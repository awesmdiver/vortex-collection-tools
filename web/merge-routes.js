'use strict';
// Merge Plugins (The Forge) -- bundles several plugins from one or more installed collections into
// a single output plugin, ESL-flagging it automatically when it qualifies. See TECHNICAL.md's
// "Merge engine" section for the full design writeup (the Part A feasibility spike, the v1.0
// new-record-only scope, the ESPFE qualification pipeline).
//
// Reuses this project's existing pieces rather than duplicating them:
//   - lib/missing-files-scan.js's listPickableCollections (2026-08-27, superseding the previous
//     commit's own listInstalledCollectionsExcludingWorkshop fix -- see that function's own header
//     comment for why it's the right one here). The real bug: a Workshop-tab draft folder for a
//     collection you're also really installed can leak indistinguishably into the picker with its
//     own, potentially stale, mod list (confirmed live: "Merge Plugins Test" showed 5 mods from a
//     stale Workshop draft instead of the real installed collection's actual 1 mod). Excluding
//     Workshop entirely (the first fix) turned out to be the WRONG call, director's own live
//     correction -- merging FROM a Workshop-authored collection's own staged content is a real,
//     legitimate use case (curating/testing a collection before it's ever installed for real). The
//     right fix is disambiguation: show BOTH "Installed Collections" and "Workshop Collections" as
//     clearly separate, labeled sections -- exactly what Rebuild Missing Files/Workshop Report
//     already do with this same shared function, reused here rather than reinvented a third time.
//   - The generic `/api/settings/browse-folder` endpoint for the output-folder picker -- no
//     dedicated pick-folder route here.
//   - web/sse-session.js for merge progress, matching Archive Finder's/Rebuild Collection's own
//     POST-starts-a-session + GET-.../events-subscribes convention.
//
// /analyze and /merge do NOT gate on Vortex running (removed 2026-08-24, director's own call) --
// they read plugin files out of staging, the same thing zEdit/xEdit itself does with Vortex wide
// open, with no equivalent gate and no one treating "deploying while running zMerge" as a risk to
// engineer around. `git log -S` on the removed calls confirmed this was never a response to a real
// incident here either -- applied by convention when v1.0 was built (reusing the app's shared
// "Vortex is running" modal), not because a merge-specific bug was ever traced to it. The post-merge
// "disable source plugins" write is a separate matter and still gates when it falls back to a direct
// Plugins.txt edit -- see runPostMergeCleanup's own comment.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const express = require('express');
const appConfig = require('../lib/app-config');
const syncLib = require('../lib/vortex-sync/lib');
const { listPickableCollections } = require('../lib/missing-files-scan');
const helperClient = require('../lib/vortex-helper-client');
const missingMastersScan = require('../lib/missing-masters-scan');
const { scanCollectionPlugins, scanEslifierOutputPlugins, computeMasterDependents, buildHelperModNameIndex, attributeWithHelperNames } = require('../lib/merge-plugin-scan');
const { buildModFromLiveData, readModFromOpenDb } = require('../lib/build-mod-from-vortex-state');
const { checkLoadList } = require('../lib/merge-preflight');
const mergeRunnerV2 = require('../lib/merge-v2-runner');
const relinkScripts = require('../lib/relink-scripts');
const { scanLightPluginValidity, setLightFlag } = require('../lib/esp-light-flag');
const { readPluginHeader, FLAG_LIGHT_MASTER } = require('../lib/esp-header');
const { countActivePluginSlots } = require('../lib/load-order-slot-count');
const { createSseSession } = require('./sse-session');

const mergeSession = createSseSession();

// Real final write path for a merge (2026-08-24, merge-overwrite-warning) -- extracted so the new
// /output-exists check below and the real /merge route compute the EXACT same path, not two
// possibly-diverging copies of this formula. Matches the per-merge subfolder layout /merge's own
// comment documents (zEdit-Revised's own zMerge layout): outputDir is the raw, user-picked root;
// the actual file lands at outputDir/{mergedBaseName}/{fileName}, not outputDir/{fileName} directly.
function computeMergeOutputPaths(outputDir, outputName) {
    const fileName = outputName.toLowerCase().endsWith('.esp') ? outputName : `${outputName}.esp`;
    const mergedBaseName = path.basename(fileName, path.extname(fileName));
    const mergeSubfolder = path.join(outputDir, mergedBaseName);
    const outputPath = path.join(mergeSubfolder, fileName);
    return { fileName, mergedBaseName, mergeSubfolder, outputPath };
}

// Merge Settings (2026-08-17, inspired by zEdit-Revised's own Merge Settings panel) -- what happens
// to the SOURCE plugins once a build succeeds. Runs here (the main server process), not inside
// lib/merge-worker.js's isolated xelib worker -- 'remove'/'backup-remove' are plain filesystem work
// with no reason to add complexity to the xelib worker, and 'disable' (see below) is a plain text-
// file edit, not xelib either. Keeping all three together here, in ONE place, is also why the
// resulting summary lines get appended onto the SAME log lib/merge-worker.js's buildMergeLog already
// wrote, rather than becoming a second, uncoordinated summary.
//
// File-scoping interpretation for 'remove'/'backup-remove' (a real judgment call, flagged in the
// handoff): deletes/backs up EXACTLY the merged plugin FILES (`item.fullPath` per included item),
// never anything else in that mod's own staging folder (textures, meshes, other unrelated plugins).
//
// 'disable' -- CORRECTED 2026-08-17, see TECHNICAL.md's own note on the original mistake. The first
// version of this disabled each source plugin's OWNING MOD via lib/vortex-sync/lib.js's
// writeDisabledFlagsForModIds (a LevelDB modState write) -- wrong: the director confirmed with a
// screenshot of Vortex's own **Plugins** page (distinct from its Mods page) that Vortex tracks a
// real, independent per-PLUGIN enabled state there, which the mod-level write never touched and
// never should have stood in for. That per-plugin state lives in Plugins.txt (the standard Bethesda
// load-order file), not the LevelDB -- see lib/missing-masters-scan.js's disablePluginsInPluginsTxt
// for the full read-modify-write reasoning.
//
// Helper-first, Plugins.txt-fallback (2026-08-24) -- see the 'disable' branch below for the real
// split. Only the FALLBACK path still re-checks isVortexRunning() immediately before writing (not
// just trusting the route's own request-start gate -- moot anyway now, since /merge itself no longer
// gates on Vortex at all) -- the same live-write caution lib/vortex-sync/lib.js's own withLiveStateDb
// applies to every LevelDB write applies here too, since this is still, on that path, a direct edit
// to a load-order file the game itself reads. The Helper path is a live in-memory flag flip through
// Vortex's own process, not a direct file write, so that caution doesn't transfer to it the same way.
// Returns { lines, backupPaths } -- backupPaths (2026-08-24, merge-restore-report-data) is
// fileName -> the absolute path this run actually copied that plugin to, populated ONLY for
// action === 'backup-remove' and ONLY once the copy itself has genuinely succeeded (recorded right
// after fs.copyFileSync returns, before the unlink attempt below -- so a copy that succeeds but is
// then followed by a failed unlink still correctly reports a real backup file on disk, even though
// that item lands in `failed` rather than `removed`). This is the merge.json enrichment step's own
// source of truth for each plugin's backupPath, rather than that step re-deriving the same
// path.join(outputDir, 'Backup', fileName) formula a second time and risking the two silently
// drifting apart if this logic ever changes.
// Shared by BOTH branches below (2026-08-24, merge-remove-also-disables) -- 'disable' is where this
// was first written; 'remove'/'backup-remove' need the exact same Vortex-side write, not a
// second copy of it. Helper-first, Plugins.txt-fallback -- when the Helper is reachable,
// setPluginEnabled flips each source plugin's own live flag directly -- the SAME precisely-scoped
// endpoint Missing Masters' own Enable button already uses, self-verified against Vortex's own
// before/after readback, so its true/false is the truth, not an assumption. Only an in-memory flag:
// Plugins.txt on disk (what the game actually reads) is rewritten by Vortex during a real deploy,
// not by this call -- said explicitly in the result line so it doesn't read as "already done" when
// a deploy is still the step that finishes it.
//
// Falls through to a direct Plugins.txt write, gate and all, when the Helper isn't available --
// that direct-file path takes effect immediately (no deploy needed) and still requires Vortex
// closed, exactly as it always has. Only THIS fallback path re-checks isVortexRunning() immediately
// before writing (not just trusting the route's own request-start gate) -- the same live-write
// caution lib/vortex-sync/lib.js's own withLiveStateDb applies to every LevelDB write applies here
// too, since this is still, on that path, a direct edit to a load-order file the game itself reads.
// The Helper path is a live in-memory flag flip through Vortex's own process, not a direct file
// write, so that caution doesn't transfer to it the same way.
async function disableSourcePluginsInVortex(items, pluginsTxtPath) {
    const lines = [];
    const helperAvailable = await helperClient.checkHelperAvailable(syncLib.GAME_ID);
    if (helperAvailable) {
        const disabled = [];
        const failed = [];
        for (const item of items) {
            const ok = await helperClient.setPluginEnabled(item.fileName, false);
            (ok ? disabled : failed).push(item.fileName);
        }
        if (disabled.length) lines.push(`Disabled ${disabled.length} plugin${disabled.length === 1 ? '' : 's'} in Vortex: ${disabled.join(', ')}. Deploy mods in Vortex to apply these changes to your game.`);
        if (failed.length) lines.push(`Could not disable ${failed.length} plugin${failed.length === 1 ? '' : 's'} in Vortex (they may already be disabled or missing from the current load order): ${failed.join(', ')}`);
    } else if (!pluginsTxtPath) {
        lines.push('Could not disable the source plugins -- no Plugins.txt location is configured (set it under Settings > Missing Masters).');
    } else if (syncLib.isVortexRunning()) {
        lines.push('Could not disable the source plugins -- Vortex was running at the moment of the write. Close Vortex and use its own Plugins page to disable them manually, or re-run a merge with Vortex closed next time.');
    } else {
        try {
            const { disabled, notFound } = missingMastersScan.disablePluginsInPluginsTxt(pluginsTxtPath, items.map((it) => it.fileName));
            if (disabled.length) lines.push(`Disabled ${disabled.length} plugin${disabled.length === 1 ? '' : 's'} in Plugins.txt: ${disabled.join(', ')}`);
            if (notFound.length) lines.push(`Could not find ${notFound.length} of these plugins active in Plugins.txt, so they were left as-is: ${notFound.join(', ')}`);
        } catch (e) {
            lines.push(`Could not disable the source plugins in Plugins.txt: ${e.message}`);
        }
    }
    return lines;
}

async function runPostMergeCleanup({ items, action, outputDir, pluginsTxtPath }) {
    const lines = [];
    const backupPaths = {};
    if (action === 'remove' || action === 'backup-remove') {
        // Disable-in-Vortex FIRST (2026-08-24, merge-remove-also-disables, live-testing gap: these
        // two branches deleted/backed-up the files but never touched Vortex's own live state, unlike
        // 'disable' -- so the source plugins kept showing enabled on Vortex's own Plugins page until
        // a manual deploy). Ordered before the file delete/backup below on purpose: item.fileName is
        // still known even once its file is gone, so disabling first (rather than after) means a
        // failed delete still leaves Vortex's state correctly updated -- the delete failing shouldn't
        // also leave the disable undone. The two result lines below are still assembled file-summary-
        // first (removed/backed-up), disable-summary-second, matching this action's own established
        // reading order (see the fs work just below) -- only the WRITE order changed, not the summary.
        const disableLines = await disableSourcePluginsInVortex(items, pluginsTxtPath);

        let backupDir = null;
        if (action === 'backup-remove') {
            backupDir = path.join(outputDir, 'Backup');
            fs.mkdirSync(backupDir, { recursive: true });
        }
        const removed = [];
        const failed = [];
        for (const item of items) {
            try {
                if (backupDir) {
                    const backupPath = path.join(backupDir, item.fileName);
                    fs.copyFileSync(item.fullPath, backupPath);
                    backupPaths[item.fileName] = backupPath;
                }
                fs.unlinkSync(item.fullPath);
                removed.push(item.fileName);
            } catch (e) {
                failed.push({ fileName: item.fileName, message: e.message });
            }
        }
        if (backupDir && removed.length) lines.push(`Backed up ${removed.length} source plugin file${removed.length === 1 ? '' : 's'} to: ${backupDir}`);
        if (removed.length) lines.push(`Removed ${removed.length} source plugin file${removed.length === 1 ? '' : 's'} from staging.`);
        for (const f of failed) lines.push(`Could not remove "${f.fileName}": ${f.message}`);
        lines.push(...disableLines);
    } else if (action === 'disable') {
        lines.push(...(await disableSourcePluginsInVortex(items, pluginsTxtPath)));
    }
    return { lines, backupPaths };
}

// Restore/Revert report foundation (2026-08-24, merge-restore-report-data) -- augments the v2
// engine's own merge.json (lib/merge-v2-worker.js's writeArtifacts, untouched -- this reads back
// what it already wrote and rewrites it with more fields, rather than a second file) with what a
// later Restore/Revert report needs: design/mockup-merge-plugins-new-features.html section 6.
// A plain function, not inlined into the /merge route's own .then(), specifically so it's directly
// testable (see scripts/test-merge-restore-report-data.js) without needing a real xelib build or
// risking real files -- `mergeFolder` can point at any scratch directory holding a merge.json
// shaped like writeArtifacts' own output.
//
// mergeJson.plugins entries are matched to `items` by `filename` (writeArtifacts' own field name,
// from its `i.fileName`) against the request's own items (client-sourced `fileName` -- same value,
// two different object shapes). stagingFolderName uses the same relative-to-staging
// first-path-segment technique lib/merge-plugin-scan.js's own attributeWithHelperNames already uses
// to recover a staging folder name from a fullPath. backupPath is added only for
// action === 'backup-remove', and only when runPostMergeCleanup's own backupPaths actually has an
// entry for that plugin (a copy that never happened, e.g. a failed backup-remove for that one file,
// must never claim a backup file exists).
function enrichMergeJsonForRestore({ mergeFolder, mergeName, action, items, backupPaths, staging }) {
    const mergeJsonPath = path.join(mergeFolder, 'merge.json');
    const mergeJson = JSON.parse(fs.readFileSync(mergeJsonPath, 'utf8'));
    mergeJson.mergedPluginName = mergeName;
    mergeJson.action = action;
    const itemsByFileName = new Map(items.map((it) => [it.fileName, it]));
    mergeJson.plugins = (mergeJson.plugins || []).map((p) => {
        const item = itemsByFileName.get(p.filename);
        const augmented = {
            ...p,
            collectionName: item?.collectionName ?? null,
            stagingFolderName: item ? path.relative(staging, item.fullPath).split(path.sep)[0] : null,
            // version/fileId/fileMD5 (2026-08-25, Merge Update Report) -- the OWNING MOD's own live
            // attrs at build time (resolved by the /merge route above, before this ever runs -- see
            // its own comment for the Helper/state.v2 resolution), not the .esp file's own -- a
            // plugin has no version of its own; the mod it comes from does. null when the lookup
            // couldn't resolve this item's mod (Helper+state.v2 both unavailable, or a genuine
            // MOD_NOT_FOUND) -- the report's own "Can't check" treatment covers that per-plugin, not
            // just for whole merges built before this field existed.
            version: item?.version ?? null,
            fileId: item?.fileId ?? null,
            fileMD5: item?.fileMD5 ?? null,
        };
        if (action === 'backup-remove' && item && backupPaths[item.fileName]) {
            augmented.backupPath = backupPaths[item.fileName];
        }
        return augmented;
    });
    fs.writeFileSync(mergeJsonPath, JSON.stringify(mergeJson, null, 2));
    return mergeJson;
}

function createMergeRouter(config) {
    const router = express.Router();
    const { staging, state } = config;

    function vortexRunningGate(res) {
        if (syncLib.isVortexRunning()) {
            res.status(409).json({ error: 'vortex-running', message: 'Vortex is currently running. Close it completely and try again.' });
            return true;
        }
        return false;
    }

    function requireStaging(res) {
        if (staging) return true;
        res.status(400).json({ error: 'not-configured', message: 'Set up your Vortex staging folder under Settings first.' });
        return false;
    }

    // The merge engine needs the real Skyrim Data folder to stage actual base-game masters
    // (Skyrim.esm etc, hardlinked into a throwaway sandbox) -- a zero-record dummy master is only
    // enough for xelib's own loader, not for copying a "new" record that references a real FormID
    // inside that master (see lib/merge-worker.js's stageMaster). Read fresh each call, same as the
    // existing skyrimDataDir read in the /merge route below -- Settings can change this without a
    // server restart.
    function requireSkyrimDataDir(res) {
        const { skyrimDataDir } = appConfig.loadConfig();
        if (skyrimDataDir) return skyrimDataDir;
        res.status(400).json({ error: 'not-configured', message: 'Set up your Skyrim Data folder under Settings first.' });
        return null;
    }

    router.get('/collections', (req, res) => {
        if (!requireStaging(res)) return;
        try {
            // { installed, workshop } (2026-08-27) -- see this file's own header comment. No .map()
            // trimming the shape down anymore -- the client now needs the real split, and
            // listPickableCollections' own items already carry exactly the fields the picker cares
            // about (modId/name/modCount), no author field to drop the way the old shape did either.
            const { installed, workshop } = listPickableCollections(staging);
            res.json({ installed, workshop });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Searches the plugins belonging to the given (already-chosen) collections -- q/extensions are
    // applied here, server-side, rather than shipping every plugin down and filtering client-side,
    // since a large multi-collection pick can easily be thousands of files.
    //
    // Helper-first modName (2026-08-24) -- scanCollectionPlugins itself is UNCHANGED, still the one
    // real filesystem walk; when the Helper is reachable, its live mod names are applied on top via
    // lib/merge-plugin-scan.js's attributeWithHelperNames, a real accuracy improvement (Vortex's own
    // truth beats a name guessed from the staging folder), independent of the gate removal above.
    // Best-effort: a Helper probe/fetch failure here just means every item keeps its file-derived
    // name (modNameSource: 'staging'), exactly as before this existed -- never a reason to fail the
    // whole plugin listing.
    // Same isInside shape as missing-masters-routes.js's/rebuild-missing-routes.js's own copies --
    // no shared lib for this in the codebase, third local copy rather than a new abstraction.
    function isInside(baseDir, targetPath) {
        const resolvedBase = path.resolve(baseDir);
        const resolvedTarget = path.resolve(targetPath);
        return resolvedTarget === resolvedBase || resolvedTarget.startsWith(resolvedBase + path.sep);
    }

    router.get('/plugins', async (req, res) => {
        if (!requireStaging(res)) return;
        const collectionModIds = String(req.query.collections || '').split(',').map((s) => s.trim()).filter(Boolean);
        // eslifierOutputDirConfigured (2026-08-24, merge-step1-eslifier-filter) -- read fresh here too
        // (Settings can change this without a restart, same convention as requireSkyrimDataDir above),
        // included even on this early-exit so the client's "not configured yet" hint stays correct
        // regardless of which return path fires.
        const { eslifierOutputDir } = appConfig.loadConfig();
        const eslifierOutputDirAbs = eslifierOutputDir ? path.resolve(eslifierOutputDir) : null;
        if (collectionModIds.length === 0) return res.json({ results: [], eslifierOutputDirConfigured: !!eslifierOutputDirAbs });
        const q = String(req.query.q || '').trim().toLowerCase();
        const extensions = String(req.query.extensions || '.esp,.esl,.esm').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
        try {
            // Combined installed+workshop (2026-08-27) -- the picker now legitimately offers BOTH,
            // so resolving a chosen modId back to its real collection.json must check both too, or
            // picking a Workshop entry would silently find nothing here.
            const pickable = listPickableCollections(staging);
            const allCollections = [...pickable.installed, ...pickable.workshop];
            const chosen = allCollections.filter((c) => collectionModIds.includes(c.modId));
            let allPlugins = scanCollectionPlugins(staging, chosen);
            // ESLifier Output is never a declared member mod of any collection.json (confirmed real,
            // director 2026-08-24: "Gate To Sovngarde definitely has files in ESLifier Output," yet it
            // appears in zero of the installed collections' own `mods[]` arrays) -- it's a personal,
            // LOCAL deploy-time tool's own output folder, same category as Merge Plugins' or zMerge's
            // own output folders. So unlike a real mod, it can never be reached through
            // scanCollectionPlugins' collection-membership matching above, no matter which collection is
            // chosen -- "it should be checked regardless of what collection you choose in the picker"
            // (director's own words). That never meant "regardless of what's actually in this folder
            // vs. what's actually chosen" though -- fixed a real, live over-broad bug here (2026-08-24,
            // merge-eslifier-scope-to-chosen-collections): a file only belongs here if its name matches
            // a real plugin belonging to the CHOSEN collections above (allPlugins, captured BEFORE this
            // concat), i.e. it's a genuine replacement for something in THIS pick -- not just any file
            // that happens to sit in the folder. Confirmed real: 363 files shown for a collection with
            // exactly one real ESLifier-replaced mod, before this fix.
            const chosenFileNamesLower = new Set(allPlugins.map((p) => p.fileName.toLowerCase()));
            allPlugins = allPlugins.concat(scanEslifierOutputPlugins(eslifierOutputDirAbs, chosenFileNamesLower));
            let helperModNameIndex = null;
            try {
                const helperAvailable = await helperClient.checkHelperAvailable(syncLib.GAME_ID);
                if (helperAvailable) {
                    const liveData = await helperClient.getAllMods();
                    if (liveData) helperModNameIndex = buildHelperModNameIndex(liveData.mods);
                }
            } catch { /* best-effort -- see comment above */ }
            allPlugins = attributeWithHelperNames(allPlugins, staging, helperModNameIndex);
            const results = allPlugins.filter((p) => {
                if (extensions.length && !extensions.includes(p.extension)) return false;
                if (!q) return true;
                return p.fileName.toLowerCase().includes(q) || p.modName.toLowerCase().includes(q);
            }).map((p) => ({
                // Exclude ESLifier output (2026-08-24, merge-step1-eslifier-filter) -- a plain path-
                // containment check against the same configured folder Missing Masters' own "Recognize
                // ESLifier output" already matches against, computed server-side (this is the only
                // place eslifierOutputDir's real path is known) and shipped down as a plain per-item
                // flag. The client filters on this flag alone -- never sees the folder path itself.
                ...p, eslifierOutput: !!eslifierOutputDirAbs && isInside(eslifierOutputDirAbs, p.fullPath),
            }));
            res.json({ results, eslifierOutputDirConfigured: !!eslifierOutputDirAbs });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Masters-dependency check (2026-08-17) -- see lib/merge-plugin-scan.js's own
    // computeMasterDependents header comment for the full rationale. No Vortex-running gate at all
    // -- same reasoning missing-masters-routes.js's own /scan already documents: this only ever
    // reads Plugins.txt and the Data folder directly (immutable existing files, not Vortex's live
    // state.v2), plus a plain staging-folder walk for resolution, none of it Vortex's own live DB.
    // Called TWICE by the client for two different reasons: once on boot (cached, drives the
    // "(master)" label everywhere a plugin name is shown) and once again fresh right before a real
    // build starts (Part 1's own pre-flight check) -- re-derived live rather than trusted from the
    // cached boot-time snapshot, same "always re-derive fresh before a real action" principle this
    // whole app already follows elsewhere. Both calls share this SAME computation -- no second,
    // possibly-drifting implementation.
    router.get('/master-dependents', (req, res) => {
        const { skyrimDataDir, pluginsListDir } = appConfig.loadConfig();
        if (!skyrimDataDir || !pluginsListDir) {
            return res.json({ configured: false, dependents: {} });
        }
        if (!requireStaging(res)) return;
        try {
            const pluginsTxtPath = path.join(pluginsListDir, 'Plugins.txt');
            // Combined installed+workshop (2026-08-27), same reasoning as /plugins above. Confirmed
            // this can never produce a FALSE "(master)" label: computeMasterDependents' own WHICH-
            // masters-need-a-label decision comes entirely from the real active Plugins.txt/Data
            // folder scan (`active`), never from allCollections -- this list is only used to resolve
            // a real active master's own bare filename back to a real staged file, for the "Include
            // in the merge" convenience. Including Workshop entries here can only ever IMPROVE that
            // resolution (a real active master that happens to also sit in a Workshop draft's own
            // staged content), never introduce an incorrect label.
            const pickable = listPickableCollections(staging);
            const allCollections = [...pickable.installed, ...pickable.workshop];
            const dependentsByMaster = computeMasterDependents(skyrimDataDir, pluginsTxtPath, staging, allCollections);
            res.json({ configured: true, dependents: Object.fromEntries(dependentsByMaster) });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Real, current Full/Light plugin-slot budget across the WHOLE load order (2026-08-24,
    // merge-light-slot-budget) -- see lib/load-order-slot-count.js's own header for the full
    // writeup and why this is a genuinely different number from the per-plugin light-eligibility
    // check below. Called by the Done screen, not the Review step -- this is real, live,
    // system-wide data, not a pre-merge estimate about the plugins in the cart.
    router.get('/slot-budget', (req, res) => {
        const { skyrimDataDir, pluginsListDir } = appConfig.loadConfig();
        if (!skyrimDataDir || !pluginsListDir) {
            return res.json({ configured: false });
        }
        try {
            res.json({ configured: true, ...countActivePluginSlots({ skyrimDataDir, pluginsListDir }) });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Pre-flight (2026-08-23) -- can everything this merge is about to load actually be loaded?
    // Runs entirely in this process on plain file reads, BEFORE lib/merge-runner.js spawns the xelib
    // worker, so a doomed merge is refused up front with a real list instead of dying partway
    // through on a native error nobody can act on. See lib/merge-preflight.js for what it checks and
    // why a missing master is reported without blocking.
    //
    // Modelled on zEdit-Revised's own zMerge, which the director asked me to read first: its
    // mergeStatusService marks each plugin `available` and refuses to build the whole merge
    // ("Plugins unavailable", canBuild = false) rather than starting one that can't finish. Same
    // shape here -- per-plugin reasons plus one overall blocked flag. (zEdit-Revised is MIT, and
    // this is its approach rather than its code.)
    function runPreflight(items, gameDataDir) {
        // Active plugin names are purely to sharpen ONE message ("it's switched on in your load
        // order, but the file isn't there") -- never required, so a missing/unreadable Plugins.txt
        // just yields the plainer wording instead of failing the check.
        let activeNames = null;
        try {
            const { pluginsListDir } = appConfig.loadConfig();
            if (pluginsListDir) {
                // readPluginsTxt returns { starred, listedNotStarred } as Sets of ALREADY-lowercased
                // names; 'starred' (a leading '*') is what active means in Plugins.txt.
                const { starred } = missingMastersScan.readPluginsTxt(path.join(pluginsListDir, 'Plugins.txt'));
                activeNames = [...starred];
            }
        } catch { /* optional detail only -- see above */ }
        return checkLoadList(items, gameDataDir, activeNames);
    }

    router.post('/preflight', (req, res) => {
        const gameDataDir = requireSkyrimDataDir(res);
        if (!gameDataDir) return;
        const items = Array.isArray(req.body?.items) ? req.body.items : [];
        if (items.length === 0) return res.status(400).json({ error: 'No plugins were provided.' });
        try {
            const { problems, blocked } = runPreflight(items, gameDataDir);
            res.json({ problems, blocked });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Read-only look at each chosen plugin: does it contain any override/injected records (v1.0
    // excludes these from the actual merge -- see lib/merge-worker.js's own header comment), what
    // masters does it declare, and how many genuinely new records would it contribute.
    //
    // NOT Vortex-gated (2026-08-24, director's own call) -- this reads plugin files out of staging,
    // the same thing zEdit/xEdit itself does with Vortex wide open and no equivalent gate. His own
    // words: "we follow the logic zMerge yes... If someone is deploying while merging files, that's
    // their problem not mine... no different if they were deploying and using zMerge at the same
    // time." Confirmed via `git log -S` that this gate was never a response to a real incident here
    // either -- applied by convention when the tool was first built (reusing the app's shared
    // "Vortex is running" modal), not because a merge-specific bug was ever traced to reading staging
    // while Vortex runs. Worst case if someone deploys mid-analyze/merge: a bad output, re-run it --
    // not lost data, not a corrupted install (the director's own stated risk bar for this change).
    router.post('/analyze', async (req, res) => {
        const gameDataDir = requireSkyrimDataDir(res);
        if (!gameDataDir) return;
        const items = Array.isArray(req.body?.items) ? req.body.items : [];
        if (items.length === 0) return res.status(400).json({ error: 'No plugins were provided.' });
        try {
            // v2 engine (2026-08-25, merge-v1-analyze-port) -- replaces mergeRunner.analyzePlugins
            // (lib/merge-runner.js/lib/merge-worker.js, now deleted). Same result shape
            // ({ results: [{ fileName, recordCount, newRecordCount, overrideCount, containsOverrides,
            // hasCellOrWorldspace, masters }] }) -- confirmed a real before/after match against v1's
            // own output for the same real plugin set, see the handoff for this change.
            const result = await mergeRunnerV2.analyzePluginsV2(items, gameDataDir);
            res.json(result);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.get('/merge/events', (req, res) => {
        if (!mergeSession.get()) return res.status(404).end();
        const afterSeq = Number(req.headers['last-event-id'] || 0);
        mergeSession.subscribe(res, { afterSeq });
    });

    // Overwrite check (2026-08-24, merge-overwrite-warning) -- the client's own pre-build check,
    // called right before Merge starts so the confirm modal below can name the real file. This is
    // the UX-facing half only; /merge's own POST handler independently re-checks the same path right
    // before it actually writes (never trusts this earlier answer), since a stale read here (the file
    // appears between this check and the real write) or a client that skips this route entirely (a
    // direct API call) must not be able to bypass the real backstop.
    router.get('/output-exists', (req, res) => {
        const outputName = String(req.query?.outputName || '').trim();
        const outputDir = String(req.query?.outputDir || '').trim();
        if (!outputName || !outputDir) return res.status(400).json({ error: 'outputName and outputDir are both required.' });
        try {
            const { outputPath } = computeMergeOutputPaths(outputDir, outputName);
            res.json({ exists: fs.existsSync(outputPath), path: outputPath });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Starts the actual merge (only the items the Review step left in -- override-containing
    // plugins must already be excluded by the caller). NEVER the Skyrim Data folder -- this tool
    // doesn't install anything into the game or Vortex, the user does that themselves afterward.
    //
    // NOT Vortex-gated (2026-08-24) -- same reasoning as /analyze above.
    router.post('/merge', async (req, res) => {
        if (mergeSession.isActive()) {
            return res.status(409).json({ error: 'A merge is already in progress' });
        }
        const items = Array.isArray(req.body?.items) ? req.body.items : [];
        const outputName = String(req.body?.outputName || '').trim();
        const outputDir = String(req.body?.outputDir || '').trim();
        if (items.length === 0) return res.status(400).json({ error: 'No plugins were provided.' });
        if (!outputName) return res.status(400).json({ error: 'Name the merged plugin first.' });
        if (!outputDir) return res.status(400).json({ error: 'Choose an output folder first.' });

        // Merge Update Report schema (2026-08-25) -- resolves each item's OWNING MOD's live
        // version/fileId/fileMD5 (Helper-first, state.v2 fallback -- same established pattern as
        // lib/rebuild-single-mod.js's own liveMods/buildModFromLiveData/buildModFromVortexState
        // split) so lib/merge-v2-worker.js's writeArtifacts can record them at build time -- there
        // is nothing for a future Merge Update Report check to compare against otherwise. Keyed by
        // stagingFolderName (item.modName -- confirmed elsewhere in this file/writeArtifacts that
        // this field already IS the Vortex staging folder name, not a display name), resolved ONCE
        // per unique mod even when several selected plugins share one owning mod (a real case --
        // see lib/merge-plugin-scan.js's own Diziet's-mod precedent). Best-effort only: a lookup
        // failure for any one mod, or the whole Helper+state.v2 path being unavailable (Vortex open,
        // no Helper extension reachable), never blocks the merge -- that plugin just isn't checkable
        // by the report later, matching its own "Can't check -- rebuild to enable" treatment for
        // exactly this case rather than a hard failure here.
        const helperAvailable = await helperClient.checkHelperAvailable(syncLib.GAME_ID).catch(() => false);
        const liveModsData = helperAvailable ? await helperClient.getAllMods().catch(() => null) : null;
        const modAttrsByName = new Map();
        const uniqueModNames = [...new Set(items.map((it) => it.modName).filter(Boolean))];
        const toAttrs = (modInfo) => ({
            version: modInfo.source.version || null,
            fileId: modInfo.source.fileId ?? null,
            fileMD5: modInfo.source.md5 || null,
        });
        if (liveModsData) {
            for (const modName of uniqueModNames) {
                try {
                    const modInfo = buildModFromLiveData(liveModsData.mods, modName, syncLib.GAME_ID);
                    if (modInfo) modAttrsByName.set(modName, toAttrs(modInfo));
                } catch { /* best-effort -- see comment above */ }
            }
        } else if (!syncLib.isVortexRunning() && uniqueModNames.length) {
            // ONE state.v2 session for every unique mod this merge needs -- syncLib.withStateDb
            // copies the whole database per call, so looping buildModFromVortexState per mod would
            // pay that cost once per mod instead of once total. See readModFromOpenDb's own header.
            try {
                await syncLib.withStateDb(state, async (db) => {
                    for (const modName of uniqueModNames) {
                        try {
                            const modInfo = await readModFromOpenDb(db, syncLib.GAME_ID, modName);
                            if (modInfo) modAttrsByName.set(modName, toAttrs(modInfo));
                        } catch { /* best-effort -- see comment above */ }
                    }
                });
            } catch { /* best-effort -- see comment above */ }
        }
        const itemsWithModAttrs = items.map((it) => ({ ...it, ...(it.modName ? modAttrsByName.get(it.modName) : undefined) }));

        // Merge method (2026-08-25, per-build picker, NOT a persisted Settings default -- see the
        // handoff) -- a real, per-request field now that lib/merge-v2-worker.js implements all 3 real
        // zMerge methods. Validated here (not just trusted from the client) the same way every other
        // real-write route on this server validates its own request body -- an unrecognized value
        // falls back to Clean rather than reaching the worker at all, so a stale/bypassed client can
        // never silently request something this route doesn't actually support.
        const method = ['Clean', 'Clobber', 'Master'].includes(req.body?.method) ? req.body.method : 'Clean';

        const gameDataDir = requireSkyrimDataDir(res);
        if (!gameDataDir) return;
        const resolvedOut = path.resolve(outputDir);
        const resolvedData = path.resolve(gameDataDir);
        if (resolvedOut === resolvedData || resolvedOut.startsWith(resolvedData + path.sep)) {
            return res.status(400).json({ error: 'The output folder cannot be your Skyrim Data folder -- choose a different folder, then install the merged plugin as a mod in Vortex yourself.' });
        }

        // Enforced here too, not only in the client's own pre-build check -- the guarantee that a
        // doomed merge never starts shouldn't depend on the caller having asked first. 400 (not 202)
        // so nothing is emitted on the SSE session and no merge is considered started at all.
        try {
            const { problems, blocked } = runPreflight(items, gameDataDir);
            if (blocked) {
                return res.status(400).json({
                    error: 'preflight-blocked',
                    problems,
                    message: 'Some of these plugins can\'t be loaded, so the merge was stopped before it started.',
                });
            }
        } catch { /* the check itself failing must never block a merge that would otherwise run */ }

        // Per-merge subfolder (2026-08-18, matching zEdit-Revised's own zMerge layout -- director's
        // own real output on disk was the reference: the chosen Output folder is the ROOT, and each
        // merge gets its OWN subfolder named after itself). outputDir stays the raw, user-picked
        // root throughout this route (still what gets remembered as the default output folder
        // below) -- mergeSubfolder is the actual working directory everything for THIS merge writes
        // into. lib/merge-worker.js's own translations/seq/log paths all derive from
        // path.dirname(outputPath), so nesting outputPath here is enough to carry all of them along
        // automatically -- no changes needed inside that file beyond ensuring the subfolder exists.
        const { mergedBaseName, mergeSubfolder, outputPath } = computeMergeOutputPaths(outputDir, outputName);

        // Overwrite backstop (2026-08-24, merge-overwrite-warning) -- the real server-side guard, not
        // just the client's own confirm modal (GET /output-exists below). A stale/bypassed client (a
        // direct API call, or a client that ran the check before the file appeared) must never be able
        // to silently overwrite a real, possibly-installed merge output -- so this refuses outright
        // unless the caller explicitly confirmed it via `overwrite: true`, same "confirmed intent, not
        // just client UI state" gate this app's other real-write routes already use (e.g.
        // /flag-as-light re-deriving eligibility fresh rather than trusting an earlier response).
        if (fs.existsSync(outputPath) && req.body?.overwrite !== true) {
            return res.status(409).json({
                error: 'output-exists',
                message: `${path.basename(outputPath)} already exists in this folder. Merging again would overwrite it.`,
                path: outputPath,
            });
        }

        const mySession = mergeSession.start({ id: `merge-${Date.now()}` });
        res.status(202).json({});

        // v2 (lib/merge-v2-worker.js, the zMerge port) is the only merge engine now (2026-08-25,
        // merge-v1-engine-retired -- the old engine's `lib/merge-worker.js`'s `runMerge` and its own
        // `mergeUseV2Engine: false` config rollback were removed once confirmed genuinely unreachable
        // through any normal flow; see TECHNICAL.md's "Merge Plugins: v1 engine retired" section).
        // The old engine's own "heads up, these OTHER plugins still need one of the merged originals"
        // note (fed by a `residualDependents` computation that used to run here) went with it -- v2's
        // own merge log has no equivalent section. Part 1's own pre-flight check (the
        // /master-dependents-backed modal) still blocks the client from reaching this route with a
        // real unresolved dependency in the first place, so this was always a secondary, log-only
        // note, never the actual safety check.
        //
        // v2's own result shape ({ outputPath, mergeFolder, logPath, recordCount, failedToCopy }) is
        // adapted to the shape this same .then() and the client's own result rendering expect below.
        // eslFlagged/qualificationReason stay a fixed "not yet ported" pair -- v2 has no ESL
        // qualification logic at all yet, so every v2 merge is honestly reported as a full,
        // non-ESL-flagged .esp -- never a guess presented as a real determination.
        //
        // logContent is read fresh off disk here (not threaded back through the worker's own stdout
        // JSON) since the log file itself is the durable source of truth -- lib/merge-v2-worker.js's
        // logger appends synchronously as it goes, specifically so a genuine worker crash (an access
        // violation, not a catchable JS throw) still leaves a real partial file to read here.
        const mergeName = mergedBaseName; // identical computation -- computeMergeOutputPaths already derived this
        const runMerge = (onProgress) => mergeRunnerV2.mergePluginsV2(itemsWithModAttrs, outputPath, gameDataDir, mergeName, method, onProgress)
            .then((r) => {
                let logContent = '';
                try { logContent = fs.readFileSync(r.logPath, 'utf8'); } catch { /* the file itself is the log; if it's unreadable there's nothing to show */ }
                return {
                    method, recordCount: r.recordCount, overrideRecordCount: 0, eslFlagged: false,
                    qualificationReason: 'v2 engine -- ESL qualification not yet ported',
                    logContent, logPath: r.logPath, outputPath: r.outputPath, failedToCopy: r.failedToCopy,
                    // unhandledStringFiles (2026-08-25, merge-results-screen-asset-gap) -- see
                    // lib/merge-v2-worker.js's own runMergeV2 comment for what this counts and why.
                    unhandledStringFiles: r.unhandledStringFiles,
                    // Kept (2026-08-24, merge-restore-report-data) so the merge.json enrichment
                    // step below can find the SAME merge.json lib/merge-v2-worker.js's own
                    // writeArtifacts already wrote there.
                    mergeFolder: r.mergeFolder,
                };
            });

        runMerge((current, total, label) => {
            if (mergeSession.get() === mySession) mergeSession.emit({ type: 'progress', current, total, label });
        }).then(async (result) => {
            if (mergeSession.get() !== mySession) return;
            const { mergeOutputDir, mergePostMergeAction, pluginsListDir, mergeStagingCopyDir } = appConfig.loadConfig();
            if (outputDir !== mergeOutputDir) appConfig.saveConfig({ mergeOutputDir: outputDir }); // remember as the default for next time
            const pluginsTxtPath = pluginsListDir ? path.join(pluginsListDir, 'Plugins.txt') : null;

            // Staging folder auto-copy (2026-08-25) -- a SEPARATE, optional destination from
            // mergeOutputDir (see lib/app-config.js's own mergeStagingCopyDir comment for why): a
            // real copy (never a move -- mergeOutputDir stays the source of truth) of the finished
            // .esp, so Vortex can adopt it as its own mod without the user moving it by hand. Logged
            // into the SAME merge log every other phase already writes to, appended the exact way the
            // cleanup step just below does (result.logContent for the UI + a real synchronous
            // fs.appendFileSync so the durable log file matches it) -- a genuine failure here
            // (permissions, disk full, the folder no longer existing) must stay visible on the results
            // screen, never silently swallowed, same standing rule the cleanup step already follows.
            if (mergeStagingCopyDir) {
                const stagingDestPath = path.join(mergeStagingCopyDir, path.basename(result.outputPath));
                try {
                    fs.mkdirSync(mergeStagingCopyDir, { recursive: true });
                    fs.copyFileSync(result.outputPath, stagingDestPath);
                    result.stagingCopyPath = stagingDestPath;
                    const appended = `\r\nCopied to staging folder: ${stagingDestPath}\r\n`;
                    result.logContent = (result.logContent || '') + appended;
                    if (result.logPath) {
                        try { fs.appendFileSync(result.logPath, appended, 'utf8'); } catch { /* non-fatal -- logContent above already carries it for the UI */ }
                    }
                } catch (e) {
                    result.stagingCopyError = e.message;
                    const appended = `\r\nWARNING: could not copy to staging folder "${mergeStagingCopyDir}": ${e.message}\r\n`;
                    result.logContent = (result.logContent || '') + appended;
                    if (result.logPath) {
                        try { fs.appendFileSync(result.logPath, appended, 'utf8'); } catch { /* best-effort */ }
                    }
                }
            }

            // Never let a Merge Settings failure hide a merge that already succeeded -- the build is
            // done by this point regardless of what happens below, so 'done' must still fire either
            // way. Appends onto the SAME log buildMergeLog already wrote, one coordinated summary
            // rather than two (see runPostMergeCleanup's own header comment).
            const resolvedAction = mergePostMergeAction || 'disable';
            let backupPaths = {};
            try {
                const cleanup = await runPostMergeCleanup({ items, action: resolvedAction, outputDir: mergeSubfolder, pluginsTxtPath });
                backupPaths = cleanup.backupPaths;
                if (cleanup.lines.length) {
                    const appended = '\r\nSource plugins:\r\n' + cleanup.lines.map((l) => `  - ${l}`).join('\r\n') + '\r\n';
                    result.logContent = (result.logContent || '') + appended;
                    if (result.logPath) {
                        try { fs.appendFileSync(result.logPath, appended, 'utf8'); } catch { /* non-fatal -- logContent above already carries it for the UI */ }
                    }
                }
            } catch (e) {
                const appended = `\r\nSource plugins: could not finish (${e.message})\r\n`;
                result.logContent = (result.logContent || '') + appended;
            }

            // result.mergeFolder is only set for the v2 engine (see its own comment above) -- absent,
            // enrichMergeJsonForRestore is skipped entirely, so the old engine (no merge.json at all)
            // is untouched. Same "never hide a merge that already succeeded" philosophy as the
            // cleanup step above -- any failure here is reported into the log, not thrown.
            if (result.mergeFolder) {
                try {
                    enrichMergeJsonForRestore({ mergeFolder: result.mergeFolder, mergeName, action: resolvedAction, items: itemsWithModAttrs, backupPaths, staging });
                } catch (e) {
                    const appended = `\r\nCould not write recovery data to merge.json: ${e.message}\r\n`;
                    result.logContent = (result.logContent || '') + appended;
                }
            }

            // Relink Scripts -- proactive, not blind (2026-08-18, director's own explicit follow-up
            // ask: don't make this a "push the button and see" action the way zEdit's own UI is;
            // this tool already scans for free right after every build, so it does). Never lets a
            // scan failure hide a merge that already succeeded, same reasoning as the cleanup step
            // above -- 'done' must still fire either way.
            try {
                const cache = await relinkScripts.updateScriptsCache(gameDataDir, (current, total, label) => {
                    if (mergeSession.get() === mySession) mergeSession.emit({ type: 'progress', current, total, label: `Scanning ${label} for relink opportunities…` });
                });
                result.relinkCandidates = relinkScripts.getScriptsToRelink(cache, items.map((it) => it.fileName));
                result.mergedPluginFileName = path.basename(outputPath);
            } catch (e) {
                result.relinkScanError = e.message;
            }

            mergeSession.emit({ type: 'done', done: true, ...result });
        }).catch((e) => {
            if (mergeSession.get() !== mySession) return;
            mergeSession.emit({ type: 'error', done: true, error: true, message: e.message });
        });
    });

    // Relink Scripts (2026-08-18) -- runs the actual relink against the scan the /merge route's own
    // success handler already did automatically (relinkCandidates in its 'done' payload), so this
    // never re-scans -- the client sends back exactly the entries that already matched. Scoped to
    // the ONE merge that was just built (mergeDataDir/outputDir/mergedPluginFileName all describe
    // that merge specifically), not zEdit's own "every saved merge" model -- this tool has no
    // persistent merge list to operate across. No Vortex-running gate -- like /master-dependents,
    // this only ever reads Plugins.txt-adjacent files and the Data folder directly, never Vortex's
    // own live state.v2.
    router.post('/relink', async (req, res) => {
        const { entries, mergeDataDir, outputDir, mergedPluginFileName } = req.body || {};
        if (!Array.isArray(entries) || entries.length === 0) return res.status(400).json({ error: 'No scripts to relink were provided.' });
        if (!mergeDataDir || !outputDir || !mergedPluginFileName) return res.status(400).json({ error: 'mergeDataDir, outputDir, and mergedPluginFileName are all required.' });
        const gameDataDir = requireSkyrimDataDir(res);
        if (!gameDataDir) return;
        try {
            const fidMap = JSON.parse(fs.readFileSync(path.join(mergeDataDir, 'map.json'), 'utf8'));
            const result = await relinkScripts.relinkScripts(entries, { gameDataDir, fidMap, mergedPluginFileName, outputDir });
            res.json(result);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Trusted-localhost-only convenience (never exposed off loopback), same reasoning as
    // rebuild-routes.js's own /reveal -- opens the merge output folder directly in Explorer. The
    // output folder is arbitrary/user-chosen (never restricted to staging), so this doesn't
    // validate against any single configured root the way Missing Masters' own open-folder routes
    // do; there's no fixed root to validate against here.
    router.post('/open-output-folder', (req, res) => {
        const { folderPath } = req.body || {};
        if (!folderPath || typeof folderPath !== 'string') return res.status(400).json({ error: 'folderPath is required.' });
        spawn(`explorer.exe "${path.resolve(folderPath)}"`, { shell: true, detached: true, stdio: 'ignore' }).unref();
        res.json({ ok: true });
    });

    // Flag as Light (2026-08-24, merge-flag-as-light) -- see lib/esp-light-flag.js's own header for
    // the full design writeup (mirrors Vortex's real setLightFlag + LOOT-validity-check shape,
    // confirmed against real Vortex source and a real empirical byte comparison). outputPath is
    // exactly what the Done screen's own `result.outputPath` already holds -- the merge's OWN output
    // folder is arbitrary/user-chosen (same reasoning /open-output-folder above already documents;
    // no single fixed root to validate against), so the real safety property here isn't "is this path
    // inside some folder" -- it's that the eligibility check ALWAYS re-runs fresh, server-side,
    // immediately before every real write, never trusting a client-held flag from an earlier response
    // (same "always re-derive before a real action" principle this app already follows elsewhere,
    // e.g. computeMasterDependents re-derived fresh right before a build). requirePluginPath below is
    // the one guard that IS meaningful without a fixed root: the target must actually look like a
    // plugin file, so a wrong/garbled path fails fast with a clear message instead of touching
    // whatever it happened to point at.
    function requirePluginPath(req, res) {
        const outputPath = String((req.method === 'GET' ? req.query.outputPath : req.body?.outputPath) || '');
        if (!outputPath || !/\.(esp|esm|esl)$/i.test(outputPath)) {
            res.status(400).json({ error: 'invalid-path', message: 'outputPath must point at a real .esp/.esm/.esl file.' });
            return null;
        }
        return path.resolve(outputPath);
    }

    router.get('/light-eligibility', (req, res) => {
        const resolved = requirePluginPath(req, res);
        if (!resolved) return;
        try {
            res.json(scanLightPluginValidity(resolved));
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.post('/flag-as-light', (req, res) => {
        const resolved = requirePluginPath(req, res);
        if (!resolved) return;
        try {
            const check = scanLightPluginValidity(resolved);
            if (!check.eligible) {
                return res.status(400).json({ error: 'not-eligible', message: "This plugin's own new records aren't already numbered in the light-plugin range.", ...check });
            }
            setLightFlag(resolved, true);
            // Self-verifying, matching Missing Masters' own setPluginEnabled convention -- read the
            // real byte back rather than trusting the write call returned without throwing.
            const header = readPluginHeader(resolved);
            if (!header || !(header.flags & FLAG_LIGHT_MASTER)) {
                return res.status(500).json({ error: 'write-failed', message: 'The flag write did not take effect on disk -- please try again.' });
            }
            res.json({ ok: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    return router;
}

// runPostMergeCleanup/enrichMergeJsonForRestore exported alongside the router (2026-08-24,
// merge-restore-report-data) purely for direct testability -- see
// scripts/test-merge-restore-report-data.js, which exercises both against disposable scratch
// files rather than a real xelib build against the director's own live staging directory (the
// 'remove'/'backup-remove' actions genuinely delete `item.fullPath`, so a real end-to-end test of
// those two would risk real mod files).
module.exports = { createMergeRouter, runPostMergeCleanup, enrichMergeJsonForRestore };
