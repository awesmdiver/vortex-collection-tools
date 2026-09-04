'use strict';
// Port of zedit-revised's own Runners/assetHandlers/stringFileHandler.js.
//
// IMPORTANT, confirmed by reading the real source directly: zMerge's own `handle` function for this
// handler is `merge.stringFiles.forEach(asset => { // TODO });` -- a literal no-op. Discovery (the
// `get` phase, finding each plugin's own strings\<plugin>*.{STRINGS,DLSTRINGS,ILSTRINGS} files) is
// fully implemented upstream; the actual copy/rebuild step was never written. This is a real,
// current limitation of the tool this project is porting, not something this port broke or left
// out -- `handleStringFiles: true` is zMerge's own real default (see mergeService.js's own
// newMerge()), and it stays true here for merge.json schema fidelity, but produces the identical
// (zero) effect on both engines. A localized/lstring-flagged plugin's own strings therefore still
// need to be handled by hand after a merge, same as with zMerge itself.
const afs = require('../asset-fs');

function register(assetService, { assetHelpers, log }) {
    assetService.addHandler({
        label: 'String Files',
        priority: 0,
        get(merge) {
            assetService.forEachPlugin(merge, (plugin, folder) => {
                const sliceLen = folder.length;
                for (const filePath of assetHelpers.findGameAssets(plugin, folder, 'strings', `${afs.getFileBase(plugin)}*.?(DL|IL)STRINGS`)) {
                    merge.stringFiles.push({ plugin, filePath: filePath.slice(sliceLen) });
                }
            }, { useGameDataFolder: true });
        },
        handle(merge) {
            if (!merge.handleStringFiles || !merge.stringFiles.length) return;
            // Honest log line (2026-08-25, merge-results-screen-asset-gap) -- was previously just
            // "Handling String Files" with nothing after, which reads as if something happened. This
            // handler is a real, live, current gap (unlike the BSA handler's own buildMergedArchive
            // path, permanently unreachable since nothing ever sets that flag true) -- any merge
            // closure containing an actual localized/lstring plugin hits this. Matches the BSA
            // handler's own "SKIPPED: <why>" phrasing so both dead-end handlers read the same way in
            // the log. Deliberately still does nothing -- matches zMerge's own real `// TODO`, see
            // this file's own header.
            if (log) log(`Handling String Files -- SKIPPED: rebuilding merged .STRINGS/.DLSTRINGS/.ILSTRINGS files is not implemented (matches zMerge's own real gap, see this handler's own header). ${merge.stringFiles.length} file(s) affected: ${merge.stringFiles.map((f) => f.filePath).join(', ')}`);
        },
    });
}

module.exports = { register };
