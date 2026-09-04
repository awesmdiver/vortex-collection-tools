'use strict';
// Port of zedit-revised's own src/javascripts/Services/merge/mergeAssetService.js -- the handler
// registry + fidReplacer/prepareToCopyAssets this project's 9 asset-handlers (lib/merge/
// asset-handlers/*.js) all register into. `merge` is our own plain object (built in
// lib/merge-v2-worker.js), not zMerge's Angular-service-backed one -- see that file's own header
// for the exact shape it builds and hands in here.

// mergeAssetService.js:5-13 -- rewrites an embedded FormID-hex substring (8 hex chars, or a literal
// "xx" prefix + 6 hex, both handled the same way by fid.slice(2)) using THIS asset's own source
// plugin's real renumbering map (merge.fidMap[plugin], the exact same map.json data
// refactorReferences already produces in lib/merge-v2-worker.js). No match in fidMap means this
// FormID was never renumbered (kept its original low 3 bytes) -- left unchanged, same as zMerge's
// own real behavior (see lib/merge/asset-helpers.js's own header for why that's a real, inherited
// limitation of the tool being ported, not something this port introduces).
function fidReplacer(merge, plugin) {
    const fidMap = merge.fidMap[plugin] || {};
    return function (match, fid) {
        const fidKey = fid.slice(2).toUpperCase();
        if (Object.prototype.hasOwnProperty.call(fidMap, fidKey)) {
            return match.replace(fid, `00${fidMap[fidKey]}`);
        }
        return match;
    };
}

// mergeAssetService.js:15-24
function prepareToCopyAssets(merge) {
    merge.dataFolders = {};
    merge.fidReplacer = {};
    for (const plugin of merge.plugins) {
        merge.dataFolders[plugin.filename] = plugin.dataFolder;
        merge.fidReplacer[plugin.filename] = fidReplacer(merge, plugin.filename);
    }
}

// mergeDataService.js:26-40's own clearMergeData -- the 10 per-handler arrays every handler's own
// `get` phase pushes discoveries into.
function initMergeAssetState(merge) {
    Object.assign(merge, {
        archives: [], faceData: [], voiceData: [], billboards: [], stringFiles: [],
        translations: [], iniFiles: [], dialogViews: [], extracted: [], generalAssets: [],
    });
}

// mergeAssetService.js:1-52's own service object -- addHandler/forEachPlugin/getAssets/handleAssets.
function createAssetService() {
    const handlers = [];

    function addHandler(handler) {
        handlers.push(handler);
        handlers.sort((a, b) => a.priority - b.priority);
    }

    // mergeAssetService.js:32-38 -- useGameDataFolder forces EVERY plugin's own search folder to
    // merge.gameDataFolder regardless of that plugin's real mod folder (see
    // lib/merge/asset-handlers/billboard-handler.js's own header for why most handlers need this:
    // voice/facegen/billboard/etc subfolders are named by PLUGIN, so once deployed they live in the
    // shared Data tree no matter which mod folder they were staged from).
    function forEachPlugin(merge, callback, options = {}) {
        const { useGameDataFolder } = options;
        for (const p of merge.plugins) {
            const dataFolder = useGameDataFolder ? merge.gameDataFolder : p.dataFolder;
            callback(p.filename, dataFolder, p.handle);
        }
    }

    // mergeAssetService.js:40-42 -- discovery only, no copying. Real zMerge runs this during PREPARE
    // (mergeBuilder.js:85, well before record-copying even starts); this engine runs it immediately
    // before handleAssets instead (see lib/merge-v2-worker.js's own comment on why that reordering
    // is safe here -- Clean-method source plugins are never mutated by record copying, so discovery
    // can happen at any point without a correctness risk).
    function getAssets(merge) {
        for (const h of handlers) if (h.get) h.get(merge);
    }

    // mergeAssetService.js:44-48
    function handleAssets(merge) {
        prepareToCopyAssets(merge);
        for (const h of handlers) if (h.handle) h.handle(merge);
    }

    return { addHandler, forEachPlugin, getAssets, handleAssets };
}

module.exports = { createAssetService, initMergeAssetState };
