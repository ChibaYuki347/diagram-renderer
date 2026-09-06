#!/usr/bin/env node
// icon-search — CLI over lib/icon-index.js
//
// Find the exact icon name + canonical URL to use in a .drawio.svg, instead of
// guessing a filename and discovering the mistake at render time.
//
// Usage:
//   icon-search cosmos db
//   icon-search "function app" --set azure --limit 5
//   icon-search entra id --json
//   icon-search --sets

'use strict';

const fs = require('fs');
const path = require('path');
const {
  buildIconIndex,
  searchIcons,
  getIcon,
  defaultAssetRoot,
} = require('../lib/icon-index');

function parseArgs(argv) {
  const args = { terms: [], limit: 10, json: false, sets: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--set') args.set = argv[++i];
    else if (a === '--limit' || a === '-n') args.limit = Number(argv[++i]);
    else if (a === '--json') args.json = true;
    else if (a === '--sets' || a === '--stats') args.sets = true;
    else if (a === '--id') args.id = argv[++i];
    else if (a === '--asset-root') args.assetRoot = argv[++i];
    else if (a === '--rules') args.rulesFile = argv[++i];
    else if (a === '-h' || a === '--help') args.help = true;
    else if (a.startsWith('--')) {
      console.error(`Unknown option: ${a}`);
      process.exit(2);
    } else args.terms.push(a);
  }
  return args;
}

function printHelp() {
  console.log(`Usage: icon-search <query...> [options]

Search the local icon mirror and print the canonical URL to embed in a
.drawio.svg. Renders offline, so what this prints is guaranteed resolvable by
\`render-drawio\` with the same asset root.

Options:
  --set NAME         Restrict to one set (azure, entra, power-platform, github, ...)
  --limit N, -n N    Max results (default 10; 0 = unlimited)
  --id ID            Exact lookup by catalog id instead of a search
  --sets, --stats    List available sets and icon counts, then exit
  --json             Machine-readable output
  --asset-root DIR   Icon mirror root (default: <skill>/.local-assets)
  --rules FILE       Resolver rules JSON (default: <skill>/assets/icons/resolver-rules.json)
  -h, --help         Show this help

Exit codes:
  0  results found
  2  usage error
  3  no results (or the mirror is empty — run scripts/fetch-icons.sh)

Examples:
  icon-search cosmos db
  icon-search "function app" --set azure -n 5
  icon-search entra id --json
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

function formatEntry(e) {
  const lines = [`${e.id}${e.score != null ? `  (score ${e.score})` : ''}`];
  lines.push(`  name : ${e.name}`);
  lines.push(`  set  : ${e.set}${e.group ? `   group: ${e.group}` : ''}`);
  lines.push(`  url  : ${e.url || '(no canonical URL — use --asset-root refs)'}`);
  lines.push(`  file : ${e.file}`);
  if (e.variants.length) lines.push(`  also : ${e.variants.join(', ')}`);
  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printHelp(); return 0; }

  const rules = args.rulesFile ? loadJsonIfPresent(args.rulesFile) : undefined;
  const index = buildIconIndex({
    assetRoot: args.assetRoot || defaultAssetRoot(),
    rules: rules || undefined,
  });

  for (const w of index.warnings) console.error(`Warning: ${w}`);

  if (args.sets) {
    if (args.json) {
      console.log(JSON.stringify({ assetRoot: index.assetRoot, sets: index.sets }, null, 2));
    } else {
      console.log(`Icon mirror: ${index.assetRoot}`);
      if (!index.sets.length) console.log('  (empty — run scripts/fetch-icons.sh)');
      for (const s of index.sets) console.log(`  ${s.name.padEnd(20)} ${s.count}`);
    }
    return index.sets.length ? 0 : 3;
  }

  if (args.id) {
    const hit = getIcon(index, args.id);
    if (!hit) {
      console.error(`No icon with id '${args.id}'.`);
      return 3;
    }
    console.log(args.json ? JSON.stringify(hit, null, 2) : formatEntry(hit));
    return 0;
  }

  const query = args.terms.join(' ');
  if (!query) {
    console.error('Error: no query given.\n');
    printHelp();
    return 2;
  }

  const hits = searchIcons(index, query, { set: args.set, limit: args.limit });
  if (!hits.length) {
    if (args.json) console.log(JSON.stringify({ query, results: [] }, null, 2));
    else console.error(`No icons matched '${query}'.` + (index.entries.length ? '' : ' The mirror is empty.'));
    return 3;
  }

  if (args.json) {
    console.log(JSON.stringify({ query, assetRoot: index.assetRoot, results: hits }, null, 2));
  } else {
    console.log(hits.map(formatEntry).join('\n\n'));
  }
  return 0;
}

try {
  process.exitCode = main();
} catch (e) {
  console.error(e.stack || String(e));
  process.exitCode = 1;
}
