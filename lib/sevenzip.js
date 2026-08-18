'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CANDIDATE_PATHS = [
  // Bundled copy first (self-contained release zip, see README's "Self-contained release
  // packaging") -- checked ahead of any system install so a release always runs against the
  // exact 7-Zip build it was tested with, regardless of what (if anything) is installed on the
  // tester's machine.
  path.join(__dirname, '..', 'tools', '7-Zip', '7z.exe'),
  'C:\\Program Files\\7-Zip\\7z.exe',
  'C:\\Program Files (x86)\\7-Zip\\7z.exe',
];

function findSevenZip() {
  for (const p of CANDIDATE_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  return '7z'; // fall back to PATH
}

function run(exePath, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(exePath, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

// Parses `7z l -slt` output into an array of { path, size, isDir }.
// Blocks are separated by blank lines. Before the real member blocks there are several
// banner/status blocks (version banner, "Scanning the drive...", "Listing archive: ...") AND an
// archive-info block that itself has a "Path = <archive path>" line (plus "Type = "/"Physical
// Size = ") -- confirmed via real `7z l -slt` output. The number of banner/status blocks isn't
// fixed (varies with 7-Zip version/verbosity), so a fixed "skip blocks[0]" index is unreliable,
// and it let the archive-info block through as a bogus zero-size file entry (path = the archive's
// own absolute path) that corrupted downstream mod-root/prefix detection for "simple" (non-FOMOD)
// mods. The reliable, FORMAT-AGNOSTIC signal to exclude it is a "Type = " field (the archive
// format: zip/7z/rar) -- confirmed present on the archive-info block and absent from every real
// member block in BOTH .zip and .7z output. A "Folder = " field is NOT a safe signal: .zip emits
// it per-member, but .7z never emits it at all (confirmed against a real .7z listing) -- an
// earlier version of this fix used "Folder" and silently discarded every entry in .7z archives.
function parseSlt(stdout) {
  const blocks = stdout.split(/\r?\n\r?\n/);
  const entries = [];
  for (const block of blocks) {
    if (!block.includes('Path = ')) continue;
    const fields = {};
    for (const line of block.split(/\r?\n/)) {
      const idx = line.indexOf(' = ');
      if (idx === -1) continue;
      fields[line.slice(0, idx)] = line.slice(idx + 3);
    }
    if (!fields.Path || fields.Type !== undefined) continue;
    // Windows attribute letters (R=read-only, A=archive, S=system, H=hidden, D=directory, ...)
    // are independent flags that can appear in any combination/order -- confirmed via a real RAR
    // archive where a directory's own entry had "Attributes = RD" (read-only + directory). A
    // startsWith('D') check missed this (only matched a bare "D"), silently misclassifying the
    // directory as a 0-byte "file" -- which then got extracted as a real file, colliding with the
    // same-named directory its own children live under. Check for 'D' anywhere in the flag set,
    // not just at the start.
    const attrs = fields.Attributes || '';
    const isDir = attrs.includes('D');
    entries.push({
      path: fields.Path,
      size: fields.Size ? parseInt(fields.Size, 10) || 0 : 0,
      isDir,
    });
  }
  return entries;
}

async function listArchive(exePath, archivePath) {
  // -sccUTF-8 (console charset) is required for non-ASCII filenames -- without it, 7-Zip silently
  // substitutes '_' for any character it can't represent in the system's default console codepage
  // WHEN PRINTING THE LISTING, even though the archive's actual internal filename table (and real
  // extraction) is correct Unicode throughout. Confirmed directly: a real archive's genuine
  // "276 полный.xml" (Cyrillic) came back from `l -slt` (no -sccUTF-8) as "276 ______.xml" --
  // six real Cyrillic characters each replaced with a literal underscore. That mangled name then
  // can never match anything on extraction ("No files to process", exit code 0 -- no error to
  // catch), so the mod's REBUILT result would have been missing that file. Do NOT confuse this
  // with -scsUTF-8 (charset for reading a LISTFILE on extraction) -- different flag, different
  // purpose, both needed where each applies.
  const { code, stdout, stderr } = await run(exePath, ['l', '-slt', '-sccUTF-8', archivePath]);
  if (code !== 0) {
    throw new Error(`7z exited ${code}: ${stderr.trim() || stdout.trim()}`);
  }
  return parseSlt(stdout);
}

// Extracts a single member (internalPath) from archivePath into destDir,
// flattening directory structure (member ends up directly in destDir).
async function extractFile(exePath, archivePath, internalPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const args = ['e', archivePath, `-o${destDir}`, '-y', internalPath];
  const { code, stdout, stderr } = await run(exePath, args);
  if (code !== 0) {
    throw new Error(`7z extract exited ${code}: ${stderr.trim() || stdout.trim()}`);
  }
  const extractedName = path.basename(internalPath);
  const extractedPath = path.join(destDir, extractedName);
  if (!fs.existsSync(extractedPath)) {
    throw new Error(`Extraction reported success but file not found at ${extractedPath}`);
  }
  return extractedPath;
}

// Extracts MANY archive members in ONE 7z invocation, preserving their internal archive-relative
// paths under destDir (destDir/<internalPath> per member). Replaces the old approach of calling
// extractFileTo() in a loop -- spawning a fresh 7z.exe (full process start + archive header
// re-parse) for EVERY resolved file -- confirmed directly responsible for turning a mod PeaZip
// extracts whole in ~5s into a multi-minute ordeal here (KS Hairdos SSE, hundreds of files).
// Uses a 7z "listfile" (@file) rather than passing paths as CLI args, since Windows caps a command
// line around ~8191 chars and some mods here have hundreds of files. -scsUTF-8 avoids mojibake for
// non-ASCII archive paths (the same class of encoding bug already hit once in this project, for
// ModuleConfig.xml).
async function extractMany(exePath, archivePath, internalPaths, destDir) {
  if (internalPaths.length === 0) return;
  fs.mkdirSync(destDir, { recursive: true });
  const listFile = path.join(destDir, '.filelist.txt');
  fs.writeFileSync(listFile, internalPaths.join('\r\n') + '\r\n', 'utf8');
  try {
    const args = ['x', archivePath, `-o${destDir}`, '-y', '-scsUTF-8', `@${listFile}`];
    const { code, stdout, stderr } = await run(exePath, args);
    if (code !== 0) {
      throw new Error(`7z extract exited ${code}: ${stderr.trim() || stdout.trim()}`);
    }
  } finally {
    fs.rmSync(listFile, { force: true });
  }
}

module.exports = { findSevenZip, listArchive, extractFile, extractMany };
