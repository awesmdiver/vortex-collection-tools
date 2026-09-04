'use strict';
// Port of zedit-revised's own Runners/assetHandlers/bsaHandler.js -- 3 registered handlers sharing
// one file (same as the real source): "Bethesda Archive Files" (priority -1, discovers + Copy/
// Extracts each plugin's own BSA/BA2), "Extracted Files" (priority 100, copies whatever an Extract
// action above pulled out of an archive back into the merge output, minus the excluded-rules
// general-asset filter), and "Merged BSA" (priority 200, builds a brand-new archive from
// merge.dataPath -- see this function's own comment for why it stays a documented no-op here).

const path = require('path');
const afs = require('../asset-fs');
const { findBsaFiles, findGeneralAssets } = require('../asset-helpers');

function hasBsa(archives, bsaPath) {
    return archives.some((a) => a.filePath === bsaPath);
}

function register(assetService, { bsaHelpers, tempDir, log }) {
    const actions = {
        Copy(archive, merge, index, oneArchive) {
            const ext = afs.getFileExt(archive.filePath);
            const base = afs.getFileBase(merge.filename);
            const suffix = oneArchive ? '' : ` - ${index}`;
            const filename = `${base + suffix}.${ext}`;
            const newPath = path.join(merge.dataPath, filename);
            if (log) log(`Copying ${archive.filePath} to ${newPath}`);
            afs.copyFile(archive.filePath, newPath);
        },
        Extract(archive, merge) {
            merge.extracted.push(bsaHelpers.extractArchive(tempDir, archive, log));
        },
    };

    assetService.addHandler({
        label: 'Bethesda Archive Files',
        priority: -1,
        get(merge) {
            assetService.forEachPlugin(merge, (plugin, folder) => {
                for (const bsaPath of findBsaFiles(plugin, folder)) {
                    if (hasBsa(merge.archives, bsaPath)) continue;
                    merge.archives.push({
                        plugin, filePath: bsaPath, filename: afs.getFileName(bsaPath),
                        assets: bsaHelpers.getFiles(bsaPath),
                    });
                }
            }, { useGameDataFolder: true });
        },
        handle(merge) {
            const action = actions[merge.archiveAction];
            if (!merge.archives.length || !action) return;
            if (log) log('Handling Bethesda Archive Files');
            const oneArchive = merge.archives.length === 1;
            merge.archives.forEach((a, n) => action(a, merge, n, oneArchive));
        },
    });

    assetService.addHandler({
        label: 'Extracted Files',
        priority: 100,
        handle(merge) {
            if (!merge.extracted.length) return;
            if (log) log('Handling Extracted Files');
            for (const folder of merge.extracted) {
                const folderLen = folder.length;
                for (const filePath of findGeneralAssets(folder, merge)) {
                    const localPath = filePath.slice(folderLen);
                    const newPath = path.join(merge.dataPath, localPath);
                    if (log) log(`Copying ${filePath} to ${newPath}`);
                    afs.copyFile(filePath, newPath);
                }
            }
        },
    });

    // "Merged BSA" (priority 200) -- real zMerge calls bsaBuilder.buildArchives, which needs
    // xelib.BuildArchive. That export exists in XEditLib.dll (confirmed against zedit-revised's own
    // vendor/xelib binding) but ISN'T present anywhere in our node_modules/xeditlib's raw FFI table
    // at all -- unlike GetContainerFiles (present but unwrapped, see lib/merge/bsa-container.js),
    // this one was never bound into our copy of the package to begin with, so there's no low-risk
    // "load the DLL a second time" path available the way there was for container reads. Gated
    // behind merge.buildMergedArchive, which defaults false (zMerge's own real default -- see
    // lib/merge-v2-worker.js's writeArtifacts) and isn't changed by this task, so this genuinely
    // never fires today; a real fix needs either an upstream xeditlib PR or a maintained local fork.
    assetService.addHandler({
        label: 'Merged BSA',
        priority: 200,
        handle(merge) {
            if (!merge.buildMergedArchive) return;
            if (log) log('Building Merged Archives -- SKIPPED: BuildArchive is not exposed by this project\'s xeditlib binding (see this handler\'s own comment).');
        },
    });
}

module.exports = { register };
