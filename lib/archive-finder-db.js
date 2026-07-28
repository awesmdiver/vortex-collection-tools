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

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

function createDb(dbDir) {
    fs.mkdirSync(dbDir, { recursive: true });
    const dbPath = path.join(dbDir, 'archive.db');
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode = WAL;');

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
    // so a graceful close on server shutdown matters.
    function close() {
        db.close();
    }

    return {
        listArchivePaths,
        getArchiveByPath,
        getArchiveById,
        upsertArchive,
        insertFiles,
        deleteArchive,
        search,
        searchArchives,
        getFailedArchives,
        stats,
        close,
    };
}

module.exports = { createDb };
