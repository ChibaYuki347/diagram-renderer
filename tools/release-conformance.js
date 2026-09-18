'use strict';

// The release rules that every plugin repository in this marketplace must agree
// on, written once and run in each of them against its own implementation.
//
// WHY A SUITE AND NOT A SHARED LIBRARY
//
// The implementations legitimately differ. diagram-renderer carries three
// manifests and a package-lock whose root version has to move with them;
// microsoft-brand-guidelines carries two manifests and no lock. One of them
// verifies a cut after the fact against its parent plan, the other seals released
// changelog sections. Merging those into one file would force each repository to
// carry the other's problem. What they must not differ on is what a changelog
// means -- which bump it asks for, and when a release has to wait -- because the
// catalog pins them to release tags and a disagreement there is a disagreement
// about what a version number is worth.
//
// So this file holds the rules and nothing else. It touches no filesystem, no
// network and no repository layout: a repository supplies an adapter that drives
// its own planner, and the suite asks it questions.
//
// THE CASE THAT MADE THIS WORTH WRITING
//
// `in-flight/touches-changelog-without-adding` below. A release cuts
// `## [Unreleased]` into a dated heading; a branch opened before that moment still
// files its bullets under `[Unreleased]`, so git's 3-way merge lands them in what
// is now a released section. Holding the release while such a branch is open is
// the guard.
//
// The question is how wide to hold. microsoft-brand-guidelines reconstructed its
// own history -- 40 releases, 87 pull requests, each release asked what was open
// at that instant -- and compared the candidates (tools/in-flight.js records the
// table). Holding for any open pull request that *adds a bullet under
// [Unreleased]* held 4 of 40 releases, none longer than 0.7 hours. Holding for any
// open pull request that *touches CHANGELOG.md* held 7 of 40, the worst of them
// for 116 hours -- and a pull request that touches the file without adding an
// [Unreleased] bullet cannot be absorbed by the cut at all, so those extra holds
// buy nothing.
//
// Both rules catch the corruption that prompted the guard, so a test that only
// asked "does it hold when it must" passes on either. This suite asks the other
// half too: does it *release* when the only thing open cannot be absorbed. That is
// the question the two repositories currently answer differently.

const CASES = [
  // ---- which bump a changelog asks for -------------------------------------
  {
    name: 'bump/fixed-is-patch',
    version: '0.4.0',
    unreleased: '### Fixed\n\n- Correct a rendering offset.',
    expect: { release: true, bump: 'patch', version: '0.4.1' },
  },
  {
    name: 'bump/added-is-minor',
    version: '0.4.0',
    unreleased: '### Added\n\n- A new layout.',
    expect: { release: true, bump: 'minor', version: '0.5.0' },
  },
  {
    name: 'bump/removed-below-1.0-is-minor',
    version: '0.4.0',
    unreleased: '### Removed\n\n- Drop the legacy loader.',
    expect: { release: true, bump: 'minor', version: '0.5.0' },
  },
  {
    // Measured rather than assumed: reading `Changed` as a minor reproduces 4 of
    // the 5 bumps microsoft-brand-guidelines actually made, which is how a
    // plausible rule hides. 0.2.1 rewrote an agent end to end under a single
    // `### Changed` and shipped as a patch.
    name: 'bump/changed-alone-is-patch',
    version: '0.4.0',
    unreleased: '### Changed\n\n- Rewrite the planner end to end.',
    expect: { release: true, bump: 'patch', version: '0.4.1' },
  },
  {
    name: 'bump/added-and-fixed-takes-the-minor',
    version: '0.4.0',
    unreleased: '### Added\n\n- A new layout.\n\n### Fixed\n\n- Correct an offset.',
    expect: { release: true, bump: 'minor', version: '0.5.0' },
  },

  // ---- when there is nothing to release ------------------------------------
  {
    name: 'idle/empty-unreleased-does-not-release',
    version: '0.4.0',
    unreleased: '',
    expect: { release: false },
  },
  {
    // A heading survives the edit that removed the last entry under it, so the
    // entries are what decide whether anything is waiting.
    name: 'idle/heading-without-entries-does-not-release',
    version: '0.4.0',
    unreleased: '### Added',
    expect: { release: false },
  },

  // ---- the major is never taken automatically ------------------------------
  {
    name: 'major/derived-bump-never-moves-the-major',
    version: '0.9.0',
    unreleased: '### Added\n\n- A new layout.',
    expect: { release: true, bump: 'minor', version: '0.10.0' },
  },
  {
    name: 'major/removed-past-1.0-is-refused',
    version: '1.2.0',
    unreleased: '### Removed\n\n- Drop the legacy loader.',
    expect: { release: false },
  },
  {
    // Keep a Changelog has no heading for a breaking change, so past 1.0.0 it
    // arrives as a bullet under `### Changed` that says so. Measured at 1.2.0:
    // `- **BREAKING**: render() no longer accepts a string` planned 1.2.1.
    name: 'major/breaking-bullet-past-1.0-is-refused',
    version: '1.2.0',
    unreleased: '### Changed\n\n- **BREAKING**: render() no longer accepts a string.',
    expect: { release: false },
  },
  {
    name: 'major/breaking-bullet-below-1.0-still-releases',
    version: '0.4.0',
    unreleased: '### Changed\n\n- **BREAKING**: render() no longer accepts a string.',
    expect: { release: true, bump: 'patch', version: '0.4.1' },
  },

  // ---- holding for work that the cut would absorb --------------------------
  {
    name: 'in-flight/nobody-asked-is-not-nothing-in-flight',
    version: '0.4.0',
    unreleased: '### Fixed\n\n- Correct an offset.',
    openPulls: null,
    expect: { release: true, bump: 'patch', version: '0.4.1' },
  },
  {
    name: 'in-flight/no-open-pull-requests-releases',
    version: '0.4.0',
    unreleased: '### Fixed\n\n- Correct an offset.',
    openPulls: [],
    expect: { release: true, bump: 'patch', version: '0.4.1' },
  },
  {
    name: 'in-flight/adds-a-bullet-holds',
    version: '0.4.0',
    unreleased: '### Fixed\n\n- Correct an offset.',
    openPulls: [
      {
        number: 41,
        files: ['CHANGELOG.md', 'src/render.js'],
        unreleased: '### Fixed\n\n- Correct an offset.\n- Also correct the margin.',
      },
    ],
    expect: { release: false, held: true },
  },
  {
    // The decisive one. The branch edits CHANGELOG.md -- a typo in a released
    // section, a link, a heading -- and adds nothing under `[Unreleased]`. There
    // is no text for the cut to absorb, so holding buys nothing and costs a
    // release. This is where the two implementations disagree today.
    name: 'in-flight/touches-changelog-without-adding-releases',
    version: '0.4.0',
    unreleased: '### Fixed\n\n- Correct an offset.',
    openPulls: [
      {
        number: 42,
        files: ['CHANGELOG.md'],
        unreleased: '### Fixed\n\n- Correct an offset.',
        released: '- Fix a typo in the 0.3.0 notes.',
      },
    ],
    expect: { release: true, bump: 'patch', version: '0.4.1' },
  },
  {
    // `main` already carries the bullet, so the 3-way merge sees identical text
    // on both sides and has nothing to move.
    name: 'in-flight/duplicate-bullet-is-not-absorbable',
    version: '0.4.0',
    unreleased: '### Fixed\n\n- Correct an offset.',
    openPulls: [
      {
        number: 43,
        files: ['CHANGELOG.md', 'docs/guide.md'],
        unreleased: '### Fixed\n\n- Correct an offset.',
      },
    ],
    expect: { release: true, bump: 'patch', version: '0.4.1' },
  },
  {
    name: 'in-flight/unrelated-pull-request-releases',
    version: '0.4.0',
    unreleased: '### Fixed\n\n- Correct an offset.',
    openPulls: [{ number: 44, files: ['src/render.js'], unreleased: '### Fixed\n\n- Correct an offset.' }],
    expect: { release: true, bump: 'patch', version: '0.4.1' },
  },
];

// The changelog a case describes. `unreleased` is the body of `## [Unreleased]`;
// `released` is an extra line inside the newest released section, which is how a
// branch edits the file without adding anything the cut could absorb.
function changelogFor({ version, unreleased = '', released = '' }) {
  const body = unreleased ? `\n${unreleased}\n` : '\n';
  const extra = released ? `${released}\n` : '';
  return `# Changelog\n\n## [Unreleased]\n${body}\n## [${version}] — 2026-09-06\n\n### Added\n- The previous release.\n${extra}`;
}

// What the suite hands an adapter for one case: the repository's changelog, the
// version its manifests carry, and the open pull requests -- each already
// rendered as the CHANGELOG.md text that branch holds. `null` means nobody asked,
// which is what happens offline and is not the same as nothing being in flight.
function inputFor(testCase) {
  const version = testCase.version;
  const changelog = changelogFor({ version, unreleased: testCase.unreleased });
  const openPulls = testCase.openPulls === undefined || testCase.openPulls === null
    ? testCase.openPulls ?? null
    : testCase.openPulls.map(pull => ({
      number: pull.number,
      title: `Pull request #${pull.number}`,
      files: pull.files,
      changelog: changelogFor({ version, unreleased: pull.unreleased, released: pull.released }),
    }));
  return { changelog, version, date: '2026-09-20', openPulls };
}

function describe(result) {
  if (!result || result.release !== true) {
    return `no release${result && result.held ? ' (held)' : ''}`;
  }
  return `${result.bump} -> ${result.version}`;
}

// Runs every case against one adapter. Returns rather than throws, so a repository
// can report the result in whichever test style it already uses.
//
// An adapter is `{ plan({ changelog, version, date, openPulls }) }` returning
// `{ release, bump?, version?, held? }`, synchronously or as a promise -- one of
// these repositories reaches its in-flight rule through an async client and the
// other does not, and that is plumbing rather than a rule. Only the fields a case
// names are compared: a repository may return more.
async function runConformance(adapter, cases = CASES) {
  if (!adapter || typeof adapter.plan !== 'function') {
    throw new Error('A conformance adapter must expose plan({ changelog, version, date, openPulls })');
  }
  const failures = [];
  for (const testCase of cases) {
    let actual;
    try {
      actual = await adapter.plan(inputFor(testCase));
    } catch (error) {
      failures.push({ name: testCase.name, expected: describe(testCase.expect), actual: `threw: ${error.message}` });
      continue;
    }
    const mismatched = Object.entries(testCase.expect)
      .filter(([field, want]) => (actual ? actual[field] : undefined) !== want);
    if (mismatched.length) {
      failures.push({
        name: testCase.name,
        expected: describe(testCase.expect),
        actual: describe(actual),
        fields: mismatched.map(([field, want]) => `${field}: expected ${JSON.stringify(want)}, got ${JSON.stringify(actual ? actual[field] : undefined)}`),
      });
    }
  }
  return { total: cases.length, passed: cases.length - failures.length, failures };
}

// A one-line-per-failure report, for the repositories that print rather than throw.
function formatFailures(result) {
  return result.failures
    .map(f => `  ${f.name}\n    expected ${f.expected}, got ${f.actual}` +
      (f.fields ? `\n    ${f.fields.join('\n    ')}` : ''))
    .join('\n');
}

module.exports = { CASES, changelogFor, inputFor, runConformance, formatFailures };
