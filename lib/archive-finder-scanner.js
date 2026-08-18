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
async function pool(items, concurrency, worker) {
    let idx = 0;
    async function runNext() {
        while (idx < items.length) {
            const i = idx++;
            await worker(items[i]);
        }
    }
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, runNext);
    await Promise.all(workers);
}

// emits: 'progress' {phase, current, total, message}, 'done' {summary}, 'error' {message}
function scan({ scanFolder, extensions: rawExtensions, archiveDb }) {
    const emitter = new EventEmitter();
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
            });

            let done = 0;
            let errors = 0;
            await pool(toScan, CONCURRENCY, async (archive) => {
                try {
                    const entries = await sevenzip.listArchive(exePath, archive.path);
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
                    errors++;
                    archiveDb.upsertArchive({
                        path: archive.path,
                        name: archive.name,
                        size: archive.size,
                        mtime: archive.mtime,
                        scanError: String(err.message || err),
                    });
                } finally {
                    done++;
                    emitter.emit('progress', {
                        phase: 'scanning',
                        current: done,
                        total: toScan.length,
                        message: archive.name,
                    });
                }
            });

            emitter.emit('done', {
                scanned: toScan.length,
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

module.exports = { scan };
