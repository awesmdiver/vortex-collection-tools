'use strict';
// Merge History report -- reads every past merge's saved merge.json (lib/merge-v2-worker.js's own
// writeArtifacts, enriched by web/merge-routes.js's own enrichMergeJsonForRestore with
// mergedPluginName/action/collectionName/stagingFolderName/backupPath) out of the configured merge
// output folder, and offers Restore/Revert per merge. See
// design/mockup-merge-plugins-new-features.html section 6 for the full design writeup -- the
// three-state model (Nothing to change / Revert / Restore) and the per-action Revert/Restore table
// are argued through there over multiple rounds; this file implements that, not a fresh
// interpretation. See DESIGN.md's "read-only browse/expand pattern" section for the report's own UI
// shape (merge -> collection -> plugin, three levels).
//
// Only v2-engine merges are visible here -- the old (v1) engine never wrote a merge.json at all
// (confirmed real on disk: a v1 merge folder only ever has map.json), so a "merge - <name>" folder
// without one, or with an un-enriched merge.json from before this feature existed (no
// mergedPluginName/action), is silently skipped rather than reported as broken.
//
// Three-state computation ('nothing' | 'revert' | 'restore'), read fresh on every /rows call:
//   1. The merge's own OUTPUT plugin file is gone entirely -> 'restore', unconditionally (this
//      overrides everything else -- nothing covers that content anymore, regardless of what state
//      the originals happen to be in).
//   2. Otherwise, for a 'disable'-action merge: "still as the merge left them" means still NOT
//      active in Plugins.txt. Any one of them back active (a collection update, a manual re-enable)
//      -> 'revert'.
//   3. For 'remove'/'backup-remove': "still as the merge left them" means the original file is
//      still absent from its own staging folder. Any one of them having reappeared -> 'revert'.
//
// Revert and Restore both act on EVERY plugin in the merge at once -- there is no per-plugin state,
// matching how the merge's own action was applied. Revert:
//   - disable  -> disable them again (reuses web/merge-routes.js's own runPostMergeCleanup exactly).
//   - remove / backup-remove -> plain delete again (no new backup -- a backup-remove's own original
//     backup, made at merge time, is what Restore uses; Revert never creates a second one).
// Restore (brings every original back regardless of current state):
//   - disable  -> enable them again. Helper-only, no Plugins.txt fallback -- matching Missing
//     Masters' own established /set-plugin-enabled precedent (web/missing-masters-routes.js) exactly.
//   - remove / backup-remove -> copy from the plugin's own recorded backupPath if it still exists;
//     otherwise re-extract the plugin's owning mod from its archive via lib/rebuild-single-mod.js's
//     rebuildSingleMod (the same single-mod re-extraction engine Missing Masters' own Restore/Rebuild
//     This Mod already use), grouped by stagingFolderName so a mod contributing many of this merge's
//     plugins (a real case -- see lib/merge-plugin-scan.js's own Diziet's-mod precedent) is only
//     re-extracted once, not once per plugin.

const fs = require('fs');
const path = require('path');
const express = require('express');
const appConfig = require('../lib/app-config');
const syncLib = require('../lib/vortex-sync/lib');
const helperClient = require('../lib/vortex-helper-client');
const missingMastersScan = require('../lib/missing-masters-scan');
const { rebuildSingleMod } = require('../lib/rebuild-single-mod');
// Reused directly, not reimplemented -- runPostMergeCleanup is exported alongside createMergeRouter
// specifically for this kind of reuse (see that file's own "runPostMergeCleanup/
// enrichMergeJsonForRestore exported alongside the router" comment). Requiring the module here does
// NOT invoke createMergeRouter (a function, not called) -- no double-mounting risk.
const { runPostMergeCleanup } = require('./merge-routes');

function createMergeHistoryRouter(config) {
    const router = express.Router();
    const { staging, downloads, state } = config;

    function requireStaging(res) {
        if (staging) return true;
        res.status(400).json({ error: 'not-configured', message: 'Set up your Vortex staging folder under Settings first.' });
        return false;
    }

    function requireOutputDir(res) {
        const { mergeOutputDir } = appConfig.loadConfig();
        if (mergeOutputDir) return mergeOutputDir;
        res.status(400).json({ error: 'not-configured', message: 'Build at least one merge first -- Merge History reads the same output folder Merge Plugins already writes to.' });
        return null;
    }

    // Every real, enriched merge.json under mergeOutputDir -- one per "merge - <name>" subfolder
    // (see lib/merge-v2-worker.js's writeArtifacts / web/merge-routes.js's own mergeSubfolder
    // comment for why the layout is <mergeOutputDir>/<mergedBaseName>/merge - <mergeName>/merge.json,
    // with the actual output plugin sitting one level up from merge.json, at
    // <mergeOutputDir>/<mergedBaseName>/<filename>).
    function findAllMergeJsons(mergeOutputDir) {
        const found = [];
        let topEntries;
        try {
            topEntries = fs.readdirSync(mergeOutputDir, { withFileTypes: true });
        } catch {
            return found; // folder configured but not readable (moved/deleted) -- report zero, not a hard error
        }
        for (const top of topEntries) {
            if (!top.isDirectory()) continue;
            const mergeSubfolder = path.join(mergeOutputDir, top.name);
            let innerEntries;
            try {
                innerEntries = fs.readdirSync(mergeSubfolder, { withFileTypes: true });
            } catch {
                continue;
            }
            for (const inner of innerEntries) {
                if (!inner.isDirectory() || !inner.name.startsWith('merge - ')) continue;
                const mergeJsonPath = path.join(mergeSubfolder, inner.name, 'merge.json');
                if (!fs.existsSync(mergeJsonPath)) continue; // v1-engine merge -- no merge.json at all
                let json;
                try {
                    json = JSON.parse(fs.readFileSync(mergeJsonPath, 'utf8'));
                } catch {
                    continue; // unreadable/corrupt -- skip rather than fail the whole report over one merge
                }
                if (!json.mergedPluginName || !json.action) continue; // built before this feature existed -- never enriched
                found.push({
                    id: `${top.name}/${inner.name}`, // relative to mergeOutputDir, used verbatim to re-locate this merge on a later Revert/Restore call
                    mergeSubfolder,
                    mergeJsonPath,
                    pluginPath: path.join(mergeSubfolder, json.filename),
                    json,
                });
            }
        }
        return found;
    }

    // Re-derives a merge's own paths from a client-submitted `id` -- never trusts it as a raw
    // filesystem path. `id` is always exactly what /rows itself handed back (top.name/inner.name),
    // so this just re-walks the same two path.join calls findAllMergeJsons already did, then
    // confirms the result still resolves INSIDE mergeOutputDir before touching disk (same isInside
    // shape used elsewhere in this app -- missing-masters-routes.js, rebuild-missing-routes.js,
    // web/merge-routes.js's own third copy for the ESLifier filter).
    function resolveMergeById(mergeOutputDir, id) {
        if (!id || typeof id !== 'string') return null;
        const resolvedBase = path.resolve(mergeOutputDir);
        const mergeFolder = path.resolve(mergeOutputDir, id);
        if (mergeFolder !== resolvedBase && !mergeFolder.startsWith(resolvedBase + path.sep)) return null;
        const mergeJsonPath = path.join(mergeFolder, 'merge.json');
        if (!fs.existsSync(mergeJsonPath)) return null;
        let json;
        try {
            json = JSON.parse(fs.readFileSync(mergeJsonPath, 'utf8'));
        } catch {
            return null;
        }
        if (!json.mergedPluginName || !json.action) return null;
        const mergeSubfolder = path.dirname(mergeFolder);
        return { mergeSubfolder, pluginPath: path.join(mergeSubfolder, json.filename), json };
    }

    // 'nothing' | 'revert' | 'restore' -- see this file's own header comment for the full rule.
    // activePluginsLower: every currently-ACTIVE (starred) plugin filename in Plugins.txt, lowercased
    // -- read ONCE per /rows call (see that handler) and passed in here rather than re-read per merge.
    function computeMergeState({ json, pluginPath, activePluginsLower }) {
        if (!fs.existsSync(pluginPath)) return 'restore';
        const plugins = json.plugins || [];
        if (json.action === 'disable') {
            const anyBackActive = plugins.some((p) => activePluginsLower.has(String(p.filename).toLowerCase()));
            return anyBackActive ? 'revert' : 'nothing';
        }
        // remove / backup-remove
        const anyReappeared = plugins.some((p) => {
            if (!p.stagingFolderName) return false; // can't check -- never false-positive a revert over this
            return fs.existsSync(path.join(staging, p.stagingFolderName, p.filename));
        });
        return anyReappeared ? 'revert' : 'nothing';
    }

    router.get('/rows', (req, res) => {
        const mergeOutputDir = requireOutputDir(res);
        if (!mergeOutputDir) return;
        try {
            const merges = findAllMergeJsons(mergeOutputDir);
            const { pluginsListDir } = appConfig.loadConfig();
            let activePluginsLower = new Set();
            if (pluginsListDir) {
                try {
                    const { starred } = missingMastersScan.readPluginsTxt(path.join(pluginsListDir, 'Plugins.txt'));
                    activePluginsLower = starred; // already lowercased by readPluginsTxt
                } catch { /* unreadable Plugins.txt -- every disable-action merge just reports 'nothing' below, not a hard failure */ }
            }
            const rows = merges.map(({ id, pluginPath, json }) => {
                const mergeState = computeMergeState({ json, pluginPath, activePluginsLower });
                // Grouped by collection for the report's own 3-level browse/expand (merge -> collection
                // -> plugin) -- a plugin with no recorded collectionName (a pre-enrichment merge.json
                // slipping through, or a genuinely unresolvable source) groups under one honest label
                // rather than silently vanishing.
                const byCollection = new Map();
                for (const p of json.plugins || []) {
                    const name = p.collectionName || 'Unknown collection';
                    if (!byCollection.has(name)) byCollection.set(name, []);
                    byCollection.get(name).push(p.filename);
                }
                const collections = [...byCollection.entries()]
                    .map(([name, files]) => ({ name, plugins: files.slice().sort((a, b) => a.localeCompare(b)) }))
                    .sort((a, b) => a.name.localeCompare(b.name));
                return {
                    id, mergedPluginName: json.mergedPluginName, filename: json.filename, action: json.action,
                    dateBuilt: json.dateBuilt, pluginCount: (json.plugins || []).length, state: mergeState, collections,
                };
            });
            rows.sort((a, b) => String(b.dateBuilt || '').localeCompare(String(a.dateBuilt || '')));
            res.json({ merges: rows });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.post('/revert', async (req, res) => {
        const mergeOutputDir = requireOutputDir(res);
        if (!mergeOutputDir) return;
        if (!requireStaging(res)) return;
        const found = resolveMergeById(mergeOutputDir, req.body?.id);
        if (!found) return res.status(404).json({ error: 'not-found', message: 'That merge could not be found -- it may have been moved or deleted.' });
        const { json } = found;
        try {
            const lines = [];
            if (json.action === 'disable') {
                const { pluginsListDir } = appConfig.loadConfig();
                const pluginsTxtPath = pluginsListDir ? path.join(pluginsListDir, 'Plugins.txt') : null;
                const items = (json.plugins || []).map((p) => ({ fileName: p.filename }));
                const cleanup = await runPostMergeCleanup({ items, action: 'disable', outputDir: null, pluginsTxtPath });
                lines.push(...cleanup.lines);
            } else {
                // Plain delete, every time -- no new backup. A backup-remove's own original backup
                // (made once, at merge time) is what Restore reads from; Revert never creates a second
                // one, matching the task's own table exactly ("Delete it again", not "back up then
                // delete it again").
                for (const p of json.plugins || []) {
                    if (!p.stagingFolderName) { lines.push(`Skipped ${p.filename} -- no recorded staging location.`); continue; }
                    const fullPath = path.join(staging, p.stagingFolderName, p.filename);
                    try {
                        if (fs.existsSync(fullPath)) {
                            fs.unlinkSync(fullPath);
                            lines.push(`Removed ${p.filename} from staging.`);
                        } else {
                            lines.push(`${p.filename} was not present; skipped removal.`);
                        }
                    } catch (e) {
                        lines.push(`Could not remove ${p.filename}: ${e.message}`);
                    }
                }
            }
            res.json({ lines });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.post('/restore', async (req, res) => {
        const mergeOutputDir = requireOutputDir(res);
        if (!mergeOutputDir) return;
        if (!requireStaging(res)) return;
        const found = resolveMergeById(mergeOutputDir, req.body?.id);
        if (!found) return res.status(404).json({ error: 'not-found', message: 'That merge could not be found -- it may have been moved or deleted.' });
        const { json } = found;
        try {
            const lines = [];
            if (json.action === 'disable') {
                // Helper-only, no Plugins.txt fallback -- same real asymmetry Missing Masters' own
                // /set-plugin-enabled already established (that route has no fallback branch at all,
                // unlike disable's own Plugins.txt path in runPostMergeCleanup above): a Plugins.txt
                // '*' can be removed offline, but adding one back correctly (matching Vortex's own
                // load-order placement rules) needs Vortex's live cooperation, not a blind file edit.
                const helperAvailable = await helperClient.checkHelperAvailable(syncLib.GAME_ID);
                if (!helperAvailable) {
                    return res.status(409).json({
                        error: 'helper-unavailable',
                        message: 'The Vortex Collection Helper extension must be reachable (Vortex genuinely open) to turn these plugins back on.',
                    });
                }
                for (const p of json.plugins || []) {
                    const ok = await helperClient.setPluginEnabled(p.filename, true);
                    lines.push(ok
                        ? `Re-enabled ${p.filename} in Vortex. Deploy mods in Vortex to apply changes to your game.`
                        : `Could not enable ${p.filename} (it may not be in the current load order).`);
                }
            } else {
                // Backup first, per plugin. Anything with no usable backup gets grouped by
                // stagingFolderName and re-extracted from its archive ONCE per folder, not once per
                // plugin -- one mod can own dozens of this merge's plugins (see lib/merge-plugin-
                // scan.js's own Diziet's-mod precedent, 31 real files from a single FOMOD-installed mod).
                const needsArchive = new Map(); // stagingFolderName -> [fileName, ...]
                for (const p of json.plugins || []) {
                    if (p.backupPath && fs.existsSync(p.backupPath)) {
                        try {
                            const targetPath = path.join(staging, p.stagingFolderName || '', p.filename);
                            fs.mkdirSync(path.dirname(targetPath), { recursive: true });
                            fs.copyFileSync(p.backupPath, targetPath);
                            lines.push(`Restored ${p.filename} from backup.`);
                        } catch (e) {
                            lines.push(`Could not restore ${p.filename} from its backup: ${e.message}`);
                        }
                        continue;
                    }
                    if (!p.stagingFolderName) {
                        lines.push(`Could not restore ${p.filename}: no recorded staging folder found for extraction.`);
                        continue;
                    }
                    if (!needsArchive.has(p.stagingFolderName)) needsArchive.set(p.stagingFolderName, []);
                    needsArchive.get(p.stagingFolderName).push(p.filename);
                }
                if (needsArchive.size) {
                    const helperAvailable = await helperClient.checkHelperAvailable(syncLib.GAME_ID);
                    const liveData = helperAvailable ? await helperClient.getAllMods() : null;
                    const { downloadMissingArchives } = appConfig.loadConfig();
                    for (const [stagingFolderName, fileNames] of needsArchive) {
                        try {
                            const result = await rebuildSingleMod({
                                vortexModId: stagingFolderName, gameId: syncLib.GAME_ID, stateDir: state,
                                downloadsDir: downloads, stagingDir: staging,
                                allowAutoDownload: !!downloadMissingArchives, liveMods: liveData ? liveData.mods : null,
                            });
                            if (result.status === 'REBUILT') {
                                for (const fn of fileNames) lines.push(`Restored ${fn} by re-extracting "${result.modName || stagingFolderName}" from archive.`);
                            } else {
                                const reason = result.status || result.kind || 'unknown error';
                                for (const fn of fileNames) lines.push(`Could not restore ${fn} -- couldn't re-extract "${stagingFolderName}" from its archive (${reason}).`);
                            }
                        } catch (e) {
                            for (const fn of fileNames) lines.push(`Could not restore ${fn}: ${e.message}`);
                        }
                    }
                }
            }
            res.json({ lines });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    return router;
}

module.exports = { createMergeHistoryRouter };
