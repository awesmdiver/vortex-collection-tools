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
const STRICT_AMBIGUOUS = Symbol('strict-ambiguous-identity-key');

// Cross-collection "is this mod also required by another installed collection" detection --
// originally built for (and still used by) Safe Collection Removal's own reviewRemoval
// (remove-collection-runner.js). Relocated here 2026-08-21 so Update Collection v2's own
// Removed-mods review can reuse the EXACT same, already-proven matching logic (see this file's own
// module.exports comment) instead of a second copy -- collection-diff.js is the natural shared home
// since both callers already require it for modIdentityKeys, so this avoids a circular require
// between remove-collection-runner.js and update-collection-v2-runner.js (the former already
// requires the latter for listCollections/buildLiveIdentityIndex/resolveLiveModId).
//
// Deliberately does NOT reuse buildIndex/findMatch above wholesale -- only modIdentityKeys. That
// pair's last-resort bare-modId fallback key is correct for THIS file's own real purpose ("is this an
// update of the same mod across revisions" -- a version bump keeps modId but changes fileId, so the
// fallback is what lets an update match at all). It's WRONG for a "shared with another collection"
// check: two different fileIds under the same Nexus mod page are two genuinely DIFFERENT files (e.g.
// a mod's several separate optional/patch downloads), and removing one must never be blocked because
// another collection happens to use a DIFFERENT file from that same page. Confirmed as a real, live
// false positive 2026-08-19 against the director's own real collections: "GTS CE - Player Homes
// Patches" and four sibling patches (all distinct fileIds under Nexus modId 141199) were flagged as
// shared with "Body Swap updated"/"My GTS Audio Overhaul" purely via the bare-modId fallback;
// Vortex's own UI does not consider them shared, and the director confirmed live.
// buildSharedModIndex/findSharedModMatch below are the same md5/fileId/logicalName priority chain
// minus that one fallback key -- a real file/logical-name match still counts as shared, a
// same-mod-page-different-file coincidence no longer does.
function buildSharedModIndex(mods) {
    const byKey = new Map();
    for (const mod of mods) {
        for (const key of modIdentityKeys(mod)) {
            if (key.startsWith('nexus:')) continue;
            byKey.set(key, byKey.has(key) ? STRICT_AMBIGUOUS : mod);
        }
    }
    return byKey;
}

function findSharedModMatch(index, mod) {
    for (const key of modIdentityKeys(mod)) {
        if (key.startsWith('nexus:')) continue;
        const hit = index.get(key);
        if (hit && hit !== STRICT_AMBIGUOUS) return hit;
    }
    return null;
}

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

// A collection author can bump a revision that ONLY changes a mod's recorded install choices
// (`choices` -- the FOMOD/installer picks, see choice-resolver.js) with the exact same underlying
// file (same md5/fileId/version) -- confirmed real: `choices` is a well-established collection.json
// field this project already reads throughout (choice-resolver.js, collection-parser.js,
// extract-mod.js, etc.), so nothing stops an author from re-packaging a revision with different
// FOMOD selections alone. isGenuineUpdate below must treat that as a real update too, or the mod
// gets matched, found "file-identical", and silently excluded -- the user keeps running the OLD
// FOMOD selections despite the collection author having genuinely changed them.
//
// Structural compare, not reference/JSON-string equality -- key order and equivalent-but-
// differently-shaped data must not read as "changed". Mirrors choice-resolver.js's OWN real
// matching semantics exactly (read directly from that file, not guessed):
//   - `choices.options` (one entry per FOMOD install STEP) is matched POSITIONALLY by array index
//     (`choices.options[stepIdx]`) -- so step order is genuinely significant, a reorder is a real
//     difference.
//   - Within a step, `groups` are matched by trimmed NAME (`recordedStep.groups.find(g =>
//     g.name.trim() === ...)`), not position -- group order is NOT significant.
//   - Within a group, `choices` are matched as an unordered SET of `idx:name` pairs
//     (choice-resolver.js literally builds `new Set(recordedGroup.choices.map(c =>
//     \`${c.idx}:${c.name}\`))`) -- choice order is NOT significant either.
// So this compares steps positionally, but canonicalizes (sorts) groups-within-a-step and
// choices-within-a-group before comparing, to avoid a false "changed" from an order difference
// that choice-resolver.js itself would treat as identical.
function canonicalGroup(group) {
    const name = normalize(group && group.name);
    const choiceKeys = ((group && group.choices) || []).map((c) => `${c.idx}:${normalize(c.name)}`).sort();
    return `${name}|${choiceKeys.join(',')}`;
}

function canonicalStep(step) {
    const name = normalize(step && step.name);
    const groupKeys = ((step && step.groups) || []).map(canonicalGroup).sort();
    return `${name}|${groupKeys.join(';')}`;
}

// Generic structural-equality fallback (recursively sorts object keys, leaves array order intact)
// for a `choices.type` this project has never actually seen -- 'fomod' is the only real value ever
// checked anywhere in this codebase (extract-mod.js, rebuild-mod.js, update-collection-v2-runner.js
// all gate on `choices.type === 'fomod'` specifically), so an unrecognized type falls back to a
// plain compare rather than guessing at semantics that don't exist yet.
function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object') {
        const keys = Object.keys(value).sort();
        return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

function choicesEqual(oldChoices, newChoices) {
    const a = oldChoices || null;
    const b = newChoices || null;
    if (!a && !b) return true;
    if (!a || !b) return false;
    if (a.type !== b.type) return false;
    if (a.type !== 'fomod') return canonicalJson(a) === canonicalJson(b);
    const aSteps = (a.options || []).map(canonicalStep);
    const bSteps = (b.options || []).map(canonicalStep);
    return aSteps.length === bSteps.length && aSteps.every((s, i) => s === bSteps[i]);
}

// True when oldMod/newMod (already matched as "the same underlying mod") are genuinely different
// files/versions, vs. a spurious "nothing actually changed" match (very common -- most of a
// collection's mods are untouched between revisions). File identity checked in priority order: an
// exact md5 match means byte-identical content regardless of what the version STRING says (an
// author can bump a version label without re-uploading); fileId is the next most reliable signal (a
// genuinely new upload always gets a new fileId even if md5 happens to collide, e.g. a
// metadata-only repack); the version string is the last-resort fallback for a non-Nexus mod with
// neither. A file-identical match is STILL a genuine update if the recorded FOMOD choices differ
// (see choicesEqual above) -- same file, different install selections, is a real difference the
// old file-only check used to miss entirely.
// Exposed separately from isGenuineUpdate so callers (the v2 runner, for the review response) can
// tell a real file/version change apart from a choices-only one -- e.g. to label a choices-only row
// "FOMOD" instead of a same-to-same version arrow, and to skip "keep installed version" for it (that
// choice is about which FILE is installed, meaningless when the file never changed).
function didFileChange(oldMod, newMod) {
    const a = oldMod.source || {};
    const b = newMod.source || {};
    if (a.md5 && b.md5) return a.md5 !== b.md5;
    if (a.fileId != null && b.fileId != null) return String(a.fileId) !== String(b.fileId);
    return normalize(oldMod.version) !== normalize(newMod.version);
}

function isGenuineUpdate(oldMod, newMod) {
    return didFileChange(oldMod, newMod) || !choicesEqual(oldMod.choices, newMod.choices);
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
    // unchanged (2026-08-18): matched mods with no genuine update -- previously dropped on the floor
    // entirely (the mockup's original "only what's actually changing is listed" framing). The
    // director's own real complaint: a 25-mod collection's Review screen only ever showed the 4 mods
    // that changed, with zero trace of the other 21 -- "if a collection says it has 25 mods, I see 25
    // mods." Purely additive/display-only -- removed/updated/added keep meaning exactly what they
    // already did, and Apply (update-collection-v2-runner.js's applyUpdate) never reads this bucket.
    // Holds the NEW mod object (same convention as `added`) -- for an unchanged mod old/new carry the
    // same file identity by definition, but the new revision's own metadata (author, instructions) is
    // the one that should keep showing once this revision is applied.
    const unchanged = [];
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
        } else {
            unchanged.push(newMatch);
        }
    }

    const added = newRequired.filter((newMod) => !matchedNew.has(newMod));

    return { removed, updated, added, unchanged };
}

// buildIndex/findMatch exported (2026-08-18) for lib/update-collection-v2-runner.js's own applyUpdate
// -- it needs the SAME ambiguity-aware, cross-revision-safe identity matching to merge a real,
// partial apply result back into the local collection.json (see that function's own header comment).
// buildSharedModIndex/findSharedModMatch exported for both remove-collection-runner.js's own
// reviewRemoval AND update-collection-v2-runner.js's own reviewUpdate (2026-08-21) -- same real,
// proven cross-collection detection, one shared implementation.
module.exports = {
    diffCollectionMods, modIdentityKeys, isGenuineUpdate, didFileChange, choicesEqual,
    buildIndex, findMatch, buildSharedModIndex, findSharedModMatch,
};
