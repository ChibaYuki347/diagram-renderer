'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { readChangesFrom, problemsOf } = require('./changes');

const MANIFESTS = [
  '.plugin/plugin.json',
  '.claude-plugin/plugin.json',
  'skills/diagram-renderer/package.json',
];
const LOCK = 'skills/diagram-renderer/package-lock.json';

const HEADING = Object.freeze({ added: 'Added', changed: 'Changed', removed: 'Removed', fixed: 'Fixed' });
const ORDER = Object.freeze(['added', 'changed', 'removed', 'fixed']);

function versionParts(version) {
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error(`Expected a stable, exact SemVer version, got ${JSON.stringify(version)}`);
  }
  const parts = version.split('.').map(Number);
  if (!parts.every(Number.isSafeInteger)) throw new Error('Version component exceeds the safe integer range');
  return parts;
}

function compareVersions(a, b) {
  const left = Array.isArray(a) ? a : versionParts(a);
  const right = Array.isArray(b) ? b : versionParts(b);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] - right[i];
  return 0;
}

function detectEol(text) {
  return /\r\n/.test(text) ? '\r\n' : '\n';
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
  const raw = String(input);
  const eol = detectEol(raw);
  const text = raw.replace(/\r\n/g, '\n');
  const sections = headings(text).filter((heading) => heading.level === 2);
  if (sections.some((section) => section.title === '[Unreleased]')) {
    throw new Error('CHANGELOG.md must not contain `## [Unreleased]`; the release writes each section from change files and a hand-written one would be released twice');
  }
  const releaseHeading = /^\[(\d+\.\d+\.\d+)\] (?:\u2014|-) (\d{4}-\d{2}-\d{2})$/;
  if (!sections.length) throw new Error('CHANGELOG.md must contain at least one dated stable release heading');

  const releases = [];
  const seen = new Set();
  let previous;
  for (const section of sections) {
    const match = releaseHeading.exec(section.title);
    if (!match) throw new Error(`Invalid release heading: ${section.title}`);
    if (seen.has(match[1])) throw new Error('Released versions must be unique and in descending order');
    seen.add(match[1]);
    const parts = versionParts(match[1]);
    if (previous && compareVersions(parts, previous) >= 0) {
      throw new Error('Released versions must be unique and in descending order');
    }
    previous = parts;
    releases.push({ ...section, version: match[1], date: match[2], parts });
  }
  return { raw, text, eol, releases, latest: releases[0].version, latestDate: releases[0].date, insertIndex: releases[0].start };
}

function defaultList() {
  if (!fs.existsSync('changes')) return [];
  return fs.readdirSync('changes').map((name) => `changes/${name}`);
}

function readState(
  read = (file) => fs.readFileSync(file, 'utf8'),
  has = (file) => fs.existsSync(file),
  { list = defaultList, prOf = () => null } = {},
) {
  const documents = Object.fromEntries(MANIFESTS.map((file) => [file, JSON.parse(read(file))]));
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
  const changes = readChangesFrom(list(), read);
  const prs = {};
  for (const change of changes) prs[change.file] = prOf(change.file) || null;
  return { version, documents, changelog, changes, prs };
}

// `added` and `removed` take the minor, `changed` and `fixed` the patch. Past
// 1.0.0 a breaking change is refused before this is asked; below it, CHARTER
// §5.1 puts a breaking change in a minor bump whatever its type, because a patch
// is for fixes only.
function deriveBump(changes) {
  return changes.some((change) => change.type === 'added' || change.type === 'removed' || change.breaking) ? 'minor' : 'patch';
}

function nextVersion(current, bump) {
  const [major, minor, patch] = versionParts(current);
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

function validateDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(date).toISOString().slice(0, 10) !== date) {
    throw new Error('Release date must be a valid YYYY-MM-DD date');
  }
}

// The date a release is dated with: Tokyo's, not UTC's. The schedule is 05:30
// JST, which is 20:30 UTC the calendar day before, so a UTC date would stamp
// every scheduled release one day early (Friday morning's as Thursday). Japan
// keeps no daylight saving time, so the offset is fixed. release.js plans once
// per run, so one run has one date.
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
function releaseDate(now = new Date()) {
  return new Date(now.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
}

function entryLine(change, pr) {
  return `- ${change.breaking ? '**BREAKING**: ' : ''}${change.summary.trim()}${pr ? ` (#${pr})` : ''}`;
}

function renderSection(changes, prs = {}) {
  const out = [];
  for (const type of ORDER) {
    const mine = changes.filter((change) => change.type === type)
      .map((change) => ({ change, pr: prs[change.file] || null }))
      .sort((a, b) => (a.pr || Infinity) - (b.pr || Infinity) || String(a.change.file).localeCompare(String(b.change.file)));
    if (!mine.length) continue;
    if (out.length) out.push('');
    out.push(`### ${HEADING[type]}`, '');
    for (const { change, pr } of mine) out.push(entryLine(change, pr));
  }
  return out.join('\n');
}

function writeSection(changelog, version, date, notes) {
  const block = `## [${version}] \u2014 ${date}\n\n${notes}\n\n`;
  const text = `${changelog.text.slice(0, changelog.insertIndex)}${block}${changelog.text.slice(changelog.insertIndex)}`;
  return changelog.eol === '\n' ? text : text.replace(/\n/g, changelog.eol);
}

function releaseNotes(changelog, version) {
  const text = String(changelog).replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const heading = new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\]`);
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) return '';
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## \[/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start + 1, end).join('\n').trim();
}

function plannedDocumentChanges(state, next, changelog, files) {
  const changes = {};
  for (const [file, document] of Object.entries(state.documents)) {
    const updated = JSON.parse(JSON.stringify(document));
    updated.version = next;
    if (file === LOCK && updated.packages?.['']) updated.packages[''].version = next;
    changes[file] = `${JSON.stringify(updated, null, 2)}\n`;
  }
  changes['CHANGELOG.md'] = changelog;
  for (const file of files) changes[file] = null;
  return changes;
}

// `kind: 'refused'` is every "no" a person has to act on; `noop` is only a day
// with no change files. release.js fails the run on a refusal, because a
// scheduled run that stayed green would retry it every morning with nobody told.
function planRelease(state, { version = '', allowMajor = false, date = releaseDate(), requirePrs = false } = {}) {
  const current = versionParts(state.version);
  let requested = version || '';
  let bump = '';
  let next = '';
  if (requested) {
    versionParts(requested);
    const want = `${current[0] + 1}.0.0`;
    if (!allowMajor || requested !== want) {
      throw new Error(`An explicit version is allowed only for manual next-major ${want}`);
    }
    bump = 'major';
    next = requested;
  }

  if (state.changes.length === 0) {
    return { kind: 'noop', current: state.version, reason: 'there are no change files in changes/' };
  }

  const problems = state.changes.flatMap(problemsOf);
  if (problems.length) throw new Error(`${problems.length} change file problem(s): ${problems[0]}`);

  // Every line the release writes links its pull request, and a released line is
  // not edited afterwards, so a change that arrived with no pull request number
  // is refused before anything is written. A file pushed to `main` directly is
  // numbered by renaming it in a pull request: the rename is then the commit that
  // added the new name (`git log --first-parent --diff-filter=A`, for a merge
  // commit and a squash alike).
  if (requirePrs) {
    const unnumbered = state.changes.filter((change) => !(state.prs || {})[change.file]).map((change) => change.file);
    if (unnumbered.length) {
      return {
        kind: 'refused',
        current: state.version,
        reason: `${unnumbered.join(', ')} did not arrive through a pull request, so its line would link none. `
          + 'Rename it in a pull request (git mv changes/<name>.md changes/<name>-1.md), and that pull request numbers it',
      };
    }
  }

  if (!requested && current[0] >= 1) {
    const removed = state.changes.find((change) => change.type === 'removed');
    if (removed) {
      return { kind: 'refused', current: state.version, reason: `${removed.file} is a removal past 1.0.0, and only a person takes the major` };
    }
    const breaking = state.changes.find((change) => change.breaking);
    if (breaking) {
      return { kind: 'refused', current: state.version, reason: `${breaking.file} is breaking past 1.0.0, and only a person takes the major` };
    }
  }

  validateDate(date);
  if (!requested) {
    bump = deriveBump(state.changes);
    next = nextVersion(state.version, bump);
  }
  const notes = renderSection(state.changes, state.prs);
  const changelog = writeSection(state.changelog, next, date, notes);
  const files = state.changes.map((change) => change.file);
  return {
    kind: 'release',
    current: state.version,
    version: next,
    tag: `v${next}`,
    bump,
    date,
    notes,
    entries: state.changes.length,
    files,
    changes: plannedDocumentChanges(state, next, changelog, files),
  };
}

function applyPlan(root, plan) {
  if (plan.kind !== 'release') throw new Error('Only a release plan can be written');
  for (const [file, content] of Object.entries(plan.changes)) {
    const full = path.join(root, ...file.split('/'));
    if (content === null) {
      if (fs.existsSync(full)) fs.unlinkSync(full);
    } else {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
  }
  const result = readState(
    (file) => fs.readFileSync(path.join(root, ...file.split('/')), 'utf8'),
    (file) => fs.existsSync(path.join(root, ...file.split('/'))),
    {
      list: () => {
        const dir = path.join(root, 'changes');
        return fs.existsSync(dir) ? fs.readdirSync(dir).map((name) => `changes/${name}`) : [];
      },
    },
  );
  if (result.version !== plan.version || result.changes.length !== 0) throw new Error('Release cut validation failed');
}

module.exports = {
  MANIFESTS,
  LOCK,
  HEADING,
  ORDER,
  versionParts,
  parseChangelog,
  readState,
  deriveBump,
  nextVersion,
  entryLine,
  renderSection,
  writeSection,
  releaseNotes,
  releaseDate,
  planRelease,
  applyPlan,
};

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 1 || !['--check', '--plan'].includes(args[0])) {
      throw new Error('Usage: node tools/plan-release.js --check|--plan (read-only)');
    }
    const state = readState();
    const plan = args[0] === '--plan' ? planRelease(state, { version: process.env.RELEASE_VERSION || '', allowMajor: false }) : null;
    const result = args[0] === '--check'
      ? { version: state.version, changes: state.changes.length, valid: true }
      : plan.kind === 'release'
        ? { kind: plan.kind, current: plan.current, version: plan.version, tag: plan.tag, bump: plan.bump, date: plan.date, entries: plan.entries, files: plan.files, notes: plan.notes }
        : plan;
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
