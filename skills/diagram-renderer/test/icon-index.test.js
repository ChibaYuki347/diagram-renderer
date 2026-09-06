#!/usr/bin/env node
// Tests for icon-index.js + bin/icon-search.js
//
// Plain node assertions — no test framework dep. Run via:
//   node test/icon-index.test.js
//
// Exit code 0 = all pass, 1 = any fail.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { execFileSync } = require('child_process');

const {
  buildIconIndex,
  searchIcons,
  getIcon,
  _internals,
} = require('../lib/icon-index');

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

// --- Build a synthetic mirror mimicking scripts/fetch-icons.sh output --------
//
// fetch-icons.sh writes BOTH a normalized name and the pack's original name,
// so the fixture does too — deduplicating those is the point of the module.

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'icon-index-test-'));
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16"/></svg>';

function put(rel) {
  const abs = path.join(tmpRoot, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, svg);
}

// Azure: normalized + original pack filename
put('azure/databases/Azure_Cosmos_DB.svg');
put('azure/databases/00147-icon-service-Azure-Cosmos-DB.svg');
put('azure/compute/Function_Apps.svg');
put('azure/compute/00029-icon-service-Function-Apps.svg');
put('azure/compute/Virtual_Machines.svg');
// Entra: bw + color flavors, normalized + original
put('entra/color/ID.svg');
put('entra/color/Microsoft Entra ID color icon.svg');
put('entra/bw/ID.svg');
put('entra/bw/Microsoft Entra ID BW icon.svg');
// Power Platform: flattened, _scalable suffix preserved as a variant
put('power-platform/PowerApps.svg');
put('power-platform/PowerApps_scalable.svg');
// Octicons: size suffixes are meaningful, must NOT be deduplicated
put('github/octicons/mark-github-16.svg');
put('github/octicons/repo-16.svg');
put('github/octicons/repo-24.svg');
// Noise that must be excluded
put('_inbox/Azure_Public_Service_Icons.svg');
fs.writeFileSync(path.join(tmpRoot, 'azure', 'Microsoft_Terms_of_Use.pdf'), 'not an icon');

const rules = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'assets', 'icons', 'resolver-rules.json'), 'utf8')
);
const index = buildIconIndex({ assetRoot: tmpRoot, rules });

// --- Tests ------------------------------------------------------------------

console.log('icon-index.js:');

test('missing asset root warns instead of throwing', () => {
  const empty = buildIconIndex({ assetRoot: path.join(tmpRoot, 'does-not-exist'), rules });
  assert.deepStrictEqual(empty.entries, []);
  assert.ok(empty.warnings.some((w) => /not found/.test(w)), JSON.stringify(empty.warnings));
});

test('folds normalized + original pack filenames into one entry', () => {
  const cosmos = index.entries.filter((e) => e.slug === 'azure_cosmos_db');
  assert.strictEqual(cosmos.length, 1, `expected 1 entry, got ${cosmos.map((c) => c.id).join(', ')}`);
  assert.strictEqual(cosmos[0].relPath, 'azure/databases/Azure_Cosmos_DB.svg');
  assert.deepStrictEqual(cosmos[0].variants, ['azure/databases/00147-icon-service-Azure-Cosmos-DB.svg']);
});

test('derives canonical draw.io URL for azure icons', () => {
  const e = getIcon(index, 'azure/compute/function_apps');
  assert.ok(e, 'function_apps not indexed');
  assert.strictEqual(e.url, 'https://app.diagrams.net/img/lib/azure2/compute/Function_Apps.svg');
});

test('derives canonical URL for entra, preserving flavor', () => {
  const color = getIcon(index, 'entra/color/id');
  const bw = getIcon(index, 'entra/bw/id');
  assert.strictEqual(color.url, 'https://aka.ms/entra-icons/color/ID.svg');
  assert.strictEqual(bw.url, 'https://aka.ms/entra-icons/bw/ID.svg');
});

test('derives canonical URL for octicons', () => {
  const e = getIcon(index, 'github/octicons/mark_github_16');
  assert.strictEqual(
    e.url,
    'https://cdn.jsdelivr.net/npm/@primer/octicons@latest/build/svg/mark-github-16.svg'
  );
});

test('derives canonical URL for power-platform and strips _scalable variant', () => {
  // camelCase is split for the id (PowerApps → power_apps), consistent with
  // Function_Apps → function_apps, but the URL keeps the real filename.
  const e = getIcon(index, 'power-platform/power_apps');
  assert.ok(e, `power_apps not indexed; got ${index.entries.map((x) => x.id).join(', ')}`);
  assert.strictEqual(e.url, 'https://aka.ms/power-platform-icons/PowerApps.svg');
  assert.deepStrictEqual(e.variants, ['power-platform/PowerApps_scalable.svg']);
});

test('octicon size variants stay distinct', () => {
  assert.ok(getIcon(index, 'github/octicons/repo_16'));
  assert.ok(getIcon(index, 'github/octicons/repo_24'));
});

test('_inbox and non-icon files are excluded', () => {
  assert.ok(!index.entries.some((e) => e.set === '_inbox'), 'inbox leaked into index');
  assert.ok(!index.entries.some((e) => /\.pdf$/i.test(e.relPath)), 'pdf leaked into index');
});

test('sets are enumerated with counts', () => {
  const names = index.sets.map((s) => s.name);
  assert.deepStrictEqual(names, ['azure', 'entra', 'github', 'power-platform']);
  assert.strictEqual(index.sets.find((s) => s.name === 'azure').count, 3);
});

test('search finds an icon by natural words', () => {
  const hits = searchIcons(index, 'cosmos db');
  assert.ok(hits.length > 0, 'no hits');
  assert.strictEqual(hits[0].id, 'azure/databases/azure_cosmos_db');
});

test('search matches a concatenated product name', () => {
  // The user types "powerapps"; the indexed name is "PowerApps" (id power_apps).
  const hits = searchIcons(index, 'powerapps');
  assert.strictEqual(hits[0].id, 'power-platform/power_apps');
});

test('search ranks an exact slug above partial matches', () => {
  const hits = searchIcons(index, 'function_apps');
  assert.strictEqual(hits[0].id, 'azure/compute/function_apps');
  assert.strictEqual(hits[0].score, 1000);
});

test('--set restricts results to one set', () => {
  const hits = searchIcons(index, 'id', { set: 'entra' });
  assert.ok(hits.length > 0);
  assert.ok(hits.every((h) => h.set === 'entra'), hits.map((h) => h.id).join(', '));
});

test('search honors the limit', () => {
  const hits = searchIcons(index, 'a', { limit: 2 });
  assert.ok(hits.length <= 2);
});

test('search returns [] for an empty query', () => {
  assert.deepStrictEqual(searchIcons(index, '   '), []);
});

test('search returns [] when nothing matches', () => {
  assert.deepStrictEqual(searchIcons(index, 'zzzznotathing'), []);
});

test('getIcon returns null for an unknown id', () => {
  assert.strictEqual(getIcon(index, 'azure/compute/nope'), null);
});

test('entries are JSON-serializable without internal matching fields', () => {
  const json = JSON.parse(JSON.stringify(getIcon(index, 'azure/compute/function_apps')));
  assert.ok(!('_tokens' in json), 'internal _tokens leaked into JSON');
  assert.ok(!('_haystack' in json), 'internal _haystack leaked into JSON');
  assert.deepStrictEqual(
    Object.keys(json).sort(),
    ['file', 'group', 'id', 'name', 'relPath', 'set', 'slug', 'url', 'variants']
  );
});

test('stripVariantDecoration peels stacked pack decorations', () => {
  const r = _internals.stripVariantDecoration('Microsoft Entra ID color icon');
  assert.strictEqual(r.stem, 'ID');
  assert.ok(r.strips >= 2);
  assert.strictEqual(_internals.stripVariantDecoration('ID').strips, 0);
});

test('slugify splits camelCase and normalizes separators', () => {
  assert.strictEqual(_internals.slugify('PowerApps'), 'power_apps');
  assert.strictEqual(_internals.slugify('Azure-Cosmos DB'), 'azure_cosmos_db');
});

test('canonicalUrlFor prefers the longest matching localBase', () => {
  const mappers = _internals.buildUrlMappers(rules);
  const url = _internals.canonicalUrlFor(mappers, 'entra/active_directory/Domain.svg');
  assert.strictEqual(url, 'https://app.diagrams.net/img/lib/active_directory/Domain.svg');
});

test('every shipped rule that owns a mirror subtree declares canonicalUrl', () => {
  // The mscae rule is deliberately inbound-only (it shares azure/ with azure2).
  const missing = rules.filter((r) => !r.canonicalUrl && r.name !== 'drawio-mscae');
  assert.deepStrictEqual(missing.map((r) => r.name), []);
});

// --- CLI smoke tests --------------------------------------------------------

console.log('\nbin/icon-search.js:');

const CLI = path.join(__dirname, '..', 'bin', 'icon-search.js');
function runCli(args) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status, stdout: e.stdout || '' };
  }
}

test('--help exits 0', () => {
  const r = runCli(['--help']);
  assert.strictEqual(r.code, 0);
  assert.match(r.stdout, /Usage: icon-search/);
});

test('search prints the canonical URL', () => {
  const r = runCli(['cosmos', 'db', '--asset-root', tmpRoot]);
  assert.strictEqual(r.code, 0, r.stdout);
  assert.match(r.stdout, /https:\/\/app\.diagrams\.net\/img\/lib\/azure2\/databases\/Azure_Cosmos_DB\.svg/);
});

test('--json emits parseable results', () => {
  const r = runCli(['function app', '--asset-root', tmpRoot, '--json']);
  assert.strictEqual(r.code, 0, r.stdout);
  const parsed = JSON.parse(r.stdout);
  assert.strictEqual(parsed.results[0].id, 'azure/compute/function_apps');
});

test('--sets lists the mirror contents', () => {
  const r = runCli(['--sets', '--asset-root', tmpRoot, '--json']);
  assert.strictEqual(r.code, 0);
  assert.strictEqual(JSON.parse(r.stdout).sets.length, 4);
});

test('no match exits 3', () => {
  assert.strictEqual(runCli(['zzzznotathing', '--asset-root', tmpRoot]).code, 3);
});

test('missing query exits 2', () => {
  assert.strictEqual(runCli(['--asset-root', tmpRoot]).code, 2);
});

test('unknown option exits 2', () => {
  assert.strictEqual(runCli(['--nope']).code, 2);
});

// --- Cleanup ----------------------------------------------------------------

try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
