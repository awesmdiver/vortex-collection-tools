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
//
// /rename and /delete act on the saved-merge RECORD's own identity/existence -- a completely
// separate axis from Revert/Restore above, which act on the merge's ORIGINAL SOURCE plugins.
// Neither one touches Plugins.txt or the merge's own already-applied effect on your load order:
//   - /rename (revised 2026-08-25 -- see that route's own comment for the full reasoning) is a REAL,
//     total rename: the outer mergeSubfolder, the actual .esp (and its .seq, if any), the inner
//     `merge - <name>` record folder, and merge.json's own name/mergedPluginName/filename all change
//     together. /apply-staging-copy is the optional, separately-confirmed follow-up for the one real
//     Vortex-relevant side effect this can leave behind -- a stale old-named copy in
//     mergeStagingCopyDir, if that setting is in use.
//   - /delete permanently removes the whole mergeSubfolder from disk (the `merge - <name>` folder,
//     the merged plugin + its .seq, and a backup-remove merge's own Backup/ copies) -- see that
//     route's own comment. This does NOT undo the merge; whatever it already changed in Vortex stays.

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

// Every real, enriched merge.json under mergeOutputDir -- one per "merge - <name>" subfolder (see
// lib/merge-v2-worker.js's writeArtifacts / web/merge-routes.js's own mergeSubfolder comment for why
// the layout is <mergeOutputDir>/<mergedBaseName>/merge - <mergeName>/merge.json, with the actual
// output plugin sitting one level up from merge.json, at <mergeOutputDir>/<mergedBaseName>/<filename>).
//
// Module-level (not a router-closure helper) and exported below specifically so lib/merged-plugin-
// lookup.js can reuse this SAME discovery for Update Collection v2's own merged-plugin Review flag
// (2026-08-25) -- "read every saved merge's own merge.json, same discovery Merge History already
// uses" -- rather than a second, separately-maintained copy of this walk.
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
        return { mergeFolder, mergeSubfolder, pluginPath: path.join(mergeSubfolder, json.filename), json };
    }

    // Windows-invalid filename characters plus the two path separators -- `newName` becomes the
    // literal `merge - <newName>` folder name below, so this is a correctness/traversal guard, not a
    // cosmetic one (unlike The Forge's own free-typed output name, which is trusted as-is since it
    // only ever feeds a single path.join with no client-controlled folder-escape risk this route
    // doesn't already close off via resolveMergeById's own isInside check on the OLD path).
    const INVALID_NAME_CHARS = /[\\/:*?"<>|]/;

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
                // Grouped by MOD, not collection (corrected 2026-08-25 -- director's own call: "we
                // don't care on this report what collection it's in, but we do care what Mod the
                // plugins are in"). Merges pull plugins from wherever they're staged; which Vortex
                // COLLECTION happened to install a given mod is incidental here, but which MOD each
                // plugin came from is the real, useful grouping -- same as this report's earlier
                // Restore/Revert logic already resolves per-mod (stagingFolderName), not per-collection.
                // p.dataFolder (lib/merge-v2-worker.js's writeArtifacts, sourced from the real Vortex
                // mod/staging-folder name at merge time) is already a clean display name -- no
                // stripDownloadNameSuffix cleanup needed, unlike a raw folder name elsewhere in this
                // app. Falls back to the raw stagingFolderName, then one honest label, for a
                // pre-enrichment merge.json slipping through rather than silently vanishing.
                const byMod = new Map();
                for (const p of json.plugins || []) {
                    const name = p.dataFolder || p.stagingFolderName || 'Unknown mod';
                    if (!byMod.has(name)) byMod.set(name, []);
                    byMod.get(name).push(p.filename);
                }
                const mods = [...byMod.entries()]
                    .map(([name, files]) => ({ name, plugins: files.slice().sort((a, b) => a.localeCompare(b)) }))
                    .sort((a, b) => a.name.localeCompare(b.name));
                return {
                    id, mergedPluginName: json.mergedPluginName, filename: json.filename, action: json.action,
                    dateBuilt: json.dateBuilt, pluginCount: (json.plugins || []).length, state: mergeState, mods,
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
                            lines.push(`${p.filename} - ${p.stagingFolderName || '(unknown folder)'} - ${e.message}`);
                        }
                        continue;
                    }
                    if (!p.stagingFolderName) {
                        lines.push(`${p.filename} - (no staging folder) - no recorded staging folder found for extraction.`);
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
                                const reason = result.detail || result.status || result.kind || 'unknown error';
                                for (const fn of fileNames) lines.push(`${fn} - ${stagingFolderName} - ${reason}`);
                            }
                        } catch (e) {
                            for (const fn of fileNames) lines.push(`${fn} - ${stagingFolderName} - ${e.message}`);
                        }
                    }
                }
            }
            res.json({ lines });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Real rename (2026-08-25, revised) -- renames the WHOLE merge, not just the record's own display
    // identity: the outer mergeSubfolder itself, the real merged .esp (and its .seq, if the merge
    // produced one), and the inner `merge - <name>` record folder, plus merge.json's own
    // name/mergedPluginName/filename fields to match. This reverses the original, narrower design
    // (which deliberately left the real .esp untouched) -- director's own explicit correction
    // 2026-08-25, real case: a merge built as "Miahil_Merged" (a typo) needed to become
    // "Mihail_Merged" everywhere, not just in this report's own display, without hand-editing 3
    // folders + a file + a JSON on disk.
    //
    // lib/merge-v2-worker.js's own computeMergeOutputPaths (web/merge-routes.js) guarantees these
    // three are ALWAYS the same string at build time: the outer folder name, the .esp's own base
    // filename, and the mergeName baked into `merge - <mergeName>`. Renaming the OUTER folder first
    // (a single fs.renameSync) moves everything inside it -- the .esp, an optional seq/ subfolder, the
    // inner record folder, and a backup-remove merge's own Backup/ folder -- as one atomic OS-level
    // move, so only the 2-3 individually-NAMED children (the .esp, the .seq, the inner record folder)
    // need a second rename pass after that.
    //
    // Does NOT touch Plugins.txt or Vortex's own tracking of this plugin directly -- if this exact
    // filename was ever deployed into Vortex (via the optional mergeStagingCopyDir auto-copy, see
    // web/merge-routes.js's own comment on it), Vortex is now tracking a mod folder whose real file
    // just disappeared out from under it. staleStagingPath in the response flags this specific,
    // detectable case back to the caller -- see /apply-staging-copy below, which is the real fix for
    // it, offered as a separate confirm step rather than applied silently here.
    router.post('/rename', (req, res) => {
        const mergeOutputDir = requireOutputDir(res);
        if (!mergeOutputDir) return;
        const found = resolveMergeById(mergeOutputDir, req.body?.id);
        if (!found) return res.status(404).json({ error: 'not-found', message: 'That merge could not be found -- it may have been moved or deleted.' });
        const newName = String(req.body?.newName || '').trim();
        if (!newName) return res.status(400).json({ error: 'invalid-name', message: 'Give it a name first.' });
        if (INVALID_NAME_CHARS.test(newName) || newName === '.' || newName === '..') {
            return res.status(400).json({ error: 'invalid-name', message: 'That name can\'t contain \\ / : * ? " < > | characters.' });
        }
        const { mergeSubfolder, json } = found;
        const oldName = json.mergedPluginName;
        const oldExt = path.extname(json.filename) || '.esp';
        const oldBaseName = path.basename(json.filename, oldExt);
        const newFilename = `${newName}${oldExt}`;
        const newMergeSubfolder = path.join(path.dirname(mergeSubfolder), newName);
        try {
            if (newName !== oldName) {
                if (fs.existsSync(newMergeSubfolder)) {
                    return res.status(409).json({ error: 'name-taken', message: 'A merge with that name already exists here -- try something else.' });
                }
                // One atomic move brings the .esp, any seq/ folder, the inner record folder, and a
                // backup-remove merge's own Backup/ folder along with it -- nothing else to relocate.
                fs.renameSync(mergeSubfolder, newMergeSubfolder);

                const oldEspPath = path.join(newMergeSubfolder, json.filename);
                const newEspPath = path.join(newMergeSubfolder, newFilename);
                if (fs.existsSync(oldEspPath)) fs.renameSync(oldEspPath, newEspPath);

                const oldSeqPath = path.join(newMergeSubfolder, 'seq', `${oldBaseName}.seq`);
                if (fs.existsSync(oldSeqPath)) {
                    fs.renameSync(oldSeqPath, path.join(newMergeSubfolder, 'seq', `${newName}.seq`));
                }

                const oldRecordFolder = path.join(newMergeSubfolder, `merge - ${oldName}`);
                const newRecordFolder = path.join(newMergeSubfolder, `merge - ${newName}`);
                if (fs.existsSync(oldRecordFolder)) fs.renameSync(oldRecordFolder, newRecordFolder);
            }
            const newRecordFolder = path.join(newMergeSubfolder, `merge - ${newName}`);
            json.name = newName;
            json.mergedPluginName = newName;
            json.filename = newFilename;
            fs.writeFileSync(path.join(newRecordFolder, 'merge.json'), JSON.stringify(json, null, 2));

            // A stale copy under the OLD filename, still sitting in the folder Vortex actually watches
            // -- only ever set when mergeStagingCopyDir is configured AND that exact old-named file is
            // really there (the common case has neither, and gets null -- no follow-up prompt).
            const { mergeStagingCopyDir } = appConfig.loadConfig();
            let staleStagingPath = null;
            if (mergeStagingCopyDir && newName !== oldName) {
                const candidate = path.join(mergeStagingCopyDir, `${oldName}${oldExt}`);
                if (fs.existsSync(candidate)) staleStagingPath = candidate;
            }
            res.json({
                id: `${newName}/merge - ${newName}`, mergedPluginName: newName, filename: newFilename,
                staleStagingPath,
            });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Second, optional step after a rename that leaves a stale old-named copy sitting in the folder
    // Vortex is actually watching (mergeStagingCopyDir) -- offered as its own confirm, not folded
    // silently into /rename above, since it's a real write Vortex will notice (the old mod folder
    // entry loses its file; a new one appears) and the director's own explicit ask was "ask if we
    // want to deploy", not "always deploy". `id` is the merge's NEW id (the rename above already
    // happened); `staleStagingPath` is exactly what /rename's own response just returned, echoed back
    // rather than re-derived, so this can't drift from what the user was actually shown.
    router.post('/apply-staging-copy', (req, res) => {
        const mergeOutputDir = requireOutputDir(res);
        if (!mergeOutputDir) return;
        const found = resolveMergeById(mergeOutputDir, req.body?.id);
        if (!found) return res.status(404).json({ error: 'not-found', message: 'That merge could not be found -- it may have been moved or deleted.' });
        const staleStagingPath = String(req.body?.staleStagingPath || '');
        const { mergeStagingCopyDir } = appConfig.loadConfig();
        if (!mergeStagingCopyDir || path.dirname(path.resolve(staleStagingPath)) !== path.resolve(mergeStagingCopyDir)) {
            return res.status(400).json({ error: 'invalid-request', message: 'That staging copy path is not valid.' });
        }
        try {
            const newPath = path.join(mergeStagingCopyDir, found.json.filename);
            fs.copyFileSync(found.pluginPath, newPath);
            if (fs.existsSync(staleStagingPath) && path.resolve(staleStagingPath) !== path.resolve(newPath)) {
                fs.rmSync(staleStagingPath, { force: true });
            }
            res.json({ ok: true, copiedTo: newPath });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Deletes a saved merge RECORD, and everything it produced -- "if we delete, we delete
    // everything" (director's own explicit call, 2026-08-25): the whole mergeSubfolder (the
    // `merge - <name>` folder holding merge.json/map.json/fidCache.json/the build log, PLUS the
    // merged plugin file and its .seq that sit one level up alongside it, plus a 'backup-remove'
    // merge's own Backup/ subfolder -- see web/merge-routes.js's runPostMergeCleanup, which writes
    // that backup dir as path.join(mergeSubfolder, 'Backup')), PLUS the deployed copy sitting in
    // mergeStagingCopyDir (if that setting is configured and this merge's own filename is actually
    // there) -- same optional staging-folder mechanism /rename's own staleStagingPath detection
    // already knows about, just applied unconditionally here rather than asking first: unlike
    // rename (where the OLD name simply stops being current), delete means nothing about this merge
    // should be left behind anywhere. Best-effort on that one piece -- a missing/unconfigured
    // mergeStagingCopyDir, or no file there under this name, is the ordinary case and never an
    // error; a real removal failure there is reported back but does NOT stop the main deletion.
    //
    // This is real, destructive disk deletion, completely separate from Revert/Restore -- it never
    // touches Plugins.txt or Vortex's own state, and does NOT undo whatever this merge already
    // applied there. The frontend's own confirm copy spells this distinction out before calling here.
    router.post('/delete', (req, res) => {
        const mergeOutputDir = requireOutputDir(res);
        if (!mergeOutputDir) return;
        const found = resolveMergeById(mergeOutputDir, req.body?.id);
        if (!found) return res.status(404).json({ error: 'not-found', message: 'That merge could not be found -- it may have been moved or deleted.' });
        const { mergeSubfolder, json } = found;
        try {
            fs.rmSync(mergeSubfolder, { recursive: true, force: true });
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
        let stagingRemoveError = null;
        const { mergeStagingCopyDir } = appConfig.loadConfig();
        if (mergeStagingCopyDir) {
            const stagedPath = path.join(mergeStagingCopyDir, json.filename);
            try {
                if (fs.existsSync(stagedPath)) fs.rmSync(stagedPath, { force: true });
            } catch (e) {
                stagingRemoveError = e.message;
            }
        }
        res.json({ removed: true, stagingRemoveError });
    });

    return router;
}

module.exports = { createMergeHistoryRouter, findAllMergeJsons };
