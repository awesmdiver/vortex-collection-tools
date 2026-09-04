'use strict';
// Shared "is this plugin on record as merged away" lookup -- built once from the SAME saved-merge
// discovery Merge History's own report already uses (web/merge-history-routes.js's findAllMergeJsons,
// reused directly here, not reimplemented -- see that file's own header comment for the merge.json
// shape this reads: lib/merge-v2-worker.js's writeArtifacts, enriched by web/merge-routes.js's own
// enrichMergeJsonForRestore with mergedPluginName/action/collectionName/stagingFolderName/backupPath).
//
// Used by Update Collection v2's own reviewUpdate (lib/update-collection-v2-runner.js) to flag an
// Updated/Added mod whose plugin is on record as part of a merge, BEFORE Apply would silently
// re-enable or re-stage it. Deliberately never reads live Plugins.txt/staging state the way Merge
// History's own computeMergeState does -- that three-state drift computation is a SEPARATE, already-
// shipped concern (has this merge already drifted back?); this lookup only answers "is this plugin ON
// RECORD as merged", a plain fact from the saved merge.json regardless of current drift state.
//
// Matching a collection.json mod entry (mod.source.logicalFilename || mod.name -- the SAME identity
// key scanCollectionPlugins/walkStagingForPlugins already use) to a saved merge's plugins[] entries
// goes through each plugin's own recorded `stagingFolderName` (the REAL, on-disk staging folder name
// at merge time, e.g. "SomeMod-12345-1-0-1700000000") rather than a live staging-folder scan --
// deliberately: for a 'remove'/'backup-remove' merge the plugin file (and sometimes its whole staging
// presence) may no longer exist to scan at all, which is exactly the case this needs to catch, not
// miss. stripDownloadNameSuffix normalizes ONLY the raw folder-name side, matching merge-plugin-
// scan.js's own established asymmetric convention exactly (collection.json's own name/logicalFilename
// is already Vortex's "clean" identity, never itself download-suffix-stripped).

const { findAllMergeJsons } = require('../web/merge-history-routes');
const { stripDownloadNameSuffix } = require('./download-naming');

function normalizeStagingFolderName(rawFolderName) {
    return stripDownloadNameSuffix(String(rawFolderName || '')).trim().toLowerCase();
}

function normalizeModMatchKey(matchKey) {
    return String(matchKey || '').trim().toLowerCase();
}

// Returns { byFilenameLower, byStagingFolderKeyLower }:
//   - byFilenameLower: Map<lowercased plugin filename, {mergeId, mergeName, action, filename}> --
//     "which plugin filenames are on record as merged away, and which merge produced them" (this
//     feature's own scope item 1). First merge found wins on a filename collision across multiple
//     saved merges -- rare (the same plugin merged away twice), and no real merge here is more
//     "authoritative" than another, so first-found is as good a tiebreak as any.
//   - byStagingFolderKeyLower: Map<normalizeStagingFolderName result, entry[]> -- the join key
//     findMergedPluginsForMod below actually uses; an array per key since one mod folder can
//     legitimately contribute several merged plugins (lib/merge-plugin-scan.js's own Diziet's-mod
//     precedent -- 31 real files from a single FOMOD-installed mod).
function buildMergedPluginLookup(mergeOutputDir) {
    const byFilenameLower = new Map();
    const byStagingFolderKeyLower = new Map();
    if (!mergeOutputDir) return { byFilenameLower, byStagingFolderKeyLower };

    const merges = findAllMergeJsons(mergeOutputDir);
    for (const { id, json } of merges) {
        const mergeName = json.mergedPluginName || json.name || 'Unnamed merge';
        const action = json.action;
        for (const p of json.plugins || []) {
            if (!p || !p.filename) continue;
            const entry = { mergeId: id, mergeName, action, filename: p.filename };
            const filenameLower = String(p.filename).toLowerCase();
            if (!byFilenameLower.has(filenameLower)) byFilenameLower.set(filenameLower, entry);
            if (p.stagingFolderName) {
                const key = normalizeStagingFolderName(p.stagingFolderName);
                if (!byStagingFolderKeyLower.has(key)) byStagingFolderKeyLower.set(key, []);
                byStagingFolderKeyLower.get(key).push(entry);
            }
        }
    }
    return { byFilenameLower, byStagingFolderKeyLower };
}

// `mod` is a raw collection.json mods[] entry ({name, source: {logicalFilename, ...}, ...}, same
// shape lib/collection-diff.js's diff.updated[].new/diff.added[] already carry). Returns [] when
// this mod has no plugin on record as merged -- the common case, and the only path a caller needs to
// check before deciding whether to render a flag at all.
function findMergedPluginsForMod(lookup, mod) {
    if (!mod) return [];
    const matchKey = (mod.source && mod.source.logicalFilename) || mod.name;
    if (!matchKey) return [];
    return lookup.byStagingFolderKeyLower.get(normalizeModMatchKey(matchKey)) || [];
}

// Convenience wrapper around findMergedPluginsForMod -- the exact shape Update Collection v2's
// Review screen needs for its own row-level badge (web/public/update-collection-v2-app.js's
// ucv2MergedPluginFlagHtml): null when there's nothing to flag (the common case), or
// {filenames, mergeNames, mergeIds, files} when there is. Arrays, not singulars, on the flag object
// itself since one mod folder can contribute several merged plugins, and in principle those could
// even span more than one saved merge.
//
// `files` (2026-08-27, merged-flag-popover) is the grouped-by-file shape the popover actually
// renders from: [{filename, mergeNames}], each entry's mergeNames deduped to that ONE file's own
// matches. This is deliberately NOT derived from the flatter `filenames`/`mergeNames` pair above --
// `mergeNames` there is deduped across ALL matches via a bare Set, so once a mod contributes more
// than one distinct file, `filenames[i]`/`mergeNames[i]` stop lining up by index (e.g. two matches
// with different filenames but the SAME mergeName collapse `mergeNames` to one entry while
// `filenames` keeps two) -- so `files` is built straight from the raw per-match pairs instead, before
// any dedup can lose that association.
function computeMergedPluginFlag(lookup, mod) {
    const matches = findMergedPluginsForMod(lookup, mod);
    if (!matches.length) return null;
    const mergeNamesByFilename = new Map();
    for (const m of matches) {
        if (!mergeNamesByFilename.has(m.filename)) mergeNamesByFilename.set(m.filename, new Set());
        mergeNamesByFilename.get(m.filename).add(m.mergeName);
    }
    return {
        filenames: matches.map((m) => m.filename),
        mergeNames: [...new Set(matches.map((m) => m.mergeName))],
        mergeIds: [...new Set(matches.map((m) => m.mergeId))],
        files: [...mergeNamesByFilename.entries()].map(([filename, names]) => ({ filename, mergeNames: [...names] })),
    };
}

module.exports = { buildMergedPluginLookup, findMergedPluginsForMod, computeMergedPluginFlag };
