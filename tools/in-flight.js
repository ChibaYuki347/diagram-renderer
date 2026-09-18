'use strict';

// A release cuts `## [Unreleased]` into a dated heading. A branch opened before
// that moment still files its bullets under `[Unreleased]`, so git's 3-way merge
// lands them in what has since become a released section -- the released notes
// then claim work that is not in the tag. The release is held while such a branch
// is open.
//
// WHAT THE RULE READS, AND WHY IT IS NOT "TOUCHES CHANGELOG.md"
//
// The hold is for what a branch ADDS under `[Unreleased]`, because that is the
// only text the cut can absorb. An edit elsewhere in the file -- a typo in a
// released section, a link, a heading -- survives the cut untouched.
//
// This repository used to hold for any CHANGELOG.md edit. That rule was measured
// in microsoft-brand-guidelines against its own history (40 releases, 87 pull
// requests; the table is in that repository's tools/in-flight.js):
//
//   holds for an added [Unreleased] bullet   4/40 releases, worst delay  0.7h
//   holds for any CHANGELOG.md edit          7/40 releases, worst delay  116h
//
// Both catch the corruption the guard exists for, so a test that only asks "does
// it hold when it must" passes on either. The three extra holds buy nothing and
// one of them cost four and a half days. tools/release-conformance.js pins both
// halves -- that it holds, and that it releases when the only thing open cannot
// be absorbed.

function bullets(text) {
  return String(text || '').split(/\r?\n/).filter(line => /^- /.test(line)).map(line => line.trim());
}

function unreleasedBullets(text) {
  if (!text) return [];
  const lines = String(text).split(/\r?\n/);
  const start = lines.findIndex(line => /^## \[Unreleased\]/.test(line));
  if (start === -1) return [];
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## \[/.test(lines[i])) { end = i; break; }
  }
  return bullets(lines.slice(start + 1, end).join('\n'));
}

// What a branch would add to the section the cut is about to rename. Bullets main
// already carries are not absorbable: the 3-way merge sees identical text on both
// sides and has nothing to move. `notes` is main's own `[Unreleased]` body.
function absorbable(notes, headChangelog) {
  const mine = new Set(bullets(notes));
  return unreleasedBullets(headChangelog).filter(bullet => !mine.has(bullet));
}

async function inFlight(github, notes) {
  const pulls = await github.pages('/pulls?state=open&base=main');
  const held = [];
  for (const pull of pulls) {
    if (!Number.isSafeInteger(pull.number) || pull.number < 1 || typeof pull.title !== 'string') {
      throw new Error('GitHub API returned an invalid pull request');
    }
    const files = await github.pages(`/pulls/${pull.number}/files`, 30);
    if (!files.every(file => typeof file.filename === 'string')) throw new Error('GitHub API returned invalid PR files');

    // A branch that renames or deletes CHANGELOG.md is held whatever it carries
    // under `[Unreleased]`. That is a different hazard from absorption -- the cut
    // rewrites a file the branch has moved out from under it -- and it is rare
    // enough that holding for it costs no cadence.
    const moved = files.some(file =>
      (file.previous_filename === 'CHANGELOG.md' && file.filename !== 'CHANGELOG.md') ||
      (file.filename === 'CHANGELOG.md' && file.status === 'removed'));

    let entries = [];
    if (!moved && files.some(file => file.filename === 'CHANGELOG.md')) {
      const sha = pull.head && pull.head.sha;
      if (typeof sha !== 'string') throw new Error('GitHub API returned a pull request with no head commit');
      entries = absorbable(notes, await github.file('CHANGELOG.md', sha));
    }

    // Notes that cite an open pull request describe work that has not landed, so
    // releasing them would publish a claim the tag cannot support.
    const mentioned = new RegExp(`(?:#|/pull/)${pull.number}(?!\\d)`).test(notes);

    if (moved || entries.length || mentioned) {
      held.push({ number: pull.number, title: pull.title, entries: entries.length });
    }
  }
  return held;
}

module.exports = { bullets, unreleasedBullets, absorbable, inFlight };
