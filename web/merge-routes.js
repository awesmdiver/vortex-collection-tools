'use strict';
// Merge Plugins (The Forge) -- bundles several plugins from one or more installed collections into
// a single output plugin, ESL-flagging it automatically when it qualifies. See TECHNICAL.md's
// "Merge engine" section for the full design writeup (the Part A feasibility spike, the v1.0
// new-record-only scope, the ESPFE qualification pipeline).
//
// Reuses this project's existing pieces rather than duplicating them:
//   - lib/sync-runner.js's listInstalledCollections (the exact same "installed collections" list
//     Rebuild Collection/Rules Generator already show).
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
const syncRunner = require('../lib/sync-runner');
const helperClient = require('../lib/vortex-helper-client');
const missingMastersScan = require('../lib/missing-masters-scan');
const { scanCollectionPlugins, scanEslifierOutputPlugins, computeMasterDependents, buildHelperModNameIndex, attributeWithHelperNames } = require('../lib/merge-plugin-scan');
const { checkLoadList } = require('../lib/merge-preflight');
const mergeRunner = require('../lib/merge-runner');
const mergeRunnerV2 = require('../lib/merge-v2-runner');
const relinkScripts = require('../lib/relink-scripts');
const { scanLightPluginValidity, setLightFlag } = require('../lib/esp-light-flag');
const { readPluginHeader, FLAG_LIGHT_MASTER } = require('../lib/esp-header');
const { countActivePluginSlots } = require('../lib/load-order-slot-count');
const { createSseSession } = require('./sse-session');

const LIGHT_PLUGIN_LIMIT = 4096; // hardcoded per the Part A spike sign-off -- requires SSE 1.6.1130+

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
async function runPostMergeCleanup({ items, action, outputDir, pluginsTxtPath }) {
    const lines = [];
    const backupPaths = {};
    if (action === 'remove' || action === 'backup-remove') {
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
    } else if (action === 'disable') {
        // Helper-first (2026-08-24) -- a real write, not a read, so this is deliberately NOT covered
        // by the /analyze and /merge gate removal above (a separate judgment call, flagged in the
        // handoff rather than silently extended here). When the Helper is reachable,
        // setPluginEnabled flips each source plugin's own live flag directly -- the SAME precisely-
        // scoped endpoint Missing Masters' own Enable button already uses, self-verified against
        // Vortex's own before/after readback, so its true/false is the truth, not an assumption.
        // Only an in-memory flag: Plugins.txt on disk (what the game actually reads) is rewritten by
        // Vortex during a real deploy, not by this call -- said explicitly in the result line so it
        // doesn't read as "already done" when a deploy is still the step that finishes it.
        //
        // Falls through to the EXISTING Plugins.txt write, gate and all, completely unchanged, when
        // the Helper isn't available -- that direct-file path takes effect immediately (no deploy
        // needed) and still requires Vortex closed, exactly as it always has.
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
    const { staging } = config;

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
            const collections = syncRunner.listInstalledCollections(staging).map((c) => ({
                modId: c.modId, name: c.name, author: c.author, modCount: c.modCount,
            }));
            res.json({ collections });
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
            const allCollections = syncRunner.listInstalledCollections(staging);
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
            const allCollections = syncRunner.listInstalledCollections(staging);
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
            const result = await mergeRunner.analyzePlugins(items, gameDataDir);
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
    router.post('/merge', (req, res) => {
        if (mergeSession.isActive()) {
            return res.status(409).json({ error: 'A merge is already in progress' });
        }
        const items = Array.isArray(req.body?.items) ? req.body.items : [];
        const outputName = String(req.body?.outputName || '').trim();
        const outputDir = String(req.body?.outputDir || '').trim();
        if (items.length === 0) return res.status(400).json({ error: 'No plugins were provided.' });
        if (!outputName) return res.status(400).json({ error: 'Name the merged plugin first.' });
        if (!outputDir) return res.status(400).json({ error: 'Choose an output folder first.' });

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

        // Purely for the merge log's own "heads up" section (buildMergeLog in lib/merge-worker.js)
        // -- Part 1's own pre-flight check (the /master-dependents-backed modal) already blocks the
        // client from reaching this route with a real unresolved dependency, so this is normally
        // empty. Computed fresh here rather than trusted from anything the client sent, same
        // "always re-derive before a real action" principle -- and non-fatal by design: a merge
        // should never fail just because this heads-up computation couldn't run.
        let residualDependents = [];
        try {
            const { pluginsListDir } = appConfig.loadConfig();
            if (pluginsListDir) {
                const pluginsTxtPath = path.join(pluginsListDir, 'Plugins.txt');
                const allCollections = syncRunner.listInstalledCollections(staging);
                const dependentsByMaster = computeMasterDependents(gameDataDir, pluginsTxtPath, staging, allCollections);
                const includedFileNames = new Set(items.map((it) => it.fileName.toLowerCase()));
                const residual = new Map();
                for (const item of items) {
                    const deps = dependentsByMaster.get(item.fileName.toLowerCase());
                    if (!deps) continue;
                    for (const dep of deps) {
                        const key = dep.fileName.toLowerCase();
                        if (includedFileNames.has(key)) continue;
                        if (!residual.has(key)) residual.set(key, { fileName: dep.fileName, neededFor: [] });
                        residual.get(key).neededFor.push(item.fileName);
                    }
                }
                residualDependents = [...residual.values()];
            }
        } catch {
            // non-fatal -- see comment above
        }

        // Engine selection (2026-08-24, merge-port-implement) -- v2 (lib/merge-v2-worker.js, the
        // zMerge port) is now the REAL default path every merge runs through (mergeUseV2Engine
        // defaults true in lib/app-config.js). `false` in config.json is a real, working rollback to
        // the old engine (lib/merge-worker.js, untouched by the port) with no code change needed.
        //
        // v2's own result shape ({ outputPath, mergeFolder, logPath, recordCount, failedToCopy }) is
        // adapted to the shape this same .then() and the client's own result rendering expect below.
        // eslFlagged/qualificationReason stay a fixed "not yet ported" pair -- v2 has no ESL
        // qualification logic at all yet (a real, separate gap from the log-content bug this fixes),
        // so every v2 merge is honestly reported as a full, non-ESL-flagged .esp regardless of
        // whether the old engine would have qualified it -- never a guess presented as a real
        // determination.
        //
        // logContent used to be hardcoded '' here -- found by the design side, not this task: the
        // log FILE (r.logPath) was already written correctly and richly by
        // lib/merge-v2-worker.js's own incremental logger, just never read back into the value the
        // UI actually displays (merge-app.js's mergeDoneLogContent.textContent = result.logContent,
        // which HIDES the whole log panel outright when this is falsy -- see mergeRenderDoneStep).
        // Read fresh off disk here instead of threading the in-memory buffer back through the
        // worker's own stdout JSON, since the log file itself is now the durable source of truth
        // (lib/merge-v2-worker.js's logger appends synchronously as it goes, specifically so a
        // genuine worker crash -- an access violation, not a catchable JS throw -- still leaves a
        // real partial file to read here, rather than nothing).
        const { mergeUseV2Engine } = appConfig.loadConfig();
        const mergeName = mergedBaseName; // identical computation -- computeMergeOutputPaths already derived this
        const runMerge = mergeUseV2Engine
            ? (onProgress) => mergeRunnerV2.mergePluginsV2(items, outputPath, gameDataDir, mergeName, onProgress)
                .then((r) => {
                    let logContent = '';
                    try { logContent = fs.readFileSync(r.logPath, 'utf8'); } catch { /* the file itself is the log; if it's unreadable there's nothing to show */ }
                    return {
                        recordCount: r.recordCount, overrideRecordCount: 0, eslFlagged: false,
                        qualificationReason: 'v2 engine -- ESL qualification not yet ported',
                        logContent, logPath: r.logPath, outputPath: r.outputPath, failedToCopy: r.failedToCopy,
                        // Kept (2026-08-24, merge-restore-report-data) so the merge.json enrichment
                        // step below can find the SAME merge.json lib/merge-v2-worker.js's own
                        // writeArtifacts already wrote there -- absent for the old engine's result
                        // (mergeDataDir, a different field, different meaning), which is exactly what
                        // makes that step a no-op for the old engine without a separate check.
                        mergeFolder: r.mergeFolder,
                    };
                })
            : (onProgress) => mergeRunner.mergePlugins(items, outputPath, LIGHT_PLUGIN_LIMIT, gameDataDir, onProgress, residualDependents);

        runMerge((current, total, label) => {
            if (mergeSession.get() === mySession) mergeSession.emit({ type: 'progress', current, total, label });
        }).then(async (result) => {
            if (mergeSession.get() !== mySession) return;
            const { mergeOutputDir, mergePostMergeAction, pluginsListDir } = appConfig.loadConfig();
            if (outputDir !== mergeOutputDir) appConfig.saveConfig({ mergeOutputDir: outputDir }); // remember as the default for next time
            const pluginsTxtPath = pluginsListDir ? path.join(pluginsListDir, 'Plugins.txt') : null;

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
                    enrichMergeJsonForRestore({ mergeFolder: result.mergeFolder, mergeName, action: resolvedAction, items, backupPaths, staging });
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
