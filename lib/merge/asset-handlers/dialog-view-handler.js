'use strict';
// Port of zedit-revised's own Runners/assetHandlers/dialogViewHandler.js -- DialogueViews\<hex
// FormID>.xml layout files for each DLVW (Dialog View) record, rewriting any embedded FormID-hex
// prefix inside a <ToolTip> element via this asset's own source plugin's fidReplacer. UNLIKE every
// other handler above, this one does NOT pass useGameDataFolder -- DLVW records/their own XML
// layouts are looked up per SOURCE PLUGIN's own individual mod folder (assetService.forEachPlugin's
// default), not the shared game Data tree.
//
// XML handling: real zMerge parses+rewrites+reserializes via the browser's own DOMParser/
// XMLSerializer (Electron-only APIs). This project has no XML DOM library and Dialog Views are a
// genuinely rare feature (zero DLVW records in any real repro run so far) -- rather than add a new
// dependency for a single-element, single-attribute transform, this rewrites the <ToolTip>...
// </ToolTip> element's own inner text directly via regex, which is a strictly narrower and more
// faithful change to the REST of the file than a full parse+reserialize would be anyway (a DOM
// roundtrip can itself alter attribute quoting/self-closing-tag formatting zMerge's own real output
// never touches). Flagged here as a deliberate, documented divergence from the exact zMerge
// mechanism, not from its observable RESULT.

const afs = require('../asset-fs');

const dialogViewPath = 'DialogueViews';
const dialogViewExpr = /^([0-9A-F]{8})\.xml$/i;
const tooltipExpr = /^([0-9A-F]{8})/i;
const TOOLTIP_TAG = /<ToolTip\b[^>]*>([\s\S]*?)<\/ToolTip>/g;

// zMerge's own `xelib.GetHexFormID(record, true)` here means (native=true, local=false) in ITS OWN
// wrapper's terms (zedit-revised/vendor/xelib/src/js/records.js:26-29) -- the full, unmasked,
// 8-hex-uppercase current FormID, NOT the 6-hex local one recordMergingService.js's own `getFid`
// helper produces elsewhere (that one calls GetHexFormID with the OPPOSITE flags,
// `(rec, false, true)`). xelib.GetHexFormID isn't exposed by our own wrapper at all (grep confirms),
// so this reproduces it directly: getFormID(rec, false) is this project's own already-proven "give
// me the full, unmasked FormID" call (lib/merge-v2-worker.js's copyRecords uses the exact same call
// for its GLOBAL dedupe key), just hex-formatted to 8 digits here instead of masked to 6.
function hex8(id) {
    return (id >>> 0).toString(16).toUpperCase().padStart(8, '0');
}

function getPluginHandle(pluginHandles, filename) {
    return pluginHandles.get(filename.toLowerCase()) || null;
}

// dialogViewHandler.js:14-25 -- every DLVW record this source plugin defines, named by its own hex
// FormID (matching the real .xml file's own filename convention).
function getDialogViewsFromPlugin(xelib, pluginFile) {
    const dialogViews = [];
    for (const record of xelib.getRecords(pluginFile, 'DLVW', true)) {
        dialogViews.push({
            record: (() => { try { return xelib.longName(record); } catch { return '(unknown record)'; } })(),
            filename: `${hex8(xelib.getFormID(record, false))}.xml`,
        });
        xelib.release(record);
    }
    return dialogViews;
}

function getDialogViewsFromDisk(assetHelpers, plugin, folder, gameDataDir) {
    if (folder === gameDataDir) return [];
    const sliceLen = folder.length;
    return assetHelpers.findGameAssets(plugin, folder, dialogViewPath, '*.xml')
        .map((filePath) => ({ filename: afs.getFileName(filePath), filePath: filePath.slice(sliceLen) }));
}

function findDialogViews(xelib, assetHelpers, pluginHandles, plugin, folder, gameDataDir) {
    const pluginFile = getPluginHandle(pluginHandles, plugin);
    const onDisk = getDialogViewsFromDisk(assetHelpers, plugin, folder, gameDataDir);
    if (!pluginFile) return onDisk;
    return getDialogViewsFromPlugin(xelib, pluginFile)
        .map((dv) => {
            const match = onDisk.find((f) => f.filename.toLowerCase() === dv.filename.toLowerCase());
            if (!match) return null;
            return { ...dv, filePath: match.filePath };
        })
        .filter(Boolean);
}

function rewriteTooltips(text, fidReplacerFn) {
    return text.replace(TOOLTIP_TAG, (whole, inner) => whole.replace(inner, inner.replace(tooltipExpr, fidReplacerFn)));
}

function handleDialogView(assetHelpers, asset, merge, log) {
    const oldPath = assetHelpers.getOldPath(asset);
    const newPath = assetHelpers.getNewPath(asset, merge, dialogViewExpr, true);
    if (log) log(`Rewriting ${oldPath}, saving to ${newPath}`);
    const text = afs.loadTextFile(oldPath);
    afs.saveTextFile(newPath, rewriteTooltips(text, merge.fidReplacer[asset.plugin]));
}

function register(assetService, { assetHelpers, xelib, gameDataDir, log }) {
    assetService.addHandler({
        label: 'Dialog Views',
        priority: 0,
        get(merge) {
            const pluginHandles = new Map();
            for (const p of merge.plugins) {
                try { pluginHandles.set(p.filename.toLowerCase(), xelib.fileByName(p.filename)); } catch { /* not loaded in this session */ }
            }
            assetService.forEachPlugin(merge, (plugin, folder) => {
                const assets = findDialogViews(xelib, assetHelpers, pluginHandles, plugin, folder, gameDataDir);
                if (assets.length === 0) return;
                merge.dialogViews.push({ plugin, folder, assets });
            });
        },
        handle(merge) {
            if (!merge.handleDialogViews || !merge.dialogViews.length) return;
            if (log) log('Handling Dialog View Files');
            for (const entry of merge.dialogViews) {
                for (const asset of entry.assets) {
                    handleDialogView(assetHelpers, { plugin: entry.plugin, folder: entry.folder, filePath: asset.filePath }, merge, log);
                }
            }
        },
    });
}

module.exports = { register };
