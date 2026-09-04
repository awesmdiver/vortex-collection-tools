'use strict';
// Port of zedit-revised's own Runners/assetHandlers/billboardHandler.js -- LOD billboards
// (textures\terrain\lodgen\<plugin>\...), searched in the REAL game Data folder (useGameDataFolder,
// same as bsaHandler/faceDataHandler/voiceDataHandler/iniFileHandler/mcmTranslationHandler/
// stringFileHandler below -- these subfolders are named by PLUGIN, not by mod, so once Vortex has
// deployed, they live in the shared Data tree regardless of which mod folder they came from; only
// dialogViewHandler and generalAssetHandler search each plugin's own individual mod folder).

const billboardPath = 'textures\\terrain\\lodgen\\';
const billboardExpr = /([0-9A-F]{8})\.(dds|txt)/i;

function getBillboardFiles(assetHelpers, plugin, folder) {
    const sliceLen = folder.length;
    return assetHelpers.findGameAssets(plugin, folder, billboardPath + plugin, '*')
        .map((filePath) => ({ filePath: filePath.slice(sliceLen) }));
}

function register(assetService, { assetHelpers, log }) {
    assetService.addHandler({
        label: 'LOD Billboards',
        priority: 0,
        get(merge) {
            assetService.forEachPlugin(merge, (plugin, folder) => {
                const assets = getBillboardFiles(assetHelpers, plugin, folder);
                if (assets.length === 0) return;
                merge.billboards.push({ plugin, folder, assets });
            }, { useGameDataFolder: true });
        },
        handle(merge) {
            if (!merge.handleBillboards || !merge.billboards.length) return;
            if (log) log('Handling LOD Billboards');
            for (const entry of merge.billboards) {
                for (const asset of entry.assets) {
                    assetHelpers.copyAsset({ plugin: entry.plugin, folder: entry.folder, filePath: asset.filePath }, merge, billboardExpr);
                }
            }
        },
    });
}

module.exports = { register };
