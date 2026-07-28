'use strict';
// "Clean Up" report backend -- finds staging folders and downloaded archives that Vortex has no
// real relationship with anymore (heavy testing/reinstalling leaves this behind). See
// TECHNICAL.md's "Clean Up report" section for the full design writeup and the real example
// (College Curriculum - Faction Requirement-79929-1-0-0-1670095062) that grounded these rules.
//
// Orphan criteria, confirmed against real state.v2 data before this was written (not assumed):
//   - Scan Staging: a folder is an exception if either (a) no mods###skyrimse### entry has this
//     installationPath at all, or (b) one does, but it has no archiveId AND no
//     attributes###collectionSlug -- a "ghost" mod Vortex silently auto-adopted from an
//     unrecognized staging folder, with no real backing (no download, no collection membership).
//   - Scan Archives: a file is an exception if no downloads###files### entry has this localPath,
//     checked regardless of that download's own state. Files still mid-download (Vortex's own
//     TEMP_DOWNLOAD_PREFIX, "__vortex_tmp_") are skipped entirely -- they legitimately have no
//     download record yet and are not orphans.
//
// Confidence split (added 2026-07-27 after a live test against real data): the (b) "ghost-mod" case
// above cannot tell a truly-abandoned mod apart from a deliberate, no-archive-by-design "fake mod"
// a generator tool creates -- confirmed real-world with DynDOLOD/BodySlide/PGPatcher/Pandora/TexGen
// output folders and other user-authored patch folders all showing up with the exact same
// no-archive/no-collection signature as a genuine orphan. The distinguishing signal the user
// identified: Vortex's OWN download-naming convention always ends a name in
// "-<modId>-<version parts>-<10-digit unix timestamp>" (e.g. the College Curriculum example above);
// a hand-named folder never does. So:
//   - Name matches that pattern -> "exceptions" (confident, safe for the normal bulk delete flow).
//   - Name does NOT match -> "needsReview" (shown in its own "Action Needed: Unrecognized" section,
//     never bulk-deleted by default -- Delete/Exclude are still available, but require the SAME
//     explicit per-item review either way). Bottom line per the user: if in doubt, ask -- never
//     silently assume either delete or keep.
//   - "vortex_collection_*" folders (Vortex's own internal Workshop-tab storage, same pattern
//     already used elsewhere in this project -- see vortex-sync/lib.js) are hard-excluded from
//     BOTH buckets entirely, never shown as a candidate of any kind.
//   - A name in the user's own permanent "Exclude" list (config.json's cleanupIgnoredStaging/
//     cleanupIgnoredArchives, set via the needsReview section's Exclude action) is also hard-excluded
//     from future scans, exactly like vortex_collection_*.
//
// scanArchives ALSO returns a lightweight `hasUninstalledArchives` boolean (archives-only, no
// staging equivalent) -- true if any archive file has a real Vortex download record that no
// currently-installed mod's archiveId actually references. Deliberately just a boolean, not a full
// list: see scanArchives's own comment for why a precise per-file list was scaled back (Vortex's own
// Mods table groups/absorbs multiple download-versions of the same mod in ways not worth
// reproducing exactly here) -- the UI just shows a pointer to check Vortex's own Status filter.
//
// Uses db.iterator() with NO range bounds, same as state-query-worker.js's buildModVersionIndex --
// a range-bounded prefix scan looks like the obvious optimization but is a real, already-hit trap
// here: LevelDB/ClassicLevel key comparison is byte-lexicographic, and '#' (0x23) sorts BEFORE
// almost every real key-segment character (digits/letters are all higher), so a `lt: prefix + '#'`
// bound silently excludes nearly everything. Follow the proven-correct convention instead.

const fs = require('fs');
const path = require('path');
// Naming-convention patterns/helpers live in their own shared module now (lib/download-naming.js) --
// used by both this file and lib/missing-masters-scan.js. Re-exported below (module.exports) so
// anything already importing these names from THIS file keeps working unchanged.
const {
    RECOGNIZED_DOWNLOAD_NAME_PATTERN,
    MANUAL_DOWNLOAD_NAME_PATTERN,
    isRecognizedDownloadName,
    isPossibleManualDownload,
} = require('./download-naming');

const SYNC_LIB_PATH = path.join(__dirname, 'vortex-sync', 'lib.js');
const TEMP_DOWNLOAD_PREFIX = '__vortex_tmp_';
const VORTEX_COLLECTION_FOLDER_PATTERN = /^vortex_collection_/i;

function loadSyncLib() {
    return require(SYNC_LIB_PATH);
}

function stripExt(name) {
    return name.replace(/\.[^./\\]+$/, '');
}

// One pass over the whole DB, gathering everything both scans need -- called once per report load
// rather than once per scan type, so switching between Scan Archives/Scan Staging never re-reads.
async function readModsAndDownloads(db) {
    const modsByInstallPath = new Map(); // installationPath -> { modId, archiveId, collectionSlug }
    const modInfo = new Map(); // modId -> { installationPath, archiveId, collectionSlug }
    const downloadLocalPaths = new Set();
    const downloadInfo = new Map(); // downloadId -> { localPath, state, game }

    for await (const [key, value] of db.iterator()) {
        let m = key.match(/^persistent###mods###skyrimse###(.+?)###installationPath$/);
        if (m) {
            const modId = m[1];
            let installationPath;
            try { installationPath = JSON.parse(value); } catch { installationPath = value; }
            if (!modInfo.has(modId)) modInfo.set(modId, {});
            modInfo.get(modId).installationPath = installationPath;
            continue;
        }
        m = key.match(/^persistent###mods###skyrimse###(.+?)###archiveId$/);
        if (m) {
            // Raw LevelDB value is JSON-encoded (a quoted string, e.g. `"a9aa8862-..."`), same as
            // installationPath/localPath elsewhere in this function -- MUST parse it before ever
            // comparing it against a download's own (unquoted) key id, or the comparison silently
            // never matches anything. Real bug caught live 2026-07-27: without this, the
            // "downloaded but not installed" reverse-lookup flagged EVERY archive, including
            // known-good installed mods, because every archiveId was being compared quoted-vs-bare.
            let archiveId;
            try { archiveId = JSON.parse(value); } catch { archiveId = value; }
            if (!modInfo.has(m[1])) modInfo.set(m[1], {});
            modInfo.get(m[1]).archiveId = archiveId;
            continue;
        }
        m = key.match(/^persistent###mods###skyrimse###(.+?)###attributes###collectionSlug$/);
        if (m) {
            if (!modInfo.has(m[1])) modInfo.set(m[1], {});
            modInfo.get(m[1]).collectionSlug = value;
            continue;
        }
        m = key.match(/^persistent###downloads###files###(.+?)###localPath$/);
        if (m) {
            let localPath;
            try { localPath = JSON.parse(value); } catch { localPath = value; }
            if (localPath) {
                downloadLocalPaths.add(localPath);
                if (!downloadInfo.has(m[1])) downloadInfo.set(m[1], {});
                downloadInfo.get(m[1]).localPath = localPath;
            }
            continue;
        }
        // Both fields below gate whether Vortex's OWN Mods table would ever show this download as a
        // row at all (state === 'finished' AND its game field includes the current game mode) -- a
        // download stuck e.g. paused/queued/failed, or tagged for a different game, is invisible in
        // Vortex's own UI, so this scan's "any uninstalled archives?" signal shouldn't count it as
        // one either.
        m = key.match(/^persistent###downloads###files###(.+?)###state$/);
        if (m) {
            if (!downloadInfo.has(m[1])) downloadInfo.set(m[1], {});
            let state;
            try { state = JSON.parse(value); } catch { state = value; }
            downloadInfo.get(m[1]).state = state;
            continue;
        }
        m = key.match(/^persistent###downloads###files###(.+?)###game$/);
        if (m) {
            if (!downloadInfo.has(m[1])) downloadInfo.set(m[1], {});
            let game;
            try { game = JSON.parse(value); } catch { game = value; }
            downloadInfo.get(m[1]).game = game;
        }
    }

    for (const [modId, info] of modInfo) {
        if (info.installationPath) modsByInstallPath.set(info.installationPath, { modId, ...info });
    }

    // Which downloads are ACTUALLY used by a real mod right now -- checked by reverse-lookup
    // (does any mod's own archiveId point to this download), never by trusting a download's own
    // `installed.modId` back-reference. Confirmed necessary 2026-07-27 by a real case: a download's
    // `installed.modId` still pointed at a modId whose mods### entry no longer existed at all (the
    // mod had been uninstalled/removed, and Vortex never cleared the download's stale reference) --
    // so the download's own claim of "installed" cannot be trusted as the source of truth.
    const usedArchiveIds = new Set();
    for (const info of modInfo.values()) {
        if (info.archiveId) usedArchiveIds.add(info.archiveId);
    }
    const downloadsByLocalPath = new Map();
    for (const [downloadId, info] of downloadInfo) {
        if (!info.localPath) continue;
        // Mirrors Vortex's own getDownloadGames.ts exactly: `game` can be a string or an array;
        // missing entirely means Vortex itself logs a warning and treats it as belonging to no game.
        const games = Array.isArray(info.game) ? info.game : info.game ? [info.game] : [];
        // Hardcoded 'skyrimse', matching every other key pattern in this file (this project only
        // ever reads the skyrimse game slice of state.v2, never syncLib.GAME_ID indirection).
        const countsAsModRow = info.state === 'finished' && games.includes('skyrimse');
        downloadsByLocalPath.set(info.localPath, { id: downloadId, ...info, countsAsModRow });
    }

    return { modsByInstallPath, downloadLocalPaths, usedArchiveIds, downloadsByLocalPath };
}

// Lists a directory's immediate entries, filtered to a kind ('dir' for staging folders, 'file' for
// archives). Missing directory (unconfigured or not-yet-created) returns an empty list rather than
// throwing -- callers surface a clear "nothing configured" state instead of a stack trace.
function listImmediateEntries(dir, kind) {
    if (!dir || !fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true })
        .filter((e) => (kind === 'dir' ? e.isDirectory() : e.isFile()))
        .map((e) => e.name);
}

async function scanStaging(stateDir, stagingDir, ignoredNames = []) {
    const syncLib = loadSyncLib();
    const ignored = new Set(ignoredNames);
    return syncLib.withStateDb(stateDir, async (db) => {
        const { modsByInstallPath } = await readModsAndDownloads(db);
        const folders = listImmediateEntries(stagingDir, 'dir')
            .filter((f) => !VORTEX_COLLECTION_FOLDER_PATTERN.test(f))
            .filter((f) => !ignored.has(f));
        const exceptions = [];
        const needsReview = [];
        for (const folder of folders) {
            const mod = modsByInstallPath.get(folder);
            let reason;
            if (!mod) reason = 'no-mod-entry';
            else if (!mod.archiveId && !mod.collectionSlug) reason = 'ghost-mod';
            else continue; // has a real archive or collection link -- not an exception at all
            const item = { name: folder, reason };
            if (isRecognizedDownloadName(folder)) {
                exceptions.push(item);
            } else {
                if (isPossibleManualDownload(folder)) item.hint = 'possible-manual-download';
                needsReview.push(item);
            }
        }
        return { total: folders.length, exceptions, needsReview };
    });
}

async function scanArchives(stateDir, downloadsDir, ignoredNames = []) {
    const syncLib = loadSyncLib();
    // Compared by base name (extension stripped on BOTH sides), not the raw string -- confirmed
    // 2026-07-27 this needed fixing: a user manually adding an exclude entry via Settings could
    // easily type the name without its ".7z"/".rar"/etc, and a raw-string Set.has() would then
    // silently never match, so the "excluded" archive kept reappearing in every scan. Stripping
    // both sides makes it match regardless of whether the extension was included.
    const ignored = new Set(ignoredNames.map(stripExt));
    return syncLib.withStateDb(stateDir, async (db) => {
        const { downloadLocalPaths, usedArchiveIds, downloadsByLocalPath } = await readModsAndDownloads(db);
        const files = listImmediateEntries(downloadsDir, 'file')
            .filter((f) => !f.startsWith(TEMP_DOWNLOAD_PREFIX))
            .filter((f) => !ignored.has(stripExt(f)));
        const exceptions = [];
        const needsReview = [];
        // Archives-only (confirmed 2026-07-27): a staging folder always shows Enabled/Disabled in
        // Vortex, never Uninstalled/Never Installed -- this bucket has no staging equivalent.
        // A download record existing is NOT proof a mod still uses it -- see the reverse-lookup note
        // on usedArchiveIds in readModsAndDownloads. Real example that grounded this: "OWL -
        // NordwarUA Variants Patch-50057-1-2-1622411906" still had a downloads### record (with a
        // stale installed.modId) but no mods### entry anywhere referenced it via archiveId.
        //
        // This started as a full per-archive list with friendly metadata (name/author/version) and
        // its own delete UI, matched against Vortex's own Uninstalled/Never-Installed status. Scaled
        // back 2026-07-27 after live investigation: Vortex's Mods table also GROUPS/absorbs multiple
        // download-versions of the same mod (modGrouping.ts's byModId+byFile+byEnabled -- an old,
        // unused download of a mod you still have installed under a newer file gets folded into that
        // mod's own row as a version-choice, not shown as its own "Uninstalled" row), so a raw
        // per-file orphan count could never exactly match what Vortex's UI displays without
        // reimplementing that whole grouping algorithm -- not worth it for what turned out to be a
        // rare case in practice (confirmed by the user: only ~3 mods in their own real library ever
        // show a version dropdown at all). The user's own call: keep this as a lightweight boolean
        // signal ("are there any at all?") to show a simple pointer, not a precise list to act on
        // here -- Vortex's own Mods table (Status filter) is the actual source of truth for this.
        let hasUninstalledArchives = false;
        for (const file of files) {
            if (downloadLocalPaths.has(file)) {
                const download = downloadsByLocalPath.get(file);
                // countsAsModRow mirrors Vortex's own ModList.tsx row-inclusion gate (state ===
                // 'finished' AND game includes 'skyrimse') -- a download failing either check is
                // invisible in Vortex's own Mods table, so this signal shouldn't count it either.
                if (download && download.countsAsModRow && !usedArchiveIds.has(download.id)) {
                    hasUninstalledArchives = true;
                }
                continue;
            }
            let sizeBytes = null;
            try { sizeBytes = fs.statSync(path.join(downloadsDir, file)).size; } catch { /* ignore */ }
            const item = { name: file, sizeBytes };
            if (isRecognizedDownloadName(stripExt(file))) {
                exceptions.push(item);
            } else {
                if (isPossibleManualDownload(stripExt(file))) item.hint = 'possible-manual-download';
                needsReview.push(item);
            }
        }
        return { total: files.length, exceptions, needsReview, hasUninstalledArchives };
    });
}

// Name-matches the OTHER side, THEN independently re-validates each match is still a real orphan
// against Vortex's actual state -- confirmed necessary 2026-07-27 by a real near-miss: deleting an
// orphaned staging folder can cross-match an archive that shares its base name PURELY by
// coincidence but is actually a separate, genuinely Vortex-tracked download (confirmed live:
// "Andrealletius' Renaming Project.zip" has a real `downloads###files###...` record, even though
// the staging folder "Andrealletius' Renaming Project" it name-matched was a genuine ghost-mod).
// A same-name match is necessary but NOT sufficient proof both sides came from the same install --
// only a real Vortex-state check can confirm that. Requires Vortex closed, same as scanStaging/
// scanArchives (this is why crossCheck is now async and needs stateDir).
async function crossCheck(stateDir, kind, deletedNames, otherDir) {
    // kind describes what was JUST deleted; the OTHER side is what we're checking here.
    const wantedBaseNames = new Set(
        kind === 'archives' ? deletedNames.map(stripExt) : deletedNames
    );
    const otherKind = kind === 'archives' ? 'dir' : 'file';
    const entries = listImmediateEntries(otherDir, otherKind);
    const candidates = entries.filter((entry) => {
        const compareName = otherKind === 'file' ? stripExt(entry) : entry;
        return wantedBaseNames.has(compareName);
    });
    if (candidates.length === 0) return [];

    const syncLib = loadSyncLib();
    return syncLib.withStateDb(stateDir, async (db) => {
        const { modsByInstallPath, downloadLocalPaths } = await readModsAndDownloads(db);
        const matches = [];
        for (const name of candidates) {
            const stillOrphaned = otherKind === 'dir'
                ? (() => { const mod = modsByInstallPath.get(name); return !mod || (!mod.archiveId && !mod.collectionSlug); })()
                : !downloadLocalPaths.has(name);
            if (stillOrphaned) matches.push({ name });
        }
        return matches;
    });
}

// Deletes each given absolute path (recursive for directories, plain unlink for files). Returns
// per-path results instead of throwing on the first failure, so one locked file doesn't silently
// hide the rest -- the UI reports every failure individually.
function deleteEntries(paths) {
    const results = [];
    for (const p of paths) {
        try {
            fs.rmSync(p, { recursive: true, force: false });
            results.push({ path: p, ok: true });
        } catch (e) {
            results.push({ path: p, ok: false, error: e.message });
        }
    }
    return results;
}

module.exports = {
    TEMP_DOWNLOAD_PREFIX,
    VORTEX_COLLECTION_FOLDER_PATTERN,
    RECOGNIZED_DOWNLOAD_NAME_PATTERN,
    MANUAL_DOWNLOAD_NAME_PATTERN,
    isRecognizedDownloadName,
    isPossibleManualDownload,
    scanStaging,
    scanArchives,
    crossCheck,
    deleteEntries,
};
