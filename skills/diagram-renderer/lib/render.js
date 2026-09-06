// render.js — Render a Mermaid diagram to PNG/SVG using @mermaid-js/mermaid-cli.
//
// Public API:
//   await renderMermaid({ code, theme, themeFile, out, format, scale, cssWidth, background })
//     code        — mermaid source string (required if file not given)
//     file        — path to a .mmd file (alternative to code)
//     theme       — named theme: 'microsoft-light' | 'microsoft-dark' | 'default' (default: 'microsoft-light')
//     themeFile   — path to a custom mermaid themeVariables JSON (overrides `theme`)
//     out         — output path (required). Extension determines format if `format` omitted.
//     format      — 'png' | 'svg' | 'pdf' (default inferred from out)
//     scale       — device scale factor for PNG (default 2 = retina)
//     cssWidth    — puppeteer viewport CSS width in px (default 1600). Smaller values
//                   produce a more compact natural layout — recommended for narrow embed targets.
//     background  — background color (default: from theme)
//   Returns:
//     { path, format, width, height }       // width/height = output PNG pixel dimensions
//
// Implementation: shells out to node_modules/.bin/mmdc with a generated
// puppeteer config that reuses Playwright's installed Chromium if available,
// avoiding a double Chromium download.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const SKILL_ROOT = path.resolve(__dirname, '..');
const THEMES_DIR = path.join(SKILL_ROOT, 'themes');

// Resolve how to invoke mermaid-cli.
//
// We deliberately run mermaid-cli's JS entry point with the *current* node
// binary rather than the `node_modules/.bin/mmdc` shim: on Windows that shim is
// an extensionless shell script that cannot be spawned directly (npm writes a
// separate `mmdc.cmd` for that), and spawning `.cmd` requires `shell: true`,
// which is unsafe with the user-supplied paths we pass through.
function resolveMmdc() {
  try {
    const pkgPath = require.resolve('@mermaid-js/mermaid-cli/package.json', { paths: [SKILL_ROOT] });
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const rel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin && pkg.bin.mmdc;
    if (rel) {
      const entry = path.resolve(path.dirname(pkgPath), rel);
      if (fs.existsSync(entry)) return entry;
    }
  } catch (_) {}
  return null;
}

// Try to locate an already-installed Chromium so mmdc doesn't download a fresh one.
// Covers the Playwright browser cache and common system installs on Linux,
// macOS and Windows. Returns null when nothing is found, in which case
// puppeteer falls back to its own bundled download.
function findChromium() {
  const env = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH;
  if (env && fs.existsSync(env)) return env;

  const home = os.homedir();
  const platform = process.platform;

  // Playwright keeps its browsers in a platform-specific cache directory.
  const pwCaches =
    platform === 'win32'
      ? [path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'ms-playwright')]
      : platform === 'darwin'
        ? [path.join(home, 'Library', 'Caches', 'ms-playwright'), path.join(home, '.cache', 'ms-playwright')]
        : [path.join(home, '.cache', 'ms-playwright')];

  // Relative path from a `chromium-<rev>` dir to the executable.
  const pwExecutables =
    platform === 'win32'
      ? [['chrome-win', 'chrome.exe'], ['chrome-win64', 'chrome.exe']]
      : platform === 'darwin'
        ? [
            ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'],
            ['chrome-mac-arm64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'],
          ]
        : [['chrome-linux64', 'chrome'], ['chrome-linux', 'chrome']];

  const candidates = [];
  for (const pwCache of pwCaches) {
    if (!fs.existsSync(pwCache)) continue;
    for (const name of fs.readdirSync(pwCache)) {
      if (!name.startsWith('chromium')) continue;
      for (const parts of pwExecutables) candidates.push(path.join(pwCache, name, ...parts));
    }
  }

  if (platform === 'win32') {
    const programFiles = [
      process.env.PROGRAMFILES,
      process.env['PROGRAMFILES(X86)'],
      path.join(home, 'AppData', 'Local'),
      process.env.LOCALAPPDATA,
    ].filter(Boolean);
    for (const base of programFiles) {
      candidates.push(path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      candidates.push(path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
      candidates.push(path.join(base, 'Chromium', 'Application', 'chrome.exe'));
    }
  } else if (platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
    );
  } else {
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium'
    );
  }

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function resolveThemeFile(theme, themeFile) {
  if (themeFile) return path.resolve(themeFile);
  if (!theme || theme === 'default') return null;
  const candidate = path.join(THEMES_DIR, `${theme}.json`);
  if (!fs.existsSync(candidate)) {
    throw new Error(`Unknown theme '${theme}'. Available: microsoft-light, microsoft-dark, default. Or pass themeFile.`);
  }
  return candidate;
}

function inferFormat(outPath) {
  const ext = path.extname(outPath).toLowerCase().replace(/^\./, '');
  if (!['png', 'svg', 'pdf'].includes(ext)) {
    throw new Error(`Cannot infer format from extension '${ext}'. Use .png, .svg, or .pdf, or pass format explicitly.`);
  }
  return ext;
}

async function renderMermaid(opts = {}) {
  const {
    code,
    file,
    theme = 'microsoft-light',
    themeFile,
    out,
    format,
    scale = 2,
    cssWidth = 1600,    // mmdc -w (puppeteer viewport width; controls "natural" diagram size)
    background,
  } = opts;

  if (!out) throw new Error('renderMermaid: `out` is required');
  if (!code && !file) throw new Error('renderMermaid: `code` or `file` is required');
  const mmdcEntry = resolveMmdc();
  if (!mmdcEntry) {
    throw new Error(`mermaid-cli (mmdc) not found. Run \`npm install\` in ${SKILL_ROOT}.`);
  }

  const outAbs = path.resolve(out);
  const fmt = format || inferFormat(outAbs);
  fs.mkdirSync(path.dirname(outAbs), { recursive: true });

  // Stage input
  let inputPath = file ? path.resolve(file) : null;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmdc-'));
  if (!inputPath) {
    inputPath = path.join(tmpDir, 'input.mmd');
    fs.writeFileSync(inputPath, code, 'utf8');
  }

  // Puppeteer config that points at an existing Chromium, if found
  const chromium = findChromium();
  const puppeteerConfig = {
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  };
  if (chromium) puppeteerConfig.executablePath = chromium;
  const ppConfigPath = path.join(tmpDir, 'puppeteer-config.json');
  fs.writeFileSync(ppConfigPath, JSON.stringify(puppeteerConfig), 'utf8');

  // Stage theme/config
  let configPath = null;
  const themeAbs = resolveThemeFile(theme, themeFile);
  if (themeAbs) {
    configPath = path.join(tmpDir, 'config.json');
    fs.copyFileSync(themeAbs, configPath);
  }

  const args = [
    '-i', inputPath,
    '-o', outAbs,
    '-p', ppConfigPath,
    '-w', String(cssWidth),
    '-s', String(scale),
  ];
  if (configPath) args.push('-c', configPath);
  if (background) args.push('-b', background);
  else if (fmt === 'png') args.push('-b', 'transparent'); // theme JSON sets background internally

  const proc = spawnSync(process.execPath, [mmdcEntry, ...args], { encoding: 'utf8' });
  // Clean temp eagerly except for debugging
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}

  if (proc.status !== 0) {
    const stderr = (proc.stderr || '').trim();
    const stdout = (proc.stdout || '').trim();
    throw new Error(`mmdc failed (exit ${proc.status}): ${stderr || stdout || 'no output'}`);
  }
  if (!fs.existsSync(outAbs)) {
    throw new Error(`mmdc reported success but ${outAbs} was not created.`);
  }

  let outWidth = null, outHeight = null;
  if (fmt === 'png') {
    try {
      const dim = readPngSize(outAbs);
      outWidth = dim.width;
      outHeight = dim.height;
    } catch (_) {}
  }

  return { path: outAbs, format: fmt, width: outWidth, height: outHeight };
}

// Minimal PNG size reader (no external deps).
function readPngSize(p) {
  const fd = fs.openSync(p, 'r');
  const buf = Buffer.alloc(24);
  fs.readSync(fd, buf, 0, 24, 0);
  fs.closeSync(fd);
  // PNG signature: 89 50 4E 47 0D 0A 1A 0A then IHDR at offset 8
  if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) {
    throw new Error('not a PNG');
  }
  // width: bytes 16-19, height: bytes 20-23 (big-endian)
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return { width, height };
}

// Cache key helper that consumers can use to dedupe renders.
function cacheKey({ code, file, theme = 'microsoft-light', scale = 2, cssWidth = 1600 }) {
  const h = crypto.createHash('sha1');
  if (code) h.update('CODE:').update(code);
  if (file) h.update('FILE:').update(fs.readFileSync(file));
  h.update('|').update(theme).update('|').update(String(scale)).update('|').update(String(cssWidth));
  return h.digest('hex');
}

module.exports = { renderMermaid, cacheKey, findChromium, resolveMmdc };
