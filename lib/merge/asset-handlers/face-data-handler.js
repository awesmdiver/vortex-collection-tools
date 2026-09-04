'use strict';
// Port of zedit-revised's own Runners/assetHandlers/faceDataHandler.js -- NPC facegen mesh/texture
// files (meshes\actors\character\facegendata\facegeom\<plugin>\..., textures\...\facetint\...),
// useGameDataFolder (see billboard-handler.js's own header for why). The real source also defines
// getFaceDataNpc (resolving a facegen filename's own hex basename back to the owning NPC_ record's
// display name, via `GetFileLoadOrder(plugin) * 0x1000000 + <hex basename>` -- the exact computation
// docs/plans/2026-08-24-merge-port-spec.md's own "Handling asset files" section calls out) but its
// one call site is commented out in the actual shipped handler -- dead code, not ported here for the
// same reason voiceDataHandler's own dialogue lookup isn't.

const faceGeomPath = 'meshes\\actors\\character\\facegendata\\facegeom\\';
const faceTintPath = 'textures\\actors\\character\\facegendata\\facetint\\';
const faceDataExpr = /([0-9A-F]{8})\.(nif|dds)/i;

function findFaceDataFiles(assetHelpers, plugin, folder) {
    const sliceLen = folder.length;
    return [
        ...assetHelpers.findGameAssets(plugin, folder, faceTintPath + plugin, '*'),
        ...assetHelpers.findGameAssets(plugin, folder, faceGeomPath + plugin, '*'),
    ].map((filePath) => ({ filePath: filePath.slice(sliceLen) }));
}

function register(assetService, { assetHelpers, log }) {
    assetService.addHandler({
        label: 'Face Data Files',
        priority: 0,
        get(merge) {
            assetService.forEachPlugin(merge, (plugin, folder) => {
                const assets = findFaceDataFiles(assetHelpers, plugin, folder);
                if (assets.length === 0) return;
                merge.faceData.push({ plugin, folder, assets });
            }, { useGameDataFolder: true });
        },
        handle(merge) {
            if (!merge.handleFaceData || !merge.faceData.length) return;
            if (log) log('Handling Face Data Files');
            for (const entry of merge.faceData) {
                for (const asset of entry.assets) {
                    assetHelpers.copyAsset({ plugin: entry.plugin, folder: entry.folder, filePath: asset.filePath }, merge, faceDataExpr);
                }
            }
        },
    });
}

module.exports = { register };
