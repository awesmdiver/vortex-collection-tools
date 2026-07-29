#!/usr/bin/env node
'use strict';
// Merge Plugins (The Forge) -- the ONE place xelib actually gets touched. Runs in its own isolated
// child process (spawned by lib/merge-runner.js), never inside the long-lived Express server
// process -- confirmed during the Part A feasibility spike that `xelib.init()` cannot be cleanly
// re-initialized within the same Node process after a prior `close()` (a real crash, not just an
// error), so every analyze/merge request gets a brand-new process, mirroring
// lib/state-query-worker.js's own isolated-worker pattern for the same "a native crash here must
// not take down the whole app" reason.
//
// Protocol (matches state-query-worker.js's own convention):
//   stdin:  one JSON line { mode: 'analyze'|'merge', items: [{fullPath, fileName}], outputPath,
//            lightPluginLimit, gameDataDir }
//   stdout: one JSON line on success (shape depends on mode, see below)
//   stderr: '##PROGRESS## ' + JSON progress lines during 'merge' mode; plain text on a real error
//
// v1.0 scope (per design/BUILD-PROMPT-the-forge.md's "v1.0 scope" section, decided from the Part A
// spike): only the proven NEW-RECORD path (`!isOverride && !isInjected`, copied with `asNew=true`)
// is merged. Any chosen plugin containing so much as ONE override/injected record is reported back
// (via 'analyze') with `containsOverrides: true` and the CALLER (web/merge-routes.js) is expected
// to exclude it from the actual 'merge' request entirely -- this worker does not attempt to merge
// an override-containing plugin's records at all in v1.0. See TECHNICAL.md's "Merge engine"
// section for why (the `asNew=false` preserve-FormID path was never proven in the spike).

const fs = require('fs');
const path = require('path');
const os = require('os');
const xelib = require('xeditlib');
const { readPluginHeader } = require('./esp-header');
const { buildDummyPluginBuffer } = require('./esp-writer');

const HEADER_FLAGS_PATH = 'File Header\\Record Header\\Record Flags';

function reportProgress(current, total, label) {
    process.stderr.write('##PROGRESS## ' + JSON.stringify({ current, total, label }) + '\n');
}

function readStdin() {
    return new Promise((resolve, reject) => {
        let data = '';
        process.stdin.on('data', (c) => { data += c; });
        process.stdin.on('end', () => resolve(data));
        process.stdin.on('error', reject);
    });
}

// GetAllFlags returns the header's valid flag names as ONE comma-separated string (empty entries
// for reserved/unused bit positions), not one array element per flag -- a real gotcha hit during
// the Part A proof. Never guess the literal string "ESL" without confirming it's actually offered
// at this path on this file.
function findEslFlagName(fileHandle) {
    const raw = xelib.getAllFlags(fileHandle, HEADER_FLAGS_PATH);
    const names = (raw[0] || '').split(',').map((f) => f.trim()).filter(Boolean);
    return names.find((f) => /^esl$/i.test(f)) || null;
}

// Windows can hold a locked handle on a file inside the sandbox for a brief moment after
// xelib.close() returns (the native DLL's own memory-mapped-file teardown isn't necessarily
// synchronous with the FFI call returning) -- confirmed real 2026-07-28: a live Review-step test
// hit "EPERM, Permission denied" on this exact rmSync right after a successful close(). maxRetries
// + retryDelay is Node's own documented fix for this class of transient Windows lock, so lean on
// that instead of a hand-rolled sleep/retry loop.
//
// Deliberately swallows its own failure (logs to stderr instead of throwing): this always runs
// inside a `finally` block, and a `finally` that throws silently replaces whatever real error the
// try block was already propagating -- confirmed real 2026-07-28, this exact masking hid a genuine
// merge-loop error behind a useless generic EPERM message. A leftover temp sandbox directory is a
// harmless, low-cost failure (a few KB in the OS temp folder, never touches real game data) next to
// losing the actual error message.
function removeSandbox(sandboxRoot) {
    try {
        fs.rmSync(sandboxRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (e) {
        process.stderr.write(`(cleanup warning, non-fatal: could not remove temp sandbox ${sandboxRoot}: ${e.message})\n`);
    }
}

// Prefer a sandbox location on the SAME drive as the real Data folder so staged masters can be
// hardlinked in (instant, zero extra disk use) instead of copied (Skyrim.esm alone is several
// hundred MB). A sibling folder next to Data, never inside it -- this project's own standing rule
// is to never write generated files into the live Data folder itself. Falls back to the OS temp
// folder (cross-drive copy only) when no game Data folder is configured.
function pickSandboxParent(gameDataDir) {
    if (gameDataDir) {
        const parent = path.join(path.dirname(gameDataDir), '.vct-merge-tmp');
        try {
            fs.mkdirSync(parent, { recursive: true });
            return parent;
        } catch (e) { /* fall through to the OS temp folder below */ }
    }
    return os.tmpdir();
}

// Stages a master file into the sandbox: hardlink from the real Data folder when possible (same
// drive, instant, no extra disk use), copy as a fallback (e.g. cross-drive), or a zero-record dummy
// (esp-writer.js's own "Create Dummy Master" technique) when the real file isn't available at all.
// A dummy is enough for xelib's loader to resolve the master by name, but NOT enough for
// copyElement/addRequiredMasters on a record that references an actual FormID inside that master
// (confirmed real 2026-07-28: an HDPT "new" record's Extra Part list pointed at a real Skyrim.esm
// FormID -- copyElement threw a bare, detail-free "CopyElement failed" against a dummy master, and
// only succeeded once the real Skyrim.esm was staged instead). Real masters are the correct default;
// the dummy fallback only covers the rare case a declared master genuinely isn't installed (in which
// case the *chosen plugin itself* is almost certainly non-functional missing that master anyway --
// this fallback avoids a hard crash, not silently guarantee a correct merge for that one plugin).
function stageMaster(masterName, dataDir, gameDataDir) {
    const destPath = path.join(dataDir, masterName);
    const realPath = gameDataDir ? path.join(gameDataDir, masterName) : null;
    if (realPath && fs.existsSync(realPath)) {
        try {
            fs.linkSync(realPath, destPath);
            return;
        } catch (e) {
            fs.copyFileSync(realPath, destPath);
            return;
        }
    }
    fs.writeFileSync(destPath, buildDummyPluginBuffer(masterName));
}

// Copies every chosen plugin into a throwaway sandbox "Data" folder so xelib (which resolves
// plugins by filename against ONE game-root Data folder, not scattered real paths) can load them
// together, regardless of which real staging folder each one actually lives in. Detects filename
// collisions up front (two different mods coincidentally shipping an identically-named plugin) and
// refuses cleanly rather than silently letting one overwrite the other.
// Returns { sandboxRoot, masterNames } -- masterNames is every declared master that had to be
// staged (in discovery order), which the caller MUST load BEFORE the chosen items themselves (see
// loadAll's own comment for why).
function stageItems(items, gameDataDir) {
    const sandboxRoot = fs.mkdtempSync(path.join(pickSandboxParent(gameDataDir), 'vct-merge-'));
    const dataDir = path.join(sandboxRoot, 'Data');
    fs.mkdirSync(dataDir, { recursive: true });
    const seen = new Set();
    for (const item of items) {
        const key = item.fileName.toLowerCase();
        if (seen.has(key)) {
            removeSandbox(sandboxRoot);
            throw new Error(`Two chosen plugins share the same file name ("${item.fileName}") from different mods -- remove one before merging.`);
        }
        seen.add(key);
        fs.copyFileSync(item.fullPath, path.join(dataDir, item.fileName));
    }

    // xelib's loader also hard-fails ("Loader failed", no detail from getExceptionMessage/
    // getMessages) if a plugin's declared master isn't physically present in the sandbox's Data
    // folder at all -- confirmed real 2026-07-28 with Loverboy_Eyes.esl/Eyes of Aber.esl (both
    // declare Skyrim.esm).
    const masterNames = [];
    for (const item of items) {
        const header = readPluginHeader(item.fullPath);
        for (const masterName of header?.masters || []) {
            const key = masterName.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            masterNames.push(masterName);
            stageMaster(masterName, dataDir, gameDataDir);
        }
    }
    return { sandboxRoot, masterNames };
}

function initXelibAt(gameRoot) {
    xelib.init();
    xelib.setLanguage('English');
    xelib.setGamePath(gameRoot);
    xelib.setGameMode(xelib.GM_SSE);
    xelib.clearMessages();
}

// fileNames MUST list every master before any plugin that depends on it -- confirmed real
// 2026-07-28: the loader fails (with an unhelpfully empty exception message) if a master is merely
// present on disk but not listed ahead of its dependents in this same call, even though nothing in
// xeditlib's own docs states that ordering requirement.
async function loadAll(fileNames) {
    xelib.loadPlugins(fileNames.join('\n'), false, false);
    await xelib.waitForLoader();
    xelib.clearMessages();
}

// Every record on a plugin that's genuinely new (not an override, not injected into another
// file's own record group) -- the only kind v1.0 merges. Also flags whether any such record is a
// CELL/WRLD-type signature (the ESPFE "risky cell/worldspace override" caution from
// docs/reference-espfe.md), and reports the plugin's own declared masters (read straight from its
// TES4 header via lib/esp-header.js -- cheaper than round-tripping through xelib for this, and
// doesn't require the file to even be loaded).
function analyzeFile(fileHandle, fullPath) {
    const header = readPluginHeader(fullPath);
    const masters = header?.masters || [];
    const records = xelib.getRecords(fileHandle, '', true);
    let newRecordCount = 0;
    let overrideCount = 0;
    let hasCellOrWorldspace = false;
    for (const rec of records) {
        const isOverride = xelib.isOverride(rec) || xelib.isInjected(rec);
        if (isOverride) {
            overrideCount++;
        } else {
            newRecordCount++;
            const sig = xelib.signature(rec);
            if (sig === 'CELL' || sig === 'WRLD') hasCellOrWorldspace = true;
        }
        xelib.release(rec);
    }
    return {
        recordCount: records.length,
        newRecordCount,
        containsOverrides: overrideCount > 0,
        hasCellOrWorldspace,
        masters,
    };
}

async function runAnalyze(items, gameDataDir) {
    const { sandboxRoot, masterNames } = stageItems(items, gameDataDir);
    try {
        initXelibAt(sandboxRoot + path.sep);
        await loadAll([...masterNames, ...items.map((i) => i.fileName)]);
        const results = items.map((item) => {
            const fh = xelib.fileByName(item.fileName);
            const info = analyzeFile(fh, item.fullPath);
            return { fileName: item.fileName, ...info };
        });
        xelib.close();
        return { results };
    } finally {
        removeSandbox(sandboxRoot);
    }
}

// A record copied with asNew=true gets a fresh top-level FormID, but xelib does NOT rewrite FormID
// references embedded WITHIN the record's own data (self-references, references to sibling records
// in the same source plugin) -- those still point at the original file, which is why a naive
// per-record asNew=true copy leaves the destination still requiring every source plugin as a master
// (confirmed real 2026-07-28: even a single, fully self-contained QUST record from a zero-master
// plugin still required its own source file as a master after copying). This is not an edge case --
// it defeats the entire point of merging plugins to free up plugin slots, since the originals could
// never actually be disabled afterward.
//
// The fix (verified against zEdit-Revised's own real source -- src/javascripts/Services/merge/
// recordMergingService.js's "Clean" method, the project's own default merge method) is a proper
// copy-then-refactor sequence:
//   1. Copy every new record preserving its ORIGINAL FormID (asNew=false) -- internal references
//      keep resolving correctly at this intermediate stage since nothing's been renumbered yet.
//   2. xelib.buildReferences(outFile) on the DESTINATION -- populates its internal reference graph,
//      required for step 3's automatic reference-fixing to find every place a FormID is used.
//   3. xelib.setFormID(rec, newFormId, false, true) for each copied record, assigning a fresh
//      compact FormID -- the fixRefs=true param (matching zEdit's BuildReferences+SetFormID combo)
//      rewrites every reference to that record's old FormID (both the record's own internal fields
//      and any sibling record's references to it) to the new one.
//   4. xelib.cleanMasters(outFile) -- now that nothing internal points at the original files
//      anymore, this actually drops them from the destination's own master list.
async function runMerge(items, outputPath, lightPluginLimit, gameDataDir) {
    const { sandboxRoot, masterNames } = stageItems(items, gameDataDir);
    try {
        initXelibAt(sandboxRoot + path.sep);
        await loadAll([...masterNames, ...items.map((i) => i.fileName)]);

        const outFile = xelib.addFile(path.basename(outputPath));

        let hasCellOrWorldspace = false;
        const copiedRecords = [];
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            reportProgress(i + 1, items.length, `Copying records from ${item.fileName}…`);
            const fh = xelib.fileByName(item.fileName);
            const records = xelib.getRecords(fh, '', true);
            for (const rec of records) {
                // v1.0 only merges new-record plugins -- the caller (web/merge-routes.js) is
                // expected to have already excluded anything containing overrides, but this
                // double-checks per-record rather than trusting that blindly (an override record
                // slipping through would corrupt the destination silently otherwise).
                if (xelib.isOverride(rec) || xelib.isInjected(rec)) {
                    xelib.release(rec);
                    continue;
                }
                const sig = xelib.signature(rec);
                if (sig === 'CELL' || sig === 'WRLD') hasCellOrWorldspace = true;
                // addRequiredMasters MUST run before copyElement regardless of asNew -- confirmed
                // real 2026-07-28 via a minimal repro: copyElement on its own threw a bare
                // "CopyElement failed" (getMessages()/getExceptionMessage() both came back empty,
                // no useful detail) on a plain QUST record with zero declared masters of its own.
                xelib.addRequiredMasters(rec, outFile, false);
                const newRec = xelib.copyElement(rec, outFile, false); // asNew=false -- preserve FormID until the renumber pass below
                copiedRecords.push(newRec);
                xelib.release(rec);
            }
        }
        const totalNewRecords = copiedRecords.length;

        reportProgress(items.length, items.length, 'Renumbering FormIDs and fixing references…');
        xelib.buildReferences(outFile);
        let nextFormId = 0x000801; // Creation Kit's own default starting local FormID for new content
        for (const rec of copiedRecords) {
            xelib.setFormID(rec, nextFormId, false, true); // fixRefs=true -- rewrites every reference to this record's old FormID
            nextFormId++;
            xelib.release(rec);
        }

        xelib.cleanMasters(outFile);
        const remainingMasters = xelib.getMasterNames(outFile);
        const originalFileNames = items.map((i) => i.fileName.toLowerCase());
        const stillRequiresOriginals = remainingMasters.filter((m) => originalFileNames.includes(m.toLowerCase()));
        if (stillRequiresOriginals.length > 0) {
            // Never silently save a merge that didn't actually achieve its one job -- this would
            // mislead the user into disabling plugins the output still secretly depends on.
            throw new Error(`The merge could not fully drop its dependency on: ${stillRequiresOriginals.join(', ')}. This means the merged file would still need those originals enabled -- nothing was saved.`);
        }

        const qualifies = totalNewRecords <= lightPluginLimit && !hasCellOrWorldspace;
        let eslFlagged = false;
        let qualificationReason = null;
        if (qualifies) {
            const eslFlagName = findEslFlagName(outFile);
            if (eslFlagName) {
                xelib.setFlag(outFile, HEADER_FLAGS_PATH, eslFlagName, true);
                eslFlagged = true;
            } else {
                qualificationReason = 'Could not find the ESL flag on this file header -- left as a full .esp.';
            }
        } else if (hasCellOrWorldspace) {
            qualificationReason = 'Contains cell/worldspace records, which is too risky to ESL-flag automatically.';
        } else {
            qualificationReason = `${totalNewRecords} new records is over the ${lightPluginLimit}-record light-plugin limit.`;
        }

        xelib.saveFile(outFile, outputPath);
        xelib.close();
        return { recordCount: totalNewRecords, eslFlagged, qualificationReason, outputPath, remainingMasters };
    } finally {
        removeSandbox(sandboxRoot);
    }
}

async function main() {
    const input = JSON.parse(await readStdin());
    const { mode, items, outputPath, lightPluginLimit, gameDataDir } = input;
    if (!Array.isArray(items) || items.length === 0) throw new Error('No plugins were provided to merge.');

    let result;
    if (mode === 'analyze') {
        result = await runAnalyze(items, gameDataDir);
    } else if (mode === 'merge') {
        if (!outputPath) throw new Error('No output path was provided for the merge.');
        result = await runMerge(items, outputPath, lightPluginLimit || 4096, gameDataDir);
    } else {
        throw new Error(`Unknown mode "${mode}".`);
    }
    process.stdout.write(JSON.stringify(result));
}

main().catch((e) => {
    try { xelib.close(); } catch (_) { /* already closed or never opened -- fine either way */ }
    // Trailing newline matters -- lib/merge-runner.js's stderr reader buffers by line and only
    // ever flushes a line once it sees '\n'; a final line with no trailing newline sat in that
    // buffer forever and was silently dropped (confirmed real 2026-07-28: a genuine per-plugin
    // error came back as the generic CRASH_HELP_TEXT instead of the actual message).
    process.stderr.write((e.message || String(e)) + '\n');
    process.exit(1);
});
