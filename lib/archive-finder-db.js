'use strict';
// Ported from the standalone Archive File Finder project (folded into this project 2026-07-28 --
// see TECHNICAL.md's "Archive Finder" section for the full writeup). Two real changes from the
// original:
//   1. The DB directory is now a required Settings path field (archiveFinderDbDir), not hardcoded
//      to a `data/` folder inside the project's own source tree -- matches this project's own
//      standing rule that every new data location is a user-chosen path, never a silent default
//      (see cleanupExcludeListDir/skyrimDataDir/etc. in lib/app-config.js for the same pattern).
//      createDb() is now a factory taking that directory, not a module-level singleton opened at
//      require-time against a fixed path.
//   2. The original's own `config` table (scanFolder/outputFolder/extensions) is gone entirely --
//      scanFolder is now the project's existing shared `downloads` field (the same folder Rebuild
//      Collection already uses), and outputFolder/extensions moved into the single unified
//      config.json (lib/app-config.js) instead of a second, tool-local settings store. This module
//      is now purely the archive/file search index, nothing else.
//
// 2026-08-27 (GitHub issue #4): real fix for two real failures a tester hit --
//   1. The index file was named `archive.db`, indistinguishable by name from something ANOTHER
//      application might own in the same folder. Renamed to `vct_archive.db`.
//   2. `createDb()` opened whatever file already sat at the target path unconditionally, ran
//      `CREATE TABLE IF NOT EXISTS`/`ALTER TABLE` against it, and flipped it into WAL mode -- all of
//      which succeed silently even against a database this app has never seen before. A file we
//      don't recognize is now probed FIRST (read-only, before any write of any kind) and refused if
//      it doesn't carry our own marker/schema -- see probeDatabase()/migrateLegacyDatabase() below.
// See TECHNICAL.md's "Archive Finder database: real fix for GitHub issue #4" section for the full
// writeup (root cause, the migration decision tree, the WAL-vs-default-journal decision).

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');
const { findVortexManagedConflict } = require('./vortex-managed-paths');

const DB_FILENAME = 'vct_archive.db';
const LEGACY_DB_FILENAME = 'archive.db'; // pre-2026-08-27 name -- see migrateLegacyDatabase()

// SQLite reserves a 4-byte "application_id" field in every database's own header (PRAGMA
// application_id) FOR EXACTLY THIS PURPOSE -- SQLite's own docs describe it as letting an
// application "signify what specific file format" a database uses, checkable before an application
// reads or writes to it. Using the field SQLite already provides for this, rather than inventing a
// marker table, means the check works even against a 0-byte-of-our-own-data-yet, freshly-created
// file, and never requires a write into a file we haven't yet confirmed is safe to write to.
// 0x76637430 spells "vct0" as big-endian ASCII bytes -- arbitrary, but traceable if anyone ever
// inspects a raw header by hand.
const APP_ID = 0x76637430;

// Column sets that make an 'archives'/'files' pair (see the CREATE TABLE below) unmistakably OUR
// schema, used only as the migration-time fallback for a genuine pre-marker index from an earlier
// version of this tool (the application_id marker is new as of this fix -- an existing user's real,
// already-populated index legitimately won't have it yet, and must not be treated as foreign just
// because it predates the marker).
const ARCHIVES_TABLE_SHAPE = ['id', 'path', 'name', 'size', 'mtime', 'last_scanned'];
const FILES_TABLE_SHAPE = ['id', 'archive_id', 'internal_path', 'file_name', 'extension', 'size'];

// Read-only probe of an EXISTING file at `dbPath` -- opens it, sets `PRAGMA query_only = ON`
// (guarantees this connection cannot write anything, even by accident, before we've decided the
// file is safe to touch for real), and reports whether it's plausibly ours. Never throws; a file
// that isn't even a valid SQLite database (wrong format, corrupt, 0 bytes) reports 'unreadable', the
// same "don't touch it" outcome as a definitely-foreign one -- we can't confirm it's ours, so we
// don't proceed.
//
// Checks the application_id marker first (the fast path once every database this tool creates
// carries it), falling back to schema introspection ONLY when the marker is absent -- covers a
// genuine pre-marker index from before this fix without needing every caller to also special-case
// "old vs. new" themselves.
function probeDatabase(dbPath) {
    let probe;
    try {
        probe = new DatabaseSync(dbPath);
    } catch {
        return 'unreadable';
    }
    try {
        probe.exec('PRAGMA query_only = ON;');
        const idRow = probe.prepare('PRAGMA application_id').get();
        if (idRow && Number(idRow.application_id) === APP_ID) return 'ours';

        const tableNames = probe.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('archives', 'files')"
        ).all().map((r) => r.name);
        if (tableNames.length !== 2) return 'foreign';

        const archiveCols = probe.prepare('PRAGMA table_info(archives)').all().map((c) => c.name);
        const fileCols = probe.prepare('PRAGMA table_info(files)').all().map((c) => c.name);
        const hasArchivesShape = ARCHIVES_TABLE_SHAPE.every((c) => archiveCols.includes(c));
        const hasFilesShape = FILES_TABLE_SHAPE.every((c) => fileCols.includes(c));
        return hasArchivesShape && hasFilesShape ? 'ours' : 'foreign';
    } catch {
        return 'unreadable';
    } finally {
        probe.close();
    }
}

// Moves a pre-rename `archive.db` (this tool's own OLD filename) to `vct_archive.db`, but ONLY once
// probeDatabase() has confirmed it's genuinely ours -- a foreign or unreadable file at the legacy
// name is left COMPLETELY alone (not opened again, not renamed, not deleted). Returns a status the
// caller can log/surface:
//   'none'           -- no archive.db present, nothing to do (the common case for a fresh install,
//                        or any install that's already migrated).
//   'target-exists'  -- vct_archive.db already exists too; the legacy file is left as-is rather
//                        than risk clobbering a real index (should only happen if migration already
//                        ran once, or the folder was hand-edited).
//   'migrated'       -- confirmed ours, moved (with its -wal/-shm siblings, if present) to the new
//                        name.
//   'left-foreign'   -- confirmed NOT ours; left untouched.
//   'left-unreadable'-- couldn't confirm either way (not a valid SQLite file, or some other read
//                        failure); left untouched, same as 'left-foreign'.
function migrateLegacyDatabase(dbDir) {
    const legacyPath = path.join(dbDir, LEGACY_DB_FILENAME);
    const targetPath = path.join(dbDir, DB_FILENAME);
    if (!fs.existsSync(legacyPath)) return { status: 'none' };
    if (fs.existsSync(targetPath)) return { status: 'target-exists', legacyPath, targetPath };

    const verdict = probeDatabase(legacyPath);
    if (verdict !== 'ours') {
        return { status: verdict === 'foreign' ? 'left-foreign' : 'left-unreadable', legacyPath };
    }

    // Confirmed ours -- move the main file and its WAL/SHM siblings (if present) together, so the
    // migration can never split an in-flight WAL from the main file it belongs to.
    fs.renameSync(legacyPath, targetPath);
    for (const suffix of ['-wal', '-shm']) {
        const src = `${legacyPath}${suffix}`;
        if (fs.existsSync(src)) fs.renameSync(src, `${targetPath}${suffix}`);
    }
    return { status: 'migrated', legacyPath, targetPath };
}

// vortexPaths (2026-08-27, issue #4): { downloads, staging } -- the two folders Vortex itself
// actively manages (see lib/vortex-managed-paths.js's own header for why exactly these two).
// Checked BEFORE anything else here touches the filesystem at all, so a bad setting never gets the
// chance to create a folder, migrate a file, or open a database inside Vortex's own working area.
// Optional (defaults to {}) so a caller that genuinely has no config context available (none exist
// in this codebase today, but nothing here should hard-require it) degrades to skipping the check
// rather than crashing.
function createDb(dbDir, vortexPaths = {}) {
    const conflict = findVortexManagedConflict(dbDir, vortexPaths);
    if (conflict) {
        const err = new Error(
            `The Archive Finder database folder ("${dbDir}") is the same as, or inside, your ` +
            `${conflict.label} ("${conflict.path}"). Vortex actively manages that folder, and this ` +
            `app holding a database open there can block Vortex itself with a "File busy" error. ` +
            `Choose a different folder for the Archive Finder database in Settings.`
        );
        err.code = 'DB_IN_VORTEX_MANAGED_FOLDER';
        throw err;
    }

    fs.mkdirSync(dbDir, { recursive: true });
    const migration = migrateLegacyDatabase(dbDir);
    const dbPath = path.join(dbDir, DB_FILENAME);

    // vct_archive.db can ALSO already exist and not be ours (hand-placed, copied in from somewhere
    // else, a name collision) -- confirm before opening it for real here too, same reasoning as the
    // legacy path just above. This is the actual safety fix: a plain `CREATE TABLE IF NOT EXISTS`
    // against a stranger's database succeeds silently, which is exactly what made this class of bug
    // possible to ship unnoticed in the first place.
    if (fs.existsSync(dbPath)) {
        const verdict = probeDatabase(dbPath);
        if (verdict !== 'ours') {
            const err = new Error(
                `"${dbPath}" already exists but doesn't look like an Archive Finder index -- refusing ` +
                `to open it. Move or rename that file, or choose a different Archive Finder database ` +
                `folder in Settings.`
            );
            err.code = 'FOREIGN_DATABASE';
            err.migration = migration;
            throw err;
        }
    }

    const db = new DatabaseSync(dbPath);
    // WAL, deliberately kept (decided, not left over by default -- see TECHNICAL.md): TWO separate
    // routes (web/archive-finder-routes.js, web/missing-masters-routes.js) each call createDb() and
    // can genuinely hold independent connections to this SAME file at once -- a scan actively
    // writing (upsertArchive/insertFiles, many times over a long scan) while a concurrent Missing
    // Masters restore search reads is a real, ordinary usage pattern, not a hypothetical. WAL is
    // exactly the SQLite mode built for "one writer, several readers, neither blocks the other" --
    // the default rollback-journal mode can make a concurrent reader wait on a writer (or vice
    // versa). The larger on-disk footprint (a -wal/-shm sidecar alongside the main file) is the
    // real, known tradeoff; the fix for THAT is (2)/(3) above -- never letting this file sit
    // somewhere Vortex is watching -- not dropping WAL, which would reintroduce real lock contention
    // between this project's own two callers instead.
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec(`PRAGMA application_id = ${APP_ID};`);

    db.exec(`
CREATE TABLE IF NOT EXISTS archives (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime INTEGER NOT NULL,
  last_scanned INTEGER NOT NULL,
  scan_error TEXT
);
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  archive_id INTEGER NOT NULL REFERENCES archives(id) ON DELETE CASCADE,
  internal_path TEXT NOT NULL,
  file_name TEXT NOT NULL,
  extension TEXT NOT NULL,
  size INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_files_name ON files(file_name);
CREATE INDEX IF NOT EXISTS idx_files_archive ON files(archive_id);
`);

    // Migration for DBs created before extension-coverage tracking existed.
    try {
        db.exec('ALTER TABLE archives ADD COLUMN scanned_extensions TEXT');
    } catch (err) {
        if (!/duplicate column/i.test(String(err.message))) throw err;
    }

    function listArchivePaths() {
        return db.prepare('SELECT id, path, size, mtime, scanned_extensions FROM archives').all();
    }

    function getArchiveByPath(p) {
        return db.prepare('SELECT * FROM archives WHERE path = ?').get(p);
    }

    function upsertArchive({ path: p, name, size, mtime, scanError, scannedExtensions }) {
        const now = Date.now();
        const extJson = JSON.stringify(scannedExtensions || []);
        const existing = getArchiveByPath(p);
        if (existing) {
            db.prepare(
                'UPDATE archives SET name = ?, size = ?, mtime = ?, last_scanned = ?, scan_error = ?, scanned_extensions = ? WHERE id = ?'
            ).run(name, size, mtime, now, scanError || null, extJson, existing.id);
            db.prepare('DELETE FROM files WHERE archive_id = ?').run(existing.id);
            return existing.id;
        }
        const result = db.prepare(
            'INSERT INTO archives (path, name, size, mtime, last_scanned, scan_error, scanned_extensions) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(p, name, size, mtime, now, scanError || null, extJson);
        return Number(result.lastInsertRowid);
    }

    function insertFiles(archiveId, files) {
        if (!files.length) return;
        const stmt = db.prepare(
            'INSERT INTO files (archive_id, internal_path, file_name, extension, size) VALUES (?, ?, ?, ?, ?)'
        );
        for (const f of files) {
            stmt.run(archiveId, f.internalPath, f.fileName, f.extension, f.size);
        }
    }

    function deleteArchive(id) {
        db.prepare('DELETE FROM archives WHERE id = ?').run(id);
    }

    // Matches indexed files by their own file name only (not the archive name they happen to live
    // in) -- searching "lanterns of skyrim" should not pull in every unrelated .esp from an archive
    // merely because the archive is named "Lanterns Of Skyrim II - FOMOD.7z".
    function search(query, extensions) {
        const like = `%${query.replace(/[%_]/g, '\\$&')}%`;
        const placeholders = extensions.map(() => '?').join(',');
        return db.prepare(`
    SELECT f.id as fileId, f.internal_path as internalPath, f.file_name as fileName,
           f.extension as extension, f.size as fileSize,
           a.id as archiveId, a.path as archivePath, a.name as archiveName
    FROM files f
    JOIN archives a ON a.id = f.archive_id
    WHERE f.extension IN (${placeholders})
      AND f.file_name LIKE ? ESCAPE '\\'
    ORDER BY a.name COLLATE NOCASE, f.file_name COLLATE NOCASE
  `).all(...extensions, like);
    }

    // Matches archives by their own file name, for "Display Archive" mode where the user picks an
    // archive and then browses its full contents live.
    function searchArchives(query) {
        const like = `%${query.replace(/[%_]/g, '\\$&')}%`;
        return db.prepare(`
    SELECT id as archiveId, path as archivePath, name as archiveName, size, scan_error as scanError
    FROM archives
    WHERE name LIKE ? ESCAPE '\\'
    ORDER BY name COLLATE NOCASE
  `).all(like);
    }

    // How many indexed files one archive contributed. Added 2026-08-23 for Missing Masters' own
    // Restore chooser, which shows a file count per candidate archive so the user can tell a full
    // mod apart from a small patch at a glance. Read-only; nothing else about the schema changed.
    function countFilesInArchive(id) {
        return db.prepare('SELECT COUNT(*) as c FROM files WHERE archive_id = ?').get(id).c;
    }

    function getArchiveById(id) {
        return db.prepare('SELECT * FROM archives WHERE id = ?').get(id);
    }

    function getFailedArchives() {
        return db.prepare(`
    SELECT id as archiveId, path as archivePath, name as archiveName, size, scan_error as scanError
    FROM archives
    WHERE scan_error IS NOT NULL
    ORDER BY name COLLATE NOCASE
  `).all();
    }

    function stats() {
        const archiveCount = db.prepare('SELECT COUNT(*) as c FROM archives').get().c;
        const fileCount = db.prepare('SELECT COUNT(*) as c FROM files').get().c;
        const errorCount = db.prepare('SELECT COUNT(*) as c FROM archives WHERE scan_error IS NOT NULL').get().c;
        const lastScanned = db.prepare('SELECT MAX(last_scanned) as t FROM archives').get().t;
        return { archiveCount, fileCount, errorCount, lastScanned };
    }

    // Flushes WAL and closes cleanly. With WAL mode's default synchronous=NORMAL, an unclean
    // process kill can drop the last few commits (safe against corruption, not against data loss),
    // so a graceful close on server shutdown -- and now, on idle (see web/archive-finder-routes.js's
    // own close-when-idle logic, issue #4) -- matters.
    function close() {
        db.close();
    }

    return {
        listArchivePaths,
        getArchiveByPath,
        getArchiveById,
        countFilesInArchive,
        upsertArchive,
        insertFiles,
        deleteArchive,
        search,
        searchArchives,
        getFailedArchives,
        stats,
        close,
        migration, // { status, legacyPath?, targetPath? } from migrateLegacyDatabase() above -- lets
        // a caller log/surface what happened to a pre-existing legacy archive.db, if anything.
    };
}

module.exports = { createDb, DB_FILENAME, LEGACY_DB_FILENAME };
