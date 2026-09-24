# Change files

Every pull request adds one file here, `changes/<name>.md`, and edits nothing in
`CHANGELOG.md`. Name it after your branch so two pull requests never pick the
same name.

```markdown
---
type: fixed        # added | changed | fixed | removed
breaking: false    # optional; true for a change that breaks a caller
---
Correct a rendering offset.
```

- **`type`** is the Keep a Changelog heading the line is written under, and it is
  the version bump: `added` and `removed` take the minor; `changed` and `fixed`
  take the patch.
- **`breaking: true`** marks a change that breaks a caller. Below 1.0.0 it takes
  the minor, whatever the `type` (CHARTER §5.1: a patch is for fixes only).
  Past 1.0.0 it, or `type: removed`, stops the automatic release; a person
  takes the major by dispatching the release workflow with the exact next major.
- **The body is one line**: what changed, for someone reading the changelog. It
  is printed as it is, followed by the pull request's number. The details belong
  in the pull request.

A pull request that changes nothing a user of the plugin sees carries the
`skip-changelog` label instead of a file. `.github/workflows/changes.yml` fails a
pull request with neither, one with both, one whose change file does not read,
and one that edits `CHANGELOG.md` below its preamble. `node tools/changes.js
--check` reads every file here.

Once a working day, at 05:30 JST, `.github/workflows/release.yml` reads the
files here on `main`, writes the dated section of `CHANGELOG.md` from them,
bumps the version, and deletes them. A file on a branch that is still open is
not on `main`, so a release never waits for open work and never takes any of it.
