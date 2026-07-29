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

module.exports = { scanCollectionPlugins, PLUGIN_EXTENSIONS };
