'use strict';

// The shared release-rule suite, run against this repository's own planner.
//
// tools/release-conformance.js is vendored from chibayuki-private-marketplace and
// is byte-identical in every plugin repo in that catalog -- the marketplace's
// check-conformance-sync.js fails if a copy drifts. Edit it there, not here.
//
// tools/release-conformance.adapter.js is this repository's own: it says how a
// case reaches planRelease and inFlight. Nothing is decided in the adapter.

const test = require('node:test');
const assert = require('node:assert/strict');

const { runConformance, formatFailures, CASES } = require('./release-conformance');
const adapter = require('./release-conformance.adapter');

test('this repository agrees with the shared release rules', async () => {
  const result = await runConformance(adapter);
  assert.equal(result.failures.length, 0, `\n${formatFailures(result)}`);
  assert.equal(result.passed, CASES.length);
});
