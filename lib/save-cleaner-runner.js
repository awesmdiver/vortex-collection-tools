'use strict';
// Save Cleaner -- headless wrapper around the bundled ReSaver_Renewed.exe (a fork of FallrimTools
// ReSaver), same "bundled path with dev-machine fallback" convention web/pgpatcher-routes.js already
// established for pgtools.exe. See design/mockup-save-cleaner.html for the full design writeup.
//
// The exe's own real CLI shape (three subcommands, one JSON object on stdout per call, exit 0/1) is
// documented in full in F:\Claude Workspace\skyrim-modding\fallrimtools-resaver-renewed's own commit
// 02e8065 / prompts/handoff-latest.md -- reused here exactly as shipped, nothing guessed:
//   report <save.ess> [--data-dir <path>]                          -- read-only
//   clean  <save.ess> [--categories=...] [--reset-havok] [--purify-formlists]  -- never writes
//   save   <save.ess> --out <path> [same clean options]             -- writes both .ess + .skse
//
// Unlike pgtools.exe (a long-running native process whose stdout is parsed line-by-line for
// progress), ReSaver_Renewed's report/clean/save each print exactly ONE JSON object at the very end
// and exit -- there is no incremental progress channel to relay. web/save-cleaner-routes.js still
// wraps each call in the app's usual SSE session so the UI gets a real "this is running" phase state
// (matching every other tool's own progress convention), it just can't be byte-precise the way the
// mockup's own screenshot shows -- see that route file's own header comment for why.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const RESAVER_EXE_CANDIDATES = [
    path.join(__dirname, '..', 'tools', 'resaver-renewed', 'ReSaver_Renewed.exe'),
    'F:\\Claude Workspace\\skyrim-modding\\fallrimtools-resaver-renewed\\dist\\ReSaver_Renewed\\ReSaver_Renewed.exe',
];

function resolveResaverExe() {
    for (const p of RESAVER_EXE_CANDIDATES) {
        if (fs.existsSync(p)) return p;
    }
    return RESAVER_EXE_CANDIDATES[0]; // bundled path -- best "expected" location for the not-found message
}

const RESAVER_EXE = resolveResaverExe();

function isResaverInstalled() {
    return fs.existsSync(RESAVER_EXE);
}

// Every category key the CLI recognizes -- kept in sync with fallrimtools-resaver-renewed's own
// CleanOperations.ALL_CATEGORIES (resaver/cli/CleanOperations.java). Filtering against this here,
// not just trusting whatever the frontend sends, is the same defensive habit this app already
// applies to mergePostMergeAction (web/settings-routes.js) -- an unrecognized value silently
// reaching the exe's own argument parser would either error confusingly or (worse) be ignored.
const CATEGORY_KEYS = ['unattached', 'undefined', 'missing-parent', 'no-parent'];

function runResaver(args, { onSpawn } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(RESAVER_EXE, args, { windowsHide: true });
        if (onSpawn) onSpawn(child);
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
}

// The CLI's own stdout contract is ONE JSON object, success or failure (see its own JsonWriter/
// CliErrors) -- this is the single place that unwraps it, so every caller gets a real JS object
// back or a real thrown Error, never a raw exit code + stdout string to re-parse themselves.
function parseResaverResult({ code, stdout, stderr }, context) {
    let parsed;
    try {
        parsed = JSON.parse(stdout.trim());
    } catch (e) {
        const detail = stderr.trim() || stdout.trim() || e.message;
        throw new Error(`ReSaver_Renewed ${context} produced no valid JSON output (exit ${code}). ${detail}`.trim());
    }
    if (!parsed.ok) {
        throw new Error(parsed.error || `ReSaver_Renewed ${context} failed.`);
    }
    return parsed;
}

function buildCleanArgs(subcommand, essPath, { categories = [], resetHavok, purifyFormLists, outPath } = {}) {
    const args = [subcommand, essPath];
    const validCategories = categories.filter((c) => CATEGORY_KEYS.includes(c));
    if (validCategories.length) args.push('--categories', validCategories.join(','));
    if (resetHavok) args.push('--reset-havok');
    if (purifyFormLists) args.push('--purify-formlists');
    if (outPath) args.push('--out', outPath);
    return args;
}

// Step 1b/2 -- read-only. `dataDir` (optional) is the real Skyrim Data folder, enabling the CLI's
// own "is this orphaned script's name currently shipped by anything installed" flag; web/save-
// cleaner-routes.js layers this app's OWN real mod/collection-name resolution on top of that plain
// boolean afterward (see that file's own header comment -- the CLI can only ever say yes/no, never
// name a specific already-uninstalled mod).
async function report(essPath, { dataDir, onSpawn } = {}) {
    const args = ['report', essPath];
    if (dataDir) args.push('--data-dir', dataDir);
    const result = await runResaver(args, { onSpawn });
    return parseResaverResult(result, 'report');
}

// Step 3->4 preview -- never writes to disk (verified for real: scripts/test-merge-history-rename-
// delete.js's own sibling test in the fork, F:\...\fallrimtools-resaver-renewed\..., confirmed via
// MD5 before/after).
async function clean(essPath, opts = {}) {
    const args = buildCleanArgs('clean', essPath, opts);
    const result = await runResaver(args, { onSpawn: opts.onSpawn });
    return parseResaverResult(result, 'clean');
}

// Step 5/5b -- reloads and re-cleans internally (a fresh CLI process has no live heap from a prior
// `clean` call; see the fork's own handoff for why `save` is designed this way), then writes. Always
// given an explicit `outPath` -- this module never decides a filename or default-overwrites
// anything; web/save-cleaner-routes.js is the one place that resolves what path to pass in, always
// from either the native Save dialog or an explicit "replace this file" confirmation.
async function saveAs(essPath, outPath, opts = {}) {
    const args = buildCleanArgs('save', essPath, { ...opts, outPath });
    const result = await runResaver(args, { onSpawn: opts.onSpawn });
    return parseResaverResult(result, 'save');
}

module.exports = { RESAVER_EXE, isResaverInstalled, CATEGORY_KEYS, report, clean, saveAs };
