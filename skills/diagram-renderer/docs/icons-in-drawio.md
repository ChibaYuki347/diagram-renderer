# Using Microsoft / GitHub product icons in draw.io diagrams

This skill lets you embed **Microsoft product icons** (Azure / M365 / Power
Platform / Entra ID) and **GitHub Octicons** in your `.drawio` diagrams,
then render them to PNG completely **offline** (no network at render time —
important on corporate networks with strict egress like Microsoft GSA).

This guide covers:

1. Where to get each icon set (with license caveats)
2. How to add icons to your drawio canvas
3. The two export modes (Embed Images ON vs OFF) and what each means
4. How to populate the local mirror this skill uses
5. Troubleshooting unresolved-icon errors

---

## TL;DR

```bash
# 1. Populate the icon cache (one-time setup; mostly manual for MS icons)
~/.copilot/skills/diagram-renderer/scripts/fetch-icons.sh

# 2. In drawio: build your diagram, drag icons from the side library
# 3. File → Save As → Editable SVG
#    - "Embed Images" ON  → SVG is self-contained, no local mirror needed at render
#    - "Embed Images" OFF → SVG references icons by URL, this skill inlines them from your local mirror

# 4. Render
node ~/.copilot/skills/diagram-renderer/bin/render-drawio.js my-arch.drawio.svg --out my-arch.png

# Or wire into a Microsoft-brand pptx deck via slides.json:
#   { "layout": "image", "variant": "image-full",
#     "content": { "title": "Arch", "drawioFile": "diagrams/my-arch.drawio.svg" } }
```

---

## 1. Where to get each icon set

> The skill ships **no icon assets** in the repo. Each user downloads them
> under the appropriate license terms. See
> [`assets/icons/LICENSE.md`](../assets/icons/LICENSE.md) for the
> full posture per set.

### GitHub Octicons — auto-fetched
- **License**: MIT (Primer / GitHub)
- **Source**: https://github.com/primer/octicons (`@primer/octicons` on npm)
- **Acquisition**: `scripts/fetch-icons.sh github` — runs `npm install --no-save @primer/octicons` and copies SVGs into `.local-assets/github/octicons/`. No interactive prompt.

### Microsoft Azure architecture icons — manual download
- **License**: Microsoft proprietary; OK to use in architectural diagrams that
  describe Microsoft products/services. Modification & redistribution are NOT
  permitted.
- **Source**: https://learn.microsoft.com/en-us/azure/architecture/icons/ →
  "Download SVG icons" link on that page (currently
  `https://arch-center.azureedge.net/icons/Azure_Public_Service_Icons_V23.zip`).
- **Pack structure (V23, Nov 2025)**:
  - ZIP root: `Azure_Public_Service_Icons/Icons/<category>/<id>-icon-service-<Name>.svg`
  - 705 SVGs across 29 categories (analytics, compute, networking, identity, …)
  - Category names use spaces and `+` (e.g. `ai + machine learning`).
  - `fetch-icons.sh azure` normalizes both:
    - category: `ai + machine learning` → `ai_machine_learning` (matches drawio's azure2 layout)
    - filename: `00028-icon-service-Batch-AI.svg` → `Batch_AI.svg`
  - **Both the original AND normalized names are written** to `.local-assets/azure/`
    so drawio's URL refs (`/img/lib/azure2/<cat>/<Name>.svg`) and hand-coded refs
    (full MS filename) both resolve.
- **Acquisition**:
  ```bash
  scripts/fetch-icons.sh azure
  # → prints the URL + terms, waits for your "I agree"
  # → asks you to drop the ZIP into .local-assets/_inbox/
  # → extracts SVGs into .local-assets/azure/ (drawio-conformant layout)
  ```
- **Verified working** with drawio URLs like:
  - `https://www.draw.io/img/lib/azure2/identity/Users.svg`
  - `https://www.draw.io/img/lib/azure2/networking/Application_Gateways.svg`
  - `https://www.draw.io/img/lib/azure2/databases/Azure_SQL.svg`

### Microsoft 365 / Office 365 icons — superseded
- **Status**: As of late 2025, Microsoft no longer publishes a standalone M365
  architecture icons ZIP. The previous M365 stencils page redirects users to
  the Azure architecture icons pack, which now includes M365 service icons under
  `intune/`, `security/`, etc.
- **Acquisition**: just run `fetch-icons.sh azure` — M365 stencils are covered.
- For Office product-family icons (Word / Excel / PowerPoint UI iconography),
  use Microsoft Fluent UI icons — different licensing posture, not in scope here.

### Microsoft Power Platform icons — manual download
- **License**: Same posture as Azure icons (see `CELA_Licenses_Public_Use_Icons.pdf`
  inside the pack).
- **Source**: https://learn.microsoft.com/en-us/power-platform/guidance/icons → ZIP
  (currently `https://download.microsoft.com/download/498606aa-6d27-4f13-aa5c-1401078c153b/Power-Platform-icons-scalable.zip`).
- **Pack structure (Feb 2026)**:
  - 8 SVGs: Agent365 / CopilotStudio at root + AIBuilder / Dataverse / PowerApps /
    PowerAutomate / PowerPages / PowerPlatform inside `Power Platform/`.
  - Filenames use `_scalable` suffix.
  - `fetch-icons.sh power-platform` flattens into `.local-assets/power-platform/`
    and strips `_scalable` for the canonical name (also preserves the original).
- **Drawio URL convention**: `https://aka.ms/power-platform-icons/<Name>.svg`
  (e.g. `.../PowerApps.svg`, `.../CopilotStudio.svg`). This is NOT a real network
  endpoint — it's a stable identifier the resolver maps to your local mirror.

### Microsoft Entra ID icons — manual download
- **License**: Same as Azure icons (see Branding Playbook for usage guidance).
- **Source**: https://learn.microsoft.com/en-us/entra/architecture/architecture-icons →
  ZIP (Oct 2023, ~7.5 MB).
- **Pack structure**:
  - Two flavors: `Microsoft Entra BW icons SVG/` and `Microsoft Entra color icons SVG/`.
  - 16 SVGs total covering the Entra product family: ID, ID Governance, Internet
    Access, Private Access, Verified ID, Workload ID, plus the umbrella icon.
  - `fetch-icons.sh entra` splits into `.local-assets/entra/bw/` and `.../color/`
    with normalized names (e.g. `ID.svg`, `ID_Governance.svg`) + originals preserved.
- **Drawio URL convention**:
  - `https://aka.ms/entra-icons/color/ID.svg`
  - `https://aka.ms/entra-icons/bw/ID_Governance.svg`
  Also NOT real endpoints — stable identifiers that the resolver maps locally.

---

## 2. Adding icons to your drawio canvas

You have three options:

### (a) Use drawio's built-in vector stencils (recommended for Azure)
draw.io desktop and app.diagrams.net ship with vector Azure stencils
(`mxgraph.azure.*`, `mxgraph.az19.*`, `mxgraph.az21.*`). These are pure
`<path>` shapes — they have **no external URL dependency** and render fine
without any local mirror. Search "Azure" in the shape panel.

⚠️ Some shape libraries (notably **mscae**, the legacy "Microsoft Cloud and
Enterprise" set) use bitmap/SVG `<image>` references that get serialized as
external URLs in the exported SVG. The next two options apply there.

### (b) Import an Icon library locally (recommended for M365 / Octicons)
1. In drawio: **Extras → Edit Library** (or **Open Library** if you have a
   `.drawioLibrary` file)
2. Click the **+** button → **Add image from folder** or **From URL**
3. Point at a folder of SVGs (e.g. `~/.copilot/skills/diagram-renderer/.local-assets/azure/`)
4. drawio bakes those icons into a library you can dock to the side panel
5. Drag icons onto your canvas

This is the cleanest workflow: the SVGs already live locally, drawio
references them as either `file://` or as the canonical CDN URL depending on
where you imported from. Either way the **auto-inline pass in this skill
catches them at render time**.

### (c) Drag from drawio's online shape libraries
If you enable "Microsoft Azure" / "AWS" / etc. from **More Shapes**, drawio
may insert `<image href="https://app.diagrams.net/img/lib/...">` references
into the exported SVG. These will be caught and inlined by this skill IF the
filename in the URL matches one in your local mirror.

---

## 3. Export: Embed Images ON vs OFF

When you save your diagram as an `.drawio.svg`, you'll see a checkbox in the
export dialog called **"Embed Images"** (or similar).

| Option | What the SVG contains | When the local mirror matters |
|---|---|---|
| **ON (recommended)** | All images baked in as `data:image/svg+xml;base64,...` URIs | Never — SVG is fully self-contained. Render works on any machine. |
| **OFF** | External `<image xlink:href="https://...">` references | At **render time** — this skill resolves each URL against the local mirror. |

**Why support both?**
- ON is the simplest model for users new to the workflow.
- OFF keeps the `.drawio.svg` small and edit-friendly (you can swap icons by
  updating the mirror), and is the default in some drawio versions.

Either way, **this skill's renderer produces identical output** — that's
verified by the Phase 4 demo (P4-8).

---

## 4. Populating the local mirror

```bash
# Run interactive (asks per set)
~/.copilot/skills/diagram-renderer/scripts/fetch-icons.sh

# Or fetch specific sets
~/.copilot/skills/diagram-renderer/scripts/fetch-icons.sh github azure entra

# Bypass interactive license prompt if you've already read LICENSE.md
READ_AND_AGREE=1 ~/.copilot/skills/diagram-renderer/scripts/fetch-icons.sh
```

After running, your mirror lives at `~/.copilot/skills/diagram-renderer/.local-assets/`:

```
.local-assets/
├── github/
│   ├── LICENSE         # MIT
│   └── octicons/       # 700+ SVGs (alert-16.svg, repo-24.svg, ...)
├── azure/              # populated from the Azure pack you dropped in _inbox/
│   ├── compute/
│   ├── networking/
│   ├── identity/
│   ├── power_platform/
│   └── ...
├── m365/
├── power-platform/
├── entra/
└── _inbox/             # scratch dir for unzipping; safe to clean
```

> ⚠️ `.local-assets/` is **gitignored**. It's a user cache, not a committed
> asset. Each user populates it themselves under the relevant terms.

---

## 5. Troubleshooting

### Error: `drawio render failed: N external image reference(s) could not be resolved offline`

The renderer is doing exactly what it should: it found `<image>` URLs in the
SVG, looked them up against your local mirror, and couldn't find a file.

Fix options (in recommended order):

#### (a) Re-export with "Embed Images" ON
The simplest fix. Open the diagram in drawio, **File → Save As → Editable
SVG**, check "Embed Images", overwrite the file. Now the SVG is
self-contained.

#### (b) Add the missing icon to your local mirror
If the error lists e.g.
`https://app.diagrams.net/img/lib/azure2/compute/App_Services.svg`,
then either:
- Ensure your `.local-assets/azure/compute/App_Services.svg` exists (rerun
  `fetch-icons.sh azure` if needed and inspect the pack layout), or
- Add an explicit alias in `assets/icons/aliases.json`:
  ```json
  {
    "https://app.diagrams.net/img/lib/azure2/compute/App_Services.svg": "azure/SVG_Icons/Compute/10035-icon-service-App-Services.svg"
  }
  ```
  (Path is relative to your `assetRoot`, i.e. `.local-assets/` by default.)

#### (c) Dump a structured missing-externals report
If you have many missing URLs, add `--report-missing missing.json` (CLI) or
`deck.drawio.reportMissing: "missing.json"` (slides.json) to dump them as
JSON. Use that to bulk-author alias entries:

```bash
node ~/.copilot/skills/diagram-renderer/bin/render-drawio.js my.drawio.svg \
  --out my.png --report-missing missing.json
cat missing.json | jq .  # inspect, then write aliases.json
```

#### (d) Last resort: `--allow-network`
If you're not on a restricted network and just want to ship the diagram,
`--allow-network` (CLI) or `deck.drawio.allowNetwork: true` (slides.json)
bypasses the offline guard and lets Chromium fetch URLs directly.

⚠️ Not recommended on corporate networks with egress proxies (e.g. Microsoft
GSA) where fetches can intermittently fail and cause inconsistent renders.

---

## Bonus: rule-based vs alias-based resolution

The resolver tries each `resolver-rules.json` entry in order, falling back to
`aliases.json` for exact-URL overrides. The rules cover broad URL patterns
(e.g. "anything under `/img/lib/azure2/` maps to `azure/`"), while aliases
handle one-off mismatches when your local mirror has a different filename or
folder structure than the URL implies.

A rule entry looks like:
```json
{
  "name": "drawio-azure2",
  "match": { "pathSuffix": "/img/lib/azure2/" },
  "localBase": "azure/"
}
```

URL `https://app.diagrams.net/img/lib/azure2/compute/App_Services.svg`
→ tail = `compute/App_Services.svg`
→ local candidate = `<assetRoot>/azure/compute/App_Services.svg`

If that file doesn't exist, the resolver also tries a **case-insensitive
basename match** in the same directory (covers `App_Services.svg` vs
`app_services.svg`). If both fail, the URL surfaces as an unresolved entry.
