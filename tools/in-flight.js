'use strict';

async function inFlight(github, notes) {
  const pulls = await github.pages('/pulls?state=open&base=main');
  const held = [];
  for (const pull of pulls) {
    if (!Number.isSafeInteger(pull.number) || pull.number < 1 || typeof pull.title !== 'string') {
      throw new Error('GitHub API returned an invalid pull request');
    }
    const files = await github.pages(`/pulls/${pull.number}/files`, 30);
    if (!files.every(file => typeof file.filename === 'string')) throw new Error('GitHub API returned invalid PR files');
    // A changelog edit (including a rename) is conservatively held, even if it
    // currently touches only historical notes. File-list APIs can omit patches.
    const changesNotes = files.some(file => file.filename === 'CHANGELOG.md' || file.previous_filename === 'CHANGELOG.md');
    const mentioned = new RegExp(`(?:#|/pull/)${pull.number}(?!\\d)`).test(notes);
    if (changesNotes || mentioned) held.push({ number: pull.number, title: pull.title });
  }
  return held;
}

module.exports = { inFlight };
