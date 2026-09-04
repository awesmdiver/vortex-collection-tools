'use strict';
// Port of zedit-revised's own Runners/assetHandlers/iniFileHandler.js -- each source plugin's own
// <PluginBase>.ini (an SkyUI-MCM-style per-plugin config file), useGameDataFolder (see
// billboard-handler.js's own header). A single INI just gets copied; more than one gets MERGED via
// the real `ini-api` package (MIT, matortheeternal -- the SAME real library zMerge's own
// package.json pins, `ini-api: ^1.0.0`) into one INI for the merged plugin.

const path = require('path');
const { Ini } = require('ini-api');
const afs = require('../asset-fs');

function getFilePath(asset) {
    return `${asset.folder}\\${asset.filePath}`;
}

function register(assetService, { log }) {
    assetService.addHandler({
        label: 'INI Files',
        priority: 0,
        get(merge) {
            assetService.forEachPlugin(merge, (plugin, folder) => {
                const filename = `${afs.getFileBase(plugin)}.ini`;
                const filePath = folder + filename;
                if (afs.exists(filePath) !== 'file') return;
                merge.iniFiles.push({ plugin, folder, filePath: filename });
            }, { useGameDataFolder: true });
        },
        handle(merge) {
            if (!merge.handleIniFiles || !merge.iniFiles.length) return;
            if (log) log('Handling INI Files');
            const filename = `${afs.getFileBase(merge.filename)}.ini`;
            const newPath = path.join(merge.dataPath, filename);
            if (merge.iniFiles.length === 1) {
                const oldPath = getFilePath(merge.iniFiles[0]);
                if (log) log(`Copying ${oldPath} to ${newPath}`);
                afs.copyFile(oldPath, newPath);
                return;
            }
            const inis = merge.iniFiles.map((asset) => {
                const filePath = getFilePath(asset);
                if (log) log(`Loading ${filePath}`);
                return new Ini(afs.loadTextFile(filePath));
            });
            if (log) log(`Merging ${inis.length} INIs`);
            const mergedIni = Ini.merge(...inis);
            const output = mergedIni.stringify({ removeCommentLines: true, blankLineAfterSection: true });
            if (log) log(`Saving merged INI to ${newPath}`);
            afs.saveTextFile(newPath, output);
        },
    });
}

module.exports = { register };
