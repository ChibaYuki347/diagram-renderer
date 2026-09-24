# Releasing diagram-renderer

Releases are driven by change files, not by hand-editing `CHANGELOG.md` or
version numbers. Each pull request that changes something a plugin user can see
adds one file, `changes/<name>.md`; a pull request that changes nothing
user-visible carries the `skip-changelog` label instead. The release workflow
runs once a working day and writes `CHANGELOG.md` from the files that have
already merged to `main`.

## Normal contribution and release

1. In a pull request, add `changes/<name>.md` and leave released changelog
   sections and versions alone.
2. Use this format:

   ```markdown
   ---
   type: fixed        # added | changed | fixed | removed
   breaking: false    # optional; true for a change that breaks a caller
   ---
   One line: what changed, for someone reading the changelog.
   ```

3. If the pull request changes nothing a user of the plugin sees, add the
   `skip-changelog` label and do not add a change file. The PR check fails if a
   pull request has neither, has both, has an unreadable change file, nests a
   change file below `changes/`, or edits a released changelog section.
4. Merge the reviewed PR. At **05:30 JST, Monday-Friday** (`30 20 * * 0-4`) or
   on manual dispatch, `.github/workflows/release.yml` checks out latest `main`,
   reads the change files, validates the cut, commits the synchronized files,
   atomically pushes the commit and annotated tag, and publishes a GitHub Release
   containing only that version's notes.

The manifests are `.plugin/plugin.json`, `.claude-plugin/plugin.json` and
`skills/diagram-renderer/package.json`. The package lock is ignored in this
repository; if it exists locally, the planner keeps its root version in sync but
does not introduce it into the release commit unless it is already tracked.

| Change files on `main` | Automatic choice |
| --- | --- |
| Any `type: added` or `type: removed` | Next minor, patch reset to zero |
| Only `type: changed` and/or `type: fixed` | Next patch |
| No change files | No-op: the only quiet "no" |

Every other "no" fails the run, so the failed workflow is what tells a person:
a scheduled run that stayed green would retry it every morning with nobody
told.

- Past 1.0.0, `type: removed` or `breaking: true` refuses the automatic
  release. Only a person takes the major.
- A change file whose commit names no pull request — pushed to `main`
  directly — is refused, because every released line links its pull request
  and a released line is not edited afterwards. Renaming the file in a pull
  request (`git mv changes/x.md changes/x-1.md`) makes that pull request the
  one that added it.
- A release is dated in Tokyo: 05:30 JST is 20:30 UTC the day before, and a
  UTC date would stamp every scheduled release a day early.

## Taking the major

The major is typed by a person, not derived from a change file. Use Actions →
**release** → *Run workflow* and enter the exact next major in the `version`
field, for example `1.0.0` from `0.6.0`. Leave the field empty for normal
minor/patch releases and for recovery.

The workflow refuses anything except the exact next major: skipped majors,
manual minors/patches, `v1.0.0`, prereleases and shell expressions fail. A valid
major with no change files is still a no-op; typing a number does not create
notes. The old holding-PR dance is gone.

## Why holds and release-due are retired

When pull requests hand-wrote bullets under `## [Unreleased]`, a release renamed
that heading and an open branch could later merge its bullets into a section that
had already shipped. The old release therefore waited for open changelog work and
`release-due` kept a standing issue for holds and unpublished notes.

Change files remove the hazard. A branch that is still open has not put its file
on `main`, so a release has nothing of it to absorb and never waits for it. The
PR check protects the other side of the boundary by refusing edits to released
sections. There is no hold state and no release-due alarm to maintain.

## Failure, concurrency and recovery

- **Main advanced during planning or validation:** the run fails before tagging.
  Dispatch again on latest `main`.
- **Validation failed before push:** nothing is published. Fix the source or the
  runner issue in a PR; the change files stay on `main` for the next run.
- **Tag pushed, Release API failed:** dispatch the workflow on `main` with an
  empty `version`. Automation verifies the exact tagged cut (single parent,
  release commit marker, versions, changed file set, deleted change files and
  reconstructed notes) and publishes that cut even if newer change files have
  since reached `main`.
- **Release succeeded but the response was lost:** retrying sees the matching
  release and does not rewrite it.
- **Existing tag/release conflicts, missing tag, unverified legacy cut, modified
  published notes or API failure:** the workflow fails. Inspect the tag, release
  and Actions logs; do not force-move tags or guess a target SHA.

The push is atomic and non-force: if either `main` or the tag conflicts, neither
ref changes. A run started manually while the scheduled run is active waits on
the release concurrency group, checks out `main` again, and usually finds the
change files already gone.

## Permissions and distribution boundary

`release` uses `contents: write` only. The repository `GITHUB_TOKEN` is still
used to push the release commit/tag and publish the GitHub Release; it no longer
needs `pull-requests: read`. Branch/ruleset policy must allow the release bot's
direct commit and tag push, or the run fails.

Publishing a GitHub Release is separate from marketplace delivery. The
marketplace repository discovers releases, proposes a catalog `source.ref` update
in its own PR, and a human merges that PR to deliver the new plugin version.

## Offline checks

From the repository root (Node 20+ and Git):

```bash
node --test tools/plan-release.test.js tools/release.test.js tools/changes.test.js tools/release-conformance.test.js
node tools/plan-release.js --check
node tools/changes.js --check
node tools/plan-release.js --plan
python -c "import yaml; yaml.safe_load(open('.github/workflows/changes.yml')); yaml.safe_load(open('.github/workflows/release.yml'))"
```

The tests use local git repositories under `.test-work/` and fake GitHub APIs.
They do not dispatch workflows, create real releases, contact GitHub or need
credentials.
