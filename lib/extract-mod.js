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
// failure (mod not found, 7z error, FOMOD parsing, etc). 3 = "Open FOMOD" -- collection.json has no
// recorded choices, and the archive genuinely has a FOMOD wizard with no deterministic default to
// replay; needs manual reinstall through Vortex. 4 = archive not locatable specifically (NOT_FOUND/
// HASH_MISMATCH from locateArchive(), and only when --archive-path wasn't given -- an explicit
// override that's since gone missing surfaces as a real "the file you pointed at is gone" case, not
// this one) -- its own code so rebuild-mod.js's caller can distinguish "genuinely no archive"
// (offer Retry Download/Import, same as SKIP_NO_ARCHIVE) from a real extraction-tool failure.

const fs = require('fs');
const path = require('path');

const { loadCollection, findMod } = require('./collection-parser');
const { locateArchive } = require('./archive-locator');
const { resolveBundledEntries, sanitizeFolderName } = require('./bundle-resolver');
const { findSevenZip, listArchive, extractFile, extractMany } = require('./sevenzip');
const { parseModuleConfigFile, hasUnhandledFeatures } = require('./fomod-parser');
const { resolveChoices } = require('./choice-resolver');
const { findModRoot, hasFomodInstaller } = require('./mod-root');
const { resolveSimpleInstall } = require('./simple-installer');
const appConfig = require('./app-config');

const fileConfig = appConfig.loadConfig();

function parseArgs(argv) {
    const args = {
        // collection/output are dev-fixture convenience defaults for this internal prototype
        // script, not real user-facing settings -- unlike downloads, left as-is.
        collection: 'F:/Mod Extraction/Daughter-of-Coldharbour-SDA-in-GTS-735477-30-1783874181/collection.json',
        downloads: fileConfig.downloads || null,
        output: 'F:/Mod Extraction/prototype-output',
        folderName: null, // override for the output subfolder name; default: derived from the archive's own filename
        modName: null,
        archivePath: null, // override -- skip locateArchive() entirely and use this exact file
    };
    const rest = [];
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--collection') args.collection = argv[++i];
        else if (argv[i] === '--downloads') args.downloads = argv[++i];
        else if (argv[i] === '--output') args.output = argv[++i];
        else if (argv[i] === '--folder-name') args.folderName = argv[++i];
        else if (argv[i] === '--archive-path') args.archivePath = argv[++i];
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
// Returns the archive members extractMany() itself couldn't extract (see that function's own header
// comment -- a partial failure no longer throws, it reports). Any resolvedFiles entry whose `source`
// is among those never lands in modOutputDir at all -- skipped here too, rather than crashing on a
// copyFileSync against a file that was never extracted.
async function installResolvedFiles(sevenZipExe, archivePath, resolvedFiles, modOutputDir, scratchRoot) {
    if (resolvedFiles.length === 0) return [];
    fs.mkdirSync(scratchRoot, { recursive: true });
    const scratchDir = fs.mkdtempSync(path.join(scratchRoot, '.sevenzip-scratch-'));
    try {
        const skipped = await extractMany(sevenZipExe, archivePath, resolvedFiles.map((f) => f.source), scratchDir);
        const skippedSources = new Set(skipped.map((s) => s.path));
        for (const f of resolvedFiles) {
            if (skippedSources.has(f.source)) {
                console.error(`  SKIPPED (couldn't extract): ${f.source} -> ${f.destination}`);
                continue;
            }
            const srcPath = path.join(scratchDir, f.source);
            const destFullPath = path.join(modOutputDir, f.destination);
            fs.mkdirSync(path.dirname(destFullPath), { recursive: true });
            fs.copyFileSync(srcPath, destFullPath);
            console.log(`  ${f.source} -> ${f.destination}`);
        }
        return skipped;
    } finally {
        fs.rmSync(scratchDir, { recursive: true, force: true });
    }
}

// Bundle-type mods ('source.type === "bundle"') -- content packaged INSIDE the collection's own
// downloaded package rather than a separately downloadable file. See lib/bundle-resolver.js's own
// header comment for the full real-world story. --archive-path is REQUIRED here (never re-resolved
// standalone): rebuild-mod.js's classifyMod() already resolved it to the collection's own package
// path in the parent process (via lib/bundle-resolver.js's resolveCollectionPackagePath, which needs
// the collection's modId + optionally a live Helper connection -- neither of which this child
// process has any way to re-derive on its own), same "the parent already did this, don't redo it"
// convention --archive-path already follows for every other source type.
//
// Exit code 5 (distinct from the generic 2, and deliberately NOT 4): 4 means "archive not locatable"
// and triggers the log/Work Through Report's Retry Download/Import recovery UI -- neither makes
// sense here (there is no per-mod archive to download, and "Import" implies hand-picking a
// replacement file, not what a missing bundled subfolder needs). rebuild-mod.js's rebuildMod() only
// wires that recovery UI off `status === 4` specifically, so this code naturally gets the plain,
// honest failure treatment instead, with zero further changes needed there.
async function extractBundledMod(mod, args, sevenZipExe) {
    console.log(`Mod: ${mod.name} (bundled content from the collection's own package)`);
    if (!args.archivePath) {
        const err = new Error(
            "Bundle-type mods can only be extracted with a pre-resolved --archive-path (the "
            + "collection's own downloaded package) -- not supported as a standalone invocation."
        );
        err.code = 'BUNDLE_PACKAGE_NOT_FOUND';
        throw err;
    }
    if (!fs.existsSync(args.archivePath)) {
        const err = new Error(`No archive file found at "${args.archivePath}" (was recorded, but is no longer there).`);
        err.code = 'BUNDLE_PACKAGE_NOT_FOUND';
        throw err;
    }
    console.log(`Collection package: ${args.archivePath}`);

    const archiveEntries = await listArchive(sevenZipExe, args.archivePath);
    const resolvedFiles = resolveBundledEntries(archiveEntries, mod.source.fileExpression);
    console.log(`Resolved ${resolvedFiles.length} file(s) from this collection's bundled content ("${mod.source.fileExpression}").`);

    const archiveBaseName = args.folderName || sanitizeFolderName(mod.source.fileExpression || mod.name);
    const modOutputDir = path.join(args.output, archiveBaseName);
    fs.mkdirSync(args.output, { recursive: true });

    const skipped = await installResolvedFiles(sevenZipExe, args.archivePath, resolvedFiles, modOutputDir, args.output);
    reportSkipped(skipped);
    console.log(`\nDone. Output: ${modOutputDir}`);
}

// Prints a single, greppable stdout line rebuild-mod.js's own runExtract() parses back out of the
// captured child-process output -- the exit code alone can't carry "succeeded, but one file inside
// the archive couldn't be extracted" (see extractMany's own header comment for why that's no longer
// a hard failure). Silent when nothing was skipped -- the overwhelmingly common case shouldn't pay
// even a log line for this.
function reportSkipped(skipped) {
    if (!skipped || skipped.length === 0) return;
    console.log(`EXTRACTION_WARNINGS_JSON:${JSON.stringify({ skippedFiles: skipped })}`);
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

    if (mod.source?.type === 'bundle') {
        await extractBundledMod(mod, args, sevenZipExe);
        return;
    }

    console.log(`Mod: ${mod.name} (modId ${mod.source.modId})`);

    // --archive-path (set by rebuild-mod.js's runExtract(), passed action.archivePath -- the SAME
    // archive classifyMod() already resolved in the parent process, whether via a normal exact
    // size/md5 match, an auto-detected same-size "Force Extract Anyway" candidate, or an explicit
    // "Import" association) always wins over re-resolving here. Confirmed live this was a real bug:
    // re-running locateArchive() against collection.json's exact recorded size/md5 re-fails for
    // BOTH the force-extract and import cases -- their whole point is accepting a file that does
    // NOT match that exact recording -- so a mod that classifyMod() correctly resolved to REBUILD
    // was hitting "No archive of size X found" here anyway, from a completely redundant re-lookup.
    let archivePath;
    if (args.archivePath) {
        // The override itself can go stale (file deleted/moved after classifyMod() resolved it,
        // between planning and this actual extraction attempt) -- given the SAME NOT_FOUND shape
        // as a natural locateArchive() miss so it's handled identically downstream (exit code 4,
        // friendly message, Retry Download/Import offered again on the log/Work Through Report).
        if (!fs.existsSync(args.archivePath)) {
            const err = new Error(`No archive file found at "${args.archivePath}" (was recorded, but is no longer there).`);
            err.code = 'NOT_FOUND';
            throw err;
        }
        archivePath = args.archivePath;
    } else {
        archivePath = await locateArchive(args.downloads, mod.source);
    }
    console.log(`Archive: ${archivePath}`);

    // Vortex assigns a mod's staging folder name once, at first install, and never renames it on
    // update -- it just refreshes the folder's CONTENTS in place (confirmed against real Vortex
    // live-state data this session). So the correct output folder name is sometimes NOT the
    // current archive's own filename -- --folder-name lets a caller (rebuild-collection.js, which
    // looks up Vortex's real tracked folder name first) override it explicitly.
    const archiveBaseName = args.folderName || path.basename(archivePath, path.extname(archivePath));
    const modOutputDir = path.join(args.output, archiveBaseName);
    fs.mkdirSync(args.output, { recursive: true });

    // Listed once, up front, so both branches below share the same real archive listing instead
    // of each fetching (or, before 2026-08-24, one branch redundantly re-fetching) its own copy.
    const archiveEntries = await listArchive(sevenZipExe, archivePath);
    // hasFomodInstaller() gates the FOMOD branch itself now (2026-08-24, merge-history-restore-
    // fomod-mismatch), not just the "Open FOMOD" detection below -- confirmed real, live: Vortex's
    // own recorded installerChoicesType for a mod's staging entry can go stale/wrong relative to
    // what the CURRENT archive actually contains (e.g. the mod's file was updated to drop its
    // FOMOD installer sometime after Vortex first recorded 'fomod' for it). Trusting
    // mod.choices.type === 'fomod' at face value sent such a mod into findModRoot(), which threw a
    // hard, uncaught "No fomod/ModuleConfig.xml found" -- correct behavior FOR that function (it
    // only promises "find the FOMOD root or throw"), but the caller was treating that as a fatal,
    // unrecoverable failure instead of recognizing "no FOMOD in this archive" as a legitimate,
    // different case this app already has a well-built path for: a simple, non-FOMOD extraction.
    const archiveHasFomod = hasFomodInstaller(archiveEntries);
    const recordedFomodChoices = mod.choices && mod.choices.type === 'fomod';
    let skippedFiles = [];

    if (recordedFomodChoices && archiveHasFomod) {
        // Needed both to expand any <folder> entries (whole-directory copies) against what's
        // actually in the archive, AND to find the real "mod root" (the folder directly
        // containing fomod\ModuleConfig.xml) -- some archives nest the FOMOD inside one or more
        // extra containing folders instead of putting it at the archive root.
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
        skippedFiles = await installResolvedFiles(sevenZipExe, archivePath, resolvedFiles, modOutputDir, args.output);
    } else {
        if (recordedFomodChoices) {
            // Recorded choices say 'fomod', but this archive genuinely has none -- the real,
            // confirmed case (2026-08-24, Merge History's Undo Merge restoring
            // "mihailimpsandhomonculus.esp" from "Imps and Homonculus (se-ae)"): stale/wrong
            // recorded installerChoicesType, not a real FOMOD this tool failed to find. Falls
            // through to the same simple-install path below -- logged clearly so this is a visible
            // behavior note, not a silent divergence from what the recorded choices said.
            console.log(`Recorded FOMOD choices for "${mod.name}" don't match this archive (no fomod/ModuleConfig.xml found) -- falling back to a simple extraction.`);
        } else if (archiveHasFomod) {
            // No recorded choices at all -- either a genuine "simple" (no installer) mod, or an
            // "Open FOMOD": a mod whose archive DOES have a real FOMOD wizard, but whose collection
            // deliberately leaves the choice to whoever installs it (Vortex's FOMOD wizard even
            // pre-selects based on what's ALREADY installed in that specific profile) rather than
            // pinning one fixed answer. Confirmed with the user this is a real, normal pattern for a
            // handful of mods in some collections, not a bug. There's no deterministic "correct"
            // answer to replay here even in principle -- refuse rather than guess.
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

        skippedFiles = await installResolvedFiles(sevenZipExe, archivePath, files, modOutputDir, args.output);
    }

    reportSkipped(skippedFiles);
    console.log(`\nDone. Output: ${modOutputDir}`);
}

main().catch((e) => {
    // locateArchive()'s own NOT_FOUND/HASH_MISMATCH messages (and the override-gone-stale one just
    // above) embed the raw recorded fileSize and downloads path -- meaningful for debugging this
    // script directly, but this was flowing straight through into the log's user-facing detail text
    // verbatim (stderr -> extractErrorDetail() in rebuild-mod.js, unchanged). Simplified here, at
    // the source, rather than trying to pattern-match the string back out of it later once it's
    // just plain stderr text with no .code anymore. Anything else (7z errors, FOMOD parsing, etc.)
    // keeps its own real message unchanged. Exit code 4 (distinct from the generic 2) is what lets
    // rebuild-mod.js's caller tell "genuinely no archive" apart from a real extraction-tool failure,
    // so it can offer the same Retry Download/Import recovery SKIP_NO_ARCHIVE already gets.
    // NO_EXPECTED_HASH removed (2026-09-04) -- locateArchive() can no longer throw it (see that
    // function's own header comment in archive-locator.js).
    const archiveMissing = e.code === 'NOT_FOUND' || e.code === 'HASH_MISMATCH';
    // Bundle-type mods (see extractBundledMod's own header comment for the full reasoning): a
    // DIFFERENT exit code from archiveMissing's 4, deliberately, so rebuild-mod.js's rebuildMod()
    // does NOT offer the Retry Download/Import recovery UI for these -- neither action makes sense
    // for a subfolder missing from (or a package missing from) the collection's own package.
    const bundleUnavailable = e.code === 'BUNDLE_PACKAGE_NOT_FOUND' || e.code === 'BUNDLE_FOLDER_NOT_FOUND';
    // EPERM/EBUSY on a file copy (Node's own fs error codes, not locateArchive()'s) is Windows
    // reporting the file as in use -- confirmed real-world this session (a freshly-extracted .ini
    // file, almost certainly antivirus/indexer briefly holding a handle). Genuinely transient in
    // practice, not a real corruption/permissions problem, so this points straight at the fix
    // (Retry Extraction) instead of a raw scratch-path-to-.rebuilding-path copyfile error.
    const transientLock = e.code === 'EPERM' || e.code === 'EBUSY';
    const friendly = archiveMissing
        ? 'No archive found.'
        : transientLock
        ? 'A file was locked by another program during extraction (likely antivirus or a file indexer briefly scanning it) -- this is usually temporary. Try Retry Extraction.'
        // bundleUnavailable's e.message is already the real, honest, user-facing sentence
        // (lib/bundle-resolver.js's own error text) -- nothing to simplify here.
        : e.message;
    console.error(`ERROR: ${friendly}`);
    process.exit(archiveMissing ? 4 : bundleUnavailable ? 5 : 2);
});
