#!/usr/bin/env node
// Tests for lib/paths.js, bin/setup.js and the default draw.io resolver.
//
// What they pin down: nothing diagram-renderer installs at run time goes under
// the skill directory (plugin hosts such as VS Code copy that directory on every
// turn), while installs made there by older versions keep working.
//
// Plain node assertions — no test framework dep. Run via:
//   node test/paths.test.js
//
// Exit code 0 = all pass, 1 = any fail.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const url = require('url');
const assert = require('assert');
const { spawnSync } = require('child_process');

const paths = require('../lib/paths');
// Loaded before any test points DIAGRAM_RENDERER_DATA at a scratch directory,
// so its own dependencies resolve from wherever they are really installed.
const { defaultResolver } = require('../lib/render-drawio');

let passed = 0, failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${(e.stack || e.message).split('\n').slice(0, 5).join('\n    ')}`);
    failed++;
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-paths-test-'));
let seq = 0;
// A fresh { data dir, skill dir } pair per test, so no test sees another's files.
function sandbox() {
  const root = path.join(tmp, String(++seq));
  const data = path.join(root, 'data');
  const skillRoot = path.join(root, 'skill');
  fs.mkdirSync(skillRoot, { recursive: true });
  return { root, data, skillRoot, opts: { env: { DIAGRAM_RENDERER_DATA: data }, skillRoot } };
}

function fakePackage(nodeModules, name, marker) {
  const dir = path.join(nodeModules, ...name.split('/'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', main: 'index.js' }));
  fs.writeFileSync(path.join(dir, 'index.js'), `module.exports = ${JSON.stringify(marker)};\n`);
}

// A runtime as bin/setup.js leaves it after a successful install: package.json
// and the install stamp recording `recorded`, and each package in `installed`
// present under node_modules.
function fakeRuntime(s, recorded, installed = Object.keys(recorded)) {
  const runtime = path.join(s.data, 'runtime');
  fs.mkdirSync(path.join(runtime, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(runtime, 'package.json'), JSON.stringify({ dependencies: recorded }));
  fs.writeFileSync(path.join(runtime, paths.RUNTIME_STAMP), JSON.stringify({ dependencies: recorded }));
  for (const name of installed) fakePackage(path.join(runtime, 'node_modules'), name, 'runtime');
  return runtime;
}

console.log('data directory:');

test('DIAGRAM_RENDERER_DATA overrides the platform default', () => {
  const dir = paths.dataDir({ env: { DIAGRAM_RENDERER_DATA: path.join(tmp, 'x') }, platform: 'win32', home: '/h' });
  assert.strictEqual(dir, path.join(tmp, 'x'));
});

test('Windows uses %LOCALAPPDATA%, falling back to ~/AppData/Local', () => {
  assert.strictEqual(
    paths.dataDir({ env: { LOCALAPPDATA: path.join('L', 'Local') }, platform: 'win32', home: 'H' }),
    path.join('L', 'Local', 'diagram-renderer')
  );
  assert.strictEqual(
    paths.dataDir({ env: {}, platform: 'win32', home: 'H' }),
    path.join('H', 'AppData', 'Local', 'diagram-renderer')
  );
});

test('macOS uses ~/Library/Application Support', () => {
  assert.strictEqual(
    paths.dataDir({ env: {}, platform: 'darwin', home: 'H' }),
    path.join('H', 'Library', 'Application Support', 'diagram-renderer')
  );
});

test('Linux honours an absolute XDG_DATA_HOME and ignores a relative one', () => {
  const xdg = path.resolve(tmp, 'xdg');
  assert.strictEqual(
    paths.dataDir({ env: { XDG_DATA_HOME: xdg }, platform: 'linux', home: 'H' }),
    path.join(xdg, 'diagram-renderer')
  );
  assert.strictEqual(
    paths.dataDir({ env: { XDG_DATA_HOME: 'relative' }, platform: 'linux', home: 'H' }),
    path.join('H', '.local', 'share', 'diagram-renderer')
  );
});

test('the default data directory is outside the skill directory', () => {
  const skill = paths.SKILL_ROOT + path.sep;
  const env = Object.assign({}, process.env);
  delete env.DIAGRAM_RENDERER_DATA;
  for (const p of [paths.dataDir({ env }), paths.runtimeDir({ env }), paths.iconsDir({ env })]) {
    assert.ok(!(p + path.sep).startsWith(skill), `${p} is inside ${skill}`);
  }
});

console.log('\nicon mirror location:');

test('with no mirror anywhere, points at <data>/icons', () => {
  const s = sandbox();
  assert.strictEqual(paths.defaultAssetRoot(s.opts), path.join(s.data, 'icons'));
});

test('uses a mirror an older version left under the skill directory', () => {
  const s = sandbox();
  fs.mkdirSync(path.join(s.skillRoot, '.local-assets'));
  assert.strictEqual(paths.defaultAssetRoot(s.opts), path.join(s.skillRoot, '.local-assets'));
});

test('prefers <data>/icons when both exist', () => {
  const s = sandbox();
  fs.mkdirSync(path.join(s.skillRoot, '.local-assets'));
  fs.mkdirSync(path.join(s.data, 'icons'), { recursive: true });
  assert.strictEqual(paths.defaultAssetRoot(s.opts), path.join(s.data, 'icons'));
});

test('migrateLegacyIcons moves the old mirror out of the skill directory', () => {
  const s = sandbox();
  const legacy = path.join(s.skillRoot, '.local-assets', 'github', 'octicons');
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'repo-24.svg'), '<svg/>');
  const r = paths.migrateLegacyIcons(s.opts);
  assert.strictEqual(r.moved, true);
  assert.ok(!fs.existsSync(path.join(s.skillRoot, '.local-assets')), 'legacy mirror should be gone');
  assert.ok(fs.existsSync(path.join(s.data, 'icons', 'github', 'octicons', 'repo-24.svg')));
});

test('migrateLegacyIcons never overwrites an existing mirror', () => {
  const s = sandbox();
  fs.mkdirSync(path.join(s.skillRoot, '.local-assets', 'azure'), { recursive: true });
  fs.mkdirSync(path.join(s.data, 'icons', 'github'), { recursive: true });
  const r = paths.migrateLegacyIcons(s.opts);
  assert.strictEqual(r.moved, false);
  assert.strictEqual(r.reason, 'target-exists');
  assert.ok(fs.existsSync(path.join(s.skillRoot, '.local-assets', 'azure')), 'legacy mirror must be left alone');
  assert.ok(!fs.existsSync(path.join(s.data, 'icons', 'azure')), 'nothing may be merged in');
});

test('migrateLegacyIcons is a no-op without a legacy mirror', () => {
  const s = sandbox();
  const r = paths.migrateLegacyIcons(s.opts);
  assert.strictEqual(r.moved, false);
  assert.strictEqual(r.reason, 'no-legacy');
  assert.ok(!fs.existsSync(s.data), 'must not create the data directory for nothing');
});

console.log('\ndependency resolution:');

const DEPS = { 'dr-fake-dep': '^1.0.0' };

test('resolves from a current <data>/runtime ahead of the skill directory', () => {
  const s = sandbox();
  const opts = Object.assign({ dependencies: DEPS }, s.opts);
  fakeRuntime(s, DEPS);
  fakePackage(path.join(s.skillRoot, 'node_modules'), 'dr-fake-dep', 'skill');
  assert.strictEqual(paths.requireDependency('dr-fake-dep', opts), 'runtime');
});

test('a stale runtime (other dependency ranges) does not shadow the skill directory', () => {
  const s = sandbox();
  const opts = Object.assign({ dependencies: DEPS }, s.opts);
  fakeRuntime(s, { 'dr-fake-dep': '^0.9.0' });
  fakePackage(path.join(s.skillRoot, 'node_modules'), 'dr-fake-dep', 'skill');
  assert.deepStrictEqual(paths.dependencyRoots(opts), [s.skillRoot, path.join(s.data, 'runtime')]);
  assert.strictEqual(paths.requireDependency('dr-fake-dep', opts), 'skill');
});

test('a stale runtime is still used when nothing else has the package', () => {
  const s = sandbox();
  const opts = Object.assign({ dependencies: DEPS }, s.opts);
  fakeRuntime(s, { 'dr-fake-dep': '^0.9.0' });
  assert.strictEqual(paths.requireDependency('dr-fake-dep', opts), 'runtime');
});

test('falls back to node_modules under the skill directory (dev clone, older installs)', () => {
  const s = sandbox();
  fakePackage(path.join(s.skillRoot, 'node_modules'), 'dr-fake-dep', 'skill');
  assert.deepStrictEqual(paths.dependencyRoots(s.opts), [s.skillRoot]);
  assert.strictEqual(paths.requireDependency('dr-fake-dep', s.opts), 'skill');
});

test('falls back to the skill directory for a package the runtime lacks', () => {
  const s = sandbox();
  const deps = { 'dr-other-dep': '^1.0.0' };
  fakeRuntime(s, deps);
  fakePackage(path.join(s.skillRoot, 'node_modules'), 'dr-fake-dep', 'skill');
  assert.strictEqual(paths.requireDependency('dr-fake-dep', Object.assign({ dependencies: deps }, s.opts)), 'skill');
});

test('a missing dependency points at setup.js, not at npm install in the skill dir', () => {
  const s = sandbox();
  assert.throws(
    () => paths.requireDependency('dr-definitely-not-installed', s.opts),
    (e) => {
      assert.strictEqual(e.code, 'DIAGRAM_RENDERER_DEPENDENCY_MISSING');
      assert.match(e.message, /bin[\\/]setup\.js/);
      assert.match(e.message, /Do not run `npm install` inside the skill directory/);
      assert.ok(e.message.includes(path.join(s.data, 'runtime')), e.message);
      return true;
    }
  );
});

console.log('\nruntime status:');

test('not installed', () => {
  const s = sandbox();
  const st = paths.runtimeStatus(Object.assign({ dependencies: { 'dr-a': '^1.0.0' } }, s.opts));
  assert.deepStrictEqual([st.installed, st.current, st.stale], [false, false, false]);
  assert.deepStrictEqual(st.missing, ['dr-a']);
});

test('current when the recorded dependencies match and are installed', () => {
  const s = sandbox();
  const deps = { 'dr-a': '^1.0.0', '@dr/b': '^2.0.0' };
  fakeRuntime(s, { '@dr/b': '^2.0.0', 'dr-a': '^1.0.0' });
  const st = paths.runtimeStatus(Object.assign({ dependencies: deps }, s.opts));
  assert.strictEqual(st.current, true, JSON.stringify(st));
});

test('stale after the skill changes its dependency ranges (plugin update)', () => {
  const s = sandbox();
  fakeRuntime(s, { 'dr-a': '^1.0.0' });
  const st = paths.runtimeStatus(Object.assign({ dependencies: { 'dr-a': '^2.0.0' } }, s.opts));
  assert.deepStrictEqual([st.installed, st.stale, st.current], [true, true, false]);
});

test('incomplete when a recorded package is missing (interrupted install)', () => {
  const s = sandbox();
  const deps = { 'dr-a': '^1.0.0', 'dr-b': '^1.0.0' };
  fakeRuntime(s, deps, ['dr-a']);
  const st = paths.runtimeStatus(Object.assign({ dependencies: deps }, s.opts));
  assert.deepStrictEqual([st.installed, st.stale, st.current], [true, false, false]);
  assert.deepStrictEqual(st.missing, ['dr-b']);
});

test('a failed upgrade does not read as current (package.json ahead of what is installed)', () => {
  const s = sandbox();
  const runtime = fakeRuntime(s, { 'dr-a': '^1.0.0' });
  // What setup.js leaves when npm fails: new ranges in package.json, stamp
  // cleared, the old packages still in node_modules.
  fs.writeFileSync(path.join(runtime, 'package.json'), JSON.stringify({ dependencies: { 'dr-a': '^2.0.0' } }));
  paths.clearRuntimeStamp(s.opts);
  const st = paths.runtimeStatus(Object.assign({ dependencies: { 'dr-a': '^2.0.0' } }, s.opts));
  assert.deepStrictEqual([st.present, st.installed, st.current], [true, false, false]);
});

test('writeRuntimeStamp marks exactly the ranges that were installed', () => {
  const s = sandbox();
  const deps = { 'dr-a': '^2.0.0' };
  const runtime = fakeRuntime(s, deps);
  fs.rmSync(path.join(runtime, paths.RUNTIME_STAMP));
  assert.strictEqual(paths.runtimeStatus(Object.assign({ dependencies: deps }, s.opts)).current, false);
  paths.writeRuntimeStamp(deps, s.opts);
  assert.strictEqual(paths.runtimeStatus(Object.assign({ dependencies: deps }, s.opts)).current, true);
});

console.log('\nbin/setup.js:');

function setup(args, env) {
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'setup.js'), ...args], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, env),
  });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

test('--where prints the data, runtime and icons directories', () => {
  const data = path.join(tmp, 'where');
  for (const [name, expected] of [['data', data], ['runtime', path.join(data, 'runtime')], ['icons', path.join(data, 'icons')]]) {
    const r = setup(['--where', name], { DIAGRAM_RENDERER_DATA: data });
    assert.strictEqual(r.code, 0, r.stderr);
    assert.strictEqual(r.stdout.trim(), expected);
  }
});

test('--where rejects an unknown name', () => {
  const r = setup(['--where', 'nowhere'], { DIAGRAM_RENDERER_DATA: path.join(tmp, 'where') });
  assert.strictEqual(r.code, 2);
});

test('--check fails on a runtime installed for other dependency versions', () => {
  const s = sandbox();
  fakeRuntime(s, { '@mermaid-js/mermaid-cli': '^1.0.0' });
  const r = setup(['--check'], { DIAGRAM_RENDERER_DATA: s.data });
  assert.strictEqual(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /installed for other dependency versions/);
});

test('--check fails when an install did not finish', () => {
  const s = sandbox();
  fs.mkdirSync(path.join(s.data, 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(s.data, 'runtime', 'package.json'), '{"dependencies":{}}');
  const r = setup(['--check'], { DIAGRAM_RENDERER_DATA: s.data });
  assert.strictEqual(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /install did not finish/);
});

console.log('\ninstalled copies of the skill:');

const { cleanInstalls, hostCopySource, skillInstalls } = require('../bin/setup');

function withData(dir, fn) {
  const saved = process.env.DIAGRAM_RENDERER_DATA;
  process.env.DIAGRAM_RENDERER_DATA = dir;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.DIAGRAM_RENDERER_DATA;
    else process.env.DIAGRAM_RENDERER_DATA = saved;
  }
}

function silenced(fn) {
  const saved = [console.log, console.warn, console.error];
  console.log = console.warn = console.error = () => {};
  try {
    return fn();
  } finally {
    [console.log, console.warn, console.error] = saved;
  }
}

// A skill directory that passes as diagram-renderer; `current` adds the
// lib/paths.js that marks a version reading from the data directory.
function fakeSkill(dir, { current = true } = {}) {
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'diagram-renderer' }));
  if (current) fs.writeFileSync(path.join(dir, 'lib', 'paths.js'), '');
  return dir;
}

// VS Code's layout: agentPlugins/<source URI, non-alphanumerics -> '-'>/<nonce>/
function fakeVsCodeCopy(root, sourcePluginDir) {
  const uri = url.pathToFileURL(sourcePluginDir).href;
  const agentPlugins = path.join(root, 'Code', 'agentPlugins');
  const copy = path.join(agentPlugins, uri.replace(/[^A-Za-z0-9]+/g, '-'), '1a0d784c8aa', 'skills', 'diagram-renderer');
  fakeSkill(copy);
  fs.writeFileSync(path.join(agentPlugins, 'cache.json'), JSON.stringify([
    { uri: 'vscode-synced-customization:/agent-host-copilotcli-1', nonce: '178144352' },
    { uri, nonce: '1a0d784c8aa' },
  ]));
  return copy;
}

test('maps a VS Code agentPlugins copy back to the plugin it was copied from', () => {
  const s = sandbox();
  const source = path.join(s.root, 'home', '.copilot', 'installed-plugins', 'mp', 'diagram-renderer');
  const copy = fakeVsCodeCopy(s.root, source);
  assert.strictEqual(
    path.resolve(hostCopySource(copy)).toLowerCase(),
    path.join(source, 'skills', 'diagram-renderer').toLowerCase()
  );
});

test('no source for a directory outside agentPlugins, or without cache.json', () => {
  const s = sandbox();
  assert.strictEqual(hostCopySource(s.skillRoot), null);
  const orphan = path.join(s.root, 'agentPlugins', 'x', 'n', 'skills', 'diagram-renderer');
  fs.mkdirSync(orphan, { recursive: true });
  assert.strictEqual(hostCopySource(orphan), null);
});

test('finds the source plugin first, then other installs, then the copy running setup', () => {
  const s = sandbox();
  const home = path.join(s.root, 'home');
  const plugins = path.join(home, '.copilot', 'installed-plugins');
  const source = path.join(plugins, 'mp', 'diagram-renderer');
  const sourceSkill = fakeSkill(path.join(source, 'skills', 'diagram-renderer'));
  const direct = fakeSkill(path.join(plugins, 'diagram-renderer', 'skills', 'diagram-renderer'));
  const old = fakeSkill(path.join(plugins, 'other-mp', 'diagram-renderer', 'skills', 'diagram-renderer'), { current: false });
  fakeSkill(path.join(plugins, 'mp', 'not-this', 'skills', 'diagram-renderer'));
  fs.writeFileSync(path.join(plugins, 'mp', 'not-this', 'skills', 'diagram-renderer', 'package.json'), '{"name":"x"}');
  const copy = fakeVsCodeCopy(s.root, source);

  const found = skillInstalls({ skillRoot: copy, home });
  const dirs = found.map((f) => f.dir.toLowerCase());
  assert.strictEqual(dirs[0], fs.realpathSync(sourceSkill).toLowerCase(), 'source must come first');
  assert.strictEqual(dirs[dirs.length - 1], fs.realpathSync(copy).toLowerCase(), 'the running copy comes last');
  assert.ok(dirs.includes(fs.realpathSync(direct).toLowerCase()));
  assert.strictEqual(new Set(dirs).size, dirs.length, 'the source is listed once');
  assert.strictEqual(found.length, 4, JSON.stringify(found, null, 2));

  const byDir = (d) => found.find((f) => f.dir.toLowerCase() === fs.realpathSync(d).toLowerCase());
  assert.strictEqual(byDir(old).current, false, 'an older version is recognised');
  assert.strictEqual(byDir(copy).hostCopy, true);
  assert.strictEqual(byDir(copy).self, true);
  for (const f of found) assert.strictEqual(f.devClone, false, `${f.dir} is host-managed`);
});

test('cleanup reaches the plugin VS Code copies from, and leaves an older version alone', () => {
  const s = sandbox();
  const home = path.join(s.root, 'home');
  const plugins = path.join(home, '.copilot', 'installed-plugins');
  const source = path.join(plugins, 'mp', 'diagram-renderer');
  const sourceSkill = fakeSkill(path.join(source, 'skills', 'diagram-renderer'));
  fakePackage(path.join(sourceSkill, 'node_modules'), 'junk', 'x');
  fs.writeFileSync(path.join(sourceSkill, 'package-lock.json'), '{}');
  fs.mkdirSync(path.join(sourceSkill, '.local-assets', 'github'), { recursive: true });
  const old = fakeSkill(path.join(plugins, 'old-mp', 'diagram-renderer', 'skills', 'diagram-renderer'), { current: false });
  fakePackage(path.join(old, 'node_modules'), 'junk', 'x');
  fs.mkdirSync(path.join(old, '.local-assets'));
  const copy = fakeVsCodeCopy(s.root, source);
  fakePackage(path.join(copy, 'node_modules'), 'junk', 'x');

  withData(s.data, () => silenced(() => cleanInstalls({ skillRoot: copy, home })));

  assert.ok(!fs.existsSync(path.join(sourceSkill, 'node_modules')), 'source plugin node_modules removed');
  assert.ok(!fs.existsSync(path.join(sourceSkill, 'package-lock.json')));
  assert.ok(!fs.existsSync(path.join(sourceSkill, '.local-assets')), 'source plugin icons moved');
  assert.ok(fs.existsSync(path.join(s.data, 'icons', 'github')));
  assert.ok(!fs.existsSync(path.join(copy, 'node_modules')), 'the running copy is cleaned too');
  assert.ok(fs.existsSync(path.join(old, 'node_modules')), 'an older version keeps its node_modules');
  assert.ok(fs.existsSync(path.join(old, '.local-assets')), 'an older version keeps its icons');
});

test('cleanup leaves a development clone alone unless it is pruned', () => {
  const s = sandbox();
  const clone = path.join(s.root, 'clone');
  fs.mkdirSync(path.join(clone, '.git'), { recursive: true });
  const skill = fakeSkill(path.join(clone, 'skills', 'diagram-renderer'));
  fakePackage(path.join(skill, 'node_modules'), 'junk', 'x');
  const home = path.join(s.root, 'home');

  withData(s.data, () => silenced(() => cleanInstalls({ skillRoot: skill, home })));
  assert.ok(fs.existsSync(path.join(skill, 'node_modules')), 'kept without --prune');

  withData(s.data, () => silenced(() => cleanInstalls({ skillRoot: skill, home, prune: true })));
  assert.ok(!fs.existsSync(path.join(skill, 'node_modules')), 'removed with --prune');
});

console.log('\ndefault draw.io resolver:');

test('renderDrawio resolves from the default mirror when no resolver is given', () => {
  const data = path.join(tmp, 'resolver');
  const octicons = path.join(data, 'icons', 'github', 'octicons');
  fs.mkdirSync(octicons, { recursive: true });
  fs.writeFileSync(path.join(octicons, 'repo-24.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const saved = process.env.DIAGRAM_RENDERER_DATA;
  process.env.DIAGRAM_RENDERER_DATA = data;
  try {
    const resolver = defaultResolver();
    assert.ok(resolver, 'expected a resolver over the default mirror');
    const hit = resolver('https://cdn.jsdelivr.net/npm/@primer/octicons@latest/build/svg/repo-24.svg');
    assert.strictEqual(hit.ok, true, JSON.stringify(hit));
    assert.strictEqual(path.resolve(hit.localPath), path.join(octicons, 'repo-24.svg'));
  } finally {
    if (saved === undefined) delete process.env.DIAGRAM_RENDERER_DATA;
    else process.env.DIAGRAM_RENDERER_DATA = saved;
  }
});

test('no default resolver without a mirror', () => {
  const saved = process.env.DIAGRAM_RENDERER_DATA;
  process.env.DIAGRAM_RENDERER_DATA = path.join(tmp, 'no-mirror');
  try {
    // A legacy mirror under the real skill directory would legitimately be
    // found, so only assert when there is none.
    if (!fs.existsSync(paths.legacyIconsDir())) {
      assert.strictEqual(defaultResolver(), null);
    }
  } finally {
    if (saved === undefined) delete process.env.DIAGRAM_RENDERER_DATA;
    else process.env.DIAGRAM_RENDERER_DATA = saved;
  }
});

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
