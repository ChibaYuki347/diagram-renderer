'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { MANIFESTS } = require('./plan-release');
const { git, currentState, readAt, remoteRef, runRelease } = require('./release');
const { evaluate } = require('./release-due');

function setup(t, notes = '### Fixed\n- Release fixture fix.') {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'diagram-release-test-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const remote = path.join(temp, 'origin.git');
  const root = path.join(temp, 'work');
  fs.mkdirSync(root);
  git(temp, 'init', '--bare', remote);
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Release test');
  git(root, 'config', 'user.email', 'test@example.invalid');
  git(root, 'config', 'core.autocrlf', 'false');
  git(root, 'remote', 'add', 'origin', remote);
  for (const file of MANIFESTS) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), `${JSON.stringify({ name: 'fixture', version: '0.4.0' }, null, 2)}\n`);
  }
  const previous = '## [0.4.0] - 2026-09-06\n\n### Added\n- Historical notes.\n';
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), `# Changelog\n\n## [Unreleased]\n\n${previous}`);
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'Initial fixture');
  git(root, 'tag', 'v0.4.0');
  git(root, 'push', 'origin', 'main', 'v0.4.0');
  if (notes) {
    fs.writeFileSync(path.join(root, 'CHANGELOG.md'), `# Changelog\n\n## [Unreleased]\n\n${notes}\n\n${previous}`);
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'Add unreleased notes');
    git(root, 'push', 'origin', 'main');
  }
  const releases = new Map([['v0.4.0', { tag_name: 'v0.4.0', body: 'Legacy full changelog', draft: false, prerelease: false }]]);
  const writes = [];
  const github = {
    releases, writes, pages: async () => [],
    release: async tag => releases.get(tag) || null,
    request: async (method, endpoint, body) => {
      assert.equal(method, 'POST');
      assert.equal(endpoint, '/releases');
      assert.ok(!releases.has(body.tag_name), 'must never overwrite an existing release');
      releases.set(body.tag_name, body);
      writes.push(body);
      return body;
    },
  };
  return { root, remote, temp, github, date: '2026-09-12' };
}

test('real git cut atomically pushes three manifests, changelog and exact tag; rerun is a no-op', async t => {
  const ctx = setup(t);
  const result = await runRelease(ctx);
  assert.equal(result.kind, 'released');
  assert.equal(result.tag, 'v0.4.1');
  assert.equal(remoteRef(ctx.root, 'refs/heads/main'), result.commit);
  assert.equal(remoteRef(ctx.root, 'refs/tags/v0.4.1'), result.commit);
  assert.equal(currentState(ctx.root).version, '0.4.1');
  assert.equal(ctx.github.writes[0].body, '### Fixed\n- Release fixture fix.');
  assert.equal(ctx.github.writes[0].target_commitish, result.commit);
  assert.equal((await runRelease(ctx)).kind, 'noop');
  assert.equal(ctx.github.writes.length, 1);
});

test('empty notes do not create commits, tags or releases', async t => {
  const ctx = setup(t, '');
  const before = git(ctx.root, 'rev-parse', 'HEAD');
  assert.equal((await runRelease(ctx)).kind, 'noop');
  assert.equal(git(ctx.root, 'rev-parse', 'HEAD'), before);
  assert.equal(ctx.github.writes.length, 0);
});

test('open PRs hold publication; API failures and validation failures leave remote untouched', async t => {
  const ctx = setup(t);
  const before = remoteRef(ctx.root, 'refs/heads/main');
  ctx.github.pages = async endpoint => endpoint.startsWith('/pulls?') ? [{ number: 7, title: 'Pending' }] : [{ filename: 'CHANGELOG.md' }];
  assert.equal((await runRelease(ctx)).kind, 'held');
  ctx.github.pages = async () => { throw new Error('API failed'); };
  await assert.rejects(runRelease(ctx), /API failed/);
  ctx.github.pages = async () => [];
  await assert.rejects(runRelease({ ...ctx, validate: () => { throw new Error('Cut validation failed'); } }), /Cut validation failed/);
  assert.equal(remoteRef(ctx.root, 'refs/heads/main'), before);
  assert.equal(remoteRef(ctx.root, 'refs/tags/v0.4.1'), undefined);
  assert.equal(ctx.github.writes.length, 0);
});

test('release POST failure recovers exact tagged cut after main advances, without releasing new notes', async t => {
  const ctx = setup(t);
  const request = ctx.github.request;
  ctx.github.request = async () => { throw new Error('POST unavailable'); };
  await assert.rejects(runRelease(ctx), /POST unavailable/);
  const cut = remoteRef(ctx.root, 'refs/tags/v0.4.1');
  assert.ok(cut);
  const changelog = path.join(ctx.root, 'CHANGELOG.md');
  fs.writeFileSync(changelog, fs.readFileSync(changelog, 'utf8').replace('## [Unreleased]', '## [Unreleased]\n\n### Added\n- Future feature.'));
  git(ctx.root, 'add', 'CHANGELOG.md');
  git(ctx.root, 'commit', '-m', 'Future work');
  git(ctx.root, 'push', 'origin', 'main');
  ctx.github.request = request;
  const result = await runRelease(ctx);
  assert.equal(result.kind, 'recovered');
  assert.equal(result.commit, cut);
  assert.match(ctx.github.writes[0].body, /fixture fix/);
  assert.doesNotMatch(ctx.github.writes[0].body, /Future|Historical/);
  assert.equal(currentState(ctx.root).changelog.hasNotes, true);
  assert.equal(remoteRef(ctx.root, 'refs/tags/v0.5.0'), undefined);
});

test('a successful but response-lost POST is idempotent on rerun', async t => {
  const ctx = setup(t);
  const request = ctx.github.request;
  ctx.github.request = async (...args) => { await request(...args); throw new Error('response lost'); };
  await assert.rejects(runRelease(ctx), /response lost/);
  assert.equal((await runRelease(ctx)).kind, 'noop');
  assert.equal(ctx.github.writes.length, 1);
});

test('conflicting tags or releases are never overwritten', async t => {
  const ctx = setup(t);
  git(ctx.root, 'tag', 'v0.4.1');
  git(ctx.root, 'push', 'origin', 'v0.4.1');
  const before = remoteRef(ctx.root, 'refs/tags/v0.4.1');
  await assert.rejects(runRelease(ctx), /already exists/);
  assert.equal(remoteRef(ctx.root, 'refs/tags/v0.4.1'), before);
  assert.equal(ctx.github.writes.length, 0);
});

test('release notes changed after publication cause an explicit conflict', async t => {
  const ctx = setup(t);
  await runRelease(ctx);
  ctx.github.releases.get('v0.4.1').body = 'Changed externally';
  await assert.rejects(runRelease(ctx), /notes differ/);
  assert.equal(ctx.github.writes.length, 1);
});

test('concurrent main push during validation aborts without tagging the newer main', async t => {
  const ctx = setup(t);
  const other = path.join(ctx.temp, 'other');
  git(ctx.temp, 'clone', '-b', 'main', ctx.remote, other);
  git(other, 'config', 'user.name', 'Concurrent fixture');
  git(other, 'config', 'user.email', 'concurrent@example.invalid');
  await assert.rejects(runRelease({
    ...ctx,
    validate: () => {
      fs.writeFileSync(path.join(other, 'concurrent.txt'), 'Concurrent push\n');
      git(other, 'add', '.');
      git(other, 'commit', '-m', 'Concurrent push');
      git(other, 'push', 'origin', 'main');
    },
  }), /main moved/);
  assert.equal(remoteRef(ctx.root, 'refs/heads/main'), git(other, 'rev-parse', 'HEAD'));
  assert.equal(remoteRef(ctx.root, 'refs/tags/v0.4.1'), undefined);
});

test('atomic push rejection leaves both remote refs unchanged', async t => {
  const ctx = setup(t);
  const before = remoteRef(ctx.root, 'refs/heads/main');
  // Reject only the tag: without --atomic the main commit would still land.
  fs.writeFileSync(path.join(ctx.remote, 'hooks', 'update'), '#!/bin/sh\ncase "$1" in refs/tags/*) exit 1;; esac\nexit 0\n', { mode: 0o755 });
  await assert.rejects(runRelease(ctx), /push/);
  assert.equal(remoteRef(ctx.root, 'refs/heads/main'), before);
  assert.equal(remoteRef(ctx.root, 'refs/tags/v0.4.1'), undefined);
  assert.equal(ctx.github.writes.length, 0);
});

test('explicit major, tracked lock synchronization, and release-due recovery status', async t => {
  const ctx = setup(t, '### Removed\n- Remove an old contract.');
  const lock = 'skills/diagram-renderer/package-lock.json';
  fs.writeFileSync(path.join(ctx.root, lock), '{"version":"0.4.0","lockfileVersion":3,"packages":{"":{"version":"0.4.0"}}}\n');
  git(ctx.root, 'add', lock);
  git(ctx.root, 'commit', '-m', 'Track lock fixture');
  git(ctx.root, 'push', 'origin', 'main');
  const result = await runRelease({ ...ctx, version: '1.0.0', allowMajor: true });
  assert.equal(result.tag, 'v1.0.0');
  assert.equal(readAt(ctx.root, result.commit).documents[lock].packages[''].version, '1.0.0');
  assert.equal((await evaluate(ctx.root, ctx.github)).kind, 'published');
  ctx.github.releases.delete('v1.0.0');
  assert.equal((await evaluate(ctx.root, ctx.github)).kind, 'recovery');
});

test('unverified historical tag without a release fails instead of retagging current main', async t => {
  const ctx = setup(t);
  ctx.github.releases.delete('v0.4.0');
  await assert.rejects(runRelease(ctx), /not an automation cut/);
  assert.equal(ctx.github.writes.length, 0);
});

test('a PR opened during validation holds the cut without changing remote refs', async t => {
  const ctx = setup(t);
  const before = remoteRef(ctx.root, 'refs/heads/main');
  const result = await runRelease({
    ...ctx,
    validate: () => {
      ctx.github.pages = async endpoint => endpoint.startsWith('/pulls?') ? [{ number: 8, title: 'New PR' }] : [{ filename: 'CHANGELOG.md' }];
    },
  });
  assert.equal(result.kind, 'held');
  assert.deepEqual(result.pulls.map(pull => pull.number), [8]);
  assert.equal(remoteRef(ctx.root, 'refs/heads/main'), before);
  assert.equal(remoteRef(ctx.root, 'refs/tags/v0.4.1'), undefined);
});

test('an ignored generated lock is updated locally but is never introduced into the cut', async t => {
  const ctx = setup(t);
  fs.writeFileSync(path.join(ctx.root, '.gitignore'), 'package-lock.json\n');
  git(ctx.root, 'add', '.gitignore');
  git(ctx.root, 'commit', '-m', 'Ignore generated lock');
  git(ctx.root, 'push', 'origin', 'main');
  const lock = 'skills/diagram-renderer/package-lock.json';
  fs.writeFileSync(path.join(ctx.root, lock), '{"version":"0.4.0","lockfileVersion":3,"packages":{"":{"version":"0.4.0"}}}\n');
  const result = await runRelease(ctx);
  assert.equal(currentState(ctx.root).documents[lock].version, '0.4.1');
  assert.equal(git(ctx.root, 'ls-tree', '--name-only', result.commit, '--', lock), '');
  assert.equal((await runRelease(ctx)).kind, 'noop');
});

test('recovery rejects a cut with unexpected files instead of publishing it', async t => {
  const ctx = setup(t);
  const { planRelease, applyPlan } = require('./plan-release');
  const base = git(ctx.root, 'rev-parse', 'HEAD');
  applyPlan(ctx.root, planRelease(currentState(ctx.root), { date: ctx.date }));
  fs.writeFileSync(path.join(ctx.root, 'unexpected.txt'), 'Not part of a release cut\n');
  git(ctx.root, 'add', '.');
  git(ctx.root, 'commit', '-m', `chore(release): v0.4.1\n\nRelease-Version: 0.4.1\nRelease-Base: ${base}`);
  git(ctx.root, 'tag', 'v0.4.1');
  git(ctx.root, 'push', 'origin', 'main', 'v0.4.1');
  await assert.rejects(runRelease(ctx), /unexpected or missing files/);
  assert.equal(ctx.github.writes.length, 0);
});
