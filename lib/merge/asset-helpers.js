'use strict';
// Port of zedit-revised's own src/javascripts/Services/merge/assetHelpers.js -- the shared
// find/copy primitives every one of the 9 asset handlers builds on. `merge` here is our own plain
// object built in lib/merge/assets.js, not zMerge's Angular-service-backed one -- see that file's
// own header for the exact shape (merge.plugins[].{filename,dataFolder}, merge.dataPath,
// merge.filename, merge.fidReplacer[pluginFilename]). Function signatures below match
// assetHelpers.js's own one-for-one (same params, same order) rather than folding `merge` into a
// closure, so this stays a straightforward diff against the real source.

const { Minimatch } = require('minimatch');
const afs = require('./asset-fs');

// assetHelpers.js:5-6
const archiveExpr = /^[^\\/]+\.(bsa|ba2)[\\/]/i;
const pluginExpr = /[^\\/]+\.es[plm][\\/]/i;

function mergeHasPlugin(merge, filename) {
    const lc = filename.toLowerCase();
    return merge.plugins.some((p) => p.filename.toLowerCase() === lc);
}

// assetHelpers.js:16-26 -- the exclusion rule list findGeneralAssets filters OUT of a mod's own
// folder: every plugin/archive/BSL itself, meta.ini, existing translations, xEdit backups, FOMOD
// installer content, screenshots, and Papyrus source -- none of that is a "general asset" a merge
// needs to duplicate.
function getRules(merge) {
    const rules = [
        '**/*.@(esp|esm|bsa|ba2|bsl)', 'meta.ini',
        'interface/translations/*.txt', 'TES5Edit Backups/**/*',
        'fomod/**/*', 'screenshot?(s)/**/*', 'scripts/source/*.psc',
    ];
    for (const plugin of merge.plugins) {
        const basePluginName = afs.getFileBase(plugin.filename);
        rules.push(`**/${afs.escapePattern(basePluginName)}.@(seq|ini)`);
        rules.push(`**/${afs.escapePattern(plugin.filename)}/**/*`);
    }
    return rules;
}

// assetHelpers.js:29-38
function findGeneralAssets(folder, merge) {
    const basePattern = afs.escapePattern(afs.toForwardSlash(folder));
    const exclusions = getRules(merge).map((rule) => new Minimatch(`${basePattern}/${rule}`, { nocase: true }));
    return afs.getFiles(folder, { matching: '**/*' }).filter((filePath) => !exclusions.some((expr) => expr.match(filePath)));
}

// assetHelpers.js:40-45 -- every top-level `<pluginBaseName>*.bsa`/`.ba2` sitting next to the
// plugin in its own mod folder (NOT recursive -- an archive belonging to plugin X never lives in a
// subfolder of X's own mod).
function findBsaFiles(plugin, folder) {
    return afs.getFiles(folder, { matching: `${afs.escapePattern(afs.getFileBase(plugin))}*.@(bsa|ba2)`, recursive: false })
        .map((p) => p.replace(/\//g, '\\'));
}

// bsaHelpers/tempDir/log are injected once per merge run (not per call, and not globals) -- see
// lib/merge/assets.js's own construction of this. Returns the same 3 functions zMerge's own
// assetHelpers exposes for archive-aware copying (getOldPath/getNewPath/copyAsset); findGameAssets/
// findBsaFiles/findGeneralAssets don't need bsaHelpers' extraction, only its `find`.
function makeAssetHelpers({ bsaHelpers, tempDir, log }) {
    // assetHelpers.js:47-50 -- a BSA-packed asset gets extracted to a real temp path first (bsaHelpers
    // handles its own extraction cache); a loose asset's own real path is used as-is.
    function getOldPath(asset) {
        return bsaHelpers.extractAsset(tempDir, asset, log) || (asset.folder + asset.filePath);
    }

    // assetHelpers.js:52-61 -- strips a leading "<archive>.bsa\" segment (only ever matches an
    // asset whose own filePath still carries the container marker after extraction), then -- unless
    // skipFn -- rewrites a "<sourcePlugin>.esp\" folder segment to the MERGED file's own name (so a
    // per-plugin asset subfolder collapses onto the merged plugin's), then -- if `expr` was given --
    // rewrites any embedded FormID-hex substring the pattern matches via this asset's own source
    // plugin's fidReplacer.
    function getNewPath(asset, merge, expr, skipFn) {
        let newPath = asset.filePath.replace(archiveExpr, '');
        if (!skipFn) {
            newPath = newPath.replace(pluginExpr, (match) => {
                const plugin = match.slice(0, -1);
                if (!mergeHasPlugin(merge, plugin)) return match;
                return merge.filename + '\\';
            });
        }
        const finalRel = !expr ? newPath : newPath.replace(expr, merge.fidReplacer[asset.plugin]);
        return `${merge.dataPath}\\${finalRel}`;
    }

    // assetHelpers.js:63-68
    function copyAsset(asset, merge, expr, skipFn = false) {
        const oldPath = getOldPath(asset);
        const newPath = getNewPath(asset, merge, expr, skipFn);
        if (log) log(`Copying ${oldPath} to ${newPath}`);
        afs.copyFile(oldPath, newPath);
    }

    // assetHelpers.js:70-81 -- loose files under `folder+subfolder` matching `expr`, PLUS the same
    // pattern's matches inside every BSA/BA2 this plugin owns (an asset can legitimately live in
    // either place).
    function findGameAssets(plugin, folder, subfolder, expr) {
        const searchDir = folder + subfolder;
        const assets = afs.getFiles(searchDir, { matching: expr, ignoreCase: true });
        const baseExpr = afs.escapePattern(afs.toForwardSlash(subfolder));
        const fullExpr = `${baseExpr}/${expr}`;
        for (const bsaPath of findBsaFiles(plugin, folder)) {
            for (const assetPath of bsaHelpers.find(bsaPath, fullExpr)) {
                assets.push(`${bsaPath}\\${assetPath}`);
            }
        }
        return assets;
    }

    return { getOldPath, getNewPath, copyAsset, findGameAssets };
}

module.exports = { makeAssetHelpers, findGeneralAssets, findBsaFiles, mergeHasPlugin };
