'use strict';
// The per-mod state machine for rebuild-collection.js.
//
// classifyMod() decides what SHOULD happen to a mod (read-only besides archive-locator's own
// hashing of candidate archives) -- shared by --dry-run and the real run, so the plan printed in
// dry-run mode is exactly what the real run will do.
//
// rebuildMod() performs the actual rebuild for one REBUILD-classified mod, using the SAME
// ordering Vortex's own installer uses (visible as a "<mod>.installing" folder while Vortex
// itself is mid-install): build the new content in a SEPARATE, clearly-marked temp folder
// ("<name>.rebuilding") first, leaving the real staging folder completely untouched throughout
// extraction and comparison. Only once the new content is verified good does a brief swap move it
// into place. This matters beyond style: if this process is interrupted (crash, power loss)
// before that swap, the real folder is exactly as it always was -- nothing to roll back, and any
// leftover ".rebuilding" folder is self-evidently abandoned debris, safe to discard on the next
// run. An earlier version of this moved the ORIGINAL out of the way first and extracted directly
// into the real slot -- if interrupted between those two steps, the real slot held partial
// garbage with no indication anything was wrong, recoverable only by knowing this tool's internal
// backup-root convention. The only remaining risk window here is the swap itself (two renames +
// a delete), not the entire extraction.
//
// What counts as a match (existingStagingFolder=true only): files present in the fresh
// extraction but ABSENT from the current staging folder ("added") are NOT treated as a failure --
// that is exactly what a repair of a corrupted/partially-deleted staging folder looks like, and
// the user's explicit instruction is that the newly-extracted, complete version wins in that
// case. Only "missing" (current had it, fresh doesn't -- the fresh extraction regressed) or
// "changed" (same path, different content) block the swap, since those indicate the fresh
// extraction may itself be wrong, not that it's completing something that was already incomplete.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const { locateArchive, resolveDomainDownloadsDir } = require('./archive-locator');
const { resolveCollectionPackagePath, resolveBundledEntries, resolveBundledEntriesFromDir, sanitizeFolderName } = require('./bundle-resolver');
const { isRealFomodChoices } = require('./vortex-live-fomod-choices');
const { buildManifest } = require('./hash-manifest');
const { diffManifestsCaseInsensitive } = require('./diff-manifests-ci');
const { listArchive } = require('./sevenzip');
const { hasFomodInstaller, hasLegacyScriptInstaller } = require('./mod-root');
const { isPluginFile, checkEslOnlyDifference } = require('./esp-flag-diff');
const { stripGhostPairs, applyGhostPreservation } = require('./ghost-files');
const { stripGameEditedMismatches } = require('./game-edited-files');

const PROJECT_ROOT = path.join(__dirname, '..');

// knownVortexModId: this mod's REAL staging folder name per Vortex's own live state (looked up
// via findCurrentModIds before calling this), if Vortex has ever installed it before. Vortex
// assigns a mod's staging folder name once, at first install, and never renames it on update --
// it just refreshes the folder's contents in place. Confirmed this session against real data: a
// mod's CURRENT archive filename can differ from its real, Vortex-tracked folder name once the
// collection has been updated to a newer file version that hasn't actually been redeployed yet
// (e.g. because the mod is disabled). Trusting the archive's own filename in that case creates a
// wrong, duplicate folder Vortex doesn't know about, instead of correctly updating the real one.
// forceExtractOffSiteMismatch: opt-in (Settings, or an explicit manual "Force Extract Anyway"
// resolve action) -- when an off-site mod's archive comes back HASH_MISMATCH (a real file of the
// exact right size exists, just fails the md5 check -- unlike Nexus mods, there's no modId/fileId
// to auto-download the correct file with), this uses that candidate as-is instead of flagging the
// mod and stopping. Never applies to NOT_FOUND (no candidate of the right size at all) or to
// Nexus-hosted mods (those get the real auto-download path instead -- see collection-runner.js).
//
// overrideArchivePath: the "Import" button's explicit archive association (lib/offsite-import-map.js)
// -- takes priority over even trying locateArchive at all, since the whole point is the user has
// directly told the tool "use THIS file for THIS mod," bypassing size/md5 verification entirely
// (unlike forceExtractOffSiteMismatch's auto-detected same-size candidate, this handles a
// genuinely different-sized repack/edition too, which HASH_MISMATCH can never catch). Silently
// falls through to the normal locateArchive path if the file has since been deleted/moved, rather
// than hard-failing -- a stale mapping shouldn't be worse than having no mapping at all.
// Builds the SKIP_NO_ARCHIVE detail for NOT_FOUND/HASH_MISMATCH -- surfaces what THIS collection's
// own collection.json actually expects (logicalFilename/size/md5) instead of a bare "No archive
// file found.", since that generic wording reads as "the file is missing" even when a real archive
// for this mod IS sitting in the downloads folder, just a different version than this collection
// was authored/synced against (confirmed real-world 2026-08-14: an authored "My NSFW" collection
// pinned to a Jan 2026 Nexus fileId while several of its OStim mods had since been updated on Nexus
// and redownloaded -- "FlufyFox Animations for OStim Standalone" recorded fileSize=25,788,196 /
// md5=aa0c8c51... but the file actually on disk was 25,789,989 bytes with a completely different
// md5, 1,793 bytes outside archive-locator's own SIZE_TOLERANCE_BYTES fallback window, so it
// legitimately never became a match candidate at all -- see TECHNICAL.md). NOT_FOUND and
// HASH_MISMATCH get slightly different wording (nothing size-plausible found at all, vs. a
// same-size-ish file was found and hashed but didn't match) since that distinction is itself useful
// context, even though both are equally "we don't have the correct archive" for classifyMod's own
// SKIP_NO_ARCHIVE handling below.
// Simplified (2026-09-01, director's own explicit call) -- this used to also append "This
// collection expects '<name>', <size>, md5 <hash>…" and a trailing "try Download Archive… or update
// the collection" sentence. Dropped both: the expected-details clause repeats the report's own name/
// row without helping decide what to do about it, and the "try Download Archive" guidance is
// redundant with the real Download Archive button sitting right next to this message.
function describeArchiveMismatch(code, source) {
    // NO_EXPECTED_HASH is no longer a real code locateArchive() can throw (2026-09-04, director's
    // own explicit call -- see archive-locator.js's own locateArchive header comment): a missing
    // recorded md5 now falls back to a Vortex Bridge download-record match, or failing that, the top
    // same-size/name-matched candidate -- it always resolves, never throws. Only HASH_MISMATCH
    // remains a real possible code here (a recorded md5 that was actually checked and genuinely
    // didn't match) -- kept as its own branch rather than folded into the default message, since a
    // future locateArchive revision could plausibly reintroduce a "found but unconfirmed" code and
    // this is where it would want to land again.
    if (code === 'HASH_MISMATCH') {
        return "Found a file the right size in your downloads, but this collection didn't include a way to confirm it's the right one.";
    }
    return 'No matching mod archive found in your downloads folder.';
}

// Bundle-type mods ('source.type === "bundle"') are content the collection author packaged directly
// INSIDE the collection's own downloaded package, not a separately downloadable file -- see
// lib/bundle-resolver.js's own header comment for the full real-world story (this is a real, live
// bug fix, 2026-08-26, not speculative design). Intercepted here, BEFORE locateArchive() is ever
// called, because these sources never carry an `md5` (the one field every match-by-hash path in
// this project assumes exists) and their recorded `fileSize` describes the COLLECTION's package, not
// the inner file -- neither the size nor the hash half of the normal matching logic could ever apply.
async function classifyBundledMod(mod, { downloadsDir, stagingDir, knownVortexModId, collectionModId, sevenZipExe }) {
    let collectionArchivePath;
    let bundledSourceDir;
    try {
        const resolved = await resolveCollectionPackagePath({ collectionModId, downloadsDir, stagingDir });
        // Two distinct shapes (2026-09-25 fix, real bug -- see lib/bundle-resolver.js's own header
        // comment): a real archive to 7z-list (archivePath), or Vortex's own already-extracted
        // staging `Bundled\` folder to read directly (bundledDir) -- the staging fallback is only
        // ever tried once BOTH archive-based candidates fail, so this is never a "which one wins"
        // choice, just "which one resolveCollectionPackagePath actually found."
        if (resolved.bundledDir) bundledSourceDir = resolved.bundledDir;
        else collectionArchivePath = resolved.archivePath;
    } catch (e) {
        return { kind: 'SKIP_NO_ARCHIVE', detail: e.message, code: e.code };
    }

    let resolvedFiles;
    try {
        if (bundledSourceDir) {
            resolvedFiles = resolveBundledEntriesFromDir(bundledSourceDir, mod.source.fileExpression);
        } else {
            const entries = await listArchive(sevenZipExe, collectionArchivePath);
            resolvedFiles = resolveBundledEntries(entries, mod.source.fileExpression);
        }
    } catch (e) {
        if (e.code === 'BUNDLE_FOLDER_NOT_FOUND') return { kind: 'SKIP_NO_ARCHIVE', detail: e.message, code: e.code };
        throw e; // a real 7z failure -- not a "this mod is missing" case, let it surface as a hard error
    }

    // No FOMOD/mod-root detection here (unlike the normal archivePath branch just below) -- bundled
    // content is never a FOMOD by definition (resolveBundledEntries/resolveBundledEntriesFromDir
    // already resolved the exact file list from a known, literal folder), so there is nothing to
    // peek for.
    const targetFolderName = knownVortexModId || sanitizeFolderName(mod.source.fileExpression || mod.name);
    const stagingModDir = path.join(stagingDir, targetFolderName);
    const existingStagingFolder = fs.existsSync(stagingModDir);

    return {
        kind: 'REBUILD', targetFolderName, stagingModDir, existingStagingFolder,
        // archivePath is undefined for the staging-resolved case -- bundledSourceDir carries the
        // equivalent "where this came from" instead. Every caller that reads action.archivePath
        // already treats a falsy value as "no archive to display/re-verify" (collection-runner.js's
        // own isActionStale() and its per-mod archiveName display both do), so this doesn't need a
        // placeholder/dummy path.
        archivePath: collectionArchivePath, bundledSourceDir,
        bundled: true, bundleFolder: mod.source.fileExpression, bundledFiles: resolvedFiles,
        // Recorded at classify time so a later caller (runRebuild()'s per-mod staleness guard, for a
        // reused plan that may be up to several minutes old) can cheaply tell "the file at this path
        // changed since I classified it" apart from "nothing changed" without re-hashing anything --
        // see rebuild-mod.js's own classifyMod() REBUILD branch for the non-bundled twin of this.
        // Only meaningful for the archive-based candidate -- a staging-resolved bundle has no single
        // "package size" to compare against (isActionStale() checks bundledSourceDir's own existence
        // instead for that case, not a size).
        archiveSize: collectionArchivePath ? fs.statSync(collectionArchivePath).size : undefined,
    };
}

// exceptionMatcher (queue: rebuild-missing-hand-pick-exceptions): (mod) => boolean, pre-built by
// the caller via lib/mod-exception-store.js's makeExceptionMatcher (loaded ONCE per scan/rebuild
// batch, not once per mod -- same convention as rebuild-missing-routes.js's own ignoredMatchers).
// Checked FIRST, before any archive resolution -- a mod on this list (director's own real case:
// "1DustAdeptArmorSE", a hand-pick-only FOMOD where the archive contains far more than the user
// deliberately chose to install) should never even be hashed/listed, let alone rebuilt: extracting
// the full archive for a mod like this installs content the user never chose, which can cause
// missing masters or crashes. Optional (defaults to a no-op) so every other classifyMod() caller
// that doesn't pass one is unaffected.
async function classifyMod(mod, { downloadsDir, stagingDir, knownVortexModId, collectionModId = null, sevenZipExe, forceExtractOffSiteMismatch = false, overrideArchivePath = null, exceptionMatcher = () => false }) {
    if (exceptionMatcher(mod)) {
        return { kind: 'SKIP_EXCEPTED', detail: 'On the Mod Exceptions list -- never auto-fixed here. Remove it from the list (Reports > Mod Exceptions) if you want this tool to manage it again.' };
    }
    let archivePath;
    let forcedMismatch = false;
    let importedOverride = false;
    let autoResolvedDuplicate = null;
    if (overrideArchivePath && fs.existsSync(overrideArchivePath)) {
        archivePath = overrideArchivePath;
        importedOverride = true;
    } else if (mod.source?.type === 'bundle') {
        // Never enters locateArchive()/the size-tolerance-then-md5 path at all -- see
        // classifyBundledMod's own header comment for why that path can never work for this source
        // type. Checked AFTER overrideArchivePath so an explicit "Import" association (the user
        // directly pointing this tool at a specific file) still wins, same as it does for every other
        // source type.
        return classifyBundledMod(mod, { downloadsDir, stagingDir, knownVortexModId, collectionModId, sevenZipExe });
    } else try {
        // A mod cross-listed under its own domainName lives in a sibling downloads folder, not this
        // one -- see resolveDomainDownloadsDir's own header comment. No-op for the overwhelming
        // majority of mods (no domainName override), so every other classifyMod() caller is
        // unaffected unless their collection actually has one of these.
        archivePath = await locateArchive(resolveDomainDownloadsDir(downloadsDir, mod.domainName), mod.source);
    } catch (e) {
        const isOffSite = mod.source?.type !== 'nexus';
        // NO_EXPECTED_HASH removed from this whole catch block (2026-09-04) -- locateArchive() can no
        // longer throw it at all (see that function's own header comment: a missing recorded md5 now
        // resolves via a Vortex Bridge download-record check or a trusted same-size/name fallback, never a
        // throw). Every branch below that used to also check for it now only needs HASH_MISMATCH.
        if (e.code === 'HASH_MISMATCH' && isOffSite && forceExtractOffSiteMismatch && e.candidates?.length > 0) {
            archivePath = e.candidates[0];
            forcedMismatch = true;
        } else if (e.code === 'AMBIGUOUS' && e.candidates?.length > 0) {
            // Director's own call (2026-08-31): don't block a whole mod -- and everything the rest of
            // this apply still needs to register in Vortex -- over duplicate downloads. Unlike
            // HASH_MISMATCH candidates (same SIZE, unverified content), locateArchive()'s own AMBIGUOUS
            // candidates are already confirmed exact md5+fileSize matches of what the collection
            // expects -- genuinely byte-identical copies under different filenames. Picking any one of
            // them is 100% content-safe; there is no "wrong" choice to make here. Sorted
            // newest-mtime-first purely for determinism (repeat runs pick the same file), not because
            // it matters for correctness.
            const sorted = [...e.candidates].sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
            archivePath = sorted[0];
            autoResolvedDuplicate = { picked: archivePath, allCandidates: e.candidates };
        } else {
            // NOT_FOUND and HASH_MISMATCH both mean "we don't have the correct archive" from the user's
            // perspective -- a HASH_MISMATCH candidate is a same-size-by-coincidence file that isn't the
            // real one (confirmed real-world: a 441-byte mod and a completely unrelated 441-byte archive
            // happened to collide on size), so it gets the same friendly rewrite AND is equally eligible
            // for auto-download (downloading the real file fixes this cleanly; the irrelevant candidate
            // just fails the md5 check again and is ignored, same as before). AMBIGUOUS is genuinely
            // different -- multiple candidates that ARE byte-identical correct matches, a genuine
            // duplicate-file situation (confirmed real-world: two byte-identical copies of the same
            // archive under different filenames) -- gets its own friendly message + the full candidate
            // list, so the log/Work Through Report can offer a "delete one of these" UI instead of a
            // dead-end error. Downloading again would only add a third correct copy.
            const isMissing = e.code === 'NOT_FOUND' || e.code === 'HASH_MISMATCH';
            const detail = isMissing
                ? describeArchiveMismatch(e.code, mod.source)
                : e.code === 'AMBIGUOUS'
                ? "Multiple matching files were found for this mod. Delete the ones you don't want, then retry."
                : e.message;
            // candidateFile (singular, HASH_MISMATCH only) so an off-site mod's plan/log detail can
            // say "a new file was found but doesn't match" instead of the generic "nothing here yet"
            // wording, and so a manual "Force Extract Anyway" resolve action knows what to use.
            // candidateFiles (plural, AMBIGUOUS only) is the full duplicate list for the delete UI.
            return {
                kind: 'SKIP_NO_ARCHIVE', detail, code: e.code, candidateFile: e.candidates?.[0],
                candidateFiles: e.code === 'AMBIGUOUS' ? e.candidates : undefined,
            };
        }
    }

    // No recorded FOMOD choices could mean a genuine "simple" archive (no installer, the common
    // case) OR an "Open FOMOD" -- a real FOMOD wizard the collection deliberately leaves to
    // whoever installs it (confirmed with the user: Vortex's own wizard even pre-selects based on
    // what's ALREADY installed in that profile, so there's no static default to replay even in
    // principle). Must check the archive itself, not just collection.json, to tell these apart.
    if (!mod.choices || mod.choices.type !== 'fomod') {
        const entries = await listArchive(sevenZipExe, archivePath);
        if (hasFomodInstaller(entries)) {
            return { kind: 'SKIP_OPEN_FOMOD', archivePath };
        }
        // Legacy "C# Script" FOMOD (item 13a) -- real, still-shipping Vortex installer type this
        // tool can't read at all (see mod-root.js::hasLegacyScriptInstaller's own header comment).
        // Reuses SKIP_OPEN_FOMOD's own status/plumbing (rather than a new, separately-wired status)
        // with `legacyInstaller: true` + an explicit `detail`, so every consumer that already
        // gates its own "Install" affordance on this status can check that flag and correctly NOT
        // offer a picker this tool has no way to actually drive.
        if (hasLegacyScriptInstaller(entries)) {
            return {
                kind: 'SKIP_OPEN_FOMOD', archivePath, legacyInstaller: true,
                detail: 'This mod uses an older "C# Script" installer, which this tool can\'t read. Install it directly through Vortex, then re-scan.',
            };
        }
    }

    const archiveBaseName = path.basename(archivePath, path.extname(archivePath));
    const targetFolderName = knownVortexModId || archiveBaseName;
    const stagingModDir = path.join(stagingDir, targetFolderName);
    const existingStagingFolder = fs.existsSync(stagingModDir);

    return {
        kind: 'REBUILD', targetFolderName, archivePath, stagingModDir, existingStagingFolder,
        forcedMismatch: forcedMismatch || undefined, importedOverride: importedOverride || undefined,
        autoResolvedDuplicate: autoResolvedDuplicate || undefined,
        // See classifyBundledMod()'s own twin of this field for why it's recorded.
        archiveSize: fs.statSync(archivePath).size,
    };
}

// execFileSync's own Error.message is just "Command failed: ..." -- the actual reason is in
// stdout/stderr, which are on the error object but easy to lose if not surfaced (same pattern
// already established in smoke-test-collection.js).
function extractErrorDetail(e) {
    const stderr = e.stderr ? e.stderr.toString().trim() : '';
    const stdout = e.stdout ? e.stdout.toString().trim() : '';
    return stderr || stdout || e.message.split('\n')[0];
}

// Async (spawn), not sync (execFileSync) -- this used to block the ENTIRE calling process (fatal
// for the web server: no HTTP/SSE could be served for the full duration of every mod's
// extraction, confirmed live -- looked exactly like the server being down). Still a separate
// child process per mod (extract-mod.js), just no longer blocking.
// archivePath: always the SAME archive classifyMod() already resolved in THIS process (normal
// exact match, an auto-detected "Force Extract Anyway" same-size candidate, or an explicit
// "Import" association) -- passed through so extract-mod.js's own child process never re-resolves
// it independently. Confirmed live this was a real bug: extract-mod.js used to always call its own
// locateArchive() against collection.json's exact recorded size/md5, which re-fails for both the
// force-extract and import cases (their whole point is accepting a file that does NOT match that
// exact recording) -- so a mod classifyMod() correctly resolved to REBUILD would still fail here
// with a redundant, contradictory "No archive found."
//
// mod.choices override ("Open FOMOD mods get an Install button", 2026-09-17): extract-mod.js's own
// child process re-loads the mod fresh from collectionJsonPath by name (findMod()) -- it never sees
// whatever THIS process's own in-memory `mod` object carries. That's invisible for the common case
// (collection.json's own recorded choices are what both copies agree on anyway), but breaks for any
// mod whose real choices exist ONLY in memory here: a live-Vortex-substituted mod
// (resolveEffectiveChoicesForMods -- collection.json itself never recorded them) or a freshly-picked
// Install action (lib/fomod-picker-data.js's buildFomodChoicesFromPicks -- nothing on disk records
// these at all). Confirmed real bug via code read: without this, such a mod's own classifyMod() call
// correctly resolves to REBUILD, but the child then reloads collection.json, finds NO choices, hits
// its own "Open FOMOD -- needs manual reinstall" gate, and exits 3 -- a REBUILD that classifyMod()
// already promised would work fails at the very last step. Fixed the same way archivePath's own
// staleness/override problem already was: write the real choices to a private scratch file and pass
// its path, so the child never needs to trust collection.json's copy at all when a better one exists
// here. Harmless to also do this for a mod whose choices DID come from collection.json -- the child
// just gets handed the identical value it would have loaded anyway. Cleaned up unconditionally once
// the child exits, success or failure.
function runExtract(mod, { collectionJsonPath, downloadsDir, stagingDir, folderName, archivePath, bundledSourceDir }) {
    return new Promise((resolve, reject) => {
        let choicesFilePath = null;
        const extraArgs = [];
        if (isRealFomodChoices(mod.choices)) {
            choicesFilePath = path.join(os.tmpdir(), `vct-choices-${crypto.randomUUID()}.json`);
            fs.writeFileSync(choicesFilePath, JSON.stringify(mod.choices));
            extraArgs.push('--choices-file', choicesFilePath);
        }
        // A bundle mod resolved via the staging Bundled\ fallback (2026-09-25 fix) carries
        // bundledSourceDir instead of archivePath -- exactly one of the two is ever set for a REBUILD
        // action, never both, never neither (see classifyBundledMod's own comment). child_process.spawn
        // rejects a non-string array element outright, so archivePath must never be pushed here as
        // `undefined` -- unlike the choices-file case above, this isn't optional bonus data, so the two
        // branches are mutually exclusive rather than one being appended on top.
        const archiveArgs = bundledSourceDir ? ['--bundled-source-dir', bundledSourceDir] : ['--archive-path', archivePath];
        const child = spawn(
            process.execPath,
            [
                'lib/extract-mod.js', mod.name, '--collection', collectionJsonPath, '--downloads', downloadsDir,
                '--output', stagingDir, '--folder-name', folderName, ...archiveArgs,
                ...extraArgs,
            ],
            { cwd: PROJECT_ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
        );
        const cleanupChoicesFile = () => {
            if (choicesFilePath) fs.rmSync(choicesFilePath, { force: true });
        };
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });
        child.on('error', (e) => { cleanupChoicesFile(); reject(e); });
        // Logged (2026-09-01, director's own explicit ask after a real live incident -- a mod's
        // staging content was gutted mid-apply and there was no log trail to check what extract-
        // mod.js's own FOMOD resolution actually did) -- this child's stdio was always `pipe`
        // (captured into stdout/stderr above), but on the success path (code === 0) everything except
        // one machine-parsed marker line was silently discarded. extract-mod.js already prints real,
        // useful diagnostics on every FOMOD-driven extraction (`Resolved N file(s) from M FOMOD
        // install step(s)...`, `Resolved condition flags: ...`, any `WARNING:` line) -- these were
        // simply never reaching this process's own console, so they never reached the app log either.
        // Surfaced here, tagged with the mod name, on BOTH the success and failure paths (the failure
        // path already attached stdout/stderr to the rejected error, but nothing upstream necessarily
        // logs an Error's own extra fields) -- console.log/warn here rides on the SAME already-active
        // app-logger.js wrapper every other log line in this project uses.
        const logChildOutput = () => {
            const relevantLines = stdout.split('\n')
                .filter((line) => /^Resolved |^WARNING:|^Resolved condition flags:|^Recorded FOMOD choices|^".*Open FOMOD/.test(line));
            if (relevantLines.length > 0) {
                console.log(`[rebuild-mod] extract-mod.js FOMOD activity for "${mod.name}":\n  ${relevantLines.join('\n  ')}`);
            }
            if (stderr.trim()) {
                console.warn(`[rebuild-mod] extract-mod.js stderr for "${mod.name}": ${stderr.trim()}`);
            }
        };
        child.on('close', (code) => {
            logChildOutput();
            cleanupChoicesFile();
            if (code !== 0) {
                const err = new Error(`Command failed with exit code ${code}`);
                err.stdout = stdout;
                err.stderr = stderr;
                err.status = code;
                reject(err);
                return;
            }
            // extract-mod.js's own reportSkipped() prints this one greppable line when extractMany()
            // (see its own header comment) had to skip a genuinely-bad member of an otherwise-good
            // archive -- the exit code alone stays 0 (a real, if partial, success) so this is the only
            // way that detail survives the child-process boundary. Absent for the overwhelmingly
            // common case (nothing skipped).
            const marker = stdout.split('\n').find((line) => line.startsWith('EXTRACTION_WARNINGS_JSON:'));
            let skippedFiles = [];
            if (marker) {
                try {
                    skippedFiles = JSON.parse(marker.slice('EXTRACTION_WARNINGS_JSON:'.length)).skippedFiles || [];
                } catch { /* malformed marker -- treat as nothing skipped rather than fail a real success */ }
            }
            resolve({ skippedFiles });
        });
    });
}

// Transient Windows "something else has this open" errors -- Defender, the search indexer, an
// open Explorer window -- briefly holding a handle inside a folder mid-rename. ENOTEMPTY is
// included because that's what Windows can surface for a locked-directory rename instead of a
// plain EBUSY/EPERM, not because it usually means a real content conflict here (rebuildingDir/
// oldContentDir are always this process's own private, freshly-built folders).
const SWAP_LOCK_ERROR_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY']);
const SWAP_MAX_ATTEMPTS = 3;
const SWAP_RETRY_PAUSES_MS = [500, 1500]; // before attempt 2, then before attempt 3

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isSwapLockError(err) {
    return !!err && SWAP_LOCK_ERROR_CODES.has(err.code);
}

// If a previous attempt got partway through (stagingModDir renamed away to ".old" but the second
// rename never completed), put the original back before trying again -- otherwise a retry would
// find stagingModDir missing and either double-clobber ".old" or throw ENOENT on the first rename.
// No-op when the real folder is already where it should be.
function restoreOriginalIfDisplaced(stagingModDir, oldContentDir) {
    if (!fs.existsSync(stagingModDir) && fs.existsSync(oldContentDir)) {
        fs.renameSync(oldContentDir, stagingModDir);
    }
}

// Same retry/backoff as the main swap loop below -- the FINAL rollback attempt (after every swap
// attempt is exhausted) is just as exposed to a brief Windows lock as the forward swap is, but used
// to get exactly ONE try before giving up to CRITICAL_MANUAL_RESTORE_NEEDED. Real incident (2026-09-
// 14, "Go to bed - Patches"): the forward swap's first rename (stagingModDir -> oldContentDir)
// succeeded, the second (rebuildingDir -> stagingModDir) failed with ENOENT (nothing to move -- see
// the zero-file-extraction guard above) and isn't a lock error, so the swap loop broke immediately
// without retrying; the single rollback attempt right after then hit a real but transient EPERM
// (Windows briefly holding the just-renamed ".old" folder -- exactly the same class of lock the
// forward swap already retries for) and had no second chance, permanently losing the mod to a
// manual-restore state it didn't need.
async function restoreOriginalWithRetry(stagingModDir, oldContentDir) {
    let lastErr = null;
    for (let attempt = 1; attempt <= SWAP_MAX_ATTEMPTS; attempt++) {
        if (attempt > 1) await sleep(SWAP_RETRY_PAUSES_MS[attempt - 2]);
        try {
            restoreOriginalIfDisplaced(stagingModDir, oldContentDir);
            return;
        } catch (err) {
            lastErr = err;
            if (!isSwapLockError(err)) throw err;
        }
    }
    throw lastErr;
}

// Moves a freshly-built ".rebuilding" folder into its real staging slot, retrying transient
// Windows lock errors before giving up instead of failing the whole collection run over one
// briefly-open handle (a real 2026-09-13 incident: a 1,955-mod rebuild hard-stopped at 160 because
// of exactly this). Shared by both swap shapes in rebuildMod(): a mod with no prior staging folder
// (hasExisting=false, a plain rename) and a verified-good rebuild of an existing mod
// (hasExisting=true, old-aside / new-in / old-discard).
//
// Returns { ok: true, attempts } on success, or { ok: false, status, ...fields } already shaped
// exactly like rebuildMod()'s other status objects -- callers return the rest of the object as-is.
async function swapInRebuiltMod({ stagingModDir, rebuildingDir, oldContentDir, hasExisting, targetFolderName, archivePath }) {
    // Confirm there's actually something to swap in BEFORE touching the real folder at all. Without
    // this, a missing rebuildingDir (rebuildMod()'s own zero-file-extraction guard is the normal
    // backstop for that -- see its own comment -- but this is a second, independent check for any
    // other caller/code path that could reach here without one) would rename the real folder to
    // ".old" (hasExisting=true) and only THEN discover there's nothing to rename into its place,
    // right when Windows can still be holding a lock on the just-renamed ".old" from that first
    // rename -- the exact real incident (2026-09-14, "Go to bed - Patches") that turned an ENOENT
    // here into a lost rollback (see restoreOriginalWithRetry's own comment) and
    // CRITICAL_MANUAL_RESTORE_NEEDED. Checked first, so a missing rebuildingDir here never moves the
    // real folder at all.
    if (!fs.existsSync(rebuildingDir)) {
        return {
            ok: false,
            status: 'FAILED_EXTRACTION_NOT_TOUCHED',
            detail: "The installer didn't pick any files for this mod, so nothing was changed.",
        };
    }

    // Clear a stale ".old" leftover from a PREVIOUS, separate call once, up front -- never repeated
    // inside the loop below. Confirmed live in testing: if this ran at the top of every attempt (as
    // it originally did) and a between-attempt restoreOriginalIfDisplaced() ever itself failed
    // (oldContentDir still holding the REAL original, stagingModDir still displaced), the very next
    // attempt's own "clear stale leftover" step would delete that real original permanently, unable
    // to tell it apart from genuine debris. Safe to do once here: within a single call, oldContentDir
    // only ever gets repopulated by THIS call's own attempts, never independently of them.
    if (hasExisting) fs.rmSync(oldContentDir, { recursive: true, force: true });

    let lastErr = null;
    let attemptsMade = 0;
    for (let attempt = 1; attempt <= SWAP_MAX_ATTEMPTS; attempt++) {
        if (attempt > 1) {
            if (hasExisting) {
                try { restoreOriginalIfDisplaced(stagingModDir, oldContentDir); } catch { /* best-effort -- the attempt below will surface any real problem */ }
            }
            await sleep(SWAP_RETRY_PAUSES_MS[attempt - 2]);
        }
        attemptsMade = attempt;
        let renamedOk = false;
        try {
            if (hasExisting) {
                fs.renameSync(stagingModDir, oldContentDir);
                fs.renameSync(rebuildingDir, stagingModDir);
            } else {
                fs.renameSync(rebuildingDir, stagingModDir);
            }
            renamedOk = true;
        } catch (err) {
            lastErr = err;
            if (!isSwapLockError(err)) break; // not a lock -- fail straight through, no point retrying
        }
        if (renamedOk) {
            // The fresh copy is in stagingModDir now -- the swap itself has ALREADY succeeded,
            // whatever happens below. Deleting ".old" (or, in the no-prior-folder shape, a leftover
            // one from an EARLIER run's CRITICAL failure -- see this function's own header note) is
            // best-effort cleanup, deliberately OUTSIDE the try/catch above: the same Defender/
            // indexer/Explorer handle that can block a rename can just as easily block a delete, and
            // a failure here must never turn a completed swap into a reported failure -- that was a
            // real bug (design-side review, 2026-09-14): it used to sit inside the same try, so a
            // locked ".old" delete after a successful rename was indistinguishable from the rename
            // itself failing, misreporting a finished REBUILT as FAILED_FOLDER_LOCKED_NOT_TOUCHED (or
            // worse, misdiagnosing a bogus CRITICAL once the next attempt's own state no longer
            // matched what a real failed rename would have left). No retry of its own here -- a
            // leftover ".old" self-heals for free on this mod's NEXT rebuild regardless of which
            // shape created it: once this swap succeeds, stagingModDir exists, so every future call
            // for this mod takes the hasExisting=true path, whose own up-front cleanup (top of this
            // function) clears any ".old" left behind.
            let leftoverOldFolder;
            try {
                fs.rmSync(oldContentDir, { recursive: true, force: true });
            } catch {
                leftoverOldFolder = oldContentDir;
            }
            return { ok: true, attempts: attemptsMade, leftoverOldFolder };
        }
    }

    // Attempts exhausted (or hit a non-lock error) -- try to put things back the way they were.
    const lockError = { code: lastErr.code, message: lastErr.message, path: lastErr.path || lastErr.dest };
    if (hasExisting) {
        try {
            await restoreOriginalWithRetry(stagingModDir, oldContentDir);
        } catch (rollbackErr) {
            // The real slot is missing AND ".old" can't be moved back either (even after retrying a
            // transient lock -- see restoreOriginalWithRetry's own comment) -- this needs a human.
            // Both folders are left on disk exactly as-is; nothing here is destructive.
            return {
                ok: false,
                status: 'CRITICAL_MANUAL_RESTORE_NEEDED',
                // No bold markup (the task copy said "Use **Restore & Retry**.") -- this string is
                // always HTML-escaped wherever it's displayed (log page, Done screen), and nothing
                // in this app renders inline markdown emphasis, so literal asterisks would just show
                // up on screen. Plain text instead, per that same instruction's own fallback.
                detail: "Couldn't swap in the fresh copy or put the original folder back. Both copies are safe on "
                    + 'disk: original is in the .old folder and fresh copy is in the .rebuilding folder. Use '
                    + 'Restore & Retry.',
                attempts: attemptsMade, lockError,
                rollbackError: { code: rollbackErr.code, message: rollbackErr.message },
                oldContentDir, rebuildingDir, stagingModDir, targetFolderName, archivePath,
            };
        }
    }
    // Original is back in place (or was never moved) -- clean up the abandoned rebuild attempt.
    // Best-effort: a leftover ".rebuilding" is self-evidently abandoned and safe for the next run
    // to clear (same defensive cleanup rebuildMod() already does on entry), so a failure to delete
    // it right now doesn't change the outcome.
    try { fs.rmSync(rebuildingDir, { recursive: true, force: true }); } catch { /* cleaned up next run */ }
    return {
        ok: false,
        status: 'FAILED_FOLDER_LOCKED_NOT_TOUCHED',
        detail: "Couldn't swap in the fresh copy after 3 tries because the folder was locked. Original files were left untouched.",
        // stagingModDir travels here too (not just in the critical branch above) so the Done
        // screen's Reveal button always has a real folder to open -- the original is intact at
        // this exact path either way.
        attempts: attemptsMade, lockError, targetFolderName, archivePath, stagingModDir,
    };
}

// Only ever called for a mod classifyMod() returned REBUILD for. Every intermediate folder this
// creates (".rebuilding", ".old") is a SAME-DIRECTORY sibling of the real staging folder, never a
// separate location -- renames never cross a directory boundary, so there's no chance of hitting
// a permissions/ACL mismatch between two different folders (e.g. an external backup root with
// different inherited permissions than the staging folder itself).
// resolveMode (optional): manual mismatch-resolution modes, triggered from the log-view page's
// "Extraction" column for a mod that already came back FAILED_MISMATCH_NOT_TOUCHED once (never used
// during a normal collection-wide rebuild run, where a mismatch should always still block and get
// reported, not silently resolved one way or the other):
//   'all'           -- full replace: whatever the archive has wins outright, discarding anything
//                       already staged that differs, no ESL-preservation either. Matches the user's
//                       own description ("completely extract the entire archive and rewrite
//                       anything that is in staging").
//   'keep-existing' -- pure additive merge: never touches a destination path staging already has
//                       (covers both a real content difference AND an ESL-only one identically, no
//                       special-casing needed), only copies in paths staging is missing entirely --
//                       which doubles as the "Vortex silently dropped a file from staging" repair
//                       case the user specifically wanted a manual, explicit trigger for rather than
//                       always-automatic.
//   any OTHER truthy value (installOpenFomodMod() passes 'fresh-install') -- a genuine clean
//                       reinstall from fresh FOMOD picks (2026-09-17, "Install should do a clean
//                       reinstall of the mod"): the whole point is that the new picks are EXPECTED
//                       to differ from whatever the mod's staging folder happened to hold before
//                       (leftover files from a prior, different set of picks), so the hasMismatch
//                       refusal below must not block it the way it correctly blocks an ordinary
//                       rebuild -- but unlike 'all', this still runs the SAME
//                       ESL-only/ghost/game-edited-files preservation every ordinary (non-mismatched)
//                       rebuild already gets, since none of those are FOMOD-choice-related and a
//                       fresh install shouldn't silently discard a Vortex-level customization or an
//                       in-play settings file just because the picks changed. Confirmed live in
//                       sandbox testing: without this, planting one extra file in a copied staging
//                       folder made Install refuse outright (FAILED_MISMATCH_NOT_TOUCHED) instead of
//                       actually performing the clean reinstall the director asked for.
async function rebuildMod(mod, action, { collectionJsonPath, downloadsDir, stagingDir }, resolveMode) {
    const stagingModDir = action.stagingModDir;
    const rebuildingDir = `${stagingModDir}.rebuilding`;
    const rebuildingFolderName = `${action.targetFolderName}.rebuilding`;
    const oldContentDir = `${stagingModDir}.old`;

    // Defensive: a ".rebuilding" folder already sitting here means a previous run was
    // interrupted before it could finish -- self-evidently abandoned, safe to clear and retry.
    fs.rmSync(rebuildingDir, { recursive: true, force: true });

    let skippedFiles = [];
    try {
        ({ skippedFiles } = await runExtract(mod, { collectionJsonPath, downloadsDir, stagingDir, folderName: rebuildingFolderName, archivePath: action.archivePath, bundledSourceDir: action.bundledSourceDir }));
    } catch (e) {
        fs.rmSync(rebuildingDir, { recursive: true, force: true });
        // extract-mod.js's own exit code 4 -- the archive genuinely isn't there (deleted/moved since
        // classifyMod() resolved it, or the resolution itself was already stale). Same recovery as
        // SKIP_NO_ARCHIVE: Retry Download for a Nexus mod, Import for an off-site one -- surfaced via
        // the same offSite flag that status already uses (modId/fileId already flow through via base).
        const archiveNotFound = e.status === 4;
        const extra = archiveNotFound ? { archiveNotFound: true, offSite: mod.source?.type !== 'nexus' || undefined } : {};
        return action.existingStagingFolder
            ? { status: 'FAILED_EXTRACTION_NOT_TOUCHED', detail: extractErrorDetail(e), ...extra }
            : { status: 'FAILED_EXTRACTION_NO_PRIOR_DATA', detail: extractErrorDetail(e), ...extra };
    }

    if (!action.existingStagingFolder) {
        // Nothing existed before, nothing to compare against -- just move the verified-extractable
        // result into place. A leftover ".old" here (a PRIOR run's swap hitting
        // CRITICAL_MANUAL_RESTORE_NEEDED and leaving the real slot missing -- exactly the state
        // that puts this mod on this "doesn't exist yet" path on the next classify) is cleaned up
        // by swapInRebuiltMod() itself; see its own header comment.
        const swapResult = await swapInRebuiltMod({
            stagingModDir, rebuildingDir, oldContentDir, hasExisting: false,
            targetFolderName: action.targetFolderName, archivePath: action.archivePath,
        });
        if (!swapResult.ok) {
            const { ok, ...failure } = swapResult;
            return failure;
        }
        const ours = buildManifest(stagingModDir);
        return {
            status: 'REBUILT',
            fileCount: Object.keys(ours).length,
            createdFromScratch: true,
            note: 'staging folder did not exist at all before this run -- entire mod recreated from its archive',
            skippedFiles: skippedFiles.length > 0 ? skippedFiles : undefined,
            attempts: swapResult.attempts > 1 ? swapResult.attempts : undefined,
            leftoverOldFolder: swapResult.leftoverOldFolder,
        };
    }

    const ours = buildManifest(rebuildingDir);
    const theirs = buildManifest(stagingModDir);

    // The installer resolved to literally NOTHING (a FOMOD bug, an archive shape this tool doesn't
    // understand, or a genuinely empty/corrupt archive) while the real staging folder has real
    // content. Real report (2026-09-14, "Go to bed - Patches"): a numeric-flag-value FOMOD bug (see
    // fomod-parser.js's own fix) resolved 0 files, and a manual "Extract all" (resolveMode: 'all')
    // went ahead anyway -- 'all' exists specifically to bypass the hasMismatch check below, so it's
    // NOT enough to only guard that check; this has to stop EVERY resolveMode, checked before any of
    // them branch. buildManifest() on a directory extract-mod.js never even created (which is
    // exactly what happens when zero files were resolved -- see installResolvedFiles's own early
    // return) silently returns {} rather than throwing, so this can't be detected any other way than
    // checking the resulting manifest sizes directly.
    if (Object.keys(ours).length === 0 && Object.keys(theirs).length > 0) {
        fs.rmSync(rebuildingDir, { recursive: true, force: true });
        return {
            status: 'FAILED_EXTRACTION_NOT_TOUCHED',
            detail: "The installer didn't pick any files for this mod, so nothing was changed.",
        };
    }

    // Vortex "ghost" files (e.g. "Disable Map Markers.esp.ghost") are a deliberate disable choice,
    // not a real difference -- a fresh archive extraction never contains one, so without this the
    // diff below would call the plain archive file "added" and the ghost file "missing", and every
    // resolution path would then either drop the disable choice (whole-folder swap) or restore the
    // plain, active file right alongside the still-present ghost ("Keep modified" -- confirmed live
    // this session, "Dragonborn UI for GTS - Resources": both "Disable Map Markers.esp" and
    // "...esp.ghost" ended up on disk at once). Stripped from the manifests BEFORE diffing so
    // neither shows up as missing/changed/added at all; see ghost-files.js for the full story.
    const { theirs: theirsForDiff, ours: oursForDiff, ghostSkipped } = stripGhostPairs(theirs, ours);
    const diff = diffManifestsCaseInsensitive(theirsForDiff, oursForDiff);
    const ghostNote = ghostSkipped.length > 0
        ? ` -- ${ghostSkipped.length} file(s) Vortex-disabled (.ghost), left untouched: ${ghostSkipped.join(', ')}`
        : '';

    // A .log/.ini/.json difference is never a real problem -- these are exactly the files a
    // running game/SKSE plugin/MCM legitimately writes to during play (a growing log, a settings
    // file the player or an in-game menu changed). Removed from BOTH `changed` and `missing` here
    // (never `added` -- an archive-only file of these extensions still extracts normally, same as
    // always); the caller below copies the user's current staging copies forward when it swaps the
    // rebuild into place, so a rebuild never silently resets settings or deletes a plugin-created
    // config. See lib/game-edited-files.js for the real report this fixes.
    const { changed: changedAfterGameEdited, missing: missingAfterGameEdited, gameEditedFilesKept } =
        stripGameEditedMismatches(diff.changed, diff.missing);
    const gameEditedNote = gameEditedFilesKept.length > 0
        ? ` -- ${gameEditedFilesKept.length} file(s) the game/a plugin edits during play (.log/.ini/.json), left untouched: ${gameEditedFilesKept.join(', ')}`
        : '';

    // A "changed" .esp/.esm/.esl is worth telling apart from a real content difference: if it
    // differs from the archive ONLY by the ESL (Light Master) flag in its TES4 header, that's a
    // deliberate local customization (ESLify/xEdit/CAO run at some point, or Vortex's own "mark as
    // light" toggle -- confirmed live: that toggle rewrites the flag directly in the staging file
    // the instant you click it, no deploy needed), not a regression. Confirmed against two real
    // cases this session ("Bitchcraft Tats", "sandboxcylinderheight.esp"). Per the user's explicit
    // call: these files are left exactly as they are -- excluded from the fresh extraction
    // entirely -- rather than either failing the mod or silently discarding the user's ESL choice.
    // MUST run before rebuildingDir is touched below, since it reads both copies. Path casing from
    // the diff is whatever the manifest's lowercased key was -- fine on Windows, where path lookups
    // are case-insensitive regardless.
    const eslOnly = changedAfterGameEdited.filter((p) => {
        if (!isPluginFile(p)) return false;
        const result = checkEslOnlyDifference(path.join(stagingModDir, p), path.join(rebuildingDir, p));
        return result !== null;
    });
    const realChanged = changedAfterGameEdited.filter((p) => !eslOnly.includes(p));
    const eslNote = eslOnly.length > 0
        ? ` -- ${eslOnly.length} file(s) Marked as Light locally, left unchanged (no real content difference): ${eslOnly.join(', ')}`
        : '';

    const hasMismatch = missingAfterGameEdited.length > 0 || realChanged.length > 0;

    if (hasMismatch && !resolveMode) {
        // Genuine regression risk -- the fresh extraction may itself be wrong. The real folder was
        // NEVER touched, so there's nothing to roll back; just discard the rebuilt attempt.
        fs.rmSync(rebuildingDir, { recursive: true, force: true });
        return {
            status: 'FAILED_MISMATCH_NOT_TOUCHED',
            detail: `missing=${missingAfterGameEdited.length} changed=${realChanged.length} (added=${diff.added.length}, not a failure on its own)${eslNote}${ghostNote}${gameEditedNote}`,
            missing: missingAfterGameEdited, changed: realChanged, added: diff.added, changedEslOnly: eslOnly, ghostSkipped,
            gameEditedFilesKept: gameEditedFilesKept.length > 0 ? gameEditedFilesKept : undefined,
        };
    }

    if (resolveMode === 'keep-existing') {
        // Case-insensitive membership check against theirs (matching diffManifestsCaseInsensitive's
        // own convention -- see its header comment on real-mod NTFS case-preservation artifacts),
        // but iterating oursForDiff's ORIGINAL-cased keys so the actual copy below reads a real path
        // under rebuildingDir, not a lowercased one that may not exist on disk. oursForDiff (not the
        // raw ours) so a ghost-matched plain path is never treated as "missing from staging" -- that
        // was the exact corruption confirmed live ("Dragonborn UI for GTS - Resources": this restored
        // the plain, active "Disable Map Markers.esp" right alongside the still-present ".ghost").
        const theirsLower = new Set(Object.keys(theirs).map((k) => k.toLowerCase()));
        const missingFromStaging = Object.keys(oursForDiff).filter((p) => !theirsLower.has(p.toLowerCase()));
        for (const p of missingFromStaging) {
            const destPath = path.join(stagingModDir, p);
            fs.mkdirSync(path.dirname(destPath), { recursive: true });
            fs.copyFileSync(path.join(rebuildingDir, p), destPath);
        }
        fs.rmSync(rebuildingDir, { recursive: true, force: true });
        // Game-edited files need no special handling here -- "keep-existing" already never
        // overwrites anything staging has (a "changed" one is simply never touched) and never
        // deletes a staging-only file (a "missing" one was never in oursForDiff/the archive to
        // begin with, so it was never a missingFromStaging candidate). Counted in the note purely
        // for an accurate total, same as ESL-only/ghost already are.
        const keptCount = missingAfterGameEdited.length + realChanged.length + eslOnly.length + gameEditedFilesKept.length;
        return {
            status: 'REBUILT',
            fileCount: Object.keys(theirs).length + missingFromStaging.length,
            restoredMissingFiles: missingFromStaging.length > 0 ? missingFromStaging : undefined,
            ghostPreserved: ghostSkipped.length > 0 ? ghostSkipped : undefined,
            gameEditedFilesKept: gameEditedFilesKept.length > 0 ? gameEditedFilesKept : undefined,
            resolvedVia: 'keep-existing',
            note: `Manually resolved (kept existing staged files as-is): ${keptCount} file(s) left untouched `
                + `(${realChanged.length} changed, ${missingAfterGameEdited.length} missing-from-archive, ${eslOnly.length} ESL-only, ${gameEditedFilesKept.length} game/plugin-edited), `
                + `${missingFromStaging.length} file(s) restored that staging was missing entirely.`
                + (ghostSkipped.length > 0 ? ` ${ghostSkipped.length} file(s) Vortex-disabled (.ghost) left untouched: ${ghostSkipped.join(', ')}.` : '')
                + (gameEditedFilesKept.length > 0 ? ` ${gameEditedFilesKept.length} file(s) the game/a plugin edits during play (.log/.ini/.json) left untouched: ${gameEditedFilesKept.join(', ')}.` : ''),
            skippedFiles: skippedFiles.length > 0 ? skippedFiles : undefined,
        };
    }

    // Every "changed" file (if any) was ESL-only -- carry the CURRENT (ESL-flagged) copy forward
    // into the verified rebuild instead of letting the archive's non-flagged version win, so the
    // user's local ESL choice survives this rebuild same as it would have survived untouched.
    // Skipped entirely for resolveMode 'all' -- that mode means a true full replace, discarding
    // even a deliberate local ESL choice, matching the user's own description of it.
    if (resolveMode !== 'all') {
        for (const p of eslOnly) {
            fs.copyFileSync(path.join(stagingModDir, p), path.join(rebuildingDir, p));
        }
        // Same reasoning as the ESL-preserve loop above: without this, the swap below would install
        // rebuildingDir (which never contains a ".ghost" file -- a fresh archive extraction never
        // has one) wholesale, silently discarding the user's Vortex disable choice on every ordinary
        // rebuild, not just a manually-resolved mismatch.
        applyGhostPreservation(stagingModDir, rebuildingDir, ghostSkipped);
        // Carries the user's CURRENT .log/.ini/.json copies forward -- for a "changed" one this
        // overwrites the archive's version rebuildingDir already has; for a "missing" one (staging-
        // only, e.g. a plugin-created settings file the archive never shipped) rebuildingDir has no
        // such path at all yet, hence the explicit mkdirSync unlike the ESL-only loop above (which
        // only ever overwrites a file already extracted there). Never let a rebuild silently reset
        // settings, wipe a growing log, or delete a plugin-created config -- see game-edited-
        // files.js for the real report this fixes.
        for (const p of gameEditedFilesKept) {
            const destPath = path.join(rebuildingDir, p);
            fs.mkdirSync(path.dirname(destPath), { recursive: true });
            fs.copyFileSync(path.join(stagingModDir, p), destPath);
        }
    }

    // Verified good -- swap it in. This is the ONLY moment that touches the real folder: move the
    // old content aside (same directory, ".old" suffix), move the new content in, discard the
    // old. Retries transient Windows lock errors up to 3 times before giving up -- and even then,
    // this no longer needs a human unless the rollback itself can't put the original back; see
    // swapInRebuiltMod()'s own header comment for the full retry/rollback story.
    const swapResult = await swapInRebuiltMod({
        stagingModDir, rebuildingDir, oldContentDir, hasExisting: true,
        targetFolderName: action.targetFolderName, archivePath: action.archivePath,
    });
    if (!swapResult.ok) {
        const { ok, ...failure } = swapResult;
        return failure;
    }

    // 'all' means a true full replace -- same reasoning as the ESL-only-choice precedent, a ".ghost"
    // disable choice doesn't survive it either. It's already gone from disk at this point (the swap
    // above discarded the old folder, which was the only place the ".ghost" file ever lived) -- this
    // is just surfacing that loudly instead of leaving it silent, per the user's explicit request.
    const noteParts = [];
    if (resolveMode === 'all' && hasMismatch) {
        noteParts.push(`Manually resolved (full replace): archive version installed outright, discarding `
            + `${realChanged.length} changed + ${missingAfterGameEdited.length} staging-only file(s) that differed `
            + `(including any ESL-only local choice).`);
    }
    if (resolveMode === 'all' && ghostSkipped.length > 0) {
        noteParts.push(`${ghostSkipped.length} Vortex-disabled (.ghost) file(s) found and removed -- `
            + `a full replace does not preserve a disable choice: ${ghostSkipped.join(', ')}.`);
    }
    if (resolveMode === 'all' && gameEditedFilesKept.length > 0) {
        noteParts.push(`${gameEditedFilesKept.length} file(s) the game/a plugin edits during play (.log/.ini/.json) `
            + `were overwritten by the archive's own version -- a full replace does not preserve local changes to `
            + `these either: ${gameEditedFilesKept.join(', ')}.`);
    }

    // Recomputed AFTER the preservation copies above (ESL-only, ghost, game-edited-missing) -- a
    // "missing" game-edited file (e.g. a plugin-created .json the archive never shipped) is copied
    // INTO rebuildingDir there, genuinely growing the file count beyond what `ours` captured at the
    // top of this function, before any of those copies happened.
    const finalFileCount = resolveMode === 'all' ? Object.keys(ours).length : Object.keys(buildManifest(rebuildingDir)).length;

    return {
        status: 'REBUILT',
        fileCount: finalFileCount,
        restoredMissingFiles: diff.added.length > 0 ? diff.added : undefined,
        eslPreserved: resolveMode !== 'all' && eslOnly.length > 0 ? eslOnly : undefined,
        ghostPreserved: resolveMode !== 'all' && ghostSkipped.length > 0 ? ghostSkipped : undefined,
        gameEditedFilesKept: resolveMode !== 'all' && gameEditedFilesKept.length > 0 ? gameEditedFilesKept : undefined,
        resolvedVia: resolveMode === 'all' ? 'all' : undefined,
        note: noteParts.length > 0 ? noteParts.join(' ') : undefined,
        skippedFiles: skippedFiles.length > 0 ? skippedFiles : undefined,
        attempts: swapResult.attempts > 1 ? swapResult.attempts : undefined,
        leftoverOldFolder: swapResult.leftoverOldFolder,
    };
}

// swapInRebuiltMod exported alongside the two real entry points purely so scripts/test-swap-in-
// rebuilt-mod.js can exercise it directly (real filesystem, real OS-level locks) without needing a
// full classify+extract+diff pipeline around it -- rebuildMod() itself is the only production caller.
module.exports = { classifyMod, rebuildMod, swapInRebuiltMod };
