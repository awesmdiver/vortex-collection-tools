'use strict';
// The one "MD5 of a file on disk" implementation (2026-08-23). There were three, and they did not
// agree on the thing that matters -- see docs/SHARED-CODE-MAP.md's own MD5 section for the audit:
//
//   lib/archive-locator.js       streaming, async   -- correct, and where this code came from
//   web/missing-masters-routes.js streaming, inline -- an exact behavioural duplicate
//   lib/relink-scripts.js         readFileSync, SYNC -- read the WHOLE file into memory
//
// That third one had a real, measured cost: it ran over every non-stock BSA/BA2 in the Data folder,
// which on this install is 796 archives totalling 85.7 GB, largest single file 1.99 GB -- each read
// synchronously into the main server process, blocking the event loop, after every merge.
//
// This lives in its own module rather than being imported out of archive-locator.js because hashing a
// file is a filesystem primitive, not an archive-locating concern: relink-scripts has no business
// depending on the archive locator, and would have pulled in its downloads-folder scanning and
// NOT_FOUND/HASH_MISMATCH error vocabulary just to hash a BSA. archive-locator.js now imports from
// here and keeps its own hashFileMd5 name, so none of its call sites changed.

const crypto = require('crypto');
const fs = require('fs');

// Streams the file rather than reading it whole -- the entire point of consolidating on this one.
// Rejects on any read error (missing file, permission denied) rather than resolving to a bogus hash.
function hashFileMd5(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('md5');
        const stream = fs.createReadStream(filePath);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', reject);
    });
}

module.exports = { hashFileMd5 };
