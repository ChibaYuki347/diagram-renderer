// inline-external-images.js — Find external <image>/<img> references in an SVG
// and replace them with data: URIs sourced from local files.
//
// Public API:
//   inlineExternalImages({ svg, resolve, missingPolicy? }) →
//     { svg, resolved:[{url, localPath, mime, bytes}], unresolved:[{url, reason}] }
//
//   createResolver({ rules, aliases, assetRoot }) → fn(url) → resolve result
//
// Design notes:
// - Uses fast-xml-parser in preserveOrder mode so we can walk + mutate the tree
//   without losing attribute ordering or comments.
// - Reads BOTH `xlink:href` (SVG 1.1) and `href` (SVG 2). drawio uses xlink:href
//   in its exports, but we support `href` too because some pipelines (and SVG2
//   conformance) emit it.
// - `data:` URIs are pass-through (already inlined).
// - Returns unresolved entries instead of throwing — the caller (render-drawio.js
//   bridge or CLI) decides whether to fail-fast, warn-and-skip, or fall back to
//   network fetch.

'use strict';

const fs = require('fs');
const path = require('path');
const { XMLParser, XMLBuilder } = require('fast-xml-parser');

const XML_OPTS = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  preserveOrder: true,
  parseTagValue: false,
  parseAttributeValue: false,
  allowBooleanAttributes: true,
  suppressEmptyNode: false,
  trimValues: false,
};

const MIME_BY_EXT = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

function mimeFor(p) {
  const ext = path.extname(p).toLowerCase();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    u.search = '';
    u.hostname = u.hostname.toLowerCase();
    return {
      href: u.toString(),
      pathname: decodeURIComponent(u.pathname),
      host: u.host,
    };
  } catch (_) {
    // Not an absolute URL (relative path or malformed). Caller skips these.
    return null;
  }
}

function fileToDataUri(absPath) {
  const buf = fs.readFileSync(absPath);
  const mime = mimeFor(absPath);
  // SVG: keep base64 even for small files for simplicity (avoids URI-encoding edge cases).
  return { dataUri: `data:${mime};base64,${buf.toString('base64')}`, mime, bytes: buf.length };
}

// True only when `p` is `root` itself or genuinely nested under it.
// A bare `p.startsWith(root)` would also accept a sibling like `<root>-evil`.
function isInside(root, p) {
  return p === root || p.startsWith(root + path.sep);
}

// Build (once per directory, per resolver) a lowercased basename → absolute path
// map for every file under `dir`. Used by rules that opt into `searchRecursive`.
function buildBasenameIndex(dir) {
  const index = new Map();
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let dirents;
    try {
      dirents = fs.readdirSync(cur, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const d of dirents) {
      const abs = path.join(cur, d.name);
      if (d.isDirectory()) {
        if (d.name === '_inbox' || d.name.startsWith('.')) continue;
        stack.push(abs);
      } else if (d.isFile()) {
        const key = d.name.toLowerCase();
        // First hit wins so results are stable regardless of traversal order.
        if (!index.has(key)) index.set(key, abs);
      }
    }
  }
  return index;
}

// Walk preserveOrder tree to find all <image> and <img> nodes.
// Calls cb(node) with the node-object { tagName: [children], ":@": {attrs} }.
function walkImages(arr, cb) {
  if (!Array.isArray(arr)) return;
  for (const node of arr) {
    if (!node || typeof node !== 'object') continue;
    for (const [key, children] of Object.entries(node)) {
      if (key === ':@') continue;
      if (key === 'image' || key === 'img') cb(node);
      if (Array.isArray(children)) walkImages(children, cb);
    }
  }
}

// Read all href-like attributes (xlink:href, href, src) from a node's attrs.
function readHrefAttrs(node) {
  const attrs = node[':@'] || {};
  const out = [];
  // Prefer xlink:href over href if both present (drawio uses xlink:href)
  if (attrs['@_xlink:href'] != null) out.push({ name: '@_xlink:href', value: attrs['@_xlink:href'] });
  if (attrs['@_href'] != null) out.push({ name: '@_href', value: attrs['@_href'] });
  if (attrs['@_src'] != null) out.push({ name: '@_src', value: attrs['@_src'] });
  return out;
}

function writeHrefAttr(node, attrName, value) {
  if (!node[':@']) node[':@'] = {};
  node[':@'][attrName] = value;
}

/**
 * Build a resolver function from a rules array + aliases map.
 *
 * @param {Object} opts
 * @param {Array<{name, match: {pathSuffix?: string, hostPrefix?: string, urlPrefix?: string}, localBase: string}>} opts.rules
 *   Each rule defines: how to match URLs, and where the local mirror lives.
 *   - pathSuffix: matches if URL pathname *contains* this substring; the part
 *                 AFTER it is the tail used for local lookup.
 *   - hostPrefix: matches if `https://host/` equals this prefix.
 *   - urlPrefix:  matches if the full URL starts with this prefix; the part
 *                 after it is the tail.
 * @param {Object} opts.aliases  Map of full URL → local relative path (overrides).
 * @param {string} opts.assetRoot  Absolute base directory where localBase paths resolve from.
 *
 * Rules may also set `searchRecursive: true` to fall back to a basename search
 * anywhere under `localBase` when the direct path misses. This is for URL
 * namespaces that are flat while the local mirror is nested (e.g. drawio's
 * `mscae/` library against the category-nested `azure/` mirror).
 */
function createResolver({ rules = [], aliases = {}, assetRoot }) {
  if (!assetRoot) throw new Error('createResolver: assetRoot is required');
  const absRoot = path.resolve(assetRoot);
  // Memoized per resolver: a recursive walk is only paid for once per subtree,
  // and only when a rule opts in AND the direct lookup already missed.
  const basenameIndexes = new Map();

  return function resolve(url) {
    // 1. Aliases take precedence (exact full-URL match)
    if (Object.prototype.hasOwnProperty.call(aliases, url)) {
      const rel = aliases[url];
      const abs = path.resolve(absRoot, rel);
      if (!isInside(absRoot, abs)) {
        return { ok: false, reason: `alias escapes assetRoot: ${abs}`, ruleName: 'alias' };
      }
      if (fs.existsSync(abs)) return { ok: true, localPath: abs, ruleName: 'alias' };
      return { ok: false, reason: `alias points to missing file: ${abs}`, ruleName: 'alias' };
    }

    const norm = normalizeUrl(url);
    if (!norm) return { ok: false, reason: `unresolvable: not an absolute URL: ${url}` };

    // 2. Try rules in declaration order
    for (const rule of rules) {
      const m = rule.match || {};
      let tail = null;

      if (m.pathSuffix) {
        const idx = norm.pathname.indexOf(m.pathSuffix);
        if (idx >= 0) tail = norm.pathname.slice(idx + m.pathSuffix.length);
      } else if (m.urlPrefix) {
        if (norm.href.startsWith(m.urlPrefix)) tail = norm.href.slice(m.urlPrefix.length);
      } else if (m.hostPrefix) {
        if (norm.href.startsWith(m.hostPrefix)) {
          tail = norm.href.slice(m.hostPrefix.length).replace(/^\/+/, '');
        }
      }

      if (tail == null) continue;
      const localBase = rule.localBase || '';
      const candidate = path.resolve(absRoot, localBase, tail);
      // Safety: ensure candidate stays within assetRoot (prevent path traversal via crafted URLs)
      if (!isInside(absRoot, candidate)) {
        return { ok: false, reason: `resolved path escapes assetRoot: ${candidate}`, ruleName: rule.name };
      }
      if (fs.existsSync(candidate)) {
        return { ok: true, localPath: candidate, ruleName: rule.name };
      }
      // Try case-insensitive fallback on the basename (some library exports normalize case)
      try {
        const dir = path.dirname(candidate);
        if (fs.existsSync(dir)) {
          const base = path.basename(candidate).toLowerCase();
          const hit = fs.readdirSync(dir).find((f) => f.toLowerCase() === base);
          if (hit) return { ok: true, localPath: path.join(dir, hit), ruleName: rule.name + '-ci' };
        }
      } catch (_) {}
      // Opt-in recursive fallback: match the basename anywhere under localBase.
      if (rule.searchRecursive) {
        const baseDir = path.resolve(absRoot, localBase);
        if (isInside(absRoot, baseDir)) {
          if (!basenameIndexes.has(baseDir)) basenameIndexes.set(baseDir, buildBasenameIndex(baseDir));
          const hit = basenameIndexes.get(baseDir).get(path.basename(candidate).toLowerCase());
          if (hit) return { ok: true, localPath: hit, ruleName: rule.name + '-recursive' };
        }
      }
      return { ok: false, reason: `matched rule "${rule.name}" but local file missing: ${candidate}`, ruleName: rule.name };
    }

    return { ok: false, reason: 'no rule matched and not in aliases' };
  };
}

/**
 * Inline all external image references in an SVG.
 *
 * @param {Object} opts
 * @param {string} opts.svg            Raw SVG content
 * @param {Function} opts.resolve      Function: (url) → {ok: bool, localPath?, reason?, ruleName?}
 * @param {string} [opts.missingPolicy='collect']  'collect' = return unresolved, never throw.
 *                                                  'throw'   = throw after first pass with full report.
 * @returns {{ svg: string, resolved: Array, unresolved: Array }}
 */
function inlineExternalImages({ svg, resolve, missingPolicy = 'collect' }) {
  if (typeof svg !== 'string') throw new Error('inlineExternalImages: svg must be a string');
  if (typeof resolve !== 'function') throw new Error('inlineExternalImages: resolve must be a function');

  const parser = new XMLParser(XML_OPTS);
  const tree = parser.parse(svg);
  const resolved = [];
  const unresolved = [];

  walkImages(tree, (node) => {
    const hrefs = readHrefAttrs(node);
    for (const { name, value } of hrefs) {
      if (!value || typeof value !== 'string') continue;
      // Pass-through data: URIs
      if (/^data:/i.test(value)) continue;
      // Skip relative/empty/anchor refs (drawio exports shouldn't produce these,
      // but be defensive)
      if (!/^https?:\/\//i.test(value)) {
        unresolved.push({ url: value, reason: 'not absolute http(s): URL', attrName: name });
        continue;
      }

      const r = resolve(value);
      if (r && r.ok) {
        const { dataUri, mime, bytes } = fileToDataUri(r.localPath);
        writeHrefAttr(node, name, dataUri);
        resolved.push({ url: value, localPath: r.localPath, mime, bytes, ruleName: r.ruleName, attrName: name });
      } else {
        unresolved.push({ url: value, reason: (r && r.reason) || 'unknown', attrName: name });
      }
    }
  });

  if (missingPolicy === 'throw' && unresolved.length > 0) {
    const err = new Error(
      `inlineExternalImages: ${unresolved.length} external image(s) could not be resolved:\n` +
        unresolved.map((u) => `  - ${u.url}  (${u.reason})`).join('\n')
    );
    err.unresolved = unresolved;
    err.resolved = resolved;
    throw err;
  }

  const builder = new XMLBuilder(XML_OPTS);
  const outSvg = builder.build(tree);

  return { svg: outSvg, resolved, unresolved };
}

module.exports = {
  inlineExternalImages,
  createResolver,
  // exposed for unit tests
  _internals: { normalizeUrl, walkImages, readHrefAttrs, mimeFor, isInside, buildBasenameIndex },
};
