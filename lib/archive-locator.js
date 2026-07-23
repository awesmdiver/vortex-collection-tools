'use strict';
// Locates the exact archive file a collection.json mod entry refers to, in a Vortex downloads
// folder. Filename alone is NOT sufficient once more than one archive/version shares a modId --
// confirmed this session with a deliberately-duplicated test archive (same modId, different
// content) -- so candidates are always disambiguated by an exact md5+fileSize match.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ARCHIVE_EXTENSIONS = new Set(['.zip', '.7z', '.rar']);

function hashFileMd5(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('md5');
        const stream = fs.createReadStream(filePath);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', reject);
    });
}

// Candidates are every archive in the downloads folder whose size exactly matches the recorded
// fileSize. Filename patterns are NOT used to narrow this -- confirmed this session that Vortex
// downloads don't all follow one naming convention (most are "<name>-<modId>-<version>-
// <timestamp>.<ext>", but some are space-delimited with no hyphens at all, e.g. "Gore - A
// Companion Mod 85298 1.8.25 2026-07-14T19-12Z 587RqTESk.zip" -- a modId-shaped hyphen marker
// would silently miss this one). fileSize is cheap to check (a stat(), not a read) across the
// whole folder, so there's no real cost to being filename-agnostic and it can't miss a real match.
function findCandidates(downloadsDir, fileSize) {
    return fs.readdirSync(downloadsDir)
        .filter((name) => ARCHIVE_EXTENSIONS.has(path.extname(name).toLowerCase()))
        .map((name) => path.join(downloadsDir, name))
        .filter((full) => fs.statSync(full).size === fileSize);
}

async function locateArchive(downloadsDir, source) {
    const candidates = findCandidates(downloadsDir, source.fileSize);
    if (candidates.length === 0) {
        throw new Error(`No archive of size ${source.fileSize} found in ${downloadsDir} (modId ${source.modId})`);
    }

    const matches = [];
    for (const candidate of candidates) {
        const md5 = await hashFileMd5(candidate);
        if (md5 === source.md5) matches.push(candidate);
    }

    if (matches.length === 0) {
        throw new Error(
            `No archive among ${candidates.length} same-size candidate(s) for modId ${source.modId} matches ` +
            `md5=${source.md5}. Candidates checked: ${candidates.join(', ')}`
        );
    }
    if (matches.length > 1) {
        throw new Error(`Multiple archives match md5+fileSize for modId ${source.modId} -- ` +
            `ambiguous, refusing to guess: ${matches.join(', ')}`);
    }
    return matches[0];
}

module.exports = { locateArchive, hashFileMd5, findCandidates };
