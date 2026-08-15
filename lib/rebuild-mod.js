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
const path = require('path');
const { spawn } = require('child_process');

const { locateArchive } = require('./archive-locator');
const { formatBytes } = require('./format-bytes');
const { buildManifest } = require('./hash-manifest');
const { diffManifestsCaseInsensitive } = require('./diff-manifests-ci');
const { listArchive } = require('./sevenzip');
const { hasFomodInstaller } = require('./mod-root');
const { isPluginFile, checkEslOnlyDifference } = require('./esp-flag-diff');
const { stripGhostPairs, applyGhostPreservation } = require('./ghost-files');

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
function describeArchiveMismatch(code, source) {
    const name = source?.logicalFilename;
    const sizeText = formatBytes(source?.fileSize);
    const md5Short = source?.md5 ? `${source.md5.slice(0, 8)}…` : null;
    const expectedBits = [name && `'${name}'`, sizeText, md5Short && `md5 ${md5Short}`].filter(Boolean);
    const expected = expectedBits.length > 0 ? ` This collection expects ${expectedBits.join(', ')}.` : '';
    const lead = code === 'HASH_MISMATCH'
        ? "An archive close to the expected size was found in your downloads folder, but it doesn't match."
        : 'No archive matching this mod was found in your downloads folder.';
    return `${lead}${expected} If a different version was downloaded since this collection was last synced, that's likely why -- try Download Archive to get the exact version, or update the collection.`;
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
async function classifyMod(mod, { downloadsDir, stagingDir, knownVortexModId, sevenZipExe, forceExtractOffSiteMismatch = false, overrideArchivePath = null, exceptionMatcher = () => false }) {
    if (exceptionMatcher(mod)) {
        return { kind: 'SKIP_EXCEPTED', detail: 'On the Mod Exceptions list -- never auto-fixed here. Remove it from the list (Reports > Mod Exceptions) if you want this tool to manage it again.' };
    }
    let archivePath;
    let forcedMismatch = false;
    let importedOverride = false;
    if (overrideArchivePath && fs.existsSync(overrideArchivePath)) {
        archivePath = overrideArchivePath;
        importedOverride = true;
    } else try {
        archivePath = await locateArchive(downloadsDir, mod.source);
    } catch (e) {
        const isOffSite = mod.source?.type !== 'nexus';
        if (e.code === 'HASH_MISMATCH' && isOffSite && forceExtractOffSiteMismatch && e.candidates?.length > 0) {
            archivePath = e.candidates[0];
            forcedMismatch = true;
        } else {
            // NOT_FOUND and HASH_MISMATCH both mean "we don't have the correct archive" from the user's
            // perspective -- a HASH_MISMATCH candidate is a same-size-by-coincidence file that isn't the
            // real one (confirmed real-world: a 441-byte mod and a completely unrelated 441-byte archive
            // happened to collide on size), so it gets the same friendly rewrite AND is equally eligible
            // for auto-download (downloading the real file fixes this cleanly; the irrelevant candidate
            // just fails the md5 check again and is ignored, same as before). AMBIGUOUS is genuinely
            // different -- multiple candidates that ARE byte-identical correct matches, a genuine
            // duplicate-file situation (confirmed real-world: two byte-identical copies of the same
            // archive under different filenames) -- gets its own friendly message + the full
            // candidate list, so the log/Work Through Report can offer a "delete one of these" UI
            // instead of a dead-end error. Downloading again would only add a third correct copy.
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
    }

    const archiveBaseName = path.basename(archivePath, path.extname(archivePath));
    const targetFolderName = knownVortexModId || archiveBaseName;
    const stagingModDir = path.join(stagingDir, targetFolderName);
    const existingStagingFolder = fs.existsSync(stagingModDir);

    return {
        kind: 'REBUILD', targetFolderName, archivePath, stagingModDir, existingStagingFolder,
        forcedMismatch: forcedMismatch || undefined, importedOverride: importedOverride || undefined,
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
function runExtract(mod, { collectionJsonPath, downloadsDir, stagingDir, folderName, archivePath }) {
    return new Promise((resolve, reject) => {
        const child = spawn(
            process.execPath,
            [
                'lib/extract-mod.js', mod.name, '--collection', collectionJsonPath, '--downloads', downloadsDir,
                '--output', stagingDir, '--folder-name', folderName, '--archive-path', archivePath,
            ],
            { cwd: PROJECT_ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
        );
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code !== 0) {
                const err = new Error(`Command failed with exit code ${code}`);
                err.stdout = stdout;
                err.stderr = stderr;
                err.status = code;
                reject(err);
                return;
            }
            resolve();
        });
    });
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
async function rebuildMod(mod, action, { collectionJsonPath, downloadsDir, stagingDir }, resolveMode) {
    const stagingModDir = action.stagingModDir;
    const rebuildingDir = `${stagingModDir}.rebuilding`;
    const rebuildingFolderName = `${action.targetFolderName}.rebuilding`;
    const oldContentDir = `${stagingModDir}.old`;

    // Defensive: a ".rebuilding" folder already sitting here means a previous run was
    // interrupted before it could finish -- self-evidently abandoned, safe to clear and retry.
    fs.rmSync(rebuildingDir, { recursive: true, force: true });

    try {
        await runExtract(mod, { collectionJsonPath, downloadsDir, stagingDir, folderName: rebuildingFolderName, archivePath: action.archivePath });
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
        // result into place.
        fs.renameSync(rebuildingDir, stagingModDir);
        // A leftover ".old" here means a PRIOR run's swap hit CRITICAL_MANUAL_RESTORE_NEEDED and
        // left the real slot missing -- exactly the state that puts this mod on the "doesn't exist
        // yet" path on the very next classify. Confirmed live: without this, a bare Resume (no
        // manual fix first) silently re-extracts the mod correctly but leaves ".old" behind forever
        // as orphaned debris, since nothing else in this branch ever looks at it. Same "self-
        // evidently abandoned, safe to clear" reasoning already applied to ".rebuilding" above.
        fs.rmSync(oldContentDir, { recursive: true, force: true });
        const ours = buildManifest(stagingModDir);
        return {
            status: 'REBUILT',
            fileCount: Object.keys(ours).length,
            createdFromScratch: true,
            note: 'staging folder did not exist at all before this run -- entire mod recreated from its archive',
        };
    }

    const ours = buildManifest(rebuildingDir);
    const theirs = buildManifest(stagingModDir);

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
    const eslOnly = diff.changed.filter((p) => {
        if (!isPluginFile(p)) return false;
        const result = checkEslOnlyDifference(path.join(stagingModDir, p), path.join(rebuildingDir, p));
        return result !== null;
    });
    const realChanged = diff.changed.filter((p) => !eslOnly.includes(p));
    const eslNote = eslOnly.length > 0
        ? ` -- ${eslOnly.length} file(s) Marked as Light locally, left unchanged (no real content difference): ${eslOnly.join(', ')}`
        : '';

    const hasMismatch = diff.missing.length > 0 || realChanged.length > 0;

    if (hasMismatch && !resolveMode) {
        // Genuine regression risk -- the fresh extraction may itself be wrong. The real folder was
        // NEVER touched, so there's nothing to roll back; just discard the rebuilt attempt.
        fs.rmSync(rebuildingDir, { recursive: true, force: true });
        return {
            status: 'FAILED_MISMATCH_NOT_TOUCHED',
            detail: `missing=${diff.missing.length} changed=${realChanged.length} (added=${diff.added.length}, not a failure on its own)${eslNote}${ghostNote}`,
            missing: diff.missing, changed: realChanged, added: diff.added, changedEslOnly: eslOnly, ghostSkipped,
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
        const keptCount = diff.missing.length + realChanged.length + eslOnly.length;
        return {
            status: 'REBUILT',
            fileCount: Object.keys(theirs).length + missingFromStaging.length,
            restoredMissingFiles: missingFromStaging.length > 0 ? missingFromStaging : undefined,
            ghostPreserved: ghostSkipped.length > 0 ? ghostSkipped : undefined,
            resolvedVia: 'keep-existing',
            note: `Manually resolved (kept existing staged files as-is): ${keptCount} file(s) left untouched `
                + `(${realChanged.length} changed, ${diff.missing.length} missing-from-archive, ${eslOnly.length} ESL-only), `
                + `${missingFromStaging.length} file(s) restored that staging was missing entirely.`
                + (ghostSkipped.length > 0 ? ` ${ghostSkipped.length} file(s) Vortex-disabled (.ghost) left untouched: ${ghostSkipped.join(', ')}.` : ''),
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
    }

    // Verified good -- swap it in. This is the ONLY moment that touches the real folder: move the
    // old content aside (same directory, ".old" suffix), move the new content in, discard the
    // old. If this specific step is interrupted, it needs a human (see
    // CRITICAL_MANUAL_RESTORE_NEEDED) -- but this window is a couple of near-instant
    // same-directory renames, not the whole extraction+comparison that came before it.
    try {
        fs.rmSync(oldContentDir, { recursive: true, force: true }); // clear any stale leftover first
        fs.renameSync(stagingModDir, oldContentDir);
        fs.renameSync(rebuildingDir, stagingModDir);
        fs.rmSync(oldContentDir, { recursive: true, force: true });
    } catch (swapErr) {
        // Friendly, actionable instruction as the primary detail -- the raw technical reason
        // (swapErr.message) and the three real paths are still fully preserved in
        // oldContentDir/rebuildingDir/stagingModDir below (used as-is by the live critical-halt
        // banner's own structured fields), just no longer embedded in this user-facing string.
        return {
            status: 'CRITICAL_MANUAL_RESTORE_NEEDED',
            detail: 'Mod failed to extract properly, extraction halted. Please go back to home page, '
                + 'reselect the collection and View Collection. Check the "Resume from previous '
                + 'incomplete run" option and Start Rebuild to resolve this issue.',
            oldContentDir, rebuildingDir, stagingModDir,
        };
    }

    // 'all' means a true full replace -- same reasoning as the ESL-only-choice precedent, a ".ghost"
    // disable choice doesn't survive it either. It's already gone from disk at this point (the swap
    // above discarded the old folder, which was the only place the ".ghost" file ever lived) -- this
    // is just surfacing that loudly instead of leaving it silent, per the user's explicit request.
    const noteParts = [];
    if (resolveMode === 'all' && hasMismatch) {
        noteParts.push(`Manually resolved (full replace): archive version installed outright, discarding `
            + `${realChanged.length} changed + ${diff.missing.length} staging-only file(s) that differed `
            + `(including any ESL-only local choice).`);
    }
    if (resolveMode === 'all' && ghostSkipped.length > 0) {
        noteParts.push(`${ghostSkipped.length} Vortex-disabled (.ghost) file(s) found and removed -- `
            + `a full replace does not preserve a disable choice: ${ghostSkipped.join(', ')}.`);
    }

    return {
        status: 'REBUILT',
        fileCount: Object.keys(ours).length,
        restoredMissingFiles: diff.added.length > 0 ? diff.added : undefined,
        eslPreserved: resolveMode !== 'all' && eslOnly.length > 0 ? eslOnly : undefined,
        ghostPreserved: resolveMode !== 'all' && ghostSkipped.length > 0 ? ghostSkipped : undefined,
        resolvedVia: resolveMode === 'all' ? 'all' : undefined,
        note: noteParts.length > 0 ? noteParts.join(' ') : undefined,
    };
}

module.exports = { classifyMod, rebuildMod };
