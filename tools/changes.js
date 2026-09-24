'use strict';

// One change file per pull request (CHARTER §5.4). This file intentionally
// requires nothing from the repository so CI can run the base branch's copy
// against a pull request's checkout.

const fs = require('node:fs');
const path = require('node:path');

const CHANGES_DIR = 'changes';
const TYPES = Object.freeze(['added', 'changed', 'fixed', 'removed']);
const KEYS = Object.freeze(['type', 'breaking']);
const SKIP_LABEL = 'skip-changelog';

const valueOf = (raw) => raw.replace(/\s+#.*$/, '').trim();
const repoPath = (...parts) => parts.join('/');
const isReadme = (name) => name.toLowerCase() === 'readme.md';
const isChangeFile = (name) => /\.md$/i.test(name) && !isReadme(name);
const isDirectChangePath = (file) => {
  if (!file.startsWith(`${CHANGES_DIR}/`)) return false;
  const rest = file.slice(CHANGES_DIR.length + 1);
  return isChangeFile(rest) && !rest.includes('/');
};

function parseChange(text, file = 'change') {
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0].trim() !== '---') {
    throw new Error(`${file}: a change file starts with a \`---\` line of front matter`);
  }
  const close = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (close === -1) throw new Error(`${file}: its front matter has no closing \`---\``);

  const fields = {};
  for (const line of lines.slice(1, close)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const match = /^([A-Za-z_][\w-]*):(.*)$/.exec(line);
    if (!match) throw new Error(`${file}: \`${line.trim()}\` is not \`key: value\``);
    const key = match[1];
    if (!KEYS.includes(key)) {
      throw new Error(`${file}: unknown key \`${key}\`; a change file has ${KEYS.map((k) => `\`${k}\``).join(', ')}`);
    }
    if (Object.hasOwn(fields, key)) throw new Error(`${file}: \`${key}\` is given twice`);
    fields[key] = valueOf(match[2]);
  }

  let breaking = false;
  if (Object.hasOwn(fields, 'breaking')) {
    if (!/^(true|false)$/.test(fields.breaking)) {
      throw new Error(`${file}: \`breaking\` is \`true\` or \`false\`, not \`${fields.breaking}\``);
    }
    breaking = fields.breaking === 'true';
  }

  const body = lines.slice(close + 1);
  while (body.length && !body[0].trim()) body.shift();
  while (body.length && !body[body.length - 1].trim()) body.pop();

  return {
    file,
    type: fields.type === undefined ? '' : fields.type,
    breaking,
    summary: body.map((line) => line.trim()).join('\n'),
  };
}

function problemsOf(change) {
  const c = change || {};
  const at = c.file || 'a change';
  const out = [];
  if (!TYPES.includes(c.type)) {
    out.push(`${at}: \`type\` is ${c.type ? `\`${c.type}\`` : 'missing'}; it is one of ${TYPES.join(', ')}`);
  }
  if (typeof c.breaking !== 'boolean') out.push(`${at}: \`breaking\` is not true or false`);
  const summary = typeof c.summary === 'string' ? c.summary : '';
  if (!summary.trim()) out.push(`${at}: it has no summary line`);
  else if (/\n/.test(summary.trim())) {
    out.push(`${at}: its summary is ${summary.trim().split('\n').length} lines; it is the one line the changelog prints, and the details belong to the pull request`);
  }
  return out;
}

function readChangesFrom(fileList, read) {
  return [...fileList]
    .filter(isDirectChangePath)
    .sort((a, b) => a.localeCompare(b))
    .map((file) => parseChange(read(file), file));
}

function readChanges(root) {
  const dir = path.join(root, CHANGES_DIR);
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir)
    .filter(isChangeFile)
    .map((name) => repoPath(CHANGES_DIR, name));
  return readChangesFrom(files, (file) => fs.readFileSync(path.join(root, ...file.split('/')), 'utf8'));
}

function prFromSubject(subject) {
  const s = String(subject || '');
  const merge = /^Merge pull request #(\d+)\b/.exec(s);
  if (merge) return Number(merge[1]);
  const all = [...s.matchAll(/\(#(\d+)\)/g)];
  return all.length ? Number(all[all.length - 1][1]) : null;
}

function releasedPart(changelog) {
  const match = /^## \[\d+\.\d+\.\d+\](?:\s+(?:\u2014|-)\s+\d{4}-\d{2}-\d{2})?/m.exec(changelog);
  return match ? changelog.slice(match.index).replace(/\r\n/g, '\n') : '';
}

function checkPullRequest({ files, labels, baseChangelog, headChangelog, read }) {
  const problems = [];
  const added = files.filter((f) => f.status === 'A' && isDirectChangePath(f.file)).map((f) => f.file);
  const present = files.filter((f) => f.status !== 'D' && isDirectChangePath(f.file)).map((f) => f.file);
  const skip = labels.includes(SKIP_LABEL);

  for (const f of files.filter((x) =>
    x.status !== 'D' &&
    x.file.startsWith(`${CHANGES_DIR}/`) &&
    x.file !== `${CHANGES_DIR}/README.md` &&
    !isDirectChangePath(x.file))) {
    problems.push(`${f.file}: a change file is \`${CHANGES_DIR}/<name>.md\`, directly in \`${CHANGES_DIR}/\``);
  }

  for (const file of present) {
    try {
      problems.push(...problemsOf(parseChange(read(file), file)));
    } catch (error) {
      problems.push(error.message);
    }
  }

  if (!added.length && !skip) {
    problems.push(`this pull request adds no change file. Add \`${CHANGES_DIR}/<name>.md\` (see ${CHANGES_DIR}/README.md), or label it \`${SKIP_LABEL}\` if it changes nothing a user of the plugin sees`);
  }
  if (added.length && skip) {
    problems.push(`this pull request is labelled \`${SKIP_LABEL}\` and adds ${added.join(', ')}; remove the label or the file`);
  }
  if (/^## \[Unreleased\]/mi.test(headChangelog)) {
    problems.push('CHANGELOG.md has a `## [Unreleased]` heading. Entries are no longer written there: the release writes each version\'s section from the change files');
  }
  if (releasedPart(headChangelog) !== releasedPart(baseChangelog)) {
    problems.push('this pull request edits a released section of CHANGELOG.md. The release writes that file; a correction goes in a change file, and a released section is never edited (RELEASING.md)');
  }

  return { ok: problems.length === 0, problems, added };
}

module.exports = {
  CHANGES_DIR,
  TYPES,
  KEYS,
  SKIP_LABEL,
  parseChange,
  problemsOf,
  readChanges,
  readChangesFrom,
  isChangeFile,
  isDirectChangePath,
  prFromSubject,
  releasedPart,
  checkPullRequest,
};

if (require.main === module) {
  const cp = require('node:child_process');
  const root = process.env.CHANGES_ROOT || path.join(__dirname, '..');
  const git = (...args) => cp.execFileSync('git', args, {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
  });

  if (process.argv.includes('--check-pr')) {
    const base = process.env.BASE_SHA;
    if (!base) {
      console.error('--check-pr needs BASE_SHA, the pull request\'s base commit');
      process.exit(2);
    }
    const files = git('diff', '--name-status', '--no-renames', `${base}...HEAD`).split('\n').filter(Boolean)
      .map((line) => {
        const [status, file] = line.split('\t');
        return { status: status[0], file };
      });
    let labels = [];
    try { labels = JSON.parse(process.env.PR_LABELS || '[]'); } catch { labels = []; }
    const showBase = (file) => {
      try { return git('show', `${base}:${file}`); } catch { return ''; }
    };
    const result = checkPullRequest({
      files,
      labels,
      baseChangelog: showBase('CHANGELOG.md'),
      headChangelog: fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'),
      read: (file) => fs.readFileSync(path.join(root, ...file.split('/')), 'utf8'),
    });
    if (!result.ok) {
      for (const problem of result.problems) console.log(`::error::${problem}`);
      process.exit(1);
    }
    console.log(result.added.length ? `change file(s): ${result.added.join(', ')}` : `labelled ${SKIP_LABEL}: no change file needed`);
    process.exit(0);
  }

  if (process.argv.includes('--check')) {
    let changes;
    try { changes = readChanges(root); } catch (error) {
      console.error(error.message);
      process.exit(1);
    }
    const problems = changes.flatMap(problemsOf);
    for (const problem of problems) console.error(problem);
    if (problems.length) process.exit(1);
    console.log(`${changes.length} change file(s) in ${CHANGES_DIR}/, all readable`);
    process.exit(0);
  }

  console.error('usage: node tools/changes.js --check | --check-pr');
  process.exit(2);
}
