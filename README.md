# diagram-renderer

[![CI](https://github.com/ChibaYuki347/diagram-renderer/actions/workflows/test.yml/badge.svg)](https://github.com/ChibaYuki347/diagram-renderer/actions/workflows/test.yml)
[![Release](https://img.shields.io/github/v/release/ChibaYuki347/diagram-renderer)](https://github.com/ChibaYuki347/diagram-renderer/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> **Governed by**: [Chibayuki Private Marketplace — Plugin Charter](https://github.com/ChibaYuki347/chibayuki-private-marketplace/blob/main/CHARTER.md)

An offline-first Mermaid + draw.io renderer for slide decks. Resolves
Azure / Entra / Power Platform / GitHub Octicon icons from a local mirror
with **strict offline guarantee** (Puppeteer-blocked `http(s):` requests by
default).

Pairs with [`microsoft-brand-guidelines`](https://github.com/ChibaYuki347/microsoft-brand-guidelines)
(private, invite-only) for Microsoft-branded slide decks, but is fully usable
standalone — anything that wants reproducible Mermaid/draw.io PNGs at natural
resolution can call it directly.

---

## What it provides

| Capability | Module |
|---|---|
| Render Mermaid (`graph`, `sequenceDiagram`, etc.) → PNG | `lib/render.js` |
| Extract ` ```mermaid ` fences from any `.md` | `lib/extract.js` |
| Render draw.io **editable SVG** (`.drawio.svg`) → PNG via headless Chromium | `lib/render-drawio.js` |
| Inline external `<image>` refs in draw.io SVG from local mirror | `lib/inline-external-images.js` |
| Acquire icon packs (Octicons + 4 Microsoft sets) | `scripts/fetch-icons.sh` |
| **`diagram-author` custom agent** (bundled in v0.2.0) | `agents/diagram-author.agent.md` |

5 icon resolver rules ship out of the box:

- `mscae-azure-cdn` — `https://app.diagrams.net/img/lib/mscae/...` → `azure/`
- `drawio-azure2-stencils` — Azure stencil URLs → `azure/`
- `ms-entra-pack-convention` — `https://aka.ms/entra-icons/<flavor>/<name>.svg` → `entra/`
- `ms-power-platform-pack-convention` — `https://aka.ms/power-platform-icons/<name>.svg` → `power-platform/`
- `github-octicons-jsdelivr` — jsDelivr Octicon URLs → `github/`

---

## Bundled agent: `diagram-author`

`diagram-author` (relocated from `microsoft-brand-guidelines` in v0.2.0)
is a custom Copilot CLI agent that orchestrates diagram design and
rendering through this plugin's CLIs. Invoke via:

```bash
copilot -p '/agent diagram-author Sequence diagram: user logs in via Entra ID then GitHub EMU SCIM provisions the account'
```

It produces a `.mmd` or `.drawio.svg` source file plus a rendered `.png`,
ready to drop into a slide via `microsoft-brand-guidelines` `slides.json`.

---

## Capability contract (locked in CHARTER §4.2)

This plugin's CLIs are the **cross-plugin contract** for diagram rendering.
Other plugins (notably the brand bridge) invoke them through `child_process`.
Signatures are locked and require a major version bump to change.

### `bin/render-mermaid.js`

```
render-mermaid <input.mmd|-> --out <output.png> [options]

Options:
  --out, -o            Output path (REQUIRED)
  --theme              microsoft-light (default) | microsoft-dark | default
  --theme-file FILE    Path to custom mermaid themeVariables JSON
  --scale N            Device scale (default 2)
  --width N            CSS viewport width in px (default 1600)
  --background COLOR   Override background color
  --format png|svg|pdf Override format (inferred from --out otherwise)
  --help, -h
```

Stdin form: pass `-` as input to read mermaid source from stdin.

### `bin/render-drawio.js`

```
render-drawio <input.svg|.drawio.svg> --out <output.png> [options]

Options:
  --out                   Output path (REQUIRED)
  --scale N               Device scale
  --cssWidth N            CSS viewport width
  --background COLOR      Override background ('transparent' for theme inherit)
  --allow-network         Opt-in to fetch external icons (default: STRICT OFFLINE)
  --no-inline-images      Skip auto-inlining of referenced icons
  --asset-root DIR        Override local icon mirror
  --rules FILE            Override resolver rules JSON
  --aliases FILE          Override exact-URL alias JSON
  --report-missing FILE   Dump unresolved URLs to JSON
```

Stdin form: `cat diagram.svg | render-drawio --out diagram.png`.

### `bin/extract-md-mermaid.js`

```
extract-md-mermaid <input.md> [--out DIR] [--list] [--render] [--theme NAME] [--cssWidth N]

Options:
  --out DIR     Write `mermaid-001.mmd ...` + manifest.json into DIR
                (default: <input>.mermaid/)
  --list        Print a table of blocks (index, lineStart, sectionTitle) and exit
  --render      Also render each block to PNG via render-mermaid
  --theme NAME  Mermaid theme (default: microsoft-light). Used only with --render
  --cssWidth N  CSS viewport width for render (default: 1100)
```

All three commands: exit 0 on success, non-zero on failure with
human-readable stderr output.

---

## Install

Via the chibayuki-private-marketplace (recommended; bundled with the
brand pipeline):

```bash
bash <(gh api -H 'Accept: application/vnd.github.raw' repos/ChibaYuki347/chibayuki-private-marketplace/contents/bootstrap.sh)
```

Or standalone from GitHub:

```bash
copilot plugin install ChibaYuki347/diagram-renderer
```

First-run setup (one-time): populate the local icon mirror.

```bash
cd ~/.copilot/installed-plugins/diagram-renderer/diagram-renderer/skills/diagram-renderer
npm install                       # mmdc + puppeteer
READ_AND_AGREE=1 scripts/fetch-icons.sh github   # auto MIT
READ_AND_AGREE=1 scripts/fetch-icons.sh azure    # manual ZIP — see prompt
READ_AND_AGREE=1 scripts/fetch-icons.sh entra    # manual ZIP
READ_AND_AGREE=1 scripts/fetch-icons.sh power-platform  # manual ZIP
```

The script prints the LICENSE summary and the official Microsoft download
URL for each pack; you place the ZIP into `.local-assets/_inbox/` and rerun.
The MS packs are never re-distributed by this repo.

---

## Quick start

### Render a Mermaid diagram directly

```bash
node bin/render-mermaid.js \
  --code 'graph LR; A[Customer] --> B(Function); B --> C[(Cosmos)]' \
  --theme microsoft-light \
  --out out.png
```

### Render a draw.io editable SVG (Azure icons resolved offline)

```bash
# In drawio: File → Save As → Editable SVG
node bin/render-drawio.js diagrams/arch.drawio.svg --out arch.png
```

### Compose with `microsoft-brand-guidelines`

Once both plugins are installed (the brand one requires `gh auth login`),
add diagrams to your `slides.json`:

```jsonc
{
  "layout": "image", "variant": "image-full",
  "content": {
    "title": "Reference architecture",
    "drawioFile": "diagrams/arch.drawio.svg",
    "caption": "Multi-tenant SCIM data flow"
  }
}
```

The brand bridge auto-locates this skill and invokes it; output is cached
under `<deckdir>/.diagram-cache/<sha1>.png`.

---

## Strict offline mode

By default, draw.io rendering runs with Puppeteer `setRequestInterception(true)`
blocking every `http(s):` request. If your `.drawio.svg` references an
external icon that the resolver cannot map to a local file, the render fails
fast with an actionable error:

```
drawio render failed: 3 external images could not be resolved offline:
  - https://app.diagrams.net/img/lib/mscae/Compute/App_Services.svg
  - ...
Try one of:
  (a) Re-export the .drawio.svg from draw.io with "Embed Images" ON
  (b) Run scripts/fetch-icons.sh to populate the local mirror
  (c) Add manual entries to assets/icons/aliases.json
  (d) Pass --allow-network (NOT recommended on corp networks)
```

This guarantee makes the renderer safe to use on locked-down corporate
networks (Microsoft Global Secure Access, etc.).

---

## Versioning & updates

This plugin uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
(pre-1.0: minor bumps may break — see [CHARTER §5.1](https://github.com/ChibaYuki347/chibayuki-private-marketplace/blob/main/CHARTER.md#§5--versioning)).

```bash
copilot plugin update diagram-renderer
```

Releases are published automatically by `.github/workflows/release.yml`
when the `.plugin/plugin.json` version field changes on `main`.

This plugin declares its capabilities via the `provides` field in the
manifest (see CHARTER §4.3):

```jsonc
{
  "provides": {
    "diagram.render.mermaid":    { "version": "1.0", "command": "..." },
    "diagram.render.drawio":     { "version": "1.0", "command": "..." },
    "diagram.extract.mermaidMd": { "version": "1.0", "command": "..." }
  }
}
```

---

## Asset licensing

Renderer code: **MIT** (see [LICENSE](LICENSE)).

Icon assets fetched into `.local-assets/`:

| Set | License | Source |
|---|---|---|
| GitHub Octicons | MIT | `@primer/octicons` npm package |
| Azure | Microsoft brand guidelines | Public Service Icons V23 ZIP (manual DL) |
| Entra | Microsoft brand guidelines | Entra architecture icons Oct-2023 ZIP (manual DL) |
| Power Platform | Microsoft brand guidelines | Power Platform Icons Scalable ZIP (manual DL) |

`.local-assets/` is `.gitignore`'d and never committed.

See [`skills/diagram-renderer/docs/icons-in-drawio.md`](skills/diagram-renderer/docs/icons-in-drawio.md)
for full author guide (drawio library import, naming conventions, troubleshooting).

---

## Development

```bash
cd skills/diagram-renderer
npm install
npm test
```

Tests cover the SVG inline pass (15 cases including DOM parsing, href vs
xlink:href, path traversal, base64 size budgets).

Renderer code: **MIT** (see [LICENSE](LICENSE)).

Icon assets fetched into `.local-assets/`:

| Set | License | Source |
|---|---|---|
| GitHub Octicons | MIT | `@primer/octicons` npm package |
| Azure | Microsoft brand guidelines | Public Service Icons V23 ZIP (manual DL) |
| Entra | Microsoft brand guidelines | Entra architecture icons Oct-2023 ZIP (manual DL) |
| Power Platform | Microsoft brand guidelines | Power Platform Icons Scalable ZIP (manual DL) |

`.local-assets/` is `.gitignore`'d and never committed.

See [`skills/diagram-renderer/docs/icons-in-drawio.md`](skills/diagram-renderer/docs/icons-in-drawio.md)
for full author guide (drawio library import, naming conventions, troubleshooting).

---

## Development

```bash
cd skills/diagram-renderer
npm install
npm test
```

Tests cover the SVG inline pass (15 cases including DOM parsing, href vs
xlink:href, path traversal, base64 size budgets).
