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
// carry the other's problem. What they must not differ on is what a change means
// -- which bump it asks for, and when a release may happen -- because the catalog
// pins them to release tags and a disagreement there is a disagreement about what
// a version number is worth.
//
// So this file holds the rules and nothing else. It touches no filesystem, no
// network and no repository layout: a repository supplies an adapter that drives
// its own planner, and the suite asks it questions.
//
// VERSION 2: ONE FILE PER CHANGE, ONE RELEASE PER DAY (CHARTER §5.4)
//
// Version 1 of these rules was written for a changelog every pull request edited
// by hand, under `## [Unreleased]`, released on every merge. A release renamed
// that heading, so a branch opened before it still filed its bullets under a
// heading that now meant a released version, and git's 3-way merge put them
// there. The guard was to hold the release while such a branch was open -- which
// is to say that the more work ran in parallel, the less of it was released: on
// 2026-09-24 five open pull requests held microsoft-brand-guidelines' release.
//
// A pull request now adds one file of its own, `changes/<name>.md`, and edits no
// shared text. A release reads the files on the default branch, writes the dated
// section from them, and deletes them. A branch that is still open has not put
// its file on the default branch, so there is nothing of its for a release to
// absorb, and the rule is no longer "hold while it is open" but "never wait for
// it" -- `open/*` below.
//
// WHAT A CHANGE IS, AS AN ADAPTER RECEIVES IT
//
//   { file, type, breaking, summary }
//
// `type` is `added`, `changed`, `fixed` or `removed`: the Keep a Changelog
// headings the generated section is written under. `breaking` is true for a
// change that breaks a caller, which Keep a Changelog has no heading for: below
// 1.0.0 it takes the minor, whatever its type (CHARTER §5.1), and past 1.0.0 it
// stops an automatic release, because only a person takes a major.
// `summary` is the one line the changelog prints; the details belong to the pull
// request, which the line links to. The file format that carries these is the
// CHARTER's (§5.4); a repository parses it, and these rules judge what it says.

const TYPES = Object.freeze(['added', 'changed', 'fixed', 'removed']);

const change = (type, summary, extra = {}) => ({
  file: `changes/${summary.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}.md`,
  type, breaking: false, summary, ...extra,
});
const FIX = change('fixed', 'Correct a rendering offset.');
const ADD = change('added', 'A new layout.');
const DROP = change('removed', 'Drop the legacy loader.');
const REWRITE = change('changed', 'Rewrite the planner end to end.');
const BREAK = change('changed', 'render() no longer accepts a string.', { breaking: true });
const BREAKFIX = change('fixed', 'The default width is now the one the docs give, which callers relied on.', { breaking: true });

const CASES = [
  // ---- which bump the changes ask for --------------------------------------
  { name: 'bump/fixed-is-patch', version: '0.4.0', changes: [FIX],
    expect: { release: true, bump: 'patch', version: '0.4.1' } },
  { name: 'bump/added-is-minor', version: '0.4.0', changes: [ADD],
    expect: { release: true, bump: 'minor', version: '0.5.0' } },
  { name: 'bump/removed-below-1.0-is-minor', version: '0.4.0', changes: [DROP],
    expect: { release: true, bump: 'minor', version: '0.5.0' } },
  {
    // Measured rather than assumed: reading `changed` as a minor reproduces 4 of
    // the 5 bumps microsoft-brand-guidelines made under version 1, which is how a
    // plausible rule hides. 0.2.1 rewrote an agent end to end as a `Changed` entry
    // and shipped as a patch.
    name: 'bump/changed-alone-is-patch', version: '0.4.0', changes: [REWRITE],
    expect: { release: true, bump: 'patch', version: '0.4.1' },
  },
  { name: 'bump/a-day-of-changes-takes-the-largest', version: '0.4.0', changes: [FIX, ADD, REWRITE],
    expect: { release: true, bump: 'minor', version: '0.5.0' } },
  {
    // CHARTER §5.1: below 1.0.0 "breaking changes happen in minor bumps", and a
    // patch is for fixes only. So `breaking` takes the minor whatever the type
    // says. Two types, because a `changed` one alone would also pass a planner
    // that reads `changed` as a minor, and a `fixed` one is the patch a
    // breaking change would otherwise ship as.
    name: 'bump/breaking-below-1.0-takes-the-minor', version: '0.4.0', changes: [BREAK],
    expect: { release: true, bump: 'minor', version: '0.5.0' },
  },
  { name: 'bump/a-breaking-fix-below-1.0-takes-the-minor', version: '0.4.0', changes: [FIX, BREAKFIX],
    expect: { release: true, bump: 'minor', version: '0.5.0' } },

  // ---- when there is nothing to release ------------------------------------
  { name: 'idle/no-change-files-does-not-release', version: '0.4.0', changes: [],
    expect: { release: false } },

  // ---- the major is never taken automatically ------------------------------
  { name: 'major/derived-bump-never-moves-the-major', version: '0.9.0', changes: [ADD],
    expect: { release: true, bump: 'minor', version: '0.10.0' } },
  { name: 'major/removed-past-1.0-is-refused', version: '1.2.0', changes: [FIX, DROP],
    expect: { release: false } },
  { name: 'major/breaking-past-1.0-is-refused', version: '1.2.0', changes: [BREAK],
    expect: { release: false } },

  // ---- a release never waits for work that is still open -------------------
  {
    // The case version 1 held for: a branch that is open, carrying a change of
    // its own. Its file is on that branch, not on the default branch, so the
    // release has nothing of it to absorb and must not wait.
    name: 'open/an-open-pull-request-with-a-change-file-does-not-hold', version: '0.4.0', changes: [FIX],
    openPulls: [{ number: 41, files: ['changes/also-correct-the-margin.md', 'src/render.js'] }],
    expect: { release: true, bump: 'patch', version: '0.4.1' },
  },
  { name: 'open/an-open-pull-request-editing-the-changelog-does-not-hold', version: '0.4.0', changes: [FIX],
    openPulls: [{ number: 42, files: ['CHANGELOG.md'] }],
    expect: { release: true, bump: 'patch', version: '0.4.1' } },
  { name: 'open/nobody-asked-is-not-a-reason-to-wait', version: '0.4.0', changes: [FIX], openPulls: null,
    expect: { release: true, bump: 'patch', version: '0.4.1' } },

  // ---- a change the rules cannot read stops the release --------------------
  {
    // A type that is not a Keep a Changelog heading has no bump, and guessing
    // one is how `improved` would ship as a patch it may not be.
    name: 'format/an-unknown-type-is-refused', version: '0.4.0',
    changes: [FIX, change('improved', 'Faster rendering.')],
    expect: { release: false },
  },
  {
    // One line each: the details are the pull request's, and a changelog line
    // that has grown a second paragraph is a pull request body in the wrong place.
    name: 'format/a-summary-of-more-than-one-line-is-refused', version: '0.4.0',
    changes: [change('fixed', 'Correct an offset.\nIt was measured at 12pt on slide 4.')],
    expect: { release: false },
  },
  { name: 'format/an-empty-summary-is-refused', version: '0.4.0',
    changes: [{ ...FIX, summary: '   ' }],
    expect: { release: false } },
];

// What the suite hands an adapter for one case: the version the manifests carry,
// the change files on the default branch, and the open pull requests with the
// paths each touches. `null` means nobody asked, which is what happens offline.
function inputFor(testCase) {
  return {
    version: testCase.version,
    date: '2026-09-25',
    changes: testCase.changes.map((c) => ({ ...c })),
    openPulls: testCase.openPulls === undefined ? null
      : testCase.openPulls && testCase.openPulls.map((p) => ({ number: p.number, title: `Pull request #${p.number}`, files: [...p.files] })),
  };
}

function describe(result) {
  if (!result || result.release !== true) return `no release${result && result.held ? ' (held)' : ''}`;
  return `${result.bump} -> ${result.version}`;
}

// Runs every case against one adapter. Returns rather than throws, so a repository
// can report the result in whichever test style it already uses.
//
// An adapter is `{ plan({ version, date, changes, openPulls }) }` returning
// `{ release, bump?, version?, held? }`, synchronously or as a promise. A planner
// that refuses by throwing is also a refusal: `format/*` cases accept either.
// Only the fields a case names are compared: a repository may return more.
async function runConformance(adapter, cases = CASES) {
  if (!adapter || typeof adapter.plan !== 'function') {
    throw new Error('A conformance adapter must expose plan({ version, date, changes, openPulls })');
  }
  const failures = [];
  for (const testCase of cases) {
    let actual;
    try {
      actual = await adapter.plan(inputFor(testCase));
    } catch (error) {
      if (testCase.expect.release === false && testCase.name.startsWith('format/')) continue;
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
    .map((f) => `  ${f.name}\n    expected ${f.expected}, got ${f.actual}` +
      (f.fields ? `\n    ${f.fields.join('\n    ')}` : ''))
    .join('\n');
}

module.exports = { RULES_VERSION: 2, TYPES, CASES, inputFor, runConformance, formatFailures };
