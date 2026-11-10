'use strict';
// Turns a stored scan_error into one short reason, so the failed-archives pop-up can show
// "Corrupt or incomplete: 12" instead of thousands of near-identical rows.

const CORRUPT_RE = /is not archive|cannot open|can not open|unexpected end|headers error|crc failed|data error|truncated|damaged|unsupported|checksum/i;

function reasonFor(scanError) {
    const text = String(scanError || '').trim();
    if (!text) return 'Unknown problem';
    if (/enter password|wrong password|encrypted/i.test(text)) return 'Password protected';
    if (CORRUPT_RE.test(text)) return 'Corrupt or incomplete';
    // "7z exited 2: ERROR: C:\path\x.7z : <detail>" -> keep the detail, drop the per-archive path
    // and exit code so identical problems group together.
    const detail = text
        .replace(/^7z exited \d+:\s*/i, '')
        .replace(/^ERROR:\s*/i, '')
        .replace(/[A-Za-z]:\\[^:\r\n]*?\.(zip|7z|rar)\s*:?\s*/gi, '')
        .split(/\r?\n/)[0]
        .trim();
    return (detail || 'Unknown problem').slice(0, 80);
}

// SQL for "this stored error is 7-Zip failing to start, not an archive failing to read". Mirrors
// lib/sevenzip.js's isSevenZipUnavailable (kept as plain LIKEs because the database cannot run JS).
const TOOL_ERROR_SQL = `(scan_error LIKE 'spawn %' AND (scan_error LIKE '% ENOENT' OR scan_error LIKE '% EACCES' OR scan_error LIKE '% EPERM' OR scan_error LIKE '% EFTYPE' OR scan_error LIKE '% UNKNOWN'))`;

// [{ reason, count }] largest first, from rows already carrying `.reason`.
function groupByReason(rows) {
    const counts = new Map();
    for (const row of rows) counts.set(row.reason, (counts.get(row.reason) || 0) + 1);
    return Array.from(counts, ([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

module.exports = { reasonFor, groupByReason, TOOL_ERROR_SQL };
