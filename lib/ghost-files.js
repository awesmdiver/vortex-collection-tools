'use strict';
// Vortex's own "ghost" mechanism: appending ".ghost" to a deployed file's name marks it as
// present-but-disabled (e.g. right-click "never deploy this file", or a manual conflict-resolution
// choice) without deleting it. A fresh archive extraction never contains a ".ghost"-suffixed name --
// Vortex applies that suffix itself, after the fact, at deploy time.
//
// Confirmed live this session (Dragonborn UI for GTS - AE Resources, "disable map markers ae.esp"):
// treating a ghosted file as a plain missing/changed file corrupts the user's disable choice. Two
// distinct failure modes were possible: (1) a whole-folder swap (the normal, no-mismatch rebuild
// path) silently discards the ".ghost" file entirely, since the fresh extraction never has one to
// carry it forward; (2) the "Keep modified" manual merge restored the plain, ACTIVE file alongside
// the still-present ghost, leaving both "Disable Map Markers AE.esp" and "...esp.ghost" on disk at
// once -- exactly backwards from what the user intended.
//
// Fix: any ".ghost" file in the CURRENT staging folder that has a same-named (minus ".ghost")
// counterpart in the fresh archive extraction is treated as an intentional match, not a real
// difference. Per the user's own explicit call, no attempt is made to reconcile a ghosted file's
// content against a possibly-newer archive version -- simplest and safest is to leave it completely
// untouched and log that it was skipped, rather than silently re-enabling or duplicating it.

const fs = require('fs');
const path = require('path');

const GHOST_SUFFIX = '.ghost';

// Removes any ghost/plain pair that match up (case-insensitively, matching this project's existing
// NTFS-case-preservation convention -- see diff-manifests-ci.js) between `theirs` (current staging)
// and `ours` (fresh extraction), from BOTH manifests. Returns new objects; never mutates the inputs.
// The returned `ghostSkipped` list uses theirs' original-cased ".ghost" keys, suitable for both
// logging and re-locating the real file on disk afterward.
function stripGhostPairs(theirs, ours) {
    const oursLower = new Map(Object.keys(ours).map((k) => [k.toLowerCase(), k]));
    const theirsOut = { ...theirs };
    const oursOut = { ...ours };
    const ghostSkipped = [];

    for (const key of Object.keys(theirs)) {
        if (!key.toLowerCase().endsWith(GHOST_SUFFIX)) continue;
        const plainLower = key.slice(0, -GHOST_SUFFIX.length).toLowerCase();
        const oursPlainKey = oursLower.get(plainLower);
        if (!oursPlainKey) continue; // no archive counterpart -- a real difference, leave it to the normal diff
        delete theirsOut[key];
        delete oursOut[oursPlainKey];
        ghostSkipped.push(key);
    }

    return { theirs: theirsOut, ours: oursOut, ghostSkipped };
}

// Called just before a verified-good rebuild is swapped into place (or additively merged). For each
// skipped ghost path: deletes the plain, active file the fresh archive extracted into rebuildingDir
// (the user's ghost choice means that file must NOT go live), then copies the real ".ghost" file
// forward from the current staging folder unchanged, so the disabled state survives the rebuild.
function applyGhostPreservation(stagingModDir, rebuildingDir, ghostSkipped) {
    for (const ghostKey of ghostSkipped) {
        const plainRel = ghostKey.slice(0, -GHOST_SUFFIX.length);
        fs.rmSync(path.join(rebuildingDir, plainRel), { force: true });
        const ghostDest = path.join(rebuildingDir, ghostKey);
        fs.mkdirSync(path.dirname(ghostDest), { recursive: true });
        fs.copyFileSync(path.join(stagingModDir, ghostKey), ghostDest);
    }
}

// Returns true if `destination` exists under `dir`, either as the plain file or as its
// Vortex-ghosted (".ghost"-suffixed) counterpart -- a ghosted file is present-but-disabled per
// this file's own header, not missing. Used by Rebuild Missing Files' own existence checks
// (lib/missing-files-scan.js, web/rebuild-missing-routes.js), which -- unlike rebuildMod()'s
// manifest-diff path above -- test one destination path directly against the filesystem rather
// than comparing two in-memory directory-listing maps, so Windows' native case-insensitive path
// lookup already handles any casing difference for free; no manual lowercasing needed here the
// way stripGhostPairs needs it for its own map-key comparisons.
function existsPlainOrGhosted(dir, destination) {
    const destPath = path.join(dir, destination);
    return fs.existsSync(destPath) || fs.existsSync(`${destPath}${GHOST_SUFFIX}`);
}

module.exports = { stripGhostPairs, applyGhostPreservation, existsPlainOrGhosted, GHOST_SUFFIX };
