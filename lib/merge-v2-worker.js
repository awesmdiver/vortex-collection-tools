#!/usr/bin/env node
'use strict';
// Merge Plugins v2 -- a direct port of zEdit-Revised's own zMerge engine (MIT, Colin Allen
// (matortheeternal), https://github.com/z-edit/zedit -- our fork skyrim-modding/zedit-revised),
// built from docs/plans/2026-08-24-merge-port-spec.md. Every phase below is named for, and traced
// against, that spec's own citations into zedit-revised/src/javascripts/Services/merge/*.js and the
// director's real ground-truth log
// (G:\zEdit Renewed\merges\merge_plugin_test\merge - merge_plugin_test\merge_2026_08_23_13_55.txt).
//
// Built ALONGSIDE lib/merge-worker.js, not in place of it (director's own call, 2026-08-24: "let's
// not destroy the current code, let's archive/save it before we build something new"). This file,
// lib/merge-v2-runner.js, and merge-plugins.THIRD-PARTY-NOTICES entry are the only new pieces;
// lib/merge-worker.js, lib/merge-runner.js and lib/merge-preflight.js are UNCHANGED and untouched by
// this port. merge-preflight.js's resolveLoadList is reused here unmodified for the staging closure
// (which files to copy in) -- its own load-list ORDER is not used for xelib.LoadPlugins, since the
// spec found zMerge's own method differs (xelib.GetLoadOrder() filtered to the closure, not a
// file-derived topological sort) -- see readGameLoadOrderV2 below.
//
// Method scope: CLEAN ONLY (recordMergingService.js's copyAndRefactor / mergeMasterService.js's
// addMastersToMergedPlugin+cleanMasters). Clean is zMerge's own default (mergeBuilder.js:4) and the
// only method the director's real run used. Clobber/Master are NOT implemented -- Clobber mutates
// the user's own source plugins, which is a materially different safety story per the spec's own
// module-map note, and neither was requested.
//
// NOT YET PORTED (explicit gaps, not silent ones -- see the handoff for the full coverage table):
//   - Asset handling (mergeAssetService.js + the 9 Runners/assetHandlers/*.js: BSA, face data, voice,
//     billboards, string files, translations, INI files, dialog views, general assets).
//   - SEQ file is ported (seqService.js) but UNTESTED -- the director's real 30-plugin scenario has
//     zero SEQ-flagged quests on either engine, confirmed by both logs.
//   - .esm output's SetIsESM equivalent is implemented via SetFlag on a best-guess flag name and is
//     UNTESTED -- every real test case outputs a .esp.
//   - AddAllMasters has no binding in this project's xeditlib wrapper (node_modules/xeditlib/xelib.js
//     -- confirmed by grep, it is not exposed). Its effect (all-masters-added-up-front) is
//     reproduced by calling addRequiredMasters per record immediately before copyElement, same as
//     lib/merge-worker.js already does -- safe here (unlike there) because the destination is always
//     the LAST-loaded file once the load order is corrected (see readGameLoadOrderV2), so no master's
//     load order can ever equal or exceed the destination's, which is exactly the condition
//     AddRequiredMasters (xedit-reference/Core/wbImplementation.pas:19258) raises on.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const xelib = require('xeditlib');
const { readPluginHeader } = require('./esp-header');
const { buildDummyPluginBuffer } = require('./esp-writer');
const { resolveLoadList } = require('./merge-preflight');

function reportProgress(current, total, label) {
    process.stderr.write('##PROGRESS## ' + JSON.stringify({ current, total, label }) + '\n');
}

function userError(message) {
    const err = new Error(message);
    err.isUserFacing = true;
    return err;
}

// 6-hex-digit uppercase LOCAL FormID string -- matches zEdit's own xelib.Hex(id, 6) / GetHexFormID
// key shape, confirmed against the real fidCache.json/map.json ("000800", "00080C", ...).
function hex6(id) {
    return (id & 0xFFFFFF).toString(16).toUpperCase().padStart(6, '0');
}

// ---- staging (reuses merge-preflight.js's resolveLoadList for the closure SET; the load ORDER
// handed to xelib is computed separately below, per the spec's finding that zMerge's method differs
// from that file's own topological sort) ----
function pickSandboxParent(gameDataDir) {
    if (gameDataDir) {
        const parent = path.join(path.dirname(gameDataDir), '.vct-merge-v2-tmp');
        try { fs.mkdirSync(parent, { recursive: true }); return parent; } catch { /* fall through */ }
    }
    return os.tmpdir();
}

// realDataListing: a case-insensitive lookup of gameDataDir's REAL directory entries, built once per
// merge and passed in. Root cause this exists to fix (2026-08-24, found while chasing a casing
// mismatch against zMerge's real output): a master's declared name in the DEPENDENT plugin's own
// header (what merge-preflight.js's resolveLoadList reports as entry.fileName) is often cased
// differently than the master file's REAL on-disk name -- e.g. "DT_Hjertesten Hall.esp" declared,
// "dt_hjertesten hall.esp" actually on disk. Staging under the declared casing means our sandbox's
// own directory listing (which xelib.getLoadOrder() reads back inside the sandbox) reports that
// wrong casing, and it ends up baked into the merged output's master list. zMerge never hits this --
// it runs directly against the real Data folder, so it only ever sees the real casing. Staging under
// the REAL on-disk name reproduces that.
function stageMaster(masterName, dataDir, gameDataDir, realDataListing) {
    const real = realDataListing && realDataListing.get(masterName.toLowerCase());
    const onDiskName = real || masterName;
    const destPath = path.join(dataDir, onDiskName);
    const realPath = gameDataDir ? path.join(gameDataDir, onDiskName) : null;
    if (realPath && fs.existsSync(realPath)) {
        try { fs.linkSync(realPath, destPath); return onDiskName; } catch { fs.copyFileSync(realPath, destPath); return onDiskName; }
    }
    fs.writeFileSync(destPath, buildDummyPluginBuffer(onDiskName));
    return onDiskName;
}

function buildRealDataListing(gameDataDir) {
    const map = new Map();
    if (!gameDataDir) return map;
    try { for (const f of fs.readdirSync(gameDataDir)) map.set(f.toLowerCase(), f); } catch { /* left empty -- falls back to declared casing */ }
    return map;
}

// Returns { sandboxRoot, closure } -- closure is resolveLoadList's own `order` (every file that must
// be staged, items and pulled-in masters alike), unchanged. Actual LOAD order is derived afterward,
// once xelib is initialised against this sandbox, via readGameLoadOrderV2.
function stageItemsV2(items, gameDataDir) {
    const sandboxRoot = fs.mkdtempSync(path.join(pickSandboxParent(gameDataDir), 'vct-merge-v2-'));
    const dataDir = path.join(sandboxRoot, 'Data');
    fs.mkdirSync(dataDir, { recursive: true });
    const seen = new Set();
    for (const item of items) {
        const key = item.fileName.toLowerCase();
        if (seen.has(key)) {
            fs.rmSync(sandboxRoot, { recursive: true, force: true });
            throw userError(`Two chosen plugins share the same file name ("${item.fileName}") from different mods -- remove one before merging.`);
        }
        seen.add(key);
    }
    const { order: closure } = resolveLoadList(items, gameDataDir);
    const realDataListing = buildRealDataListing(gameDataDir);
    for (const entry of closure) {
        if (entry.kind === 'item') {
            // A chosen ITEM's on-sandbox name still comes from the item itself (its OWN real
            // filename, already correct -- these are files the caller picked directly, not names
            // read out of someone else's header), never from realDataListing.
            fs.copyFileSync(entry.sourcePath, path.join(dataDir, entry.fileName));
        } else {
            stageMaster(entry.fileName, dataDir, gameDataDir, realDataListing);
        }
    }
    // Skyrim.ccc (Creation Club load order + CANONICAL Bethesda-shipped filenames, e.g.
    // "ccAFDSSE001-DweSanctuary.esm" even when the on-disk copy has been lowercased by whatever
    // extracted it) lives at the game ROOT, one level above Data -- copying it into the sandbox root
    // is what lets xelib.getLoadOrder() (readGameLoadOrderV2) resolve CC content the same way it
    // would against the real install, matching zMerge's own casing exactly. Best-effort: a merge
    // with no CC content in its closure works fine without it.
    if (gameDataDir) {
        const cccSrc = path.join(path.dirname(gameDataDir), 'Skyrim.ccc');
        if (fs.existsSync(cccSrc)) { try { fs.copyFileSync(cccSrc, path.join(sandboxRoot, 'Skyrim.ccc')); } catch { /* non-fatal */ } }
    }
    return { sandboxRoot, closure };
}

function initXelibAt(gameRoot) {
    xelib.init();
    xelib.setLanguage('English');
    xelib.setGamePath(gameRoot);
    xelib.setGameMode(xelib.GM_SSE);
    xelib.clearMessages();
}

// zMerge's own method (spec section 0, "Load order"): loadOrderService.js:99 builds
// $rootScope.loadOrder from xelib.GetLoadOrder(); editMergePlugins.js:35 filters it to
// selected-plus-required, preserving that order. GetLoadOrder(), called against our sandbox, was
// confirmed live (2026-08-24) to reflect the REAL Plugins.txt order filtered to files actually
// present in the sandbox Data folder -- not filesystem/insertion order -- so this is a faithful port
// of zMerge's method, not an approximation of its result the way
// diagnostics/2026-08-24-game-load-order-ordering.patch was (that patch reconstructs order from
// files for merge-preflight.js, which must stay xelib-free; it is deliberately NOT used here).
//
// Anything GetLoadOrder() doesn't mention (staged but not active in Plugins.txt -- an ESLifier
// Output copy, a picked-but-inactive plugin) is appended after everything it does, in closure order,
// which is resolveLoadList's own topological order -- guaranteeing master-before-dependent even for
// files the game itself would never have an opinion on.
function readGameLoadOrderV2(closure) {
    const staged = new Set(closure.map((e) => e.fileName.toLowerCase()));
    const raw = xelib.getLoadOrder();
    const known = raw.filter((n) => staged.has(n.toLowerCase()));
    const knownSet = new Set(known.map((n) => n.toLowerCase()));
    const unknown = closure.filter((e) => !knownSet.has(e.fileName.toLowerCase())).map((e) => e.fileName);
    return [...known, ...unknown];
}

// Guards the one thing the spec calls non-negotiable: "Master-before-dependent must remain
// guaranteed. If real load order would ever violate it, the dependency wins." GetLoadOrder() should
// never actually violate this (it IS the game's real order, and a well-formed master graph is
// consistent with it) -- but a corrupt or hand-edited header could still produce a closure entry
// whose declared master sits later in game order than itself, which would be exactly the state the
// spec says the game itself could not run. Detected and reported rather than silently trusted.
function findLoadOrderViolations(orderedNames, closure) {
    const pos = new Map(orderedNames.map((n, i) => [n.toLowerCase(), i]));
    const byName = new Map(closure.map((e) => [e.fileName.toLowerCase(), e]));
    const violations = [];
    orderedNames.forEach((name, i) => {
        const entry = byName.get(name.toLowerCase());
        for (const m of (entry && entry.masters) || []) {
            const mp = pos.get(m.toLowerCase());
            if (mp !== undefined && mp > i) violations.push({ file: name, needs: m });
        }
    });
    return violations;
}

// Pure computation, no logging (2026-08-24, merge-log-parity) -- the real final load order with any
// dependency-violation fix already applied, plus the list of what got moved (so the caller can still
// log "Reordered X ahead of Y" for each one, exactly as it always has). Extracted so the SAME
// computation can also drive the new pre-"Preparing merge..." "Loading X" listing below without a
// second, possibly-diverging xelib.getLoadOrder() call -- this function's own two callers
// (runMergeV2's own load-order listing and its unchanged violation-fix block) end up sharing one
// result instead of each recomputing it.
function computeFinalLoadOrderV2(closure) {
    const orderedNames = readGameLoadOrderV2(closure);
    const violations = findLoadOrderViolations(orderedNames, closure);
    const reorderedPairs = [];
    if (violations.length) {
        // Non-negotiable per the spec: dependency wins over game order if they ever disagree.
        // Reorder minimally by moving each violator's master ahead of it (topological patch),
        // rather than failing the whole merge over a corrupt-header edge case.
        const pos = new Map(orderedNames.map((n, i) => [n.toLowerCase(), i]));
        for (const v of violations) {
            const mi = pos.get(v.needs.toLowerCase());
            const fi = pos.get(v.file.toLowerCase());
            if (mi !== undefined && fi !== undefined && mi > fi) {
                const [item] = orderedNames.splice(mi, 1);
                orderedNames.splice(fi, 0, item);
                reorderedPairs.push({ needs: v.needs, file: v.file });
            }
        }
    }
    return { orderedNames, reorderedPairs };
}

async function loadAllV2(fileNames) {
    // smartLoad = true -- matches mergeLoadService.js:74's xelib.LoadPlugins(loadOrder, true).
    xelib.loadPlugins(fileNames.join('\n'), true, false);
    await xelib.waitForLoader();
    xelib.clearMessages();
}

// ---- masters (mergeMasterService.js, Clean method) ----
// addMastersToMergedPlugin (xelib.AddAllMasters) has no binding here -- see this file's header.
// Reproduced by relying on addRequiredMasters/copyElement's own internal AddRequiredMasters call
// (xedit-reference/Core/wbImplementation.pas:19295-19300 -- CopyInto calls it before every copy
// regardless), which is now safe because the destination is always the highest load-order file.
function cleanMastersV2(outFile, items) {
    xelib.cleanMasters(outFile);
    const remaining = xelib.getMasterNames(outFile);
    const originalNames = items.map((i) => i.fileName.toLowerCase());
    const stillPresent = remaining.filter((m) => originalNames.includes(m.toLowerCase()));
    return stillPresent; // mirrors mergeMasterService.js:21-24's own verify loop
}

// ---- records (recordMergingService.js, Clean method: getUsedFormIds -> copyRecords(trackNew) ->
// refactorReferences) ----

function isNewRecord(rec) {
    return !xelib.isOverride(rec) && !xelib.isInjected(rec);
}

// shouldTrack (recordMergingService.js:55) -- a record is renumbering-eligible if it's genuinely new,
// or an injected/override record whose TARGET file is itself one of the plugins being merged.
function isInjectedInMerge(rec, mergedLower) {
    let targetH = null;
    try {
        targetH = xelib.getInjectionTarget(rec);
        if (!targetH) return false;
        return mergedLower.has(xelib.name(targetH).toLowerCase());
    } catch { return false; } finally { if (targetH) xelib.release(targetH); }
}
function isOverrideInMerge(rec, mergedLower) {
    let masterH = null, fileH = null;
    try {
        masterH = xelib.getMasterRecord(rec);
        if (!masterH) return false;
        fileH = xelib.getElementFile(masterH);
        if (!fileH) return false;
        return mergedLower.has(xelib.name(fileH).toLowerCase());
    } catch { return false; } finally {
        if (fileH) xelib.release(fileH);
        if (masterH) xelib.release(masterH);
    }
}
function shouldTrack(rec, mergedLower) {
    const isOverride = xelib.isOverride(rec);
    const isInjected = xelib.isInjected(rec);
    if (!isOverride && !isInjected) return true;
    if (isInjected) return isInjectedInMerge(rec, mergedLower);
    if (isOverride) return isOverrideInMerge(rec, mergedLower);
    return false;
}

// getUsedFormIds (recordMergingService.js:99) -- every NEW record's local fid, across every merged
// plugin, marked -1 (not yet claimed by anyone). Order doesn't matter here; it's a set-membership pass.
function getUsedFormIds(sortedItems) {
    const usedFids = {};
    for (const item of sortedItems) {
        const fh = xelib.fileByName(item.fileName);
        const records = xelib.getRecords(fh, '', true);
        for (const rec of records) {
            if (isNewRecord(rec)) usedFids[hex6(xelib.getFormID(rec, true))] = -1;
            xelib.release(rec);
        }
    }
    return usedFids;
}

// copyRecords (recordMergingService.js:120) -- REVERSE game-load order, deduped by GLOBAL FormID.
// This is zMerge's own conflict resolution: the first copy encountered (highest priority, since we
// walk from the last-loading plugin backward) wins; a later (lower-priority) duplicate is skipped.
// A copy failure does NOT claim the fid (recordMergingService.js:11-23's own early-return-on-failure
// before the copiedFids.push), so a lower-priority duplicate still gets its own chance.
// TWO PASSES, not one -- see this file's own diagnostic history (2026-08-24) for why. Our
// AddAllMasters substitute originally interleaved addRequiredMasters+copyElement per record (matching
// how it reads most naturally). That interleaving has a real, reproducible bug: a minimal 2-plugin
// repro (dz_hot_springs.esp + dz_basement_bath_allinone.esp -- individually harmless, together they
// fail every time) showed one specific record's copyElement throwing BuildReferences-adjacent
// failures purely because of WHEN addRequiredMasters ran relative to the surrounding copies, not
// because of anything wrong with the record, its masters, or the closure (all independently verified
// correct -- see the handoff). Splitting into "add every record's required masters first, across
// BOTH plugins, THEN copy every record" -- closer to what AddAllMasters actually does, adding
// everything up front rather than incrementally -- made the exact same repro pass cleanly, 0
// failures, confirmed by direct A/B test (interleaved: fails; two-pass: succeeds, same input).
//
// Re-opens each plugin's records fresh for pass 2 rather than holding every handle from pass 1 open
// simultaneously -- simpler handle lifetime, and the cost is one extra GetRecords call per plugin,
// negligible next to the actual copy work.
// logger param (2026-08-24, merge-log-parity) -- see makeLogger's own header for why every write is
// a synchronous, immediately-durable append: logging every record AS it's copied, not retroactively
// after the whole pass finishes, means a real crash mid-copy still leaves a log that shows exactly
// how far the merge got and which record it died on -- the actual diagnostic value the director asked
// for, not just a per-plugin summary that can't answer "which specific record caused this."
function copyRecords(sortedItems, outFile, mergedLower, logger) {
    const reversed = sortedItems.slice().reverse();

    // Pass 1: addRequiredMasters for every record, every plugin, before any copy at all.
    for (const item of reversed) {
        const fh = xelib.fileByName(item.fileName);
        for (const rec of xelib.getRecords(fh, '', true)) {
            try { xelib.addRequiredMasters(rec, outFile, false); } catch { /* surfaced again in pass 2 if it still fails there */ }
            xelib.release(rec);
        }
    }

    // Pass 2: the real copy, unchanged from before except addRequiredMasters is no longer called
    // here -- pass 1 already did it. Dedupe/tracking logic is byte-for-byte what it always was.
    const copiedFids = new Set();
    const newRecordsByPlugin = {};
    const failedToCopy = [];
    for (let idx = 0; idx < reversed.length; idx++) {
        const item = reversed[idx];
        reportProgress(idx + 1, reversed.length, `Copying records from ${item.fileName}…`);
        // Moved here from runMergeV2's own post-pass batch loop (2026-08-24, merge-log-parity) -- the
        // per-record lines below need to nest under their own plugin's header, in real order, which
        // only works if this is logged live as each plugin's own records actually start copying.
        logger.log(`Copying records from ${item.fileName}`);
        const fh = xelib.fileByName(item.fileName);
        const records = xelib.getRecords(fh, '', true);
        const tracked = [];
        for (const rec of records) {
            const fid = xelib.getFormID(rec, false); // GLOBAL fid -- matches zMerge's own dedupe key
            if (copiedFids.has(fid)) { xelib.release(rec); continue; }
            const track = shouldTrack(rec, mergedLower);
            let newRec = null;
            try {
                newRec = xelib.copyElement(rec, outFile, false); // asNew=false -- preserve FormID; new records renumbered below
            } catch (e) {
                failedToCopy.push({ plugin: item.fileName, name: safeLongName(rec), error: e.message.split('\n')[0] });
            }
            xelib.release(rec);
            if (!newRec) continue;
            // Confirmed empirically (2026-08-24, merge-log-parity) against a real merge, all 400
            // copied records: newRec's own longName is byte-identical to rec's at this point --
            // copyElement's asNew=false preserves the raw FormID verbatim, and the re-prefix to the
            // MERGED FILE's own master index doesn't happen until refactorReferences runs later. Using
            // newRec here (not rec, already released above) is still the more correct choice going
            // forward: it names the record as it now actually exists in the output file, matching
            // zMerge's own real per-record log lines exactly (confirmed against
            // G:\zEdit Renewed\merges\zmerge-mahail's own reference log for this same scenario).
            logger.log(`Copying ${safeLongName(newRec)}`);
            copiedFids.add(fid);
            if (track) tracked.push(newRec); else xelib.release(newRec);
        }
        newRecordsByPlugin[item.fileName] = tracked;
    }
    return { newRecordsByPlugin, failedToCopy };
}

function safeLongName(rec) {
    try { return xelib.longName(rec); } catch { return '(unknown record)'; }
}

// refactorReferences (recordMergingService.js:150) -- FORWARD game-load order. For each plugin's own
// tracked new records: a collision (usedFids[oldFid] already claimed by an earlier plugin in this
// same forward pass) gets a fresh globally-unique fid; otherwise the record keeps its low three bytes
// and is simply re-prefixed with the MERGED FILE's own master index, and claims that fid for anyone
// coming after it.
function refactorReferences(sortedItems, outFile, newRecordsByPlugin, usedFids) {
    xelib.buildReferences(outFile); // on the DESTINATION, before any setFormID -- so fixRefs=true can find every reference
    let nextFormId = 0x000801;
    const getNextFormId = () => {
        while (Object.prototype.hasOwnProperty.call(usedFids, hex6(nextFormId))) nextFormId++;
        return nextFormId;
    };
    const base = xelib.getFileLoadOrder(outFile) * 0x1000000;
    const fidMap = {}; // pluginName -> { oldHex6: newHex6 } -- RENUMBERED entries only, matching map.json
    sortedItems.forEach((item, index) => {
        fidMap[item.fileName] = {};
        const tracked = newRecordsByPlugin[item.fileName] || [];
        for (const rec of tracked) {
            const oldFid = hex6(xelib.getFormID(rec, true));
            if (usedFids[oldFid] > -1) {
                const newFormId = base + getNextFormId();
                const newFid = hex6(newFormId);
                fidMap[item.fileName][oldFid] = newFid;
                xelib.setFormID(rec, newFormId, false, true); // fixRefs=true
                usedFids[newFid] = index;
                nextFormId++;
            } else {
                xelib.setFormID(rec, base + parseInt(oldFid, 16), false, true);
                usedFids[oldFid] = index;
            }
            xelib.release(rec);
        }
    });
    return fidMap;
}

// ---- SEQ (seqService.js) -- UNTESTED, see this file's header ----
function isSeqFlagged(rec) {
    try { return xelib.hasElement(rec, 'DNAM\\Flags') && xelib.getFlag(rec, 'DNAM\\Flags', 'Start Game Enabled'); }
    catch { return false; }
}
function buildSeqFileV2(outFile, outputDir, mergedBaseName) {
    if (!xelib.hasElement(outFile, 'QUST')) return null;
    const questGroup = xelib.getElement(outFile, 'QUST');
    const masterCount = xelib.getMasterNames(outFile).length;
    const formIds = [];
    for (const qust of xelib.getElements(questGroup)) {
        if (isSeqFlagged(qust)) {
            // Clean method: masterIsMerged === xelib.IsMaster(rec) (seqService.js:16) -- true for a
            // genuinely new record now living at its final position in the merged file.
            const fid = xelib.getFormID(qust, true);
            if (xelib.isMaster(qust)) formIds.push((fid & 0x00FFFFFF) | (masterCount << 24));
        }
        xelib.release(qust);
    }
    xelib.release(questGroup);
    if (!formIds.length) return null;
    const outDir = path.join(outputDir, 'seq');
    fs.mkdirSync(outDir, { recursive: true });
    const fileName = `${mergedBaseName}.seq`;
    const buffer = Buffer.alloc(formIds.length * 4);
    formIds.forEach((fid, i) => buffer.writeUInt32LE(fid, i * 4));
    fs.writeFileSync(path.join(outDir, fileName), buffer);
    return path.join('seq', fileName);
}

// ---- artifacts (mergeService.js) -- schema and serialization confirmed against the real ground-
// truth files: fidCache.json is ONE MINIFIED LINE (fileHelpers.js:73's minify=true, the only caller
// that passes it), merge.json and map.json are 2-space pretty (JSON.stringify's own default when
// this project writes them, matching jetpack.write's default object behaviour). ----
function buildFidCache(sortedItems, usedFids) {
    const cache = {};
    for (const item of sortedItems) cache[item.fileName] = [];
    // usedFids values are the INDEX into sortedItems that ultimately claimed each fid (see
    // refactorReferences) -- rebuild the per-plugin bucket from that, matching mergeService.js:43's
    // getFidCache exactly (index -1 entries, i.e. never claimed by a NEW record at all, are excluded).
    for (const [fid, index] of Object.entries(usedFids)) {
        if (index > -1 && sortedItems[index]) cache[sortedItems[index].fileName].push(fid);
    }
    return cache;
}

function writeArtifacts({ mergeFolder, name, filename, method, loadOrderNames, sortedItems, fidMap, usedFids }) {
    fs.mkdirSync(mergeFolder, { recursive: true });
    const mergeJson = {
        name, filename, method,
        loadOrder: loadOrderNames,
        plugins: sortedItems.map((i) => ({ filename: i.fileName, dataFolder: i.modName || null })),
        dateBuilt: new Date().toISOString(),
        // The rest of mergeService.js:87-107's own newMerge() defaults, for schema completeness --
        // these are asset-handling TOGGLES this engine doesn't act on yet (see this file's header),
        // so they're written as zMerge's own inert defaults rather than omitted. Only useGameLoadOrder
        // is true here (not zMerge's own false default) since that IS what this engine actually did.
        archiveAction: 'Extract', buildMergedArchive: false, useGameLoadOrder: true,
        handleFaceData: false, handleVoiceData: false, handleBillboards: false, handleStringFiles: false,
        handleTranslations: false, handleIniFiles: false, handleDialogViews: false, copyGeneralAssets: false,
        customMetadata: {},
    };
    fs.writeFileSync(path.join(mergeFolder, 'merge.json'), JSON.stringify(mergeJson, null, 2));
    fs.writeFileSync(path.join(mergeFolder, 'map.json'), JSON.stringify(fidMap, null, 2));
    fs.writeFileSync(path.join(mergeFolder, 'fidCache.json'), JSON.stringify(buildFidCache(sortedItems, usedFids)));
}

// ---- log (progressLogger.js) -- phase separators are a blank line + 60 '=', matching the real log ----
// Writes INCREMENTALLY, synchronously, one line at a time -- deliberately NOT buffer-then-flush
// (2026-08-24, wiring v2 into the live UI). A buffered logger only ever reaches disk via its own
// flush() call, at the very end or in a catch block -- both are ordinary JS control flow, and
// neither one runs when the WORKER PROCESS ITSELF dies (a genuine native access violation, not a
// catchable JS throw). That exact failure shape is what the earlier AddRequiredMasters/
// BuildReferences investigations kept running into, and it's precisely the case where a real log
// matters most: the tester needs to see where it died, not find an empty file. Each write() below is
// a real, completed fs.appendFileSync syscall -- once it returns, that line is durable even if the
// process is killed the instant afterward; only power loss or an OS-level crash could lose it, a
// different and far rarer failure than "this one process segfaulted."
//
// The file is created (truncated) once, up front, so every subsequent call is a plain append -- no
// per-write existence/mkdir churn, and flush() is kept only so call sites don't need to change; it's
// a no-op now, since there is nothing left to flush.
// sessionStart/sessionEnd (2026-08-24, merge-log-parity) -- zMerge brackets its whole log with an
// 80-'=' rule and a "Session started/terminated at {date}" line either side (real reference:
// G:\zEdit Renewed\merges\zmerge-mahail's own log, confirmed 80 characters exactly, not the 60-char
// bar phase() already uses for section separators). Plain Date#toString() already matches its format
// closely (e.g. "Mon Aug 24 2026 11:44:36 GMT-0700 (Pacific Daylight Time)") since neither log
// invented a custom date format -- both are just the platform's own default.
function makeLogger(logPath) {
    const bar = '='.repeat(60);
    const sessionBar = '='.repeat(80);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, '', 'utf8');
    const write = (s) => {
        try { fs.appendFileSync(logPath, s + '\r\n', 'utf8'); }
        catch { /* a logging failure must never take down the merge itself */ }
    };
    return {
        log: (msg) => write(msg),
        phase: (msg) => { write(''); write(msg); write(bar); },
        sessionStart: () => { write(sessionBar); write(`Session started at ${new Date().toString()}`); write(''); write(''); },
        sessionEnd: () => { write(''); write(`Session terminated at ${new Date().toString()}`); write(sessionBar); write(''); write(''); },
        flush: () => {},
    };
}

async function runMergeV2(items, outputPath, gameDataDir, mergeName) {
    const { sandboxRoot, closure } = stageItemsV2(items, gameDataDir);
    const outputDir = path.dirname(outputPath);
    const filename = path.basename(outputPath);
    const mergeFolder = path.join(outputDir, `merge - ${mergeName}`);
    const logPath = path.join(mergeFolder, `merge_v2_${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);
    const logger = makeLogger(logPath);
    logger.sessionStart();
    try {
        logger.log(`Building merge ${mergeName}`);
        logger.log(`Merge Folder: ${outputDir}`);
        logger.log('Merge Method: Clean');

        initXelibAt(sandboxRoot + path.sep);
        // Real master/source-plugin load order, one line each, matching zMerge's own log (2026-08-24,
        // merge-log-parity) -- useful to confirm the real order a merge ran against, especially given
        // this project's own history of load-order bugs. computeFinalLoadOrderV2 already applies any
        // dependency-violation fix, so this listing reflects the true final order even in that rare
        // case, not just the common one.
        const { orderedNames, reorderedPairs } = computeFinalLoadOrderV2(closure);
        orderedNames.forEach((name, i) => logger.log(`Loading ${name} (${i + 1}/${orderedNames.length})`));
        logger.log('Done loading files.');

        logger.phase('Preparing merge...');
        // Unchanged from before this change -- still the same "Reordered X ahead of Y" line, in the
        // same position, just fed from computeFinalLoadOrderV2's own already-computed result above
        // instead of recomputing it inline.
        for (const v of reorderedPairs) logger.log(`Reordered ${v.needs} ahead of ${v.file} (dependency overrides game order)`);
        await loadAllV2(orderedNames);

        const outFile = xelib.addFile(filename);
        logger.log(`Merging into ${filename}`);
        // .esm output flag -- no verified binding, best-effort only (see header note).
        if (path.extname(filename).toLowerCase() === '.esm') {
            try { xelib.setFlag(outFile, 'File Header\\Record Header\\Record Flags', 'ESM', true); } catch { /* untested path, non-fatal */ }
        }

        // sortedItems: the chosen ITEMS ONLY, in ascending game load order -- mirrors
        // storePluginHandles' sortOnKey('loadOrder') (mergeBuilder.js:21-27).
        const closureByName = new Map(closure.map((e) => [e.fileName.toLowerCase(), e]));
        const itemNames = new Set(items.map((i) => i.fileName.toLowerCase()));
        const sortedItems = orderedNames
            .filter((n) => itemNames.has(n.toLowerCase()))
            .map((n) => items.find((i) => i.fileName.toLowerCase() === n.toLowerCase()));
        const mergedLower = new Set(sortedItems.map((i) => i.fileName.toLowerCase()));

        logger.phase('Getting used FormIDs...');
        for (const item of sortedItems) logger.log(`Getting used FormIDs in ${item.fileName}`);
        const usedFids = getUsedFormIds(sortedItems);

        logger.phase('Copying records...');
        reportProgress(0, sortedItems.length, 'Copying records…');
        // copyRecords now logs its own "Copying records from X" header AND a per-record "Copying
        // {longName}" line for every record it actually copies, live as each one happens (2026-08-24,
        // merge-log-parity) -- see its own header comment. No separate batch loop needed here anymore.
        const { newRecordsByPlugin, failedToCopy } = copyRecords(sortedItems, outFile, mergedLower, logger);
        for (const f of failedToCopy) logger.log(`WARNING: failed to copy ${f.name} from ${f.plugin}: ${f.error}`);

        logger.phase('Refactoring references...');
        const fidMap = refactorReferences(sortedItems, outFile, newRecordsByPlugin, usedFids);

        // Asset handling phase intentionally NOT invoked -- see this file's header. Logged so the
        // gap is visible in our own log, never silent.
        logger.phase('Handling asset files...');
        logger.log('(not yet ported in this engine -- see docs/plans/2026-08-24-merge-port-spec.md)');

        logger.phase('Cleaning merge masters...');
        // Empirically required here (2026-08-24): zMerge's own JS never calls SortMasters explicitly
        // (grepped -- its only call site is an unrelated context-menu action), which means the
        // Pascal-side AddRequiredMasters/AddMastersIfMissing keeps the master list continuously
        // sorted by load order as each one is added (AddMastersIfMissing's own aSortMasters=True
        // default, xedit-reference/Core/wbImplementation.pas). Confirmed our xeditlib wrapper's
        // addRequiredMasters does NOT do this: a real run showed dz_undress_common.esp (game load
        // order 33) at master-list position 5, ahead of six later-loading masters. sortMasters(h) is
        // otherwise unused by this project until now (only wired to a context-menu action in
        // zEdit itself) -- calling it once here reproduces zMerge's own end state without needing to
        // guess at its per-call internal behaviour.
        xelib.sortMasters(outFile);
        const stillPresent = cleanMastersV2(outFile, items);
        let builtWithErrors = false;
        for (const m of stillPresent) { logger.log(`ERROR: Failed to remove master ${m}.`); builtWithErrors = true; }

        logger.phase('Saving merge files...');
        const mergedBaseName = path.basename(filename, path.extname(filename));
        const seqFile = buildSeqFileV2(outFile, outputDir, mergedBaseName);
        if (seqFile) logger.log(`Created SEQ file: ${seqFile}`);
        fs.mkdirSync(outputDir, { recursive: true });
        xelib.saveFile(outFile, outputPath);
        logger.log('Saving merged plugin');
        writeArtifacts({
            mergeFolder, name: mergeName, filename, method: 'Clean',
            loadOrderNames: orderedNames, sortedItems, fidMap, usedFids,
        });
        logger.log('Saving additional merge data');

        const recordCount = Object.values(newRecordsByPlugin).reduce((n, a) => n + a.length, 0);
        xelib.close();

        if (builtWithErrors) throw userError('Merge built with errors (a merged plugin remained on the master list after cleaning).');

        logger.log(`Completed merge ${mergeName}.`);
        logger.sessionEnd();
        logger.flush();
        // masterCount deliberately NOT read here -- the caller reads it back from the saved .esp via
        // lib/esp-header.js, which is simpler than keeping xelib open just to report it.
        return { outputPath, mergeFolder, logPath, recordCount, failedToCopy };
    } catch (e) {
        try { xelib.close(); } catch { /* already closed or never opened */ }
        logger.log(`FATAL: ${e.message}`);
        try { logger.sessionEnd(); } catch { /* best-effort, same as flush() below */ }
        try { logger.flush(); } catch { /* best-effort */ }
        throw e;
    } finally {
        fs.rmSync(sandboxRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    }
}

async function readStdin() {
    return new Promise((resolve, reject) => {
        let data = '';
        process.stdin.on('data', (c) => { data += c; });
        process.stdin.on('end', () => resolve(data));
        process.stdin.on('error', reject);
    });
}

async function main() {
    const input = JSON.parse(await readStdin());
    const { items, outputPath, gameDataDir, mergeName } = input;
    if (!items || !items.length) throw userError('No plugins were provided.');
    if (!outputPath) throw userError('No output path was provided.');
    const result = await runMergeV2(items, outputPath, gameDataDir, mergeName || path.basename(outputPath, path.extname(outputPath)));
    process.stdout.write(JSON.stringify(result));
}

main().catch((e) => {
    if (e.isUserFacing) process.stderr.write('##USERERR## ' + e.message + '\n');
    else process.stderr.write((e.stack || e.message) + '\n');
    process.exit(1);
});
