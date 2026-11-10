'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const appConfig = require('./app-config');

const BUNDLED_PATH = path.join(__dirname, '..', 'tools', '7-Zip', '7z.exe');
const STANDARD_PATHS = [
  'C:\\Program Files\\7-Zip\\7z.exe',
  'C:\\Program Files (x86)\\7-Zip\\7z.exe',
];

// Search order: bundled copy, the path the person picked with "Locate 7-Zip" (config `sevenZipPath`),
// the VCT_7ZIP_EXE override, the standard install folders, then PATH.
//   - Bundled first (self-contained release zip, see README's "Self-contained release packaging"):
//     a release always runs against the exact 7-Zip build it was tested with.
//   - VCT_7ZIP_EXE is a developer override for a 7z.exe outside the usual places; never set on a
//     player's PC. No developer folder is hard-coded here (the 1.6.0 rule).
// Config is read fresh on every call (a located path takes effect with no restart); a missing or
// unreadable config just means "nothing saved".
function candidatePaths() {
  let saved = null;
  try { saved = appConfig.loadConfig().sevenZipPath; } catch { /* no config yet */ }
  return [BUNDLED_PATH, saved, process.env.VCT_7ZIP_EXE, ...STANDARD_PATHS].filter(Boolean);
}

function findSevenZip() {
  for (const p of candidatePaths()) {
    if (fs.existsSync(p)) return p;
  }
  return '7z'; // fall back to PATH
}

// A spawn failure means 7-Zip itself could not be started (not found, not runnable) -- the tool is
// missing, which says nothing about whichever archive was being read. Checked on a thrown error
// (err.code) and on a stored scan_error string ("spawn 7z ENOENT").
const TOOL_ERROR_CODES = ['ENOENT', 'EACCES', 'EPERM', 'EFTYPE', 'UNKNOWN'];
const TOOL_ERROR_RE = new RegExp(`^spawn .* (${TOOL_ERROR_CODES.join('|')})$`);

function isSevenZipUnavailable(errOrMessage) {
  if (!errOrMessage) return false;
  if (typeof errOrMessage === 'object' && errOrMessage.syscall && String(errOrMessage.syscall).startsWith('spawn')
    && TOOL_ERROR_CODES.includes(errOrMessage.code)) return true;
  const message = typeof errOrMessage === 'string' ? errOrMessage : String(errOrMessage.message || '');
  return TOOL_ERROR_RE.test(message.trim());
}

// Starts 7-Zip once and throws only if it cannot be started at all (any exit code is fine).
async function probe(exePath) {
  await run(exePath, ['-h']);
}

// Checks a file the person picked really is a runnable 7-Zip: starts it with the harmless help flag
// and looks for 7-Zip's own banner. Returns { ok: true } or { ok: false, reason }.
async function verifySevenZip(exePath) {
  if (!exePath || !fs.existsSync(exePath) || !fs.statSync(exePath).isFile()) {
    return { ok: false, reason: 'not-found' };
  }
  try {
    const { stdout, stderr } = await run(exePath, ['-h']);
    return /7-Zip/i.test(`${stdout}\n${stderr}`) ? { ok: true } : { ok: false, reason: 'not-7zip' };
  } catch {
    return { ok: false, reason: 'not-runnable' };
  }
}

// Kills a child AND everything it started (7-Zip can have helpers), only the one pid we spawned.
function killTree(child) {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill());
  } else {
    child.kill('SIGKILL');
  }
}

// Why scans used to hang (2026-10-28): the child's stdin was left as an open pipe. A password-
// protected .7z (encrypted file names) makes 7-Zip print "Enter password" and WAIT for input that
// never comes -- idle, no CPU, forever -- while the same command run by hand with input closed fails
// at once. stdin is now closed ('ignore'), so 7-Zip gets end-of-input and reports an error instead.
//
// opts.timeoutMs: kill the child (tree) after this long and reject with err.code 'SEVENZIP_TIMEOUT'.
// opts.control: an object the caller keeps; run() sets control.kill(reason) so the caller can abort
// this one child ('SEVENZIP_SKIPPED' / 'SEVENZIP_STOPPED'). Rejected errors carry .stdoutBytes and
// .output (the first part of what the child printed) for the one log line.
function run(exePath, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(exePath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let killedFor = null;
    let timer = null;
    const kill = (code) => {
      if (killedFor) return;
      killedFor = code;
      killTree(child);
    };
    child.stdout.on('data', (d) => { stdout += d; stdoutBytes += d.length; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (killedFor) {
        const err = new Error(`7-Zip was stopped (${killedFor})`);
        err.code = killedFor;
        err.stdoutBytes = stdoutBytes;
        err.output = `${stdout}${stderr}`.replace(/\s+/g, ' ').trim().slice(0, 200);
        return reject(err);
      }
      resolve({ code, stdout, stderr });
    });
    if (opts.control) opts.control.kill = (reason) => kill(reason);
    if (opts.timeoutMs) timer = setTimeout(() => kill('SEVENZIP_TIMEOUT'), opts.timeoutMs);
  });
}

// Real, confirmed 7-Zip 26.x bug (2026-08-28): some real, healthy ZIP archives trip "Incorrect
// reparse stream" on a specific entry's own metadata (an NTFS extra field 7-Zip's own extraction
// code misreads as a reparse point/symlink) even though the file is a completely ordinary text/
// binary entry -- confirmed directly against a real mod archive (a tiny "framework" mod, just an
// ESP + a placeholder text file, re-downloaded fresh from Nexus and still failing the same way, so
// not a corrupt/truncated download either): PeaZip's own opener flags the same file with a similar
// warning but still extracts it fine, and PowerShell's `Expand-Archive` (a completely different,
// .NET-based zip reader, no 7-Zip involved at all) extracts every entry with zero errors. Only
// applies to .zip -- Expand-Archive can't read .7z/.rar, but this failure mode is itself specific to
// ZIP's own NTFS extra-field encoding, so those formats were never at risk of it anyway.
function isReparseStreamError(message) {
  return /incorrect reparse stream/i.test(message);
}

// Paths reach PowerShell through environment variables, never inside the command text: PowerShell
// counts the curly quotes U+2018 to U+201B as quotes, so doubling '' alone is not enough.
function psEnvArgs(values) {
  const env = { ...process.env };
  const refs = values.map((v, i) => {
    env[`VCT_PS_ARG_${i}`] = String(v).replace(/\0/g, '');
    return `$env:VCT_PS_ARG_${i}`;
  });
  return { env, refs };
}

// Async (spawn, not spawnSync) -- this project's own established rule (see rebuild-mod.js's
// runExtract header comment): a sync child-process call here would block the ENTIRE web server for
// as long as PowerShell takes, not just this one request.
function runPowerShell(scriptLines, env) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', scriptLines.join('; ')], { windowsHide: true, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

// Extracts EVERY member of a .zip via PowerShell's Expand-Archive into a private scratch folder
// under destDir, then copies just the requested internalPaths out of it -- matching extractFile/
// extractMany's own "only these members land in destDir" contract exactly, rather than dumping the
// whole archive in. Returns false (never throws) on anything short of a full, verified success --
// this is a fallback for one specific, narrow 7-Zip failure mode, not a general-purpose replacement
// extractor, so any surprise here should fall through to the caller's own original 7z error rather
// than silently half-applying a different one.
async function extractViaPowerShellFallback(archivePath, internalPaths, destDir) {
  if (path.extname(archivePath).toLowerCase() !== '.zip') return false;
  const scratchDir = path.join(destDir, `.ps-reparse-fallback-${process.pid}-${Date.now()}`);
  try {
    fs.mkdirSync(scratchDir, { recursive: true });
    const { env, refs } = psEnvArgs([archivePath, scratchDir]);
    const { code } = await runPowerShell([
      `Expand-Archive -LiteralPath ${refs[0]} -DestinationPath ${refs[1]} -Force`,
    ], env);
    if (code !== 0) return false;
    for (const internalPath of internalPaths) {
      if (!fs.existsSync(path.join(scratchDir, internalPath))) return false;
    }
    for (const internalPath of internalPaths) {
      const dest = path.join(destDir, internalPath);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.cpSync(path.join(scratchDir, internalPath), dest, { recursive: true });
    }
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
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

async function listArchive(exePath, archivePath, opts = {}) {
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
  const { code, stdout, stderr } = await run(exePath, ['l', '-slt', '-sccUTF-8', archivePath], opts);
  if (code !== 0) {
    // With input closed, 7-Zip's password prompt ends in a bare "Break signaled"; name it plainly.
    if (/enter password/i.test(stdout)) throw new Error(`7z exited ${code}: Enter password (this archive is password protected)`);
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
  const extractedName = path.basename(internalPath);
  const extractedPath = path.join(destDir, extractedName);
  if (code !== 0) {
    const detail = stderr.trim() || stdout.trim();
    // See extractViaPowerShellFallback's own header comment -- real 7-Zip 26.x bug, not a bad
    // archive. extractFile's own contract flattens to just the basename, so this is a smaller,
    // one-member version of extractMany's own fallback rather than a shared helper.
    if (isReparseStreamError(detail) && path.extname(archivePath).toLowerCase() === '.zip') {
      const scratchDir = path.join(destDir, `.ps-reparse-fallback-${process.pid}-${Date.now()}`);
      try {
        fs.mkdirSync(scratchDir, { recursive: true });
        const { env, refs } = psEnvArgs([archivePath, scratchDir]);
        const ps = await runPowerShell([`Expand-Archive -LiteralPath ${refs[0]} -DestinationPath ${refs[1]} -Force`], env);
        const scratchFile = path.join(scratchDir, internalPath);
        if (ps.code === 0 && fs.existsSync(scratchFile)) {
          fs.cpSync(scratchFile, extractedPath);
          return extractedPath;
        }
      } finally {
        fs.rmSync(scratchDir, { recursive: true, force: true });
      }
    }
    throw new Error(`7z extract exited ${code}: ${detail}`);
  }
  if (!fs.existsSync(extractedPath)) {
    throw new Error(`Extraction reported success but file not found at ${extractedPath}`);
  }
  return extractedPath;
}

// Per-member fallback (2026-08-31, director's own real incident + explicit ask): a single bad member
// inside an otherwise-healthy archive (confirmed real: a reparse-stream-tripping .txt file) used to
// block extraction of the WHOLE mod -- extractMany() either got everything or threw, nothing in
// between. Vortex's own native install doesn't work that way -- confirmed directly against Vortex's
// real source (InstallManager.ts's queryContinue): its "Archive damaged... Continue" dialog just
// proceeds with whatever 7-Zip already wrote to the temp folder, skipping only the member(s) that
// genuinely failed. This mirrors that, one member at a time (preserving each one's own internal path
// under destDir, same contract as the bulk extraction below) -- only ever reached once the bulk
// attempt AND the whole-archive PowerShell fallback have both already failed. Returns which members
// were skipped (empty array = every member DID extract, just not in one shot) so the caller can tell
// the user "one file in this package couldn't be extracted, let the mod author know" instead of
// failing the whole mod. Throws only if EVERY member failed -- that's a genuinely different, more
// serious failure than "one bad file in an otherwise-good archive," and there'd be nothing left to
// proceed with anyway.
async function extractPerMember(exePath, archivePath, internalPaths, destDir) {
  const skipped = [];
  for (const internalPath of internalPaths) {
    const { code, stdout, stderr } = await run(exePath, ['x', archivePath, `-o${destDir}`, '-y', '-scsUTF-8', internalPath]);
    const destFullPath = path.join(destDir, internalPath);
    if (code !== 0 || !fs.existsSync(destFullPath)) {
      skipped.push({ path: internalPath, error: stderr.trim() || stdout.trim() || 'extraction failed' });
    }
  }
  if (skipped.length === internalPaths.length) {
    throw new Error(`Every member failed to extract from this archive: ${skipped[0].error}`);
  }
  return skipped;
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
//
// Return value (2026-08-31): an array of skipped members ({path, error}), NOT void -- empty means a
// full, ordinary success. Backward compatible with every existing caller that ignored the old void
// return; a caller that wants to warn about partial extraction reads this array instead of relying on
// a thrown error, since a partial failure no longer throws (see extractPerMember above).
async function extractMany(exePath, archivePath, internalPaths, destDir) {
  if (internalPaths.length === 0) return [];
  fs.mkdirSync(destDir, { recursive: true });
  const listFile = path.join(destDir, '.filelist.txt');
  fs.writeFileSync(listFile, internalPaths.join('\r\n') + '\r\n', 'utf8');
  try {
    const args = ['x', archivePath, `-o${destDir}`, '-y', '-scsUTF-8', `@${listFile}`];
    const { code, stdout, stderr } = await run(exePath, args);
    if (code !== 0) {
      const detail = stderr.trim() || stdout.trim();
      // See extractViaPowerShellFallback's own header comment -- real 7-Zip 26.x bug, not a bad
      // archive.
      if (isReparseStreamError(detail) && await extractViaPowerShellFallback(archivePath, internalPaths, destDir)) {
        return [];
      }
      // Bulk attempt (and the reparse-stream PS fallback, where applicable) both failed -- fall back
      // to one-member-at-a-time rather than failing the whole mod outright.
      return await extractPerMember(exePath, archivePath, internalPaths, destDir);
    }
    return [];
  } finally {
    fs.rmSync(listFile, { force: true });
  }
}

module.exports = { run, findSevenZip, candidatePaths, isSevenZipUnavailable, probe, verifySevenZip, listArchive, extractFile, extractMany };
