'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { test } = require('node:test');
const C = require('./changes');

const ROOT = path.join(__dirname, '..');
const WORK = path.join(require('node:os').tmpdir(), 'diagram-renderer-tests');
const FILE = '---\ntype: fixed        # added | changed | fixed | removed\nbreaking: false\n---\nCorrect a rendering offset.\n';
const LOG = '# Changelog\n\nProse.\n\n## [0.6.0] — 2026-09-18\n\n### Fixed\n\n- Old fix.\n';

function tmp(t, name) {
  fs.mkdirSync(WORK, { recursive: true });
  const dir = path.join(WORK, `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function put(root, file, text) {
  const full = path.join(root, ...file.split('/'));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
}

function throwsMessage(fn, re) {
  let message = '';
  try { fn(); } catch (error) { message = error.message; }
  assert.match(message, re);
}

test('parseChange reads the format and CRLF, and rejects unjudgeable front matter', () => {
  assert.deepEqual(C.parseChange(FILE, 'changes/x.md'), {
    file: 'changes/x.md', type: 'fixed', breaking: false, summary: 'Correct a rendering offset.',
  });
  assert.deepEqual(C.parseChange(FILE.replace(/\n/g, '\r\n'), 'x'), C.parseChange(FILE, 'x'));
  assert.equal(C.parseChange('---\ntype: added\n---\n\n  A layout.  \n\n', 'x').summary, 'A layout.');
  for (const [text, re] of [
    ['type: fixed\n---\nx\n', /^changes\/bad\.md: a change file starts/],
    ['---\ntype: fixed\nx\n', /no closing `---`/],
    ['---\ntype: fixed\nremoves: \[x\]\n---\nx\n', /unknown key `removes`/],
    ['---\ntype: fixed\ntype: added\n---\nx\n', /`type` is given twice/],
    ['---\ntype: fixed\nbreaking: yes\n---\nx\n', /`breaking` is `true` or `false`, not `yes`/],
    ['---\njust words\n---\nx\n', /is not `key: value`/],
  ]) throwsMessage(() => C.parseChange(text, 'changes/bad.md'), re);
});

test('problemsOf judges type, boolean and exactly one non-empty line', () => {
  const ch = (extra) => ({ file: 'changes/c.md', type: 'fixed', breaking: false, summary: 'A line.', ...extra });
  for (const type of C.TYPES) assert.deepEqual(C.problemsOf(ch({ type })), []);
  for (const [change, re] of [
    [ch({ type: 'improved' }), /`type` is `improved`/],
    [ch({ type: '' }), /`type` is missing/],
    [ch({ breaking: 'false' }), /`breaking` is not true or false/],
    [ch({ summary: '   ' }), /no summary line/],
    [ch({ summary: 'One.\nTwo.' }), /summary is 2 lines/],
  ]) assert.match(C.problemsOf(change)[0], re);
});

test('readChanges reads direct markdown files except README in name order', (t) => {
  const root = tmp(t, 'changes');
  put(root, 'changes/README.md', '# how');
  put(root, 'changes/b.md', FILE);
  put(root, 'changes/a.md', FILE.replace('fixed ', 'added '));
  put(root, 'changes/note.txt', 'ignored');
  assert.deepEqual(C.readChanges(root).map((c) => [c.file, c.type]), [['changes/a.md', 'added'], ['changes/b.md', 'fixed']]);
  put(root, 'changes/c.md', 'bad');
  throwsMessage(() => C.readChanges(root), /^changes\/c\.md:/);
});

test('readChangesFrom and prFromSubject support git-ref readers', () => {
  const files = ['README.md', 'changes/b.md', 'changes/README.md', 'changes/a.md', 'changes/sub/x.md'];
  const read = (file) => file.endsWith('a.md') ? FILE.replace('fixed ', 'changed ') : FILE;
  assert.deepEqual(C.readChangesFrom(files, read).map((c) => [c.file, c.type]), [['changes/a.md', 'changed'], ['changes/b.md', 'fixed']]);
  assert.equal(C.prFromSubject('fix: issue (#9) (#12)'), 12);
  assert.equal(C.prFromSubject('Merge pull request #7 from owner/branch'), 7);
  assert.equal(C.prFromSubject('chore: release v0.6.0'), null);
});

function verdict(over = {}) {
  return C.checkPullRequest({
    files: [{ status: 'A', file: 'changes/feat-x.md' }, { status: 'M', file: 'tools/x.js' }],
    labels: [], baseChangelog: LOG, headChangelog: LOG, read: () => FILE, ...over,
  });
}

test('checkPullRequest requires a change file or skip-changelog, not both, and protects released history', () => {
  assert.equal(verdict().ok, true);
  assert.equal(verdict({ files: [{ status: 'M', file: 'README.md' }], labels: ['skip-changelog'] }).ok, true);
  for (const [over, re] of [
    [{ files: [{ status: 'M', file: 'tools/x.js' }] }, /adds no change file/],
    [{ labels: ['skip-changelog'] }, /labelled `skip-changelog` and adds/],
    [{ read: () => '---\ntype: improved\n---\nx\n' }, /`type` is `improved`/],
    [{ read: () => 'bad' }, /starts with a `---`/],
    [{ files: [{ status: 'A', file: 'changes/sub/x.md' }], labels: ['skip-changelog'] }, /directly in `changes\/`/],
    [{ headChangelog: LOG.replace('- Old fix.', '- Edited.') }, /edits a released section/],
    [{ headChangelog: LOG.replace('Prose.\n\n', 'Prose.\n\n## [Unreleased]\n\n- by hand\n\n') }, /`## \[Unreleased\]`/],
  ]) assert.equal(verdict(over).problems.some((p) => re.test(p)), true, JSON.stringify(over));
  assert.equal(verdict({ headChangelog: LOG.replace('Prose.', 'Better prose.') }).ok, true);
});

test('--check-pr CLI judges a real pull request diff against its base', (t) => {
  const repo = tmp(t, 'pr');
  const git = (...args) => cp.execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.invalid');
  git('config', 'user.name', 't');
  git('config', 'core.autocrlf', 'false');
  put(repo, 'CHANGELOG.md', LOG);
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD').trim();
  git('checkout', '-q', '-b', 'feat');
  put(repo, 'code.js', '1');
  git('add', '.');
  git('commit', '-q', '-m', 'code');
  const run = (labels = [], env = {}) => cp.spawnSync(process.execPath, [path.join(__dirname, 'changes.js'), '--check-pr'], {
    encoding: 'utf8', env: { ...process.env, CHANGES_ROOT: repo, BASE_SHA: base, PR_LABELS: JSON.stringify(labels), ...env },
  });
  let r = run();
  assert.equal(r.status, 1);
  assert.match(r.stdout, /adds no change file/);
  r = run(['skip-changelog']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  put(repo, 'changes/feat.md', FILE);
  git('add', '.');
  git('commit', '-q', '-m', 'change file');
  r = run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /changes\/feat\.md/);
  put(repo, 'CHANGELOG.md', LOG.replace('- Old fix.', '- Edited.'));
  git('add', '.');
  git('commit', '-q', '-m', 'edit history');
  r = run();
  assert.equal(r.status, 1);
  assert.match(r.stdout, /edits a released section/);
  r = run([], { BASE_SHA: '' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /needs BASE_SHA/);
});

test('live changes directory reads, and workflows are wired to change files', () => {
  const live = C.readChanges(ROOT);
  assert.deepEqual(live.flatMap(C.problemsOf), []);
  assert.ok(fs.existsSync(path.join(ROOT, 'changes', 'README.md')));
  const changesYml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'changes.yml'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(changesYml, /types: \[opened, synchronize, reopened, labeled, unlabeled\]/);
  assert.match(changesYml, /permissions:\n\s+contents: read/);
  assert.match(changesYml, /fetch-depth: 0/);
  assert.match(changesYml, /git show "\$BASE_SHA:tools\/changes\.js" > "\$RUNNER_TEMP\/changes\.js"/);
  assert.match(changesYml, /node "\$RUNNER_TEMP\/changes\.js" --check-pr/);
  const releaseYml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(releaseYml, /schedule:\n\s+- cron: '30 20 \* \* 0-4'/);
  assert.doesNotMatch(releaseYml, /\bpush:/);
  assert.doesNotMatch(releaseYml, /pull-requests:/);
  assert.match(releaseYml, /node tools\/changes\.js --check/);
  assert.ok(!fs.existsSync(path.join(ROOT, '.github', 'workflows', 'release-due.yml')));
});

// The step of a workflow named `name`: its text, and its `run:` script as the
// shell receives it.
function stepOf(y, name) {
  const at = y.indexOf(`      - name: ${name}\n`);
  if (at === -1) return null;
  const rest = y.slice(at + 1);
  const end = rest.search(/\n {6}- /);
  const step = end === -1 ? rest : rest.slice(0, end + 1);
  const script = (step.split('\n        run: |\n')[1] || '').split('\n').map((l) => l.slice(10)).join('\n');
  return { at, step, script };
}

test('release.yml asks the marketplace to pin what it published, on every run so that a retry asks again, says so when it cannot, and fails when asking fails', () => {
  const y = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8').replace(/\r\n/g, '\n');
  const s = stepOf(y, 'Ask the marketplace to pin the release');
  assert.ok(s, 'the step is gone');
  const release = y.indexOf('      - name: Plan, validate cut, atomically push and publish\n        id: release\n');
  assert.ok(release !== -1 && s.at > release, 'it does not come after the release, or the release step has no id');
  assert.doesNotMatch(s.step, /\n {8}if: /, 'it is gated, so a run retried after a failed request, with nothing left to publish, would not ask again');
  assert.match(s.step, /GH_TOKEN: \$\{\{ secrets\.MARKETPLACE_DISPATCH_TOKEN \}\}/);
  assert.match(s.step, /TAG: \$\{\{ steps\.release\.outputs\.tag \}\}/);
  const tokens = [...y.matchAll(/GH_TOKEN: (.*)/g)].map((m) => m[1].trim());
  assert.deepEqual(tokens, ['${{ github.token }}', '${{ secrets.MARKETPLACE_DISPATCH_TOKEN }}']);
  const secrets = [...new Set([...y.matchAll(/\bsecrets\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]))];
  assert.deepEqual(secrets, ['MARKETPLACE_DISPATCH_TOKEN'], 'release.yml holds another secret');
  assert.equal([...y.matchAll(/github\.token/g)].length, 1, 'the job token is handed to more than the release step');
  const marketplace = (s.step.match(/MARKETPLACE: (\S+)/) || [])[1];
  assert.equal(marketplace, 'ChibaYuki347/chibayuki-private-marketplace');

  // Run the script as the runner does, with `gh` standing in as a function
  // that records what it was asked and exits as it is told.
  assert.equal(cp.spawnSync('bash', ['--version'], { encoding: 'utf8' }).status, 0, 'no bash to run the step with');
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'dr-dispatch-'));
  const unix = (p) => p.split(path.sep).join('/');
  const run = (token, ghExit = 0, tag = 'v9.9.9') => {
    const log = path.join(dir, 'gh.log');
    const summary = path.join(dir, 'summary.md');
    fs.writeFileSync(log, ''); fs.writeFileSync(summary, '');
    const fake = 'gh() { printf \'%s\\n\' "$*" >> "$GH_LOG"; return "${GH_EXIT:-0}"; }\n';
    const r = cp.spawnSync('bash', ['-c', fake + s.script], {
      encoding: 'utf8',
      env: { ...process.env, GH_TOKEN: token, MARKETPLACE: marketplace, TAG: tag, GH_LOG: unix(log), GH_EXIT: String(ghExit), GITHUB_STEP_SUMMARY: unix(summary) },
    });
    return { status: r.status, out: `${r.stdout}${r.stderr}`, calls: fs.readFileSync(log, 'utf8').trim(), summary: fs.readFileSync(summary, 'utf8') };
  };
  const CALL = 'workflow run sync-plugin-refs.yml --repo ChibaYuki347/chibayuki-private-marketplace --ref main';
  try {
    const none = run('');
    assert.equal(none.status, 0);
    assert.match(none.out, /::warning::MARKETPLACE_DISPATCH_TOKEN is not set, so ChibaYuki347\/chibayuki-private-marketplace was not asked to pin v9\.9\.9/);
    assert.match(none.summary, /was not asked to pin v9\.9\.9/);
    assert.equal(none.calls, '');
    const quiet = run('', 0, '');
    assert.equal(quiet.status, 0);
    assert.doesNotMatch(quiet.out, /warning/, 'with no token and nothing published, it should stay quiet');
    assert.equal(quiet.summary, '');
    assert.equal(quiet.calls, '');
    const asked = run('t0ken');
    assert.equal(asked.status, 0);
    assert.equal(asked.calls, CALL);
    assert.match(asked.summary, /Asked ChibaYuki347\/chibayuki-private-marketplace to sync \(sync-plugin-refs\) and pin v9\.9\.9\./);
    const again = run('t0ken', 0, '');
    assert.equal(again.status, 0);
    assert.equal(again.calls, CALL, 'with nothing published on this run (a retry), it should ask again');
    assert.match(again.summary, /Asked ChibaYuki347\/chibayuki-private-marketplace to sync \(sync-plugin-refs\)\.\n/);
    const refused = run('t0ken', 1);
    assert.notEqual(refused.status, 0, 'a dispatch that fails leaves the run green');
    assert.doesNotMatch(refused.summary, /Asked/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('changes.js can run from the base checkout without repository-local requires', () => {
  const src = fs.readFileSync(path.join(__dirname, 'changes.js'), 'utf8');
  const requires = [...src.matchAll(/require\('([^']+)'\)/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(requires)].sort(), ['node:child_process', 'node:fs', 'node:path']);
});
