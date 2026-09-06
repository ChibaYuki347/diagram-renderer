# diagram-renderer

[![CI](https://github.com/ChibaYuki347/diagram-renderer/actions/workflows/test.yml/badge.svg)](https://github.com/ChibaYuki347/diagram-renderer/actions/workflows/test.yml)
[![Release](https://img.shields.io/github/v/release/ChibaYuki347/diagram-renderer)](https://github.com/ChibaYuki347/diagram-renderer/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> Renderer code is MIT. Icon packs are **not** redistributed — see
> [Asset licensing](#asset-licensing).

An offline-first Mermaid + draw.io renderer for diagrams and slide decks.
Resolves Azure / Entra / Power Platform / GitHub Octicon icons from a local
mirror with a **strict offline guarantee** (Puppeteer-blocked `http(s):`
requests by default).

It is a standalone Open Skill: any agent, script, or deck builder that can run
a CLI or `require()` a Node module can use it. No account, no network, and no
companion plugin is required.

---

## What it provides

| Capability | Module |
|---|---|
| Render Mermaid (`graph`, `sequenceDiagram`, etc.) → PNG | `lib/render.js` |
| Extract ` ```mermaid ` fences from any `.md` | `lib/extract.js` |
| Render draw.io **editable SVG** (`.drawio.svg`) → PNG via headless Chromium | `lib/render-drawio.js` |
| Inline external `<image>` refs in draw.io SVG from local mirror | `lib/inline-external-images.js` |
| **Search the local icon mirror by name** (no more guessing URLs) | `lib/icon-index.js` / `bin/icon-search.js` |
| Acquire icon packs (Octicons + 4 Microsoft sets) | `scripts/fetch-icons.sh` |
| **`diagram-author` custom agent** | `agents/diagram-author.agent.md` |
| **Icon-rich architecture authoring** (design) | [`docs/architecture-rendering-design.md`](skills/diagram-renderer/docs/architecture-rendering-design.md) |

7 icon resolver rules ship out of the box, all driven by
[`assets/icons/resolver-rules.json`](skills/diagram-renderer/assets/icons/resolver-rules.json):

| Rule | Matches | Resolves to |
|---|---|---|
| `drawio-mscae` | `/img/lib/mscae/` | `azure/` (recursive basename search) |
| `drawio-azure2` | `/img/lib/azure2/` | `azure/` |
| `drawio-active-directory` | `/img/lib/active_directory/` | `entra/active_directory/` |
| `drawio-dynamics365` | `/img/lib/dynamics365/` | `dynamics365/` |
| `github-octicons-jsdelivr` | `/build/svg/` | `github/octicons/` |
| `ms-entra-pack-convention` | `https://aka.ms/entra-icons/` | `entra/` |
| `ms-power-platform-pack-convention` | `https://aka.ms/power-platform-icons/` | `power-platform/` |

---

## Bundled agent: `diagram-author`

`diagram-author` is a custom Copilot CLI agent that orchestrates diagram design
and rendering through this plugin's CLIs. Invoke via:

```bash
copilot -p '/agent diagram-author Sequence diagram: user logs in via Entra ID then GitHub EMU SCIM provisions the account'
```

It produces a `.mmd` or `.drawio.svg` source file plus a rendered `.png`, and
emits a slide-fragment JSON that most deck builders can splice in directly.

---

## Capability contract

This plugin's CLIs are the stable, public contract for diagram rendering.
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

```bash
copilot plugin install ChibaYuki347/diagram-renderer
```

Or clone and use it directly — nothing about this repo requires the Copilot
plugin system:

```bash
git clone https://github.com/ChibaYuki347/diagram-renderer
cd diagram-renderer/skills/diagram-renderer && npm install
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

Verify what landed:

```bash
node bin/icon-search.js --sets
```

---

## Quick start

### Render a Mermaid diagram directly

```bash
echo 'graph LR; A[Customer] --> B(Function); B --> C[(Cosmos)]' \
  | node bin/render-mermaid.js - --out out.png

# or from a file
node bin/render-mermaid.js diagrams/flow.mmd --theme default --out out.png
```

### Find the icon you want

```bash
node bin/icon-search.js cosmos db
node bin/icon-search.js "function app" --set azure -n 5
```

Each hit prints a `url:` line that is guaranteed to resolve offline — paste it
straight into your `.drawio.svg`'s `xlink:href`.

### Render a draw.io editable SVG (Azure icons resolved offline)

```bash
# In drawio: File → Save As → Editable SVG
node bin/render-drawio.js diagrams/arch.drawio.svg --out arch.png
```

### Optional: wire it into a deck builder

Deck runners can detect diagram fields on an `image` slide and call this skill
to produce the PNG. For example, the
[`microsoft-brand-guidelines`](https://github.com/ChibaYuki347/microsoft-brand-guidelines)
runner accepts:

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

It auto-locates this skill and caches output under
`<deckdir>/.diagram-cache/<sha1>.png`. That bridge lives entirely in the
calling skill — this repository has no dependency on it.

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
While pre-1.0, minor bumps may contain breaking changes; see
[CHANGELOG.md](CHANGELOG.md) before upgrading.

```bash
copilot plugin update diagram-renderer
```

Releases are published automatically by `.github/workflows/release.yml`
when the `.plugin/plugin.json` version field changes on `main`. CI enforces
that `.plugin/plugin.json`, `.claude-plugin/plugin.json` and
`skills/diagram-renderer/package.json` all carry the same version.

This plugin declares its capabilities via the `provides` field in the
manifest, so a consuming skill can discover the CLIs without hardcoding paths:

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

Tests cover the draw.io SVG inline pass (21 cases: DOM parsing, `href` vs
`xlink:href`, path traversal, recursive basename fallback, base64 size budgets)
and the icon index (29 cases: variant grouping, scoring, URL round-tripping,
CLI exit codes).
