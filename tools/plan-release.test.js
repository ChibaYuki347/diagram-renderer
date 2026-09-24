'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const {
  MANIFESTS, LOCK, versionParts, parseChangelog, readState, planRelease, applyPlan, renderSection, releaseNotes, nextVersion, releaseDate,
} = require('./plan-release');
const { problemsOf } = require('./changes');

const ROOT = path.join(__dirname, '..');
const WORK = path.join(require('node:os').tmpdir(), 'diagram-renderer-tests');
const DATE = '2026-09-25';
const LOG = '# Changelog\n\nPreamble.\n\n## [0.6.0] — 2026-09-18\n\n### Added\n\n- Previous release.\n';

function tmp(t, name) {
  fs.mkdirSync(WORK, { recursive: true });
  const dir = path.join(WORK, `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function change(type, summary, extra = {}) {
  return { file: `changes/${summary.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}.md`, type, breaking: false, summary, ...extra };
}

function changeFile(type, summary, breaking = false) {
  return `---\ntype: ${type}\n${breaking ? 'breaking: true\n' : ''}---\n${summary}\n`;
}

function files({ version = '0.6.0', changelog = LOG, changes = {}, lock = false } = {}) {
  const out = Object.fromEntries(MANIFESTS.map((file) => [file, `${JSON.stringify({ name: 'diagram-renderer', version, private: true }, null, 2)}\n`]));
  out['CHANGELOG.md'] = changelog;
  out['changes/README.md'] = '# how\n';
  for (const [file, text] of Object.entries(changes)) out[file] = text;
  if (lock) {
    out[LOCK] = `${JSON.stringify({ version, lockfileVersion: 3, packages: { '': { version }, dep: { version: '9.9.9' } } }, null, 2)}\n`;
  }
  return out;
}

function state(map, prs = {}) {
  return readState(
    (file) => map[file],
    (file) => Object.hasOwn(map, file),
    { list: () => Object.keys(map).filter((file) => file.startsWith('changes/')), prOf: (file) => prs[file] || null },
  );
}

test('bump by type: added and removed are minor; changed and fixed are patch; largest wins', () => {
  for (const [type, want, next] of [
    ['added', 'minor', '0.7.0'],
    ['removed', 'minor', '0.7.0'],
    ['changed', 'patch', '0.6.1'],
    ['fixed', 'patch', '0.6.1'],
  ]) {
    const plan = planRelease(state(files({ changes: { 'changes/x.md': changeFile(type, `${type} thing.`) } })), { date: DATE });
    assert.equal(plan.bump, want);
    assert.equal(plan.version, next);
  }
  const mixed = planRelease(state(files({ changes: { 'changes/a.md': changeFile('fixed', 'Fix.'), 'changes/b.md': changeFile('added', 'Add.') } })), { date: DATE });
  assert.equal(mixed.bump, 'minor');
  assert.equal(mixed.version, '0.7.0');
});

test('no change files are a noop, including a valid manual major', () => {
  assert.equal(planRelease(state(files()), { date: DATE }).kind, 'noop');
  assert.equal(planRelease(state(files()), { date: DATE, version: '1.0.0', allowMajor: true }).kind, 'noop');
});

test('manual version validation remains exact next-major only', () => {
  const input = state(files({ changes: { 'changes/break.md': changeFile('changed', 'Break.', true) } }));
  assert.equal(planRelease(input, { date: DATE, version: '1.0.0', allowMajor: true }).bump, 'major');
  for (const version of ['major', 'v1.0.0', '1.0.0-beta.1', '01.0.0', '0.6.1', '0.7.0', '2.0.0', '1.1.0', '1.0.0\nx']) {
    assert.throws(() => planRelease(input, { date: DATE, version, allowMajor: true }), /SemVer|manual next-major/);
  }
  assert.throws(() => planRelease(input, { date: DATE, version: '1.0.0' }), /manual next-major/);
  assert.throws(() => versionParts('99999999999999999999.0.0'), /safe integer/);
});

test('past 1.0 removed and breaking changes refuse automatic release; below 1.0 both take the minor', () => {
  const removed = state(files({ version: '1.2.3', changelog: LOG.replaceAll('0.6.0', '1.2.3'), changes: { 'changes/drop.md': changeFile('removed', 'Drop an option.') } }));
  let plan = planRelease(removed, { date: DATE });
  assert.equal(plan.kind, 'refused');
  assert.match(plan.reason, /only a person takes the major/);
  const breaking = state(files({ version: '1.2.3', changelog: LOG.replaceAll('0.6.0', '1.2.3'), changes: { 'changes/break.md': changeFile('changed', 'Rename a key.', true) } }));
  plan = planRelease(breaking, { date: DATE });
  assert.equal(plan.kind, 'refused');
  assert.match(plan.reason, /only a person takes the major/);
  assert.equal(planRelease(state(files({ changes: { 'changes/drop.md': changeFile('removed', 'Drop.') } })), { date: DATE }).version, '0.7.0');
  // CHARTER §5.1: below 1.0.0 a breaking change takes the minor, whatever its type.
  for (const type of ['changed', 'fixed']) {
    const minor = planRelease(state(files({ changes: { 'changes/fix.md': changeFile('fixed', 'A fix.'), 'changes/break.md': changeFile(type, 'Break.', true) } })), { date: DATE });
    assert.equal(minor.bump, 'minor', `a breaking ${type} change`);
    assert.equal(minor.version, '0.7.0', `a breaking ${type} change`);
  }
});

test('with requirePrs, a change whose pull request is unknown is refused, naming it and the way out', () => {
  const map = files({ changes: { 'changes/a.md': changeFile('fixed', 'Numbered.'), 'changes/b.md': changeFile('added', 'Pushed straight to main.') } });
  const plan = planRelease(state(map, { 'changes/a.md': 12 }), { date: DATE, requirePrs: true });
  assert.equal(plan.kind, 'refused');
  assert.match(plan.reason, /^changes\/b\.md did not arrive through a pull request.*Rename it in a pull request/);
  assert.equal(planRelease(state(map, { 'changes/a.md': 12, 'changes/b.md': 13 }), { date: DATE, requirePrs: true }).kind, 'release');
  assert.equal(planRelease(state(map), { date: DATE }).kind, 'release', 'a direct caller may still render an unnumbered line');
});

test('a release is dated in Tokyo: every run release.yml schedules is dated the JST weekday it runs on', () => {
  const yml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8').replace(/\r\n/g, '\n');
  const [minute, hour, from, to] = (/- cron: '(\d+) (\d+) \* \* (\d)-(\d)'/.exec(yml) || []).slice(1).map(Number);
  assert.ok(Number.isInteger(to), 'release.yml has no cron of the form `m h * * a-b`');
  let runs = 0;
  for (let day = 1; day <= 31; day++) {
    const at = new Date(Date.UTC(2026, 9, day, hour, minute));
    if (at.getUTCDay() < from || at.getUTCDay() > to) continue;
    runs += 1;
    const tokyo = new Date(at.getTime() + 9 * 3600 * 1000);
    assert.equal(releaseDate(at), tokyo.toISOString().slice(0, 10), at.toISOString());
    assert.notEqual(releaseDate(at), at.toISOString().slice(0, 10), `${at.toISOString()} has the same UTC date, so this proves nothing`);
    assert.ok(tokyo.getUTCDay() >= 1 && tokyo.getUTCDay() <= 5, `${at.toISOString()} is not a JST weekday`);
  }
  assert.ok(runs >= 20, `only ${runs} scheduled runs in the month`);
  assert.equal(releaseDate(new Date('2026-10-31T20:30:00Z')), '2026-11-01');
  assert.equal(releaseDate(new Date('2026-12-31T15:00:00Z')), '2027-01-01');
  assert.equal(releaseDate(new Date('2026-12-31T14:59:59Z')), '2026-12-31');
  // release.js passes no date, so the planner's own default is what dates a run.
  // Checked with the clock at a scheduled run's instant, where the UTC and JST
  // dates differ; at most hours of the day they agree and would prove nothing.
});

test('the planner, given no date, dates a scheduled run with that run\'s JST day', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-24T20:30:00Z') });
  const undated = planRelease(state(files({ changes: { 'changes/x.md': changeFile('fixed', 'Fix.') } })));
  assert.equal(undated.date, '2026-09-25');
});

test('unreadable, unknown-type, empty and multi-line changes throw naming the file', () => {
  for (const [name, text, re] of [
    ['bad-front.md', 'bad', /changes\/bad-front\.md/],
    ['unknown.md', changeFile('improved', 'Faster.'), /changes\/unknown\.md.*type/],
    ['empty.md', changeFile('fixed', '   '), /changes\/empty\.md.*summary/],
    ['multi.md', changeFile('fixed', 'One.\nTwo.'), /changes\/multi\.md.*summary/],
  ]) {
    const map = files({ changes: { [`changes/${name}`]: text } });
    if (name === 'bad-front.md') assert.throws(() => state(map), re);
    else assert.throws(() => planRelease(state(map), { date: DATE }), re);
  }
});

test('rendered section text uses heading order, PR ordering and BREAKING marker exactly', () => {
  const changes = [
    change('fixed', 'Correct an offset.', { file: 'changes/z-fix.md' }),
    change('added', 'A second layout.', { file: 'changes/b-add.md' }),
    change('added', 'A first layout.', { file: 'changes/a-add.md' }),
    change('removed', 'Drop the loader.', { file: 'changes/drop.md' }),
    change('changed', 'Rename a key.', { file: 'changes/break.md', breaking: true }),
  ];
  const prs = { 'changes/b-add.md': 12, 'changes/a-add.md': 9, 'changes/drop.md': 5, 'changes/z-fix.md': 30 };
  assert.equal(renderSection(changes, prs), [
    '### Added', '', '- A first layout. (#9)', '- A second layout. (#12)', '',
    '### Changed', '', '- **BREAKING**: Rename a key.', '',
    '### Removed', '', '- Drop the loader. (#5)', '',
    '### Fixed', '', '- Correct an offset. (#30)',
  ].join('\n'));
});

test('CHANGELOG.md refuses Unreleased, invalid headings, duplicates and ascending releases', () => {
  assert.throws(() => parseChangelog('# Changelog\n\n## [Unreleased]\n'), /Unreleased/);
  assert.throws(() => parseChangelog('# Changelog\n\n## [Upcoming]\n'), /Invalid release heading/);
  assert.throws(() => parseChangelog(`${LOG}\n## [0.6.0] - 2026-09-01\n`), /unique/);
  assert.throws(() => parseChangelog(`${LOG}\n## [0.7.0] - 2026-09-01\n`), /descending/);
  assert.throws(() => parseChangelog(`${LOG}\n\`\`\`\nunclosed`), /Unclosed/);
});

test('cut synchronizes manifests and optional lock, deletes change files and scopes notes', (t) => {
  const map = files({ lock: true, changes: { 'changes/fix.md': changeFile('fixed', 'Fix rendering.') } });
  const plan = planRelease(state(map, { 'changes/fix.md': 18 }), { date: DATE });
  assert.equal(plan.version, '0.6.1');
  assert.equal(plan.notes, '### Fixed\n\n- Fix rendering. (#18)');
  for (const file of MANIFESTS) assert.equal(JSON.parse(plan.changes[file]).version, '0.6.1');
  const lock = JSON.parse(plan.changes[LOCK]);
  assert.equal(lock.version, '0.6.1');
  assert.equal(lock.packages[''].version, '0.6.1');
  assert.equal(lock.packages.dep.version, '9.9.9');
  assert.equal(plan.changes['changes/fix.md'], null);
  assert.match(plan.changes['CHANGELOG.md'], /^## \[0\.6\.1\] — 2026-09-25\n\n### Fixed\n\n- Fix rendering\. \(#18\)/m);
  assert.equal(releaseNotes(plan.changes['CHANGELOG.md'], '0.6.1'), plan.notes);

  const root = tmp(t, 'apply');
  for (const [file, text] of Object.entries(map)) {
    const full = path.join(root, ...file.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }
  applyPlan(root, plan);
  assert.equal(fs.existsSync(path.join(root, 'changes', 'fix.md')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, MANIFESTS[0]), 'utf8')).version, '0.6.1');
});

test('CRLF input stays CRLF and manifest/changelog drift fails explicitly', () => {
  const map = files({ changelog: LOG.replace(/\n/g, '\r\n'), changes: { 'changes/fix.md': changeFile('fixed', 'Fix.') } });
  const plan = planRelease(state(map), { date: DATE });
  assert.equal(/\r\n/.test(plan.changes['CHANGELOG.md']), true);
  assert.equal(/(^|[^\r])\n/.test(plan.changes['CHANGELOG.md']), false);
  const drift = files();
  drift[MANIFESTS[1]] = JSON.stringify({ version: '0.5.0' });
  assert.throws(() => state(drift), /Version drift/);
  const lockDrift = files({ lock: true });
  lockDrift[LOCK] = '{"version":"0.6.0","lockfileVersion":3,"packages":{"":{"version":"0.5.0"}}}';
  assert.throws(() => state(lockDrift), /Version drift/);
  const changelogDrift = files({ version: '0.6.1' });
  assert.throws(() => state(changelogDrift), /Latest changelog version/);
  assert.throws(() => planRelease(state(files({ changes: { 'changes/fix.md': changeFile('fixed', 'Fix.') } })), { date: '2026-02-30' }), /date/);
});

test('the live changelog has no Unreleased, agrees with the manifests, and the next release can be written above it', () => {
  // Read as it stands, whatever change files are waiting: the release's own
  // validation step runs this suite on the cut, after the change files are gone
  // and the version has moved, so nothing here may name a version or a file.
  const stateNow = readState(
    (file) => fs.readFileSync(path.join(ROOT, ...file.split('/')), 'utf8'),
    (file) => fs.existsSync(path.join(ROOT, ...file.split('/'))),
    { list: () => fs.readdirSync(path.join(ROOT, 'changes')).map((name) => `changes/${name}`) },
  );
  assert.equal(stateNow.changelog.latest, stateNow.version);
  assert.deepEqual(stateNow.changes.flatMap(problemsOf), []);
  const plan = planRelease({ ...stateNow, changes: [{ file: 'changes/probe.md', type: 'fixed', breaking: false, summary: 'Probe.' }], prs: {} }, { date: DATE });
  assert.equal(plan.kind, 'release');
  assert.equal(plan.version, nextVersion(stateNow.version, 'patch'));
  assert.equal(releaseNotes(plan.changes['CHANGELOG.md'], plan.version), '### Fixed\n\n- Probe.');
});
