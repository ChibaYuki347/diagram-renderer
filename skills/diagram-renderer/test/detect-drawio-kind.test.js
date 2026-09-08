#!/usr/bin/env node
// Tests for detectDrawioKind() in lib/render-drawio.js
//
// This function decides whether an input is an editable SVG, raw draw.io XML,
// or something we cannot render. Getting it wrong produces the unhelpful
// "could not detect SVG content in input" error on files that are perfectly
// valid, so the prologue handling is worth pinning down.
//
// Plain node assertions — no test framework dep. Run via:
//   node test/detect-drawio-kind.test.js

'use strict';

const assert = require('assert');
const { detectDrawioKind } = require('../lib/render-drawio');

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

const SVG_ROOT = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>';
const DECL = '<?xml version="1.0" encoding="UTF-8"?>';

console.log('detectDrawioKind:');

test('bare svg root', () => {
  assert.strictEqual(detectDrawioKind(SVG_ROOT), 'svg');
});

test('leading whitespace before the root element', () => {
  assert.strictEqual(detectDrawioKind(`\n\n  ${SVG_ROOT}`), 'svg');
});

test('xml declaration then svg', () => {
  assert.strictEqual(detectDrawioKind(`${DECL}\n${SVG_ROOT}`), 'svg');
});

// Regression: XML allows comments between the declaration and the root
// element, and draw.io's own exports include them. We used to only look at the
// single tag following the declaration and rejected these outright.
test('xml declaration, comment, then svg', () => {
  assert.strictEqual(detectDrawioKind(`${DECL}\n<!-- exported by draw.io -->\n${SVG_ROOT}`), 'svg');
});

test('several comments before the root element', () => {
  const input = `${DECL}\n<!-- one -->\n<!-- two\n   spanning lines -->\n${SVG_ROOT}`;
  assert.strictEqual(detectDrawioKind(input), 'svg');
});

test('comment without an xml declaration', () => {
  assert.strictEqual(detectDrawioKind(`<!-- note -->\n${SVG_ROOT}`), 'svg');
});

test('a comment containing markup does not confuse the scan', () => {
  const input = `${DECL}<!-- <mxfile> is mentioned here -->${SVG_ROOT}`;
  assert.strictEqual(detectDrawioKind(input), 'svg');
});

test('doctype before the root element', () => {
  const doctype = '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">';
  assert.strictEqual(detectDrawioKind(`${DECL}\n${doctype}\n${SVG_ROOT}`), 'svg');
});

test('stylesheet processing instruction before the root element', () => {
  const pi = '<?xml-stylesheet type="text/css" href="s.css"?>';
  assert.strictEqual(detectDrawioKind(`${DECL}\n${pi}\n${SVG_ROOT}`), 'svg');
});

test('mxfile is detected as draw.io xml', () => {
  assert.strictEqual(detectDrawioKind('<mxfile host="app.diagrams.net"></mxfile>'), 'drawio-xml');
});

test('mxfile behind a declaration and comment', () => {
  assert.strictEqual(detectDrawioKind(`${DECL}<!-- c --><mxfile></mxfile>`), 'drawio-xml');
});

test('mxGraphModel is detected as draw.io xml', () => {
  assert.strictEqual(detectDrawioKind('<mxGraphModel dx="1"></mxGraphModel>'), 'drawio-xml');
});

test('html is not renderable', () => {
  assert.strictEqual(detectDrawioKind('<!DOCTYPE html><html><body></body></html>'), 'unknown');
});

test('plain text is not renderable', () => {
  assert.strictEqual(detectDrawioKind('graph TD; a-->b;'), 'unknown');
});

test('an svg buried past the prologue budget is not misdetected', () => {
  // The scan deliberately only looks at the head of the file; a megabyte of
  // comments is not a case worth supporting, and must fail loudly rather than
  // hang.
  const input = `${DECL}<!--${'x'.repeat(20000)}-->${SVG_ROOT}`;
  assert.strictEqual(detectDrawioKind(input), 'unknown');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
