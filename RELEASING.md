# Releasing diagram-renderer

Releases are driven by `CHANGELOG.md`, not by hand-editing version numbers.
The `release` workflow runs on every push to `main`, or by manual dispatch
**on main**. It checks out the latest main after waiting for the shared release
concurrency group. A release already in progress is never cancelled.

## Normal contribution and release

1. Make changes in a pull request. Put user-visible notes under
   `## [Unreleased]`, using Keep a Changelog headings.
2. Leave the three manifest versions and released changelog sections alone.
   Run the offline checks below and let the existing unit/e2e PR checks pass.
3. Merge the reviewed PR. The workflow plans and validates a release cut,
   commits the synchronized versions and changelog, atomically pushes the
   commit and annotated `vX.Y.Z` tag, and publishes a GitHub Release containing
   **only that version's notes**.

The manifests are `.plugin/plugin.json`, `.claude-plugin/plugin.json` and
`skills/diagram-renderer/package.json`. The package lock is deliberately
gitignored in this repository; automation does not introduce or commit one.
If a lock exists locally its top-level version and `packages[""].version`
(lockfile v2/v3) must match and are updated too. If the project later tracks
that lock, it is included in the release commit. Dependency versions are not
changed by the planner. `package.json` remains private: there is no npm publish.

| Unreleased content | Automatic choice |
| --- | --- |
| Nonempty `### Added` or `### Removed` | Next minor, patch reset to zero |
| Other user-visible notes (for example Fixed, Changed, Security) | Next patch |
| Empty, headings-only or HTML-comment-only section | No-op |

Automatic selection **never chooses a major**, including for notes under
Removed. Maintainers must review contract-breaking changes before merging:
the category rule is a deterministic heuristic, not compatibility analysis.
For a controlled major, merge the notes while a separate open changelog PR
holds automatic publication. Wait until that main push's release run has
finished in the held state, close the holding PR **without merging**, then
dispatch on main with `version` set to the exact next major, such as `1.0.0`
from `0.4.0`. Do not merge another PR between lifting the hold and dispatch:
any main push can trigger automatic minor/patch publication. The manual major
run is still subject to the same open-PR guard. Never disable safeguards by
editing versions on main.

Only the exact next major `X+1.0.0` is accepted by the optional `version`
input. `major`, `v1.0.0`, prereleases, skipped majors, manual minors/patches,
and shell expressions fail. Empty notes remain a no-op even with a valid
major input. Leave `version` empty for normal automatic selection and recovery.

## Holds and the standing release-due issue

An open PR targeting main holds a new release if it changes or renames
`CHANGELOG.md`, or the pending notes mention it as `#number` or `/pull/number`.
The file check is deliberately conservative: even a historical changelog
edit holds the release. This avoids cutting notes while related work is
still in flight. Unrelated PRs without changelog edits do not hold releases.
All PR/file pages are read; failures and pagination limits fail explicitly,
never masquerade as "no open PRs". The guard is checked again after cut
validation. It is a snapshot, not a lock on GitHub PR creation.

After merging a blocking PR, its main push retries automatically. After
closing it without merging, manually dispatch release with empty `version`
(closing a PR does not produce a main push). A held run succeeds without
pushing anything, and its job summary lists the blocking PR numbers.

`release-due` runs Monday-Friday at **06:30 JST** (`30 21 * * 0-4` in UTC),
on manual dispatch, and after a main `release` workflow completes. GitHub
scheduled runs can be delayed. It maintains one bot-authored **Release due**
issue, reusing/reopening that same issue in later cycles:

| Status | Meaning |
| --- | --- |
| `ready` | Pending notes with no known PR hold; not proof that release CI passed |
| `held` | Pending notes plus blocking PR numbers |
| `recovery` | A verified cut is tagged but lacks a published GitHub Release |
| `failed` | Inspection failed, so readiness is unknown; the workflow also fails |
| `published` | Current version is published and Unreleased is empty; close the issue |

The issue includes only unpublished notes, not all historical versions.
An inspection failure is recorded if the issue API is reachable; if that API
also fails, the workflow fails rather than reporting a successful update.
Multiple matching standing issues are treated as an error, not deleted.
The issue is a reminder, not a second publisher.

## Failure, concurrency and recovery

- **Main advanced during planning:** the workflow refuses to use the newer
  commit as its release target. Dispatch again on main. The push is atomic
  and non-force: if either main or the tag conflicts, neither ref is changed.
- **Tag pushed, Release API failed:** dispatch on main with empty `version`.
  Automation verifies the tag's exact commit, single parent, release marker,
  manifest versions, changed file set and reconstructed changelog cut. It
  publishes only that cut, even if main now contains additional unreleased
  notes. A later run can release the new notes.
- **Release succeeded but the response was lost:** a retry recognizes the
  existing matching release and does not rewrite it.
- **Existing tag/release conflicts, missing tag, unverified legacy cut,
  modified published notes or API failure:** the workflow fails. Inspect
  Actions logs and the relevant tag/commit before any manual repair. Do not
  delete or force-move release tags, overwrite notes, or guess a target SHA.
- **Validation failed before push:** nothing is published. Fix the source or
  infrastructure in a PR and retry. Temporary runner changes are not pushed.

Recovery never makes a newer main commit impersonate an earlier release.
The release bot's `chore(release):` commits are filtered from push-triggered
release jobs; the default `GITHUB_TOKEN` also prevents recursive workflow
triggers from its own pushes. Manual dispatch remains available for recovery.
The renderer unit suite runs before planning; offline tooling tests and
version/changelog consistency checks run again against the generated cut.
The existing end-to-end rendering suite remains a PR/main CI check.

## Permissions and distribution boundary

`release` uses `contents: write` and `pull-requests: read`;
`release-due` uses `contents: read`, `issues: write`, and
`pull-requests: read`. Both use the repository's `GITHUB_TOKEN`. Actions and
Issues must be enabled, and repository/org policy must permit these grants.
Branch/ruleset policy must allow the release bot's direct version commit and
tag push. If policy blocks it, the run fails; no alternate credential or
branch-protection bypass is attempted. A maintainer must resolve that policy
decision. Contributors pushing workflow-file changes need a credential
authorized to edit workflows.

Publishing a plugin Release is separate from marketplace delivery.
The marketplace's existing pull-based synchronization discovers published
GitHub Releases, proposes a catalog `source.ref`/version update in a PR, and
a human merges that PR to deliver it to marketplace users. There is no
catalog pre-bump, cross-repository token, push or dispatch in this plugin.

## Offline checks

From the repository root (Node 20 and Git):

```bash
node --test tools/plan-release.test.js tools/release.test.js
node tools/plan-release.js --check
node tools/plan-release.js --plan
```

The planner CLI is read-only. Tests use temporary local Git repositories and
fake GitHub APIs: they do not dispatch workflows, create real tags/releases
or issues, or need credentials. They cover version policy, empty notes,
invalid input, lock consistency, PR holds, API failures/pagination, atomic
push rejection, concurrent main updates, publication retry/recovery and
standing issue lifecycle.
