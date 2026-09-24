'use strict';

const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { MANIFESTS, LOCK, releaseNotes, planRelease, applyPlan } = require('./plan-release');
const { git, currentState, readAt, remoteRef, runRelease, outputsOf } = require('./release');

const ROOT = path.join(__dirname, '..');
const WORK = path.join(require('node:os').tmpdir(), 'diagram-renderer-tests');
const DATE = '2026-09-25';
const BASE_LOG = '# Changelog\n\nPreamble.\n\n## [0.6.0] — 2026-09-18\n\n### Added\n\n- Previous release.\n';

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

function changeFile(type, summary, breaking = false) {
  return `---\ntype: ${type}\n${breaking ? 'breaking: true\n' : ''}---\n${summary}\n`;
}

function githubFixture() {
  const releases = new Map([['v0.6.0', { tag_name: 'v0.6.0', body: 'Legacy release', draft: false, prerelease: false }]]);
  const writes = [];
  return {
    repository: 'owner/repo', releases, writes,
    release: async (tag) => releases.get(tag) || null,
    request: async (method, endpoint, body) => {
      assert.equal(method, 'POST');
      assert.equal(endpoint, '/releases');
      assert.ok(!releases.has(body.tag_name), 'must never overwrite a release');
      releases.set(body.tag_name, body);
      writes.push(body);
      return body;
    },
  };
}

function setup(t, { changes = true } = {}) {
  const temp = tmp(t, 'release');
  const remote = path.join(temp, 'origin.git');
  const root = path.join(temp, 'work');
  fs.mkdirSync(root);
  git(temp, 'init', '--bare', remote);
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Release test');
  git(root, 'config', 'user.email', 'test@example.invalid');
  git(root, 'config', 'core.autocrlf', 'false');
  git(root, 'remote', 'add', 'origin', remote);
  const manifest = `${JSON.stringify({ name: 'fixture', version: '0.6.0', private: true }, null, 2)}\n`;
  for (const file of MANIFESTS) put(root, file, manifest);
  put(root, 'CHANGELOG.md', BASE_LOG);
  put(root, 'changes/README.md', '# how\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'Initial fixture');
  git(root, 'tag', 'v0.6.0');
  git(root, 'push', 'origin', 'main', 'v0.6.0');

  if (changes) {
    git(root, 'checkout', '-q', '-b', 'feat-a');
    put(root, 'changes/feat-a.md', changeFile('added', 'A new layout.'));
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'add a change file');
    git(root, 'checkout', '-q', 'main');
    git(root, 'merge', '--no-ff', '-m', 'feat: a new layout (#99) (#12)', 'feat-a');
    put(root, 'changes/fix-b.md', changeFile('fixed', 'Correct an offset.'));
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'fix: an offset (#15)');
    git(root, 'push', 'origin', 'main');
  }
  return { root, remote, temp, github: githubFixture(), date: DATE };
}

test('real git cut publishes notes with PR numbers, deletes change files, and reruns as noop', async (t) => {
  const ctx = setup(t);
  const result = await runRelease(ctx);
  assert.equal(result.kind, 'released');
  assert.equal(result.tag, 'v0.7.0');
  assert.equal(remoteRef(ctx.root, 'refs/heads/main'), result.commit);
  assert.equal(remoteRef(ctx.root, 'refs/tags/v0.7.0'), result.commit);
  const state = currentState(ctx.root);
  assert.equal(state.version, '0.7.0');
  assert.deepEqual(state.changes, []);
  const notes = '### Added\n\n- A new layout. (#12)\n\n### Fixed\n\n- Correct an offset. (#15)';
  assert.equal(ctx.github.writes[0].body, notes);
  assert.equal(releaseNotes(fs.readFileSync(path.join(ctx.root, 'CHANGELOG.md'), 'utf8'), '0.7.0'), notes);
  assert.deepEqual(fs.readdirSync(path.join(ctx.root, 'changes')), ['README.md']);
  const again = await runRelease(ctx);
  assert.equal(again.kind, 'noop');
  assert.equal(ctx.github.writes.length, 1);
});

test('release POST failure recovers the tagged cut after main advances with a new change file', async (t) => {
  const ctx = setup(t);
  const request = ctx.github.request;
  ctx.github.request = async () => { throw new Error('POST unavailable'); };
  await assert.rejects(runRelease(ctx), /POST unavailable/);
  const cut = remoteRef(ctx.root, 'refs/tags/v0.7.0');
  assert.ok(cut);
  put(ctx.root, 'changes/future.md', changeFile('fixed', 'Future fix.'));
  git(ctx.root, 'add', '.');
  git(ctx.root, 'commit', '-m', 'fix: future (#22)');
  git(ctx.root, 'push', 'origin', 'main');
  ctx.github.request = request;
  const result = await runRelease(ctx);
  assert.equal(result.kind, 'recovered');
  assert.equal(result.commit, cut);
  assert.match(ctx.github.writes[0].body, /A new layout/);
  assert.doesNotMatch(ctx.github.writes[0].body, /Future fix/);
  assert.equal(currentState(ctx.root).changes.length, 1);
  assert.equal(remoteRef(ctx.root, 'refs/tags/v0.7.1'), undefined);
});

test('response-lost publication is idempotent on rerun', async (t) => {
  const ctx = setup(t);
  const request = ctx.github.request;
  ctx.github.request = async (...args) => { await request(...args); throw new Error('response lost'); };
  await assert.rejects(runRelease(ctx), /response lost/);
  const again = await runRelease(ctx);
  assert.equal(again.kind, 'noop');
  assert.equal(ctx.github.writes.length, 1);
});

test('conflicting tag or release is refused without publishing', async (t) => {
  const tagConflict = setup(t);
  git(tagConflict.root, 'tag', 'v0.7.0');
  git(tagConflict.root, 'push', 'origin', 'v0.7.0');
  await assert.rejects(runRelease(tagConflict), /already exists/);
  assert.equal(tagConflict.github.writes.length, 0);

  const releaseConflict = setup(t);
  releaseConflict.github.releases.set('v0.7.0', { tag_name: 'v0.7.0', body: 'wrong', draft: false, prerelease: false });
  await assert.rejects(runRelease(releaseConflict), /already exists/);
  assert.equal(releaseConflict.github.writes.length, 0);
});

test('published notes changed externally cause an explicit conflict', async (t) => {
  const ctx = setup(t);
  await runRelease(ctx);
  ctx.github.releases.get('v0.7.0').body = 'Changed externally';
  await assert.rejects(runRelease(ctx), /notes differ/);
});

test('concurrent main push during validation aborts without tagging the newer main', async (t) => {
  const ctx = setup(t);
  const other = path.join(ctx.temp, 'other');
  git(ctx.temp, 'clone', '-b', 'main', ctx.remote, other);
  git(other, 'config', 'user.name', 'Concurrent fixture');
  git(other, 'config', 'user.email', 'concurrent@example.invalid');
  await assert.rejects(runRelease({
    ...ctx,
    validate: () => {
      put(other, 'concurrent.txt', 'Concurrent push\n');
      git(other, 'add', '.');
      git(other, 'commit', '-m', 'Concurrent push');
      git(other, 'push', 'origin', 'main');
    },
  }), /main moved/);
  assert.equal(remoteRef(ctx.root, 'refs/heads/main'), git(other, 'rev-parse', 'HEAD'));
  assert.equal(remoteRef(ctx.root, 'refs/tags/v0.7.0'), undefined);
  assert.equal(ctx.github.writes.length, 0);
});

test('atomic push rejection leaves both remote refs unchanged', async (t) => {
  const ctx = setup(t);
  const before = remoteRef(ctx.root, 'refs/heads/main');
  put(ctx.remote, 'hooks/update', '#!/bin/sh\ncase "$1" in refs/tags/*) exit 1;; esac\nexit 0\n');
  fs.chmodSync(path.join(ctx.remote, 'hooks', 'update'), 0o755);
  await assert.rejects(runRelease(ctx), /push/);
  assert.equal(remoteRef(ctx.root, 'refs/heads/main'), before);
  assert.equal(remoteRef(ctx.root, 'refs/tags/v0.7.0'), undefined);
  assert.equal(ctx.github.writes.length, 0);
});

test('explicit major synchronizes a tracked lock', async (t) => {
  const ctx = setup(t);
  put(ctx.root, LOCK, '{"version":"0.6.0","lockfileVersion":3,"packages":{"":{"version":"0.6.0"}}}\n');
  git(ctx.root, 'add', LOCK);
  git(ctx.root, 'commit', '-m', 'Track lock fixture');
  git(ctx.root, 'push', 'origin', 'main');
  const result = await runRelease({ ...ctx, version: '1.0.0', allowMajor: true });
  assert.equal(result.tag, 'v1.0.0');
  assert.equal(readAt(ctx.root, result.commit).documents[LOCK].packages[''].version, '1.0.0');
});

test('recovery rejects a cut with unexpected files instead of publishing it', async (t) => {
  const ctx = setup(t);
  const base = git(ctx.root, 'rev-parse', 'HEAD');
  const plan = planRelease(currentState(ctx.root), { date: ctx.date });
  applyPlan(ctx.root, plan);
  put(ctx.root, 'unexpected.txt', 'Not part of a release cut\n');
  git(ctx.root, 'add', '.');
  git(ctx.root, 'commit', '-m', `chore(release): v0.7.0\n\nRelease-Version: 0.7.0\nRelease-Base: ${base}`);
  git(ctx.root, 'tag', 'v0.7.0');
  git(ctx.root, 'push', 'origin', 'main', 'v0.7.0');
  await assert.rejects(runRelease(ctx), /unexpected or missing files/);
  assert.equal(ctx.github.writes.length, 0);
});

test('an ignored local lock is updated locally but never introduced into the cut', async (t) => {
  const ctx = setup(t);
  put(ctx.root, '.gitignore', 'package-lock.json\n');
  git(ctx.root, 'add', '.gitignore');
  git(ctx.root, 'commit', '-m', 'Ignore generated lock');
  git(ctx.root, 'push', 'origin', 'main');
  put(ctx.root, LOCK, '{"version":"0.6.0","lockfileVersion":3,"packages":{"":{"version":"0.6.0"}}}\n');
  const result = await runRelease(ctx);
  assert.equal(JSON.parse(fs.readFileSync(path.join(ctx.root, ...LOCK.split('/')), 'utf8')).version, '0.7.0');
  assert.equal(git(ctx.root, 'ls-tree', '--name-only', result.commit, '--', LOCK), '');
  assert.equal((await runRelease(ctx)).kind, 'noop');
});

test('unverified historical tag without a release fails instead of retagging current main', async (t) => {
  const ctx = setup(t, { changes: false });
  ctx.github.releases.delete('v0.6.0');
  await assert.rejects(runRelease(ctx), /not an automation cut/);
  assert.equal(ctx.github.writes.length, 0);
});

test('recovery rejects a cut whose diff mentions a change file but leaves it present', async (t) => {
  const ctx = setup(t);
  const base = git(ctx.root, 'rev-parse', 'HEAD');
  const original = fs.readFileSync(path.join(ctx.root, 'changes', 'feat-a.md'), 'utf8');
  const plan = planRelease(currentState(ctx.root), { date: ctx.date });
  applyPlan(ctx.root, plan);
  put(ctx.root, 'changes/feat-a.md', `${original}\n`);
  git(ctx.root, 'add', '.');
  git(ctx.root, 'commit', '-m', `chore(release): v0.7.0\n\nRelease-Version: 0.7.0\nRelease-Base: ${base}`);
  git(ctx.root, 'tag', 'v0.7.0');
  git(ctx.root, 'push', 'origin', 'main', 'v0.7.0');
  await assert.rejects(runRelease(ctx), /should delete changes\/feat-a\.md/);
  assert.equal(ctx.github.writes.length, 0);
});

test('a change pushed straight to main fails the run, publishing nothing, until a pull request renames it', async (t) => {
  const ctx = setup(t, { changes: false });
  put(ctx.root, 'changes/direct.md', changeFile('fixed', 'Pushed straight to main.'));
  git(ctx.root, 'add', '.');
  git(ctx.root, 'commit', '-m', 'pushed straight to main');
  git(ctx.root, 'push', 'origin', 'main');
  const before = remoteRef(ctx.root, 'refs/heads/main');
  await assert.rejects(runRelease(ctx), /Release refused: changes\/direct\.md did not arrive through a pull request/);
  assert.equal(remoteRef(ctx.root, 'refs/heads/main'), before);
  assert.equal(remoteRef(ctx.root, 'refs/tags/v0.6.1'), undefined);
  assert.equal(ctx.github.writes.length, 0);
  git(ctx.root, 'checkout', '-q', '-b', 'number-it');
  git(ctx.root, 'mv', 'changes/direct.md', 'changes/direct-1.md');
  git(ctx.root, 'commit', '-m', 'number it');
  git(ctx.root, 'checkout', '-q', 'main');
  git(ctx.root, 'merge', '--no-ff', '-m', 'chore: number a change (#21)', 'number-it');
  git(ctx.root, 'push', 'origin', 'main');
  const result = await runRelease(ctx);
  assert.equal(result.kind, 'released');
  assert.equal(ctx.github.writes[0].body, '### Fixed\n\n- Pushed straight to main. (#21)');
});

test('a removal past 1.0.0 fails the run rather than leaving it green', async (t) => {
  const ctx = setup(t, { changes: false });
  const manifest = `${JSON.stringify({ name: 'fixture', version: '1.0.0', private: true }, null, 2)}\n`;
  for (const file of MANIFESTS) put(ctx.root, file, manifest);
  put(ctx.root, 'CHANGELOG.md', BASE_LOG.replace('0.6.0', '1.0.0'));
  git(ctx.root, 'add', '.');
  git(ctx.root, 'commit', '-m', 'release 1.0.0 by hand');
  git(ctx.root, 'tag', 'v1.0.0');
  ctx.github.releases.set('v1.0.0', { tag_name: 'v1.0.0', body: 'By hand', draft: false, prerelease: false });
  put(ctx.root, 'changes/drop.md', changeFile('removed', 'Drop an option.'));
  git(ctx.root, 'add', '.');
  git(ctx.root, 'commit', '-m', 'feat!: drop an option (#30)');
  git(ctx.root, 'push', 'origin', 'main', 'v1.0.0');
  await assert.rejects(runRelease(ctx), /Release refused: changes\/drop\.md is a removal past 1\.0\.0/);
  assert.equal(ctx.github.writes.length, 0);
});

test('the release CLI refuses push events before any GitHub or git work', () => {
  const result = cp.spawnSync(process.execPath, [path.join(__dirname, 'release.js')], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'push' },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /schedule or workflow_dispatch/);
});

test('the workflow is told a version was published, and which, only when one was', () => {
  assert.equal(outputsOf({ kind: 'released', tag: 'v0.6.1', commit: 'abc' }), 'published=true\ntag=v0.6.1\n');
  assert.equal(outputsOf({ kind: 'recovered', tag: 'v0.6.1', commit: 'abc' }), 'published=true\ntag=v0.6.1\n');
  assert.equal(outputsOf({ kind: 'noop', reason: 'no change files' }), 'published=false\ntag=\n');
  assert.equal(outputsOf(null), 'published=false\ntag=\n');
  const src = fs.readFileSync(path.join(__dirname, 'release.js'), 'utf8');
  assert.match(src, /if \(process\.env\.GITHUB_OUTPUT\) fs\.appendFileSync\(process\.env\.GITHUB_OUTPUT, outputsOf\(result\)\);/);
});
