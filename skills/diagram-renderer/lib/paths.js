// paths.js — Where diagram-renderer keeps what it installs at run time.
//
// The skill directory is shipped by a plugin host, and some hosts copy the
// whole plugin directory on every turn: VS Code's AgentPluginManager syncs each
// installed plugin into %APPDATA%\Code\agentPlugins. mermaid-cli + puppeteer
// are ~33,000 files, so a node_modules/ under the skill directory made every
// turn copy them, run out of file handles (EMFILE) and hang for ~10 minutes.
//
// Nothing installed at run time lives under the skill directory. It goes to a
// per-user data directory instead:
//
//   <data>/runtime/node_modules   mermaid-cli, puppeteer, fast-xml-parser (bin/setup.js)
//   <data>/icons                  the local icon mirror (scripts/fetch-icons.sh)
//
// <data> is $DIAGRAM_RENDERER_DATA when set, otherwise
//   Windows  %LOCALAPPDATA%\diagram-renderer
//   macOS    ~/Library/Application Support/diagram-renderer
//   others   ${XDG_DATA_HOME:-~/.local/share}/diagram-renderer
//
// Installs made the old way, under the skill directory itself (node_modules/,
// .local-assets/), are still found, so nothing breaks before `bin/setup.js`
// moves them out. A development clone can keep `npm install`-ing in place.
//
// Every function takes optional { env, platform, home, skillRoot } overrides so
// the resolution rules can be tested without touching the real machine.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const SKILL_ROOT = path.resolve(__dirname, '..');
const DATA_ENV = 'DIAGRAM_RENDERER_DATA';
const SETUP_SCRIPT = path.join(SKILL_ROOT, 'bin', 'setup.js');

function dataDir({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  if (env[DATA_ENV]) return path.resolve(env[DATA_ENV]);
  if (platform === 'win32') {
    return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'diagram-renderer');
  }
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'diagram-renderer');
  }
  // The XDG spec says a relative XDG_DATA_HOME is invalid and must be ignored.
  const xdg = env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : null;
  return path.join(xdg || path.join(home, '.local', 'share'), 'diagram-renderer');
}

function runtimeDir(opts) {
  return path.join(dataDir(opts), 'runtime');
}

function iconsDir(opts) {
  return path.join(dataDir(opts), 'icons');
}

function legacyIconsDir({ skillRoot = SKILL_ROOT } = {}) {
  return path.join(skillRoot, '.local-assets');
}

// The icon mirror to read from. The data directory's wins; a mirror left under
// the skill directory by an older version is used only when there is no new
// one. With neither, the data directory's (absent) path is returned so that
// warnings and error messages name where the mirror belongs.
function defaultAssetRoot(opts = {}) {
  const current = iconsDir(opts);
  if (fs.existsSync(current)) return current;
  const legacy = legacyIconsDir(opts);
  if (fs.existsSync(legacy)) return legacy;
  return current;
}

// Where to look for runtime dependencies, in order. The data directory's
// runtime comes first only when it is current: a lookup from it also walks up
// through every ancestor node_modules (e.g. a stray ~/node_modules), and a
// runtime left behind by another version of the skill must not shadow a
// development clone's own install. The runtime stays as a fallback either way.
function dependencyRoots(opts = {}) {
  const runtime = runtimeDir(opts);
  const skill = opts.skillRoot || SKILL_ROOT;
  if (!fs.existsSync(path.join(runtime, 'node_modules'))) return [skill];
  return runtimeStatus(opts).current ? [runtime, skill] : [skill, runtime];
}

// Resolve a runtime dependency (a bare module id such as 'puppeteer' or
// 'fast-xml-parser/package.json') from dependencyRoots(), in order.
function resolveDependency(request, opts = {}) {
  let lastError = null;
  for (const root of dependencyRoots(opts)) {
    try {
      return require.resolve(request, { paths: [root] });
    } catch (e) {
      if (e.code !== 'MODULE_NOT_FOUND') throw e;
      lastError = e;
    }
  }
  throw lastError;
}

function missingDependencyError(name, opts) {
  const err = new Error(
    `${name} is not installed. Run \`node "${SETUP_SCRIPT}"\` to install diagram-renderer's ` +
    `dependencies into ${runtimeDir(opts)}. Do not run \`npm install\` inside the skill directory: ` +
    'plugin hosts such as VS Code copy that directory on every turn, and ~33,000 dependency files ' +
    'make each turn hang.'
  );
  err.code = 'DIAGRAM_RENDERER_DEPENDENCY_MISSING';
  return err;
}

function requireDependency(name, opts) {
  let resolved;
  try {
    resolved = resolveDependency(name, opts);
  } catch (e) {
    if (e.code !== 'MODULE_NOT_FOUND') throw e;
    throw missingDependencyError(name, opts);
  }
  return require(resolved);
}

function sameDependencies(a, b) {
  const ka = Object.keys(a || {}).sort();
  const kb = Object.keys(b || {}).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
}

// Written by bin/setup.js only after `npm install` succeeds, recording the
// dependency ranges that install satisfied. The runtime's package.json cannot
// serve: it is written before npm runs, so a failed upgrade would leave new
// ranges over old packages and look current.
const RUNTIME_STAMP = '.diagram-renderer-installed.json';

function writeRuntimeStamp(dependencies, opts) {
  const file = path.join(runtimeDir(opts), RUNTIME_STAMP);
  fs.writeFileSync(file, JSON.stringify({ dependencies }, null, 2) + '\n');
}

function clearRuntimeStamp(opts) {
  fs.rmSync(path.join(runtimeDir(opts), RUNTIME_STAMP), { force: true });
}

// Whether the data directory's runtime matches the dependencies this skill
// version declares.
//   present — setup has created the runtime directory
//   installed — an install into it finished (the stamp exists)
//   stale   — that install was for other dependency ranges (the plugin was
//             updated since, or an upgrade failed part way)
//   current — installed for exactly these ranges, with every package present
function runtimeStatus(opts = {}) {
  const dir = runtimeDir(opts);
  const wanted = opts.dependencies || require('../package.json').dependencies || {};
  let recorded = null;
  try {
    recorded = JSON.parse(fs.readFileSync(path.join(dir, RUNTIME_STAMP), 'utf8')).dependencies || {};
  } catch (_) {}
  const missing = Object.keys(wanted).filter(
    (name) => !fs.existsSync(path.join(dir, 'node_modules', ...name.split('/'), 'package.json'))
  );
  const stale = recorded !== null && !sameDependencies(recorded, wanted);
  return {
    dir,
    present: recorded !== null || fs.existsSync(path.join(dir, 'package.json')),
    installed: recorded !== null,
    missing,
    stale,
    current: recorded !== null && !stale && missing.length === 0,
  };
}

// Move an icon mirror that an older version wrote under the skill directory to
// the data directory. Never overwrites: when both exist the legacy one is left
// alone and reported, because merging two users' packs is not ours to decide.
function migrateLegacyIcons(opts = {}) {
  const legacy = legacyIconsDir(opts);
  const target = iconsDir(opts);
  if (!fs.existsSync(legacy)) return { moved: false, reason: 'no-legacy', legacy, target };
  if (fs.existsSync(target)) return { moved: false, reason: 'target-exists', legacy, target };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    fs.renameSync(legacy, target);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    fs.cpSync(legacy, target, { recursive: true, errorOnExist: true, force: false });
    fs.rmSync(legacy, { recursive: true, force: true });
  }
  return { moved: true, reason: 'moved', legacy, target };
}

module.exports = {
  DATA_ENV,
  RUNTIME_STAMP,
  SETUP_SCRIPT,
  SKILL_ROOT,
  clearRuntimeStamp,
  dataDir,
  defaultAssetRoot,
  dependencyRoots,
  iconsDir,
  legacyIconsDir,
  migrateLegacyIcons,
  requireDependency,
  resolveDependency,
  runtimeDir,
  runtimeStatus,
  writeRuntimeStamp,
};
