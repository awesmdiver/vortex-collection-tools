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
//   - syncLib.isVortexRunning() for the "Vortex must be closed" gate (this reads staging files,
//     not Vortex's own database, but staging is Vortex-managed and could be mid-write).

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const express = require('express');
const appConfig = require('../lib/app-config');
const syncLib = require('../lib/vortex-sync/lib');
const syncRunner = require('../lib/sync-runner');
const missingMastersScan = require('../lib/missing-masters-scan');
const { scanCollectionPlugins, computeMasterDependents } = require('../lib/merge-plugin-scan');
const mergeRunner = require('../lib/merge-runner');
const relinkScripts = require('../lib/relink-scripts');
const { createSseSession } = require('./sse-session');

const LIGHT_PLUGIN_LIMIT = 4096; // hardcoded per the Part A spike sign-off -- requires SSE 1.6.1130+

const mergeSession = createSseSession();

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
// for the full read-modify-write reasoning. Re-checks isVortexRunning() immediately before writing
// (not just trusting the route's own request-start gate) -- the same live-write caution
// lib/vortex-sync/lib.js's own withLiveStateDb applies to every LevelDB write now applies here too,
// this app's first-ever write to a load-order file the game itself reads.
async function runPostMergeCleanup({ items, action, outputDir, pluginsTxtPath }) {
    const lines = [];
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
                if (backupDir) fs.copyFileSync(item.fullPath, path.join(backupDir, item.fileName));
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
        if (!pluginsTxtPath) {
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
    return lines;
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
    router.get('/plugins', (req, res) => {
        if (!requireStaging(res)) return;
        const collectionModIds = String(req.query.collections || '').split(',').map((s) => s.trim()).filter(Boolean);
        if (collectionModIds.length === 0) return res.json({ results: [] });
        const q = String(req.query.q || '').trim().toLowerCase();
        const extensions = String(req.query.extensions || '.esp,.esl,.esm').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
        try {
            const allCollections = syncRunner.listInstalledCollections(staging);
            const chosen = allCollections.filter((c) => collectionModIds.includes(c.modId));
            const allPlugins = scanCollectionPlugins(staging, chosen);
            const results = allPlugins.filter((p) => {
                if (extensions.length && !extensions.includes(p.extension)) return false;
                if (!q) return true;
                return p.fileName.toLowerCase().includes(q) || p.modName.toLowerCase().includes(q);
            });
            res.json({ results });
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

    // Read-only look at each chosen plugin: does it contain any override/injected records (v1.0
    // excludes these from the actual merge -- see lib/merge-worker.js's own header comment), what
    // masters does it declare, and how many genuinely new records would it contribute. Vortex-gated
    // since this reads the real plugin files out of staging.
    router.post('/analyze', async (req, res) => {
        if (vortexRunningGate(res)) return;
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

    // Starts the actual merge (only the items the Review step left in -- override-containing
    // plugins must already be excluded by the caller). NEVER the Skyrim Data folder -- this tool
    // doesn't install anything into the game or Vortex, the user does that themselves afterward.
    router.post('/merge', (req, res) => {
        if (vortexRunningGate(res)) return;
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

        const fileName = outputName.toLowerCase().endsWith('.esp') ? outputName : `${outputName}.esp`;
        // Per-merge subfolder (2026-08-18, matching zEdit-Revised's own zMerge layout -- director's
        // own real output on disk was the reference: the chosen Output folder is the ROOT, and each
        // merge gets its OWN subfolder named after itself). outputDir stays the raw, user-picked
        // root throughout this route (still what gets remembered as the default output folder
        // below) -- mergeSubfolder is the actual working directory everything for THIS merge writes
        // into. lib/merge-worker.js's own translations/seq/log paths all derive from
        // path.dirname(outputPath), so nesting outputPath here is enough to carry all of them along
        // automatically -- no changes needed inside that file beyond ensuring the subfolder exists.
        const mergedBaseName = path.basename(fileName, path.extname(fileName));
        const mergeSubfolder = path.join(outputDir, mergedBaseName);
        const outputPath = path.join(mergeSubfolder, fileName);

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

        mergeRunner.mergePlugins(items, outputPath, LIGHT_PLUGIN_LIMIT, gameDataDir, (current, total, label) => {
            if (mergeSession.get() === mySession) mergeSession.emit({ type: 'progress', current, total, label });
        }, residualDependents).then(async (result) => {
            if (mergeSession.get() !== mySession) return;
            const { mergeOutputDir, mergePostMergeAction, pluginsListDir } = appConfig.loadConfig();
            if (outputDir !== mergeOutputDir) appConfig.saveConfig({ mergeOutputDir: outputDir }); // remember as the default for next time
            const pluginsTxtPath = pluginsListDir ? path.join(pluginsListDir, 'Plugins.txt') : null;

            // Never let a Merge Settings failure hide a merge that already succeeded -- the build is
            // done by this point regardless of what happens below, so 'done' must still fire either
            // way. Appends onto the SAME log buildMergeLog already wrote, one coordinated summary
            // rather than two (see runPostMergeCleanup's own header comment).
            try {
                const cleanupLines = await runPostMergeCleanup({ items, action: mergePostMergeAction || 'disable', outputDir: mergeSubfolder, pluginsTxtPath });
                if (cleanupLines.length) {
                    const appended = '\r\nSource plugins:\r\n' + cleanupLines.map((l) => `  - ${l}`).join('\r\n') + '\r\n';
                    result.logContent = (result.logContent || '') + appended;
                    if (result.logPath) {
                        try { fs.appendFileSync(result.logPath, appended, 'utf8'); } catch { /* non-fatal -- logContent above already carries it for the UI */ }
                    }
                }
            } catch (e) {
                const appended = `\r\nSource plugins: could not finish (${e.message})\r\n`;
                result.logContent = (result.logContent || '') + appended;
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

    return router;
}

module.exports = { createMergeRouter };
