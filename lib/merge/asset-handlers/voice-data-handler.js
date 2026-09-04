'use strict';
// Port of zedit-revised's own Runners/assetHandlers/voiceDataHandler.js -- sound\voice\<plugin>\...
// files, useGameDataFolder (see billboard-handler.js's own header for why). The real source also
// defines getVoiceDataDialogue (reading a DIAL/INFO record's own NAM1 response text via the voice
// filename's embedded FormID) but its one call site is commented out in the actual shipped
// handler -- dead code, not ported here for the same reason.

const voicePath = 'sound\\voice\\';
const voiceDataExpr = /_([0-9A-F]{8})_[0-9]\.(fuz|wav)/i;

function getVoiceDataAssets(assetHelpers, plugin, folder) {
    const sliceLen = folder.length;
    return assetHelpers.findGameAssets(plugin, folder, voicePath + plugin, '**/*')
        .map((filePath) => ({ filePath: filePath.slice(sliceLen) }));
}

function register(assetService, { assetHelpers, log }) {
    assetService.addHandler({
        label: 'Voice Data Files',
        priority: 0,
        get(merge) {
            assetService.forEachPlugin(merge, (plugin, folder) => {
                const assets = getVoiceDataAssets(assetHelpers, plugin, folder);
                if (assets.length === 0) return;
                merge.voiceData.push({ plugin, folder, assets });
            }, { useGameDataFolder: true });
        },
        handle(merge) {
            if (!merge.handleVoiceData || !merge.voiceData.length) return;
            if (log) log('Handling Voice Data Files');
            for (const entry of merge.voiceData) {
                for (const asset of entry.assets) {
                    assetHelpers.copyAsset({ plugin: entry.plugin, folder: entry.folder, filePath: asset.filePath }, merge, voiceDataExpr);
                }
            }
        },
    });
}

module.exports = { register };
