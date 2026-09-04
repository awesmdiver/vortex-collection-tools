'use strict';
// Save Cleaner's own backup store -- a save file (.ess + its paired .skse) is far more valuable to
// a real playthrough than a re-extractable mod folder, so this deliberately does NOT reuse Rebuild
// Collection's own pruneOldBackups (lib/collection-runner.js) or Update Collection's state-backup
// store (lib/vortex-sync/lib.js's STATE_BACKUPS_DIR) as-is -- neither is a clean fit: the former
// groups by a modId-prefixed folder name (no meaning here) and the latter's root is hardcoded, not
// user-configurable (this tool's backup root IS, per the mockup's own Settings section). Instead
// this combines the SIMPLER slice-and-delete keep-N logic pruneStateBackups uses with a
// user-configurable root the way pruneOldBackups has one -- see each function's own header comment
// for exactly which existing pattern it mirrors.
//
// One backup = one dated subfolder containing BOTH files from one save (never just the .ess), plus
// a tiny metadata.json recording the original filename/directory so Restore knows exactly where a
// backup came from without the user having to remember or retype it.

const fs = require('fs');
const path = require('path');

function timestampSlug(date) {
    return date.toISOString().replace(/[:.]/g, '-');
}

// Takes a backup of one save (both files, if the co-save exists) into `<backupRoot>/<original
// basename>-<timestamp>/`. Called right before ANY write that could destroy the original: overwriting
// via "Save", and (defensively) before restoring a different backup over the live saves folder.
// Silently returns null if backupRoot isn't configured -- Save/Save As both still work without one,
// per this tool's own "blank is a supported state" convention (see lib/app-config.js).
function backupSave(backupRoot, essPath, cosavePath) {
    if (!backupRoot) return null;
    const baseName = path.basename(essPath, path.extname(essPath));
    const backupDir = path.join(backupRoot, `${baseName}-${timestampSlug(new Date())}`);
    fs.mkdirSync(backupDir, { recursive: true });
    const essDest = path.join(backupDir, path.basename(essPath));
    fs.copyFileSync(essPath, essDest);
    let cosaveDest = null;
    if (cosavePath && fs.existsSync(cosavePath)) {
        cosaveDest = path.join(backupDir, path.basename(cosavePath));
        fs.copyFileSync(cosavePath, cosaveDest);
    }
    const metadata = {
        originalEssPath: essPath,
        originalCosavePath: cosavePath || null,
        createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(backupDir, 'metadata.json'), JSON.stringify(metadata, null, 2));
    return { backupDir, essPath: essDest, cosavePath: cosaveDest };
}

// Newest-first, same shape lib/vortex-sync/lib.js's own listStateBackups returns ({name, dir,
// createdAt}) so the frontend/Settings pattern this mirrors needs no translation layer.
function listSaveBackups(backupRoot) {
    if (!backupRoot || !fs.existsSync(backupRoot)) return [];
    let entries;
    try {
        entries = fs.readdirSync(backupRoot, { withFileTypes: true });
    } catch {
        return [];
    }
    const backups = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(backupRoot, entry.name);
        let metadata = {};
        try {
            metadata = JSON.parse(fs.readFileSync(path.join(dir, 'metadata.json'), 'utf8'));
        } catch {
            metadata = {};
        }
        let createdAt = metadata.createdAt;
        if (!createdAt) {
            try { createdAt = fs.statSync(dir).mtime.toISOString(); } catch { createdAt = null; }
        }
        backups.push({ name: entry.name, dir, createdAt, originalEssPath: metadata.originalEssPath || null });
    }
    backups.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
    return backups;
}

// Same slice-and-delete shape as lib/vortex-sync/lib.js's pruneStateBackups: null/undefined means
// unlimited (no pruning at all -- there is no "0 = off" state, same reasoning maxStateBackupsToKeep
// already documents, since these backups are a safety net, not an optional convenience).
function pruneSaveBackups(backupRoot, maxToKeep) {
    if (maxToKeep == null) return { deleted: [] };
    const backups = listSaveBackups(backupRoot); // newest-first already
    const excess = backups.slice(maxToKeep);
    for (const b of excess) fs.rmSync(b.dir, { recursive: true, force: true });
    return { deleted: excess.map((b) => b.name) };
}

function deleteAllSaveBackups(backupRoot) {
    const backups = listSaveBackups(backupRoot);
    for (const b of backups) fs.rmSync(b.dir, { recursive: true, force: true });
    return { deleted: backups.map((b) => b.name) };
}

// Restores one backup's own files back to their ORIGINAL recorded location (metadata.json's
// originalEssPath/originalCosavePath) -- a real, hard-to-reverse overwrite of whatever currently
// sits there, so callers (web/save-cleaner-routes.js) must gate this behind the same explicit
// confirmation any other real overwrite in this app requires. Validates the backup dir is genuinely
// inside the configured backupRoot first (same "never trust a client-submitted path" guard every
// other restore/delete route in this app already applies -- e.g. Merge History's own resolveMergeById).
function restoreSaveBackup(backupRoot, backupDirName) {
    const resolvedRoot = path.resolve(backupRoot);
    const backupDir = path.resolve(backupRoot, backupDirName);
    if (backupDir !== resolvedRoot && !backupDir.startsWith(resolvedRoot + path.sep)) {
        throw new Error('That backup could not be found.');
    }
    const metadataPath = path.join(backupDir, 'metadata.json');
    if (!fs.existsSync(metadataPath)) throw new Error('That backup is missing its own metadata and cannot be restored automatically.');
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    if (!metadata.originalEssPath) throw new Error('That backup does not record where it came from.');

    const essName = path.basename(metadata.originalEssPath);
    const backedUpEss = path.join(backupDir, essName);
    if (!fs.existsSync(backedUpEss)) throw new Error(`Backup is missing its own .ess file (${essName}).`);
    fs.mkdirSync(path.dirname(metadata.originalEssPath), { recursive: true });
    fs.copyFileSync(backedUpEss, metadata.originalEssPath);

    let restoredCosave = false;
    if (metadata.originalCosavePath) {
        const cosaveName = path.basename(metadata.originalCosavePath);
        const backedUpCosave = path.join(backupDir, cosaveName);
        if (fs.existsSync(backedUpCosave)) {
            fs.copyFileSync(backedUpCosave, metadata.originalCosavePath);
            restoredCosave = true;
        }
    }
    return { restoredEssPath: metadata.originalEssPath, restoredCosavePath: restoredCosave ? metadata.originalCosavePath : null };
}

module.exports = { backupSave, listSaveBackups, pruneSaveBackups, deleteAllSaveBackups, restoreSaveBackup };
