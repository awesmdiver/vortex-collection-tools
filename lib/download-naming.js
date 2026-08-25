'use strict';
// Shared Vortex download/staging-folder naming-convention helpers -- used by both
// lib/cleanup-scan.js (Mod Scrub's exceptions/needsReview safety classification) and
// lib/missing-masters-scan.js (Missing Masters' cosmetic mod-name display cleanup). Pulled out into
// its own module 2026-07-27 so a fix to the underlying pattern only ever needs to happen once, in
// one place, for both consumers.
//
// modId(-version parts)-<10-digit unix timestamp> at the end of the name -- Vortex's own
// auto-generated download-naming shape. The middle "version parts" segment was originally assumed
// to always be numeric (e.g. "-1-4-6-"), but confirmed real 2026-07-27 (Missing Masters,
// "1DustAdeptArmorSE-53257-new-1628092406" -- modId 53257, a literal non-numeric version string
// "new", then the timestamp) that Vortex's real naming convention allows an ARBITRARY (non-hyphen)
// version string there -- `(?:-[^-]+)*` catches this, where the older `(?:-\d+)*` silently didn't.
// Loosening this was deliberately checked against Mod Scrub's own safety use before being shared:
// a hand-named tool-output folder (DynDOLOD Output, BodySlide Output, etc.) never ends in a
// "-<number>-...-<10-digit-timestamp>" shape at all, so this change doesn't newly risk misreading
// one of those as a confident, safe-to-bulk-delete "exceptions" match -- it only fixes a real
// false-negative (a genuine Vortex download with a non-numeric version string previously landing in
// the extra-caution "needsReview" bucket for no real reason).
//
// A version segment can also be genuinely EMPTY (confirmed real 2026-07-27 against a live 4560-folder
// staging directory: "Project AHO - Spell Crafting for Mysticism-65891-1-0-1--1648930764" has a blank
// segment between two dashes right before the real epoch) -- `[^-]*` (zero-or-more) instead of
// `[^-]+` (one-or-more) lets a repetition match nothing instead of failing the whole pattern, so the
// mandatory `-\d{10}$` epoch anchor at the end still gets found.
const RECOGNIZED_DOWNLOAD_NAME_PATTERN = /-\d+(?:-[^-]*)*-\d{10}$/;

// A SECOND, different Vortex-generated naming shape, confirmed real 2026-07-27 -- space-separated,
// ends in an ISO-ish timestamp ("2026-07-27T19-43Z") plus a random alphanumeric suffix (e.g.
// "Portalmaster 186656 1.0 2026-07-27T19-43Z hfH9s6oFY.rar"). Originally suspected to mean "the user
// manually downloaded this from Nexus's website instead of using Vortex's Download with Manager
// button" -- re-checked 2026-07-27 against a live 4560-folder staging directory and this shape turned
// out to be the OVERWHELMING majority (139 of 4560, vs. 4040 for the dash+epoch shape above) of
// ordinary Vortex-managed installs in this install, not an edge case -- the "manual download" framing
// undersold how common it is. modId/version ordering varies between examples, so only the trailing
// date+suffix shape is matched here for the "is this shape present at all" check.
const MANUAL_DOWNLOAD_NAME_PATTERN = /\d{4}-\d{2}-\d{2}T\d{2}-\d{2}Z [A-Za-z0-9]+$/;

// The FULL space-separated shape, for stripping (not just detecting): "<name> <modId> <version>
// <ISO-date>T<time>Z <token>" -- e.g. "GTS - Specific Patches 97490 113 2026-07-17T15-17Z VMSnJrLRM"
// strips to "GTS - Specific Patches". Tight enough (mandatory numeric modId, mandatory ISO-shaped
// timestamp, mandatory trailing alnum token, all space-delimited) that a hand-typed folder name
// essentially can't match it by accident -- confirmed safe against the same 4560-folder real listing
// (139 matches, all genuine Vortex-managed installs, zero false positives found on manual review).
const SPACE_SEPARATED_DOWNLOAD_NAME_PATTERN = /\s\d+\s\S+\s\d{4}-\d{2}-\d{2}T\d{2}-\d{2}Z\s[A-Za-z0-9]+$/;

// A THIRD shape: modId(-version parts) at the end with NO trailing timestamp at all (confirmed real
// 2026-07-27: "ElysiumEstate5.0.1-4119-5-0-1" -- modId 4119, version "5-0-1" i.e. "5.0.1" dash-
// encoded -- ends right there, no epoch, likely an older Vortex naming convention or a folder moved/
// renamed by something else). Deliberately kept OUT of RECOGNIZED_DOWNLOAD_NAME_PATTERN and
// isRecognizedDownloadName -- checked against the same 4560-folder listing and it's looser than the
// other two shapes (no timestamp anchor at all to pin down where the real name ends), and 3 of 93
// real matches were ambiguous on manual review (e.g. "SQOSPatcher-v0-3" -> "SQOSPatcher-v0", where
// "-3" may be part of a real "v0.3" version string rather than a stray modId to strip; "ggmods-4923-
// foundation-face-library-1.1" -> "ggmods", where the trailing words might be the actual mod name,
// not Vortex metadata). That ambiguity is an acceptable trade for Missing Masters' purely cosmetic
// display (worst case: an occasional display name that's a bit more aggressively trimmed than ideal),
// but not for Mod Scrub's safety classification, which is why it's exported separately and never
// folded into isRecognizedDownloadName.
const BARE_DASH_NO_TIMESTAMP_PATTERN = /-\d+(?:-[^-]*)*$/;

// EXTRACTING the version, not just stripping the suffix off (2026-08-23). This is the gap that made
// web/missing-masters-routes.js roll its own copy: everything above only ever answered "is there a
// suffix, and where does the real name end", never "what version does that suffix encode". The
// private copy then re-derived the shapes and, predictably, re-derived them WRONG -- its dashed
// pattern required every version segment to be strictly numeric, exactly the assumption this file's
// own header records being disproved twice. Measured against the real downloads folder: 169 of 4,571
// archives returned null there that this recognises.
//
// Reuses the same two CONFIDENT shapes the strippers use, with capture groups added -- the same
// pattern knowledge, so the next correction lands in one place instead of two.
//
// BARE_DASH_NO_TIMESTAMP_PATTERN is deliberately NOT used here, matching the judgment its own comment
// above already records: with no timestamp to anchor where the real name ends, some of its real
// matches are genuinely ambiguous ("SQOSPatcher-v0-3" -- is "-3" a modId or part of "v0.3"?).
// Guessing wrong is fine for a cosmetic name trim and not fine for a version number displayed next to
// an archive the user is about to pick between.
//
// Accepts an archive FILENAME as well as a folder name: the shapes above are $-anchored because they
// were written for folder names, so a trailing archive extension is trimmed first.
// The trailing (?:\.\d+)? is Vortex's DUPLICATE-COPY marker, not part of the version: a second copy
// of the same download lands as "<name>-<epoch>.1.<ext>". Found by diffing this against the old
// private copy across the real 4,571-archive downloads folder -- 4 archives regressed to null without
// it (e.g. "(4) Community Overlays 1 - Main - CBBE 4K-22487-1-0-1-1547248552.1.7z"), because the old
// regex happened to tolerate it by matching a literal dot after the epoch rather than anchoring to
// the end. Kept as an explicit optional group rather than pre-stripping, so it can only ever apply
// immediately after an otherwise-complete, valid shape.
const DASH_EPOCH_VERSION_PATTERN = /-\d+((?:-[^-]*)*)-\d{10}(?:\.\d+)?$/;
const SPACE_SEPARATED_VERSION_PATTERN = /\s\d+\s(\S+)\s\d{4}-\d{2}-\d{2}T\d{2}-\d{2}Z\s[A-Za-z0-9]+(?:\.\d+)?$/;

function parseVersionFromDownloadName(name) {
    const base = String(name || '').replace(/\.(zip|7z|rar)$/i, '');

    const dashed = DASH_EPOCH_VERSION_PATTERN.exec(base);
    if (dashed) {
        // Dash-encoded ("-6-3-0" -> "6.3.0"). Empty segments are dropped rather than rendered as a
        // stray dot: a genuinely blank segment is real (see the header's own -65891-1-0-1-- case) and
        // "1.0.1." would just look broken.
        const parts = dashed[1].split('-').filter(Boolean);
        return parts.length ? parts.join('.') : null;
    }

    const spaced = SPACE_SEPARATED_VERSION_PATTERN.exec(base);
    if (spaced) return spaced[1];

    return null; // a hand-named archive has no version to report -- say so rather than guessing
}

function isRecognizedDownloadName(name) {
    return RECOGNIZED_DOWNLOAD_NAME_PATTERN.test(name) || SPACE_SEPARATED_DOWNLOAD_NAME_PATTERN.test(name);
}

function isPossibleManualDownload(name) {
    return MANUAL_DOWNLOAD_NAME_PATTERN.test(name);
}

// Strips the trailing modId-version-timestamp suffix if present, turning a raw staging folder name
// back into a clean display name (e.g. "GTS Patches - OWL-50057-1-2-1622411906" -> "GTS Patches -
// OWL"). Tries each known shape in order of confidence (dash+epoch, then space+ISO+token, then the
// looser bare-dash-no-timestamp fallback) and strips using the first one that matches. Returns the
// name UNCHANGED if none match -- a hand-named folder (no real suffix to strip) is safely left as-is,
// never mangled.
function stripDownloadNameSuffix(name) {
    if (RECOGNIZED_DOWNLOAD_NAME_PATTERN.test(name)) return name.replace(RECOGNIZED_DOWNLOAD_NAME_PATTERN, '');
    if (SPACE_SEPARATED_DOWNLOAD_NAME_PATTERN.test(name)) return name.replace(SPACE_SEPARATED_DOWNLOAD_NAME_PATTERN, '');
    if (BARE_DASH_NO_TIMESTAMP_PATTERN.test(name)) return name.replace(BARE_DASH_NO_TIMESTAMP_PATTERN, '');
    return name;
}

module.exports = {
    RECOGNIZED_DOWNLOAD_NAME_PATTERN,
    MANUAL_DOWNLOAD_NAME_PATTERN,
    SPACE_SEPARATED_DOWNLOAD_NAME_PATTERN,
    BARE_DASH_NO_TIMESTAMP_PATTERN,
    isRecognizedDownloadName,
    isPossibleManualDownload,
    stripDownloadNameSuffix,
    parseVersionFromDownloadName,
};
