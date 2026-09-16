'use strict';
// Replicates the ORDER Vortex's own extracted file list ends up in -- NOT the archive's own listing
// order (7z's `-slt` order, what this project used before this fix). Confirmed 2026-09-16 by reading
// Vortex's real source directly (see config/vortex-source-refs.json's own "vortex-walk-order" entry):
// Vortex extracts an archive to a temp folder FIRST, then builds its install file list by walking
// that real folder on disk (`src/renderer/src/extensions/mod_management/InstallManager.ts`'s
// `buildFileList()`, which calls `src/renderer/src/util/walk.ts`'s `walk()`) -- an archive's own
// internal listing order (what 7z reports) has no bearing on the real order at all.
//
// walk()'s real algorithm (read directly, not assumed): `fs.readdirAsync(target)` for one directory,
// then EVERY direct child (file or subdirectory, as a bare path -- not yet expanded) is added to the
// list in that readdir order, THEN each subdirectory is recursed into, ONE AT A TIME, in that SAME
// readdir order -- each subdirectory's entire subtree is fully walked (recursively, by the same
// rule) before the NEXT sibling subdirectory even starts. Net effect for two paths that diverge at
// some shared ancestor directory: whichever diverging PATH SEGMENT sorts first in that ancestor's
// own readdir order has its entire subtree appear earlier in the overall file list -- nesting depth
// never matters, only the sibling order at the point the two paths first differ. Confirmed against
// the task's own real example: "00 Main\fomod\ModuleConfig.xml" beats a shallower
// "fomod\ModuleConfig.xml" at the archive root, because "00 Main" and "fomod" are ROOT-level
// siblings and "00 Main" sorts first -- despite its own match sitting one folder deeper.
//
// readdir order on NTFS (what Windows' FindFirstFile/FindNextFile -- and so Node's fs.readdir --
// returns, which is what a real, on-disk extracted Vortex temp folder uses) is NOT plain JavaScript
// string order: NTFS's own directory index collates names by comparing an UPPERCASED, per-UTF-16-
// code-unit ordinal value (a fixed case-fold baked into the filesystem driver), not a locale-aware
// sort and not a raw mixed-case ordinal sort (which would put every uppercase letter before every
// lowercase one, unlike NTFS's case-insensitive behavior). Reproduced here as: uppercase each path
// segment, then compare with plain JS string relational operators (already per-UTF-16-code-unit
// ordinal, not locale-aware) -- a close, well-documented approximation for the ASCII/Latin mod-name
// content this project actually sees, not a byte-for-byte reimplementation of the NTFS driver's own
// (older, fixed) Unicode case-fold table.
function compareVortexWalkOrder(pathA, pathB) {
    const segsA = pathA.split(/[\\/]/);
    const segsB = pathB.split(/[\\/]/);
    const len = Math.min(segsA.length, segsB.length);
    for (let i = 0; i < len; i++) {
        const a = segsA[i].toUpperCase();
        const b = segsB[i].toUpperCase();
        if (a !== b) return a < b ? -1 : 1;
    }
    return segsA.length - segsB.length;
}

// Sorts a real archive-entries-derived path list into Vortex's own real walk order, in place-safe
// fashion (returns a new array). Used wherever "the first match Vortex's own file list would produce"
// needs to be picked from a set of candidates found via a 7z listing (whose OWN order reflects the
// archive's internal storage order, not Vortex's real extracted-and-walked order).
function sortByVortexWalkOrder(paths) {
    return [...paths].sort(compareVortexWalkOrder);
}

module.exports = { compareVortexWalkOrder, sortByVortexWalkOrder };
