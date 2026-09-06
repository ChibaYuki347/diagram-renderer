---
name: diagram-renderer
description: Render Mermaid and draw.io diagrams to PNG/SVG so other Skills (pptx, docx, or any deck/doc generator) can embed them as static images. Strictly offline by default, with a searchable local catalog of Azure / Entra / Power Platform / GitHub Octicon icons. Ships light/dark themes plus a CLI and Node API. Use when a deck- or doc-generation workflow needs to materialize architecture diagrams, decision trees, or flow charts from markdown / source files.
---

# diagram-renderer

**Scope**: convert diagram source → static raster/vector image. This skill **does not** generate slides or documents itself — it produces PNG/SVG that other skills (e.g. `pptx`, `docx`, or any deck builder) embed.

## 🧭 New session? Start here (30 seconds)

The skill is self-contained: every CLI resolves its own paths relative to the
skill directory, so there is nothing to configure and no environment variable
to set.

```bash
cd <skill>                 # the directory containing this SKILL.md
npm install                # mermaid-cli + puppeteer
npm test                   # should print "N passed, 0 failed"
```

Rendering works immediately for Mermaid and for draw.io SVGs that already embed
their images. To resolve **product icons** offline, populate the local mirror
once:

```bash
bash scripts/fetch-icons.sh github          # Octicons, MIT, fully automatic
bash scripts/fetch-icons.sh azure entra power-platform   # Microsoft packs, manual ZIP drop
```

The mirror lands in `<skill>/.local-assets/` (gitignored, never redistributed)
and is auto-discovered at render time. Then find the exact icon to reference:

```bash
node bin/icon-search.js cosmos db
node bin/icon-search.js --sets            # what is actually installed
```

See [`docs/icons-in-drawio.md`](docs/icons-in-drawio.md) for the full author
guide.

## Capabilities

| Phase | Source | Status |
|---|---|---|
| 1 | Mermaid (inline string) → PNG/SVG | ✅ MVP |
| 1 | Mermaid (`.mmd` file) → PNG/SVG | ✅ MVP |
| 2 | Mermaid blocks inside `.md` → extracted `.mmd` files + manifest (optional render) | ✅ |
| 3 | draw.io editable SVG (`.drawio.svg` / `.svg`) → PNG | ✅ |
| 3 | draw.io raw XML (`.drawio`) → PNG | ❌ Not supported (export as Editable SVG first) |
| 4 | draw.io with Microsoft / GitHub product icons — offline inline of external `<image>` refs | ✅ ([details](docs/icons-in-drawio.md)) |
| 4 | Search the local icon mirror by name → canonical URL (`bin/icon-search.js`) | ✅ |
| 5 | **Authoring** icon-rich architecture diagrams (Mermaid `architecture-beta` with local icon packs; `arch.yaml` → auto-layout → SVG) | 📐 Proposed ([design](docs/architecture-rendering-design.md)) |

### Phase 4: offline icon inlining for draw.io

draw.io exports can reference Azure / M365 / Power Platform / Entra ID / GitHub icons
as external URLs (`<image xlink:href="https://app.diagrams.net/img/lib/azure2/...">`)
when "Embed Images" is OFF. This skill detects those URLs at render time and
substitutes data: URIs sourced from a local mirror (`.local-assets/`), so the
PNG comes out identical whether you exported with embedding ON or OFF — and **no
network is touched at render time** (enforced via Puppeteer request interception).

Setup:
- `scripts/fetch-icons.sh` — populate the local mirror (GitHub Octicons auto via npm MIT; MS icons via interactive license-confirm + manual ZIP drop)
- `bin/icon-search.js` — search the populated mirror; prints the canonical URL to paste into your SVG, so you never have to guess a filename
- `assets/icons/resolver-rules.json` — committed rule definitions (URL pattern → local subtree, plus the `canonicalUrl` used to map back)
- `assets/icons/aliases.json` — committed exact-URL overrides for edge cases
- `assets/icons/LICENSE.md` — licensing posture per icon set

### Finding the right icon

Guessing an icon filename is the most common way to break an offline render:
the mistake only surfaces at render time as an unresolved-external error.
`icon-search` reads the mirror you actually installed, so whatever it prints is
guaranteed to resolve.

```bash
node bin/icon-search.js cosmos db
# azure/databases/azure_cosmos_db  (score 708)
#   name : Azure Cosmos DB
#   set  : azure   group: databases
#   url  : https://app.diagrams.net/img/lib/azure2/databases/Azure_Cosmos_DB.svg
#   file : <skill>/.local-assets/azure/databases/Azure_Cosmos_DB.svg

node bin/icon-search.js "entra id" --set entra --json   # machine-readable
node bin/icon-search.js --sets                          # what is installed
```

Exit code `3` means "no match" — treat it as "this icon is not in the mirror",
not as a crash.

## Themes

`themes/microsoft-light.json` and `themes/microsoft-dark.json` express a
Microsoft-flavored palette as a mermaid `themeVariables` block. They are
bundled examples, not a requirement: pass `--theme default` for stock mermaid
styling, or any [mermaid themeVariables](https://mermaid.js.org/config/theming.html)
JSON file to `--theme-file` for your own palette.

## Usage

### CLI

```bash
# Inline (from stdin)
echo 'graph LR; A-->B-->C' | render-mermaid --theme microsoft-light --out diagram.png

# File
render-mermaid input.mmd --theme microsoft-dark --out diagram.png --scale 2

# Extract all ```mermaid blocks from a .md file
extract-md-mermaid docs/architecture.md --list                          # show what's there
extract-md-mermaid docs/architecture.md --out out/diagrams              # write mermaid-001.mmd + manifest.json
extract-md-mermaid docs/architecture.md --out out/diagrams --render \   # ...and rasterize each
  --theme microsoft-light --cssWidth 1100

# Render a drawio editable SVG to PNG (Phase 3)
render-drawio diagrams/arch.drawio.svg --out arch.png --cssWidth 1100

# Find the exact icon name + URL to reference in a drawio SVG (Phase 4)
icon-search cosmos db
icon-search "function app" --set azure --json
```

The `--out DIR` mode writes `manifest.json` with one entry per block:
`{ index, file, lineStart, lineEnd, sectionTitle, sectionLevel, sectionAnchor, png?, pngWidth?, pngHeight? }`.

> **draw.io workflow**: This skill renders **editable SVG** exports from draw.io
> (file extension `.drawio.svg` or plain `.svg`). To produce one from a `.drawio`
> file, open it in draw.io and choose **File → Save As → Editable SVG**
> (or **Export As → SVG** with *"Include a copy of my diagram"* enabled). Raw
> `.drawio` XML files are intentionally **not** supported — wrapping the drawio
> engine would require Electron / drawio-desktop, which we avoid for portability.

### Programmatic (Node)

```js
const { renderMermaid } = require('<skill>/lib/render');

const { path, width, height } = await renderMermaid({
  code: 'graph TD\n  Start --> End',
  theme: 'microsoft-light',
  out: '/tmp/diagram.png',
  scale: 2,
});

// Extract mermaid fences from markdown
const {
  extractMermaidBlocks,
  pickBlock,
  readMarkdownFile,
} = require('<skill>/lib/extract');

const md = readMarkdownFile('docs/architecture.md');
const blocks = extractMermaidBlocks(md);
const block = pickBlock(blocks, { section: 'Pattern B' }); // or { index: 0 }
// block.code → string ready for renderMermaid()

// Render a drawio editable SVG to PNG (Phase 3)
const { renderDrawio } = require('<skill>/lib/render-drawio');
const { path: pngPath, width, height } = await renderDrawio({
  file: 'diagrams/arch.drawio.svg',
  out: '/tmp/arch.png',
  cssWidth: 1100,
});

// Search the local icon mirror (Phase 4)
const { buildIconIndex, searchIcons } = require('<skill>/lib/icon-index');
const index = buildIconIndex();                       // defaults to <skill>/.local-assets
const [best] = searchIcons(index, 'cosmos db');
// best.url  → https://app.diagrams.net/img/lib/azure2/databases/Azure_Cosmos_DB.svg
// best.file → absolute path to the SVG on disk
```

### Composing with other skills

This skill is standalone; anything that can run a CLI or `require()` a Node
module can use it. A deck builder typically calls `renderMermaid` /
`renderDrawio` and caches the PNG by `cacheKey()`.

As one concrete example, the [`microsoft-brand-guidelines`](https://github.com/ChibaYuki347/microsoft-brand-guidelines)
deck runner auto-detects these `content` fields on `layout: "image"` slides and
renders them through this skill into `<deckdir>/.diagram-cache/<sha1>.png`:

- `mermaid` — inline mermaid code as a string
- `mermaidFile` — path to a `.mmd` file
- `mermaidMd` + (`mermaidMdIndex` | `mermaidMdSection`) — pull a ```` ```mermaid ```` block out of a `.md` file by index or section heading
- `drawio` — inline drawio editable-SVG content as a string
- `drawioFile` — path to a `.drawio.svg` / `.svg` file
- `leftMermaid*` / `rightMermaid*` / `leftDrawio*` / `rightDrawio*` — same fields prefixed for the `image-2up` variant

That integration is optional and lives entirely in the calling skill — nothing
in this repository depends on it.

## Dependencies

- Node 18+
- `@mermaid-js/mermaid-cli` (Puppeteer-based; bundled Chromium download is ~150 MB unless `PUPPETEER_EXECUTABLE_PATH` reuses an existing Chromium)
- Optional CJK fonts at `~/.fonts/` for Japanese rendering (Noto Sans CJK JP)

## Known constraints

- Mermaid `themeVariables` cannot fully express Microsoft typography (font fallback is best-effort); PowerPoint will still render its own text labels in surrounding cells in the chosen brand font.
- PowerPoint embeds PNG well; SVG support varies by PowerPoint version — **prefer PNG** for `.pptx` targets.
- mmdc renders one diagram per invocation; for batch use, prefer the Node API to avoid per-call Chromium spin-up cost.
