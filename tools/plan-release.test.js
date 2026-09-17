'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { MANIFESTS, LOCK, versionParts, parseChangelog, readState, planRelease } = require('./plan-release');
const { GitHub } = require('./github');
const { inFlight } = require('./in-flight');
const { MARKER, runDue } = require('./release-due');

function fixture(notes = '### Fixed\n- Fix rendering.') {
  const files = Object.fromEntries(MANIFESTS.map(file => [file, JSON.stringify({ name: 'diagram-renderer', version: '0.4.0', private: true })]));
  files['CHANGELOG.md'] = `# Changelog\n\n## [Unreleased]\n\n${notes}\n\n## [0.4.0] - 2026-09-06\n\n### Added\n- Previous release.\n`;
  return files;
}

function state(files) {
  return readState(file => files[file], file => Object.hasOwn(files, file));
}

test('Added/Removed with content choose minor; all other notes choose patch', () => {
  for (const category of ['Added', 'Removed', 'Fixed', 'Changed', 'Security', 'Notes']) {
    const plan = planRelease(state(fixture(`### ${category}\n- A visible change.`)));
    assert.equal(plan.version, ['Added', 'Removed'].includes(category) ? '0.5.0' : '0.4.1');
  }
  assert.equal(planRelease(state(fixture('### Added\n<!-- later -->\n### Fixed\n- A fix.'))).version, '0.4.1');
});

test('empty, headings-only and comment-only Unreleased are no-ops, including manual major', () => {
  for (const notes of ['', '\n ', '<!-- todo -->', '### Added\n\n### Fixed\n<!-- todo\nlater -->']) {
    assert.equal(planRelease(state(fixture(notes))).kind, 'noop');
    assert.equal(planRelease(state(fixture(notes)), { version: '1.0.0', allowMajor: true }).kind, 'noop');
  }
});

test('only explicit manual exact next-major is permitted', () => {
  const input = state(fixture());
  assert.equal(planRelease(input, { version: '1.0.0', allowMajor: true }).bump, 'major');
  for (const version of ['major', 'v1.0.0', '1.0.0-beta.1', '01.0.0', '0.4.1', '0.5.0', '2.0.0', '1.1.0', '1.0.0\nx', '$(id)']) {
    assert.throws(() => planRelease(input, { version, allowMajor: true }));
  }
  assert.throws(() => planRelease(input, { version: '1.0.0' }), /manual/);
  assert.throws(() => planRelease(state(fixture('')), { version: '0.5.0', allowMajor: true }));
  assert.throws(() => versionParts('99999999999999999999.0.0'), /safe integer/);
});

test('cut synchronizes all versions and optional lock root, preserves dependencies and scopes notes', () => {
  const files = fixture();
  files[LOCK] = JSON.stringify({
    version: '0.4.0', lockfileVersion: 3,
    packages: { '': { version: '0.4.0' }, 'node_modules/example': { version: '9.2.1' } },
  });
  const plan = planRelease(state(files), { date: '2026-09-12' });
  for (const file of [...MANIFESTS, LOCK]) assert.equal(JSON.parse(plan.changes[file]).version, '0.4.1');
  const lock = JSON.parse(plan.changes[LOCK]);
  assert.equal(lock.packages[''].version, '0.4.1');
  assert.equal(lock.packages['node_modules/example'].version, '9.2.1');
  assert.equal(plan.notes, '### Fixed\n- Fix rendering.');
  assert.match(plan.changes['CHANGELOG.md'], /## \[Unreleased\]\n\n## \[0\.4\.1\] \u2014 2026-09-12/);
  assert.match(plan.changes['CHANGELOG.md'], /Previous release\./);
  assert.equal(planRelease(state({ ...files, ...plan.changes })).kind, 'noop');
});

test('drift, malformed changelog and invalid dates fail explicitly', () => {
  for (const file of MANIFESTS) {
    const files = fixture();
    files[file] = '{"version":"0.3.0"}';
    assert.throws(() => state(files), /drift|does not match/);
  }
  const files = fixture();
  files[LOCK] = '{"version":"0.4.0","lockfileVersion":3,"packages":{"":{"version":"0.3.0"}}}';
  assert.throws(() => state(files), /drift/);
  for (const changelog of [
    '# Changelog', '## [Unreleased]\n## [Unreleased]\n## [0.4.0] - 2026-09-06',
    '## [0.4.0] - 2026-09-06\n## [Unreleased]', '## [Unreleased]\n## [Upcoming]',
  ]) assert.throws(() => parseChangelog(changelog));
  assert.throws(() => parseChangelog(`${fixture()['CHANGELOG.md']}\n## [0.4.0] - 2026-09-01`), /unique/);
  assert.throws(() => parseChangelog(`${fixture()['CHANGELOG.md']}\n## [0.5.0] - 2026-09-01`), /descending/);
  assert.throws(() => planRelease(state(fixture()), { date: '2026-02-30' }), /date/);
});

test('CRLF, comments and fenced headings cannot change release boundaries or bump selection', () => {
  const files = fixture('### Fixed\n- Example:\n```md\n## [Unreleased]\n### Added\n```\n<!--\n### Removed\n- Hidden\n-->');
  const parsed = state(files);
  assert.equal(planRelease(parsed).version, '0.4.1');
  assert.equal(planRelease(state(Object.fromEntries(Object.entries(files).map(([file, text]) => [file, text.replace(/\n/g, '\r\n')])))).version, '0.4.1');
  assert.throws(() => state(fixture('```\nunclosed')), /Unclosed/);
  assert.equal(planRelease(state(fixture('### Fixed\n- Document literal comments:\n```html\n<!--\n```\n'))).version, '0.4.1');
});

test('PR guard holds changelog edits, renames and explicit references but not unrelated PRs', async () => {
  const pulls = [1, 2, 3, 4, 5].map(number => ({ number, title: `PR ${number}` }));
  const files = {
    1: [{ filename: 'CHANGELOG.md' }],
    2: [{ filename: 'archive.md', previous_filename: 'CHANGELOG.md' }],
    3: [{ filename: 'README.md' }],
    4: [{ filename: 'renderer.js' }],
    5: [{ filename: 'README.md' }],
  };
  const github = { pages: async endpoint => endpoint.startsWith('/pulls?') ? pulls : files[endpoint.split('/')[2]] };
  assert.deepEqual((await inFlight(github, 'Fix #3 and https://github.com/owner/repo/pull/4, not #50.')).map(pull => pull.number), [1, 2, 3, 4]);
  await assert.rejects(inFlight({ pages: async () => { throw new Error('API unavailable'); } }, ''), /unavailable/);
  await assert.rejects(inFlight({ pages: async () => [{}] }, ''), /invalid/);
});

test('API pagination is complete; only explicit release 404 is absence; API errors never become no-PR', async () => {
  const requests = [];
  const github = new GitHub({
    repository: 'owner/repo', token: 'test-only',
    fetchImpl: async url => {
      requests.push(url);
      if (url.includes('/releases/')) return { status: 404, ok: false };
      return { ok: true, json: async () => new URL(url).searchParams.get('page') === '1' ? Array.from({ length: 100 }, (_, number) => ({ number })) : [{ number: 100 }] };
    },
  });
  assert.equal((await github.pages('/pulls?state=open&base=main')).length, 101);
  assert.ok(requests[1].includes('&page=2'));
  assert.equal(await github.release('v0.4.0'), null);
  for (const status of [401, 403, 429, 500]) {
    const bad = new GitHub({ repository: 'owner/repo', token: 'test-only', fetchImpl: async () => ({ ok: false, status }) });
    await assert.rejects(bad.release('v0.4.0'), new RegExp(`HTTP ${status}`));
    await assert.rejects(inFlight(bad, ''), new RegExp(`HTTP ${status}`));
  }
  await assert.rejects(github.pages('/pulls', 1), /pagination limit/);
  assert.throws(() => new GitHub({ repository: 'bad/../../url', token: 'test-only' }), /Invalid/);
});

function issueApi(existing = []) {
  const writes = [];
  return { repository: 'owner/repo', writes, pages: async () => existing, request: async (...args) => { writes.push(args); return {}; } };
}

test('release-due creates once, reopens same standing issue, and closes when published', async () => {
  const github = issueApi();
  await runDue({ github, evaluateStatus: async () => ({ kind: 'ready', detail: 'v0.5.0', notes: '- Feature' }) });
  assert.equal(github.writes[0][0], 'POST');
  assert.match(github.writes[0][2].body, /Status: ready/);
  const existing = issueApi([{ number: 4, body: MARKER, state: 'closed' }]);
  await runDue({ github: existing, evaluateStatus: async () => ({ kind: 'held', detail: '#2' }) });
  assert.equal(existing.writes[0][1], '/issues/4');
  assert.equal(existing.writes[0][2].state, 'open');
  await runDue({ github: existing, evaluateStatus: async () => ({ kind: 'published', detail: 'v0.5.0 published' }) });
  assert.equal(existing.writes[1][2].state, 'closed');
  const empty = issueApi();
  await runDue({ github: empty, evaluateStatus: async () => ({ kind: 'published', detail: 'No notes' }) });
  assert.equal(empty.writes.length, 0);
});

test('release-due reports failure, fails the job, and refuses duplicate issues', async () => {
  const github = issueApi();
  await assert.rejects(runDue({ github, evaluateStatus: async () => { throw new Error('HTTP 503'); } }), /HTTP 503/);
  assert.match(github.writes[0][2].body, /Status: failed/);
  const duplicates = issueApi([{ number: 1, body: MARKER }, { number: 2, body: MARKER }]);
  await assert.rejects(runDue({ github: duplicates, evaluateStatus: async () => ({ kind: 'ready', detail: '' }) }), /Multiple/);
  assert.equal(duplicates.writes.length, 0);
  await assert.rejects(runDue({
    github: { pages: async () => { throw new Error('Issues API unavailable'); } },
    evaluateStatus: async () => ({ kind: 'ready', detail: '' }),
  }), /Issues API unavailable/);
});
