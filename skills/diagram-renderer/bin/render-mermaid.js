#!/usr/bin/env node
// render-mermaid — CLI wrapper for lib/render.js.
//
// Usage:
//   render-mermaid <input.mmd> --out <output.png> [options]
//   echo 'graph LR; A-->B' | render-mermaid - --out diagram.png
//
// Options:
//   --out, -o          Output path (required)
//   --theme            Named theme: microsoft-light (default) | microsoft-dark | default
//   --theme-file       Path to a custom mermaid themeVariables JSON
//   --scale            Device scale (default 2)
//   --width            CSS viewport width in px (default 1600). Smaller = tighter natural layout.
//   --background, -b   Override background color (e.g. white, transparent, #FFFFFF)
//   --format           Override format (png | svg | pdf); inferred from --out otherwise
//   --help, -h         Show help

'use strict';

const fs = require('fs');
const path = require('path');
const { renderMermaid } = require('../lib/render');

function usage() {
  console.error(`Usage: render-mermaid <input.mmd|-> --out <out.png> [--theme NAME] [--theme-file FILE]
                       [--scale N] [--width N] [--background COLOR] [--format png|svg|pdf]`);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { out.help = true; continue; }
    if (a === '--out' || a === '-o') { out.out = argv[++i]; continue; }
    if (a === '--theme') { out.theme = argv[++i]; continue; }
    if (a === '--theme-file') { out.themeFile = argv[++i]; continue; }
    if (a === '--scale') { out.scale = Number(argv[++i]); continue; }
    if (a === '--width') { out.cssWidth = Number(argv[++i]); continue; }
    if (a === '--background' || a === '-b') { out.background = argv[++i]; continue; }
    if (a === '--format') { out.format = argv[++i]; continue; }
    if (a.startsWith('--')) { console.error(`Unknown flag: ${a}`); process.exit(2); }
    out._.push(a);
  }
  return out;
}

async function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args._.length && process.stdin.isTTY)) {
    usage();
    process.exit(args.help ? 0 : 1);
  }
  if (!args.out) { console.error('Missing --out'); usage(); process.exit(2); }

  const input = args._[0];
  let code, file;
  if (!input || input === '-') {
    code = await readStdin();
    if (!code.trim()) { console.error('No input on stdin'); process.exit(2); }
  } else {
    if (!fs.existsSync(input)) { console.error(`Input not found: ${input}`); process.exit(2); }
    file = input;
  }

  const result = await renderMermaid({
    code, file,
    out: args.out,
    theme: args.theme || 'microsoft-light',
    themeFile: args.themeFile,
    scale: args.scale,
    cssWidth: args.cssWidth,
    background: args.background,
    format: args.format,
  });
  console.log(`${path.relative(process.cwd(), result.path)}  (${result.format}${result.width ? `, ${result.width}x${result.height}px` : ''})`);
}

main().catch(err => { console.error(err.message || err); process.exit(1); });
