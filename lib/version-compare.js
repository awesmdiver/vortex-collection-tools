'use strict';
// Shared real-mod-version comparison -- moved out of lib/vortex-update-flags.js (2026-09-22) so
// lib/missing-files-scan.js can reuse the exact same normalization without a circular require
// (vortex-update-flags.js itself requires missing-files-scan.js for listPickableCollections).
//
// versionClean mirrors Vortex's own real source, versionClean.ts, exactly -- semver.coerce ->
// semver.valid -> semver.clean, falling back to '0.0.0-' + the raw input when it isn't coercible
// at all (so two different uncoercible strings still compare as different, never silently
// collapse to equal). This is the same normalization vortex-update-flags.js's own hasUpdateFlag
// already uses to faithfully port Vortex's modUpdateState.ts -- reused here rather than a second,
// naive string comparison (which breaks on real mod version strings like "1.10" vs "1.9" -- a
// plain string ">" reads "1.9" as greater since '9' > '1').
const semver = require('semver');

function versionClean(input) {
    let res = semver.valid(semver.coerce(input, { includePrerelease: true }));
    if (res !== null) res = semver.clean(res);
    return res || '0.0.0-' + input;
}

// True only when BOTH versions are known and `a` is strictly newer than `b` -- null/undefined on
// either side means "nothing to compare," never a false positive.
function isVersionNewer(a, b) {
    if (a == null || b == null) return false;
    return semver.gt(versionClean(a), versionClean(b));
}

module.exports = { versionClean, isVersionNewer };
