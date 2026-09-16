'use strict';
// Files a running game/SKSE plugin/MCM legitimately writes to DURING PLAY -- a growing .log, an
// .ini/.json settings file the player or a mod's own in-game menu changed. A difference here is
// never a real "the archive extraction doesn't match staging" problem the way an .esp/.bsa
// difference is -- it's just normal, expected drift this tool must not treat as a mismatch, and
// must never silently reset when it swaps a rebuilt mod into place.
//
// Real report (2026-09-14, Gate To Sovngarde rebuild): "Actor Limit Fix - Anniversary Edition" and
// "Bug Fixes SSE - Anniversary Edition" both flagged FAILED_MISMATCH_NOT_TOUCHED purely because
// their own SKSE plugin ".log" files (skse/plugins/actorlimitfix.log, .../bugfixessse.log) had
// grown since the archive was authored. ".ini"/".json" settings files (SKSE plugin settings, MCM
// settings, and similar) hit the exact same false positive for the exact same reason.
//
// What each diff list actually means here (see rebuild-mod.js's own header comment for the full
// story): `changed` = same path, different content in staging vs. the fresh archive extraction --
// for one of these extensions, keep the STAGING (current, played-with) copy, not the archive's.
// `missing` = present in staging, absent from the archive (e.g. a plugin creates its own settings
// file on first run that the archive never shipped at all) -- keep it, don't let a rebuild delete
// it. `added` (archive-only) is DELIBERATELY untouched by this module -- that's the normal "the
// archive has this brand-new default file, staging doesn't yet" case, and extracting it is exactly
// right regardless of extension; nothing here should suppress it.
//
// Deliberately only these three extensions -- the ones actually confirmed real-world. Widening
// this list needs its own confirmed real case, not a guess: a .esp/.esm/.esl/.bsa/.ba2/.pex
// difference is almost always a genuine problem, never something to silently wave through.

const path = require('path');

const GAME_EDITED_EXTENSIONS = new Set(['.log', '.ini', '.json']);

function isGameEditedFile(relativePath) {
    return GAME_EDITED_EXTENSIONS.has(path.extname(relativePath).toLowerCase());
}

// Removes every game-edited path from BOTH `changed` and `missing` (returns new arrays; never
// mutates the inputs). `added` is untouched entirely -- not even accepted as a parameter -- so a
// caller can't accidentally wire this into suppressing it too.
// Returns { changed, missing, gameEditedFilesKept } -- the last one is every removed path,
// deduplicated (a path can only ever appear in one of the two source lists, but de-duping here
// keeps this safe if a caller ever passes overlapping data) and sorted, for both logging and for
// the caller to actually copy those paths forward from staging when it swaps the rebuild into
// place (see rebuild-mod.js's own use of this).
function stripGameEditedMismatches(changed, missing) {
    const kept = new Set();
    const filterOut = (p) => {
        if (!isGameEditedFile(p)) return true;
        kept.add(p);
        return false;
    };
    const filteredChanged = changed.filter(filterOut);
    const filteredMissing = missing.filter(filterOut);
    return { changed: filteredChanged, missing: filteredMissing, gameEditedFilesKept: [...kept].sort() };
}

module.exports = { GAME_EDITED_EXTENSIONS, isGameEditedFile, stripGameEditedMismatches };
