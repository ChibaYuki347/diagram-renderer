#!/usr/bin/env node
// End-to-end render smoke test.
//
// The unit suites prove the pure logic. They deliberately never launch
// Chromium, so on their own they cannot tell you whether this skill can
// actually produce a PNG on this machine. That gap is what this file closes:
// it drives the real CLIs against the committed samples and asserts on the
// bytes that come out.
//
// What a green run here proves:
//   * mermaid-cli + Chromium resolve and launch on this platform
//   * the local icon mirror resolves real jsDelivr URLs
//   * every <image> in the sample is inlined (0 unresolved)
//   * Chromium made ZERO network requests while rendering
//   * an unresolvable icon is a hard failure, not a silent fetch
//
// Not part of `npm test` — it needs Chromium and a populated mirror. Run via:
//   npm run test:e2e
//
// Prerequisites:
//   npm install
//   READ_AND_AGREE=1 scripts/fetch-icons.sh github     # Octicons, MIT, auto
//
// Env:
//   E2E_ASSET_ROOT   override the icon mirror location (default <skill>/.local-assets)
//   E2E_OUT_DIR      keep rendered PNGs here instead of a scratch dir that is
//                    deleted on exit. CI sets this so the samples can be
//                    uploaded as build artifacts and actually looked at.
//
// Exit code 0 = all pass, 1 = any fail, 2 = prerequisites missing.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { spawnSync } = require('child_process');

const SKILL_DIR = path.resolve(__dirname, '..');
const BIN = path.join(SKILL_DIR, 'bin');
const ASSET_ROOT = process.env.E2E_ASSET_ROOT || path.join(SKILL_DIR, '.local-assets');

const SAMPLE_MMD = path.join(__dirname, 'sample-flow.mmd');
const SAMPLE_DRAWIO = path.join(__dirname, 'sample-architecture.drawio.svg');

// Icons the committed sample depends on. Checked up front so a missing mirror
// reports "run fetch-icons.sh" instead of a confusing render failure later.
const REQUIRED_ICONS = [
  'repo-24.svg',
  'workflow-24.svg',
  'package-24.svg',
  'shield-check-24.svg',
  'rocket-24.svg',
];

// When E2E_OUT_DIR is set the rendered PNGs are kept so a human (or a CI
// artifact upload) can look at them; otherwise everything lands in a scratch
// dir that is removed on exit.
const keepOutput = Boolean(process.env.E2E_OUT_DIR);
const outDir = keepOutput
  ? path.resolve(process.env.E2E_OUT_DIR)
  : fs.mkdtempSync(path.join(os.tmpdir(), 'dr-e2e-'));
if (keepOutput) fs.mkdirSync(outDir, { recursive: true });

let passed = 0, failed = 0;
const tests = [];

function group(title) { tests.push({ title }); }
function test(name, fn) { tests.push({ name, fn }); }

async function runAll() {
  for (const t of tests) {
    if (t.title) { console.log(`\n${t.title}`); continue; }
    try {
      await t.fn();
      console.log(`  ✓ ${t.name}`);
      passed++;
    } catch (e) {
      console.error(`  ✗ ${t.name}`);
      console.error(`    ${(e.stack || e.message).split('\n').slice(0, 8).join('\n    ')}`);
      failed++;
    }
  }
}

function run(script, args) {
  const r = spawnSync(process.execPath, [path.join(BIN, script), ...args], {
    encoding: 'utf8',
    cwd: SKILL_DIR,
  });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// A PNG that "exists" is not a PNG that rendered. Verify the signature and
// pull the real pixel dimensions out of the IHDR chunk.
function readPng(file) {
  assert.ok(fs.existsSync(file), `expected output at ${file}`);
  const buf = fs.readFileSync(file);
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.ok(buf.subarray(0, 8).equals(sig), `${path.basename(file)} is not a PNG`);
  assert.strictEqual(buf.toString('ascii', 12, 16), 'IHDR', 'missing IHDR chunk');
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    bytes: buf.length,
  };
}

// --- Preflight --------------------------------------------------------------

function preflight() {
  const octicons = path.join(ASSET_ROOT, 'github', 'octicons');
  const missing = REQUIRED_ICONS.filter(n => !fs.existsSync(path.join(octicons, n)));
  if (!fs.existsSync(octicons) || missing.length) {
    console.error('e2e prerequisites missing.\n');
    console.error(`  icon mirror: ${octicons}`);
    console.error(`  missing:     ${missing.length ? missing.join(', ') : '(directory absent)'}\n`);
    console.error('  Populate it with:');
    console.error('    READ_AND_AGREE=1 scripts/fetch-icons.sh github\n');
    console.error('  Octicons are MIT licensed and fetched automatically — no manual download.');
    process.exit(2);
  }
}

preflight();

// --- Icon catalog -----------------------------------------------------------

group('icon catalog:');

test('icon-search resolves a known Octicon to its canonical URL', () => {
  const r = run('icon-search.js', ['mark-github', '--set', 'github', '--asset-root', ASSET_ROOT, '--json']);
  assert.strictEqual(r.code, 0, `exit ${r.code}: ${r.stderr}`);
  const hits = JSON.parse(r.stdout).results;
  assert.ok(hits.length > 0, 'expected at least one hit');
  const hit = hits[0];
  assert.match(hit.url, /\/build\/svg\/mark-github-\d+\.svg$/);
  assert.ok(fs.existsSync(hit.file), `catalog pointed at a missing file: ${hit.file}`);
});

test('every icon the sample uses is discoverable through the catalog', () => {
  for (const icon of REQUIRED_ICONS) {
    const slug = icon.replace(/\.svg$/, '');
    const r = run('icon-search.js', [slug, '--set', 'github', '--asset-root', ASSET_ROOT, '--json']);
    assert.strictEqual(r.code, 0, `icon-search failed for ${slug}: ${r.stderr}`);
    const hits = JSON.parse(r.stdout).results;
    assert.ok(
      hits.some(h => h.url.endsWith(`/${icon}`)),
      `catalog never surfaced ${icon}; got ${hits.slice(0, 3).map(h => h.url).join(', ')}`
    );
  }
});

test('--sets reports the github pack as populated', () => {
  const r = run('icon-search.js', ['--sets', '--asset-root', ASSET_ROOT, '--json']);
  assert.strictEqual(r.code, 0, r.stderr);
  const github = JSON.parse(r.stdout).sets.find(s => s.name === 'github');
  assert.ok(github, 'github set absent from --sets');
  assert.ok(github.count > 100, `expected the full Octicon pack, got ${github.count}`);
});

// --- Mermaid ----------------------------------------------------------------

group('mermaid rendering:');

test('renders the sample flowchart to a real PNG', () => {
  const out = path.join(outDir, 'flow.png');
  const r = run('render-mermaid.js', [SAMPLE_MMD, '--out', out]);
  assert.strictEqual(r.code, 0, `exit ${r.code}: ${r.stderr}`);
  const png = readPng(out);
  assert.ok(png.width > 200 && png.height > 100, `suspicious dimensions ${png.width}x${png.height}`);
  assert.ok(png.bytes > 5000, `PNG is only ${png.bytes} bytes — probably blank`);
});

test('renders with the stock mermaid theme (no brand theme required)', () => {
  const out = path.join(outDir, 'flow-default.png');
  const r = run('render-mermaid.js', [SAMPLE_MMD, '--theme', 'default', '--out', out]);
  assert.strictEqual(r.code, 0, `exit ${r.code}: ${r.stderr}`);
  assert.ok(readPng(out).width > 200);
});

test('rejects an unknown theme instead of silently falling back', () => {
  const out = path.join(outDir, 'never.png');
  const r = run('render-mermaid.js', [SAMPLE_MMD, '--theme', 'no-such-theme', '--out', out]);
  assert.notStrictEqual(r.code, 0, 'unknown theme should fail');
  assert.ok(!fs.existsSync(out), 'no output should be written on failure');
});

// --- draw.io + icons --------------------------------------------------------

group('draw.io rendering with offline icons:');

test('renders the sample architecture to a real PNG', () => {
  const out = path.join(outDir, 'arch.png');
  const r = run('render-drawio.js', [SAMPLE_DRAWIO, '--out', out, '--asset-root', ASSET_ROOT]);
  assert.strictEqual(r.code, 0, `exit ${r.code}: ${r.stderr}`);
  const png = readPng(out);
  assert.ok(png.width > 800, `expected a wide canvas, got ${png.width}`);
  assert.ok(png.bytes > 10000, `PNG is only ${png.bytes} bytes — icons probably did not draw`);
});

test('every external image is inlined and nothing reaches the network', async () => {
  // Driven through the API rather than the CLI so the inline report and the
  // blocked-request guard are both observable. Build the resolver exactly the
  // way bin/render-drawio.js does — createResolver defaults to *no* rules, so
  // omitting these would resolve nothing and prove nothing.
  const { renderDrawio } = require('../lib/render-drawio');
  const { createResolver } = require('../lib/inline-external-images');
  const resolver = createResolver({
    assetRoot: ASSET_ROOT,
    rules: JSON.parse(fs.readFileSync(path.join(SKILL_DIR, 'assets', 'icons', 'resolver-rules.json'), 'utf8')),
    aliases: JSON.parse(fs.readFileSync(path.join(SKILL_DIR, 'assets', 'icons', 'aliases.json'), 'utf8')),
  });

  const result = await renderDrawio({
    file: SAMPLE_DRAWIO,
    out: path.join(outDir, 'arch-api.png'),
    resolver,
  });

  assert.strictEqual(result.inlined.unresolved.length, 0,
    `unresolved: ${result.inlined.unresolved.map(u => u.url).join(', ')}`);
  assert.strictEqual(result.inlined.resolved.length, REQUIRED_ICONS.length,
    `expected ${REQUIRED_ICONS.length} inlined icons, got ${result.inlined.resolved.length}`);
  readPng(result.path);
});

test('an unresolvable icon fails the render instead of fetching it', () => {
  const bogus = path.join(outDir, 'bogus.drawio.svg');
  fs.writeFileSync(bogus, `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="120" height="120">
  <image x="10" y="10" width="64" height="64" xlink:href="https://cdn.jsdelivr.net/npm/@primer/octicons@latest/build/svg/definitely-not-an-icon-24.svg"/>
</svg>`);
  const report = path.join(outDir, 'missing.json');
  const out = path.join(outDir, 'bogus.png');

  const r = run('render-drawio.js', [bogus, '--out', out, '--asset-root', ASSET_ROOT, '--report-missing', report]);

  assert.notStrictEqual(r.code, 0, 'strict offline should have failed this render');
  assert.match(r.stderr, /could not be resolved offline/);
  assert.ok(!fs.existsSync(out), 'no PNG should be produced for an unresolved reference');

  assert.ok(fs.existsSync(report), 'expected --report-missing to write a report');
  const parsed = JSON.parse(fs.readFileSync(report, 'utf8'));
  const urls = JSON.stringify(parsed);
  assert.match(urls, /definitely-not-an-icon-24\.svg/);
});

// --- Run ---------------------------------------------------------------------

(async () => {
  await runAll();

  if (keepOutput) {
    console.log(`\nRendered output kept in ${outDir}`);
  } else {
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (_) {}
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
