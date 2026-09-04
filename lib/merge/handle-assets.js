'use strict';
// The single integration point lib/merge-v2-worker.js calls for the whole asset-handling phase --
// builds zMerge's own `merge` object shape (mergeDataService.js/mergeService.js's own newMerge()
// fields, populated from what the worker already computed), wires the 9 real handlers
// (lib/merge/asset-handlers/*.js) into a fresh registry, and runs discovery + copy exactly once.
//
// DEFAULT FLAGS (2026-08-25, closes GitHub issue #3's own asset-handling gap): zMerge's own real
// defaults, confirmed straight from source (mergeService.js's own newMerge(), NOT just "what one
// run happened to use") -- handleFaceData/handleVoiceData/handleBillboards/handleStringFiles/
// handleTranslations/handleIniFiles/handleDialogViews: true, copyGeneralAssets: false. Director's
// own instruction: "whatever zMerge produces, we produce too, no restrictions" -- these are now the
// real runtime behavior, not just inert merge.json schema fields the way they were before this
// change (see lib/merge-v2-worker.js's own writeArtifacts, which used to write these same 8 keys as
// permanently-false placeholders).
const fs = require('fs');
const path = require('path');
const xelib = require('xeditlib');
const { createAssetService, initMergeAssetState } = require('./assets');
const { makeAssetHelpers } = require('./asset-helpers');
const { makeBsaHelpers } = require('./bsa-container');
const bsaHandler = require('./asset-handlers/bsa-handler');
const generalAssetHandler = require('./asset-handlers/general-asset-handler');
const billboardHandler = require('./asset-handlers/billboard-handler');
const dialogViewHandler = require('./asset-handlers/dialog-view-handler');
const faceDataHandler = require('./asset-handlers/face-data-handler');
const iniFileHandler = require('./asset-handlers/ini-file-handler');
const mcmTranslationHandler = require('./asset-handlers/mcm-translation-handler');
const stringFileHandler = require('./asset-handlers/string-file-handler');
const voiceDataHandler = require('./asset-handlers/voice-data-handler');

const DEFAULT_FLAGS = {
    archiveAction: 'Extract',
    buildMergedArchive: false,
    handleFaceData: true,
    handleVoiceData: true,
    handleBillboards: true,
    handleStringFiles: true,
    handleTranslations: true,
    handleIniFiles: true,
    handleDialogViews: true,
    copyGeneralAssets: false,
};

// sortedItems: the SAME already-ordered array lib/merge-v2-worker.js's own runMergeV2 builds
// (ascending game load order, chosen items only). fidMap: refactorReferences' own output
// ({pluginFileName: {oldHex6: newHex6}}), reused as-is -- it's already exactly map.json's schema,
// the same data mergeAssetService.js's own fidReplacer needs. outputDir/filename: the merged
// plugin's own real output location (merge.dataPath/merge.filename). gameDataDir: the REAL game
// Data folder (not the sandbox) -- most handlers search here, see billboard-handler.js's own header
// for why. logger: this file's own makeLogger() instance, reused for asset-phase log lines exactly
// like every other phase.
async function handleAssets({ sortedItems, fidMap, outputDir, filename, gameDataDir, logger }) {
    // Trailing separator on dataPath/gameDataFolder -- every real caller below concatenates
    // `folder + subPath` directly (findGameAssets, iniFileHandler's own `folder + filename`, etc.),
    // same as plugin.dataFolder just below.
    const merge = {
        filename,
        dataPath: `${outputDir.replace(/\\/g, '/').replace(/\/$/, '')}`,
        gameDataFolder: gameDataDir ? `${gameDataDir.replace(/\\/g, '/').replace(/\/$/, '')}/` : '',
        fidMap,
        plugins: sortedItems.map((item) => ({
            filename: item.fileName,
            // Trailing separator -- zMerge's own dataFolder always carries one too
            // (mergeDataService.js:59's own `fh.getDirectory(filePath) + '\\'`), since every real
            // caller concatenates `folder + subPath` directly rather than joining.
            dataFolder: `${path.dirname(item.fullPath).replace(/\\/g, '/')}/`,
        })),
        ...DEFAULT_FLAGS,
    };
    initMergeAssetState(merge);

    const log = (msg) => logger.log(msg);
    const tempDir = fs.mkdtempSync(path.join(outputDir, '.vct-merge-assets-'));
    fs.mkdirSync(tempDir, { recursive: true });
    const bsaHelpers = makeBsaHelpers();
    const assetHelpers = makeAssetHelpers({ bsaHelpers, tempDir, log });

    const assetService = createAssetService();
    bsaHandler.register(assetService, { bsaHelpers, tempDir, log });
    generalAssetHandler.register(assetService, { assetHelpers, gameDataDir: merge.gameDataFolder, log });
    billboardHandler.register(assetService, { assetHelpers, log });
    voiceDataHandler.register(assetService, { assetHelpers, log });
    faceDataHandler.register(assetService, { assetHelpers, log });
    iniFileHandler.register(assetService, { log });
    mcmTranslationHandler.register(assetService, { assetHelpers, log });
    stringFileHandler.register(assetService, { assetHelpers, log });
    dialogViewHandler.register(assetService, { assetHelpers, xelib, gameDataDir: merge.gameDataFolder, log });

    try {
        assetService.getAssets(merge);
        assetService.handleAssets(merge);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }

    return { flags: DEFAULT_FLAGS, archives: merge.archives.length, faceData: merge.faceData.length, voiceData: merge.voiceData.length,
        billboards: merge.billboards.length, translations: merge.translations.length, iniFiles: merge.iniFiles.length,
        dialogViews: merge.dialogViews.length, generalAssets: merge.generalAssets.length,
        // stringFiles (2026-08-25, merge-results-screen-asset-gap) -- the one real, live asset-
        // handling gap (string-file-handler.js's own header). Everything else in this summary is a
        // plain activity count; this one specifically means "found but could NOT actually be
        // rebuilt" -- lib/merge-v2-worker.js's own runMergeV2 surfaces it on the results screen when
        // non-zero, see that file's own comment at the handleAssets call site.
        stringFiles: merge.stringFiles.length };
}

module.exports = { handleAssets, DEFAULT_FLAGS };
