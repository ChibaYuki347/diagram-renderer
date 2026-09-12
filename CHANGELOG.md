# Changelog

All notable changes to `diagram-renderer` are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Changelog-driven release automation with automatic minor/patch selection,
  explicit manual next-major releases, open-PR holds and verified recovery.
- A standing release-due issue for unpublished notes, holds and inspection
  failures, refreshed on weekday mornings and after release runs.
- Offline release tooling tests in CI and a maintainer release guide covering
  version synchronization, permissions and marketplace delivery.

## [0.4.0] — 2026-09-06

### Added
- **End-to-end render smoke test** (`test/e2e-render.test.js`, `npm run test:e2e`)
  and a dedicated `e2e` CI job. Until now CI only ran unit tests: it never
  launched Chromium, never resolved an icon and never exercised strict-offline
  mode, so the suite could be green while the renderer was broken on a given
  platform — which is exactly how the Linux-only Chromium lookup fixed in 0.3.0
  survived review. The new job renders committed samples for real and proves:
  - `mmdc` and Chromium resolve and launch;
  - every `<image xlink:href="https://…">` in the sample inlines from the local
    mirror (`unresolved.length === 0`);
  - Chromium issues **zero** network requests during the render;
  - an icon that is *not* mirrored fails the render instead of silently
    fetching it.
- Committed samples that double as documentation of the expected input shape:
  `test/sample-architecture.drawio.svg` (5 Octicon references) and
  `test/sample-flow.mmd`.
- The `e2e` job uploads the rendered PNGs as a build artifact
  (`rendered-samples`), so a reviewer can download and actually look at what
  the renderer produced for a given commit.
- `npm run fetch-icons` convenience script.

### Fixed
Both of these were found by the new end-to-end test on its first run, and
neither was reachable from the unit suite:
- **Mermaid rendering was broken on every fresh install.** `resolveMmdc()`
  located mermaid-cli via `require.resolve('@mermaid-js/mermaid-cli/package.json')`,
  but that package declares an `exports` map with no `./package.json` entry, so
  the call always threw `ERR_PACKAGE_PATH_NOT_EXPORTED` and the renderer
  reported "mermaid-cli (mmdc) not found. Run `npm install`" even immediately
  after a successful `npm install`. It now falls back to walking the
  `node_modules` chain directly.
- **Valid draw.io SVG exports were rejected.** `detectDrawioKind()` only
  examined the single tag following the XML declaration, so any file with a
  comment, `DOCTYPE` or processing instruction before the root element failed
  with "could not detect SVG content in input" — including exports that draw.io
  itself produces. The whole XML prologue is now skipped. Covered by 14 new
  unit tests in `test/detect-drawio-kind.test.js`.

## [0.3.0] — 2026-05-23

### Added
- **Icon catalog** (`lib/icon-index.js`) and **`icon-search` CLI**
  (`bin/icon-search.js`). Indexes the local `.local-assets/` mirror and
  answers "which icon do I use for Cosmos DB?" with the exact URL that is
  guaranteed to resolve offline. This removes the single largest failure
  mode in icon-rich authoring: agents guessing icon filenames and only
  finding out at render time.
  - Folds pack variants (`_scalable`, BW/color, `NN-icon-service-` prefixes,
    normalized + original filenames) into one entry with `variants[]`.
  - Derives canonical outbound URLs from `resolver-rules.json` so
    authoring-time and render-time cannot drift.
  - Exit codes: `0` hits, `2` usage error, `3` no match. `--json`, `--set`,
    `--sets`, `--id`, `-n/--limit` supported.
- `searchRecursive` support in the draw.io resolver: flat URLs
  (`/img/lib/mscae/Office_365.svg`) now resolve by basename anywhere under
  a nested mirror subtree.
- 29 icon-index tests + 6 new resolver tests (50 total, up from 15).
- CI now asserts `skills/diagram-renderer/package.json` version matches both
  plugin manifests, so the drift fixed below cannot recur.

### Fixed
- **`diagram-author` agent referenced CLIs that do not exist.** Step 3 told
  the agent to run `bin/render.js` with `--strict-offline`; the real binaries
  are `bin/render-mermaid.js` / `bin/render-drawio.js`, and strict offline is
  the *default* (the opt-out is `--allow-network`). Any literal execution of
  the documented command failed.
- **`drawio-mscae` resolver rule pointed at an unpopulated directory**
  (`m365/`). Microsoft folded the standalone M365 stencils into the Azure
  pack, so it now maps to `azure/` with `searchRecursive`. Previously every
  `mscae/` URL failed to resolve, and the agent was documented to avoid them.
- **Path-traversal weakness** in the resolver: the containment check used
  `candidate.startsWith(absRoot)`, which accepted sibling directories such as
  `<root>-evil`. Replaced with a segment-aware `isInside()`.
- **Chromium discovery was Linux-only.** `findChromium()` now covers Linux,
  macOS and Windows (Playwright cache dirs plus system installs including
  Edge). draw.io rendering previously could not start on macOS or Windows.
- **mermaid-cli was unspawnable on Windows.** The `.bin/mmdc` shim is not
  directly executable there; `resolveMmdc()` now runs mermaid-cli's JS entry
  through `process.execPath`.
- `package.json` version was stuck at `0.1.0` while both plugin manifests
  said `0.2.0`.
- `scripts/fetch-icons.sh` and `bin/render-drawio.js --help` documented the
  asset root as `~/.copilot/...`; the code resolves `<skill>/.local-assets`.
- `README.md` had its "Asset licensing" and "Development" sections duplicated
  verbatim, listed 5 resolver rules under names that do not exist (there are
  7), and showed a `--code` flag that `render-mermaid` does not accept.
- A resolver test failed on case-insensitive filesystems (Windows/macOS)
  because the fallback path it exercised was never reached.

### Changed
- **Repositioned as a standalone Open Skill.** No behavioural change to the
  renderer — the code never depended on any other plugin — but the docs,
  manifests and agent no longer assume a private marketplace or a companion
  brand plugin:
  - `SKILL.md` setup no longer instructs running a private `bootstrap.sh`.
  - The `diagram-author` agent's hard `slide-architect` handoff is now an
    optional, described output shape.
  - README leads with `copilot plugin install ChibaYuki347/diagram-renderer`
    and a plain `git clone`; the brand-deck bridge is documented as one
    optional consumer.
  - Plugin manifest descriptions no longer say "Pairs with
    microsoft-brand-guidelines".
  - Agent style guidance no longer hardcodes a specific brand palette.
- `microsoft-light` remains the default mermaid theme for backward
  compatibility; `--theme default` selects stock mermaid styling.

## [0.2.0] — 2026-05-22

### Added
- **Bundled `diagram-author` custom agent** (relocated from
  `microsoft-brand-guidelines` per CHARTER §3.3 — outcome-based agent
  placement). Invoke with `/agent diagram-author <intent>`. The agent
  resolves its own renderer CLIs via self-discovery first, with a
  fallback to `~/.copilot/installed-plugins/` search.
- `.plugin/plugin.json` and `.claude-plugin/plugin.json` now declare
  `"agents": ["./agents"]`, registering the agent on `copilot plugin
  install / update`.
- **Capability declaration** (doc-only in v1.0 of the charter — see
  CHARTER §4.3):
  ```jsonc
  "provides": {
    "diagram.render.mermaid":    { "version": "1.0", "command": "skills/diagram-renderer/bin/render-mermaid.js" },
    "diagram.render.drawio":     { "version": "1.0", "command": "skills/diagram-renderer/bin/render-drawio.js" },
    "diagram.extract.mermaidMd": { "version": "1.0", "command": "skills/diagram-renderer/bin/extract-md-mermaid.js" }
  }
  ```
- README §"Capability contract (locked in CHARTER §4.2)" with the full
  locked CLI signatures.
- "Governed by [CHARTER.md](https://github.com/ChibaYuki347/chibayuki-private-marketplace/blob/main/CHARTER.md)"
  section in README — this plugin is now formally governed by the
  marketplace charter.

### Notes
- This is a **minor bump** (0.1 → 0.2) because, in pre-1.0 SemVer
  (CHARTER §5.1), additive behavior with a relocation symmetry (paired
  with brand 0.2.1 → 0.3.0) is the right granularity. From 1.0 onward,
  capability-id removals would require a major bump.

## [0.1.0] — 2026-05-21

Initial public release as a Copilot CLI plugin.

### Added
- Mermaid renderer (`lib/render.js`) — code/file/section input, light & dark
  Microsoft brand themes, deterministic SHA1-keyed cache
- Mermaid extractor (`lib/extract.js`) — pulls ` ```mermaid ` fences from
  any `.md` file with section anchors (`bin/extract-md-mermaid.js` CLI)
- draw.io editable-SVG renderer (`lib/render-drawio.js`) — uses headless
  Chromium (Puppeteer) to screenshot `.drawio.svg` files at natural resolution
- **Offline icon resolver** (`lib/inline-external-images.js`) — DOM-scans
  draw.io SVGs and rewrites `<image href="https://...">` to inline
  `data:` URIs from the local mirror; Puppeteer's `setRequestInterception`
  blocks any `http(s):` request (defense-in-depth) when `strictOffline: true`
  (default)
- 5 resolver rules covering Azure (mscae + azure2 layouts), Entra (aka.ms
  convention), Power Platform (aka.ms convention), GitHub Octicons (jsDelivr
  URL pattern)
- `scripts/fetch-icons.sh` — license-safe icon acquisition (Octicons via npm
  MIT auto-fetch; Azure / Entra / Power Platform require manual ZIP download
  with `READ_AND_AGREE=1` consent)
- 15 unit tests (`test/inline-external-images.test.js`)
- Documentation: `SKILL.md`, `docs/icons-in-drawio.md`, `docs/icon-svg-patterns.md`

### Compatibility
- Pairs with [`microsoft-brand-guidelines`](https://github.com/ChibaYuki347/microsoft-brand-guidelines) (private invite-only) for Microsoft-branded slide output
- Standalone-usable for any consumer that wants offline Mermaid / draw.io rendering
