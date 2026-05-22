# Changelog

All notable changes to `diagram-renderer` are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
