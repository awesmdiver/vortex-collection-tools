'use strict';
// Merge Update Report -- a genuinely different question from Merge History's own report (that one
// asks "did the merge's OWN OUTPUT drift" -- revert/restore; this asks "did the SOURCE MODS drift" --
// rebuild). See design/mockup-merge-plugins-new-features.html section 7 for the full design writeup
// this implements, and its own "director's real scenario": merge 4 plugins into 1, remove the 4
// originals from staging, then 2 of those source mods get a real update in Vortex later -- this
// report flags which saved merges are now built from stale sources and offers a one-click rebuild.
//
// Reuses this project's existing pieces rather than duplicating them:
//   - web/merge-history-routes.js's findAllMergeJsons -- the SAME saved-merge discovery Merge
//     History already uses (one per "merge - <name>" subfolder under mergeOutputDir).
//   - lib/build-mod-from-vortex-state.js's buildModFromLiveData/readModFromOpenDb -- the SAME
//     Helper-first, state.v2-fallback pattern web/merge-routes.js's own /merge route now uses to
//     RECORD a mod's version/fileId/fileMD5 at build time (see that route's own comment). This
//     report reads the SAME 3 fields back and compares them against what's live NOW.
//
// "Updated" definition (director's own resolved call, 2026-08-25 -- see the mockup's own "Resolved"
// callout): ANY live version/fileId/fileMD5 difference from what merge.json recorded, mirroring
// lib/collection-diff.js's own didFileChange (md5 first, then fileId, then a plain version-string
// compare) -- broader than Vortex's own updateAvailable flag (which only means an update is PENDING,
// not that one already happened), and broader than "is it newer" (also catches a manual downgrade/
// side-grade). Tracking is at the MOD level, not the individual plugin -- a plugin has no version of
// its own, the mod it comes from does (see mockup's own "Also clarified" callout) -- so merge.json's
// version/fileId/fileMD5 per plugin entry is always the OWNING MOD's attrs, and every plugin sharing
// one mod flags together the moment that mod updates.
//
// A plugin with no recorded version/fileId/fileMD5 at all (built before this schema existed) is
// "can't check", not "up to date" -- same treatment when the live lookup itself can't resolve this
// specific mod (Helper unreachable AND Vortex running, or the mod's been uninstalled since) --
// matching the mockup's own EarlyTestMerge.esp greyed-out row exactly, just applied per-plugin so a
// mix of old and new merges (or a merge with one mod that's since vanished) degrades gracefully
// instead of an all-or-nothing report-wide failure.

const express = require('express');
const appConfig = require('../lib/app-config');
const syncLib = require('../lib/vortex-sync/lib');
const helperClient = require('../lib/vortex-helper-client');
const { findAllMergeJsons } = require('./merge-history-routes');
const { buildModFromLiveData, readModFromOpenDb } = require('../lib/build-mod-from-vortex-state');

function createMergeUpdateReportRouter(config) {
    const router = express.Router();
    const { state } = config;

    function requireOutputDir(res) {
        const { mergeOutputDir } = appConfig.loadConfig();
        if (mergeOutputDir) return mergeOutputDir;
        res.status(400).json({ error: 'not-configured', message: 'Build at least one merge first -- Merge Update Status Report reads from the same output folder Merge Plugins writes to.' });
        return null;
    }

    // didModChange (collection-diff.js's own didFileChange, ported to compare merge.json's recorded
    // mod attrs against the SAME mod's current live attrs instead of two collection.json revisions):
    // md5 wins when both sides have one (the strongest signal -- genuinely a different file); else
    // fileId (a real Nexus file was swapped); else a plain version-string compare as the last resort.
    function didModChange(recorded, live) {
        if (recorded.fileMD5 && live.fileMD5) return recorded.fileMD5 !== live.fileMD5;
        if (recorded.fileId != null && live.fileId != null) return String(recorded.fileId) !== String(live.fileId);
        return String(recorded.version || '') !== String(live.version || '');
    }

    // Resolves live {version, fileId, fileMD5} for every name in modNames (a Set of stagingFolderName
    // strings), Helper-first, ONE state.v2 session for the whole batch when falling back (see
    // readModFromOpenDb's own header for why looping buildModFromVortexState per mod would be far too
    // expensive here -- a report can easily touch dozens of unique mods across several merges).
    // Best-effort throughout: any failure just leaves fewer names resolved, never throws -- a merge
    // whose mods can't be resolved live degrades to "can't check" for those specific plugins, not a
    // report-wide 500.
    async function resolveLiveAttrs(modNames) {
        const liveAttrsByModName = new Map();
        if (!modNames.size) return liveAttrsByModName;
        const helperAvailable = await helperClient.checkHelperAvailable(syncLib.GAME_ID).catch(() => false);
        const liveModsData = helperAvailable ? await helperClient.getAllMods().catch(() => null) : null;
        if (liveModsData) {
            for (const modName of modNames) {
                try {
                    const modInfo = buildModFromLiveData(liveModsData.mods, modName, syncLib.GAME_ID);
                    if (modInfo) liveAttrsByModName.set(modName, { version: modInfo.source.version || null, fileId: modInfo.source.fileId ?? null, fileMD5: modInfo.source.md5 || null });
                } catch { /* best-effort -- this one mod just stays unresolved */ }
            }
            return liveAttrsByModName;
        }
        if (syncLib.isVortexRunning()) return liveAttrsByModName; // neither path available -- everything stays "can't check"
        try {
            await syncLib.withStateDb(state, async (db) => {
                for (const modName of modNames) {
                    try {
                        const modInfo = await readModFromOpenDb(db, syncLib.GAME_ID, modName);
                        if (modInfo) liveAttrsByModName.set(modName, { version: modInfo.source.version || null, fileId: modInfo.source.fileId ?? null, fileMD5: modInfo.source.md5 || null });
                    } catch { /* best-effort */ }
                }
            });
        } catch { /* best-effort -- state.v2 unreadable for any reason, everything stays "can't check" */ }
        return liveAttrsByModName;
    }

    // Shared per-plugin computation used by both /rows and /merge (the pre-populated hand-off) --
    // same result shape either way so the frontend's own badge-rendering logic doesn't have to know
    // which endpoint produced it.
    // modName: same real mod display name Merge History's own /rows groups by (p.dataFolder --
    // lib/merge-v2-worker.js's writeArtifacts records this at merge time from the plugin's real
    // owning-mod name -- falling back to the raw stagingFolderName, then one honest label). Threaded
    // through here too (2026-08-25, director's own ask: "make it exactly behave the same as Merge
    // History") so this report's own frontend can group by mod, not just list plugins flat.
    function computePluginStatus(p, liveAttrsByModName) {
        const modName = p.dataFolder || p.stagingFolderName || 'Unknown mod';
        const recordedAny = p.version != null || p.fileId != null || p.fileMD5 != null;
        if (!p.stagingFolderName || !recordedAny) {
            return { filename: p.filename, modName, checkable: false, updated: false, oldVersion: null, newVersion: null };
        }
        const live = liveAttrsByModName.get(p.stagingFolderName);
        if (!live) {
            return { filename: p.filename, modName, checkable: false, updated: false, oldVersion: null, newVersion: null };
        }
        const updated = didModChange(p, live);
        return {
            filename: p.filename, modName, checkable: true, updated,
            oldVersion: p.version || null, newVersion: updated ? (live.version || null) : null,
        };
    }

    router.get('/rows', async (req, res) => {
        const mergeOutputDir = requireOutputDir(res);
        if (!mergeOutputDir) return;
        try {
            const merges = findAllMergeJsons(mergeOutputDir);
            const uniqueModNames = new Set();
            for (const { json } of merges) {
                for (const p of json.plugins || []) {
                    if (p.stagingFolderName && (p.version != null || p.fileId != null || p.fileMD5 != null)) {
                        uniqueModNames.add(p.stagingFolderName);
                    }
                }
            }
            const liveAttrsByModName = await resolveLiveAttrs(uniqueModNames);

            const rows = merges.map(({ id, json }) => {
                const plugins = (json.plugins || []).map((p) => computePluginStatus(p, liveAttrsByModName));
                const updatedCount = plugins.filter((p) => p.updated).length;
                return {
                    id, mergedPluginName: json.mergedPluginName, filename: json.filename,
                    pluginCount: plugins.length, dateBuilt: json.dateBuilt,
                    checkable: plugins.some((p) => p.checkable),
                    updatedCount, plugins,
                };
            });
            rows.sort((a, b) => String(b.dateBuilt || '').localeCompare(String(a.dateBuilt || '')));
            res.json({ merges: rows });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Part 3's own data source -- the "Create a new version" hand-off. Returns exactly one merge's
    // own original plugin list plus which are updated, for Merge Plugins' Step 1 to pre-populate from
    // (see web/public/merge-app.js's own ?sourceMergeId= handling). `id` arrives as a query param
    // (not a URL path segment) since a real id contains a literal '/' (findAllMergeJsons' own
    // `${top.name}/${inner.name}` shape) -- matching this project's own established "GET with a
    // query-param id" convention elsewhere rather than fighting Express path-param slash-escaping.
    // Validated against the SAME real discovery list findAllMergeJsons already produced -- never a
    // caller-constructed filesystem path, so no separate traversal check is needed here.
    router.get('/merge', async (req, res) => {
        const mergeOutputDir = requireOutputDir(res);
        if (!mergeOutputDir) return;
        const id = String(req.query?.id || '');
        if (!id) return res.status(400).json({ error: 'missing-id', message: 'No merge id was given.' });
        try {
            const merges = findAllMergeJsons(mergeOutputDir);
            const found = merges.find((m) => m.id === id);
            if (!found) return res.status(404).json({ error: 'not-found', message: 'That merge could not be found -- it may have been moved or deleted.' });
            const { json } = found;
            const uniqueModNames = new Set(
                (json.plugins || [])
                    .filter((p) => p.stagingFolderName && (p.version != null || p.fileId != null || p.fileMD5 != null))
                    .map((p) => p.stagingFolderName),
            );
            const liveAttrsByModName = await resolveLiveAttrs(uniqueModNames);
            // collectionName (2026-08-25) -- unlike /rows above, this endpoint's own caller (Merge
            // Plugins' Step 1 pre-population, web/public/merge-app.js's mergeStartWithSourceMerge)
            // needs it to auto-select the right Step 0 collection(s); computePluginStatus's own
            // shared shape deliberately doesn't carry it since /rows never needs it.
            const plugins = (json.plugins || []).map((p) => ({ ...computePluginStatus(p, liveAttrsByModName), collectionName: p.collectionName || null }));
            res.json({ id, mergedPluginName: json.mergedPluginName, filename: json.filename, plugins });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    return router;
}

module.exports = { createMergeUpdateReportRouter };
