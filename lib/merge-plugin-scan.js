'use strict';
// Merge Plugins (The Forge) -- plugin discovery. Pure filesystem reads, no xelib involved (xelib
// only comes in for lib/merge-engine.js's actual load/analyze/merge work). See TECHNICAL.md's
// "Merge engine" section for the full design writeup.
//
// The problem this solves: a collection's collection.json lists which plugin FILENAMES belong to
// it (its own `plugins: [{name, enabled}]` array), but doesn't say which MOD FOLDER each one
// physically lives in -- that requires cross-referencing against the real staging directory.
// Precisely resolving collection.json's `mods[]` entries to their real staging folder names (the
// way lib/rebuild-mod.js does) needs Vortex's own live state (a `knownVortexModId`), which is a
// much heavier dependency than a read-only plugin search needs. Instead, this does ONE plain
// filesystem walk of the whole staging directory (same technique as
// lib/missing-masters-scan.js's buildStagingModNameIndex, confirmed fast there: "~150ms for a full
// pass" against a real ~4550-folder staging directory) and matches by FILENAME against each chosen
// collection's own authoritative `plugins` list -- no Vortex-state dependency at all.

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

// One pass over stagingDir's immediate subfolders, recording every plugin file found at each mod
// folder's own root or one level into a "Data" subfolder (same one-level-deep convention as
// buildStagingModNameIndex, for the same real reason -- some mod authors ship an on/off-format
// choice with the real payload nested under "data\"). Skips any folder that itself has a
// collection.json (a collection's own staging folder, not a mod's) so a collection is never
// mistaken for one of its own member mods. Returns Map<lowercased filename, {fullPath, modName}[]>
// -- an array per filename since two unrelated mods can coincidentally ship an identically-named
// plugin (confirmed real-world elsewhere in this app, see missing-masters-scan.js's own notes).
function walkStagingForPlugins(stagingDir) {
    const byFileName = new Map();
    let folders;
    try {
        folders = fs.readdirSync(stagingDir, { withFileTypes: true }).filter((e) => e.isDirectory());
    } catch (err) {
        throw new Error(`Could not read staging directory "${stagingDir}": ${err.message}`);
    }
    const record = (fileName, fullPath, modName) => {
        const key = fileName.toLowerCase();
        const list = byFileName.get(key) || [];
        list.push({ fullPath, modName });
        byFileName.set(key, list);
    };
    for (const folder of folders) {
        const modDir = path.join(stagingDir, folder.name);
        if (fs.existsSync(path.join(modDir, 'collection.json'))) continue; // a collection's own folder, not a mod
        let entries;
        try {
            entries = fs.readdirSync(modDir, { withFileTypes: true });
        } catch {
            continue; // unreadable subfolder -- skip it, don't fail the whole scan over one mod
        }
        const modName = stripDownloadNameSuffix(folder.name);
        for (const entry of entries) {
            if (entry.isFile() && hasPluginExtension(entry.name)) {
                record(entry.name, path.join(modDir, entry.name), modName);
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
                    record(entry.name, path.join(modDir, dataDirEntry.name, entry.name), modName);
                }
            }
        }
    }
    return byFileName;
}

// Given the CHOSEN collections (each { modId, name, collectionJsonPath }), returns every plugin
// file that belongs to any of them: [{ fileName, extension, modName, collectionModId,
// collectionName, fullPath }]. A plugin genuinely shared by two chosen collections appears once per
// collection (each is a distinct pick from the user's perspective). A plugin a collection.json
// lists but that isn't actually found anywhere in staging (never installed, or installed under a
// different name) is silently omitted -- there's nothing to merge if it doesn't exist on disk.
function scanCollectionPlugins(stagingDir, collections) {
    const stagingIndex = walkStagingForPlugins(stagingDir);
    const results = [];
    for (const collection of collections) {
        let collectionJson;
        try {
            collectionJson = JSON.parse(fs.readFileSync(collection.collectionJsonPath, 'utf8'));
        } catch (err) {
            throw new Error(`Could not read "${collection.name}"'s collection.json: ${err.message}`);
        }
        const pluginNames = Array.isArray(collectionJson.plugins) ? collectionJson.plugins : [];
        for (const p of pluginNames) {
            if (!p || !p.name) continue;
            const matches = stagingIndex.get(p.name.toLowerCase());
            if (!matches) continue;
            for (const m of matches) {
                results.push({
                    fileName: p.name,
                    extension: path.extname(p.name).toLowerCase(),
                    modName: m.modName,
                    collectionModId: collection.modId,
                    collectionName: collection.name,
                    fullPath: m.fullPath,
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

module.exports = { scanCollectionPlugins, computeMasterDependents, PLUGIN_EXTENSIONS };
