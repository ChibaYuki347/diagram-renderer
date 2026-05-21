# Changelog

All notable changes to `diagram-renderer` are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
