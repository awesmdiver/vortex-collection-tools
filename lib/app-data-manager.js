'use strict';
// Settings -> App Data checklist (2026-09-14, "split Logs from App Data") -- lists every real item
// sitting in App Data, grouped by tool + data kind (matching design/mockup-settings-logs-and-app-
// data.html's own DATA shape), and deletes a chosen subset after validating every path actually
// lives inside App Data. See TECHNICAL.md's "Logs vs App Data" section for the authoritative
// subfolder-name table this mirrors -- lib/app-data-migration.js's own plan uses the SAME subfolder
// names, so a location this file lists is exactly where that migration would have moved it from.
//
// Each group's own `lose` text is the exact, director-approved copy for the delete confirmation
// (queue: logs-vs-app-data) -- kept here, not duplicated in the client, so the server route and the
// confirmation modal can never drift apart.

const fs = require('fs');
const path = require('path');
const runner = require('./collection-runner');

function safeStat(p) {
    try { return fs.statSync(p); } catch { return null; }
}

// "Last changed" only shows when it differs meaningfully from "Created" (more than a few seconds --
// the same file being written once, closed, and stat'd back should never show a spurious "changed").
function meaningfullyChanged(createdMs, changedMs) {
    return createdMs != null && changedMs != null && changedMs - createdMs > 5000;
}

// ---------- Real "Created" dates (2026-09-15, "keeps each file's real dates") ----------
// A file moved into App Data by lib/app-data-migration.js gets a NEW on-disk creation time the
// instant it's copied -- Windows itself gives Node no way to SET a file's own creation time, only
// read it, so the copy's own birthtime is always just "the moment the move happened," never the
// truth. That migration records the real original creation time it captured (from the source, one
// instant before the copy) into a small per-App-Data-folder sidecar; this reads it back here rather
// than trusting `stat.birthtimeMs` blindly for a moved file.

const ORIGIN_DATES_FILENAME = '.origin-dates.json';

function loadOriginDates(appDataDir) {
    try {
        return JSON.parse(fs.readFileSync(path.join(appDataDir, ORIGIN_DATES_FILENAME), 'utf8'));
    } catch {
        return {};
    }
}

function relKey(appDataDir, filePath) {
    return path.relative(appDataDir, filePath).split(path.sep).join('/');
}

// Falls back (no sidecar entry -- a file moved before this fix existed, or one that was always
// authored directly in App Data and never migrated at all) to `stat.birthtimeMs`, EXCEPT when that
// birthtime is actually AFTER the file's own mtime -- impossible for a file authored in place (its
// last-modified time can only be at or after its own creation), so birth > mtime is the fingerprint
// of a copy whose real origin was never recorded. The preserved mtime (confirmed empirically:
// `fs.copyFileSync` keeps the source's original last-modified time on this project's real Windows
// installs) is the closest real signal left in that case, so it's used instead of the misleading
// birthtime.
function resolveCreatedAtMs(appDataDir, filePath, stat, originDates) {
    const key = relKey(appDataDir, filePath);
    if (key in originDates) return originDates[key];
    const birth = stat.birthtimeMs;
    const mtime = stat.mtimeMs;
    if (birth != null && mtime != null && birth - mtime > 5000) return mtime;
    return birth != null ? birth : mtime;
}

// Every file directly under `dir` (non-recursive) -- used for a dir whose own children are each a
// standalone item (Rebuild Collection reports, Cycle Helper history sessions).
function listFilesIn(dir) {
    try {
        return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.join(dir, e.name));
    } catch {
        return [];
    }
}

function listDirsIn(dir) {
    try {
        return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
        return [];
    }
}

// Combined size + created/changed range for every file directly under `dir` (Update Collection's own
// per-collection subfolder, Archive Finder's index folder holding db+wal+shm together as one item).
// "Created" for the group is the EARLIEST real creation date among its files, "changed" the latest
// real modification -- both resolved the same origin-date-aware way a single file's own dates are.
function summarizeDir(appDataDir, dir, originDates) {
    const files = listFilesIn(dir);
    if (files.length === 0) return null;
    let sizeBytes = 0, createdMs = null, changedMs = null;
    for (const f of files) {
        const stat = safeStat(f);
        if (!stat) continue;
        sizeBytes += stat.size;
        const created = resolveCreatedAtMs(appDataDir, f, stat, originDates);
        if (createdMs == null || created < createdMs) createdMs = created;
        if (changedMs == null || stat.mtimeMs > changedMs) changedMs = stat.mtimeMs;
    }
    return { sizeBytes, createdMs, changedMs };
}

function fileItem({ id, name, filePath, tool, type, lose, listWarn, appDataDir, originDates }) {
    const stat = safeStat(filePath);
    if (!stat || !stat.isFile()) return null;
    const createdMs = resolveCreatedAtMs(appDataDir, filePath, stat, originDates);
    const changedMs = stat.mtimeMs;
    return {
        id, tool, type, lose, listWarn: !!listWarn, name,
        createdAt: new Date(createdMs).toISOString(),
        changedAt: meaningfullyChanged(createdMs, changedMs) ? new Date(changedMs).toISOString() : null,
        sizeBytes: stat.size, deletePath: filePath, isDir: false,
    };
}

function dirItem({ id, name, dirPath, tool, type, lose, listWarn, summary }) {
    if (!summary) return null;
    return {
        id, tool, type, lose, listWarn: !!listWarn, name,
        createdAt: summary.createdMs != null ? new Date(summary.createdMs).toISOString() : null,
        changedAt: meaningfullyChanged(summary.createdMs, summary.changedMs) ? new Date(summary.changedMs).toISOString() : null,
        sizeBytes: summary.sizeBytes, deletePath: dirPath, isDir: true,
    };
}

// One entry per tool GROUP shown in the checklist -- `items()` is a function (not a pre-built array)
// so each group is only ever computed on an actual GET, never speculatively.
function buildGroups(appDataDir, { staging } = {}) {
    const groups = [];
    // Loaded ONCE per request -- every fileItem/summarizeDir call below reads from this same map
    // rather than re-reading the sidecar file per item.
    const originDates = loadOriginDates(appDataDir);

    // ---- Rebuild Collection: run reports ----
    groups.push({
        tool: 'Rebuild Collection', type: 'Run report',
        lose: 'Resume, Retry, and Stats for that run',
        items: listFilesIn(path.join(appDataDir, 'rebuild-collection', 'reports')).map((filePath) => {
            const base = path.basename(filePath);
            let collectionName = base, startedAt = null;
            try {
                const log = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                collectionName = log.collectionName || base;
                startedAt = log.startedAt || null;
            } catch { /* unreadable/corrupt report -- fall back to the raw filename */ }
            const stat = safeStat(filePath);
            // startedAt (the report's own recorded run start) is the most authoritative "created"
            // signal when present -- it's the exact real moment the run began, more precise than any
            // filesystem timestamp could be. Falls back to the origin-date-aware file stat otherwise.
            const createdMs = startedAt ? new Date(startedAt).getTime() : (stat ? resolveCreatedAtMs(appDataDir, filePath, stat, originDates) : null);
            const changedMs = stat?.mtimeMs;
            const when = startedAt ? new Date(startedAt).toLocaleString() : '';
            return {
                id: filePath, tool: 'Rebuild Collection', type: 'Run report',
                lose: 'Resume, Retry, and Stats for that run', listWarn: false,
                name: when ? `${collectionName} — ${when}` : collectionName,
                createdAt: createdMs ? new Date(createdMs).toISOString() : null,
                changedAt: meaningfullyChanged(createdMs, changedMs) ? new Date(changedMs).toISOString() : null,
                sizeBytes: stat?.size || 0, deletePath: filePath, isDir: false,
            };
        }),
    });

    // ---- Rebuild Collection: off-site import choices ----
    groups.push({
        tool: 'Rebuild Collection', type: 'Your imports',
        lose: "which downloaded file you picked for each off-site mod (you'll have to select them again with Import)",
        items: [fileItem({
            id: 'rebuild-collection/offsite-import-map.json', name: 'Off-site import choices',
            filePath: path.join(appDataDir, 'rebuild-collection', 'offsite-import-map.json'),
            tool: 'Rebuild Collection', type: 'Your imports', appDataDir, originDates,
            lose: "which downloaded file you picked for each off-site mod (you'll have to select them again with Import)",
        })].filter(Boolean),
    });

    // ---- Update Collection: per-collection tracking ----
    const trackingRoot = path.join(appDataDir, 'update-collection', 'tracking');
    groups.push({
        tool: 'Update Collection', type: 'Update tracking',
        lose: 'the saved Ignored and Disabled choices for that collection',
        items: listDirsIn(trackingRoot).map((collectionModId) => {
            const dirPath = path.join(trackingRoot, collectionModId);
            const summary = summarizeDir(appDataDir, dirPath, originDates);
            let name = collectionModId;
            if (staging) {
                try { name = runner.resolveCollectionInfo(staging, collectionModId).name; } catch { /* removed/renamed since -- show the raw id */ }
            }
            return dirItem({
                id: `update-collection/tracking/${collectionModId}`, name, dirPath, summary,
                tool: 'Update Collection', type: 'Update tracking',
                lose: 'the saved Ignored and Disabled choices for that collection',
            });
        }).filter(Boolean),
    });

    // ---- Update Collection: backup-ratio dismissals ----
    groups.push({
        tool: 'Update Collection', type: 'Dismissed warnings',
        lose: 'the "this is normal for this collection" dismissals you gave its backup-ratio warning',
        items: [fileItem({
            id: 'update-collection/backup-ratio-dismiss-state.json', name: 'Backup-ratio dismissals',
            filePath: path.join(appDataDir, 'update-collection', 'backup-ratio-dismiss-state.json'),
            tool: 'Update Collection', type: 'Dismissed warnings', appDataDir, originDates,
            lose: 'the "this is normal for this collection" dismissals you gave its backup-ratio warning',
        })].filter(Boolean),
    });

    // ---- Cycle Helper: fix history ----
    const historyDir = path.join(appDataDir, 'cycle-helper', 'history');
    groups.push({
        tool: 'Cycle Helper', type: 'Fix history',
        lose: 'the record of fixes from that session',
        items: listFilesIn(historyDir).map((filePath) => {
            let sessionId = path.basename(filePath, '.json');
            try { sessionId = JSON.parse(fs.readFileSync(filePath, 'utf8')).sessionId || sessionId; } catch { /* corrupt -- fall back to filename */ }
            const when = (() => { try { return new Date(sessionId).toLocaleString(); } catch { return sessionId; } })();
            return fileItem({
                id: filePath, name: `Session ${when}`, filePath, appDataDir, originDates,
                tool: 'Cycle Helper', type: 'Fix history', lose: 'the record of fixes from that session',
            });
        }).filter(Boolean),
    });

    // ---- Cycle Helper: rules snapshot ----
    groups.push({
        tool: 'Cycle Helper', type: 'Rules snapshot',
        lose: 'the "rules right before you last hand-edited them in Vortex" snapshot',
        items: [fileItem({
            id: 'cycle-helper/cycle-helper-snapshot.json', name: 'Rules snapshot',
            filePath: path.join(appDataDir, 'cycle-helper', 'cycle-helper-snapshot.json'),
            tool: 'Cycle Helper', type: 'Rules snapshot', appDataDir, originDates,
            lose: 'the "rules right before you last hand-edited them in Vortex" snapshot',
        })].filter(Boolean),
    });

    // ---- Work Through Report: progress ----
    groups.push({
        tool: 'Work Through Report', type: 'Progress',
        lose: 'your checked-off progress',
        items: [fileItem({
            id: 'work-through/work-through-state.json', name: 'Checklist progress',
            filePath: path.join(appDataDir, 'work-through', 'work-through-state.json'),
            tool: 'Work Through Report', type: 'Progress', lose: 'your checked-off progress', appDataDir, originDates,
        })].filter(Boolean),
    });

    // ---- Rebuild Missing Files: last-checked/fixed dates ----
    groups.push({
        tool: 'Rebuild Missing Files', type: 'Dates',
        lose: '"Last checked" and "Last extracted" dates on the collection cards',
        items: [fileItem({
            id: 'rebuild-missing-files/rebuild-missing-last-fixed-state.json', name: 'Last checked & extracted dates',
            filePath: path.join(appDataDir, 'rebuild-missing-files', 'rebuild-missing-last-fixed-state.json'),
            tool: 'Rebuild Missing Files', type: 'Dates', appDataDir, originDates,
            lose: '"Last checked" and "Last extracted" dates on the collection cards',
        })].filter(Boolean),
    });

    // ---- Workshop Report: fetch tracking ----
    groups.push({
        tool: 'Workshop Report', type: 'Fetch tracking',
        lose: 'which revision it thinks is currently on disk for each collection (it will re-check on the next Refresh)',
        items: [fileItem({
            id: 'workshop-report/workshop-report-fetch-state.json', name: 'Fetch tracking',
            filePath: path.join(appDataDir, 'workshop-report', 'workshop-report-fetch-state.json'),
            tool: 'Workshop Report', type: 'Fetch tracking', appDataDir, originDates,
            lose: 'which revision it thinks is currently on disk for each collection (it will re-check on the next Refresh)',
        })].filter(Boolean),
    });

    // ---- Rules Generator: anomaly choices ----
    groups.push({
        tool: 'Rules Generator', type: 'Remembered choices',
        lose: 'the answers you gave to its "is this intentional?" questions',
        items: [fileItem({
            id: 'rules-generator/rules-generator-anomaly-choices.json', name: 'Anomaly choices',
            filePath: path.join(appDataDir, 'rules-generator', 'rules-generator-anomaly-choices.json'),
            tool: 'Rules Generator', type: 'Remembered choices', appDataDir, originDates,
            lose: 'the answers you gave to its "is this intentional?" questions',
        })].filter(Boolean),
    });

    // ---- Mod Exceptions: your hand-built list ----
    groups.push({
        tool: 'Mod Exceptions', type: 'Your list', listWarn: true,
        lose: 'every mod you added to the exceptions list',
        items: [fileItem({
            id: 'mod-exceptions/mod-exceptions.json', name: 'Exceptions list',
            filePath: path.join(appDataDir, 'mod-exceptions', 'mod-exceptions.json'),
            tool: 'Mod Exceptions', type: 'Your list', listWarn: true, appDataDir, originDates,
            lose: 'every mod you added to the exceptions list',
        })].filter(Boolean),
    });

    // ---- Mod Scrub: your hand-built exclude list ----
    groups.push({
        tool: 'Mod Scrub', type: 'Your list', listWarn: true,
        lose: 'every folder/archive name you marked Exclude',
        items: [fileItem({
            id: 'mod-scrub/exclude-list.json', name: 'Exclude list',
            filePath: path.join(appDataDir, 'mod-scrub', 'exclude-list.json'),
            tool: 'Mod Scrub', type: 'Your list', listWarn: true, appDataDir, originDates,
            lose: 'every folder/archive name you marked Exclude',
        })].filter(Boolean),
    });

    // ---- Archive Finder: search index (cache) ----
    groups.push({
        tool: 'Archive Finder', type: 'Cache',
        lose: 'nothing permanent — the search index rebuilds itself on your next search (the first one will be slower)',
        items: (() => {
            const dirPath = path.join(appDataDir, 'archive-finder', 'index');
            const summary = summarizeDir(appDataDir, dirPath, originDates);
            return [dirItem({
                id: 'archive-finder/index', name: 'Archive search index', dirPath, summary,
                tool: 'Archive Finder', type: 'Cache',
                lose: 'nothing permanent — the search index rebuilds itself on your next search (the first one will be slower)',
            })].filter(Boolean);
        })(),
    });

    // ---- Merge Plugins: script relink cache ----
    groups.push({
        tool: 'Merge Plugins', type: 'Cache',
        lose: "nothing permanent — it rebuilds itself the next time it's needed",
        items: [fileItem({
            id: 'merge-plugins/relink-scripts-cache.json', name: 'Script relink cache',
            filePath: path.join(appDataDir, 'merge-plugins', 'relink-scripts-cache.json'),
            tool: 'Merge Plugins', type: 'Cache', appDataDir, originDates,
            lose: "nothing permanent — it rebuilds itself the next time it's needed",
        })].filter(Boolean),
    });

    // Groups with zero real items today (nothing saved yet, or already deleted) are dropped entirely
    // -- an empty "Rules snapshot" group with a checkbox that deletes nothing is just noise.
    return groups.filter((g) => g.items.length > 0);
}

function totalCountAndSize(groups) {
    let count = 0, sizeBytes = 0;
    for (const g of groups) for (const it of g.items) { count++; sizeBytes += it.sizeBytes; }
    return { count, sizeBytes };
}

// Deletes exactly the given deletePath list, after validating each one genuinely resolves inside
// appDataDir -- the same "never trust a client-supplied path without validating containment" rule
// this app already applies to log filenames (rebuild-routes.js) and merge history paths. Returns
// {deleted, errors}; a single bad/outside path is skipped (reported in errors), never used to abort
// the rest of a batch.
function validateAndCollectPaths(appDataDir, deletePaths) {
    const root = path.resolve(appDataDir);
    const valid = [];
    const errors = [];
    for (const p of deletePaths) {
        const resolved = path.resolve(p);
        if (resolved !== root && !resolved.startsWith(root + path.sep)) {
            errors.push(`Refused to delete "${p}" -- outside the App Data folder.`);
            continue;
        }
        valid.push(resolved);
    }
    return { valid, errors };
}

module.exports = { buildGroups, totalCountAndSize, validateAndCollectPaths };
