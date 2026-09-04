'use strict';
// Port of zedit-revised's own Runners/assetHandlers/mcmTranslationHandler.js -- SkyUI-MCM
// interface\translations\<plugin>*.txt files, useGameDataFolder (see billboard-handler.js's own
// header). Unlike every other handler, this one doesn't just copy assets -- same-language
// translations from every source plugin get concatenated into ONE file for the merged plugin (UCS2,
// leading BOM, "\r\n\r\n"-separated per source), matching how SkyUI itself reads a single combined
// translation file per language.

const path = require('path');
const afs = require('../asset-fs');

const UTF16_MARKER = String.fromCharCode(65279);
const translationPath = 'interface\\translations\\';

function loadTranslations(assetHelpers, merge, translations) {
    for (const entry of merge.translations) {
        for (const asset of entry.assets) {
            const fullPath = assetHelpers.getOldPath({ folder: entry.folder, filePath: asset.filePath });
            const content = afs.loadTextFile(fullPath, 'ucs2').slice(1);
            const baseName = afs.getFileBase(entry.plugin).toLowerCase();
            const language = afs.getFileBase(asset.filePath).toLowerCase().replace(baseName, '');
            translations[language] = Object.prototype.hasOwnProperty.call(translations, language)
                ? `${translations[language]}\r\n\r\n${content}`
                : content;
        }
    }
}

function saveTranslations(merge, translations, log) {
    const basePath = path.join(merge.dataPath, 'interface', 'translations');
    const baseName = afs.getFileBase(merge.filename).toLowerCase();
    for (const language of Object.keys(translations)) {
        const filePath = path.join(basePath, `${baseName}${language}.txt`);
        const content = UTF16_MARKER + translations[language];
        if (log) log(`Saving ${language} translation to ${filePath}`);
        afs.saveTextFile(filePath, content, 'ucs2');
    }
}

function findMcmTranslations(assetHelpers, plugin, folder) {
    const sliceLen = folder.length;
    const expr = `${afs.getFileBase(plugin)}*.txt`;
    return assetHelpers.findGameAssets(plugin, folder, translationPath, expr).map((filePath) => ({ filePath: filePath.slice(sliceLen) }));
}

function register(assetService, { assetHelpers, log }) {
    assetService.addHandler({
        label: 'MCM Translation Files',
        priority: 0,
        get(merge) {
            assetService.forEachPlugin(merge, (plugin, folder) => {
                const assets = findMcmTranslations(assetHelpers, plugin, folder);
                if (assets.length === 0) return;
                merge.translations.push({ plugin, folder, assets });
            }, { useGameDataFolder: true });
        },
        handle(merge) {
            if (!merge.handleTranslations || !merge.translations.length) return;
            if (log) log('Handling MCM Translation Files');
            const translations = {};
            loadTranslations(assetHelpers, merge, translations);
            saveTranslations(merge, translations, log);
        },
    });
}

module.exports = { register };
