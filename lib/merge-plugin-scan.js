'use strict';
// Merge Plugins (The Forge) -- plugin discovery. Pure filesystem reads, no xelib involved (xelib
// only comes in for lib/merge-engine.js's actual load/analyze/merge work). See TECHNICAL.md's
// "Merge engine" section for the full design writeup.
//
// CORRECTED (2026-08-24, merge-step1-real-files-not-json-snapshot): this used to cross-reference
// collection.json's own `plugins: [{name, enabled}]` array as the "authoritative" list of what a
// collection contains. That array is NOT live -- confirmed real (director, 2026-08-24): Vortex only
// writes it when the collection itself is explicitly updated (or, for a Workshop item, re-fetched
// from Nexus), never on an ordinary deploy. It can also just be a PARTIAL snapshot of what Vortex's
// own collection editor happened to record rule choices for at authoring time -- confirmed live: a
// 5-mod test collection whose `plugins` array listed only 6 entries, while one single FOMOD-installed
// mod in it ("Diziet's Player Home Bath Undressing for SkyrimSE") alone had 31 real .esp files on
// disk. Re-enabling every mod and redeploying in Vortex did NOT change collection.json (confirmed via
// its unchanged mtime) -- deploy simply never touches this file, so the old approach could never see
// those files no matter what state the mods were actually in. The director also wants disabled mods
// mergeable, which the old `plugins[]`-only approach coincidentally never enforced either (it never
// even checked `enabled`) but would have kept missing entirely if a mod's plugins were never added to
// that array in the first place.
//
// Now walks the real staging directory (same one-pass technique as
// lib/missing-masters-scan.js's buildStagingModNameIndex, confirmed fast there: "~150ms for a full
// pass" against a real ~4550-folder staging directory) and, for each chosen collection, resolves its
// `mods[]` entries to real staging folders by matching each mod's `source.logicalFilename` (falling
// back to `name`) against `stripDownloadNameSuffix(folder.name)` -- the SAME modName-from-folder
// guess used everywhere else in this app (walkStagingForPlugins' own modName field, missing-masters-
// scan.js's buildStagingModNameIndex). `logicalFilename` matches the real folder name far more
// reliably than `name` -- for a "Mihail" mod, collection.json's own `name` is a longer,
// human-authored display string ("Wendigo- Mihail Monsters and Animals (SE-AE) - wendigo (se-ae)")
// that doesn't match its own real staging folder name at all, while `logicalFilename` ("wendigo
// (se-ae)") matches exactly -- confirmed against all 5 real mods in the test collection above.
// Every real plugin file found in a matched folder is included, regardless of whether
// collection.json's own `plugins` array ever mentioned it.

const fs = require('fs');
const path = require('path');
const { stripDownloadNameSuffix } = require('./download-naming');
const { readPluginHeader } = require('./esp-header');
const { scanDataFolder, readPluginsTxt, computeActiveSet } = require('./missing-masters-scan');

const PLUGIN_EXTENSIONS = ['.esp', '.esm', '.esl'];

function hasPluginExtension(name) {
    const lower = name.toLowerCase();
    return PLUGIN_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

// Every plugin file at ONE mod folder's own root, or one level into a "Data" subfolder (some mod
// authors ship an on/off-format choice with the real payload nested under "data\"). Shared by
// walkStagingForPlugins (called once per top-level staging folder) and scanEslifierOutputPlugins
// (called once, directly, against the configured ESLifier output folder -- which isn't itself one of
// stagingDir's own top-level entries in the general case, though it usually is here). Returns
// [{fileName, extension, fullPath}] -- modName is attached by the caller, since the two callers derive
// it differently (stripDownloadNameSuffix(folder.name) for a real staging mod; a fixed label for the
// ESLifier folder, which isn't a downloaded/versioned mod archive and shouldn't be stripped as one).
function walkOneModFolder(modDir) {
    const found = [];
    let entries;
    try {
        entries = fs.readdirSync(modDir, { withFileTypes: true });
    } catch {
        return found; // unreadable folder -- caller decides whether that's fatal
    }
    for (const entry of entries) {
        if (entry.isFile() && hasPluginExtension(entry.name)) {
            found.push({ fileName: entry.name, extension: path.extname(entry.name).toLowerCase(), fullPath: path.join(modDir, entry.name) });
        }
    }
    const dataDirEntry = entries.find((e) => e.isDirectory() && e.name.toLowerCase() === 'data');
    if (dataDirEntry) {
        let dataFiles;
        try {
            dataFiles = fs.readdirSync(path.join(modDir, dataDirEntry.name), { withFileTypes: true });
        } catch {
            dataFiles = [];
        }
        for (const entry of dataFiles) {
            if (entry.isFile() && hasPluginExtension(entry.name)) {
                found.push({ fileName: entry.name, extension: path.extname(entry.name).toLowerCase(), fullPath: path.join(modDir, dataDirEntry.name, entry.name) });
            }
        }
    }
    return found;
}

// One pass over stagingDir's immediate subfolders. Skips any folder that itself has a
// collection.json (a collection's own staging folder, not a mod's) so a collection is never
// mistaken for one of its own member mods. Returns Map<lowercased modName, {fileName, extension,
// fullPath, modName}[]> -- keyed by MOD (2026-08-24, merge-step1-real-files-not-json-snapshot,
// previously keyed by plugin filename), since scanCollectionPlugins now needs "every real file this
// mod contains", not "which mod does this one already-known filename belong to". An array per
// modName since two different staging folders can normalize to the identical stripped name (e.g. an
// old/new version of the same mod both still present during an update) -- their files are simply
// pooled under the one key, same "err toward showing more real candidates" approach the old
// per-filename Map used.
function walkStagingForPlugins(stagingDir) {
    const byModName = new Map();
    let folders;
    try {
        folders = fs.readdirSync(stagingDir, { withFileTypes: true }).filter((e) => e.isDirectory());
    } catch (err) {
        throw new Error(`Could not read staging directory "${stagingDir}": ${err.message}`);
    }
    for (const folder of folders) {
        const modDir = path.join(stagingDir, folder.name);
        if (fs.existsSync(path.join(modDir, 'collection.json'))) continue; // a collection's own folder, not a mod
        const modName = stripDownloadNameSuffix(folder.name);
        const key = modName.toLowerCase();
        const list = byModName.get(key) || [];
        for (const f of walkOneModFolder(modDir)) list.push({ ...f, modName });
        if (list.length) byModName.set(key, list);
    }
    return byModName;
}

// ESLifier's own output folder is a personal, LOCAL deploy-time tool -- it replaces files that belong
// to OTHER mods (which in turn belong to real collections), but is never itself a declared member mod
// of any collection.json (confirmed real, director 2026-08-24: "Gate To Sovngarde definitely has
// files in ESLifier Output" -- yet ESLifier Output appears in zero of the 31 installed collections'
// own `mods[]` arrays). So unlike every other mod, it can never be reached through
// scanCollectionPlugins' own collection-membership matching, no matter which collection is chosen --
// by design, per the director's own call: "it should be checked regardless of what collection you
// choose in the picker." Returns [{fileName, extension, modName, collectionModId: null,
// collectionName: 'ESLifier Output', fullPath}] -- collectionModId/collectionName deliberately don't
// name any real chosen collection (these files aren't really FROM one); collectionModId is never
// actually read anywhere downstream (grepped web/public/merge-app.js and every merge runner/worker),
// so `null` here is safe. Returns [] if the folder isn't configured or doesn't exist.
//
// allowedFileNamesLower (2026-08-24, merge-eslifier-scope-to-chosen-collections -- a real bug fix,
// not part of the original feature) -- a Set of lowercased filenames, always the CHOSEN collections'
// own real scanCollectionPlugins() result. "Checked regardless of which collection is chosen" (the
// director's own words above) always meant "don't gate this on collection MEMBERSHIP the way a real
// mod would be" -- it never meant "show every file that happens to exist in this folder regardless of
// what's actually picked". Confirmed real, live bug: 363 files shown for a chosen collection with
// exactly ONE real ESLifier-replaced mod, because this had no awareness of the current selection at
// all. A file only belongs here now if its name is a real replacement for something IN the current
// pick, matching the feature's own original intent.
function scanEslifierOutputPlugins(eslifierOutputDirAbs, allowedFileNamesLower) {
    if (!eslifierOutputDirAbs || !fs.existsSync(eslifierOutputDirAbs)) return [];
    return walkOneModFolder(eslifierOutputDirAbs)
        .filter((f) => allowedFileNamesLower.has(f.fileName.toLowerCase()))
        .map((f) => ({
            ...f, modName: 'ESLifier Output', collectionModId: null, collectionName: 'ESLifier Output',
        }));
}

// Given the CHOSEN collections (each { modId, name, collectionJsonPath }), returns every plugin
// file that belongs to any of them: [{ fileName, extension, modName, collectionModId,
// collectionName, fullPath }]. A plugin genuinely shared by two chosen collections appears once per
// collection (each is a distinct pick from the user's perspective). A collection member mod that
// isn't actually found anywhere in staging (never installed, or installed under an unrecognizably
// different folder name) is silently omitted -- there's nothing to merge if it doesn't exist on disk.
function scanCollectionPlugins(stagingDir, collections) {
    const byModName = walkStagingForPlugins(stagingDir);
    const results = [];
    for (const collection of collections) {
        let collectionJson;
        try {
            collectionJson = JSON.parse(fs.readFileSync(collection.collectionJsonPath, 'utf8'));
        } catch (err) {
            throw new Error(`Could not read "${collection.name}"'s collection.json: ${err.message}`);
        }
        const mods = Array.isArray(collectionJson.mods) ? collectionJson.mods : [];
        // A mod matched by more than one collection.json entry (shouldn't normally happen, but two
        // distinct mods folder-normalizing to the identical stripped name would otherwise double-count
        // that folder's files) never contributes the same real file twice within this one collection.
        const seenFullPaths = new Set();
        for (const mod of mods) {
            if (!mod) continue;
            const matchKey = (mod.source && mod.source.logicalFilename) || mod.name;
            if (!matchKey) continue;
            const files = byModName.get(String(matchKey).toLowerCase());
            if (!files) continue;
            for (const f of files) {
                if (seenFullPaths.has(f.fullPath)) continue;
                seenFullPaths.add(f.fullPath);
                results.push({
                    fileName: f.fileName,
                    extension: f.extension,
                    modName: f.modName,
                    collectionModId: collection.modId,
                    collectionName: collection.name,
                    fullPath: f.fullPath,
                });
            }
        }
    }
    return results;
}

// ---- Masters-dependency check (2026-08-17) -- director's own real repro: merging away a plugin
// other ACTIVE plugins depend on as a master breaks them (zEdit/zMerge already warns about this;
// Merge Plugins didn't, and just failed generically instead). Same reverse-index-building PATTERN
// missing-masters-scan.js's own scanMissingMasters already uses (walk every active plugin's own
// declared masters, group by master) -- adapted here rather than reused directly, since that
// function only ever surfaces MISSING/inactive masters, not "who currently depends on this one".
//
// Scoped to the REAL, currently-active load order (Data folder + Plugins.txt) -- NOT staging or
// whichever collections happen to be chosen in Merge Plugins' own Step 0 picker. This matters:
// zEdit's own warning is about the real, live load order (exactly what a merged plugin will
// actually replace), and a dependent plugin can easily belong to a totally different collection
// than the one being merged from (confirmed real in the director's own repro).
//
// Returns Map<lowercased master filename, [{ fileName, resolvedItem }]> -- resolvedItem is the
// dependent's own mergeable {fileName, extension, modName, collectionModId, collectionName,
// fullPath} if it could be resolved back to a real staging location across ALL installed
// collections (needed so "Include them in the merge" has something real to add to the cart),
// or `null` if it couldn't be (e.g. a manually-installed loose file with no collection.json entry
// anywhere -- shown in the warning either way, just not auto-includable).
function computeMasterDependents(dataDir, pluginsTxtPath, stagingDir, allCollections) {
    const filesOnDisk = scanDataFolder(dataDir);
    const pluginsTxt = readPluginsTxt(pluginsTxtPath);
    const active = computeActiveSet(filesOnDisk, pluginsTxt);

    // Resolves a bare filename back to a real, mergeable staging item -- built ONCE across every
    // installed collection (not just the ones currently chosen in Step 0), first match wins (a
    // plugin genuinely shared by two collections resolves the same way regardless of which one).
    const resolvableByFileName = new Map();
    for (const item of scanCollectionPlugins(stagingDir, allCollections)) {
        const key = item.fileName.toLowerCase();
        if (!resolvableByFileName.has(key)) resolvableByFileName.set(key, item);
    }

    const dependentsByMaster = new Map();
    for (const [key, info] of filesOnDisk) {
        if (!active.has(key)) continue;
        let header;
        try {
            header = readPluginHeader(path.join(dataDir, info.actualFileName));
        } catch {
            continue; // unreadable file -- skip rather than fail the whole scan over one bad plugin
        }
        if (!header || header.compressed || !header.masters || header.masters.length === 0) continue;

        for (const master of header.masters) {
            const mKey = master.toLowerCase();
            if (mKey === key) continue; // shouldn't happen, but guard against a self-referential master
            if (!dependentsByMaster.has(mKey)) dependentsByMaster.set(mKey, []);
            dependentsByMaster.get(mKey).push({
                fileName: info.actualFileName,
                resolvedItem: resolvableByFileName.get(key) || null,
            });
        }
    }
    for (const list of dependentsByMaster.values()) list.sort((a, b) => a.fileName.localeCompare(b.fileName));
    return dependentsByMaster;
}

// ---- Helper-first mod attribution (2026-08-24) -------------------------------------------------
// scanCollectionPlugins' own modName is a GUESS: stripDownloadNameSuffix(folder.name), derived
// purely from the staging folder's own name. Usually right, but it can be wrong for a standalone
// (non-Vortex-managed) install or an oddly-renamed folder -- Vortex's own live
// state.persistent.mods knows the REAL mod name regardless of what the folder is called.
//
// Deliberately NOT folded into scanCollectionPlugins/walkStagingForPlugins above, and does not
// re-walk staging -- different source, different confidence, kept as two clean, independent paths
// per the task's own instruction, joined only by a thin post-processing step here. The file walk
// stays the untouched fallback; this only OVERRIDES modName on top of its output when a live Helper
// answer for that exact staging folder exists.

// installationPath -> resolved live name, built once from one getAllMods() call. Name resolution
// mirrors lib/build-mod-from-vortex-state.js's own shapeMod convention exactly (customFileName first,
// logicalFileName fallback) -- same live fields, same precedence, so this can never disagree with
// how every other Helper-attributed name in this app is derived.
function buildHelperModNameIndex(helperMods) {
    const index = new Map();
    if (!helperMods || typeof helperMods !== 'object') return index;
    for (const mod of Object.values(helperMods)) {
        if (!mod || !mod.installationPath) continue;
        const attrs = mod.attributes || {};
        const name = attrs.customFileName || attrs.logicalFileName;
        if (name) index.set(mod.installationPath, name);
    }
    return index;
}

// Applies buildHelperModNameIndex's own result on top of scanCollectionPlugins' output. Each
// staging folder name is recovered from the item's own fullPath (the first path segment under
// stagingDir) rather than re-walked -- scanCollectionPlugins already did the one real filesystem
// pass. `modNameSource` is the explicit "which one answered" outcome the task asked for: 'helper'
// when Vortex's own live state supplied the name, 'staging' when the file-derived guess was kept
// (either because the Helper is unavailable -- helperModNameIndex is then empty -- or because this
// particular folder has no live Helper record, e.g. a manually-dropped-in mod Vortex never
// registered).
function attributeWithHelperNames(items, stagingDir, helperModNameIndex) {
    return items.map((item) => {
        if (helperModNameIndex && helperModNameIndex.size > 0) {
            const rel = path.relative(stagingDir, item.fullPath);
            const folderName = rel.split(path.sep)[0];
            const helperName = helperModNameIndex.get(folderName);
            if (helperName) return { ...item, modName: helperName, modNameSource: 'helper' };
        }
        return { ...item, modNameSource: 'staging' };
    });
}

module.exports = {
    scanCollectionPlugins, scanEslifierOutputPlugins, computeMasterDependents, PLUGIN_EXTENSIONS,
    buildHelperModNameIndex, attributeWithHelperNames,
};
