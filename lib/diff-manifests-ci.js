'use strict';
// Case-insensitive-path wrapper around diff-manifests.js's diffManifests(), used ONLY by
// rebuild-collection.js's own match/mismatch decision -- smoke-test-collection.js keeps the
// existing case-sensitive comparison unchanged.
//
// Confirmed this session: at least one real mod ("Lydia of Whiterun - SerketHetyt's Housecarls
// v2.0") has a byte-identical file whose path casing differs from Vortex's real staging output
// (an NTFS case-preservation artifact -- see README's "FaceGen path casing" note -- not a real
// content difference). An exact-string compare would treat that as a mismatch and trigger an
// unwanted rollback for a mod that's actually fine. Content is still compared by hash, unchanged
// -- only the path KEY used to match entries between the two manifests is folded to lowercase.

const { diffManifests } = require('./diff-manifests');

// Lowercases every path key in a manifest. Throws if two different-case original keys would
// collapse to the same lowercased key -- a real ambiguity worth surfacing loudly rather than
// silently resolving by overwriting one entry with the other.
function lowercaseManifestKeys(manifest) {
    const result = {};
    for (const [key, value] of Object.entries(manifest)) {
        const lower = key.toLowerCase();
        if (Object.prototype.hasOwnProperty.call(result, lower)) {
            throw new Error(
                `Manifest has two different-case paths that collapse to the same lowercase key: ` +
                `"${result[lower].__originalKey}" and "${key}" -- refusing to guess which is correct.`
            );
        }
        result[lower] = { ...value, __originalKey: key };
    }
    return result;
}

function diffManifestsCaseInsensitive(before, after) {
    return diffManifests(lowercaseManifestKeys(before), lowercaseManifestKeys(after));
}

module.exports = { diffManifestsCaseInsensitive };
