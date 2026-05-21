#!/usr/bin/env node
// Tests for inline-external-images.js
//
// Plain node assertions — no test framework dep. Run via:
//   node test/inline-external-images.test.js
//
// Exit code 0 = all pass, 1 = any fail.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const { inlineExternalImages, createResolver, _internals } = require('../lib/inline-external-images');

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

// --- Set up a tmp asset root with sample SVG/PNG files ----------------------

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iei-test-'));
const svgIcon = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#0078D4"/></svg>';
const pngIcon = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
  0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0,
  0x1f, 0x15, 0xc4, 0x89,
  0, 0, 0, 10, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0, 0, 0, 0, 5, 0, 1,
  0x0d, 0x0a, 0x2d, 0xb4,
  0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

fs.mkdirSync(path.join(tmpRoot, 'azure', 'compute'), { recursive: true });
fs.mkdirSync(path.join(tmpRoot, 'm365'), { recursive: true });
fs.writeFileSync(path.join(tmpRoot, 'azure', 'compute', 'App_Services.svg'), svgIcon);
fs.writeFileSync(path.join(tmpRoot, 'azure', 'compute', 'VM.svg'), svgIcon);
fs.writeFileSync(path.join(tmpRoot, 'm365', 'Teams.png'), pngIcon);

const rules = [
  { name: 'drawio-azure2', match: { pathSuffix: '/img/lib/azure2/' }, localBase: 'azure/' },
  { name: 'drawio-mscae',  match: { pathSuffix: '/img/lib/mscae/'  }, localBase: 'm365/' },
];

const resolver = createResolver({
  rules,
  aliases: { 'https://custom.example/icons/extra.svg': 'azure/compute/VM.svg' },
  assetRoot: tmpRoot,
});

// --- Tests ------------------------------------------------------------------

console.log('inline-external-images.js:');

test('normalizeUrl strips query/hash and lowercases host', () => {
  const n = _internals.normalizeUrl('https://APP.diagrams.NET/img/lib/azure2/compute/VM.svg?v=2#x');
  assert.strictEqual(n.host, 'app.diagrams.net');
  assert.strictEqual(n.pathname, '/img/lib/azure2/compute/VM.svg');
});

test('normalizeUrl returns null for non-absolute', () => {
  assert.strictEqual(_internals.normalizeUrl('img/lib/x.svg'), null);
});

test('rewrites xlink:href to data: URI', () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
    <image x="0" y="0" xlink:href="https://app.diagrams.net/img/lib/azure2/compute/App_Services.svg"/>
  </svg>`;
  const { svg: out, resolved, unresolved } = inlineExternalImages({ svg, resolve: resolver });
  assert.strictEqual(unresolved.length, 0, `unexpected unresolved: ${JSON.stringify(unresolved)}`);
  assert.strictEqual(resolved.length, 1);
  assert.match(out, /xlink:href="data:image\/svg\+xml;base64,/);
});

test('rewrites href (SVG2) to data: URI', () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg"><image href="https://app.diagrams.net/img/lib/azure2/compute/VM.svg"/></svg>`;
  const { svg: out, resolved, unresolved } = inlineExternalImages({ svg, resolve: resolver });
  assert.strictEqual(unresolved.length, 0);
  assert.strictEqual(resolved.length, 1);
  assert.match(out, /href="data:image\/svg\+xml;base64,/);
});

test('handles PNG icons with correct MIME', () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="https://app.diagrams.net/img/lib/mscae/Teams.png"/></svg>`;
  const { svg: out, resolved } = inlineExternalImages({ svg, resolve: resolver });
  assert.strictEqual(resolved.length, 1);
  assert.strictEqual(resolved[0].mime, 'image/png');
  assert.match(out, /data:image\/png;base64,/);
});

test('data: URIs are pass-through (not touched)', () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="data:image/svg+xml;base64,PHN2Zy8+"/></svg>`;
  const { resolved, unresolved } = inlineExternalImages({ svg, resolve: resolver });
  assert.strictEqual(resolved.length, 0);
  assert.strictEqual(unresolved.length, 0);
});

test('exact-URL alias overrides rules', () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="https://custom.example/icons/extra.svg"/></svg>`;
  const { resolved, unresolved } = inlineExternalImages({ svg, resolve: resolver });
  assert.strictEqual(unresolved.length, 0);
  assert.strictEqual(resolved.length, 1);
  assert.strictEqual(resolved[0].ruleName, 'alias');
});

test('collects unresolved URLs without throwing (default policy)', () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
    <image xlink:href="https://app.diagrams.net/img/lib/azure2/compute/App_Services.svg"/>
    <image xlink:href="https://example.com/unknown/icon.svg"/>
  </svg>`;
  const { resolved, unresolved } = inlineExternalImages({ svg, resolve: resolver });
  assert.strictEqual(resolved.length, 1);
  assert.strictEqual(unresolved.length, 1);
  assert.strictEqual(unresolved[0].url, 'https://example.com/unknown/icon.svg');
});

test('missingPolicy=throw raises with full report', () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="https://example.com/missing.svg"/></svg>`;
  assert.throws(
    () => inlineExternalImages({ svg, resolve: resolver, missingPolicy: 'throw' }),
    (e) => Array.isArray(e.unresolved) && e.unresolved.length === 1
  );
});

test('matches host-varying URLs by path suffix', () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
    <image xlink:href="https://embed.diagrams.net/img/lib/azure2/compute/VM.svg"/>
    <image xlink:href="https://drawio.corp.internal/img/lib/azure2/compute/App_Services.svg"/>
  </svg>`;
  const { resolved, unresolved } = inlineExternalImages({ svg, resolve: resolver });
  assert.strictEqual(unresolved.length, 0);
  assert.strictEqual(resolved.length, 2);
});

test('case-insensitive basename fallback', () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="https://app.diagrams.net/img/lib/azure2/compute/app_services.svg"/></svg>`;
  const { resolved, unresolved } = inlineExternalImages({ svg, resolve: resolver });
  assert.strictEqual(unresolved.length, 0);
  assert.strictEqual(resolved.length, 1);
  assert.match(resolved[0].ruleName, /-ci$/);
});

test('path traversal is blocked (URL normalization + escapes-assetRoot defense in depth)', () => {
  // WHATWG URL parser normalizes both bare and percent-encoded ../ segments,
  // so they never reach our pathSuffix matcher. Either way, no resolution.
  const samples = [
    'https://app.diagrams.net/img/lib/azure2/../../../etc/passwd',
    'https://app.diagrams.net/img/lib/azure2/%2E%2E/%2E%2E/etc/passwd',
    'https://app.diagrams.net/img/lib/azure2/foo/../../../etc/passwd',
  ];
  for (const url of samples) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="${url}"/></svg>`;
    const { resolved, unresolved } = inlineExternalImages({ svg, resolve: resolver });
    assert.strictEqual(resolved.length, 0, `traversal leaked for ${url}`);
    assert.strictEqual(unresolved.length, 1);
  }
});

test('URL-decoded paths resolve correctly', () => {
  fs.writeFileSync(path.join(tmpRoot, 'azure', 'compute', 'App Service.svg'), svgIcon);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="https://app.diagrams.net/img/lib/azure2/compute/App%20Service.svg"/></svg>`;
  const { resolved, unresolved } = inlineExternalImages({ svg, resolve: resolver });
  assert.strictEqual(unresolved.length, 0, JSON.stringify(unresolved));
  assert.strictEqual(resolved.length, 1);
});

test('preserves non-image elements untouched', () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
    <rect x="0" y="0" width="100" height="100" fill="#0078D4"/>
    <text x="50" y="50">Hello</text>
    <image xlink:href="https://app.diagrams.net/img/lib/azure2/compute/VM.svg"/>
  </svg>`;
  const { svg: out } = inlineExternalImages({ svg, resolve: resolver });
  assert.match(out, /<rect /);
  assert.match(out, /<text /);
  assert.match(out, />Hello</);
});

test('handles nested image refs inside <g>', () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
    <g transform="translate(10,10)">
      <g>
        <image xlink:href="https://app.diagrams.net/img/lib/azure2/compute/VM.svg"/>
      </g>
    </g>
  </svg>`;
  const { resolved } = inlineExternalImages({ svg, resolve: resolver });
  assert.strictEqual(resolved.length, 1);
});

// --- Cleanup ----------------------------------------------------------------

try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
