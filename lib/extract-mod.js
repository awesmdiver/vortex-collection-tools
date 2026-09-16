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
const { findSevenZip, listArchive } = require('./sevenzip');
const { hasFomodInstaller } = require('./mod-root');
const { resolveFomodOrSimpleFiles } = require('./mod-install-plan');
const { extractResolvedFiles } = require('./extract-resolved-files');
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
        choicesFile: null, // override -- a JSON file holding real {type:'fomod', options} choices,
        // trusted over whatever this mod's own collection.json entry says (or doesn't say at all).
        // See rebuild-mod.js's runExtract() header comment for why this exists.
    };
    const rest = [];
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--collection') args.collection = argv[++i];
        else if (argv[i] === '--downloads') args.downloads = argv[++i];
        else if (argv[i] === '--output') args.output = argv[++i];
        else if (argv[i] === '--folder-name') args.folderName = argv[++i];
        else if (argv[i] === '--archive-path') args.archivePath = argv[++i];
        else if (argv[i] === '--choices-file') args.choicesFile = argv[++i];
        else rest.push(argv[i]);
    }
    args.modName = rest[0];
    return args;
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

    const skipped = await extractResolvedFiles(sevenZipExe, args.archivePath, resolvedFiles, modOutputDir, args.output);
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

    // --choices-file wins over whatever collection.json itself recorded for this mod (or didn't) --
    // see rebuild-mod.js's runExtract() header comment. The parent process already resolved these
    // real choices (a live-Vortex-substituted mod, or a fresh Install pick) and this file is the
    // only way that in-memory value survives the spawn boundary; collection.json is never rewritten.
    if (args.choicesFile) {
        mod.choices = JSON.parse(fs.readFileSync(args.choicesFile, 'utf8'));
    }

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

    // "Open FOMOD" (the archive DOES have a real FOMOD wizard, but collection.json has no recorded
    // choices for it -- the collection deliberately leaves this one to whoever installs it; Vortex's
    // own wizard even pre-selects based on what's ALREADY installed in that specific profile, so
    // there's no deterministic default to replay even in principle) has to be checked HERE, before
    // calling the shared resolver below -- unlike every other real caller of that resolver
    // (rebuild-mod.js's classifyMod already refuses this case before a mod ever reaches REBUILD kind,
    // via its own SKIP_OPEN_FOMOD), this script can also be invoked standalone (see this file's own
    // Usage comment), with no classifyMod() gate having run in this process at all.
    if (archiveHasFomod && !recordedFomodChoices) {
        console.error(
            `"${mod.name}" is an Open FOMOD -- its archive has a real FOMOD installer wizard, but ` +
            `collection.json has no recorded choices for it (the collection deliberately leaves this ` +
            `one to whoever installs it). There's no deterministic default to replay -- this mod needs ` +
            `to be reinstalled manually through Vortex's own FOMOD wizard.`
        );
        process.exit(3);
    }

    const resolved = await resolveFomodOrSimpleFiles(mod, archiveEntries, archivePath, { sevenZipExe, scratchRoot: args.output });
    if (resolved.unresolvable) {
        console.error(`"${mod.name}"'s ${resolved.unresolvable} -- refusing to produce a silently-incomplete extraction.`);
        process.exit(1);
    }
    if (resolved.fellBackFromStaleFomod) {
        // Recorded choices say 'fomod', but this archive genuinely has none -- the real, confirmed
        // case (2026-08-24, Merge History's Undo Merge restoring "mihailimpsandhomonculus.esp" from
        // "Imps and Homonculus (se-ae)"): stale/wrong recorded installerChoicesType, not a real FOMOD
        // this tool failed to find. Resolved as a simple extraction instead -- logged clearly so this
        // is a visible behavior note, not a silent divergence from what the recorded choices said.
        console.log(`Recorded FOMOD choices for "${mod.name}" don't match this archive (no fomod/ModuleConfig.xml found) -- falling back to a simple extraction.`);
    }
    if (resolved.warnings) {
        for (const w of resolved.warnings) console.warn(`WARNING: ${w}`);
    }
    if (resolved.fomodStepCount != null) {
        if (resolved.rootPrefix) console.log(`Mod root inside archive: "${resolved.rootPrefix}"`);
        if (resolved.conditionalPatternCount > 0) console.log(`Resolved condition flags: ${JSON.stringify(resolved.flags)}`);
        console.log(`Resolved ${resolved.files.length} file(s) from ${resolved.fomodStepCount} FOMOD install step(s)` +
            (resolved.conditionalPatternCount > 0 ? ` + ${resolved.conditionalPatternCount} conditional pattern(s)` : '') + '.');
    } else {
        console.log(`Resolved ${resolved.files.length} file(s) as a simple (non-FOMOD) install.`);
    }

    const skippedFiles = await extractResolvedFiles(sevenZipExe, archivePath, resolved.files, modOutputDir, args.output);
    reportSkipped(skippedFiles);
    console.log(`\nDone. Output: ${modOutputDir}`);
}

// Turns a thrown error into { friendly, exitCode } -- extracted as its own function so
// scripts/test-fomod-folder-destination.js (and any future test) can exercise the classification
// directly instead of needing a real subprocess/crafted 7z scenario for every case.
//
// locateArchive()'s own NOT_FOUND/HASH_MISMATCH messages (and the override-gone-stale one above)
// embed the raw recorded fileSize and downloads path -- meaningful for debugging this script
// directly, but this was flowing straight through into the log's user-facing detail text verbatim
// (stderr -> extractErrorDetail() in rebuild-mod.js, unchanged). Simplified here, at the source,
// rather than trying to pattern-match the string back out of it later once it's just plain stderr
// text with no .code anymore. Anything else (7z errors, FOMOD parsing, etc.) keeps its own real
// message unchanged. Exit code 4 (distinct from the generic 2) is what lets rebuild-mod.js's caller
// tell "genuinely no archive" apart from a real extraction-tool failure, so it can offer the same
// Retry Download/Import recovery SKIP_NO_ARCHIVE already gets.
// NO_EXPECTED_HASH removed (2026-09-04) -- locateArchive() can no longer throw it (see that
// function's own header comment in archive-locator.js).
function classifyExtractionError(e) {
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
    //
    // BUT: this same EPERM also fires when the copy's own DESTINATION is already a directory --
    // confirmed real (2026-09-14): three "Paper Maps for FWMF" FOMODs' ModuleConfig.xml had a
    // <file> destination ending in a separator, which choice-resolver.js used to take verbatim as
    // a literal file path (see fomod-parser.js's own fix for the real cause -- Vortex's real
    // installer treats that as "create this folder, no file", not "put the file in this folder").
    // That's NOT a lock, and Retry Extraction can never fix it (the destination is a directory
    // every single time, so it fails identically on every retry -- confirmed exactly this
    // symptom). Node's copyFileSync/renameSync errors carry `.path`/`.dest` for precisely this
    // check -- fs.statSync(e.dest) actually being a directory settles it, no message-string-
    // matching needed (Node's own wording for this varies by version/platform).
    let destIsDirectory = false;
    if (e.dest) {
        try { destIsDirectory = fs.statSync(e.dest).isDirectory(); } catch { /* dest doesn't exist -- not this case */ }
    }
    const transientLock = (e.code === 'EPERM' || e.code === 'EBUSY') && !destIsDirectory;
    const friendly = archiveMissing
        ? 'No archive found.'
        : transientLock
        ? 'A file was locked by another program during extraction (likely antivirus or a file indexer briefly scanning it) -- this is usually temporary. Try Retry Extraction.'
        : destIsDirectory
        // Gemini-polished (2026-09-14, "share one install and extraction engine"), replacing the
        // draft wording df404f2 originally shipped with.
        ? `Couldn't copy "${e.path || '?'}" because a folder already exists at "${e.dest}". Your files were left untouched, but Retry Extraction won't fix this—you may need to reinstall the mod through Vortex.`
        // bundleUnavailable's e.message is already the real, honest, user-facing sentence
        // (lib/bundle-resolver.js's own error text) -- nothing to simplify here.
        : e.message;
    return { friendly, exitCode: archiveMissing ? 4 : bundleUnavailable ? 5 : 2 };
}

if (require.main === module) {
    main().catch((e) => {
        const { friendly, exitCode } = classifyExtractionError(e);
        console.error(`ERROR: ${friendly}`);
        process.exit(exitCode);
    });
}

module.exports = { classifyExtractionError };
