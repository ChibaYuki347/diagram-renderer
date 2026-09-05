---
name: diagram-renderer
description: Render Mermaid (and later draw.io) diagrams to PNG/SVG so other Skills (especially the `pptx` skill + `microsoft-brand-guidelines` tokens) can embed them as static images. Provides a Microsoft-branded mermaid theme (light/dark) and a CLI + Node API. Use when a deck-/doc-generation workflow needs to materialize architecture diagrams, decision trees, or flow charts from markdown / source files.
---

# diagram-renderer

**Scope**: convert diagram source → static raster/vector image. This skill **does not** generate slides or documents itself — it produces PNG/SVG that other skills (e.g. Anthropic `pptx`, `docx`, `microsoft-brand-guidelines` PPT layouts) embed.

## 🧭 New session? Start here (30 seconds)

This skill ships as one of two plugins in the
[`chibayuki-private-marketplace`](https://github.com/ChibaYuki347/chibayuki-private-marketplace)
private catalog (paired with `microsoft-brand-guidelines`). Before composing
deck-with-diagram workflows, confirm the install is wired correctly:

```bash
bash ~/dev/chibayuki-private-marketplace/bootstrap.sh --health
```

If you see `✅ All checks passed`, the brand bridge will auto-discover this
renderer at build time (no env vars needed). For canonical paths,
capability-discovery flow, the 4 custom agents, end-to-end workflow, and
troubleshooting matrix, read
**[`chibayuki-private-marketplace/INTEGRATION.md`](https://github.com/ChibaYuki347/chibayuki-private-marketplace/blob/main/INTEGRATION.md)**.

For drawio Microsoft / Entra / Azure icon resolution, see
[`docs/icons-in-drawio.md`](docs/icons-in-drawio.md) and run
`bash scripts/fetch-icons.sh github|azure|entra|power-platform` to populate the
local mirror at `~/.copilot/skills/diagram-renderer/.local-assets/`.

## Capabilities

| Phase | Source | Status |
|---|---|---|
| 1 | Mermaid (inline string) → PNG/SVG | ✅ MVP |
| 1 | Mermaid (`.mmd` file) → PNG/SVG | ✅ MVP |
| 2 | Mermaid blocks inside `.md` → extracted `.mmd` files + manifest (optional render) | ✅ |
| 3 | draw.io editable SVG (`.drawio.svg` / `.svg`) → PNG | ✅ |
| 3 | draw.io raw XML (`.drawio`) → PNG | ❌ Not supported (export as Editable SVG first) |
| 4 | draw.io with Microsoft / GitHub product icons — offline inline of external `<image>` refs | ✅ ([details](docs/icons-in-drawio.md)) |
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
- `assets/icons/resolver-rules.json` — committed rule definitions (URL pattern → local subtree)
- `assets/icons/aliases.json` — committed exact-URL overrides for edge cases
- `assets/icons/LICENSE.md` — licensing posture per icon set

## Brand themes

`themes/microsoft-light.json` and `themes/microsoft-dark.json` express the Microsoft brand palette as a mermaid `themeVariables` block — derived from `microsoft-brand-guidelines/tokens/{light,dark}.json` (Pure White / Blue Black bases).

To use a different theme: pass any [mermaid themeVariables](https://mermaid.js.org/config/theming.html) JSON file to `--theme-file`.

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
const { renderMermaid } = require('~/.copilot/skills/diagram-renderer/lib/render');

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
} = require('~/.copilot/skills/diagram-renderer/lib/extract');

const md = readMarkdownFile('docs/architecture.md');
const blocks = extractMermaidBlocks(md);
const block = pickBlock(blocks, { section: 'Pattern B' }); // or { index: 0 }
// block.code → string ready for renderMermaid()

// Render a drawio editable SVG to PNG (Phase 3)
const { renderDrawio } = require('~/.copilot/skills/diagram-renderer/lib/render-drawio');
const { path: pngPath, width, height } = await renderDrawio({
  file: 'diagrams/arch.drawio.svg',
  out: '/tmp/arch.png',
  cssWidth: 1100,
});
```

### Integration with `microsoft-brand-guidelines`

The brand skill's `deck-from-json.js` runner auto-detects these `content` fields on `layout: "image"` slides and renders them via this skill into `<deckdir>/.diagram-cache/<sha1>.png`:

- `mermaid` — inline mermaid code as a string
- `mermaidFile` — path to a `.mmd` file
- `mermaidMd` + (`mermaidMdIndex` | `mermaidMdSection`) — pull a ```` ```mermaid ```` block out of a `.md` file by index or section heading
- `drawio` — inline drawio editable-SVG content as a string
- `drawioFile` — path to a `.drawio.svg` / `.svg` file
- `leftMermaid*` / `rightMermaid*` / `leftDrawio*` / `rightDrawio*` — same fields prefixed for the `image-2up` variant

See `examples/slide-recipes.md` in that skill for full examples.

## Dependencies

- Node 18+
- `@mermaid-js/mermaid-cli` (Puppeteer-based; bundled Chromium download is ~150 MB unless `PUPPETEER_EXECUTABLE_PATH` reuses an existing Chromium)
- Optional CJK fonts at `~/.fonts/` for Japanese rendering (Noto Sans CJK JP)

## Known constraints

- Mermaid `themeVariables` cannot fully express Microsoft typography (font fallback is best-effort); PowerPoint will still render its own text labels in surrounding cells in the chosen brand font.
- PowerPoint embeds PNG well; SVG support varies by PowerPoint version — **prefer PNG** for `.pptx` targets.
- mmdc renders one diagram per invocation; for batch use, prefer the Node API to avoid per-call Chromium spin-up cost.
