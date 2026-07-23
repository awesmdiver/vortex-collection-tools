#!/usr/bin/env node
// Extracts a single Vortex collection mod directly from its archive, replaying the FOMOD choices
// collection.json already recorded (or, for a mod with no recorded choices at all, applying
// Vortex's own generic mod-root-prefix detection -- see lib/simple-installer.js) -- no manual
// re-clicking through any installer wizard, and (deliberately, for this prototype) zero
// interaction with Vortex itself: output goes to a plain folder for comparison against what
// Vortex actually produced.
//
// Usage:
//   node extract-mod.js "<mod name>" [--collection <path>] [--downloads <path>] [--output <dir>]
//     [--folder-name <name>]
//
// Exit codes: 0 = extracted successfully. 1 = the mod's FOMOD uses a feature this prototype
// doesn't parse yet (a top-level always-installed <files> block outside <installSteps>) --
// refuses to produce a silently-incomplete extraction rather than guessing. 2 = any other
// failure (mod not found, archive not locatable, etc). 3 = "Open FOMOD" -- collection.json has no
// recorded choices, and the archive genuinely has a FOMOD wizard with no deterministic default to
// replay; needs manual reinstall through Vortex.

const fs = require('fs');
const path = require('path');

const { loadCollection, findMod } = require('./lib/collection-parser');
const { locateArchive } = require('./lib/archive-locator');
const { findSevenZip, listArchive, extractFile, extractMany } = require('./lib/sevenzip');
const { parseModuleConfigFile, hasUnhandledFeatures } = require('./lib/fomod-parser');
const { resolveChoices } = require('./lib/choice-resolver');
const { findModRoot, hasFomodInstaller } = require('./lib/mod-root');
const { resolveSimpleInstall } = require('./lib/simple-installer');

function parseArgs(argv) {
    const args = {
        collection: 'F:/Mod Extraction/Daughter-of-Coldharbour-SDA-in-GTS-735477-30-1783874181/collection.json',
        downloads: 'F:/Vortex Downloads/skyrimse',
        output: 'F:/Mod Extraction/prototype-output',
        folderName: null, // override for the output subfolder name; default: derived from the archive's own filename
        modName: null,
    };
    const rest = [];
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--collection') args.collection = argv[++i];
        else if (argv[i] === '--downloads') args.downloads = argv[++i];
        else if (argv[i] === '--output') args.output = argv[++i];
        else if (argv[i] === '--folder-name') args.folderName = argv[++i];
        else rest.push(argv[i]);
    }
    args.modName = rest[0];
    return args;
}

// Extracts every resolved {source, destination} file for a mod in ONE 7z call (into a scratch
// dir preserving archive-relative paths), then copies each into its real destination. Copy, not
// move/rename, deliberately -- if a FOMOD ever maps the same archive source to two different
// destinations (two <file> entries sharing a source), a move would make the second one fail with
// the file already gone; a copy handles that safely at negligible extra cost (same-drive local
// copy, not a fresh process spawn). scratchRoot should be on the same drive as modOutputDir so the
// copy stays a fast same-drive operation.
async function installResolvedFiles(sevenZipExe, archivePath, resolvedFiles, modOutputDir, scratchRoot) {
    if (resolvedFiles.length === 0) return;
    fs.mkdirSync(scratchRoot, { recursive: true });
    const scratchDir = fs.mkdtempSync(path.join(scratchRoot, '.sevenzip-scratch-'));
    try {
        await extractMany(sevenZipExe, archivePath, resolvedFiles.map((f) => f.source), scratchDir);
        for (const f of resolvedFiles) {
            const srcPath = path.join(scratchDir, f.source);
            const destFullPath = path.join(modOutputDir, f.destination);
            fs.mkdirSync(path.dirname(destFullPath), { recursive: true });
            fs.copyFileSync(srcPath, destFullPath);
            console.log(`  ${f.source} -> ${f.destination}`);
        }
    } finally {
        fs.rmSync(scratchDir, { recursive: true, force: true });
    }
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!args.modName) {
        console.error('Usage: node extract-mod.js "<mod name>" [--collection <path>] [--downloads <path>] [--output <dir>]');
        process.exit(2);
    }

    const sevenZipExe = findSevenZip();
    const collection = loadCollection(args.collection);
    const mod = findMod(collection, args.modName);
    console.log(`Mod: ${mod.name} (modId ${mod.source.modId})`);

    const archivePath = await locateArchive(args.downloads, mod.source);
    console.log(`Archive: ${archivePath}`);

    // Vortex assigns a mod's staging folder name once, at first install, and never renames it on
    // update -- it just refreshes the folder's CONTENTS in place (confirmed against real Vortex
    // live-state data this session). So the correct output folder name is sometimes NOT the
    // current archive's own filename -- --folder-name lets a caller (rebuild-collection.js, which
    // looks up Vortex's real tracked folder name first) override it explicitly.
    const archiveBaseName = args.folderName || path.basename(archivePath, path.extname(archivePath));
    const modOutputDir = path.join(args.output, archiveBaseName);
    fs.mkdirSync(args.output, { recursive: true });

    if (mod.choices && mod.choices.type === 'fomod') {
        // Needed both to expand any <folder> entries (whole-directory copies) against what's
        // actually in the archive, AND to find the real "mod root" (the folder directly
        // containing fomod\ModuleConfig.xml) -- some archives nest the FOMOD inside one or more
        // extra containing folders instead of putting it at the archive root.
        const archiveEntries = await listArchive(sevenZipExe, archivePath);
        const { configPath, rootPrefix } = findModRoot(archiveEntries);
        if (rootPrefix) console.log(`Mod root inside archive: "${rootPrefix}"`);

        // Peek just the FOMOD config, not the whole archive.
        const scratchDir = fs.mkdtempSync(path.join(args.output, '.fomod-peek-'));
        let parsedFomod;
        try {
            const extractedConfigPath = await extractFile(sevenZipExe, archivePath, configPath, scratchDir);
            parsedFomod = parseModuleConfigFile(extractedConfigPath);
        } finally {
            fs.rmSync(scratchDir, { recursive: true, force: true });
        }

        if (hasUnhandledFeatures(parsedFomod)) {
            console.error(
                `"${mod.name}"'s FOMOD uses a feature this prototype doesn't parse yet ` +
                `(a top-level always-installed <files> block) -- refusing to produce a ` +
                `silently-incomplete extraction.`
            );
            process.exit(1);
        }

        // All FOMOD source paths are relative to rootPrefix, not the archive root -- make the
        // archive listing passed to resolveChoices() (used for <folder> expansion) relative the
        // same way, so its prefix-matching logic doesn't need to know about rootPrefix at all.
        const rootPrefixLower = rootPrefix.toLowerCase();
        const relativeEntries = rootPrefix
            ? archiveEntries
                .filter((e) => {
                    const lower = e.path.toLowerCase();
                    return lower.startsWith(rootPrefixLower + '\\') || lower.startsWith(rootPrefixLower + '/');
                })
                .map((e) => ({ ...e, path: e.path.slice(rootPrefix.length + 1) }))
            : archiveEntries;

        const { files, warnings, flags } = resolveChoices(parsedFomod, mod.choices, relativeEntries);
        for (const w of warnings) console.warn(`WARNING: ${w}`);
        if (parsedFomod.conditionalPatterns.length > 0) {
            console.log(`Resolved condition flags: ${JSON.stringify(flags)}`);
        }
        console.log(`Resolved ${files.length} file(s) from ${parsedFomod.installSteps.length} FOMOD install step(s)` +
            (parsedFomod.conditionalPatterns.length > 0 ? ` + ${parsedFomod.conditionalPatterns.length} conditional pattern(s)` : '') + '.');

        const resolvedFiles = files.map((file) => ({
            source: rootPrefix ? `${rootPrefix}\\${file.source}` : file.source,
            destination: file.destination,
        }));
        await installResolvedFiles(sevenZipExe, archivePath, resolvedFiles, modOutputDir, args.output);
    } else {
        // No recorded choices at all -- either a genuine "simple" (no installer) mod, or an
        // "Open FOMOD": a mod whose archive DOES have a real FOMOD wizard, but whose collection
        // deliberately leaves the choice to whoever installs it (Vortex's FOMOD wizard even
        // pre-selects based on what's ALREADY installed in that specific profile) rather than
        // pinning one fixed answer. Confirmed with the user this is a real, normal pattern for a
        // handful of mods in some collections, not a bug. There's no deterministic "correct"
        // answer to replay here even in principle -- refuse rather than guess.
        const archiveEntries = await listArchive(sevenZipExe, archivePath);
        if (hasFomodInstaller(archiveEntries)) {
            console.error(
                `"${mod.name}" is an Open FOMOD -- its archive has a real FOMOD installer wizard, but ` +
                `collection.json has no recorded choices for it (the collection deliberately leaves this ` +
                `one to whoever installs it). There's no deterministic default to replay -- this mod needs ` +
                `to be reinstalled manually through Vortex's own FOMOD wizard.`
            );
            process.exit(3);
        }
        const files = resolveSimpleInstall(archiveEntries);
        console.log(`Resolved ${files.length} file(s) as a simple (non-FOMOD) install.`);

        await installResolvedFiles(sevenZipExe, archivePath, files, modOutputDir, args.output);
    }

    console.log(`\nDone. Output: ${modOutputDir}`);
}

main().catch((e) => {
    console.error(`ERROR: ${e.message}`);
    process.exit(2);
});
