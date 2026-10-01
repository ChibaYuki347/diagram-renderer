#!/usr/bin/env node
// setup — install diagram-renderer's runtime dependencies OUTSIDE the plugin,
// and clear out what older versions left inside it.
//
// Why: plugin hosts such as VS Code copy the whole plugin directory on every
// turn. A node_modules/ inside it (~33,000 files) makes each turn run out of
// file handles and hang. See lib/paths.js for where things go instead.
//
// VS Code runs skills from its own copy (%APPDATA%\Code\agentPlugins\...), so
// the directory this script runs from may not be the one the host copies from.
// Cleanup therefore covers every installed copy of this skill it can find: the
// source of a VS Code copy (from agentPlugins/cache.json), each install under
// ~/.copilot/installed-plugins, and the skill directory itself.
//
// Usage:
//   node bin/setup.js                  install / update, clean up, then report
//   node bin/setup.js --check          report only; exit 1 if not ready to render
//   node bin/setup.js --where icons    print a directory (data | runtime | icons)
//   node bin/setup.js --migrate-icons  only move legacy icon mirrors

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const url = require('url');
const { spawnSync } = require('child_process');
const paths = require('../lib/paths');

const SKILL_ROOT = paths.SKILL_ROOT;
const PKG = require('../package.json');
const DEPENDENCIES = PKG.dependencies || {};
// Resolved to prove rendering can work: mermaid-cli (whose exports map hides its
// package.json, so lib/render.js locates it), puppeteer, which
// lib/render-drawio.js loads directly, and fast-xml-parser.
const PROBES = [
  ['@mermaid-js/mermaid-cli', () => require('../lib/render').resolveMmdc()],
  ['puppeteer', () => paths.resolveDependency('puppeteer')],
  ['fast-xml-parser', () => paths.resolveDependency('fast-xml-parser')],
];

function parseArgs(argv) {
  const args = { check: false, migrateIcons: false, prune: false, help: false, where: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') args.check = true;
    else if (a === '--migrate-icons') args.migrateIcons = true;
    else if (a === '--prune') args.prune = true;
    else if (a === '--where') {
      args.where = argv[++i];
      if (args.where === undefined) {
        console.error('--where takes data, runtime or icons');
        process.exit(2);
      }
    }
    else if (a === '-h' || a === '--help') args.help = true;
    else {
      console.error(`Unknown option: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: setup [--check | --where data|runtime|icons | --migrate-icons] [--prune]

Install diagram-renderer's dependencies (mermaid-cli, puppeteer, fast-xml-parser)
into a per-user data directory, never into the plugin: plugin hosts such as
VS Code copy the plugin directory on every turn.

  (no option)       Install into ${paths.runtimeDir()}
                    (skipped when already current). Then, in every installed
                    copy of this skill (including the one VS Code copies from),
                    move a legacy .local-assets/ icon mirror into
                    ${paths.iconsDir()}
                    (never overwriting: identical files are dropped, differing
                    ones stay and are listed) and remove node_modules/ and
                    package-lock.json.
  --check           Report where everything resolves from; install nothing.
                    Exit 1 if a dependency is missing, the runtime is out of
                    date, or an installed plugin still has node_modules/.
  --where NAME      Print the data, runtime or icons directory and exit.
  --migrate-icons   Only move legacy icon mirrors; install nothing.
  --prune           Also clean this skill directory when it is a development
                    clone (a git checkout outside any plugin host).
  -h, --help        Show this help

Override the data directory with ${paths.DATA_ENV}=<dir>.
`);
}

function realOr(p) {
  try {
    return fs.realpathSync(p);
  } catch (_) {
    return path.resolve(p);
  }
}

function samePath(a, b) {
  const ra = realOr(a);
  const rb = realOr(b);
  return process.platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

function isInside(dir, file) {
  const rel = path.relative(realOr(dir), realOr(file));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function pathSegments(dir) {
  return realOr(dir).split(/[\\/]+/).map((s) => s.toLowerCase());
}

// A directory a plugin host installed or copied, as opposed to a clone someone
// is developing in.
function isHostManaged(dir) {
  const segs = pathSegments(dir);
  return segs.includes('installed-plugins') || segs.includes('agentplugins');
}

function isHostCopy(dir) {
  return pathSegments(dir).includes('agentplugins');
}

function isGitCheckout(dir) {
  let d = realOr(dir);
  for (;;) {
    if (fs.existsSync(path.join(d, '.git'))) return true;
    const parent = path.dirname(d);
    if (parent === d) return false;
    d = parent;
  }
}

// A development clone keeps an in-place `npm install` unless told otherwise.
function isDevClone(dir) {
  return !isHostManaged(dir) && isGitCheckout(dir);
}

function isThisSkill(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name === 'diagram-renderer';
  } catch (_) {
    return false;
  }
}

// A version that reads dependencies and icons from the data directory. An
// older one only looks under its own directory, so it must be left intact.
function knowsDataDir(dir) {
  return fs.existsSync(path.join(dir, 'lib', 'paths.js'));
}

// VS Code keeps each plugin at agentPlugins/<encoded source URI>/<nonce>/ and
// lists the source URIs in agentPlugins/cache.json. The directory name is the
// URI with every run of non-alphanumerics replaced by '-'.
function hostCopySource(skillDir) {
  const copyRoot = path.resolve(skillDir, '..', '..');
  const encoded = path.basename(path.dirname(copyRoot));
  const agentPlugins = path.dirname(path.dirname(copyRoot));
  if (path.basename(agentPlugins).toLowerCase() !== 'agentplugins') return null;
  try {
    const entries = JSON.parse(fs.readFileSync(path.join(agentPlugins, 'cache.json'), 'utf8'));
    const hits = (Array.isArray(entries) ? entries : []).filter(
      (e) => e && typeof e.uri === 'string' && /^file:/i.test(e.uri) &&
        e.uri.replace(/[^A-Za-z0-9]+/g, '-') === encoded
    );
    if (hits.length !== 1) return null;
    return path.join(url.fileURLToPath(hits[0].uri), 'skills', 'diagram-renderer');
  } catch (_) {
    return null;
  }
}

function subdirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(dir, d.name));
  } catch (_) {
    return [];
  }
}

// Every installed copy of this skill: the source of a VS Code copy, each
// install under ~/.copilot/installed-plugins (<marketplace>/<plugin>/ or
// <plugin>/), then the skill directory itself. Sources come first so that a
// legacy icon mirror moves from the copy the host keeps re-syncing.
function skillInstalls({ skillRoot = SKILL_ROOT, home = os.homedir() } = {}) {
  const candidates = [hostCopySource(skillRoot)];
  for (const lvl1 of subdirs(path.join(home, '.copilot', 'installed-plugins'))) {
    candidates.push(path.join(lvl1, 'skills', 'diagram-renderer'));
    for (const lvl2 of subdirs(lvl1)) candidates.push(path.join(lvl2, 'skills', 'diagram-renderer'));
  }
  candidates.push(skillRoot);

  const out = [];
  for (const c of candidates) {
    if (!c || !isThisSkill(c) || out.some((o) => samePath(o.dir, c))) continue;
    out.push({
      dir: realOr(c),
      self: samePath(c, skillRoot),
      hostCopy: isHostCopy(c),
      devClone: isDevClone(c),
      current: knowsDataDir(c),
    });
  }
  return out;
}

// Run npm without a shell: on Windows `npm` is a .cmd shim, which Node only
// spawns through a shell. npm-cli.js sits next to the running node in every
// standard install; fall back to the shim through a shell (with constant
// arguments only) when it does not.
function runNpmInstall(cwd) {
  const args = ['install', '--no-audit', '--no-fund', '--prefix', cwd];
  const nodeDir = path.dirname(process.execPath);
  const candidates = [
    process.env.npm_execpath,
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter((p) => p && /npm-cli\.js$/.test(p) && fs.existsSync(p));
  const r = candidates.length
    ? spawnSync(process.execPath, [candidates[0], ...args], { cwd, stdio: 'inherit' })
    : spawnSync('npm install --no-audit --no-fund', { cwd, stdio: 'inherit', shell: true });
  if (r.error) throw r.error;
  return r.status;
}

function installRuntime() {
  const status = paths.runtimeStatus();
  if (status.current) {
    console.log(`Runtime is current: ${status.dir}`);
    return true;
  }
  fs.mkdirSync(status.dir, { recursive: true });
  // Until npm succeeds, the runtime must not read as installed for anything.
  paths.clearRuntimeStamp();
  const manifest = {
    name: 'diagram-renderer-runtime',
    private: true,
    description: 'Runtime dependencies of the diagram-renderer skill. Managed by its bin/setup.js; safe to delete.',
    dependencies: DEPENDENCIES,
  };
  fs.writeFileSync(path.join(status.dir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Installing ${Object.keys(DEPENDENCIES).join(', ')} into ${status.dir} ...`);
  const code = runNpmInstall(status.dir);
  if (code !== 0) {
    console.error(`npm install failed (exit ${code}) in ${status.dir}`);
    return false;
  }
  paths.writeRuntimeStamp(DEPENDENCIES);
  return paths.runtimeStatus().current;
}

function migrateIcons(install) {
  const r = paths.migrateLegacyIcons({ skillRoot: install.dir });
  if (r.reason === 'moved') {
    console.log(`Moved the icon mirror ${r.legacy} -> ${r.target}`);
  } else if (r.reason === 'reconciled') {
    console.log(
      `Folded the icon mirror ${r.legacy} into ${r.target} ` +
      `(${r.merged} added, ${r.duplicates} identical duplicates removed)`
    );
  } else if (r.reason === 'conflicts') {
    const shown = r.conflicts.slice(0, 5).map((c) => `    ${c}`).join('\n');
    const more = r.conflicts.length > 5 ? `\n    ... and ${r.conflicts.length - 5} more` : '';
    console.warn(
      `Warning: ${r.legacy} still holds ${r.conflicts.length} file(s) that differ from the same path in ${r.target}\n` +
      `  (${r.merged} added, ${r.duplicates} identical duplicates removed). Nothing was overwritten:\n${shown}${more}\n` +
      `  Keep whichever version you want in ${r.target}, then delete ${r.legacy}.`
    );
  } else if (r.reason === 'overlapping') {
    console.warn(`Warning: ${r.legacy} and ${r.target} overlap; ${paths.DATA_ENV} must point outside the skill.`);
  }
}

function removeFrom(dir, name) {
  const p = path.join(dir, name);
  if (!fs.existsSync(p)) return;
  try {
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 5 });
    console.log(`Removed ${p}`);
  } catch (e) {
    console.error(`Could not remove ${p}: ${e.message}\n  Close anything using it and delete it by hand.`);
  }
}

function warnOutdated(install) {
  console.warn(
    `Warning: ${install.dir} is an older diagram-renderer that still keeps its dependencies and icons\n` +
    '  inside the plugin; it was left untouched. Update that plugin (e.g. `copilot plugin update\n' +
    '  diagram-renderer`), then run setup again.'
  );
}

// Move legacy icon mirrors out of, and delete node_modules/ from, every
// installed copy that knows about the data directory. A development clone is
// only touched with --prune (icons are always moved: they are data, not a build).
function cleanInstalls({ prune = false, iconsOnly = false, home, skillRoot } = {}) {
  for (const install of skillInstalls({ home, skillRoot })) {
    if (!install.current) {
      if (fs.existsSync(path.join(install.dir, 'node_modules')) ||
          fs.existsSync(paths.legacyIconsDir({ skillRoot: install.dir }))) {
        warnOutdated(install);
      }
      continue;
    }
    migrateIcons(install);
    if (iconsOnly || (install.devClone && !(prune && install.self))) continue;
    removeFrom(install.dir, 'node_modules');
    removeFrom(install.dir, 'package-lock.json');
  }
}

function resolveOrNull(probe) {
  try {
    return probe() || null;
  } catch (_) {
    return null;
  }
}

function report() {
  const status = paths.runtimeStatus();
  const assetRoot = paths.defaultAssetRoot();
  let ok = true;

  console.log(`data dir : ${paths.dataDir()}`);
  let runtimeNote = 'current';
  if (!status.present) runtimeNote = 'not installed';
  else if (!status.installed) runtimeNote = 'install did not finish — rerun setup';
  else if (status.stale) runtimeNote = 'installed for other dependency versions — rerun setup';
  else if (status.missing.length) runtimeNote = `incomplete (missing ${status.missing.join(', ')}) — rerun setup`;
  if (status.present && !status.current) ok = false;
  console.log(`runtime  : ${status.dir}  (${runtimeNote})`);

  for (const [name, probe] of PROBES) {
    const at = resolveOrNull(probe);
    if (!at) ok = false;
    let where = 'NOT FOUND';
    if (at) where = isInside(status.dir, at) ? 'runtime' : isInside(SKILL_ROOT, at) ? 'skill directory' : 'elsewhere';
    console.log(`  ${name.padEnd(26)} ${where}${at ? `  ${at}` : ''}`);
  }

  let iconNote = 'present';
  if (!fs.existsSync(assetRoot)) iconNote = 'absent — run scripts/fetch-icons.sh';
  else if (samePath(assetRoot, paths.legacyIconsDir())) iconNote = 'legacy location inside the skill — rerun setup to move it';
  console.log(`icons    : ${assetRoot}  (${iconNote})`);

  for (const install of skillInstalls()) {
    const modules = path.join(install.dir, 'node_modules');
    if (!fs.existsSync(modules)) continue;
    if (install.devClone) {
      if (install.self) {
        console.warn(`\nNote: ${modules} exists. Fine in a development clone; remove it with\n  node "${paths.SETUP_SCRIPT}" --prune`);
      }
    } else if (!install.current) {
      console.warn('');
      warnOutdated(install);
    } else {
      // A plugin host copying this directory every turn hangs on it.
      ok = false;
      console.error(
        `\n${modules} exists inside an installed plugin.\n` +
        '  Plugin hosts such as VS Code copy the plugin directory on every turn, and a\n' +
        '  node_modules/ there makes each turn hang.'
      );
    }
  }
  if (!ok) console.error(`\nNot ready. Run: node "${paths.SETUP_SCRIPT}"`);
  return ok;
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return 0;
  }
  if (args.where !== null) {
    const dirs = { data: paths.dataDir, runtime: paths.runtimeDir, icons: paths.iconsDir };
    if (!Object.prototype.hasOwnProperty.call(dirs, args.where)) {
      console.error(`--where takes data, runtime or icons; got '${args.where}'`);
      return 2;
    }
    console.log(dirs[args.where]());
    return 0;
  }
  if (args.migrateIcons) {
    cleanInstalls({ iconsOnly: true });
    return 0;
  }
  if (args.check) return report() ? 0 : 1;

  if (!installRuntime()) return 1;
  // Only after the runtime works: an install's own node_modules is what it
  // renders with until then.
  cleanInstalls({ prune: args.prune });
  console.log('');
  return report() ? 0 : 1;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(e.stack || String(e));
    process.exitCode = 1;
  }
}

module.exports = { cleanInstalls, hostCopySource, isDevClone, isHostManaged, skillInstalls };
