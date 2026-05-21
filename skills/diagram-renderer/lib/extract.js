// extract.js — Extract ```mermaid fenced blocks from Markdown files.
//
// Public API:
//   extractMermaidBlocks(input, opts?)
//     input — Markdown source string OR absolute file path
//     opts  — { fromFile?: boolean }  (auto-detected if input contains a newline)
//   Returns: [{
//     index,         // 0-based ordinal of the mermaid block in the document
//     code,          // raw mermaid source between the fences
//     lineStart,     // 1-based line number of the ```mermaid opening fence
//     lineEnd,       // 1-based line number of the closing ``` fence
//     sectionTitle,  // text of the nearest preceding heading (without leading '#'s); empty string if none
//     sectionLevel,  // heading depth (1-6) or 0 if no preceding heading
//     sectionAnchor, // GitHub-style slug of sectionTitle (lowercased ASCII, CJK kept)
//   }]
//
//   readMarkdownFile(filePath) → string  (utility re-exported for convenience)
//
// Notes:
//   - Recognizes both ```mermaid and ~~~mermaid fences (any length ≥ 3, with optional info-string)
//   - Skips nested code blocks correctly (closing fence must match opener char + length)
//   - Heading tracking: most-recent heading at any level above the block

'use strict';

const fs = require('fs');
const path = require('path');

// GitHub-ish heading-to-anchor slug.
// Behaviour: lowercase ASCII letters, keep CJK / digits, collapse whitespace to '-',
//            drop most punctuation, collapse runs of '-'.
function slugify(text) {
  if (!text) return '';
  let s = String(text).trim();
  // Strip backticks, bold/italic markers, links
  s = s.replace(/`([^`]+)`/g, '$1');
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
  s = s.replace(/\*([^*]+)\*/g, '$1');
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  // Lowercase ASCII only (CJK stays as-is)
  s = s.replace(/[A-Z]/g, c => c.toLowerCase());
  // Replace whitespace with hyphen
  s = s.replace(/\s+/g, '-');
  // Drop common punctuation; keep word chars + hyphen + CJK ranges
  s = s.replace(/[!"#$%&'()*+,./:;<=>?@\[\\\]^`{|}~。、，．：；！？「」『』（）【】《》]/g, '');
  // Collapse multi-hyphen and trim
  s = s.replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  return s;
}

function extractMermaidBlocks(input, opts = {}) {
  let src;
  if (opts.fromFile || (typeof input === 'string' && input.length < 4096 && !input.includes('\n') && fs.existsSync(input))) {
    src = fs.readFileSync(input, 'utf8');
  } else {
    src = String(input);
  }
  const lines = src.split(/\r?\n/);

  const headingStack = { level: 0, title: '' };
  const blocks = [];

  let i = 0;
  let blockIdx = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Track headings (ATX style only: lines starting with 1-6 '#' followed by space)
    const hMatch = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (hMatch) {
      headingStack.level = hMatch[1].length;
      headingStack.title = hMatch[2].replace(/\s*#+\s*$/, '').trim();
      i++;
      continue;
    }

    // Detect opening fence: ``` or ~~~ (>=3), optional language string "mermaid"
    const fenceOpen = line.match(/^(\s{0,3})(`{3,}|~{3,})\s*([^\s`~]*)/);
    if (fenceOpen) {
      const indent = fenceOpen[1].length;
      const marker = fenceOpen[2];
      const lang = (fenceOpen[3] || '').trim().toLowerCase();

      if (lang === 'mermaid') {
        // Find matching close fence (same char, length >= opener)
        const openLine = i + 1; // 1-based
        const codeLines = [];
        let j = i + 1;
        let closedAt = -1;
        const closeRe = new RegExp('^\\s{0,3}' + marker[0] + '{' + marker.length + ',}\\s*$');
        while (j < lines.length) {
          if (closeRe.test(lines[j])) {
            closedAt = j;
            break;
          }
          codeLines.push(lines[j]);
          j++;
        }
        if (closedAt === -1) {
          // unterminated — treat to EOF
          closedAt = lines.length - 1;
        }
        const code = codeLines.join('\n');
        // Strip per-line indent equal to opener indent (markdown nested-list code blocks)
        let normalizedCode = code;
        if (indent > 0) {
          const rx = new RegExp('^ {0,' + indent + '}');
          normalizedCode = code.split('\n').map(ln => ln.replace(rx, '')).join('\n');
        }
        blocks.push({
          index: blockIdx++,
          code: normalizedCode,
          lineStart: openLine,
          lineEnd: closedAt + 1,
          sectionTitle: headingStack.title,
          sectionLevel: headingStack.level,
          sectionAnchor: slugify(headingStack.title),
        });
        i = closedAt + 1;
        continue;
      } else {
        // Non-mermaid fenced block — skip to its close so we don't track headings inside
        const closeRe = new RegExp('^\\s{0,3}' + marker[0] + '{' + marker.length + ',}\\s*$');
        let j = i + 1;
        while (j < lines.length && !closeRe.test(lines[j])) j++;
        i = j + 1;
        continue;
      }
    }

    i++;
  }
  return blocks;
}

// Resolve a single block from a markdown file using either index or section slug/title.
//   selector: { index? :number, section?: string }   (section matches anchor exactly or title substring)
function pickBlock(blocks, selector = {}) {
  if (selector.index != null) {
    const b = blocks[selector.index];
    if (!b) throw new Error(`mermaid block index ${selector.index} out of range (have ${blocks.length})`);
    return b;
  }
  if (selector.section) {
    const want = String(selector.section);
    const wantSlug = slugify(want);
    // 1) exact anchor match
    let hit = blocks.find(b => b.sectionAnchor === want || b.sectionAnchor === wantSlug);
    if (hit) return hit;
    // 2) section title contains the requested string (case-insensitive ASCII)
    hit = blocks.find(b => (b.sectionTitle || '').toLowerCase().includes(want.toLowerCase()));
    if (hit) return hit;
    throw new Error(`no mermaid block found for section="${selector.section}"`);
  }
  if (blocks.length === 0) throw new Error('no mermaid blocks in document');
  return blocks[0];
}

function readMarkdownFile(filePath) {
  return fs.readFileSync(path.resolve(filePath), 'utf8');
}

module.exports = {
  extractMermaidBlocks,
  pickBlock,
  slugify,
  readMarkdownFile,
};
