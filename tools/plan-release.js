'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MANIFESTS = [
  '.plugin/plugin.json',
  '.claude-plugin/plugin.json',
  'skills/diagram-renderer/package.json',
];
const LOCK = 'skills/diagram-renderer/package-lock.json';

function versionParts(version) {
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error(`Expected a stable, exact SemVer version, got ${JSON.stringify(version)}`);
  }
  const parts = version.split('.').map(Number);
  if (!parts.every(Number.isSafeInteger)) throw new Error('Version component exceeds the safe integer range');
  return parts;
}

function visibleMarkdown(text) {
  return text.replace(/<!--[\s\S]*?-->/g, '').trim();
}

function headings(text) {
  const found = [];
  let offset = 0;
  let fence;
  let inComment = false;
  for (const line of text.split('\n')) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length &&
          !line.slice(marker[0].length).trim()) fence = undefined;
    } else if (!inComment && marker) {
      fence = marker[1];
    } else {
      let cleaned = '';
      let cursor = 0;
      while (cursor < line.length) {
        const boundary = line.indexOf(inComment ? '-->' : '<!--', cursor);
        if (!inComment) cleaned += line.slice(cursor, boundary < 0 ? line.length : boundary);
        if (boundary < 0) break;
        cursor = boundary + (inComment ? 3 : 4);
        inComment = !inComment;
      }
      const match = /^(#{2,3}) (.+?)\s*$/.exec(cleaned);
      if (match) found.push({ level: match[1].length, title: match[2], start: offset, end: offset + line.length });
    }
    offset += line.length + 1;
  }
  if (fence || inComment) throw new Error('Unclosed code fence or HTML comment in CHANGELOG.md');
  return found;
}

function parseChangelog(input) {
  const text = input.replace(/\r\n/g, '\n');
  const sections = headings(text).filter(h => h.level === 2);
  if (sections[0]?.title !== '[Unreleased]' ||
      sections.filter(h => h.title === '[Unreleased]').length !== 1) {
    throw new Error('CHANGELOG.md must start with exactly one ## [Unreleased] section');
  }
  const releaseHeading = /^\[(\d+\.\d+\.\d+)\] (?:\u2014|-) (\d{4}-\d{2}-\d{2})$/;
  const latest = releaseHeading.exec(sections[1]?.title || '');
  if (!latest) throw new Error('Unreleased must be followed by a dated stable version heading');
  let previous;
  for (const section of sections.slice(1)) {
    const match = releaseHeading.exec(section.title);
    if (!match) throw new Error(`Invalid release heading: ${section.title}`);
    const parts = versionParts(match[1]);
    if (previous) {
      const firstDifference = parts.findIndex((part, index) => part !== previous[index]);
      if (firstDifference < 0 || parts[firstDifference] > previous[firstDifference]) {
        throw new Error('Released versions must be unique and in descending order');
      }
    }
    previous = parts;
  }
  const [unreleased, next] = sections;
  const notes = text.slice(unreleased.end, next.start).trim();
  const categories = headings(notes).filter(h => h.level === 3);
  const meaningful = visibleMarkdown(notes).replace(/^### .+$/gm, '').trim();
  let minor = false;
  for (let i = 0; i < categories.length; i++) {
    const category = categories[i];
    const body = visibleMarkdown(notes.slice(category.end, categories[i + 1]?.start ?? notes.length));
    if (body && ['Added', 'Removed'].includes(category.title)) minor = true;
  }
  return { text, unreleased, next, notes, hasNotes: Boolean(meaningful), minor, latest: latest[1] };
}

function readState(read = file => fs.readFileSync(file, 'utf8'), has = fs.existsSync) {
  const documents = Object.fromEntries(MANIFESTS.map(file => [file, JSON.parse(read(file))]));
  const version = documents[MANIFESTS[0]].version;
  versionParts(version);
  for (const file of MANIFESTS) {
    if (documents[file].version !== version) throw new Error(`Version drift in ${file}; expected ${version}`);
  }
  if (has(LOCK)) {
    const lock = JSON.parse(read(LOCK));
    if (lock.version !== version || (lock.lockfileVersion >= 2 && lock.packages?.['']?.version !== version)) {
      throw new Error(`Version drift in ${LOCK}; expected both root versions to be ${version}`);
    }
    documents[LOCK] = lock;
  }
  const changelog = parseChangelog(read('CHANGELOG.md'));
  if (changelog.latest !== version) {
    throw new Error(`Latest changelog version ${changelog.latest} does not match manifests ${version}`);
  }
  return { version, documents, changelog };
}

function planRelease(state, { version = '', allowMajor = false, date = new Date().toISOString().slice(0, 10) } = {}) {
  const current = versionParts(state.version);
  let next;
  let bump;
  if (version) {
    versionParts(version);
    if (!allowMajor || version !== `${current[0] + 1}.0.0`) {
      throw new Error(`An explicit version is allowed only for manual next-major ${current[0] + 1}.0.0`);
    }
    next = version;
    bump = 'major';
  } else {
    bump = state.changelog.minor ? 'minor' : 'patch';
    next = bump === 'minor' ? `${current[0]}.${current[1] + 1}.0` : `${current[0]}.${current[1]}.${current[2] + 1}`;
  }
  versionParts(next);
  if (!state.changelog.hasNotes) return { kind: 'noop', current: state.version, reason: 'Unreleased has no user-visible notes' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(date).toISOString().slice(0, 10) !== date) {
    throw new Error('Release date must be a valid YYYY-MM-DD date');
  }
  const { changelog } = state;
  const changes = {};
  for (const [file, document] of Object.entries(state.documents)) {
    const updated = JSON.parse(JSON.stringify(document));
    updated.version = next;
    if (file === LOCK && updated.packages?.['']) updated.packages[''].version = next;
    changes[file] = `${JSON.stringify(updated, null, 2)}\n`;
  }
  changes['CHANGELOG.md'] = `${changelog.text.slice(0, changelog.unreleased.end)}\n\n` +
    `## [${next}] \u2014 ${date}\n\n${changelog.notes}\n\n${changelog.text.slice(changelog.next.start)}`;
  return { kind: 'release', current: state.version, version: next, tag: `v${next}`, bump, notes: changelog.notes, changes };
}

function applyPlan(root, plan) {
  if (plan.kind !== 'release') throw new Error('Only a release plan can be written');
  for (const [file, content] of Object.entries(plan.changes)) fs.writeFileSync(path.join(root, file), content);
  const result = readState(file => fs.readFileSync(path.join(root, file), 'utf8'), file => fs.existsSync(path.join(root, file)));
  if (result.version !== plan.version || result.changelog.hasNotes) throw new Error('Release cut validation failed');
}

module.exports = { MANIFESTS, LOCK, versionParts, parseChangelog, readState, planRelease, applyPlan };

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 1 || !['--check', '--plan'].includes(args[0])) {
      throw new Error('Usage: node tools/plan-release.js --check|--plan (read-only)');
    }
    const state = readState();
    console.log(JSON.stringify(args[0] === '--check' ? { version: state.version, valid: true } : planRelease(state), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
