// render-drawio.js — Render a draw.io diagram to PNG using headless Chromium.
//
// Public API:
//   await renderDrawio({ source, file, out, scale, cssWidth, background,
//                        inlineImages, resolver, strictOffline, allowNetwork })
//     source            — drawio SVG content as a string (alternative to `file`)
//     file              — path to `.drawio.svg`, `.svg`, or `.drawio` (XML).
//                         `.drawio` raw XML is NOT supported by this renderer alone —
//                         we throw a helpful error pointing the user to export as
//                         "Editable SVG" (`.drawio.svg`) from drawio first. This keeps
//                         the renderer corp-friendly (no Electron / drawio-desktop install).
//     out               — output path (.png recommended for PPT)
//     scale             — deviceScaleFactor for the screenshot (default 2 = retina)
//     cssWidth          — viewport / CSS width in px (default 1600). The SVG is
//                         embedded at width=100% so the natural aspect is preserved;
//                         the larger this is, the higher the rasterized resolution.
//     background        — CSS background color (default: transparent)
//     inlineImages      — bool (default: true). If true, pre-process the SVG with
//                         inlineExternalImages() to convert external <image> URLs
//                         to data: URIs from local mirror. Required for offline rendering.
//     resolver          — function (url) → {ok, localPath?, reason?}. Required when
//                         inlineImages=true and SVG contains external refs.
//     strictOffline     — bool (default: true). Intercept Puppeteer requests and
//                         abort any http(s) navigation, fail-fast on any external
//                         fetch attempt. Local file:// and data: are allowed.
//     allowNetwork      — bool (default: false). Opposite of strictOffline as a
//                         convenience for CLI flag wiring. If true → strictOffline = false.
//   Returns:
//     { path, format: 'png', width, height,
//       inlined: { resolved: [...], unresolved: [...] }? }   // includes inline report if inlineImages=true
//
// Design notes:
// - We reuse the same Chromium discovery as render.js (Playwright cache first)
//   so we don't trigger a fresh download.
// - For `.svg` / `.drawio.svg`: we open a tiny HTML page with the SVG inlined,
//   measure the rendered bounding box, then `page.screenshot({clip: bbox})`.
// - For `.drawio` (XML only): we surface a clear actionable error.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const { findChromium } = require('./render');
const { inlineExternalImages } = require('./inline-external-images');

const SKILL_ROOT = path.resolve(__dirname, '..');
const PUPPETEER_PATHS = [SKILL_ROOT];

function loadPuppeteer() {
  try {
    const resolved = require.resolve('puppeteer', { paths: PUPPETEER_PATHS });
    return require(resolved);
  } catch (e) {
    throw new Error(
      'puppeteer is not installed in diagram-renderer. ' +
      'It is normally pulled in transitively by @mermaid-js/mermaid-cli — run ' +
      '`npm install` in ' + SKILL_ROOT + ' to restore.'
    );
  }
}

// Detect whether the source looks like SVG vs raw drawio XML.
function detectDrawioKind(content) {
  const head = content.slice(0, 2048).trim();
  if (/^<\?xml[^>]*\?>/.test(head)) {
    const next = head.replace(/^<\?xml[^>]*\?>\s*/, '');
    if (/^<svg[\s>]/i.test(next)) return 'svg';
    if (/^<mxfile[\s>]/i.test(next) || /^<mxGraphModel[\s>]/i.test(next)) return 'drawio-xml';
  }
  if (/^<svg[\s>]/i.test(head)) return 'svg';
  if (/^<mxfile[\s>]/i.test(head) || /^<mxGraphModel[\s>]/i.test(head)) return 'drawio-xml';
  return 'unknown';
}

function readPngSize(p) {
  const fd = fs.openSync(p, 'r');
  const buf = Buffer.alloc(24);
  fs.readSync(fd, buf, 0, 24, 0);
  fs.closeSync(fd);
  if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) {
    throw new Error('not a PNG');
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// Format a helpful error when the user has external <image> URLs that we
// couldn't resolve. Action-oriented per Phase 4 plan.
function formatUnresolvedError(unresolved) {
  const lines = [
    `drawio render failed: ${unresolved.length} external image reference(s) could not be resolved offline:`,
    '',
  ];
  for (const u of unresolved.slice(0, 20)) {
    lines.push(`  - ${u.url}`);
    lines.push(`      reason: ${u.reason}`);
  }
  if (unresolved.length > 20) lines.push(`  ... and ${unresolved.length - 20} more`);
  lines.push('');
  lines.push('Try one of:');
  lines.push('  (a) Re-export the .drawio.svg from draw.io with "Embed Images" ON (File → Save As / Export As → Editable SVG, check "Embed Images") — recommended');
  lines.push('  (b) Populate the local icon mirror: run scripts/fetch-icons.sh in the diagram-renderer skill');
  lines.push('  (c) Add manual mappings to assets/icons/aliases.json');
  lines.push('  (d) Pass --allow-network (CLI) or { strictOffline: false } (API) to let Chromium fetch — not recommended in corp/airgapped envs');
  const err = new Error(lines.join('\n'));
  // Expose structured data so callers (CLI / bridge) can dump a machine-readable report.
  err.unresolved = unresolved;
  err.code = 'DRAWIO_UNRESOLVED_EXTERNAL_IMAGES';
  return err;
}

async function renderDrawio(opts = {}) {
  const {
    source,
    file,
    out,
    scale = 2,
    cssWidth = 1600,
    background = 'transparent',
    inlineImages = true,
    resolver = null,
    allowNetwork = false,
  } = opts;
  // strictOffline defaults to true, but `allowNetwork: true` flips it off.
  const strictOffline = opts.strictOffline != null ? !!opts.strictOffline : !allowNetwork;

  if (!out) throw new Error('renderDrawio: `out` is required');
  if (!source && !file) throw new Error('renderDrawio: `source` or `file` is required');

  let content = source;
  if (!content) {
    const abs = path.resolve(file);
    if (!fs.existsSync(abs)) throw new Error(`renderDrawio: file not found: ${abs}`);
    content = fs.readFileSync(abs, 'utf8');
  }

  const kind = detectDrawioKind(content);
  if (kind === 'drawio-xml') {
    throw new Error(
      'renderDrawio: raw `.drawio` XML is not supported by this renderer. ' +
      'In drawio (desktop or app.diagrams.net), use **File → Save As → Editable SVG** ' +
      '(or **Export As → SVG** with "Include a copy of my diagram" enabled) to produce ' +
      'a `.drawio.svg` file, then reference that instead. This keeps the build pipeline ' +
      'dependency-free (no Electron / drawio-desktop install required).'
    );
  }
  if (kind !== 'svg') {
    throw new Error(
      `renderDrawio: could not detect SVG content in input. Got prefix: ${content.slice(0, 120).replace(/\s+/g, ' ')}`
    );
  }

  // ---- Phase 4.3: inline external <image> refs to data: URIs --------------
  let inlineReport = null;
  if (inlineImages) {
    if (!resolver) {
      // No resolver supplied. If the SVG happens to be already self-contained
      // (Embed Images was ON at export time), we don't need one — but we still
      // want to detect external refs and fail-fast in strictOffline mode.
      // Use a noop resolver that flags everything as unresolved.
      const noopResolver = () => ({ ok: false, reason: 'no resolver configured (inlineImages=true but resolver=null)' });
      const r = inlineExternalImages({ svg: content, resolve: noopResolver });
      if (r.unresolved.length > 0 && strictOffline) {
        throw formatUnresolvedError(r.unresolved);
      }
      inlineReport = r;
      content = r.svg;
    } else {
      const r = inlineExternalImages({ svg: content, resolve: resolver });
      if (r.unresolved.length > 0 && strictOffline) {
        throw formatUnresolvedError(r.unresolved);
      }
      inlineReport = r;
      content = r.svg;
    }
  }

  const outAbs = path.resolve(out);
  fs.mkdirSync(path.dirname(outAbs), { recursive: true });

  const puppeteer = loadPuppeteer();
  const chromium = findChromium();

  const launchOpts = {
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    headless: true,
  };
  if (chromium) launchOpts.executablePath = chromium;

  const browser = await puppeteer.launch(launchOpts);
  let width = 0, height = 0;
  const blockedRequests = [];
  try {
    const page = await browser.newPage();

    // ---- Phase 4.3: offline guard -----------------------------------------
    if (strictOffline) {
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        const url = req.url();
        if (/^https?:/i.test(url)) {
          blockedRequests.push(url);
          req.abort('failed').catch(() => {});
        } else {
          // data:, about:, file: etc. allowed
          req.continue().catch(() => {});
        }
      });
    }

    await page.setViewport({ width: Math.max(200, Math.round(cssWidth)), height: 800, deviceScaleFactor: scale });

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
  html,body{margin:0;padding:0;background:${background};}
  #wrap{display:inline-block;}
  #wrap > svg{display:block;width:${cssWidth}px;height:auto;max-width:none;}
</style></head>
<body><div id="wrap">${content}</div></body></html>`;

    await page.setContent(html, { waitUntil: 'networkidle0' });

    const box = await page.evaluate(() => {
      const svg = document.querySelector('#wrap > svg');
      if (!svg) return null;
      const r = svg.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    });

    if (!box || box.width <= 0 || box.height <= 0) {
      throw new Error('renderDrawio: could not measure SVG bounding box (empty render?)');
    }

    await page.setViewport({
      width: Math.ceil(box.x + box.width + 2),
      height: Math.ceil(box.y + box.height + 2),
      deviceScaleFactor: scale,
    });

    await page.screenshot({
      path: outAbs,
      type: 'png',
      omitBackground: background === 'transparent',
      clip: {
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
      },
    });
  } finally {
    await browser.close();
  }

  // Defense-in-depth: if strictOffline but Chromium DID try to fetch despite our
  // inline pass + interception, surface that as an error (the screenshot above
  // would still complete from cached/aborted state, but the caller deserves to
  // know).
  if (strictOffline && blockedRequests.length > 0) {
    const err = new Error(
      `renderDrawio: strictOffline=true but ${blockedRequests.length} network request(s) were attempted and blocked:\n` +
      blockedRequests.slice(0, 10).map((u) => `  - ${u}`).join('\n') +
      (blockedRequests.length > 10 ? `\n  ... and ${blockedRequests.length - 10} more` : '') +
      '\nThis usually means the SVG has external <image> refs that the inline pass could not resolve. ' +
      'See `inlined.unresolved` on the (would-have-been) result, or re-export with "Embed Images" ON.'
    );
    err.blockedRequests = blockedRequests;
    err.inlined = inlineReport;
    throw err;
  }

  try {
    const dim = readPngSize(outAbs);
    width = dim.width;
    height = dim.height;
  } catch (_) {}

  const result = { path: outAbs, format: 'png', width, height };
  if (inlineReport) result.inlined = { resolved: inlineReport.resolved, unresolved: inlineReport.unresolved };
  return result;
}

// Cache key for consumers (matches lib/render.js pattern).
// IMPORTANT: when callers use inlineImages=true, they should call cacheKey()
// with the POST-INLINE svg content (via `source`), not the raw file content,
// so that changes to the local icon mirror invalidate the cache.
function cacheKey({ source, file, scale = 2, cssWidth = 1600, background = 'transparent' }) {
  const h = crypto.createHash('sha1');
  if (source) h.update('SRC:').update(source);
  if (file) h.update('FILE:').update(fs.readFileSync(file));
  h.update('|').update(String(scale)).update('|').update(String(cssWidth)).update('|').update(String(background));
  return h.digest('hex');
}

module.exports = { renderDrawio, cacheKey, detectDrawioKind };
