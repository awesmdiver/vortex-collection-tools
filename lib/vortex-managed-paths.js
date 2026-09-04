'use strict';
// Which of this project's own configured folders are folders VORTEX ITSELF actively manages -- i.e.
// places Vortex creates/moves/deletes files in as part of its own normal operation, where another
// app holding a file open (even briefly, even read-only) can produce a real "File busy" error FOR
// VORTEX, not just for us.
//
// Confirmed real, live (GitHub issue #4, 2026-08-27): Archive Finder's own index database, pointed
// at the Vortex downloads folder (a completely natural reading of "where should the archive index
// live" -- the archives are right there), held a WAL-locked handle open for the life of the server.
// Vortex itself could not touch that folder at all until the server was closed from the tray:
//
//   Vortex needs to access "...\archive.db" but it's open in another application. Please close the
//   file in all other applications and then retry.
//
// Scoped to `downloads`/`staging` specifically -- these are the two folders Vortex is CONTINUOUSLY,
// actively working in (extracting/moving/deleting mod archives and mod files) as its own core job,
// not just an occasional touch. skyrimDataDir/pluginsListDir (the game's own folders, per
// app-config.js's own comment) are READ-ONLY inputs to this app and are touched by Vortex only
// during an explicit deploy -- a narrower, less continuous exposure, deliberately left out here
// rather than assumed to need the same treatment.

const { isPathInside } = require('./path-containment');

// Returns { label, path } describing the FIRST Vortex-managed folder `candidatePath` collides with
// (is equal to, or sits anywhere inside), or null if it's clear of all of them. Either config field
// can legitimately be unset (a fresh install with only some settings filled in yet); a missing field
// is simply skipped, never treated as a match.
function findVortexManagedConflict(candidatePath, { downloads, staging } = {}) {
    if (!candidatePath) return null;
    const managed = [
        { label: 'Vortex downloads folder', path: downloads },
        { label: 'Vortex staging (mods) folder', path: staging },
    ];
    for (const m of managed) {
        if (m.path && isPathInside(candidatePath, m.path)) return m;
    }
    return null;
}

module.exports = { findVortexManagedConflict };
