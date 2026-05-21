#!/usr/bin/env node
// extract-md-mermaid.js — Extract ```mermaid blocks from a Markdown file.
//
// Usage:
//   extract-md-mermaid <input.md> [--out DIR] [--list] [--render] [--theme NAME]
//
// Options:
//   --out DIR     Write `mermaid-001.mmd ...` + manifest.json into DIR (default: <input>.mermaid/)
//   --list        Print a table of blocks (index, lineStart, sectionTitle) and exit.
//   --render      Also render each block to PNG via lib/render.js (same DIR).
//   --theme NAME  Mermaid theme (default: microsoft-light). Used only with --render.
//   --cssWidth N  CSS viewport width for render (default: 1100).

'use strict';

const fs = require('fs');
const path = require('path');
const { extractMermaidBlocks } = require('../lib/extract');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') { out.out = argv[++i]; continue; }
    if (a === '--list') { out.list = true; continue; }
    if (a === '--render') { out.render = true; continue; }
    if (a === '--theme') { out.theme = argv[++i]; continue; }
    if (a === '--cssWidth') { out.cssWidth = Number(argv[++i]); continue; }
    if (a === '-h' || a === '--help') { out.help = true; continue; }
    if (a.startsWith('--')) throw new Error(`Unknown option: ${a}`);
    out._.push(a);
  }
  return out;
}

function usage() {
  console.error(`Usage: extract-md-mermaid <input.md> [--out DIR] [--list] [--render] [--theme NAME] [--cssWidth N]`);
}

function pad(n, w) { return String(n).padStart(w, '0'); }

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args._.length !== 1) {
    usage();
    process.exit(args.help ? 0 : 1);
  }
  const input = path.resolve(args._[0]);
  if (!fs.existsSync(input)) {
    console.error(`Input not found: ${input}`);
    process.exit(2);
  }
  const src = fs.readFileSync(input, 'utf8');
  const blocks = extractMermaidBlocks(src);

  if (args.list) {
    if (blocks.length === 0) {
      console.log('(no mermaid blocks found)');
      return;
    }
    const w = String(blocks.length - 1).length;
    console.log(`Found ${blocks.length} mermaid block(s) in ${path.relative(process.cwd(), input)}:`);
    blocks.forEach(b => {
      const head = (b.code.split('\n').find(l => l.trim()) || '').slice(0, 50);
      console.log(`  [${pad(b.index, w)}] line ${b.lineStart}: ${b.sectionTitle || '(no heading)'}`);
      console.log(`         first: ${head}`);
    });
    return;
  }

  const outDir = path.resolve(args.out || (input + '.mermaid'));
  fs.mkdirSync(outDir, { recursive: true });
  const w = Math.max(3, String(blocks.length).length);
  const manifest = {
    source: path.relative(outDir, input),
    extractedAt: new Date().toISOString(),
    count: blocks.length,
    blocks: [],
  };

  let renderer = null;
  if (args.render) {
    renderer = require('../lib/render');
  }

  for (const b of blocks) {
    const base = `mermaid-${pad(b.index + 1, w)}`;
    const mmdPath = path.join(outDir, `${base}.mmd`);
    fs.writeFileSync(mmdPath, b.code + '\n');
    const entry = {
      index: b.index,
      file: path.basename(mmdPath),
      lineStart: b.lineStart,
      lineEnd: b.lineEnd,
      sectionTitle: b.sectionTitle,
      sectionLevel: b.sectionLevel,
      sectionAnchor: b.sectionAnchor,
    };
    if (renderer) {
      const pngPath = path.join(outDir, `${base}.png`);
      const result = await renderer.renderMermaid({
        code: b.code,
        theme: args.theme || 'microsoft-light',
        cssWidth: args.cssWidth || 1100,
        out: pngPath,
      });
      entry.png = path.basename(result.path);
      entry.pngWidth = result.width;
      entry.pngHeight = result.height;
    }
    manifest.blocks.push(entry);
  }
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`Wrote ${blocks.length} block(s) → ${path.relative(process.cwd(), outDir)}/`);
}

main().catch(err => { console.error(err.stack || err.message); process.exit(1); });
