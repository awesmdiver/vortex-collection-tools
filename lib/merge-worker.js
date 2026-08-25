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
const { resolveLoadList } = require('./merge-preflight');

const HEADER_FLAGS_PATH = 'File Header\\Record Header\\Record Flags';

function reportProgress(current, total, label) {
    process.stderr.write('##PROGRESS## ' + JSON.stringify({ current, total, label }) + '\n');
}

// 6-hex-digit uppercase local FormID string, matching zEdit-Revised's own xelib.Hex(id, 6) format
// (relinker.js/recordMergingService.js both key their FormID maps this exact way -- see
// buildFidMap's own header comment).
function formatFid(id) {
    return (id & 0xFFFFFF).toString(16).toUpperCase().padStart(6, '0');
}

// Marks one of this worker's OWN intentional, already-friendly messages (BUILD-PROMPT-merge-error-
// handling.md) -- filename collision, no-plugins/no-output-path, "Unknown mode", and the
// dependency-drop failure below are the only ones. main()'s catch handler tags exactly these with
// a ##USERERR## stderr prefix; lib/merge-runner.js only ever surfaces a message verbatim when it
// carries that marker -- everything else (native xelib errors like "Loader failed", an unmarked
// crash) falls back to its own generic CRASH_HELP_TEXT instead. Defensive by default: a future
// thrown Error that forgets to use this helper safely falls back too, rather than leaking raw text.
function userError(message) {
    const err = new Error(message);
    err.isUserFacing = true;
    return err;
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
        // Hardened 2026-07-30 (BUILD-PROMPT-merge-error-handling.md) -- a real tester's Skyrim sits
        // on a C: Steam install, prime territory for Defender to hold the file lock longer than the
        // original 5x200ms budget covered. More patience here is cheap; a leftover sandbox dir isn't.
        fs.rmSync(sandboxRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    } catch (e) {
        // ##WARN## (not ##USERERR##) -- this is the non-fatal cleanup warning itself, and must NEVER
        // reach the user (see BUILD-PROMPT-merge-error-handling.md's root cause: this exact text
        // leaked to a tester's screen verbatim). lib/merge-runner.js skips ##WARN## lines outright,
        // same as it already skips ##PROGRESS##.
        process.stderr.write(`##WARN## (cleanup warning, non-fatal: could not remove temp sandbox ${sandboxRoot}: ${e.message})\n`);
    }
}

// Best-effort sweep of leftover vct-merge-* sandboxes from a prior run that never got cleaned up
// (BUILD-PROMPT-merge-error-handling.md) -- e.g. a crash between stageItems and the finally
// block's removeSandbox call, or an EPERM that outlasted even the hardened retry budget above.
// Ignores every failure entirely: this is opportunistic housekeeping on the way to starting a NEW
// run, never allowed to block or fail it.
function sweepStaleSandboxes(parent) {
    let entries;
    try {
        entries = fs.readdirSync(parent, { withFileTypes: true });
    } catch (e) {
        return;
    }
    for (const entry of entries) {
        if (entry.isDirectory() && entry.name.startsWith('vct-merge-')) {
            try {
                fs.rmSync(path.join(parent, entry.name), { recursive: true, force: true });
            } catch (e) { /* still locked, or another run's active sandbox -- leave it, try again next time */ }
        }
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
            sweepStaleSandboxes(parent);
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
//
// Returns { sandboxRoot, loadOrder } -- loadOrder is EVERY file staged (chosen items and pulled-in
// masters alike) already sorted so each master precedes everything that depends on it. The caller
// hands it to loadAll verbatim; there is no longer a separate masters-then-items concatenation to
// get wrong at the call site.
//
// lib/merge-preflight.js's resolveLoadList does the actual work, and its header comment carries the
// full story of the two defects this replaced (a one-level-deep master walk, and discovery order
// standing in for dependency order). Sharing that one implementation with the pre-flight check is
// deliberate: the list validated before the merge starts is bit-for-bit the list that gets staged,
// so the two can never drift into disagreeing about what will be loaded.
function stageItems(items, gameDataDir) {
    const sandboxRoot = fs.mkdtempSync(path.join(pickSandboxParent(gameDataDir), 'vct-merge-'));
    const dataDir = path.join(sandboxRoot, 'Data');
    fs.mkdirSync(dataDir, { recursive: true });
    const seen = new Set();
    for (const item of items) {
        const key = item.fileName.toLowerCase();
        if (seen.has(key)) {
            removeSandbox(sandboxRoot);
            throw userError(`Two chosen plugins share the same file name ("${item.fileName}") from different mods -- remove one before merging.`);
        }
        seen.add(key);
    }

    // xelib's loader also hard-fails if a plugin's declared master isn't physically present in the
    // sandbox's Data folder at all -- confirmed real 2026-07-28 with Loverboy_Eyes.esl/Eyes of
    // Aber.esl (both declare Skyrim.esm). The failure mode is inconsistent and never points at the
    // real culprit: sometimes a detail-free "Loader failed", sometimes a System Error Code 2
    // ("cannot find the file specified") naming a plugin that is demonstrably sitting right there in
    // the sandbox -- because what's actually unresolvable is that plugin's own master reference.
    const { order } = resolveLoadList(items, gameDataDir);
    for (const entry of order) {
        if (entry.kind === 'item') {
            fs.copyFileSync(entry.sourcePath, path.join(dataDir, entry.fileName));
        } else {
            stageMaster(entry.fileName, dataDir, gameDataDir);
        }
    }
    return { sandboxRoot, loadOrder: order.map((e) => e.fileName) };
}

// ---- Output parity with zEdit-Revised's own zMerge (2026-08-17) -- director's own real
// side-by-side comparison (a real zMerge build of this exact merge, still on disk at
// "F:\Skyrim zMerge Files\Diziet's Player Home Bath - Merge") showed our tool was missing three
// categories of output zMerge produces alongside the merged .esp itself: MCM translation files,
// a .seq (Story Manager "Start Game Enabled" quest) file, and a log of what happened. zEdit-Revised
// is open source (the director's own fork, github.com/awesmdiver/zedit-revised) -- both features
// below are ported from its real source rather than guessed from the output shape alone:
// src/javascripts/Runners/assetHandlers/mcmTranslationHandler.js and
// src/javascripts/Services/merge/seqService.js.
//
// fidCache.json/map.json (also present in zMerge's own output folder) are deliberately NOT
// reproduced -- they exist to support zEdit's own "update this merge later, keep FormIDs stable
// for save compatibility" feature. This tool has no incremental-rebuild feature (every merge is a
// fresh full build), so there is nothing that would ever read them back -- they would be inert
// metadata nobody consumes. Skip unless/until an update-merge feature is actually built.

const TRANSLATIONS_DIR = 'interface\\translations';

// zEdit's own mcmTranslationHandler.js searches the REAL, currently-active Skyrim Data folder for
// each merged plugin's translation files (`useGameDataFolder: true`), NOT that plugin's own mod
// staging folder -- confirmed by reading its source, then verified empirically: the director's own
// real zMerge output has EVERY language's content identical (all-English), while the source mod's
// OWN staging copy of the same files has genuine per-language text (real French, German, etc.).
// The cause: some other currently-active mod is winning the Data-folder conflict for
// `interface\translations\dz_undress_common_*.txt` with an English-only stub, and zMerge -- like
// the real game at runtime -- reads whatever is ACTUALLY currently active in Data, not any one
// mod's own original intent. Mirroring that (rather than reading each plugin's own staging folder,
// as originally speced) is the correct choice for a merge tool: the whole point of merging is to
// preserve exactly what the game currently sees, not to quietly upgrade content the player wasn't
// actually getting before the merge either.
function findGameTranslationFiles(gameDataDir, pluginBaseName) {
    const dir = path.join(gameDataDir, TRANSLATIONS_DIR);
    let entries;
    try {
        entries = fs.readdirSync(dir);
    } catch {
        return [];
    }
    const prefix = pluginBaseName.toLowerCase();
    return entries.filter((name) => {
        const lower = name.toLowerCase();
        return lower.startsWith(prefix) && lower.endsWith('.txt');
    }).map((name) => path.join(dir, name));
}

// Matches mcmTranslationHandler.js's loadTranslations/saveTranslations exactly: language suffix is
// each matched file's own basename with the plugin's own basename prefix stripped (e.g.
// "dz_undress_common_english" -> "_english"), and when more than one merged plugin contributes a
// translation for the SAME language, their content is concatenated (double-CRLF separated, in
// plugin/items order) into one file for that language -- SkyUI's own MCM translation loader parses
// the whole file as one flat token list regardless of which plugin a line originally came from.
function copyTranslationFiles(items, gameDataDir, outputDir, mergedBaseName) {
    if (!gameDataDir) return [];
    const byLanguage = new Map();
    for (const item of items) {
        const pluginBaseName = path.basename(item.fileName, path.extname(item.fileName));
        for (const filePath of findGameTranslationFiles(gameDataDir, pluginBaseName)) {
            const fileBaseName = path.basename(filePath, path.extname(filePath));
            const language = fileBaseName.toLowerCase().replace(pluginBaseName.toLowerCase(), '');
            let content;
            try {
                content = fs.readFileSync(filePath, 'utf16le');
            } catch {
                continue; // unreadable -- skip this one file rather than fail the whole merge over it
            }
            if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1); // strip the BOM char before concatenating
            const existing = byLanguage.get(language);
            byLanguage.set(language, existing ? existing + '\r\n\r\n' + content : content);
        }
    }
    if (byLanguage.size === 0) return [];
    const outDir = path.join(outputDir, 'interface', 'translations');
    fs.mkdirSync(outDir, { recursive: true });
    const written = [];
    for (const [language, content] of byLanguage) {
        const fileName = `${mergedBaseName.toLowerCase()}${language}.txt`;
        fs.writeFileSync(path.join(outDir, fileName), '\uFEFF' + content, 'utf16le');
        written.push(path.join('interface', 'translations', fileName));
    }
    return written;
}

const SEQ_FLAG = 'Start Game Enabled';

// Ported from seqService.js's buildSeqFile/getSeqQuests. zEdit's own version branches on whether
// each QUST record's own master is ALSO fully absorbed into the merge (masterIsMerged) vs. is
// itself SEQ-flagged in an untouched master (masterIsSEQ, skipped -- that quest's SEQ entry
// already exists on the original, unmerged master and doesn't need a second one). Both branches
// only matter for a record that OVERRIDES another file's own QUST record. This tool's v1.0 scope
// never merges overrides at all (lib/merge-worker.js's runMerge only ever copies
// `!isOverride && !isInjected` records) -- every QUST record present in our own merged output is
// therefore, by construction, always a brand-new record this file itself owns, so that branching
// is dead code here and is deliberately not ported; every SEQ-flagged QUST record in the output
// gets an entry, unconditionally.
//
// The FormID fixup (`fid & 0x00FFFFFF | masterCount << 24`) re-derives each record's own top byte
// (its "local to this file" self-index, i.e. its file's OWN declared master count) from the CURRENT
// master list -- read AFTER cleanMasters has already dropped the merged-away originals, since the
// top byte baked in by the earlier setFormID renumbering pass reflected the LARGER, pre-cleanMasters
// master list. Verified empirically against the director's own real zMerge output: its merged file
// declares exactly 27 masters (0x1B), and its real .seq file's 3 FormIDs all carry top byte 0x1B
// with the low 3 bytes matching this same file's own QUST record FormIDs exactly.
function buildSeqFile(outFile, outputDir, mergedBaseName) {
    // hasElement first, not a bare getElement -- getElement THROWS if the path doesn't resolve
    // (confirmed by reading node_modules/xeditlib/xelib.js: `if (!raw.GetElement(...)) fail(...)`),
    // and a merge with zero QUST records at all (the common case) has no QUST group whatsoever.
    if (!xelib.hasElement(outFile, 'QUST')) return null;
    const questGroup = xelib.getElement(outFile, 'QUST');
    const masterCount = xelib.getMasterNames(outFile).length;
    const formIds = [];
    const quests = xelib.getElements(questGroup);
    for (const qust of quests) {
        if (xelib.hasElement(qust, 'DNAM\\Flags') && xelib.getFlag(qust, 'DNAM\\Flags', SEQ_FLAG)) {
            const fid = xelib.getFormID(qust, true);
            formIds.push((fid & 0x00FFFFFF) | (masterCount << 24));
        }
        xelib.release(qust);
    }
    xelib.release(questGroup);
    if (formIds.length === 0) return null;
    const outDir = path.join(outputDir, 'seq');
    fs.mkdirSync(outDir, { recursive: true });
    const fileName = `${mergedBaseName}.seq`;
    const buffer = Buffer.alloc(formIds.length * 4);
    formIds.forEach((fid, i) => buffer.writeUInt32LE(fid, i * 4));
    fs.writeFileSync(path.join(outDir, fileName), buffer);
    return path.join('seq', fileName);
}

// Plain-language summary saved next to the merged plugin -- deliberately NOT a copy of zEdit's own
// raw engine trace (its real log opens with 800+ lines of "Loading resources from X.bsa" before
// anything about the actual merge). Mirrors this app's own established reporting voice instead
// (see Update Collection's/Rebuild Collection's own result summaries).
function buildMergeLog({ mergedName, outputPath, items, recordCount, overrideRecordCount, eslFlagged, qualificationReason, translationFiles, seqFile, residualDependents }) {
    const lines = [];
    lines.push(`Merge: ${mergedName}`);
    lines.push(`Built: ${new Date().toISOString()}`);
    lines.push('');
    lines.push(`Output: ${outputPath}`);
    lines.push(eslFlagged ? 'Flagged as a light plugin (ESL) -- it won\'t use up a real plugin slot.' : `Left as a full .esp -- ${qualificationReason || 'did not qualify for the ESL flag.'}`);
    lines.push(`${recordCount} new record${recordCount === 1 ? '' : 's'} copied in.`);
    if (overrideRecordCount) lines.push(`${overrideRecordCount} override record${overrideRecordCount === 1 ? '' : 's'} carried over too, still changing the same original targets they always did.`);
    lines.push('');
    lines.push(`Plugins merged (${items.length}):`);
    for (const item of items) lines.push(`  - ${item.fileName}${item.modName ? ` (${item.modName})` : ''}`);
    if (translationFiles.length) {
        lines.push('');
        lines.push(`Translation files carried over (${translationFiles.length}):`);
        for (const f of translationFiles) lines.push(`  - ${f}`);
    }
    if (seqFile) {
        lines.push('');
        lines.push(`Story Manager quest file created: ${seqFile}`);
    }
    if (residualDependents.length) {
        lines.push('');
        lines.push('Heads up -- these plugins still need one of the merged originals as a master and were NOT included in this merge:');
        for (const dep of residualDependents) lines.push(`  - ${dep.fileName} (needs ${dep.neededFor.join(', ')})`);
    }
    return lines.join('\r\n') + '\r\n';
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
// xeditlib's own docs states that ordering requirement. Re-confirmed the hard way 2026-08-23, when a
// real merge died on a plugin whose master sat seventeen slots too late in the list.
//
// Nothing here re-sorts: callers pass stageItems' own `loadOrder`, which lib/merge-preflight.js's
// resolveLoadList already topologically sorted. That is the ONE place the ordering rule is enforced,
// so it cannot be satisfied in one call path and quietly missed in another.
async function loadAll(fileNames) {
    xelib.loadPlugins(fileNames.join('\n'), false, false);
    await xelib.waitForLoader();
    xelib.clearMessages();
}

// Both new records (no master, brand-new content) and override records (isOverride/isInjected --
// modifies an EXISTING record in some OTHER, not-being-merged plugin) are mergeable -- see
// runMerge's own header comment for why overrides were originally excluded, and why that turned out
// to be an overly conservative v1.0 scope decision rather than a real engine limitation (2026-08-17
// investigation, TECHNICAL.md's own "Override records ARE mergeable" section has the full story).
// `containsOverrides`/`overrideCount` are now purely INFORMATIONAL (surfaced in the Review step so
// the user knows some records will keep referencing an external master, never a reason to exclude
// the plugin from the merge). CELL/WRLD risk-flagging now covers BOTH kinds -- an override of an
// existing cell/worldspace is at least as risky to ESL-flag as a brand-new one, arguably more so.
// Reports the plugin's own declared masters (read straight from its TES4 header via
// lib/esp-header.js -- cheaper than round-tripping through xelib for this, and doesn't require the
// file to even be loaded).
function analyzeFile(fileHandle, fullPath) {
    const header = readPluginHeader(fullPath);
    const masters = header?.masters || [];
    const records = xelib.getRecords(fileHandle, '', true);
    let newRecordCount = 0;
    let overrideCount = 0;
    let hasCellOrWorldspace = false;
    for (const rec of records) {
        const isOverride = xelib.isOverride(rec) || xelib.isInjected(rec);
        if (isOverride) overrideCount++; else newRecordCount++;
        const sig = xelib.signature(rec);
        if (sig === 'CELL' || sig === 'WRLD') hasCellOrWorldspace = true;
        xelib.release(rec);
    }
    return {
        recordCount: records.length,
        newRecordCount,
        overrideCount,
        containsOverrides: overrideCount > 0,
        hasCellOrWorldspace,
        masters,
    };
}

async function runAnalyze(items, gameDataDir) {
    const { sandboxRoot, loadOrder } = stageItems(items, gameDataDir);
    try {
        initXelibAt(sandboxRoot + path.sep);
        await loadAll(loadOrder);
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
//   1. Copy every record preserving its ORIGINAL FormID (asNew=false) -- internal references keep
//      resolving correctly at this intermediate stage since nothing's been renumbered yet.
//   2. xelib.buildReferences(outFile) on the DESTINATION -- populates its internal reference graph,
//      required for step 3's automatic reference-fixing to find every place a FormID is used.
//   3. xelib.setFormID(rec, newFormId, false, true) for each NEW record ONLY, assigning a fresh
//      compact FormID -- the fixRefs=true param (matching zEdit's BuildReferences+SetFormID combo)
//      rewrites every reference to that record's old FormID (both the record's own internal fields
//      and any sibling record's references to it) to the new one.
//   4. xelib.cleanMasters(outFile) -- now that nothing internal points at the merged-away originals
//      anymore, this actually drops THEM from the destination's own master list (a master an
//      override still legitimately depends on, per step 3's own carve-out below, correctly stays).
//
// Override records ARE mergeable (2026-08-17, corrected the same day it first shipped) -- v1.0
// originally skipped any record where `isOverride(rec) || isInjected(rec)` was true, treating
// "contains overrides" as disqualifying. That turned out to be an overly conservative scope
// decision, not a real engine limitation: investigated against 6 real plugins the director hit this
// on (all from "GTS Community Edition"/"ESLifier Output") by dumping every flagged record's own
// detail directly via xelib -- EVERY one was a genuine override of a real record in some OTHER,
// unrelated, NOT-being-merged plugin (e.g. a horse-mod patch overriding its own companion's NPC_
// record in that companion's own separate mod file) -- never a false positive, never a record from
// one of the OTHER plugins in the same merge. zEdit-Revised's own Clean method merges these plugins
// successfully (confirmed via the director's own real zMerge run of the identical 6 files), which is
// what prompted re-examining whether this tool's OWN already-Clean-method engine could too.
//
// The key insight, verified with an isolated spike before touching this function: an override
// record copied via copyElement(rec, outFile, false) -- SAME call as a new record, asNew=false --
// and then left alone (no setFormID renumber pass) keeps pointing at the exact same target FormID in
// its original master, so it goes on overriding that master's record exactly as before, in the new
// destination file too. Only records that started out genuinely NEW (no master of their own) get
// renumbered; renumbering an override would sever it from its target entirely, turning it into a
// disconnected, non-functional duplicate that silently drops whatever the source plugin actually
// changed -- confirmed empirically: re-opening a real test output in a completely fresh xelib
// session showed the copied override record still reading `isOverride=true` against its real target
// master, un-renumbered, while the plugin's own genuinely-new records got the usual compact
// sequential ids. The override's target master (e.g. the companion mod's own file) correctly remains
// a required master of the merged output -- exactly matching what the ORIGINAL, unmerged plugin
// already required, and exactly what zMerge's own Clean method output does too. `stillRequiresOriginals`
// below only ever checks whether one of the plugins ACTUALLY BEING MERGED remains a master, so this
// doesn't trip it.
async function runMerge(items, outputPath, lightPluginLimit, gameDataDir, residualDependents) {
    const { sandboxRoot, loadOrder } = stageItems(items, gameDataDir);
    try {
        initXelibAt(sandboxRoot + path.sep);
        await loadAll(loadOrder);

        const outFile = xelib.addFile(path.basename(outputPath));

        const newRecords = [];
        const overrideRecords = [];
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            reportProgress(i + 1, items.length, `Copying records from ${item.fileName}…`);
            const fh = xelib.fileByName(item.fileName);
            const records = xelib.getRecords(fh, '', true);
            for (const rec of records) {
                const isOverride = xelib.isOverride(rec) || xelib.isInjected(rec);
                // addRequiredMasters MUST run before copyElement regardless of asNew -- confirmed
                // real 2026-07-28 via a minimal repro: copyElement on its own threw a bare
                // "CopyElement failed" (getMessages()/getExceptionMessage() both came back empty,
                // no useful detail) on a plain QUST record with zero declared masters of its own.
                // Applies identically to an override record -- its target master is exactly the kind
                // of "required master" this call adds.
                xelib.addRequiredMasters(rec, outFile, false);
                const newRec = xelib.copyElement(rec, outFile, false); // asNew=false for BOTH kinds -- preserve FormID; only new records get renumbered below
                // pluginFileName carried alongside the handle (2026-08-18, Relink Scripts' own
                // prerequisite) so the renumber loop below can build map.json's own
                // { [pluginFileName]: { [oldFormId]: newFormId } } shape -- see buildFidMap's own
                // header comment for the real consumer this feeds.
                (isOverride ? overrideRecords : newRecords).push({ rec: newRec, pluginFileName: item.fileName });
                xelib.release(rec);
            }
        }
        const totalNewRecords = newRecords.length;

        reportProgress(items.length, items.length, 'Renumbering FormIDs and fixing references…');
        xelib.buildReferences(outFile); // populates the reference graph BEFORE any setFormID call below -- needed so fixRefs=true can find every place a renumbered record's old FormID was referenced, including from an override record that itself won't be renumbered
        let nextFormId = 0x000801; // Creation Kit's own default starting local FormID for new content
        const fidMap = {}; // { [pluginFileName]: { [oldFormIdHex6]: newFormIdHex6 } } -- see buildFidMap
        for (const { rec, pluginFileName } of newRecords) {
            const oldFidHex = formatFid(xelib.getFormID(rec, true)); // local fid BEFORE renumbering -- still the source's own original id at this point, copyElement(asNew=false) never touched it
            xelib.setFormID(rec, nextFormId, false, true); // fixRefs=true -- rewrites every reference to this record's old FormID
            if (!fidMap[pluginFileName]) fidMap[pluginFileName] = {};
            fidMap[pluginFileName][oldFidHex] = formatFid(nextFormId);
            nextFormId++;
            xelib.release(rec);
        }
        for (const { rec } of overrideRecords) {
            xelib.release(rec); // deliberately NOT renumbered -- see this function's own header comment
        }

        xelib.cleanMasters(outFile);
        const remainingMasters = xelib.getMasterNames(outFile);
        const originalFileNames = items.map((i) => i.fileName.toLowerCase());
        const stillRequiresOriginals = remainingMasters.filter((m) => originalFileNames.includes(m.toLowerCase()));
        if (stillRequiresOriginals.length > 0) {
            // Never silently save a merge that didn't actually achieve its one job -- this would
            // mislead the user into disabling plugins the output still secretly depends on.
            throw userError(`The merge could not fully drop its dependency on: ${stillRequiresOriginals.join(', ')}. This means the merged file would still need those originals enabled -- nothing was saved.`);
        }

        // Real bug fix (2026-08-24, merge-v1-drop-cellworldspace-gate) -- this used to also require
        // !hasCellOrWorldspace, silently refusing to Light-flag a v1 merge that was genuinely
        // FormID-range-eligible just because it happened to touch a CELL/WRLD record. Same wrong
        // assumption already found and fixed on the display side (web/public/merge-app.js's Review
        // step, commit 65a2835) and confirmed against the same real research merge-flag-as-light was
        // built on (lib/esp-light-flag.js, commit 1da834e): Vortex's own real LOOT-backed eligibility
        // check only looks at FormID range -- cell/worldspace edits are docs/reference-esp-vs-esl.md's
        // own documented CAUTION area, never a hard eligibility gate. Unlike the display-side fix,
        // this one is a REAL, live write path -- a v1 merge that qualifies here actually gets flagged
        // for real via xelib.setFlag below, so this was silently leaving genuinely-eligible real
        // merges as full .esp plugins. The per-record CELL/WRLD tracking that fed the old check is
        // removed too, not left computed-but-unread -- nothing in this function reads it anymore.
        // (analyzeFile's own separate copy, used for the Review-step's informational per-item display,
        // is untouched -- that data was never the problem here, only this function's own use of it as
        // a gate was.)
        const qualifies = totalNewRecords <= lightPluginLimit;
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
        } else {
            qualificationReason = `${totalNewRecords} new records is over the ${lightPluginLimit}-record light-plugin limit.`;
        }

        reportProgress(items.length, items.length, 'Writing translations and Story Manager data…');
        const mergedBaseName = path.basename(outputPath, path.extname(outputPath));
        const outputDir = path.dirname(outputPath);
        // outputPath already points inside this merge's own per-merge subfolder (web/merge-routes.js
        // computes it, matching zEdit-Revised's own zMerge layout) -- that subfolder doesn't exist
        // yet the first time a given merge name is used, and buildSeqFile below only creates its own
        // 'seq' subdirectory when there's actually a SEQ file to write, so this can't be skipped.
        fs.mkdirSync(outputDir, { recursive: true });
        const seqFile = buildSeqFile(outFile, outputDir, mergedBaseName);

        xelib.saveFile(outFile, outputPath);
        xelib.close();

        const translationFiles = copyTranslationFiles(items, gameDataDir, outputDir, mergedBaseName);

        const logContent = buildMergeLog({
            mergedName: mergedBaseName,
            outputPath,
            items,
            recordCount: totalNewRecords,
            overrideRecordCount: overrideRecords.length,
            eslFlagged,
            qualificationReason,
            translationFiles,
            seqFile,
            residualDependents: residualDependents || [],
        });
        const logPath = path.join(outputDir, `${mergedBaseName} - merge log.txt`);
        fs.writeFileSync(logPath, logContent, 'utf8');

        // map.json (2026-08-18) -- the old->new FormID map Relink Scripts actually reads back (see
        // lib/relink-scripts.js's buildFidMap, a direct port of zEdit-Revised's own relinker.js).
        // Nested in a `merge - <name>` subfolder, matching zMerge's own real placement exactly
        // (confirmed against the director's own real output on disk) -- unlike the merge log above,
        // which deliberately stayed flat at the per-merge subfolder's own root (no multi-file
        // metadata folder to justify nesting it, per that earlier task's own judgment call). This
        // one nests because map.json is metadata a DIFFERENT feature reads back programmatically,
        // not something a human opens directly.
        //
        // fidCache.json is deliberately NOT written here -- see TECHNICAL.md's own note on why:
        // zEdit's own fidCache.json exists purely to support ITS incremental "update this merge
        // later" rebuild feature (avoiding FormID collisions against a PRIOR build of the same
        // persistent merge). This tool has no such feature and no consumer would ever read it back
        // -- Relink Scripts (the one real new consumer as of this same task) only ever reads
        // map.json, confirmed by reading relinker.js's own buildFormIdMap directly.
        const mergeDataDir = path.join(outputDir, `merge - ${mergedBaseName}`);
        fs.mkdirSync(mergeDataDir, { recursive: true });
        fs.writeFileSync(path.join(mergeDataDir, 'map.json'), JSON.stringify(fidMap, null, 2), 'utf8');

        return {
            recordCount: totalNewRecords, overrideRecordCount: overrideRecords.length, eslFlagged, qualificationReason, outputPath, remainingMasters,
            translationFiles, seqFile, logPath, logContent, mergeDataDir,
        };
    } finally {
        removeSandbox(sandboxRoot);
    }
}

async function main() {
    const input = JSON.parse(await readStdin());
    const { mode, items, outputPath, lightPluginLimit, gameDataDir, residualDependents } = input;
    if (!Array.isArray(items) || items.length === 0) throw userError('No plugins were provided to merge.');

    let result;
    if (mode === 'analyze') {
        result = await runAnalyze(items, gameDataDir);
    } else if (mode === 'merge') {
        if (!outputPath) throw userError('No output path was provided for the merge.');
        result = await runMerge(items, outputPath, lightPluginLimit || 4096, gameDataDir, residualDependents);
    } else {
        throw userError(`Unknown mode "${mode}".`);
    }
    process.stdout.write(JSON.stringify(result));
}

main().catch((e) => {
    try { xelib.close(); } catch (_) { /* already closed or never opened -- fine either way */ }
    // ##USERERR## only ever goes out for a message this file itself built via userError() above --
    // everything else (a native xelib exception, some other unmarked throw) reaches merge-runner.js
    // unprefixed, which is exactly what makes it fall back to CRASH_HELP_TEXT there instead of
    // leaking raw text to the user.
    const prefix = e && e.isUserFacing ? '##USERERR## ' : '';
    // Trailing newline matters -- lib/merge-runner.js's stderr reader buffers by line and only
    // ever flushes a line once it sees '\n'; a final line with no trailing newline sat in that
    // buffer forever and was silently dropped (confirmed real 2026-07-28: a genuine per-plugin
    // error came back as the generic CRASH_HELP_TEXT instead of the actual message).
    process.stderr.write(prefix + (e.message || String(e)) + '\n');
    process.exit(1);
});
