'use strict';
// Locates the exact archive file a collection.json mod entry refers to, in a Vortex downloads
// folder. Filename alone is NOT sufficient once more than one archive/version shares a modId --
// confirmed this session with a deliberately-duplicated test archive (same modId, different
// content) -- so candidates are always disambiguated by an exact md5+fileSize match.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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

function hashFileMd5(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('md5');
        const stream = fs.createReadStream(filePath);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', reject);
    });
}

// Candidates are every archive in the downloads folder whose size is within `tolerance` bytes of
// the recorded fileSize (0 = exact match, the default/common case). Filename patterns are NOT used
// to narrow this -- confirmed this session that Vortex downloads don't all follow one naming
// convention (most are "<name>-<modId>-<version>-<timestamp>.<ext>", but some are space-delimited
// with no hyphens at all, e.g. "Gore - A Companion Mod 85298 1.8.25 2026-07-14T19-12Z
// 587RqTESk.zip" -- a modId-shaped hyphen marker would silently miss this one). fileSize is cheap
// to check (a stat(), not a read) across the whole folder, so there's no real cost to being
// filename-agnostic and it can't miss a real match.
function findCandidates(downloadsDir, fileSize, tolerance = 0) {
    return fs.readdirSync(downloadsDir)
        .filter((name) => ARCHIVE_EXTENSIONS.has(path.extname(name).toLowerCase()))
        .map((name) => path.join(downloadsDir, name))
        .filter((full) => Math.abs(fs.statSync(full).size - fileSize) <= tolerance);
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
    if (candidates.length === 0) {
        const err = new Error(`No archive of size ${source.fileSize} found in ${downloadsDir} (modId ${source.modId})`);
        err.code = 'NOT_FOUND';
        throw err;
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

module.exports = { locateArchive, hashFileMd5, findCandidates };
