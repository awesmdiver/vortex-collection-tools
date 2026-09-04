#!/usr/bin/env node
'use strict';
// Merge Plugins v2 -- a direct port of zEdit-Revised's own zMerge engine (MIT, Colin Allen
// (matortheeternal), https://github.com/z-edit/zedit -- our fork skyrim-modding/zedit-revised),
// built from docs/plans/2026-08-24-merge-port-spec.md. Every phase below is named for, and traced
// against, that spec's own citations into zedit-revised/src/javascripts/Services/merge/*.js and the
// director's real ground-truth log
// (G:\zEdit Renewed\merges\merge_plugin_test\merge - merge_plugin_test\merge_2026_08_23_13_55.txt).
//
// Originally built ALONGSIDE lib/merge-worker.js, not in place of it (director's own call,
// 2026-08-24: "let's not destroy the current code, let's archive/save it before we build something
// new"). That file's own real merge-build logic (runMerge) was retired on 2026-08-25 once this
// engine was confirmed byte-identical and the sole active engine (`mergeUseV2Engine` defaulted
// `true` with no UI rollback). Its analyze-only remainder (analyzeFile/runAnalyze -- the Review
// step's override/master/record-count preview) was kept alive as the LAST live piece, since this
// file had no equivalent of its own -- until this same day, when that logic was ported in below (see
// runAnalyzeV2's own header) and lib/merge-worker.js/lib/merge-runner.js were finally deleted
// entirely. merge-preflight.js's resolveLoadList is reused here unmodified for the staging closure
// (which files to copy in) -- its own load-list ORDER is not used for the merge-build path's own
// xelib.LoadPlugins call, since the spec found zMerge's own method differs (xelib.GetLoadOrder()
// filtered to the closure, not a file-derived topological sort) -- see readGameLoadOrderV2 below;
// runAnalyzeV2 below uses the plain closure order instead, matching what v1's own analyze always did.
//
// Method scope: all 3 real methods (2026-08-25) -- Clean (recordMergingService.js's copyAndRefactor
// / mergeMasterService.js's addMastersToMergedPlugin+cleanMasters, still the default and the only
// method any real test case had used until now), Clobber (renumberAndCopy, source plugins renumbered
// IN PLACE using their own load-order slot as the renumber base, plus a per-source buildReferences
// pass during prepare and an unconditional per-plugin master removal at the end -- real user demand,
// see the handoff), and Master (same renumberAndCopy record path as Clobber, but its own masters-ADD
// step adds the merged output as a new master ON EACH SOURCE instead of adding masters to the output
// itself, and never removes anything). See recordMergingService.js/mergeMasterService.js's own real
// method maps (mergeMethods / addMastersMethods / removeMastersMethods) for the authoritative
// per-method dispatch this ports; runMergeV2's own comments cite the exact source lines inline.
//
// Both new methods mutate the loaded SOURCE plugins' own in-memory records/master lists (Clobber
// renumbers them; Master adds a new master to them) -- exactly matching zMerge's own real behavior,
// and safe here for the same reason it's safe there: this worker (like zMerge's own real
// saveMergeFiles) NEVER calls xelib.saveFile on a source-plugin handle, only ever on outFile, so
// these mutations are purely transient -- discarded, along with the whole native session, when this
// process exits. See renumberFormIds/addMergeAsMasterToSources' own headers for the full reasoning.
// Method choice is a real, per-build request field now (web/merge-routes.js's own /merge route),
// never a persisted Settings default -- see the handoff for the picker UI this shipped alongside.
//
// Asset handling (mergeAssetService.js + the 9 Runners/assetHandlers/*.js: BSA, face data, voice,
// billboards, string files, translations, INI files, dialog views, general assets) is now ported --
// see lib/merge/handle-assets.js and lib/merge/asset-handlers/*.js (2026-08-25, GitHub issue #3).
// Two real, source-confirmed limitations carry over from zMerge itself, not introduced by this port:
// stringFileHandler's own `handle` is a literal `// TODO` upstream (discovery works, the actual
// copy/rebuild was never written -- see lib/merge/asset-handlers/string-file-handler.js's own
// header), and the "Merged BSA" priority-200 branch needs xelib.BuildArchive, which isn't bound in
// this project's xeditlib package at all (gated behind buildMergedArchive, which defaults false --
// see lib/merge/asset-handlers/bsa-handler.js's own header).
//
// NOT YET PORTED (explicit gaps, not silent ones -- see the handoff for the full coverage table):
//   - SEQ file is ported (seqService.js) -- real coverage as of 2026-08-25
//     (scripts/test-merge-methods.js, scripts/fixtures/VCTSeqFixture.esp): a genuine
//     Start-Game-Enabled quest produces a real .seq file whose bytes match the merged record's own
//     real FormID (independently re-read, not the worker's own in-process values).
//   - .esm output's SetIsESM equivalent is implemented via SetFlag on a best-guess flag name -- real
//     coverage as of 2026-08-25 (scripts/test-merge-methods.js): a real .esm-named merge output has
//     the ESM header flag bit actually set, confirmed via lib/esp-header.js reading the saved file.
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
const { handleAssets, DEFAULT_FLAGS: ASSET_DEFAULT_FLAGS } = require('./merge/handle-assets');
const { findClobberContiguityViolation } = require('./merge-clobber-contiguity');

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

// renumberFormIds (recordMergingService.js:82-97/112-118, `renumberPluginRecords`/`renumberFormIds`)
// -- Clobber/Master ONLY (recordMergingService.js:172-174's `renumberAndCopy`; Clean's own
// `copyAndRefactor` never calls this). FORWARD game-load order (matches Clean's refactorReferences,
// NOT copyRecords' reverse dedup pass). For each merged plugin's own NEW records (isNewRecord, same
// test as getUsedFormIds above): a collision (its own fid already claimed by an EARLIER-processed
// plugin in usedFids) gets a fresh globally-unique fid; otherwise it keeps its own fid unchanged and
// just claims it for later plugins. The renumber base is the SOURCE PLUGIN'S OWN load-order slot
// (recordMergingService.js:85's `base = xelib.GetFileLoadOrder(plugin) * 0x1000000`) -- NOT the
// merged output's, which is what makes this table row ("Renumbering base") differ from Clean.
//
// This calls xelib.setFormID DIRECTLY ON THE LOADED SOURCE PLUGIN'S OWN RECORDS -- a real, in-memory
// mutation of the source, exactly matching zMerge's own "renumber sources in place" behavior (the
// port spec's own table, and this file's former header note, both call this out as the reason
// Clobber/Master weren't exposed sooner). It is safe here: this worker NEVER calls xelib.saveFile on
// any source-plugin handle, only ever on outFile (mergeBuilder.js's own real saveMergeFiles does the
// exact same thing -- it only ever saves merge.plugin, never merge.plugins). So this mutation exists
// purely to compute what copyRecords should carry into outFile next; it's discarded, along with the
// entire native xelib session, when this process exits. The user's real .esp files on disk are never
// touched -- and even the SANDBOX's own staged copies never get written back.
// logger param -- matches recordMergingService.js's own per-record `Renumbering ${oldFid} to
// ${newFid}` log line (renumberRecord's own progressLogger.log call). Confirmed against a real
// zEdit-Revised Clobber reference run (2026-08-25, mihailglassatr.esp + mihailwendigo.esp,
// G:\zEdit Revised\merges\clobber_test1): this function's own fidMap output already matched that
// real run's renumbering EXACTLY, fid-for-fid (000800->000822 through 00081F->000841) -- this
// logger call was the one real gap found, a missing log line, not a data/correctness defect.
function renumberFormIds(sortedItems, usedFids, logger) {
    let nextFormId = 0x000801;
    const getNextFormId = () => {
        while (Object.prototype.hasOwnProperty.call(usedFids, hex6(nextFormId))) nextFormId++;
        return nextFormId;
    };
    const fidMap = {}; // pluginName -> { oldHex6: newHex6 } -- RENUMBERED entries only, matching map.json
    sortedItems.forEach((item, index) => {
        fidMap[item.fileName] = {};
        const fh = xelib.fileByName(item.fileName);
        const base = xelib.getFileLoadOrder(fh) * 0x1000000;
        const records = xelib.getRecords(fh, '', true);
        for (const rec of records) {
            if (!isNewRecord(rec)) { xelib.release(rec); continue; }
            const oldFid = hex6(xelib.getFormID(rec, true));
            if (usedFids[oldFid] > -1) {
                const newFormId = base + getNextFormId();
                const newFid = hex6(newFormId);
                fidMap[item.fileName][oldFid] = newFid;
                logger.log(`Renumbering ${oldFid} to ${newFid}`);
                xelib.setFormID(rec, newFormId, false, true); // fixRefs=true
                usedFids[newFid] = index;
                nextFormId++;
            } else {
                usedFids[oldFid] = index;
            }
            xelib.release(rec);
        }
    });
    return fidMap;
}

// findClobberContiguityViolation -- see lib/merge-clobber-contiguity.js's own header. Pulled out into
// its own tiny module purely so it's unit-testable directly (this file's own main() runs
// unconditionally on require, so requiring THIS file for a test would try to read real stdin).

// clobberMastersV2 (mergeMasterService.js:7-14, `clobberMasters`) -- Clobber's own masters-REMOVE
// step. Unlike Clean's cleanMastersV2 (a native bulk CleanMasters + verify), this is a surgical,
// UNCONDITIONAL per-plugin removal of each of the merge's OWN source plugins from outFile's master
// list -- no verify afterward, matching zMerge's own real behavior exactly (it trusts the specific
// removal to succeed, rather than re-checking). This makes sense given WHY it's safe here: Clobber's
// own renumberFormIds already renumbered every one of these plugins' own records to fit within
// outFile's numbering scheme before copyRecords ever ran, so outFile's copies no longer NEED any of
// these source plugins as masters at all -- unlike Clean, which never renumbers the sources and so
// genuinely needs CleanMasters' own "is this master still referenced anywhere" logic.
const MASTERS_PATH_V2 = 'File Header\\Master Files';
function clobberMastersV2(outFile, items) {
    const masters = xelib.getElement(outFile, MASTERS_PATH_V2);
    for (const item of items) {
        try { xelib.removeArrayItem(masters, '', 'MAST', item.fileName); } catch { /* not present -- nothing to remove, matches zMerge's own unconditional call */ }
    }
}

// addMergeAsMasterToSources (mergeMasterService.js:33-38, `addMastersToPlugins`) -- Master method's
// OWN masters-ADD step (replacing, not supplementing, the AddAllMasters-on-outFile substitute the
// other two methods use -- addMastersMethods maps 'Master' to ONLY this, never
// addMastersToMergedPlugin; outFile still gets whatever masters ITS OWN copied records individually
// need via copyRecords' existing addRequiredMasters pass-1, the same native auto-add every CopyElement
// call already does regardless of method -- see this file's own header on why that substitute exists).
// Adds the merged output's own FUTURE filename as a new master ON EACH SOURCE PLUGIN's in-memory
// master list -- the real point of "Master" mode (the merged file becomes a base the sources depend
// on going forward). Same real, upstream caveat as renumberFormIds' own mutation: this worker never
// calls xelib.saveFile on a source plugin handle (only ever on outFile, matching zMerge's own real
// saveMergeFiles), so this never reaches the user's actual .esp files -- exactly like real zMerge
// itself, this is a session-only simulation; making Master mode's real benefit materialize requires
// the user to add the new merged file as a master to each original plugin themselves afterward
// (e.g. via xEdit's own Add Master action). Not a gap introduced by this port -- confirmed by reading
// mergeBuilder.js's own saveMergeFiles, which only ever writes merge.plugin, never merge.plugins,
// for any method.
function addMergeAsMasterToSources(sortedItems, filename) {
    for (const item of sortedItems) {
        const fh = xelib.fileByName(item.fileName);
        xelib.addMaster(fh, filename);
    }
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
// trackNew (recordMergingService.js:63, `copyPluginRecords(plugin, merge, trackNew)`) -- Clean's own
// copyAndRefactor calls this with trackNew=true (the default here, unchanged behavior); Clobber/
// Master's renumberAndCopy calls it with trackNew=false, since their own FormIDs are ALREADY final
// by this point (renumberFormIds below already renumbered every source record in place, before this
// runs) -- there's no refactor pass to feed afterward, so nothing needs tracking; every copied record
// just gets released immediately, matching recordMergingService.js:72's own
// `track ? newRecords.push(newRec) : xelib.Release(newRec)`.
function copyRecords(sortedItems, outFile, mergedLower, logger, trackNew = true) {
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
            const track = trackNew && shouldTrack(rec, mergedLower);
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
    // copiedCount (2026-08-25, method-picker) -- total records that actually landed in outFile,
    // regardless of trackNew. Clean's own recordCount stat (runMergeV2) still sums newRecordsByPlugin
    // unchanged (zero regression risk to an already-proven number); Clobber/Master use this instead,
    // since trackNew=false means newRecordsByPlugin is always empty for them -- summing THAT would
    // report "0 records" on every real build, which is wrong, not just differently-scoped.
    return { newRecordsByPlugin, failedToCopy, copiedCount: copiedFids.size };
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
        // The rest of mergeService.js:87-107's own newMerge() defaults -- ASSET_DEFAULT_FLAGS (see
        // lib/merge/handle-assets.js) is zMerge's own real default set (handleFaceData/
        // handleVoiceData/handleBillboards/handleStringFiles/handleTranslations/handleIniFiles/
        // handleDialogViews: true, copyGeneralAssets: false) -- these now reflect the REAL runtime
        // behavior this same merge just ran with, not inert placeholders. Only useGameLoadOrder is
        // true here (not zMerge's own false default) since that IS what this engine actually did.
        ...ASSET_DEFAULT_FLAGS, useGameLoadOrder: true,
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

// MERGE_METHODS (recordMergingService.js:172-176, mergeMasterService.js:40-50) -- the 3 real methods
// this file now implements. See this file's own header for a table citing every source line.
const MERGE_METHODS = new Set(['Clean', 'Clobber', 'Master']);

async function runMergeV2(items, outputPath, gameDataDir, mergeName, method = 'Clean') {
    if (!MERGE_METHODS.has(method)) throw userError(`Unknown merge method "${method}".`);
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
        logger.log(`Merge Method: ${method}`);

        initXelibAt(sandboxRoot + path.sep);
        // Real master/source-plugin load order, one line each, matching zMerge's own log (2026-08-24,
        // merge-log-parity) -- useful to confirm the real order a merge ran against, especially given
        // this project's own history of load-order bugs. computeFinalLoadOrderV2 already applies any
        // dependency-violation fix, so this listing reflects the true final order even in that rare
        // case, not just the common one.
        const { orderedNames, reorderedPairs } = computeFinalLoadOrderV2(closure);

        // Contiguous check (mergeLoadService.js:44-65) -- Clobber ONLY, and BEFORE any real loading,
        // matching zMerge's own timing as closely as this architecture allows (it checks before
        // LoadPlugins even runs; the earliest WE can know orderedNames at all is right here, and
        // nothing has been loaded yet either way -- see findClobberContiguityViolation's own header).
        if (method === 'Clobber') {
            const itemNamesLower = new Set(items.map((i) => i.fileName.toLowerCase()));
            const badPlugin = findClobberContiguityViolation(orderedNames, itemNamesLower);
            if (badPlugin) {
                throw userError(`${badPlugin} makes the plugins to be merged not contiguous. The Clobber merge method requires the plugins being merged to be contiguous in your real load order. Rearrange your load order so they run right after each other, or use Clean instead.`);
            }
        }

        orderedNames.forEach((name, i) => logger.log(`Loading ${name} (${i + 1}/${orderedNames.length})`));
        logger.log('Done loading files.');
        await loadAllV2(orderedNames);

        // sortedItems: the chosen ITEMS ONLY, in ascending game load order -- mirrors
        // storePluginHandles' sortOnKey('loadOrder') (mergeBuilder.js:21-27). Computed here, before
        // outFile exists, because Clobber's own per-source buildReferences step (right below) needs
        // it and has to run before prepareMergedPlugin/addMasters per mergeBuilder.js's own real
        // sequencing (storePluginHandles -> buildReferences -> prepareMergedPlugin -> addMasters).
        const closureByName = new Map(closure.map((e) => [e.fileName.toLowerCase(), e]));
        const itemNames = new Set(items.map((i) => i.fileName.toLowerCase()));
        const sortedItems = orderedNames
            .filter((n) => itemNames.has(n.toLowerCase()))
            .map((n) => items.find((i) => i.fileName.toLowerCase() === n.toLowerCase()));
        const mergedLower = new Set(sortedItems.map((i) => i.fileName.toLowerCase()));

        if (method === 'Clobber') {
            // buildReferences (mergeBuilder.js:29-36) -- per SOURCE plugin, Clobber only, right after
            // loading, BEFORE "Preparing merge..." -- confirmed against TWO independent real Clobber
            // reference logs (2026-08-25: the director's own fresh "clobber_test1" build, AND,
            // discovered while cross-checking this, diagnostics/issue-3-merge-mismatch-v2's own
            // "Mihail zMerge" log -- its own merge.json says "method": "Clobber", not "Clean" as
            // earlier assumed during that separate investigation). Both show "Building references..."
            // -> "Done building references" -> THEN "Preparing merge..." -> "Merging into X", in that
            // exact order. Needed so renumberFormIds' own SetFormID(fixRefs=true) call, right below,
            // can find and correct any reference TO a record being renumbered -- within the same
            // plugin or another loaded one.
            logger.phase('Building references...');
            for (const item of sortedItems) {
                logger.log(`Building references for ${item.fileName}`);
                const fh = xelib.fileByName(item.fileName);
                xelib.buildReferences(fh);
            }
            logger.log('Done building references');
        }

        // "Preparing merge..." -- moved here (after loading, and after Clobber's own buildReferences
        // when it runs) to match the real log ordering confirmed above; mergeBuilder.js's own real
        // prepareMerge only ever logs this immediately after the (conditional) buildReferences call,
        // which itself only ever runs after loadPlugins resolves -- never before the real load, for
        // any method.
        logger.phase('Preparing merge...');
        for (const v of reorderedPairs) logger.log(`Reordered ${v.needs} ahead of ${v.file} (dependency overrides game order)`);
        const outFile = xelib.addFile(filename);
        logger.log(`Merging into ${filename}`);
        // .esm output flag -- no verified binding, best-effort only (see header note).
        if (path.extname(filename).toLowerCase() === '.esm') {
            try { xelib.setFlag(outFile, 'File Header\\Record Header\\Record Flags', 'ESM', true); } catch { /* untested path, non-fatal */ }
        }

        if (method === 'Master') {
            // addMastersToPlugins (mergeMasterService.js:33-38) -- Master's OWN masters-ADD step,
            // right after prepareMergedPlugin, matching mergeBuilder.js's real
            // "prepareMergedPlugin -> mergeMasterService.addMasters" sequencing. See
            // addMergeAsMasterToSources' own header for the real, upstream "never persisted to disk"
            // caveat this carries.
            addMergeAsMasterToSources(sortedItems, filename);
            logger.log(`Added ${filename} as a master to the plugins being merged`);
        }

        logger.phase('Getting used FormIDs...');
        for (const item of sortedItems) logger.log(`Getting used FormIDs in ${item.fileName}`);
        const usedFids = getUsedFormIds(sortedItems);

        // renumberAndCopy (recordMergingService.js:160-164) -- Clobber/Master ONLY. copyAndRefactor
        // (Clean) never renumbers up front; it copies first, then refactors afterward (below).
        let renumberFidMap = null;
        if (method !== 'Clean') {
            logger.phase('Renumbering FormIDs...');
            for (const item of sortedItems) logger.log(`Renumbering FormIDs in ${item.fileName}`);
            renumberFidMap = renumberFormIds(sortedItems, usedFids, logger);
        }

        logger.phase('Copying records...');
        reportProgress(0, sortedItems.length, 'Copying records…');
        // copyRecords now logs its own "Copying records from X" header AND a per-record "Copying
        // {longName}" line for every record it actually copies, live as each one happens (2026-08-24,
        // merge-log-parity) -- see its own header comment. No separate batch loop needed here anymore.
        // trackNew=false for Clobber/Master (their FormIDs are already final from renumberFormIds
        // above -- see copyRecords' own header) -- true (unchanged) for Clean.
        const { newRecordsByPlugin, failedToCopy, copiedCount } = copyRecords(sortedItems, outFile, mergedLower, logger, method === 'Clean');
        for (const f of failedToCopy) logger.log(`WARNING: failed to copy ${f.name} from ${f.plugin}: ${f.error}`);

        // fidMap: Clean gets it from refactorReferences (unchanged); Clobber/Master already computed
        // theirs during renumberFormIds above -- there's no separate refactor pass for them at all
        // (recordMergingService.js:172-176's own method map never calls refactorReferences for either).
        let fidMap;
        if (method === 'Clean') {
            logger.phase('Refactoring references...');
            fidMap = refactorReferences(sortedItems, outFile, newRecordsByPlugin, usedFids);
        } else {
            fidMap = renumberFidMap;
        }

        logger.phase('Handling asset files...');
        // 2026-08-25 (GitHub issue #3) -- the real 9-handler port, see lib/merge/handle-assets.js's
        // own header for the exact merge.json flags this runs with and why. outputDir/filename are
        // the merged plugin's own real destination (not the sandbox); gameDataDir is the real game
        // Data folder most handlers search (see billboard-handler.js's own header for why).
        // Captured (2026-08-25, merge-results-screen-asset-gap) -- previously discarded entirely.
        // unhandledStringFiles below is the one real, live gap in this summary worth surfacing on the
        // results screen -- see handle-assets.js's own return comment and string-file-handler.js's
        // own header for why this specific count, and not any of the others in this summary.
        const assetSummary = await handleAssets({ sortedItems, fidMap, outputDir, filename, gameDataDir, logger });

        // Empirically required here (2026-08-24): zMerge's own JS never calls SortMasters explicitly
        // (grepped -- its only call site is an unrelated context-menu action), which means the
        // Pascal-side AddRequiredMasters/AddMastersIfMissing keeps the master list continuously
        // sorted by load order as each one is added (AddMastersIfMissing's own aSortMasters=True
        // default, xedit-reference/Core/wbImplementation.pas). Confirmed our xeditlib wrapper's
        // addRequiredMasters does NOT do this: a real run showed dz_undress_common.esp (game load
        // order 33) at master-list position 5, ahead of six later-loading masters. sortMasters(h) is
        // otherwise unused by this project until now (only wired to a context-menu action in
        // zEdit itself) -- calling it once here reproduces zMerge's own end state without needing to
        // guess at its per-call internal behaviour. Kept unconditional across all 3 methods -- this is
        // OUR OWN substitute mechanism's own quirk-fix (addRequiredMasters, used by copyRecords'
        // pass 1 regardless of method), not one of zMerge's real per-method differences.
        xelib.sortMasters(outFile);
        // removeMasters (mergeMasterService.js:40-50) -- the one step that genuinely differs by
        // method, phase text included: Clean's own cleanMasters logs "Cleaning merge masters..." and
        // verifies (cleanMastersV2); Clobber's own clobberMasters logs "Clobbering merge masters..."
        // and removes unconditionally, no verify (clobberMastersV2 -- see its own header for why
        // that's safe here); Master does nothing at all, not even a phase header -- confirmed against
        // a real Clobber reference log (2026-08-25, G:\zEdit Revised\merges\clobber_test1) that this
        // phase text really is method-specific, not a fixed "Cleaning..." for every method as
        // originally written.
        let builtWithErrors = false;
        if (method === 'Clean') {
            logger.phase('Cleaning merge masters...');
            const stillPresent = cleanMastersV2(outFile, items);
            for (const m of stillPresent) { logger.log(`ERROR: Failed to remove master ${m}.`); builtWithErrors = true; }
        } else if (method === 'Clobber') {
            logger.phase('Clobbering merge masters...');
            for (const item of items) logger.log(`Removing master ${item.fileName}`);
            clobberMastersV2(outFile, items);
        }
        // Master: no removal step at all, no phase header -- matches zMerge's own real
        // removeMastersMethods.Master (a genuine no-op with zero progress/log calls).

        logger.phase('Saving merge files...');
        const mergedBaseName = path.basename(filename, path.extname(filename));
        const seqFile = buildSeqFileV2(outFile, outputDir, mergedBaseName);
        if (seqFile) logger.log(`Created SEQ file: ${seqFile}`);
        fs.mkdirSync(outputDir, { recursive: true });
        xelib.saveFile(outFile, outputPath);
        logger.log('Saving merged plugin');
        writeArtifacts({
            mergeFolder, name: mergeName, filename, method,
            loadOrderNames: orderedNames, sortedItems, fidMap, usedFids,
        });
        logger.log('Saving additional merge data');

        // recordCount: Clean keeps its own proven computation unchanged (sums newRecordsByPlugin, the
        // genuinely-new/trackable records). Clobber/Master ran copyRecords with trackNew=false, so
        // newRecordsByPlugin is always empty for them -- copiedCount (every record that actually
        // landed in outFile, tracked or not) is the only meaningful count available, and the one a
        // "records merged" stat should show anyway. See copyRecords' own header for why.
        const recordCount = method === 'Clean'
            ? Object.values(newRecordsByPlugin).reduce((n, a) => n + a.length, 0)
            : copiedCount;
        xelib.close();

        if (builtWithErrors) throw userError('Merge built with errors (a merged plugin remained on the master list after cleaning).');

        logger.log(`Completed merge ${mergeName}.`);
        logger.sessionEnd();
        logger.flush();
        // masterCount deliberately NOT read here -- the caller reads it back from the saved .esp via
        // lib/esp-header.js, which is simpler than keeping xelib open just to report it.
        return { outputPath, mergeFolder, logPath, recordCount, failedToCopy, unhandledStringFiles: assetSummary.stringFiles };
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

// ---- analyze (2026-08-25, merge-v1-analyze-port) -- ported from lib/merge-worker.js's own
// analyzeFile/runAnalyze, the read-only preview pass that powers the live Review step
// (override/new-record count, masters, a CELL/WRLD risk flag, per chosen plugin). That file's own
// header explains why it survived the rest of the v1 engine's removal: this was the one piece
// merge-v2-worker.js had no equivalent for. It does now -- this IS the port, and lib/merge-worker.js/
// lib/merge-runner.js are deleted in the same change that adds this (see TECHNICAL.md/the handoff for
// the real before/after comparison that verified it).
//
// Reuses this engine's own staging/load/classification primitives rather than re-deriving them --
// stageItemsV2, initXelibAt, isNewRecord (identical logic to v1's own `isOverride =
// xelib.isOverride(rec) || xelib.isInjected(rec)`, just phrased as its negation), and
// readPluginHeader (already imported above for other uses in this file) are all already exactly what
// analyze needs; nothing v1-specific had to be re-invented except the loading call itself, see
// loadAllForAnalyze's own comment for why that one specifically does NOT reuse loadAllV2.
//
// Deliberately does NOT use the real-game-load-order correction (readGameLoadOrderV2/
// computeFinalLoadOrderV2) the merge-BUILD path applies -- v1's own analyze never did either, and a
// plain topological order (stageItemsV2's own closure -- masters always ahead of dependents) is
// already everything override-vs-new classification needs. Using the corrected order would risk a
// result that looks "more real" but no longer matches what this exact screen has always shown.
//
// loadAllForAnalyze -- v1's own loadAll called xelib.loadPlugins(fileNames, SMARTLOAD=false, false).
// loadAllV2 (the merge-build path) calls it with smartLoad=TRUE, matching zMerge's own real
// mergeLoadService.js:74 xelib.LoadPlugins(loadOrder, true) -- a deliberate, real behavioral
// difference from v1, not an oversight (see loadAllV2's own comment). Reusing loadAllV2 here would
// therefore risk a genuine divergence from what analyze has always produced, which is exactly the
// one thing this port must not do (see the handoff's own before/after verification). This function
// is the one piece of the load path NOT shared with the merge-build path, on purpose.
async function loadAllForAnalyze(fileNames) {
    xelib.loadPlugins(fileNames.join('\n'), false, false);
    await xelib.waitForLoader();
    xelib.clearMessages();
}

function analyzeFileV2(fileHandle, fullPath) {
    const header = readPluginHeader(fullPath);
    const masters = header?.masters || [];
    const records = xelib.getRecords(fileHandle, '', true);
    let newRecordCount = 0;
    let overrideCount = 0;
    let hasCellOrWorldspace = false;
    for (const rec of records) {
        if (isNewRecord(rec)) newRecordCount++; else overrideCount++;
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

async function runAnalyzeV2(items, gameDataDir) {
    const { sandboxRoot, closure } = stageItemsV2(items, gameDataDir);
    try {
        initXelibAt(sandboxRoot + path.sep);
        await loadAllForAnalyze(closure.map((e) => e.fileName));
        const results = items.map((item) => {
            const fh = xelib.fileByName(item.fileName);
            const info = analyzeFileV2(fh, item.fullPath);
            return { fileName: item.fileName, ...info };
        });
        xelib.close();
        return { results };
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
    const { mode, items, outputPath, gameDataDir, mergeName, method } = input;
    if (!items || !items.length) throw userError('No plugins were provided.');
    let result;
    if (mode === 'analyze') {
        result = await runAnalyzeV2(items, gameDataDir);
    } else {
        if (!outputPath) throw userError('No output path was provided.');
        result = await runMergeV2(items, outputPath, gameDataDir, mergeName || path.basename(outputPath, path.extname(outputPath)), method || 'Clean');
    }
    process.stdout.write(JSON.stringify(result));
}

main().catch((e) => {
    if (e.isUserFacing) process.stderr.write('##USERERR## ' + e.message + '\n');
    else process.stderr.write((e.stack || e.message) + '\n');
    process.exit(1);
});
