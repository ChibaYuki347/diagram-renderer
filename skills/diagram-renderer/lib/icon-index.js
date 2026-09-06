// icon-index.js — Build a searchable catalog of the locally mirrored icon SVGs.
//
// This is the logical inverse of `inline-external-images.js`:
//   inline-external-images : URL  → local file   (render time)
//   icon-index             : name → local file + canonical URL   (authoring time)
//
// Public API:
//   buildIconIndex({ assetRoot, rules? })  → { assetRoot, entries, sets, warnings }
//   searchIcons(index, query, opts?)       → [{ ...entry, score }]
//   getIcon(index, id)                     → entry | null
//   defaultAssetRoot()                     → absolute path to <skill>/.local-assets
//
// Why this exists
// ---------------
// Authoring an icon-rich diagram previously required *guessing* the exact icon
// filename (e.g. `Azure_Cosmos_DB.svg` vs `Cosmos_DB.svg` vs
// `00147-icon-service-Azure-Cosmos-DB.svg`). A wrong guess only surfaces at
// render time as an unresolved-external error. This module lets an author (or
// an agent) search the mirror that is actually installed and get back the
// canonical URL to paste into a `.drawio.svg`.
//
// Design notes
// ------------
// - The mirror layout is `<set>/<group...>/<Name>.svg`, where `<set>` is the
//   first path segment (azure, entra, power-platform, github, dynamics365, ...).
//   Nothing here is hardcoded to a specific vendor: sets are discovered by
//   scanning, and the URL mapping is derived from `resolver-rules.json`.
// - `scripts/fetch-icons.sh` deliberately writes BOTH a normalized filename and
//   the pack's original filename for provenance. Those are the same logical
//   icon, so we fold them into one entry with `variants[]` rather than
//   returning near-duplicate search hits.
// - A missing/absent asset root is NOT an error. `.local-assets/` is
//   gitignored and absent on a fresh install, so we return an empty index plus
//   a warning and let the caller decide.

'use strict';

const fs = require('fs');
const path = require('path');

const SKILL_ROOT = path.resolve(__dirname, '..');

/** Absolute path to the conventional local icon mirror. */
function defaultAssetRoot() {
  return path.join(SKILL_ROOT, '.local-assets');
}

/** Absolute path to the committed resolver rules. */
function defaultRulesFile() {
  return path.join(SKILL_ROOT, 'assets', 'icons', 'resolver-rules.json');
}

// Filenames that icon packs ship alongside a normalized copy. Each pattern that
// applies is stripped; the file needing the FEWEST strips is treated as the
// canonical one for its group. Additive by design — an unrecognised pack simply
// gets one entry per file, which is still correct, just not deduplicated.
const VARIANT_STRIPPERS = [
  // Azure pack: "00147-icon-service-Azure-Cosmos-DB" → "Azure-Cosmos-DB"
  /^\d+-icon-service-/i,
  // Power Platform pack: "PowerApps_scalable" → "PowerApps"
  /[ _-]?scalable$/i,
  // Entra pack: "Microsoft Entra ID color icon" → "ID color icon"
  /^Microsoft[ _-]+Entra[ _-]+/i,
  // Entra pack flavor suffixes: "ID color icon" → "ID"
  /[ _-]+(?:filled[ _-]+)?(?:BW|color)[ _-]+icon$/i,
  // Entra pack: "Verified ID (product family)" → "Verified ID"
  /[ _-]*\(?product[ _-]+family\)?$/i,
];

// Directory / file names that are never icons.
const SKIP_DIRS = new Set(['_inbox', 'node_modules', '.git']);
const ICON_EXTENSIONS = new Set(['.svg', '.png']);

/**
 * Strip pack-specific decoration from a base filename (no extension).
 * Returns { stem, strips } where `strips` counts how many patterns applied —
 * used to decide which physical file is the canonical one for a group.
 */
function stripVariantDecoration(stem) {
  let out = stem;
  let strips = 0;
  // Patterns can expose each other (prefix strip reveals a suffix), so loop
  // until the string stabilises.
  for (let pass = 0; pass < VARIANT_STRIPPERS.length; pass++) {
    let changedThisPass = false;
    for (const re of VARIANT_STRIPPERS) {
      const next = out.replace(re, '');
      if (next !== out && next.trim() !== '') {
        out = next.trim();
        strips++;
        changedThisPass = true;
      }
    }
    if (!changedThisPass) break;
  }
  return { stem: out, strips };
}

/** Lowercase, separator-normalized identifier used for grouping and matching. */
function slugify(s) {
  return String(s)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2') // PowerApps → Power_Apps
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** Human-readable display name derived from the canonical filename stem. */
function humanize(stem) {
  return stem
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Tokens used for search matching. */
function tokenize(s) {
  return slugify(s).split('_').filter(Boolean);
}

function walkFiles(dir, baseDir, out) {
  let dirents;
  try {
    dirents = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return;
  }
  for (const d of dirents) {
    if (d.name.startsWith('.')) continue;
    const abs = path.join(dir, d.name);
    if (d.isDirectory()) {
      if (SKIP_DIRS.has(d.name)) continue;
      walkFiles(abs, baseDir, out);
    } else if (d.isFile()) {
      if (!ICON_EXTENSIONS.has(path.extname(d.name).toLowerCase())) continue;
      out.push(path.relative(baseDir, abs));
    }
  }
}

/**
 * Build a reverse map: local subtree → canonical URL prefix.
 * Derived from resolver-rules.json so that the render-time rules and the
 * authoring-time catalog can never drift apart. A rule participates only if it
 * declares `canonicalUrl`.
 */
function buildUrlMappers(rules) {
  return rules
    .filter((r) => r && r.canonicalUrl && typeof r.localBase === 'string')
    .map((r) => ({
      name: r.name,
      // normalize to posix-style with a single trailing slash
      localBase: r.localBase.replace(/\\/g, '/').replace(/\/*$/, '/'),
      canonicalUrl: r.canonicalUrl.replace(/\/*$/, '/'),
    }))
    // longest localBase first so `entra/active_directory/` beats `entra/`
    .sort((a, b) => b.localBase.length - a.localBase.length);
}

function canonicalUrlFor(mappers, relPosix) {
  for (const m of mappers) {
    if (m.localBase === '/' || relPosix.startsWith(m.localBase)) {
      const tail = m.localBase === '/' ? relPosix : relPosix.slice(m.localBase.length);
      return m.canonicalUrl + tail.split('/').map(encodeURIComponent).join('/');
    }
  }
  return null;
}

/**
 * Scan the local icon mirror into a searchable catalog.
 *
 * @param {Object}   [opts]
 * @param {string}   [opts.assetRoot]  Mirror root (default: <skill>/.local-assets)
 * @param {Array}    [opts.rules]      Resolver rules (default: loaded from assets/icons/resolver-rules.json)
 * @returns {{assetRoot: string, entries: Array, sets: Array, warnings: Array<string>}}
 */
function buildIconIndex(opts = {}) {
  const assetRoot = path.resolve(opts.assetRoot || defaultAssetRoot());
  const warnings = [];

  let rules = opts.rules;
  if (!rules) {
    const rulesFile = defaultRulesFile();
    try {
      rules = JSON.parse(fs.readFileSync(rulesFile, 'utf8'));
    } catch (e) {
      rules = [];
      warnings.push(`could not read resolver rules (${rulesFile}): ${e.message}`);
    }
  }
  const mappers = buildUrlMappers(rules);

  if (!fs.existsSync(assetRoot)) {
    warnings.push(
      `icon mirror not found at ${assetRoot} — run scripts/fetch-icons.sh to populate it`
    );
    return { assetRoot, entries: [], sets: [], warnings };
  }

  const relPaths = [];
  walkFiles(assetRoot, assetRoot, relPaths);

  // Group physical files that represent the same logical icon.
  const groups = new Map();
  for (const rel of relPaths) {
    const relPosix = rel.split(path.sep).join('/');
    const segments = relPosix.split('/');
    const filename = segments.pop();
    const set = segments.length ? segments[0] : '';
    const group = segments.slice(1).join('/');

    const ext = path.extname(filename);
    const rawStem = filename.slice(0, filename.length - ext.length);
    const { stem, strips } = stripVariantDecoration(rawStem);
    const slug = slugify(stem);
    if (!slug) continue;

    const key = `${set}/${group}/${slug}`;
    const candidate = { relPosix, filename, rawStem, stem, strips, set, group, slug, ext };
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { primary: candidate, variants: [] });
      continue;
    }
    // Canonical = fewest strips, then shortest filename (stable tiebreak).
    const better =
      candidate.strips < existing.primary.strips ||
      (candidate.strips === existing.primary.strips &&
        candidate.filename.length < existing.primary.filename.length);
    if (better) {
      existing.variants.push(existing.primary);
      existing.primary = candidate;
    } else {
      existing.variants.push(candidate);
    }
  }

  const entries = [];
  for (const [, g] of groups) {
    const p = g.primary;
    const id = [p.set, p.group, p.slug].filter(Boolean).join('/');
    const name = humanize(p.stem);
    const entry = {
      id,
      set: p.set,
      group: p.group,
      name,
      slug: p.slug,
      relPath: p.relPosix,
      file: path.join(assetRoot, ...p.relPosix.split('/')),
      url: canonicalUrlFor(mappers, p.relPosix),
      variants: g.variants.map((v) => v.relPosix).sort(),
    };
    // Precomputed matching material (non-enumerable so JSON output stays clean).
    const tokens = tokenize(name);
    Object.defineProperty(entry, '_tokens', { value: tokens, enumerable: false });
    Object.defineProperty(entry, '_haystack', {
      value: [id, name, p.set, p.group, p.slug].join(' ').toLowerCase(),
      enumerable: false,
    });
    entries.push(entry);
  }

  entries.sort((a, b) => a.id.localeCompare(b.id));

  const setCounts = new Map();
  for (const e of entries) setCounts.set(e.set, (setCounts.get(e.set) || 0) + 1);
  const sets = [...setCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (entries.length === 0) {
    warnings.push(`icon mirror at ${assetRoot} contains no icons — run scripts/fetch-icons.sh`);
  }
  for (const e of entries) {
    if (!e.url) {
      warnings.push(
        `no canonical URL for set '${e.set}' — add a "canonicalUrl" to the matching rule in resolver-rules.json`
      );
      break; // one warning per build is enough
    }
  }

  return { assetRoot, entries, sets, warnings };
}

/**
 * Score one entry against a tokenized query. 0 means "no match".
 * Ordering intent: exact identifier > exact name > full token coverage >
 * partial coverage, with shorter names winning ties.
 */
function scoreEntry(entry, tokens, q) {
  if (!tokens.length) return 0;

  const qSlug = slugify(q);
  if (entry.slug === qSlug || entry.id === q) return 1000;
  if (entry.name.toLowerCase() === q) return 950;
  if (entry.id.endsWith(`/${qSlug}`)) return 900;

  const nameTokens = entry._tokens;
  let matched = 0;
  let exact = 0;
  let prefix = 0;
  for (const t of tokens) {
    if (nameTokens.includes(t)) { matched++; exact++; continue; }
    if (nameTokens.some((nt) => nt.startsWith(t))) { matched++; prefix++; continue; }
    if (entry._haystack.includes(t)) { matched++; }
  }
  if (matched === 0) return 0;

  const coverage = matched / tokens.length;
  let score = Math.round(coverage * 500) + exact * 60 + prefix * 30;
  if (coverage === 1) score += 100;
  // Prefer concise names: "Cosmos DB" over "Cosmos DB Migration Service".
  score -= Math.min(40, nameTokens.length * 4);
  return Math.max(score, 1);
}

/**
 * Search the catalog.
 *
 * @param {Object} index            Result of buildIconIndex()
 * @param {string} query            Free-text query, e.g. "cosmos db"
 * @param {Object} [opts]
 * @param {string} [opts.set]       Restrict to one set (azure, entra, github, ...)
 * @param {number} [opts.limit=10]  Max results (0 = unlimited)
 * @param {number} [opts.minScore=1]
 * @returns {Array} entries with an added `score`, best first
 */
function searchIcons(index, query, opts = {}) {
  const { set, limit = 10, minScore = 1 } = opts;
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const tokens = tokenize(q);

  const hits = [];
  for (const entry of index.entries) {
    if (set && entry.set !== set) continue;
    const score = scoreEntry(entry, tokens, q);
    if (score >= minScore) hits.push(Object.assign({ score }, entry));
  }

  hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return limit > 0 ? hits.slice(0, limit) : hits;
}

/** Exact lookup by catalog id (e.g. "azure/databases/azure_cosmos_db"). */
function getIcon(index, id) {
  if (!id) return null;
  const want = String(id).trim().toLowerCase();
  return index.entries.find((e) => e.id === want) || null;
}

module.exports = {
  buildIconIndex,
  searchIcons,
  getIcon,
  defaultAssetRoot,
  defaultRulesFile,
  // exposed for unit tests
  _internals: { slugify, humanize, tokenize, stripVariantDecoration, scoreEntry, buildUrlMappers, canonicalUrlFor },
};
