'use strict';
// Locates the exact archive file a collection.json mod entry refers to, in a Vortex downloads
// folder. Filename alone is NOT sufficient once more than one archive/version shares a modId --
// confirmed this session with a deliberately-duplicated test archive (same modId, different
// content) -- so candidates are always disambiguated by an exact md5+fileSize match.

const fs = require('fs');
const path = require('path');
const helperClient = require('./vortex-helper-client');

const ARCHIVE_EXTENSIONS = new Set(['.zip', '.7z', '.rar']);

// Confirmed real-world this session: a manually-downloaded, Nexus-served file for "Eyes Nouveaux -
// Ultra" had an MD5 that matched collection.json's own recorded md5 EXACTLY (cross-checked two
// independent ways -- Node's crypto module and Windows' own certutil), yet its actual size
// (131,109,777 bytes) was 3 bytes off from collection.json's recorded fileSize (131,109,780). An
// MD5 match is effectively proof positive this IS the correct file -- the size field itself was
// simply wrong in the collection's own manifest, not a problem with the download. This tolerance is
// the fallback window (only ever used once the exact-size search below finds nothing) within which
// a near-miss-sized file is still worth actually hashing to check -- generous enough to catch this
// exact class of manifest inaccuracy, tiny enough relative to real archive sizes that two unrelated
// mods' archives coincidentally landing within it of each other is effectively impossible.
const SIZE_TOLERANCE_BYTES = 1024;

// Moved to lib/file-hash.js (2026-08-23) and imported back under the same name, so every call site
// in this file is unchanged. See that module for why the primitive does not live here any more.
const { hashFileMd5 } = require('./file-hash');

// Candidates are every archive in the downloads folder whose size is within `tolerance` bytes of
// the recorded fileSize (0 = exact match, the default/common case). Filename patterns are NOT used
// to narrow this -- confirmed this session that Vortex downloads don't all follow one naming
// convention (most are "<name>-<modId>-<version>-<timestamp>.<ext>", but some are space-delimited
// with no hyphens at all, e.g. "Gore - A Companion Mod 85298 1.8.25 2026-07-14T19-12Z
// 587RqTESk.zip" -- a modId-shaped hyphen marker would silently miss this one). fileSize is cheap
// to check (a stat(), not a read) across the whole folder, so there's no real cost to being
// filename-agnostic and it can't miss a real match.
// Vortex's own downloads root holds one sibling subfolder per Nexus game domain (confirmed live
// 2026-08-25: ".../skyrim", ".../skyrimse", ".../dragonsdogma2", ".../site" all sit side by side on
// disk). This project's own configured `downloads` setting only ever points at ONE of those
// (whichever game the user set up in Settings) -- so a mod cross-listed under a DIFFERENT domain
// (the mod's own per-mod `domainName` override in collection.json -- same field the a12787a/cdc977d
// Nexus-API fixes already handle) has its real archive sitting in a SIBLING folder this project
// would otherwise never look in, and DID mislook in: "Rebuild Missing Files" was reporting "No
// archive matching this mod was found" for TES Arena Bikini Armor even after Download Archive
// succeeded, because the download landed in the "skyrim" sibling folder while the scan/report only
// ever checked the configured "skyrimse" one. Resolves that sibling when it exists on disk; falls
// back to the configured folder unchanged for the overwhelming common case (no override, or the
// sibling genuinely doesn't exist -- e.g. a from-scratch setup with a flat downloads folder).
function resolveDomainDownloadsDir(baseDownloadsDir, domainName) {
    if (!domainName || path.basename(baseDownloadsDir) === domainName) return baseDownloadsDir;
    const sibling = path.join(path.dirname(baseDownloadsDir), domainName);
    return fs.existsSync(sibling) ? sibling : baseDownloadsDir;
}

function findCandidates(downloadsDir, fileSize, tolerance = 0) {
    return fs.readdirSync(downloadsDir)
        .filter((name) => ARCHIVE_EXTENSIONS.has(path.extname(name).toLowerCase()))
        .map((name) => path.join(downloadsDir, name))
        .filter((full) => Math.abs(fs.statSync(full).size - fileSize) <= tolerance);
}

// REVISED (2026-09-01, same day): an earlier same-day version of this function used collection.json's
// own logicalFilename/name to FILTER same-size candidates before hashing -- confirmed live this threw
// away a genuinely correct file. "Standalone Sleeves of Skyrim" (collection.json's own logicalFilename)
// is really, correctly the file "Standalone Sleeved Imperials-42865-1-0-1-....rar" on disk (same mod
// page, the archive's own filename doesn't match its later-renamed display name) -- exact size, exact
// md5, but the name filter excluded it before it was ever hash-checked, misreporting a genuinely-
// present archive as missing. Director's own call on the revision: name stays part of the search (used
// below to try the most-likely candidates FIRST), but it must never be able to exclude a real
// candidate from being hash-checked -- content (size + md5) is the only thing allowed to make the
// final call on "is this archive here." Every same-size candidate still gets checked if the
// name-preferred ones don't pan out; nothing is ever skipped.
function normalizeForNameMatch(str) {
    return String(str || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// Reorders candidates so ones whose own filename looks related to the mod's recorded name are
// checked first -- pure ordering, never exclusion. The unrelated ones stay in the list, just last.
function preferByName(candidates, nameHint) {
    const hint = normalizeForNameMatch(nameHint);
    if (!hint) return candidates;
    const related = [];
    const rest = [];
    for (const c of candidates) {
        const candidateName = normalizeForNameMatch(path.basename(c, path.extname(c)));
        (candidateName.includes(hint) ? related : rest).push(c);
    }
    return [...related, ...rest];
}

// REVISED (2026-09-04, director's own explicit call): this used to always throw NO_EXPECTED_HASH
// when collection.json recorded no md5 to check a same-size candidate against -- correct, but overly
// cautious given what's actually knowable here. Director's own words: "we are better off going with
// just trust the size, if the help[er] doesn't provide anything as long as the file name and size
// match. the chances of the file not being correct, is extremely small compared to the pain of
// having all the extra steps." Two-tier fallback, in order of trustworthiness:
//
// Tier 1 -- ask Vortex's own live download database. Confirmed via Vortex's real source
// (mod_management/util/testModReference.ts's testRef(), read directly this session): when a
// collection rule carries real Nexus repo info, Vortex ITSELF matches purely on modId+fileId
// equality against `state.persistent.downloads.files` -- it never touches a hash for this case
// either. That's not a guess; it's the exact real identity Vortex recorded straight from the Nexus
// API the moment it downloaded the file. If the Helper is reachable and one of the current same-size
// candidates has a matching download record, that candidate is exactly as trustworthy as Vortex's
// own approach -- no reason to be stricter than Vortex itself is.
//
// Tier 2 -- if the Helper isn't reachable (or reachable but has no matching record for this file,
// e.g. it was never downloaded through Vortex at all), fall back to the top same-size candidate
// AFTER preferByName()'s own reordering. Same-size collision with an unrelated archive is already
// vanishingly rare; combined with the candidate's own filename plausibly matching the mod's recorded
// name, the director's own risk call is that this is good enough, and refusing outright causes far
// more real pain (a dead-end "can't confirm it" error with no path forward except a fresh download)
// than the near-zero chance of picking the wrong file.
//
// Never touches HASH_MISMATCH or AMBIGUOUS below -- those mean "we DID have a real md5 to check
// against, and either nothing matched (a confirmed real problem) or more than one candidate matched
// exactly (a genuine, separate ambiguity)." Both stay exactly as strict as before; this revision is
// scoped ONLY to the "there was never anything to check against in the first place" case.
async function resolveViaHelperDownloadRecord(candidates, source) {
    if (!source.modId || !source.fileId) return null;
    try {
        if (!(await helperClient.checkHelperAvailable())) return null;
        const downloadsData = await helperClient.getAllDownloads();
        if (!downloadsData || !downloadsData.files) return null;
        const candidateBasenames = new Map(candidates.map((c) => [path.basename(c).toLowerCase(), c]));
        for (const record of Object.values(downloadsData.files)) {
            const ids = record.modInfo && record.modInfo.nexus && record.modInfo.nexus.ids;
            if (!ids) continue;
            if (String(ids.modId) !== String(source.modId) || String(ids.fileId) !== String(source.fileId)) continue;
            const localBasename = record.localPath && path.basename(record.localPath).toLowerCase();
            const match = localBasename && candidateBasenames.get(localBasename);
            if (match) return match;
        }
        return null;
    } catch {
        return null; // best-effort only -- never let a Helper hiccup block resolution here
    }
}

// .code lets callers react precisely (e.g. "is this a real download opportunity or an ambiguous
// mess needing a human?") without string-matching messages -- see lib/rebuild-mod.js's classifyMod.
async function locateArchive(downloadsDir, source) {
    let candidates = findCandidates(downloadsDir, source.fileSize);
    // Fallback ONLY when the exact-size search finds literally nothing -- keeps the common case
    // (a real match, or a genuinely-absent file) exactly as fast as before; this extra pass only
    // ever runs, and only ever hashes, a small handful of near-size files in the rarer case.
    if (candidates.length === 0) {
        candidates = findCandidates(downloadsDir, source.fileSize, SIZE_TOLERANCE_BYTES);
    }

    candidates = preferByName(candidates, source.logicalFilename || source.name);

    if (candidates.length === 0) {
        const err = new Error(`No archive of size ${source.fileSize} found in ${downloadsDir} (modId ${source.modId})`);
        err.code = 'NOT_FOUND';
        throw err;
    }

    // Defensive, NOT bundle-specific (every source type is covered, not just 'bundle' -- see
    // lib/bundle-resolver.js's own header comment for the real case this was built from): a missing
    // `source.md5` can never be compared against a real computed hash and yield a true match --
    // `md5 === undefined` is always false, so without this guard, ANY same-size candidate silently
    // reported as HASH_MISMATCH ("we checked, it's wrong") when the honest answer was "we have no
    // way to verify this one at all." See this function's own header comment above for what happens
    // now instead -- Tier 1 (Helper download-record match) then Tier 2 (trust the top candidate).
    if (!source.md5) {
        const helperMatch = await resolveViaHelperDownloadRecord(candidates, source);
        return helperMatch || candidates[0];
    }

    const matches = [];
    for (const candidate of candidates) {
        const md5 = await hashFileMd5(candidate);
        if (md5 === source.md5) matches.push(candidate);
    }

    if (matches.length === 0) {
        const err = new Error(
            `No archive among ${candidates.length} same-size candidate(s) for modId ${source.modId} matches ` +
            `md5=${source.md5}. Candidates checked: ${candidates.join(', ')}`
        );
        err.code = 'HASH_MISMATCH';
        // Structured, not just embedded in the message string -- lets callers (off-site mods
        // specifically) build their own "a new file was found but doesn't match" message and offer a
        // force-extract override, instead of only having a human-readable sentence to parse.
        err.candidates = candidates;
        throw err;
    }
    if (matches.length > 1) {
        const err = new Error(`Multiple archives match md5+fileSize for modId ${source.modId} -- ` +
            `ambiguous, refusing to guess: ${matches.join(', ')}`);
        err.code = 'AMBIGUOUS';
        // Structured, not just embedded in the message string -- same reasoning as HASH_MISMATCH's
        // own .candidates above -- lets a caller offer a "delete one of these duplicates" UI instead
        // of just a dead-end error. Real-world case: two byte-identical copies of the same archive
        // under different filenames (a straight-up duplicate, not a version conflict).
        err.candidates = matches;
        throw err;
    }
    return matches[0];
}

module.exports = {
    locateArchive, hashFileMd5, findCandidates, resolveDomainDownloadsDir, ARCHIVE_EXTENSIONS,
    resolveViaHelperDownloadRecord, // exported for direct testability, not a real external caller
};
