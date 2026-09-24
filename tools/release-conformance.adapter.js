'use strict';

// Drives this repository's own release planner from the shared conformance cases
// in tools/release-conformance.js. Nothing here decides anything: the adapter
// translates a case into the state plan-release.js already takes, and translates
// the answer back. A rule that only holds inside the adapter would be a rule this
// repository does not actually run.
//
// `openPulls` is handed over and deliberately not passed on: the planner takes no
// such input, which is how "a release never waits for an open pull request" holds
// here -- there is nothing for it to wait on.

const { planRelease } = require('./plan-release');

const CHANGELOG = '# Changelog\n\n## [0.0.1] — 2026-01-01\n\n### Added\n\n- The first release.\n';

function plan({ version, date, changes }) {
  const state = {
    version,
    documents: {},
    changelog: {
      text: CHANGELOG,
      eol: '\n',
      latest: '0.0.1',
      latestDate: '2026-01-01',
      insertIndex: CHANGELOG.indexOf('## [0.0.1]'),
      releases: [{ version: '0.0.1', date: '2026-01-01' }],
    },
    changes,
    prs: {},
  };
  const result = planRelease(state, { date });
  return { release: result.kind === 'release', bump: result.bump, version: result.version };
}

module.exports = { plan };
