# diagram-renderer

[![CI](https://github.com/ChibaYuki347/diagram-renderer/actions/workflows/test.yml/badge.svg)](https://github.com/ChibaYuki347/diagram-renderer/actions/workflows/test.yml)
[![Release](https://img.shields.io/github/v/release/ChibaYuki347/diagram-renderer)](https://github.com/ChibaYuki347/diagram-renderer/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

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

5 icon resolver rules ship out of the box:

- `mscae-azure-cdn` — `https://app.diagrams.net/img/lib/mscae/...` → `azure/`
- `drawio-azure2-stencils` — Azure stencil URLs → `azure/`
- `ms-entra-pack-convention` — `https://aka.ms/entra-icons/<flavor>/<name>.svg` → `entra/`
- `ms-power-platform-pack-convention` — `https://aka.ms/power-platform-icons/<name>.svg` → `power-platform/`
- `github-octicons-jsdelivr` — jsDelivr Octicon URLs → `github/`

---

## Install

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

This plugin uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

```bash
copilot plugin update diagram-renderer
```

Releases are published automatically by `.github/workflows/release.yml`
when the `.plugin/plugin.json` version field changes on `main`.

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
