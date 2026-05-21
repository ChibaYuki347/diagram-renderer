# draw.io exported SVG — image reference patterns

This document records how draw.io serializes embedded raster/SVG icons into its
"Editable SVG" exports. It is the basis for the auto-inline resolver in
`lib/inline-external-images.js` (Phase 4.2).

## TL;DR

When a user drags an icon from draw.io's image library (`mscae`, `azure2`,
`active_directory`, `dynamics365` etc.) and exports the diagram as Editable SVG:

| Toggle: "Embed Images" | Resulting `xlink:href` value |
|---|---|
| **ON** (recommended) | `data:image/svg+xml;base64,...` (or `data:image/png;base64,...` for raster) |
| **OFF** | An absolute URL pointing at the **host the diagram was edited on**, with the **stable suffix** `img/lib/<library>/<path>` |

**Stable invariant**: the host part (`app.diagrams.net`, `embed.diagrams.net`,
`www.draw.io`, self-hosted Confluence/JIRA plugins, etc.) varies, but the path
**after** the host always follows `/img/lib/<library>/<...>` for built-in
libraries.

→ Our resolver matches on **path suffix**, not full URL.

## Source-code evidence

From `jgraph/drawio` (verified via `gh search code` 2026-05-21):

### Sidebar declarations use relative paths

```js
// src/main/webapp/js/diagramly/sidebar/Sidebar-MSCAE.js
var s = 'image;sketch=0;aspect=fixed;html=1;points=[];align=center;fontSize=12;image=img/lib/mscae/';
```

All image-based shape libraries follow the pattern `image=img/lib/<library>/`.

### `convertImages` rewrites at export time

```js
// src/main/webapp/js/diagramly/Editor.js — Editor.prototype.convertImages
convertImages('image', 'xlink:href');
convertImages('img',    'src');
```

For each `<image>` element it calls `converter.convert(src)`, which uses
`mxUrlConverter.updateBaseUrl()` — i.e. resolves the relative path against the
current page's base URL.

### "Embed Images" controls the data-URI substitution

```js
// Editor.prototype.convertImageToDataUri
// → fetches the URL and replaces with data:image/svg+xml;base64,...
```

When the toggle is OFF, drawio still resolves the path to an absolute URL but
**does not** fetch + inline. The result is what we have to deal with downstream.

## Observed library directories

From `repos/jgraph/drawio/contents/src/main/webapp/img/lib`:

| Dir | Contents | Maps to our scope |
|---|---|---|
| `mscae/` | Microsoft Cloud & Enterprise — mixed Office 365, Intune, OMS, System Center, Azure (legacy flat icons), Companies, Service-by-category | **M365** (and partial Azure-legacy) |
| `azure2/` | Modern Azure architecture icons, organized by category (`compute/`, `networking/`, `identity/`, `storage/`, `power_platform/`, …) | **Azure** + **Power Platform** + partial **Entra** (via `identity/`) |
| `active_directory/` | Legacy AD icons (servers, clusters, domains) | **Entra** (legacy) |
| `dynamics365/` | Dynamics 365 product icons | (out of scope this phase) |
| `allied_telesis/`, `atlassian/`, `cumulus/`, `ibm/`, `sap/` | Third-party | (out of scope) |

GitHub icons are **not** in drawio's built-in libraries. Users either:
- import Octicons SVGs as custom shapes, OR
- use the GitHub library shipped via this skill's drawio library packaging (Phase 4.7, experimental)

## URL patterns to expect

Concretely, when a user exports with Embed Images OFF on `app.diagrams.net`:

```xml
<image x="100" y="100" width="48" height="48"
       xlink:href="https://app.diagrams.net/img/lib/mscae/App_Services.svg"/>

<image x="200" y="100" width="48" height="48"
       xlink:href="https://app.diagrams.net/img/lib/azure2/compute/App_Services.svg"/>

<image x="300" y="100" width="48" height="48"
       xlink:href="https://app.diagrams.net/img/lib/active_directory/active_directory.svg"/>
```

On other deployments the host changes but the path is invariant:

| Host | Notes |
|---|---|
| `https://app.diagrams.net/` | The canonical public app |
| `https://embed.diagrams.net/` | Embed mode (Confluence/Jira/Notion etc.) |
| `https://www.draw.io/` | Legacy domain, still alive |
| `https://viewer.diagrams.net/` | Read-only viewer |
| Self-hosted | Any custom domain (corp drawio instance) |

## Resolver rule shape (informs Phase 4.2)

```jsonc
// assets/icons/resolver-rules.json
[
  {
    "name": "drawio-mscae",
    "match": { "pathSuffix": "/img/lib/mscae/" },
    "localBase": ".local-assets/m365/mscae/",
    "scope": ["m365"]
  },
  {
    "name": "drawio-azure2",
    "match": { "pathSuffix": "/img/lib/azure2/" },
    "localBase": ".local-assets/azure/azure2/",
    "scope": ["azure", "power-platform", "entra"]
  },
  {
    "name": "drawio-active-directory",
    "match": { "pathSuffix": "/img/lib/active_directory/" },
    "localBase": ".local-assets/entra/active_directory/",
    "scope": ["entra"]
  }
]
```

Resolver algorithm:
1. Take the original URL, strip query + hash, percent-decode.
2. Lowercase host (not path — path is case-sensitive on most file systems).
3. For each rule, check if URL contains `match.pathSuffix`. If yes:
   - extract the part **after** the suffix
   - resolve `localBase + tail` to a file on disk
   - if exists, read + base64-encode, return data URI
4. If no rule matches, try `aliases.json` for hand-curated overrides.
5. Otherwise: collect into `unresolved[]` and let the caller decide (throw vs warn).

## Edge cases noted (handle in scanner)

- `<image>` may use `href` (SVG2) **or** `xlink:href` (SVG1.1) — scanner must read both.
- Attribute may use single or double quotes.
- Path may be percent-encoded (`%20` for spaces).
- Some library entries are PNG, not SVG (e.g. `mscae/Companies/...png`) — match by extension to pick correct MIME.
- `<img>` (HTML) appears only inside `<foreignObject>` — rare, but the same logic applies.
- `data:` URIs are pass-through (already inlined, skip).

## Hybrid discovery plan (per user choice 2026-05-21)

- **Now (Phase 4.2-4.6)**: implement scanner + resolver against the synthesized
  URL patterns documented above.
- **Later (Phase 4.8)**: user provides 1-2 real drawio exports (Embed ON + OFF
  pair). We diff against expectations and tighten rules if needed.
