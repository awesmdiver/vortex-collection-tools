'use strict';
// Canonical, case-insensitive path-containment check. Windows/NTFS is case-insensitive but
// case-PRESERVING, and a symlink/junction or an 8.3 short name can make two visually different
// strings resolve to the identical real folder -- a trailing slash or different casing must never
// defeat a containment check that guards something consequential (this project is Windows-only
// throughout, so case-insensitivity is always correct here, not just a special case).

const fs = require('fs');
const path = require('path');

// Resolves as far toward the real, on-disk path as possible without throwing: fs.realpathSync
// (follows symlinks/junctions, resolves 8.3 short names, normalizes casing to whatever's actually
// on disk) when the path exists, falling back to a plain path.resolve (still normalizes '..'/'.'/
// a trailing slash) when it doesn't -- a folder being validated doesn't necessarily exist yet (e.g.
// a Settings field the user just typed but hasn't saved/created).
function canonicalize(p) {
    const resolved = path.resolve(p);
    try {
        return fs.realpathSync(resolved);
    } catch {
        return resolved;
    }
}

// True if `candidate` IS `base`, or sits anywhere inside it -- case-insensitive and canonical (see
// header comment). False if either argument is missing/blank, never throws.
function isPathInside(candidate, base) {
    if (!candidate || !base) return false;
    const c = canonicalize(candidate).toLowerCase();
    const b = canonicalize(base).toLowerCase();
    const bWithSep = b.endsWith(path.sep) ? b : b + path.sep;
    return c === b || c.startsWith(bWithSep);
}

module.exports = { isPathInside, canonicalize };
