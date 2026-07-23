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
const { buildManifest } = require('./hash-manifest');
const { diffManifestsCaseInsensitive } = require('./diff-manifests-ci');
const { listArchive } = require('./sevenzip');
const { hasFomodInstaller } = require('./mod-root');
const { isPluginFile, checkEslOnlyDifference } = require('./esp-flag-diff');

const PROJECT_ROOT = path.join(__dirname, '..');

// knownVortexModId: this mod's REAL staging folder name per Vortex's own live state (looked up
// via findCurrentModIds before calling this), if Vortex has ever installed it before. Vortex
// assigns a mod's staging folder name once, at first install, and never renames it on update --
// it just refreshes the folder's contents in place. Confirmed this session against real data: a
// mod's CURRENT archive filename can differ from its real, Vortex-tracked folder name once the
// collection has been updated to a newer file version that hasn't actually been redeployed yet
// (e.g. because the mod is disabled). Trusting the archive's own filename in that case creates a
// wrong, duplicate folder Vortex doesn't know about, instead of correctly updating the real one.
async function classifyMod(mod, { downloadsDir, stagingDir, knownVortexModId, sevenZipExe }) {
    let archivePath;
    try {
        archivePath = await locateArchive(downloadsDir, mod.source);
    } catch (e) {
        return { kind: 'SKIP_NO_ARCHIVE', detail: e.message };
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

    return { kind: 'REBUILD', targetFolderName, archivePath, stagingModDir, existingStagingFolder };
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
function runExtract(mod, { collectionJsonPath, downloadsDir, stagingDir, folderName }) {
    return new Promise((resolve, reject) => {
        const child = spawn(
            process.execPath,
            [
                'extract-mod.js', mod.name, '--collection', collectionJsonPath, '--downloads', downloadsDir,
                '--output', stagingDir, '--folder-name', folderName,
            ],
            { cwd: PROJECT_ROOT, stdio: ['ignore', 'pipe', 'pipe'] }
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
async function rebuildMod(mod, action, { collectionJsonPath, downloadsDir, stagingDir }) {
    const stagingModDir = action.stagingModDir;
    const rebuildingDir = `${stagingModDir}.rebuilding`;
    const rebuildingFolderName = `${action.targetFolderName}.rebuilding`;

    // Defensive: a ".rebuilding" folder already sitting here means a previous run was
    // interrupted before it could finish -- self-evidently abandoned, safe to clear and retry.
    fs.rmSync(rebuildingDir, { recursive: true, force: true });

    try {
        await runExtract(mod, { collectionJsonPath, downloadsDir, stagingDir, folderName: rebuildingFolderName });
    } catch (e) {
        fs.rmSync(rebuildingDir, { recursive: true, force: true });
        return action.existingStagingFolder
            ? { status: 'FAILED_EXTRACTION_NOT_TOUCHED', detail: extractErrorDetail(e) }
            : { status: 'FAILED_EXTRACTION_NO_PRIOR_DATA', detail: extractErrorDetail(e) };
    }

    if (!action.existingStagingFolder) {
        // Nothing existed before, nothing to compare against -- just move the verified-extractable
        // result into place.
        fs.renameSync(rebuildingDir, stagingModDir);
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
    const diff = diffManifestsCaseInsensitive(theirs, ours);

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

    if (diff.missing.length > 0 || realChanged.length > 0) {
        // Genuine regression risk -- the fresh extraction may itself be wrong. The real folder was
        // NEVER touched, so there's nothing to roll back; just discard the rebuilt attempt.
        fs.rmSync(rebuildingDir, { recursive: true, force: true });
        return {
            status: 'FAILED_MISMATCH_NOT_TOUCHED',
            detail: `missing=${diff.missing.length} changed=${realChanged.length} (added=${diff.added.length}, not a failure on its own)${eslNote}`,
            missing: diff.missing, changed: realChanged, added: diff.added, changedEslOnly: eslOnly,
        };
    }

    // Every "changed" file (if any) was ESL-only -- carry the CURRENT (ESL-flagged) copy forward
    // into the verified rebuild instead of letting the archive's non-flagged version win, so the
    // user's local ESL choice survives this rebuild same as it would have survived untouched.
    for (const p of eslOnly) {
        fs.copyFileSync(path.join(stagingModDir, p), path.join(rebuildingDir, p));
    }

    // Verified good -- swap it in. This is the ONLY moment that touches the real folder: move the
    // old content aside (same directory, ".old" suffix), move the new content in, discard the
    // old. If this specific step is interrupted, it needs a human (see
    // CRITICAL_MANUAL_RESTORE_NEEDED) -- but this window is a couple of near-instant
    // same-directory renames, not the whole extraction+comparison that came before it.
    const oldContentDir = `${stagingModDir}.old`;
    try {
        fs.rmSync(oldContentDir, { recursive: true, force: true }); // clear any stale leftover first
        fs.renameSync(stagingModDir, oldContentDir);
        fs.renameSync(rebuildingDir, stagingModDir);
        fs.rmSync(oldContentDir, { recursive: true, force: true });
    } catch (swapErr) {
        return {
            status: 'CRITICAL_MANUAL_RESTORE_NEEDED',
            detail: `The verified-good rebuild couldn't be swapped into place: ${swapErr.message}. ` +
                `Original may be at "${oldContentDir}", verified-good new content at "${rebuildingDir}", ` +
                `real slot "${stagingModDir}" may be missing or partial. Restore by hand.`,
            oldContentDir, rebuildingDir, stagingModDir,
        };
    }

    return {
        status: 'REBUILT',
        fileCount: Object.keys(ours).length,
        restoredMissingFiles: diff.added.length > 0 ? diff.added : undefined,
        eslPreserved: eslOnly.length > 0 ? eslOnly : undefined,
    };
}

module.exports = { classifyMod, rebuildMod };
