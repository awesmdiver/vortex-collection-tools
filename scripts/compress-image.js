#!/usr/bin/env node
// Resizes + losslessly compresses a PNG for committing under assets/ -- the same "keep a full-res
// -original sibling, ship a shrunk working copy" pattern already used for every banner in this repo
// (see assets/*-original.png). Two stages, chosen specifically to never trade away sharpness:
//   1. sharp resizes to a target max width (never upscales) and re-saves as PNG at max LOSSLESS
//      compression (compressionLevel 9, palette forcing OFF so full color depth is kept) -- this is
//      where almost all the size reduction comes from (fewer pixels), with zero recompression
//      artifacts.
//   2. tools/oxipng/oxipng.exe re-encodes those SAME pixels with a slower/better DEFLATE strategy --
//      genuinely lossless (not one pixel changes), just squeezes another chunk of size for free.
// Deliberately does NOT use lossy palette-quantization tools (pngquant and friends) -- those get
// smaller files by reducing to a ~256-color palette, which can introduce visible banding on
// gradients/anti-aliased edges, exactly what this project's own banner art has plenty of.
//
// Usage:
//   node scripts/compress-image.js <input> [output] [--width 1280]
//   npm run compress-image -- <input> [output] [--width 1280]
//
// <input>  source image (anything sharp reads -- png/jpg/webp/etc. -- output is always PNG).
// [output] optional. If omitted, derived automatically ONLY when <input>'s filename ends in
//          "-original" (the established convention) by dropping that suffix -- e.g.
//          "release-v0.6.0-banner-original.png" -> "release-v0.6.0-banner.png". This never risks
//          overwriting the original: if the input doesn't end in "-original" and no output is
//          given, the script refuses rather than guessing.
// --width  target max width in pixels (default 1280, matching this repo's existing banners).
//
// tools/oxipng/oxipng.exe is gitignored (a downloaded binary, not source -- same convention
// lib/sevenzip.js already uses for tools/7-Zip/7z.exe) and auto-downloaded here on first use if
// missing, so a fresh clone needs nothing manual before this works.

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');
const sharp = require('sharp');

const OXIPNG_DIR = path.join(__dirname, '..', 'tools', 'oxipng');
const OXIPNG_EXE = path.join(OXIPNG_DIR, 'oxipng.exe');
const DEFAULT_WIDTH = 1280;

function parseArgs(argv) {
  const positional = [];
  let width = DEFAULT_WIDTH;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--width') width = Number(argv[++i]);
    else positional.push(argv[i]);
  }
  return { input: positional[0], explicitOutput: positional[1], width };
}

// Only auto-derives when it's unambiguous (the "-original" convention) -- otherwise returns null so
// the caller is forced to say explicitly where the compressed copy goes, never guessing in a way
// that could clobber the source.
function deriveOutput(input) {
  const ext = path.extname(input);
  const base = path.basename(input, ext);
  const suffix = '-original';
  if (!base.endsWith(suffix)) return null;
  return path.join(path.dirname(input), base.slice(0, -suffix.length) + ext);
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'vortex-collection-tools' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(fetchJson(res.headers.location));
      }
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'vortex-collection-tools' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(downloadFile(res.headers.location, dest));
      }
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', reject);
    }).on('error', reject);
  });
}

async function ensureOxipng() {
  if (fs.existsSync(OXIPNG_EXE)) return;
  console.log('tools/oxipng/oxipng.exe not found -- downloading it once (gitignored, like tools/7-Zip)...');
  const release = await fetchJson('https://api.github.com/repos/oxipng/oxipng/releases/latest');
  const asset = (release.assets || []).find((a) => /x86_64-pc-windows-msvc\.zip$/.test(a.name));
  if (!asset) throw new Error('Could not find a Windows x64 oxipng release asset -- check https://github.com/oxipng/oxipng/releases manually.');
  fs.mkdirSync(OXIPNG_DIR, { recursive: true });
  const zipPath = path.join(OXIPNG_DIR, 'oxipng.zip');
  await downloadFile(asset.browser_download_url, zipPath);
  execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -Path "${zipPath}" -DestinationPath "${OXIPNG_DIR}" -Force`]);
  const extractedDir = fs.readdirSync(OXIPNG_DIR).find((f) => f.startsWith('oxipng-') && fs.statSync(path.join(OXIPNG_DIR, f)).isDirectory());
  if (!extractedDir) throw new Error('oxipng zip did not contain the expected oxipng-* folder -- its layout may have changed.');
  const dir = path.join(OXIPNG_DIR, extractedDir);
  fs.renameSync(path.join(dir, 'oxipng.exe'), OXIPNG_EXE);
  const license = path.join(dir, 'LICENSE.txt');
  if (fs.existsSync(license)) fs.renameSync(license, path.join(OXIPNG_DIR, 'LICENSE.txt'));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(zipPath, { force: true });
  console.log('oxipng.exe ready.');
}

function mb(bytes) {
  return (bytes / 1e6).toFixed(2) + 'MB';
}

async function main() {
  const { input, explicitOutput, width } = parseArgs(process.argv.slice(2));
  if (!input) {
    console.error('Usage: node scripts/compress-image.js <input> [output] [--width 1280]');
    process.exit(2);
  }
  if (!fs.existsSync(input)) {
    console.error(`Input not found: ${input}`);
    process.exit(1);
  }
  const output = explicitOutput || deriveOutput(input);
  if (!output) {
    console.error(
      `Can't tell where the compressed copy should go. Either name the input "*-original.png" ` +
      `(so it becomes "*.png" automatically) or pass an explicit output path:\n` +
      `  node scripts/compress-image.js ${input} <output.png>`
    );
    process.exit(2);
  }
  if (path.resolve(output) === path.resolve(input)) {
    console.error(`Refusing to overwrite the input in place (${input}) -- pass a different output path.`);
    process.exit(2);
  }

  await ensureOxipng();

  const beforeSize = fs.statSync(input).size;
  const image = sharp(input);
  const meta = await image.metadata();
  const targetWidth = meta.width && meta.width > width ? width : null; // never upscale
  let pipeline = image;
  if (targetWidth) pipeline = pipeline.resize({ width: targetWidth });
  const buffer = await pipeline.png({ compressionLevel: 9, adaptiveFiltering: true, palette: false }).toBuffer();
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, buffer);
  console.log(`Resize: ${meta.width}px -> ${targetWidth || meta.width}px | lossless PNG re-save: ${mb(beforeSize)} -> ${mb(buffer.length)}`);

  execFileSync(OXIPNG_EXE, ['-o', 'max', '--strip', 'safe', output], { stdio: 'inherit' });
  const afterOxi = fs.statSync(output).size;
  console.log(`oxipng lossless squeeze: ${mb(buffer.length)} -> ${mb(afterOxi)}`);
  console.log(`Done: ${output} (${mb(beforeSize)} -> ${mb(afterOxi)}, ${(100 - (afterOxi / beforeSize) * 100).toFixed(0)}% smaller, no quality loss)`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
