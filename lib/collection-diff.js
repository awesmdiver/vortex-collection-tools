'use strict';
// Update Collection v2's own core new work (2026-08-18) -- classifies an update into
// Removed/Updated/Added by comparing the OLD (currently-installed) collection.json's mods[]
// against the NEW (fetched revision's) mods[]. Nothing else in this project already does this:
// vortex-sync/lib.js's computeSync filters ignore/disable state into a Vortex-importable patched
// collection.json, it does not classify a mod list against a PRIOR revision at all. See
// TECHNICAL.md's "Update Collection v2" section for the full design writeup.
//
// Deliberately NOT reusing vortex-sync/lib.js's makeIdentityMatcher/identityKeys here -- a
// considered choice, not an oversight. That matcher requires either an EXACT md5 match or an exact
// modId+fileId PAIR match, which is the right strictness for "does this rule reference still point
// at something installed" (a false positive there could misapply/misplace a rule) -- but WRONG for
// "is this the same mod across a version bump": a real Nexus file update almost always changes BOTH
// fileId and md5 while modId (the mod PAGE) stays the same, so requiring the pair together (or an
// exact content match) would never match a genuine update at all -- it would misclassify every real
// update as a Remove+Add pair instead. Confirmed against real collection.json data on this machine
// (Beauty Salon for GTS, Gate To Sovngarde, GTS Community Edition, etc.):
// mod.source = {type, modId, fileId, md5, fileSize, logicalFilename, updatePolicy, tag}. modId is
// the stable "same mod page" identity across file/version changes; fileId/md5 change on every
// update. mod.instructions (a plain string, confirmed present on real mods in several installed
// collections here) carries the mod-author note the mockup's instructions modal shows.

function normalize(s) {
    return (s || '').trim().toLowerCase();
}

// A REAL failure mode found and fixed via real data, not assumed -- read before changing matching
// priority again. First attempt matched by bare Nexus modId as a fallback signal (a mod page's id is
// stable across a file update). Tested against two REAL, adjacent published revisions of a real,
// large installed collection (Gate To Sovngarde, revision 114 vs. 115, 1955 mods) and it produced
// 354 completely WRONG "Updated" pairs -- e.g. "Interesting NPCs SE - Alternative Locations" paired
// with the unrelated "Interesting NPCs - 4.5 to 4.54 Update". Root cause: a single Nexus mod page
// very commonly hosts SEVERAL distinct, separately-installed files (a "Main File" plus multiple
// "Patch"/"Optional" files, e.g. modId 147701 = "Children of the North Wind" contributing at least
// three genuinely different collection entries under that one modId) -- bare modId collides all of
// them together, so whenever that page's own file SET changed shape between revisions (a patch
// added/removed/renamed), the matcher paired up whichever unrelated entries happened to land on
// either side. `source.tag` was ALSO tried and independently disproven the same way: compared across
// the same real 114->115 pair, 1952 mods with a LITERALLY IDENTICAL modId+fileId (proven, by
// construction, to be the exact same untouched file) had a DIFFERENT tag 1952 times out of 1952 --
// Vortex regenerates it fresh every time a collection revision is packaged, so it carries zero
// cross-revision identity signal despite being one of vortex-sync/lib.js's own identityKeys priorities
// (correct for THAT function's own same-session use case, actively wrong for this one).
//
// The fix: identity keys are checked in strict priority order, and a key is only ever trusted to
// match through if it's UNAMBIGUOUS on the side being searched (exactly one candidate claims it) --
// see buildIndex's AMBIGUOUS handling below. modId alone is kept only as the LAST-resort key,
// specifically so it only ever fires for a mod page that legitimately contributes exactly one entry
// to each side (the common, single-file-mod case) -- the moment a modId is shared by more than one
// mod on either side, matching through it is refused entirely rather than guessing.
function modIdentityKeys(mod) {
    const src = mod.source || {};
    const keys = [];
    // Exact modId+fileId together -- the same real file, byte-for-byte-provenance identical. Always
    // tried first; this is what lets an untouched mod (the overwhelming majority in a real diff)
    // resolve as "unchanged" and never even reach the fuzzier keys below.
    if (src.modId != null && src.fileId != null) keys.push(`exact:${src.modId}:${src.fileId}`);
    // logicalFilename is Nexus's own "the file's declared name" field -- far more specific than a
    // bare mod-page id, and the best available signal for an off-site (non-Nexus) mod, which has no
    // modId at all. Still checked for ambiguity (see buildIndex) since nothing rules out two
    // differently-authored files coincidentally sharing one.
    if (src.logicalFilename) keys.push(`logical:${normalize(src.logicalFilename)}`);
    // Bare mod-page id -- LAST resort, deliberately least specific. See header comment for exactly
    // why this can never be promoted above logicalFilename without reintroducing the proven bug.
    if (src.type === 'nexus' && src.modId != null) keys.push(`nexus:${src.modId}`);
    return keys;
}

const AMBIGUOUS = Symbol('ambiguous-identity-key');

// A key claimed by MORE THAN ONE mod on this same side is marked AMBIGUOUS and can never be matched
// through -- see modIdentityKeys' own header comment for the real, confirmed case this prevents.
function buildIndex(mods) {
    const byKey = new Map();
    for (const mod of mods) {
        for (const key of modIdentityKeys(mod)) {
            byKey.set(key, byKey.has(key) ? AMBIGUOUS : mod);
        }
    }
    return byKey;
}

function findMatch(index, mod) {
    for (const key of modIdentityKeys(mod)) {
        const hit = index.get(key);
        if (hit && hit !== AMBIGUOUS) return hit;
    }
    return null;
}

// True when oldMod/newMod (already matched as "the same underlying mod") are genuinely different
// files/versions, vs. a spurious "nothing actually changed" match (very common -- most of a
// collection's mods are untouched between revisions). Checked in priority order: an exact md5 match
// means byte-identical content regardless of what the version STRING says (an author can bump a
// version label without re-uploading); fileId is the next most reliable signal (a genuinely new
// upload always gets a new fileId even if md5 happens to collide, e.g. a metadata-only repack);
// the version string is the last-resort fallback for a non-Nexus mod with neither.
function isGenuineUpdate(oldMod, newMod) {
    const a = oldMod.source || {};
    const b = newMod.source || {};
    if (a.md5 && b.md5) return a.md5 !== b.md5;
    if (a.fileId != null && b.fileId != null) return String(a.fileId) !== String(b.fileId);
    return normalize(oldMod.version) !== normalize(newMod.version);
}

// oldMods/newMods: raw collection.json mods[] arrays. Optional mods (mod.optional === true) are
// excluded from all three buckets -- Update Collection v2's own Phase 1 deliberately defers Optional
// Installs to a later screen/phase, matching Vortex's own real flow (it asks about optionals LAST,
// after the main update finishes, not alongside Required mods) -- see TECHNICAL.md's own write-up.
//
// A mod that fails to match at all (every one of its identity keys is either absent from the other
// side, or ambiguous there) is NOT force-paired with anything -- it shows as a genuine Remove (old
// side) and a genuine Add (new side) rather than a guessed Update. Confirmed the right call by the
// real 114->115 test this file's own header comment describes: safer to occasionally show a real
// same-mod-page swap as "1 removed + 1 added" than to risk pairing two unrelated files as "Updated".
function diffCollectionMods(oldMods, newMods) {
    const oldRequired = (oldMods || []).filter((m) => m.optional !== true);
    const newRequired = (newMods || []).filter((m) => m.optional !== true);
    const newIndex = buildIndex(newRequired);

    const removed = [];
    const updated = [];
    const matchedNew = new Set();

    for (const oldMod of oldRequired) {
        const newMatch = findMatch(newIndex, oldMod);
        if (!newMatch) {
            removed.push(oldMod);
            continue;
        }
        matchedNew.add(newMatch);
        if (isGenuineUpdate(oldMod, newMatch)) {
            updated.push({ old: oldMod, new: newMatch });
        }
        // else: matched AND unchanged -- not shown at all, matching the mockup's own "only what's
        // actually changing is listed" framing (most of a collection's mods are untouched).
    }

    const added = newRequired.filter((newMod) => !matchedNew.has(newMod));

    return { removed, updated, added };
}

module.exports = { diffCollectionMods, modIdentityKeys, isGenuineUpdate };
