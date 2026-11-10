'use strict';
// Ported from the standalone Archive File Finder project (folded into this project 2026-07-28 --
// see TECHNICAL.md's "Archive Finder" section). Two real changes from the original:
//   1. Uses this project's own lib/sevenzip.js (a strict superset of the standalone tool's own
//      copy -- bundled-7z-first lookup, a UTF-8 listing flag the original lacked, and a directory-
//      detection bug fix), not a duplicate implementation.
//   2. scan() now takes its scan folder, extensions, and DB explicitly as arguments instead of
//      reading a hardcoded db.getConfig() -- the scan folder is this project's own existing shared
//      `downloads` setting (the same folder Rebuild Collection already uses), not a second,
//      independent "scan folder" setting.

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const sevenzip = require('./sevenzip');
const { isAbsoluteJunkEntry } = require('./archive-finder-junk-paths');

const ARCHIVE_EXTENSIONS = new Set(['.zip', '.7z', '.rar']);
const CONCURRENCY = 6;

// Per-archive time limit: 90 s, plus 30 s per 100 MiB, capped at 10 minutes. Listing a healthy
// archive takes well under a second, so this only ever catches one that is stuck.
const BASE_LIMIT_MS = 90 * 1000;
const EXTRA_MS_PER_100_MIB = 30 * 1000;
const MAX_LIMIT_MS = 10 * 60 * 1000;
function timeLimitMs(sizeBytes) {
    const extra = Math.floor((sizeBytes || 0) / (100 * 1024 * 1024)) * EXTRA_MS_PER_100_MIB;
    return Math.min(BASE_LIMIT_MS + extra, MAX_LIMIT_MS);
}

function findArchivesOnDisk(folder) {
    const results = [];
    const entries = fs.readdirSync(folder, { withFileTypes: true });
    for (const entry of entries) {
        if (entry.isDirectory()) continue; // top-level only; downloads folders aren't nested
        const ext = path.extname(entry.name).toLowerCase();
        if (!ARCHIVE_EXTENSIONS.has(ext)) continue;
        const full = path.join(folder, entry.name);
        const st = fs.statSync(full);
        results.push({ path: full, name: entry.name, size: st.size, mtime: Math.floor(st.mtimeMs) });
    }
    return results;
}

// Runs a bounded-concurrency pool over `items`, calling `worker(item)` for each.
async function pool(items, concurrency, worker, shouldStop = () => false) {
    let idx = 0;
    async function runNext() {
        while (idx < items.length && !shouldStop()) {
            const i = idx++;
            await worker(items[i]);
        }
    }
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, runNext);
    await Promise.all(workers);
}

// emits: 'progress' {phase, current, total, message, errors, activeSeconds}, 'done' {summary}, 'error' {message}
// The returned emitter also has skipCurrent() (give up on the archive that has been running longest)
// and stop() (end the scan cleanly, keeping what was indexed). `limitMs` overrides timeLimitMs (tests).
function scan({ scanFolder, extensions: rawExtensions, archiveDb, limitMs = timeLimitMs }) {
    const emitter = new EventEmitter();
    const active = new Map(); // archive path -> { name, startedAt, control }
    let stopped = false;
    const oldestActive = () => {
        let oldest = null;
        for (const a of active.values()) if (!oldest || a.startedAt < oldest.startedAt) oldest = a;
        return oldest;
    };
    emitter.skipCurrent = () => {
        const oldest = oldestActive();
        if (!oldest || !oldest.control.kill) return false;
        oldest.control.skipped = true;
        oldest.control.kill('SEVENZIP_SKIPPED');
        return true;
    };
    emitter.stop = () => {
        stopped = true;
        for (const a of active.values()) if (a.control.kill) a.control.kill('SEVENZIP_STOPPED');
    };
    (async () => {
        try {
            const exePath = sevenzip.findSevenZip();
            const extensions = rawExtensions.map((e) => e.toLowerCase());

            if (!scanFolder) {
                emitter.emit('error', { message: 'No downloads folder configured. Set one up under Settings first.' });
                return;
            }
            if (!fs.existsSync(scanFolder)) {
                emitter.emit('error', { message: `Downloads folder does not exist: ${scanFolder}` });
                return;
            }

            // 7-Zip that cannot start is a problem with the tool, not with any archive: check once up
            // front and stop with one clear error instead of trying thousands of archives.
            const sevenZipDown = (err) => emitter.emit('error', {
                code: 'sevenzip-unavailable',
                message: "7-Zip couldn't be started, so no archives were read. Locate 7-Zip to continue.",
                detail: String(err.message || err),
            });
            try {
                await sevenzip.probe(exePath);
            } catch (err) {
                if (sevenzip.isSevenZipUnavailable(err)) return sevenZipDown(err);
            }
            // Archives an older scan marked "failed" only because 7-Zip could not start were never
            // really read: forget them so they are scanned fresh below. Real failures stay.
            archiveDb.clearToolErrors();
            // A new scan starts with a clean failed count: every earlier failed mark is dropped and
            // those archives are read again, so the count only ever holds THIS scan's failures.
            archiveDb.resetFailedMarks();

            emitter.emit('progress', { phase: 'listing', current: 0, total: 0, message: 'Reading folder contents...' });
            const onDisk = findArchivesOnDisk(scanFolder);
            const onDiskByPath = new Map(onDisk.map((a) => [a.path, a]));

            const inDb = archiveDb.listArchivePaths();
            const inDbByPath = new Map(inDb.map((a) => [a.path, a]));

            // Removed: in DB but no longer on disk.
            let removed = 0;
            for (const dbArchive of inDb) {
                if (!onDiskByPath.has(dbArchive.path)) {
                    archiveDb.deleteArchive(dbArchive.id);
                    removed++;
                }
            }

            // New, changed on disk, or missing coverage for a newly-added tracked extension (e.g.
            // you added ".esm" after this archive was last scanned for ".esp" only) -- any of these
            // forces a re-list.
            const toScan = onDisk.filter((a) => {
                const existing = inDbByPath.get(a.path);
                if (!existing) return true;
                if (existing.size !== a.size || existing.mtime !== a.mtime) return true;
                let previouslyScanned;
                try {
                    previouslyScanned = new Set(JSON.parse(existing.scanned_extensions || '[]'));
                } catch {
                    previouslyScanned = new Set();
                }
                return !extensions.every((ext) => previouslyScanned.has(ext));
            });
            const skipped = onDisk.length - toScan.length;

            emitter.emit('progress', {
                phase: 'scanning',
                current: 0,
                total: toScan.length,
                message: `${toScan.length} new/changed archive(s) to scan, ${skipped} unchanged, ${removed} removed`,
                errors: 0,
            });

            let done = 0;
            let errors = 0;
            let toolFailure = null; // 7-Zip stopped starting mid-scan: never recorded against an archive
            let tookTooLong = 0; // timed out or skipped by the person: not stored, so the next scan tries again
            const emitProgress = (message) => {
                const oldest = oldestActive();
                emitter.emit('progress', {
                    phase: 'scanning',
                    current: done,
                    total: toScan.length,
                    message: oldest ? oldest.name : message,
                    errors, // failures so far in THIS scan, never more than `current`
                    activeSeconds: oldest ? Math.floor((Date.now() - oldest.startedAt) / 1000) : 0,
                });
            };
            // Once a second, so the page can show how long the current archive has been running.
            const heartbeat = setInterval(() => { if (active.size) emitProgress(''); }, 1000);
            heartbeat.unref();
            await pool(toScan, CONCURRENCY, async (archive) => {
                if (toolFailure || stopped) return;
                const control = {};
                active.set(archive.path, { name: archive.name, startedAt: Date.now(), control });
                const startedAt = Date.now();
                try {
                    const entries = await sevenzip.listArchive(exePath, archive.path, { timeoutMs: limitMs(archive.size), control });
                    const archiveId = archiveDb.upsertArchive({
                        path: archive.path,
                        name: archive.name,
                        size: archive.size,
                        mtime: archive.mtime,
                        scannedExtensions: extensions,
                    });
                    const matched = entries
                        .filter((e) => !e.isDir && !isAbsoluteJunkEntry(e.path))
                        .map((e) => ({ entry: e, ext: path.extname(e.path).toLowerCase() }))
                        .filter(({ ext }) => extensions.includes(ext))
                        .map(({ entry, ext }) => ({
                            internalPath: entry.path,
                            fileName: path.basename(entry.path),
                            extension: ext,
                            size: entry.size,
                        }));
                    archiveDb.insertFiles(archiveId, matched);
                } catch (err) {
                    if (sevenzip.isSevenZipUnavailable(err)) {
                        toolFailure = toolFailure || err;
                        return;
                    }
                    if (err.code === 'SEVENZIP_STOPPED') return; // the person stopped the scan: not a result
                    if (err.code === 'SEVENZIP_TIMEOUT' || err.code === 'SEVENZIP_SKIPPED') {
                        tookTooLong++;
                        console.warn(`[archive-finder] gave up on "${archive.name}" (${archive.size} bytes) after ${Math.round((Date.now() - startedAt) / 1000)} s (${err.code === 'SEVENZIP_SKIPPED' ? 'skipped by the person' : 'time limit'}); 7-Zip had printed ${err.stdoutBytes} bytes: ${err.output || '(nothing)'}`);
                        return;
                    }
                    errors++;
                    archiveDb.upsertArchive({
                        path: archive.path,
                        name: archive.name,
                        size: archive.size,
                        mtime: archive.mtime,
                        scanError: String(err.message || err),
                    });
                } finally {
                    active.delete(archive.path);
                    if (!stopped) {
                        done++;
                        emitProgress(archive.name);
                    }
                }
            }, () => !!toolFailure || stopped);
            clearInterval(heartbeat);

            if (toolFailure) return sevenZipDown(toolFailure);

            emitter.emit('done', {
                stopped,
                tookTooLong,
                scanned: stopped ? done : toScan.length,
                skipped,
                removed,
                errors,
                stats: archiveDb.stats(),
            });
        } catch (err) {
            emitter.emit('error', { message: String(err.message || err) });
        }
    })();
    return emitter;
}

module.exports = { scan, timeLimitMs };
