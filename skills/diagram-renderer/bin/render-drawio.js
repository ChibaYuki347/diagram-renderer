#!/usr/bin/env node
// render-drawio — CLI wrapper around lib/render-drawio.js
//
// Usage:
//   render-drawio <input.svg|.drawio.svg> --out <out.png> [options]
//   cat diagram.svg | render-drawio --out diagram.png

'use strict';

const fs = require('fs');
const path = require('path');
const { renderDrawio } = require('../lib/render-drawio');
const { createResolver } = require('../lib/inline-external-images');

function parseArgs(argv) {
  const args = { positional: [], allowNetwork: false, noInline: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i];
    else if (a === '--scale') args.scale = Number(argv[++i]);
    else if (a === '--cssWidth' || a === '--css-width' || a === '--width') args.cssWidth = Number(argv[++i]);
    else if (a === '--background' || a === '--bg') args.background = argv[++i];
    else if (a === '--allow-network') args.allowNetwork = true;
    else if (a === '--no-inline-images') args.noInline = true;
    else if (a === '--asset-root') args.assetRoot = argv[++i];
    else if (a === '--rules') args.rulesFile = argv[++i];
    else if (a === '--aliases') args.aliasesFile = argv[++i];
    else if (a === '--report-missing') args.reportMissing = argv[++i];
    else if (a === '-h' || a === '--help') args.help = true;
    else if (a.startsWith('--')) {
      console.error(`Unknown option: ${a}`);
      process.exit(2);
    } else args.positional.push(a);
  }
  return args;
}

function printHelp() {
  console.log(`Usage: render-drawio <input.svg|.drawio.svg> --out <out.png> [options]

Render an editable SVG export from draw.io to PNG using headless Chromium.

Options:
  --out FILE              Output PNG path (required)
  --scale N               Device scale factor for screenshot (default 2)
  --cssWidth N            CSS viewport width in px (default 1600)
  --background CSS        Background color (default: transparent)

Icon inlining (Phase 4):
  --asset-root DIR        Root of local icon mirror (default: <skill>/.local-assets)
  --rules FILE            JSON file with resolver rules (default: <skill>/assets/icons/resolver-rules.json if present)
  --aliases FILE          JSON file with URL→localPath alias map (optional)
  --no-inline-images      Skip the inline-external-images preflight (NOT recommended)
  --allow-network         Allow Chromium to fetch external resources (disables strictOffline)
  --report-missing FILE   On unresolved externals, write a JSON report to this path before erroring

  -h, --help              Show this help

Default behavior (Phase 4):
  - Pre-process SVG: rewrite external <image> URLs to data: URIs from local mirror.
  - Block ALL http(s) requests in Chromium (strictOffline). Fail-fast on any external fetch.
  - Recommended export path from drawio: File → Save As → Editable SVG, "Embed Images" ON.

Note: raw .drawio XML files are not supported. In draw.io, use
      File → Save As → Editable SVG to produce a .drawio.svg first.
`);
}

function loadJsonIfPresent(p) {
  if (!p) return null;
  const abs = path.resolve(p);
  if (!fs.existsSync(abs)) {
    console.error(`Warning: ${p} not found, skipping`);
    return null;
  }
  return JSON.parse(fs.readFileSync(abs, 'utf8'));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printHelp(); return; }
  if (!args.out) {
    console.error('Error: --out is required');
    process.exit(2);
  }
  let file = args.positional[0];
  let source = null;
  if (!file) {
    if (process.stdin.isTTY) {
      console.error('Error: no input file and stdin is a TTY');
      process.exit(2);
    }
    source = fs.readFileSync(0, 'utf8');
  } else {
    file = path.resolve(file);
  }

  // Build resolver if asset-root is provided (or default exists)
  const SKILL_ROOT = path.resolve(__dirname, '..');
  const defaultAssetRoot = path.join(SKILL_ROOT, '.local-assets');
  const defaultRules = path.join(SKILL_ROOT, 'assets', 'icons', 'resolver-rules.json');
  const defaultAliases = path.join(SKILL_ROOT, 'assets', 'icons', 'aliases.json');

  const assetRoot = args.assetRoot || (fs.existsSync(defaultAssetRoot) ? defaultAssetRoot : null);
  const rulesFile = args.rulesFile || (fs.existsSync(defaultRules) ? defaultRules : null);
  const aliasesFile = args.aliasesFile || (fs.existsSync(defaultAliases) ? defaultAliases : null);

  let resolver = null;
  if (assetRoot && !args.noInline) {
    const rules = loadJsonIfPresent(rulesFile) || [];
    const aliases = loadJsonIfPresent(aliasesFile) || {};
    resolver = createResolver({ rules, aliases, assetRoot });
  }

  try {
    const result = await renderDrawio({
      file,
      source,
      out: args.out,
      scale: args.scale,
      cssWidth: args.cssWidth,
      background: args.background,
      inlineImages: !args.noInline,
      resolver,
      allowNetwork: args.allowNetwork,
    });
    console.log(JSON.stringify(result));
  } catch (e) {
    if (args.reportMissing && (e.unresolved || (e.message && /external image reference/.test(e.message)))) {
      // Try to extract unresolved list from the error
      const report = { unresolved: e.unresolved || [], message: e.message };
      fs.writeFileSync(path.resolve(args.reportMissing), JSON.stringify(report, null, 2));
      console.error(`(Wrote missing-externals report to ${args.reportMissing})`);
    }
    console.error(e.stack || String(e));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e.stack || String(e));
  process.exit(1);
});
