'use strict';
// Ported verbatim from the standalone Archive File Finder project (folded into this project
// 2026-07-28 -- see TECHNICAL.md's "Archive Finder" section).

// Some archives (packaging mistakes) contain entries stored under an absolute Windows path (e.g.
// "C:\Users\someone\Desktop\mod\...") instead of a path relative to the archive root. These aren't
// real mod content -- filter them out everywhere archive contents are read.
function isAbsoluteJunkEntry(internalPath) {
    return /^[A-Za-z]:[\\/]/.test(internalPath);
}

module.exports = { isAbsoluteJunkEntry };
