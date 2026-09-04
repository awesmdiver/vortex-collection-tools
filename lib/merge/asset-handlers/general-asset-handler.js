'use strict';
// Port of zedit-revised's own Runners/assetHandlers/generalAssetHandler.js -- copies whatever is
// left over in each source mod's own folder once every OTHER handler's own exclusion rules
// (findGeneralAssets, see lib/merge/asset-helpers.js) have filtered out plugins/archives/BSLs,
// meta.ini, translations, xEdit backups, FOMOD content, screenshots, and Papyrus source.
//
// sortModFolders substitute: real zMerge sorts each mod's own folder by the user's live MO2/Vortex
// mod-list ORDER (mergeIntegrationService.js's own sortModFolders, which needs a running mod
// manager's own priority list -- not portable here, same "keep our resolver" call the port spec
// already makes for plugin.dataFolder itself, spec §6.2). When two source mods' own folders both
// contain a same-named general asset, whichever gets copied LAST wins (copyAsset always overwrites)
// -- ours sorts by each folder's OWNING plugin's own ascending game load order instead, which is the
// one true priority signal this engine already has and needs no external mod-manager state: a
// later-loading plugin's own assets win, matching how the game itself resolves loose-file priority.
const { findGeneralAssets } = require('../asset-helpers');

function getPluginFolders(merge) {
    const folders = {};
    for (const plugin of merge.plugins) {
        const folder = plugin.dataFolder;
        if (!folders[folder]) folders[folder] = [];
        folders[folder].push(plugin.filename);
    }
    return folders;
}

// Load-order substitute for sortModFolders -- see this file's own header. merge.plugins is already
// in ascending game-load order (mirrors storePluginHandles' own sortOnKey('loadOrder'), same as
// lib/merge-v2-worker.js's sortedItems), so the first plugin to introduce a given folder key fixes
// that folder's own rank.
function sortModFolders(folderKeys, merge) {
    const rank = new Map();
    merge.plugins.forEach((p, i) => { if (!rank.has(p.dataFolder)) rank.set(p.dataFolder, i); });
    return folderKeys.slice().sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0));
}

function getGeneralAssets(folder, merge) {
    const folderLen = folder.length;
    return findGeneralAssets(folder, merge).map((p) => ({ filePath: p.slice(folderLen) }));
}

function register(assetService, { assetHelpers, gameDataDir, log }) {
    assetService.addHandler({
        label: 'General Assets',
        priority: 1,
        get(merge) {
            const folders = getPluginFolders(merge);
            const modFolders = sortModFolders(Object.keys(folders), merge);
            for (const folder of modFolders) {
                if (folder === gameDataDir) continue; // a plugin living straight in Data has nothing "extra" of its own to copy
                const plugins = folders[folder];
                const assets = getGeneralAssets(folder, merge);
                if (assets.length === 0) continue;
                merge.generalAssets.push({ folder, plugins, assets });
            }
        },
        handle(merge) {
            if (!merge.copyGeneralAssets || !merge.generalAssets.length) return;
            if (log) log('Handling General Assets');
            for (const entry of merge.generalAssets) {
                for (const asset of entry.assets) {
                    assetHelpers.copyAsset({ folder: entry.folder, filePath: asset.filePath }, merge, null, true);
                }
            }
        },
    });
}

module.exports = { register };
