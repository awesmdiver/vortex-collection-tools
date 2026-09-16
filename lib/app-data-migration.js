'use strict';
// One-time move of every tool's "remembered data" out of wherever it used to live (a retired
// per-tool Settings field, a hardcoded config/<name>.json, or Rebuild Collection's own reports
// folder under logsDir) into the single App Data folder (2026-09-14, "split Logs from App Data" --
// see TECHNICAL.md's own section for the full writeup and the director's own motivating incident: a
// cleanup of an unconfigured scratch/logs folder deleted every real Rebuild Collection run report
// once, because those reports lived inside the logs folder).
//
// Runs once at server startup (web/server.js's main(), right after config.json is read), and is a
// safe no-op every time after the real move already happened -- each entry below only ever copies a
// file that's STILL SITTING at its old location; once that's gone (moved last time, or never
// existed), there's nothing left to do. Never overwrites a NEWER file already in App Data with an
// OLDER one from the legacy location (mtime-compared per file) -- if App Data already has this data
// (e.g. the app kept running against it after an earlier partial migration), the legacy copy is
// simply removed rather than clobbering it.
//
// Copy-then-verify-then-remove, never move-then-hope: each file is compared by SIZE after copying
// (cheap, and enough to catch a truncated/interrupted copy -- a full hash isn't needed for a same-
// filesystem copy that either completes or throws) before its legacy copy is deleted. A verification
// failure leaves BOTH copies in place and is logged as an error, never silently drops data.
//
// REVISED 2026-09-15 ("the one-time move leaves Update Collection backups where they are, and keeps
// each file's real dates" -- a design-side sandbox review, and a real incident on the director's own
// install, both found before/right as this shipped). Two real bugs, both about NEVER moving a whole
// shared folder on trust alone:
//   1. `ucv2TrackingDir` and `syncBackupRoot` can be (and on the director's own install, ARE) the
//      SAME real folder -- Update Collection's own per-collection tracking subfolders sit right next
//      to lib/vortex-sync/lib.js's own flat backup-snapshot files (`saveBackup`'s own
//      `<collectionModId>-<stamp>.json`) and web/clear-update-flags-routes.js's own `update-flags/`
//      subfolder. The old code walked EVERYTHING found under `ucv2TrackingDir` and moved it all,
//      which silently carried 7 real backups (and the update-flags folder) into App Data, emptying
//      Update Collection's own restore list. Fixed below: every retired folder setting is now walked
//      by a function that only ever recognizes and moves the SPECIFIC files that setting's own real
//      code writes -- never "everything in this directory" -- so a coincidentally-shared folder is
//      safe by construction, not by luck.
//   2. A moved file's own on-disk creation time becomes "the moment it was copied here" -- Windows
//      itself has no API Node exposes for SETTING a file's creation time, only reading it. The App
//      Data checklist's own "Created" column existed specifically so the user could pick what to
//      delete by date; showing the move time for everything defeats that the moment the move runs.
//      Fixed below: the REAL original creation time (captured from the source file, one instant
//      before it's copied) is recorded in a small per-App-Data-folder sidecar
//      (`.origin-dates.json`) and used by lib/app-data-manager.js's own checklist instead of the
//      copy's own (wrong) birthtime.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const appConfig = require('./app-config');
const { loadBackup } = require('./vortex-sync/lib');

const LEGACY_CONFIG_DIR = path.join(__dirname, '..', 'config');
const ORIGIN_DATES_FILENAME = '.origin-dates.json';

function safeStat(p) {
    try { return fs.statSync(p); } catch { return null; }
}

// ---------- Real creation dates, preserved across a move Windows itself can't preserve ----------

function relKey(appDataDir, filePath) {
    return path.relative(appDataDir, filePath).split(path.sep).join('/');
}

// One JSON sidecar per App Data folder -- {"<path relative to appDataDir, forward-slash>": createdAtMs}.
// Loaded once per migration run, written once at the end (see runMigration) rather than per-file, so
// a large first-time migration doesn't do hundreds of tiny rewrites of the same small file.
function createOriginDatesTracker(appDataDir) {
    const filePath = path.join(appDataDir, ORIGIN_DATES_FILENAME);
    let map = {};
    try {
        map = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch { /* none recorded yet -- a fresh App Data folder, or one from before this fix */ }
    let dirty = false;
    return {
        // Called right after a real move succeeds, with the SOURCE's own stat (taken before the
        // copy, so its birthtime is still the truth) -- never overwrites an existing entry, so
        // re-running the migration after a partial failure can't clobber an already-recorded date
        // with a later, wrong one.
        record(destPath, sourceStat) {
            if (!sourceStat) return;
            const key = relKey(appDataDir, destPath);
            if (key in map) return;
            map[key] = sourceStat.birthtimeMs || sourceStat.mtimeMs;
            dirty = true;
        },
        save() {
            if (!dirty) return;
            try {
                fs.writeFileSync(filePath, JSON.stringify(map, null, 2));
            } catch (e) {
                console.error(`[app-data-migration] Could not save ${ORIGIN_DATES_FILENAME}: ${e.message}`);
            }
        },
    };
}

// ---------- Core file move (unchanged shape, now records the origin date too) ----------

// Copies one file from `src` to `dest` (creating dest's parent folder as needed), verifies the copy
// by size, then removes `src` -- unless `dest` already exists and is at least as new as `src`, in
// which case `src` is simply dropped (already migrated, or App Data already has the current copy).
// `originDates` (optional) records the source's real creation time against the destination path --
// see createOriginDatesTracker above. Returns 'moved' | 'skipped-already-current' | 'error'.
function migrateOneFile(src, dest, originDates) {
    const srcStat = safeStat(src);
    if (!srcStat || !srcStat.isFile()) return 'skipped-already-current'; // nothing at the legacy path
    const destStat = safeStat(dest);
    if (destStat && destStat.mtimeMs >= srcStat.mtimeMs) {
        fs.rmSync(src, { force: true });
        return 'skipped-already-current';
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try {
        fs.copyFileSync(src, dest);
        const copiedStat = fs.statSync(dest);
        if (copiedStat.size !== srcStat.size) {
            throw new Error(`size mismatch after copy (${srcStat.size} -> ${copiedStat.size})`);
        }
        fs.rmSync(src, { force: true });
        if (originDates) originDates.record(dest, srcStat);
        return 'moved';
    } catch (e) {
        console.error(`[app-data-migration] Could not move "${src}" -> "${dest}": ${e.message}`);
        return 'error';
    }
}

// ---------- Precise movers -- each recognizes ONLY the real files its own tool writes ----------
// Never "move everything in this directory": a retired folder setting can be (and on a real install,
// is) the SAME physical folder as something else entirely -- see this file's own header comment.

// Files directly under `srcDir` (no recursion) whose name satisfies `predicate` -- used for a flat
// folder where the real tool output has a recognizable shape (Rebuild Collection's own
// `rebuild-*.json` reports, Cycle Helper's own `*.json` session files, Archive Finder's own db/-wal/
// -shm files) and anything else sitting there (an unrelated file, a subfolder) is left completely
// alone. Removes `srcDir` itself only once it's fully empty -- a leftover non-matching file keeps
// both itself and its folder right where they are.
function migrateMatchingFiles(srcDir, destDir, predicate, originDates) {
    const result = { moved: 0, skipped: 0, errors: [] };
    if (!srcDir) return result;
    if (path.resolve(srcDir) === path.resolve(destDir)) return result; // already pointed at App Data itself
    let entries;
    try {
        entries = fs.readdirSync(srcDir, { withFileTypes: true });
    } catch {
        return result; // legacy folder doesn't exist (or isn't readable) -- nothing to migrate
    }
    for (const entry of entries) {
        if (!entry.isFile() || !predicate(entry.name)) continue;
        const outcome = migrateOneFile(path.join(srcDir, entry.name), path.join(destDir, entry.name), originDates);
        if (outcome === 'moved') result.moved++;
        else if (outcome === 'skipped-already-current') result.skipped++;
        else result.errors.push(`${path.join(srcDir, entry.name)}: could not verify copy`);
    }
    try { if (fs.readdirSync(srcDir).length === 0) fs.rmdirSync(srcDir); } catch { /* best-effort -- non-matching content left on purpose */ }
    return result;
}

// Update Collection's own per-collection tracking files ONLY -- lib/update-collection-v2-runner.js's
// getUcv2TrackingDir writes exactly `ucv2-apply-status.json` and `pre-update-<stamp>.json`, always
// one level under a collectionModId-named subfolder. `ucv2TrackingDir` can be the SAME real folder as
// `syncBackupRoot` (confirmed on the director's own install) -- that folder ALSO holds
// lib/vortex-sync/lib.js's own flat backup-snapshot `.json` files (never inside a subfolder) and
// web/clear-update-flags-routes.js's own `update-flags/` subfolder (never containing a tracking
// file). Both are left exactly where they are: a file directly at `srcDir`'s own root is never
// touched (tracking data is always one level down), and a subfolder is only ever descended into if
// it actually contains at least one real tracking file -- `update-flags/` has none, so it's skipped
// whole. Even inside a genuine tracking subfolder, only the matching files move -- anything else a
// user dropped in there by hand stays.
function isUcv2TrackingFile(name) {
    return name === 'ucv2-apply-status.json' || /^pre-update-.*\.json$/i.test(name);
}
function migrateUcv2Tracking(srcDir, destDir, originDates) {
    const result = { moved: 0, skipped: 0, errors: [] };
    if (!srcDir) return result;
    if (path.resolve(srcDir) === path.resolve(destDir)) return result;
    let entries;
    try {
        entries = fs.readdirSync(srcDir, { withFileTypes: true });
    } catch {
        return result;
    }
    for (const entry of entries) {
        if (!entry.isDirectory()) continue; // never a file sitting directly at this root -- see header comment
        const srcSub = path.join(srcDir, entry.name);
        let subEntries;
        try {
            subEntries = fs.readdirSync(srcSub, { withFileTypes: true });
        } catch {
            continue;
        }
        const trackingFiles = subEntries.filter((e) => e.isFile() && isUcv2TrackingFile(e.name));
        if (trackingFiles.length === 0) continue; // not a tracking subfolder (e.g. "update-flags") -- leave it whole
        const destSub = path.join(destDir, entry.name);
        for (const f of trackingFiles) {
            const outcome = migrateOneFile(path.join(srcSub, f.name), path.join(destSub, f.name), originDates);
            if (outcome === 'moved') result.moved++;
            else if (outcome === 'skipped-already-current') result.skipped++;
            else result.errors.push(`${path.join(srcSub, f.name)}: could not verify copy`);
        }
        try { if (fs.readdirSync(srcSub).length === 0) fs.rmdirSync(srcSub); } catch { /* a non-tracking file left on purpose keeps its folder too */ }
    }
    return result;
}

const ARCHIVE_FINDER_FILENAME_PATTERN = /^(vct_archive|archive)\.db(-wal|-shm)?$/i;

// ---------- One entry per data kind this feature moves ----------
// See TECHNICAL.md's "Logs vs App Data" section for the authoritative table this mirrors.
// `legacy`/`legacyDir` may be null/undefined (a required field the user never configured, or an
// optional one with no built-in default) -- every mover above treats that as "nothing to migrate."
//
// kind: 'file' -- one exact file. 'matching-files' -- every file directly under `legacy` whose name
// satisfies `predicate` (never a whole-directory move). 'ucv2-tracking' -- Update Collection's own
// specialized mover above.
function buildPlan(fileConfig) {
    const plan = [];
    // Rebuild Collection run reports -- getLogsDir('rebuild-collection') is the CURRENT resolution
    // (depends on the logsDir setting), captured here exactly as every real caller already computes
    // it, so this migrates whatever is REALLY there today, not a guessed default. Only files matching
    // web/rebuild-routes.js's own naming (`rebuild-<collectionModId>-<timestamp>.json`) -- the same
    // pattern web/settings-routes.js's own (now-retired) log-pattern check used.
    plan.push({
        tool: 'Rebuild Collection', label: 'run reports', kind: 'matching-files',
        legacy: appConfig.getLogsDir('rebuild-collection'), subdir: 'rebuild-collection/reports',
        predicate: (name) => /^rebuild-.+\.json$/i.test(name),
    });
    plan.push({ tool: 'Rebuild Collection', label: 'off-site import choices', kind: 'file', legacy: path.join(LEGACY_CONFIG_DIR, 'offsite-import-map.json'), subdir: 'rebuild-collection', filename: 'offsite-import-map.json' });
    // Update Collection tracking -- NEVER a whole-directory move; see migrateUcv2Tracking's own
    // header comment for exactly why (this folder can be, and on a real install is, the SAME
    // physical folder as syncBackupRoot).
    plan.push({ tool: 'Update Collection', label: 'tracking', kind: 'ucv2-tracking', legacy: fileConfig.ucv2TrackingDir || null, subdir: 'update-collection/tracking' });
    plan.push({ tool: 'Update Collection', label: 'backup-ratio dismissals', kind: 'file', legacy: path.join(LEGACY_CONFIG_DIR, 'backup-ratio-dismiss-state.json'), subdir: 'update-collection', filename: 'backup-ratio-dismiss-state.json' });
    // Cycle Helper history -- lib/cycle-helper-history.js writes one `.json` file per session,
    // nothing else, but this is still narrowed to that extension rather than trusted as a dedicated
    // folder -- same "recognize the real shape, never trust the whole directory" discipline as
    // everything else here.
    plan.push({
        tool: 'Cycle Helper', label: 'fix history', kind: 'matching-files',
        legacy: fileConfig.cycleHelperHistoryDir || path.join(LEGACY_CONFIG_DIR, 'cycle-helper-history'), subdir: 'cycle-helper/history',
        predicate: (name) => name.toLowerCase().endsWith('.json'),
    });
    plan.push({ tool: 'Cycle Helper', label: 'rules snapshot', kind: 'file', legacy: path.join(LEGACY_CONFIG_DIR, 'cycle-helper-snapshot.json'), subdir: 'cycle-helper', filename: 'cycle-helper-snapshot.json' });
    // Mod Exceptions / Mod Scrub -- each of these "folder" settings only ever held ONE real file
    // (lib/mod-exception-store.js / lib/cleanup-exclude-store.js's own FILE_NAME); moving that one
    // exact file, not the folder, means anything else ever placed alongside it stays put.
    plan.push({ tool: 'Mod Exceptions', label: 'exceptions list', kind: 'file', legacy: fileConfig.modExceptionListDir ? path.join(fileConfig.modExceptionListDir, 'mod-exceptions.json') : null, subdir: 'mod-exceptions', filename: 'mod-exceptions.json' });
    plan.push({ tool: 'Mod Scrub', label: 'exclude list', kind: 'file', legacy: fileConfig.cleanupExcludeListDir ? path.join(fileConfig.cleanupExcludeListDir, 'exclude-list.json') : null, subdir: 'mod-scrub', filename: 'exclude-list.json' });
    plan.push({ tool: 'Work Through Report', label: 'progress', kind: 'file', legacy: path.join(LEGACY_CONFIG_DIR, 'work-through-state.json'), subdir: 'work-through', filename: 'work-through-state.json' });
    plan.push({ tool: 'Rebuild Missing Files', label: 'last-checked/fixed dates', kind: 'file', legacy: path.join(LEGACY_CONFIG_DIR, 'rebuild-missing-last-fixed-state.json'), subdir: 'rebuild-missing-files', filename: 'rebuild-missing-last-fixed-state.json' });
    plan.push({ tool: 'Workshop Report', label: 'fetch state', kind: 'file', legacy: path.join(LEGACY_CONFIG_DIR, 'workshop-report-fetch-state.json'), subdir: 'workshop-report', filename: 'workshop-report-fetch-state.json' });
    plan.push({ tool: 'Rules Generator', label: 'anomaly choices', kind: 'file', legacy: path.join(LEGACY_CONFIG_DIR, 'rules-generator-anomaly-choices.json'), subdir: 'rules-generator', filename: 'rules-generator-anomaly-choices.json' });
    // Archive Finder -- the live db plus its own WAL/SHM sidecars if present (SQLite leaves those
    // behind only when a connection wasn't cleanly closed), and the pre-rename `archive.db` shape
    // from before GitHub issue #4's fix -- never anything else that might be sitting in that folder.
    plan.push({
        tool: 'Archive Finder', label: 'search index', kind: 'matching-files',
        legacy: fileConfig.archiveFinderDbDir || null, subdir: 'archive-finder/index',
        predicate: (name) => ARCHIVE_FINDER_FILENAME_PATTERN.test(name),
    });
    plan.push({ tool: 'Merge Plugins', label: 'script relink cache', kind: 'file', legacy: path.join(LEGACY_CONFIG_DIR, 'relink-scripts-cache.json'), subdir: 'merge-plugins', filename: 'relink-scripts-cache.json' });
    return plan;
}

// ---------- Reverse restoration: put back anything an earlier, buggier run moved by mistake ----------

// Small, synchronous MD5 -- deliberately NOT lib/file-hash.js's own streaming hashFileMd5 (async,
// built for multi-gigabyte archives). A real backup snapshot is a small JSON file (a handful of KB to
// maybe a few hundred), and this whole migration module is synchronous top to bottom by design (it
// runs once, inline, before web/server.js finishes booting) -- pulling in an async hash here would
// mean restructuring the entire call chain for one small comparison.
function hashFileSync(filePath) {
    return crypto.createHash('md5').update(fs.readFileSync(filePath)).digest('hex');
}

function filesAreIdentical(a, b) {
    const statA = safeStat(a);
    const statB = safeStat(b);
    if (!statA || !statB || statA.size !== statB.size) return false;
    return hashFileSync(a) === hashFileSync(b);
}

// Finds any REAL Update Collection backup-snapshot file sitting directly at App Data's own
// update-collection/tracking root (never inside a per-collection subfolder -- a genuine backup is
// always flat) and moves it back to syncBackupRoot, exactly reversing the earlier bug (see this
// file's own header comment). Detected the SAME way lib/vortex-sync/lib.js's own listBackups()
// already validates a real backup -- loadBackup()'s schemaVersion check -- never a filename guess,
// since a backup's own filename embeds the collectionModId and isn't otherwise distinguishable from
// any other .json someone might have dropped there.
//
// When syncBackupRoot already has an identical file (confirmed by size AND content hash, not just a
// name match or an mtime comparison) -- the exact shape of the director's own install, where the
// design side had already manually copied these back -- the stray App Data copy is simply removed
// rather than creating a duplicate. When the destination file exists but genuinely differs, NEITHER
// copy is touched and this is logged for a human to look at -- a backup file's own content must never
// be silently overwritten. Called every startup (idempotent: nothing left to restore is a no-op).
function restoreStrayBackups(appDataDir, syncBackupRoot) {
    const trackingRoot = path.join(appDataDir, 'update-collection', 'tracking');
    let entries;
    try {
        entries = fs.readdirSync(trackingRoot, { withFileTypes: true });
    } catch {
        return { restored: 0, deduped: 0, errors: [] };
    }
    const strayBackups = [];
    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) continue;
        if (entry.name === ORIGIN_DATES_FILENAME) continue;
        const full = path.join(trackingRoot, entry.name);
        try {
            loadBackup(full); // throws if this isn't a real, schema-valid backup snapshot
            strayBackups.push(full);
        } catch { /* not a backup -- something else entirely; never touched by this function */ }
    }
    const result = { restored: 0, deduped: 0, errors: [] };
    if (strayBackups.length === 0) return result;
    if (!syncBackupRoot) {
        console.error(`[app-data-migration] Found ${strayBackups.length} real Update Collection backup(s) misplaced in App Data, but no Update Collection backups folder is configured to put them back in -- left in place: ${strayBackups.join(', ')}`);
        result.errors.push('syncBackupRoot not configured');
        return result;
    }
    for (const strayPath of strayBackups) {
        const name = path.basename(strayPath);
        const destPath = path.join(syncBackupRoot, name);
        if (fs.existsSync(destPath)) {
            if (filesAreIdentical(strayPath, destPath)) {
                fs.rmSync(strayPath, { force: true });
                result.deduped++;
            } else {
                console.error(`[app-data-migration] "${name}" exists in both App Data and the Update Collection backups folder with DIFFERENT content -- leaving both in place for you to check.`);
                result.errors.push(`${name}: content differs at both locations`);
            }
            continue;
        }
        const outcome = migrateOneFile(strayPath, destPath, null); // no origin-date tracking needed -- this file already lives in a real backups folder the checklist never lists
        if (outcome === 'moved') result.restored++;
        else if (outcome !== 'skipped-already-current') result.errors.push(`${name}: could not restore to the backups folder`);
    }
    if (result.restored > 0 || result.deduped > 0) {
        console.log(`[app-data-migration] Restored ${result.restored} misplaced Update Collection backup(s) to "${syncBackupRoot}", removed ${result.deduped} duplicate copy/copies already there.`);
    }
    return result;
}

// Removes every now-empty subfolder under `dir`, recursively (deepest first) -- cleans up the empty
// per-collection shells an earlier buggy run left behind (both genuinely-empty tracking folders that
// were already empty in the legacy location, and stray folders a since-fixed test/verify script
// created by writing into the real configured folder instead of a scratch one). Never removes `dir`
// itself, and never removes a folder that still has real content -- only ever prunes emptiness this
// migration (or something else) already left behind. Safe to run every startup.
function pruneEmptyDirsRecursive(dir) {
    const removed = [];
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return removed;
    }
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const sub = path.join(dir, entry.name);
        removed.push(...pruneEmptyDirsRecursive(sub));
        try {
            if (fs.readdirSync(sub).length === 0) {
                fs.rmdirSync(sub);
                removed.push(sub);
            }
        } catch { /* best-effort */ }
    }
    return removed;
}

// ---------- Orchestration ----------

// Runs the whole plan against `appDataDir`, then the reverse-restoration and empty-folder cleanup
// passes above. Returns a per-entry result list for logging/testing; never throws -- one entry's
// failure (logged, both copies left in place) must never block the rest.
// Calls buildPlan via `module.exports.` (not the bare local binding) -- deliberately, so a test can
// mock `appDataMigration.buildPlan` by reassigning the exported property and have it actually take
// effect here (see lib/app-config.js's own getLogsDir for the identical reasoning/gotcha: a bare
// local call always resolves to this module's own original closure, silently ignoring the mock).
function runMigration(appDataDir, fileConfig) {
    const originDates = createOriginDatesTracker(appDataDir);
    const results = [];
    for (const entry of module.exports.buildPlan(fileConfig)) {
        const destDir = path.join(appDataDir, entry.subdir);
        let outcome;
        if (entry.kind === 'file') {
            outcome = entry.legacy ? migrateOneFile(entry.legacy, path.join(destDir, entry.filename), originDates) : 'skipped-already-current';
            results.push({ ...entry, outcome });
        } else if (entry.kind === 'ucv2-tracking') {
            const dirResult = migrateUcv2Tracking(entry.legacy, destDir, originDates);
            outcome = dirResult.errors.length > 0 ? 'error' : (dirResult.moved > 0 ? 'moved' : 'skipped-already-current');
            results.push({ ...entry, outcome, moved: dirResult.moved, skipped: dirResult.skipped, errors: dirResult.errors });
        } else { // 'matching-files'
            const dirResult = migrateMatchingFiles(entry.legacy, destDir, entry.predicate, originDates);
            outcome = dirResult.errors.length > 0 ? 'error' : (dirResult.moved > 0 ? 'moved' : 'skipped-already-current');
            results.push({ ...entry, outcome, moved: dirResult.moved, skipped: dirResult.skipped, errors: dirResult.errors });
        }
    }
    originDates.save();
    const moved = results.filter((r) => r.outcome === 'moved' || r.moved > 0);
    if (moved.length > 0) {
        console.log(`[app-data-migration] Moved ${moved.length} data kind(s) into App Data ("${appDataDir}"): ${moved.map((r) => `${r.tool} ${r.label}`).join(', ')}.`);
    }
    for (const r of results) {
        if (r.outcome === 'error' || (r.errors && r.errors.length > 0)) {
            console.error(`[app-data-migration] Problem migrating ${r.tool} ${r.label}: ${(r.errors || ['see above']).join('; ')}`);
        }
    }

    restoreStrayBackups(appDataDir, fileConfig.syncBackupRoot);
    const pruned = pruneEmptyDirsRecursive(path.join(appDataDir, 'update-collection', 'tracking'));
    if (pruned.length > 0) {
        console.log(`[app-data-migration] Removed ${pruned.length} empty leftover folder(s) under App Data's Update Collection tracking: ${pruned.join(', ')}.`);
    }

    return results;
}

// Called once at server startup (web/server.js's main()) -- a no-op when App Data isn't configured
// yet (nothing moves; every tool keeps reading its data from wherever it already was, exactly
// today's behavior) or once everything has already been migrated (every legacy location is already
// gone, so each entry resolves to 'skipped-already-current' immediately).
function migrateIfConfigured(fileConfig) {
    const appDataDir = fileConfig.appDataDir;
    if (!appDataDir) return [];
    fs.mkdirSync(appDataDir, { recursive: true });
    return module.exports.runMigration(appDataDir, fileConfig);
}

module.exports = {
    buildPlan, migrateOneFile, migrateMatchingFiles, migrateUcv2Tracking,
    restoreStrayBackups, pruneEmptyDirsRecursive, runMigration, migrateIfConfigured,
};
