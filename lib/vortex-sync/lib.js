// Shared logic for both the CLI (index.js) and the interactive menu (menu.js).
//
// This NEVER opens or writes Vortex's live state database. It always copies
// state.v2 to a temp directory first and opens the copy read-only. If Vortex
// is running and holds files locked, the copy will fail and the caller is
// told to close Vortex and retry.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { ClassicLevel } = require('classic-level');

const DEFAULT_STATE_DIR = path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'Vortex',
  'state.v2'
);
const GAME_ID = 'skyrimse';
// Points at the project's single unified config.json (lib/app-config.js) -- the web UI's Settings
// page and this terminal tool both read/write the SAME file now, rather than two independent
// config.jsons that could drift out of sync (this one used to be its own sibling file here).
const appConfig = require('../app-config');
const CONFIG_PATH = appConfig.CONFIG_PATH;
const BACKUP_SCHEMA_VERSION = 1;

// Vortex versions this tool's live-state writes (apply-ignores, apply-disables)
// have actually been tested against. Vortex occasionally changes its state
// layout between versions — this doesn't guarantee compatibility, but a
// mismatch is a clear signal to double-check before trusting an automated
// write, rather than silently assuming the schema this tool was built
// against still holds.
// '2.3.0-beta.1' was tested first; '2.3.0' (the final release) confirmed separately this same
// session -- extensively exercised (backup/apply-ignores preview+apply, apply-disables, restore)
// against real state.v2 data with no schema surprises. The exact-string TESTED_VORTEX_VERSIONS.
// includes() check doesn't treat these as "the same version" otherwise, so the warning kept firing
// even though 2.3.0 itself was already proven fine.
// 2.4.0-beta.1/.2/stable added 2026-07-27 -- SOURCE-LEVEL research only (Nexus-Mods/Vortex's real
// GitHub history + CHANGELOG.md), not yet live-exercised against an actual 2.4.0 state.v2 the way
// 2.3.0 was. Findings: only one migration shipped since 2.3.0 (`healStoragePathNames_2_4`, 2.4.0
// beta.1->beta.2) -- it repairs VALUES only (mod `customFileName`/`logicalFileName`/`modName`
// attributes and a download's `modInfo.name`, all polluted with CDN storage-path prefixes by a
// beta.1 regression, LAZ-807), never the shape of `mods`/`rules`/`profiles`/`downloads`. Everything
// else that shipped in 2.4.0 (collection install-session tracking, plugin load-order/`transactions`
// state, a LevelDB invalid-UTF8-key self-heal, a Nexus GraphQL query filter, a `deterministicReferenceTag`
// scheme for collection.json's OWN `reference.tag` at install time) touches state this project never
// reads (`loadOrder`, `persistent.transactions`) or fields scoped to collection-authoring/install-time
// matching, not the persisted per-mod `rules` array this project reads/writes. No code change made
// here beyond this allowlist bump. Re-confirm live against a real 2.4.0 state.v2 next time any of
// Create Backup / Apply Ignores preview+apply / Rules Generator actually run, same as 2.3.0 was.
// 2.5.0 added 2026-08-14 -- live-exercised the same way 2.3.0 was (Create Backup, Apply Ignores
// preview+apply, Apply Disables run against real state.v2), no schema surprises.
const TESTED_VORTEX_VERSIONS = ['2.3.0-beta.1', '2.3.0', '2.4.0-beta.1', '2.4.0-beta.2', '2.4.0', '2.5.0'];

// Translates between this module's legacy "stagingDir" field name (used throughout sync-cli.js)
// and the unified config's "staging" field -- everything else passes through as-is.
function loadConfig() {
  const cfg = appConfig.loadConfig();
  return { ...cfg, stagingDir: cfg.staging };
}

function saveConfig(config) {
  const { stagingDir, ...rest } = config;
  const patch = { ...rest };
  if (stagingDir !== undefined) patch.staging = stagingDir;
  appConfig.saveConfig(patch);
}

// A "vortex_collection_<id>" folder's collection.json alone was confirmed (2026-08-14, see
// scanStagingCollections' own comment below) to NOT mean "has real content" -- Rebuild Missing
// Files' own "Fetch from Nexus" writes a full, real-looking mods[] array straight from Nexus's own
// collection.json with zero actual files extracted. The one thing that's actually true only once
// SOME real extraction has happened (via Rebuild Missing Files' Extract action, or Rebuild
// Collection) is that at least one of the collection's own mods has a REAL, already-existing
// staging folder -- confirmed live against real collections (2026-08-14): every genuinely-installed
// mod's staging folder is named `<mod.source.logicalFilename>-<modId>-<version>-<timestamp>` (or
// exactly `logicalFilename` with no suffix in rarer cases), so a folder starting with
// `logicalFilename + '-'`, or exactly matching it, is real, on-disk, mergeable content -- not a
// guess. This deliberately does NOT require ALL (or even most) mods to have real folders: a
// collection sharing SOME mods with an already-installed collection (common for a director with
// many overlapping GTS/Skyrim collections -- confirmed live, one real Workshop collection had
// 17 of 20 mods already on disk purely from sharing) is genuinely useful/mergeable content, same
// as this app treats any other partial-completion state elsewhere.
function hasRealWorkshopContent(collectionData, allFolderNames) {
  for (const mod of collectionData.mods || []) {
    const logicalFilename = mod.source?.logicalFilename;
    if (!logicalFilename) continue;
    if (allFolderNames.some((f) => f === logicalFilename || f.startsWith(`${logicalFilename}-`))) {
      return true;
    }
  }
  return false;
}

// Scans a Vortex mod staging directory (e.g. "E:/Vortex Mods/skyrimse") for
// installed collections by looking for a collection.json directly inside
// each immediate subdirectory. This is a plain filesystem read — much
// cheaper than enumerating Vortex's state database — and the folder name is
// also the Vortex mod id for that collection (confirmed convention: Vortex
// names collection staging folders exactly after the mod id).
function scanStagingCollections(stagingDir) {
  let entries;
  try {
    entries = fs.readdirSync(stagingDir, { withFileTypes: true });
  } catch (err) {
    throw new Error(`Could not read staging directory "${stagingDir}": ${err.message}`);
  }
  const allFolderNames = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  const results = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // "vortex_collection_<id>" is Vortex's own internal folder-naming convention for a collection
    // tracked in its Workshop tab (a collection you're authoring/curating), NOT automatically a
    // real installed collection -- confirmed against a real install (2026-07-24): every one of the
    // user's 7 actually-installed collections gets an archive-derived folder name
    // (<Name>-<modId>-<version>-<timestamp>) once installed, while a Workshop-tab entry uses this
    // raw internal-id naming, whether or not a collection.json happens to be cached there yet
    // (Vortex writes one here while a Workshop collection is actively being edited/re-packaged,
    // independent of any real install). Bare exclusion was too broad though (confirmed live
    // 2026-08-14: a fetched-but-never-extracted Workshop collection has a full, real-looking
    // collection.json with zero actual files anywhere) -- a Workshop folder now needs BOTH a real
    // collection.json AND real on-disk content for at least one of its own mods
    // (hasRealWorkshopContent above) to count as a real collection here. See scanAllCollections in
    // state-query-worker.js for the Workshop-DROPDOWN side of this same underlying distinction
    // (that one intentionally shows Workshop drafts regardless of content -- a different UI with a
    // different purpose, not this function).
    const isWorkshopFolder = /^vortex_collection_/i.test(entry.name);
    const collectionJsonPath = path.join(stagingDir, entry.name, 'collection.json');
    if (!fs.existsSync(collectionJsonPath)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(collectionJsonPath, 'utf8'));
      if (isWorkshopFolder && !hasRealWorkshopContent(data, allFolderNames)) continue;
      results.push({
        modId: entry.name,
        folderPath: path.join(stagingDir, entry.name),
        collectionJsonPath,
        name: data.info?.name || entry.name,
        author: data.info?.author,
        modCount: data.mods?.length || 0,
        domainName: data.info?.domainName,
      });
    } catch {
      // not a valid collection.json — skip
    }
  }
  results.sort((a, b) => a.name.localeCompare(b.name));
  return results;
}

// Vortex's collection-update flow deletes the currently-installed revision's
// data (staging folder, and apparently the corresponding Vortex state entry)
// as soon as you let the update proceed — there is no window afterward where
// both the old ignored/disabled data and the new collection.json coexist.
// Confirmed by hands-on testing (2026-07-13): the fix is to snapshot
// everything needed for comparison *before* clicking "Update" in Vortex, to
// a durable file here, then compare against the new collection.json (which
// does become available if you choose "Later" at the install prompt instead
// of "Install") using that snapshot instead of live state.
// oldMods: a lean snapshot of the CURRENTLY-installed collection.json's mods[] list (see
// extractModsForSnapshot below), captured now so a later Compare can diff it against the NEW
// collection.json -- what the collection AUTHOR added/removed between revisions, independent of
// anything the user personally ignored/disabled. Optional (null when the collection.json couldn't
// be read at backup time) -- NOT part of BACKUP_SCHEMA_VERSION, so older backups without this field
// stay loadable; computeSync treats a missing value as "not captured", not "nothing changed".
function buildBackupSnapshot({ collectionModId, collectionName, profileId, profileName, stagingDir, ignored, disabled, oldMods }) {
  return {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    collectionModId,
    collectionName,
    profileId: profileId ?? null,
    profileName: profileName ?? null,
    stagingDir,
    ignored,
    disabled,
    oldMods: oldMods ?? null,
  };
}

// Extracts a lean per-mod snapshot (identity + display fields only, same shape modRow() in
// report.js already expects) from a collection.json's mods[] list -- used both for the NEW
// collection (already this shape) and to normalize the OLD collection.json's mods for storage in a
// backup snapshot above. Kept lean rather than storing the raw mods[] entries verbatim since a full
// collection.json can be large and every other field in a backup snapshot already limits itself to
// essentials.
function extractModsForSnapshot(collection) {
  return (collection.mods || []).map((m) => ({
    name: m.name,
    author: m.author,
    version: m.version,
    details: { category: m.details?.category },
    source: m.source,
  }));
}

// backupsDir has no hardcoded fallback -- confirmed live this was actively confusing (a real
// backup silently landed inside this project's own lib/vortex-sync/backups/ folder, nothing
// resembling a real Vortex location, with no indication of where it actually went). The caller
// (web UI's Settings-configured syncBackupRoot, or a CLI --sync-backup-root flag/interactive
// prompt) is always responsible for supplying a real, explicitly-chosen folder.
function saveBackup(snapshot, backupsDir) {
  if (!backupsDir) throw new Error('A backups folder must be configured before a backup can be saved.');
  fs.mkdirSync(backupsDir, { recursive: true });
  const stamp = snapshot.createdAt.replace(/[:.]/g, '-');
  const filePath = path.join(backupsDir, `${snapshot.collectionModId}-${stamp}.json`);
  fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2));
  return filePath;
}

function loadBackup(filePath) {
  const snapshot = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (snapshot.schemaVersion !== BACKUP_SCHEMA_VERSION) {
    throw new Error(`Unsupported or invalid backup file: "${filePath}"`);
  }
  return snapshot;
}

// Lists backups newest-first, for a picker. Skips any file that isn't a valid backup rather than
// failing the whole listing. No hardcoded fallback -- same reasoning as saveBackup above; callers
// with nothing configured yet should treat that as "nothing to list" themselves rather than ever
// reaching this function with an implicit/wrong location.
function listBackups(backupsDir) {
  if (!backupsDir) return [];
  let entries;
  try {
    entries = fs.readdirSync(backupsDir);
  } catch {
    return [];
  }
  const results = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    try {
      results.push({ filePath: path.join(backupsDir, entry), ...loadBackup(path.join(backupsDir, entry)) });
    } catch {
      // not a valid backup — skip
    }
  }
  results.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return results;
}

function isVortexRunning() {
  try {
    const out = execSync('tasklist', { encoding: 'utf8', windowsHide: true });
    return /vortex\.exe/i.test(out);
  } catch {
    return false; // best-effort; not fatal if we can't check
  }
}

// classic-level (Google LevelDB under the hood) has no true read-only open
// mode — opening always replays the write-ahead log (*.log) if one is
// present, which involves writing a fresh SST file via table_builder. If
// that *.log was copied mid-write (e.g. Vortex closing/reopening around the
// copy), the replay can hit a native assertion and hard-crash the process.
//
// Fix: never copy the *.log WAL at all. Everything durable already lives in
// the immutable *.ldb files plus MANIFEST/CURRENT, which LevelDB never
// modifies in place (only writes new ones and deletes old, so a plain file
// copy of them can't be torn mid-write the way an actively-appended WAL
// can). Without a *.log file present, opening the copy involves no replay
// and no writes at all — just reads. We lose at most the handful of very
// last writes that hadn't yet been flushed out of the WAL, which is fine for
// this tool's purposes (Vortex flushes regularly; and Vortex must be closed
// before we copy anyway).
// includeLog: only ever passed by withStateDbIncludingWal (see below) -- an explicit opt-in for
// the one caller that specifically wants the crash-risk tradeoff, never the default.
function copyStateDb(srcDir, destDir, { includeLog = false } = {}) {
  fs.mkdirSync(destDir, { recursive: true });
  const failed = [];
  const copied = [];
  for (const entry of fs.readdirSync(srcDir)) {
    if (entry === 'LOCK') continue; // never useful to copy -- just a mutex, no data
    if (entry.endsWith('.log') && !includeLog) continue; // skip WAL unless explicitly included
    const src = path.join(srcDir, entry);
    const dest = path.join(destDir, entry);
    let srcSizeBefore;
    try {
      srcSizeBefore = fs.statSync(src).size;
      fs.copyFileSync(src, dest);
    } catch {
      failed.push(entry);
      continue;
    }
    copied.push({ entry, src, dest, srcSizeBefore });
  }
  if (failed.length > 0) {
    throw new Error(
      `Could not copy ${failed.length} file(s) from Vortex's state database ` +
      `(locked): ${failed.join(', ')}.\n` +
      `Close Vortex completely and try again.`
    );
  }
  // Second line of defense: confirm nothing we copied changed size during or
  // after the copy (would indicate Vortex re-opened the DB mid-copy).
  for (const c of copied) {
    const srcSizeAfter = fs.statSync(c.src).size;
    const destSize = fs.statSync(c.dest).size;
    if (srcSizeAfter !== c.srcSizeBefore || destSize !== c.srcSizeBefore) {
      return false; // inconsistent copy — caller should retry
    }
  }
  return true;
}

async function withStateDbCopy(stateDir, fn, { includeLog = false } = {}) {
  if (isVortexRunning()) {
    throw new Error('Vortex is currently running. Close it completely and try again.');
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vortex-state-copy-'));
  try {
    let stable = false;
    for (let attempt = 1; attempt <= 3 && !stable; attempt++) {
      stable = copyStateDb(stateDir, tmpDir, { includeLog });
      if (isVortexRunning()) {
        throw new Error('Vortex was (re)launched while reading its state. Close it completely and try again.');
      }
    }
    if (!stable) {
      throw new Error(
        'Could not get a stable copy of Vortex\'s state database after several attempts ' +
        '(files kept changing). Make sure Vortex is fully closed and try again.'
      );
    }
    const db = new ClassicLevel(tmpDir, { valueEncoding: 'utf8' });
    try {
      return await fn(db);
    } finally {
      await db.close();
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// The one, safe, always-used-by-default read path -- every real caller in this project should keep
// calling this exactly as before. Never includes the WAL (see copyStateDb's own comment for why).
async function withStateDb(stateDir, fn) {
  return withStateDbCopy(stateDir, fn, { includeLog: false });
}

// Confirmed live 2026-07-27: the WAL-exclusion tradeoff above can silently miss real, recent writes
// (see TECHNICAL.md's "Confirmed live (2026-07-27)" write-up) -- a large batch of Vortex changes can
// still be sitting only in the *.log WAL when Vortex closes, since LevelDB only compacts every few
// MB of writes, not on every close. Replaying that WAL has a documented native-crash risk though, so
// this is NEVER used for a real read's actual displayed/saved data -- only as a SEPARATE, follow-up
// freshness check (see sync-runner.js's checkBackupFreshness), always run in its own isolated child
// process AFTER the real safe read already succeeded, so a crash here can only ever kill this bonus
// check, never the result the user actually gets.
async function withStateDbIncludingWal(stateDir, fn) {
  return withStateDbCopy(stateDir, fn, { includeLog: true });
}

// Editing collection.json on disk does NOT control what Vortex actually
// installs. Confirmed from Vortex's own source (bundledPlugins/collections
// makeInstall.ts): as soon as the collection package itself is downloaded,
// Vortex's installer reads collection.json from its own extraction path and
// immediately converts every mod into a rule, committed to
// persistent###mods###<gameId>###<modId>###rules — before "Resume" is ever
// clicked. Editing the staging-folder copy afterward edits a file nothing
// re-reads. The only way to actually make Vortex skip a mod is to set
// `ignored: true` on the matching rule in its live state directly — the same
// field its own "Ignore" button sets. Confirmed by hands-on testing
// (2026-07-13): file-edit approach silently had no effect on install.
const STATE_BACKUPS_DIR = path.join(__dirname, 'state-backups');

// Takes a full, exact copy of the live state.v2 directory (including the WAL
// this time — we're archiving it, not opening it, so there's no replay risk)
// so there is always a restore path before any write to live state. Refuses
// to proceed (throws) if the backup can't be completed in full.
function backupLiveState(stateDir) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(STATE_BACKUPS_DIR, `state.v2-${stamp}`);
  fs.mkdirSync(backupDir, { recursive: true });
  const failed = [];
  for (const entry of fs.readdirSync(stateDir)) {
    try {
      fs.copyFileSync(path.join(stateDir, entry), path.join(backupDir, entry));
    } catch {
      failed.push(entry);
    }
  }
  if (failed.length > 0) {
    throw new Error(
      `Could not back up ${failed.length} file(s) before writing to live state: ${failed.join(', ')}. ` +
      'Refusing to write without a complete backup. Make sure Vortex is fully closed and try again.'
    );
  }
  return backupDir;
}

// Lists this project's own state.v2 backups (newest first) for a restore
// UI/CLI to choose from.
function listStateBackups() {
  if (!fs.existsSync(STATE_BACKUPS_DIR)) return [];
  return fs.readdirSync(STATE_BACKUPS_DIR)
    .filter((name) => name.startsWith('state.v2-'))
    .map((name) => {
      const dir = path.join(STATE_BACKUPS_DIR, name);
      return { name, dir, createdAt: fs.statSync(dir).mtime.toISOString() };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// Deletes the OLDEST state.v2 backups once the count exceeds maxToKeep -- same "keep newest N,
// delete the rest" idea as collection-runner.js's own pruneOldBackups (Rebuild Collection's
// per-mod backups), just applied to this one flat folder instead of grouped per collection (every
// state-backup already lives in the same STATE_BACKUPS_DIR regardless of which collection or which
// write triggered it). null/undefined means unlimited -- never prunes, matches
// config.maxStateBackupsToKeep's own default. Called automatically right after every new backup
// (see withLiveStateDb below) so this never needs its own separate scheduled/manual trigger.
function pruneStateBackups(maxToKeep) {
  if (maxToKeep == null) return { deleted: [] };
  const backups = listStateBackups(); // newest-first already
  const excess = backups.slice(maxToKeep);
  for (const b of excess) fs.rmSync(b.dir, { recursive: true, force: true });
  return { deleted: excess.map((b) => b.name) };
}

// Restores a previously-taken state.v2 backup (see backupLiveState) back over
// the LIVE state.v2 directory -- the restore half of the safety net
// backupLiveState exists to provide. Confirmed via audit that no restore path
// existed at all before this, despite this project already documenting a
// real native LevelDB crash risk during writes -- "we take a backup" with no
// way to use it was a real gap, not a hypothetical one.
//
// Requires Vortex closed (same gate as any other live-state write), and
// itself takes a fresh backup of whatever is CURRENTLY live before touching
// it -- so a restore is itself undoable, and picking the wrong backup
// doesn't destroy the only copy of a still-good current state.
//
// The live directory's current contents are cleared (not overlaid) before
// copying the backup in: LevelDB's on-disk format (SST files, MANIFEST,
// CURRENT) needs to end up as ONE consistent, complete snapshot -- overlaying
// old backup files on top of a newer live directory risks mixing old and new
// SST files into something neither snapshot actually represents. Safe to
// clear first here specifically because the current live state was just
// backed up in full, immediately above.
//
// backupDir must be one of this function's own listStateBackups() results
// (a direct child of STATE_BACKUPS_DIR) -- refuses any other path.
function restoreLiveState(stateDir, backupDir) {
  if (isVortexRunning()) {
    throw new Error('Vortex is currently running. Close it completely before restoring its state.');
  }
  const resolvedBackup = path.resolve(backupDir);
  if (path.dirname(resolvedBackup) !== path.resolve(STATE_BACKUPS_DIR)) {
    throw new Error('Refusing to restore from a path outside this project\'s own state-backups folder.');
  }
  if (!fs.existsSync(resolvedBackup) || !fs.statSync(resolvedBackup).isDirectory()) {
    throw new Error(`Backup folder not found: ${resolvedBackup}`);
  }
  const preRestoreBackupDir = backupLiveState(stateDir);
  if (isVortexRunning()) {
    throw new Error('Vortex was (re)launched while backing up current state. Nothing was restored -- close it completely and try again.');
  }
  for (const entry of fs.readdirSync(stateDir)) {
    fs.rmSync(path.join(stateDir, entry), { recursive: true, force: true });
  }
  const failed = [];
  for (const entry of fs.readdirSync(resolvedBackup)) {
    try {
      fs.copyFileSync(path.join(resolvedBackup, entry), path.join(stateDir, entry));
    } catch {
      failed.push(entry);
    }
  }
  if (failed.length > 0) {
    throw new Error(
      `Restore incomplete -- could not copy ${failed.length} file(s): ${failed.join(', ')}. ` +
      `The live state directory was cleared before this attempt -- your previous state is safely at ` +
      `${preRestoreBackupDir} if you need to restore that back instead.`
    );
  }
  return { restoredFrom: resolvedBackup, preRestoreBackupDir };
}

async function getVortexAppVersion(db) {
  try {
    const raw = await db.get('app###appVersion');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'LEVEL_NOT_FOUND') return undefined;
    throw err;
  }
}

// Safe pre-flight check (via the read-only temp-copy path, no live open) for
// callers that want to warn about an untested Vortex version *before*
// committing to a live write — e.g. showing it alongside a dry-run preview,
// ahead of the "proceed?" confirmation.
async function checkVortexVersionCompat(stateDir) {
  const version = await withStateDb(stateDir, (db) => getVortexAppVersion(db));
  return { version, tested: version !== undefined && TESTED_VORTEX_VERSIONS.includes(version) };
}

// Opens Vortex's LIVE state.v2 directly (not a copy) for a narrow, surgical
// write. Requires Vortex to be fully closed, and always backs up the entire
// live directory first via backupLiveState — if that backup fails, this
// throws before ever opening the DB for writing. Returns the detected Vortex
// version and whether it matches a version this tool's writes have actually
// been tested against (TESTED_VORTEX_VERSIONS) — callers should surface a
// warning (or, for the interactive menu, require confirmation) on mismatch,
// since Vortex occasionally changes its state layout between versions and a
// mismatch means this tool's assumptions about that layout are unverified.
async function withLiveStateDb(stateDir, fn) {
  if (isVortexRunning()) {
    throw new Error('Vortex is currently running. Close it completely before writing to its state.');
  }
  const backupDir = backupLiveState(stateDir);
  pruneStateBackups(appConfig.loadConfig().maxStateBackupsToKeep);
  // Re-check after the backup copy (a real, non-trivial directory copy, not
  // instantaneous) -- the check above only proves Vortex was closed at the
  // START of that copy. Nothing has been written to the live DB yet at this
  // point, so it's safe to just refuse here rather than open it.
  if (isVortexRunning()) {
    throw new Error('Vortex was (re)launched while backing up its state. Nothing was written -- close it completely and try again.');
  }
  const db = new ClassicLevel(stateDir, { valueEncoding: 'utf8' });
  try {
    const vortexVersion = await getVortexAppVersion(db);
    const versionTested = vortexVersion !== undefined && TESTED_VORTEX_VERSIONS.includes(vortexVersion);
    const result = await fn(db);
    return { ...result, backupDir, vortexVersion, versionTested };
  } finally {
    await db.close();
  }
}

// ---- Staleness -- confirmed real and NOT just a brief timing window (2026-08-16): a write via
// withLiveStateDb above is durable (WAL-safe) the moment it returns, but LevelDB does NOT flush the
// WAL into compacted SST files on close() -- it only compacts opportunistically (every few MB of
// writes) or when something else opens/replays the DB (Vortex itself, on its own next launch).
// withStateDb deliberately never reads the WAL (see copyStateDb's own header comment -- replaying a
// WAL that's mid-write is a documented native-crash risk), so a caller's own just-written data can
// stay invisible to its own very next withStateDb-based read for an UNBOUNDED time, not just a
// moment. A forced full-keyspace db.compactRange() was tried and rejected here (2026-08-16): it
// timed out against the director's real, ~4,500-mod Vortex database well past this project's own
// 30s worker limit -- too slow to run on every write.
//
// The real fix lives at each WRITE CALLER, not here: after writing through withLiveStateDb, mutate
// the SAME in-memory index the write already built (see rules-generator.js's applyRules, which
// updates modIndex's own entry.rules in place as it writes) and re-derive anything "fresh" needed
// from THAT patched in-memory copy, in the SAME process, rather than opening a second withStateDb
// read afterward. This has zero staleness risk by construction (no second DB read at all) and costs
// nothing extra (the index is already built and already in memory). Documented here as the pattern
// to follow for any other write path that needs an immediate "what does it look like now" answer.

// A rule's reference uses fileMD5/tag/repo.modId/repo.fileId — normalize to
// the flat {fileMD5, tag, modId, fileId} shape makeIdentityMatcher expects.
function ruleReferenceIdentity(rule) {
  return {
    fileMD5: rule.reference?.fileMD5,
    tag: rule.reference?.tag,
    modId: rule.reference?.repo?.modId,
    fileId: rule.reference?.repo?.fileId,
  };
}

// Minimum structural shape this tool depends on for a collection mod rule.
// If any rule in the array doesn't hold this shape, Vortex's schema has
// likely changed since this tool was built against it — safer to refuse the
// whole write than to read-modify-write a structure we no longer understand.
function validateRuleShape(rule) {
  return !!rule && typeof rule === 'object' &&
    typeof rule.type === 'string' &&
    rule.reference !== null && typeof rule.reference === 'object';
}

function assertRulesShapeKnown(rules, modId) {
  if (!Array.isArray(rules)) {
    throw new Error(`Rules for "${modId}" are not an array — Vortex's state layout may have changed. Refusing to write.`);
  }
  const bad = rules.findIndex((r) => !validateRuleShape(r));
  if (bad !== -1) {
    throw new Error(
      `Rule at index ${bad} for "${modId}" doesn't match the structure this tool expects — ` +
      'Vortex\'s state layout may have changed since this tool was built. Refusing to write.'
    );
  }
}

// Pure function: given a collection mod's current rules and a list of
// ignored refs (e.g. from a backup snapshot), returns the rules with
// ignored:true set on matches (skipping any already ignored) plus a list of
// what changed. Does not touch the database — used for both dry-run preview
// (via the safe read-only withStateDb copy) and the real write.
//
// unmatched: backup refs with NO matching rule at all in the CURRENT collection (regardless of that
// rule's own ignored status) -- the collection author removed that mod between the backed-up
// revision and this one. Tracked separately from "already ignored, nothing to change" (a match that
// already has ignored:true is still a match, just not a "change") -- confirmed live this distinction
// matters: a backup capturing 4 ignored mods where the author removed 1 should show "3 will be set
// to ignored, 1 removed by the update", not silently report only 3 with no explanation for the gap.
function applyIgnoresToRules(rules, ignoredRefs) {
  const matcher = makeIdentityMatcher(ignoredRefs);
  const changed = [];
  const matchedRefs = new Set();
  const candidateIdentities = [];
  const updatedRules = rules.map((rule) => {
    const identity = ruleReferenceIdentity(rule);
    candidateIdentities.push(identity);
    const match = matcher(identity);
    if (match) matchedRefs.add(match);
    if (rule.ignored === true || !match) return rule;
    changed.push({ name: rule.extra?.name || rule.reference?.description || '(unnamed)' });
    return { ...rule, ignored: true };
  });
  const unmatched = ignoredRefs.filter((r) => !matchedRefs.has(r));
  // candidateIdentities is every CURRENT rule's identity, freshly read from live state -- exactly
  // the population identityDriftWarning needs (see its own comment): a backup snapshot being sparse
  // is normal and expected, but every rule in the collection you're updating TO suddenly having no
  // readable identity at all is not.
  const identityWarning = identityDriftWarning(candidateIdentities, 'mods in the current collection');
  return { updatedRules, changed, unmatched, identityWarning };
}

// Writes ignored:true onto the matching rules for modId in the given (live)
// db. Only writes if something actually changed. Single key read, single key
// write — nothing else in the database is touched.
async function writeIgnoredFlags(db, modId, ignoredRefs) {
  const raw = await db.get(`persistent###mods###${GAME_ID}###${modId}###rules`);
  const rules = JSON.parse(raw);
  assertRulesShapeKnown(rules, modId);
  const { updatedRules, changed, unmatched, identityWarning } = applyIgnoresToRules(rules, ignoredRefs);
  if (changed.length > 0) {
    await db.put(`persistent###mods###${GAME_ID}###${modId}###rules`, JSON.stringify(updatedRules));
  }
  return { changed, unmatched, identityWarning };
}

// Reads the four identity-defining attributes for one mod id, in the shape
// makeIdentityMatcher/identityKeys expect. Returns undefined if there's no
// mod at all at this id (no fileMD5 attribute) -- shared by findCurrentModIds'
// fast path (single id) and its full-scan fallback (every installed id).
async function readModIdentity(db, modId) {
  const fileMD5 = await getModValue(db, modId, 'attributes###fileMD5');
  if (fileMD5 === undefined) return undefined;
  const tag = await getModValue(db, modId, 'attributes###referenceTag');
  const modIdAttr = await getModValue(db, modId, 'attributes###modId');
  const fileIdAttr = await getModValue(db, modId, 'attributes###fileId');
  return {
    fileMD5: JSON.parse(fileMD5),
    tag: tag !== undefined ? JSON.parse(tag) : undefined,
    modId: modIdAttr !== undefined ? JSON.parse(modIdAttr) : undefined,
    fileId: fileIdAttr !== undefined ? JSON.parse(fileIdAttr) : undefined,
  };
}

// Finds the *current* installed mod ids matching each item in `refs` (e.g.
// a backup's disabled[] list, shaped {fileMD5, tag, modId, fileId,
// vortexModId, name}). Used AFTER a collection update actually installs
// previously-disabled dependent mods under fresh mod ids — unlike the
// collection's own rules (which exist before Resume and can be pre-empted),
// a dependent mod's id doesn't exist until Vortex actually installs it, so
// this can only run post-install.
//
// Fast path: try each item's original vortexModId directly (Vortex's id
// generation appears to often reproduce the same id for the exact same
// file/version) -- but ONLY accepted once the candidate at that id is
// confirmed to actually be the same mod (fileMD5/tag/modId+fileId identity
// match against `ref`), not just "some mod happens to still be at that id".
// A prior version of this fast path accepted the id on nothing more than
// "a fileMD5 attribute exists there at all" -- if Vortex ever reassigns an
// old numeric id to a genuinely different mod after an update, that would
// have silently disabled the WRONG mod and reported success under the old
// mod's name. Falls back to the full scan below (matching by fileMD5/tag/
// modId+fileId across every currently-installed mod) for anything the fast
// path can't confirm.
// Core scan shared by findCurrentModIds (unchanged public contract -- bare results array, used by
// Rebuild Collection's state-query-worker.js and sync-cli.js's own direct calls) and
// findCurrentModIdsChecked (adds the identity-drift check below, used only by the two Update
// Collection apply-disables call sites that actually act on the result of a fresh live-state scan).
// candidateIdentities collects one entry per id actually scanned in the full-scan fallback below
// (an empty {} when readModIdentity found nothing there) -- NOT one entry per input ref, since a ref
// simply not being installed yet (Resume still running) is normal and expected, unlike every
// installed mod suddenly reading as unidentifiable.
async function findCurrentModIdsCore(db, refs) {
  const results = [];
  const remaining = [];
  for (const ref of refs) {
    if (ref.vortexModId) {
      const identity = await readModIdentity(db, ref.vortexModId);
      if (identity && makeIdentityMatcher([ref])(identity)) {
        results.push({ vortexModId: ref.vortexModId, matchedRef: ref });
        continue;
      }
    }
    remaining.push(ref);
  }
  if (remaining.length === 0) return { results, candidateIdentities: [] };

  const modPrefix = `persistent###mods###${GAME_ID}###`;
  const ids = new Set();
  for await (const key of db.keys({ gte: modPrefix, lt: modPrefix + '￿' })) {
    const rest = key.slice(modPrefix.length);
    const sep = rest.indexOf('###');
    if (sep !== -1) ids.add(rest.slice(0, sep));
  }
  const alreadyFound = new Set(results.map((r) => r.vortexModId));
  const matcher = makeIdentityMatcher(remaining);
  const candidateIdentities = [];
  for (const id of ids) {
    if (alreadyFound.has(id)) continue;
    const identity = await readModIdentity(db, id);
    // Every id here comes from a real `persistent###mods###...` key, so it's a confirmed real mod
    // entry, not a stray/missing one -- readModIdentity returning nothing here (no fileMD5 attribute
    // at all) is itself a candidate for the drift check, not skipped from it the way it's skipped
    // from matching (below).
    candidateIdentities.push(identity || {});
    if (!identity) continue;
    const match = matcher(identity);
    if (match) results.push({ vortexModId: id, matchedRef: match });
  }
  return { results, candidateIdentities };
}

async function findCurrentModIds(db, refs) {
  return (await findCurrentModIdsCore(db, refs)).results;
}

async function findCurrentModIdsChecked(db, refs) {
  const { results, candidateIdentities } = await findCurrentModIdsCore(db, refs);
  const identityWarning = identityDriftWarning(candidateIdentities, 'currently-installed mods');
  return { results, identityWarning };
}

// Sets enabled:false in profile modState for each matched mod, skipping any
// already disabled. modState values are plain "true"/"false" strings (not
// JSON-quoted like most other fields in this database).
async function writeDisabledFlags(db, profileId, matches) {
  const changed = [];
  for (const { vortexModId, matchedRef } of matches) {
    const key = `persistent###profiles###${profileId}###modState###${vortexModId}###enabled`;
    const current = await db.get(key).catch((err) => {
      if (err.code === 'LEVEL_NOT_FOUND') return undefined;
      throw err;
    });
    if (current !== undefined && current !== 'true' && current !== 'false') {
      throw new Error(
        `modState value for "${vortexModId}" is "${current}", not "true"/"false" as expected — ` +
        'Vortex\'s state layout may have changed since this tool was built. Refusing to write.'
      );
    }
    if (current === 'false') continue;
    await db.put(key, 'false');
    changed.push({ vortexModId, name: matchedRef.name });
  }
  return changed;
}

async function getModValue(db, modId, field) {
  try {
    return await db.get(`persistent###mods###${GAME_ID}###${modId}###${field}`);
  } catch (err) {
    if (err.code === 'LEVEL_NOT_FOUND') return undefined;
    throw err;
  }
}

async function getRules(db, modId) {
  const raw = await getModValue(db, modId, 'rules');
  if (raw === undefined) {
    throw new Error(
      `No mod with id "${modId}" found under game "${GAME_ID}" in Vortex's state. ` +
      'This usually means Vortex hasn\'t written this mod to its state database yet. Try either: ' +
      '(1) in Vortex, go to the Collections page and click "Refresh" on the collection, or ' +
      '(2) reopen Vortex, wait a moment, close it again — then select your option again.'
    );
  }
  return JSON.parse(raw);
}

function ruleToRef(r) {
  return {
    name: r.extra?.name || r.reference?.description || '(unnamed)',
    fileMD5: r.reference?.fileMD5,
    tag: r.reference?.tag,
    modId: r.reference?.repo?.modId,
    fileId: r.reference?.repo?.fileId,
    author: r.extra?.author,
    category: r.extra?.category,
    version: r.extra?.version,
  };
}

// Every mod that belongs to a collection (every rule on its Vortex mod
// entry), regardless of ignored status. Used to scope "is this mod part of
// THIS collection" checks — a Vortex profile can contain mods from several
// collections (or added manually), so membership must never be assumed.
function extractAllMembers(rules) {
  return rules.map(ruleToRef);
}

function extractIgnored(rules) {
  return rules.filter((r) => r.ignored === true).map(ruleToRef);
}

// Matches identity across the two shapes used in this codebase:
//  - collection.json's mods[].source: { md5, tag, modId, fileId }
//  - everything else (rule refs, disabled-mod attributes): { fileMD5, tag, modId, fileId }
// Priority: fileMD5 (most reliable) > tag > modId+fileId.
function identityKeys(x) {
  if (!x) return [];
  const keys = [];
  const md5 = x.md5 || x.fileMD5;
  if (md5) keys.push(`md5:${md5}`);
  if (x.tag) keys.push(`tag:${x.tag}`);
  if (x.modId && x.fileId) keys.push(`id:${x.modId}:${x.fileId}`);
  return keys;
}

// True when a ref/candidate has literally zero usable identity fields (no fileMD5, tag, or
// modId+fileId pair). On its own this is ambiguous -- it could just mean this one mod genuinely
// lacks that data (happens for a small minority of real mods, e.g. some very old off-site entries)
// -- see identityDriftWarning below, which looks for this becoming true across almost everything at
// once, the actual signature of a schema change rather than one mod's data being incomplete.
function hasNoIdentity(x) {
  return identityKeys(x).length === 0;
}

// The write paths in this file (writeIgnoredFlags, writeDisabledFlags) already refuse outright if
// the OUTER shape of what they write looks unfamiliar (assertRulesShapeKnown, and an inline
// true/false check respectively) -- so a schema change there can't silently corrupt anything. The
// gap this closes is narrower and easier to miss: the INNER identity fields this file reads to
// figure out *which* mod a rule/ref refers to (reference.fileMD5, reference.repo.modId,
// attributes###fileMD5, etc.) are read with no validation at all. If Vortex ever renamed one of
// those fields, every read of it would just silently come back undefined, identityKeys() would
// return zero keys for every candidate, and matching would silently degrade to "matches nothing" --
// which today gets reported as "removed by the collection author" / "not found installed", a
// plausible-sounding but WRONG explanation for what's actually a tool/Vortex incompatibility.
// Threshold: >=80% with at least 3 candidates -- high enough to tolerate a handful of genuinely
// bare-identity mods without false-triggering on an ordinary collection, low enough to catch "every
// single one of these now reads as unidentifiable" long before it's mistaken for real removal.
// candidates should always be freshly read from Vortex's LIVE state (current rules/installed mods),
// never from a backup -- a historical snapshot being sparse says nothing about today's schema.
function identityDriftWarning(candidates, itemLabel) {
  if (candidates.length < 3) return null;
  const bare = candidates.filter(hasNoIdentity).length;
  if (bare / candidates.length < 0.8) return null;
  return `${bare} of ${candidates.length} ${itemLabel} had no readable identity data (no file hash, ` +
    'tag, or mod/file id). This looks like Vortex may have changed how it stores this data, not that ' +
    'those mods were genuinely removed -- do not trust the "removed"/"not found" results above until ' +
    'this is investigated. Check whether a newer version of this tool is available, and verify manually ' +
    'in Vortex before relying on this step\'s result.';
}

// Builds a lookup from a list of refs (any of the shapes above) to itself,
// then returns a matcher that finds the matching ref for a given candidate,
// or null. Priority order is enforced by checking keys in identityKeys()'s
// order for the *candidate*, so an md5 match always wins over a looser tag
// match even if both exist.
function makeIdentityMatcher(refs) {
  const byKey = new Map();
  for (const ref of refs) {
    for (const key of identityKeys(ref)) {
      if (!byKey.has(key)) byKey.set(key, ref);
    }
  }
  return (candidate) => {
    for (const key of identityKeys(candidate)) {
      if (byKey.has(key)) return byKey.get(key);
    }
    return null;
  };
}

// Filters a list of items (must expose fileMD5/tag/modId+fileId, e.g. from
// getDisabledInstalledMods) down to only those that are members of the given
// collection's rules.
//
// Confirmed live (2026-07-28): a Nexus mod can end up installed TWICE under two different
// fileIds that happen to produce the identical file hash (e.g. the author re-uploaded the same
// archive under a new file id, and Vortex installed the new copy as a separate mod entry rather
// than replacing the old one in place). When that happens, the OLD, no-longer-referenced copy can
// still be sitting on disk, disabled -- and matching on fileMD5 alone (makeIdentityMatcher's
// normal, correct-for-most-cases priority) wrongly credits it as "this collection's own disabled
// dependency", because it shares content with the member the collection's rule actually points at.
// The rule's own reference is pinned to a SPECIFIC modId+fileId, not merely "any install with this
// content" -- so once a candidate and its matched member both carry a modId+fileId, require them
// to actually agree. A bare content-hash coincidence is not enough by itself to claim a disabled
// install belongs to this collection. (This stricter check is intentionally NOT folded into
// makeIdentityMatcher itself -- other call sites, e.g. findCurrentModIdsCore's post-update mod-id
// lookup, rely on the looser md5-only match to recognize the SAME rule's dependency after its
// fileId legitimately changes between backup time and now, where there's only one candidate and
// requiring fileId agreement would wrongly report it as not installed.)
function filterToCollectionMembers(items, rules) {
  const matcher = makeIdentityMatcher(extractAllMembers(rules));
  return items.filter((item) => {
    const match = matcher(item);
    if (!match) return false;
    if (item.modId && item.fileId && match.modId && match.fileId) {
      return String(item.modId) === String(match.modId) && String(item.fileId) === String(match.fileId);
    }
    return true;
  });
}

// Lists every Vortex profile, with enough info to pick the one that goes
// with a given collection (Vortex names the profile after the collection by
// default when you install one).
// Vortex's state.v2 is shared across EVERY game it manages, not just this one -- confirmed live
// (2026-07-25): a real install had a third profile ("Default", 50 keys vs. thousands for the real
// Skyrim SE profiles) whose gameId was "dragonsdogma2", a genuinely different, unrelated game, not
// a ghost/corrupted entry. Filtered to gameId === GAME_ID here (not left to callers) so nothing in
// this Skyrim-SE-only project ever has to remember to filter this itself.
async function listProfiles(db) {
  const prefix = 'persistent###profiles###';
  const ids = new Set();
  for await (const key of db.keys({ gte: prefix, lt: prefix + '￿' })) {
    const rest = key.slice(prefix.length);
    const sep = rest.indexOf('###');
    if (sep === -1) continue;
    ids.add(rest.slice(0, sep));
  }
  const results = [];
  for (const id of ids) {
    const gameIdRaw = await db.get(`persistent###profiles###${id}###gameId`).catch(() => undefined);
    const gameId = gameIdRaw ? JSON.parse(gameIdRaw) : undefined;
    if (gameId !== GAME_ID) continue;
    const name = await db.get(`persistent###profiles###${id}###name`).catch(() => undefined);
    results.push({
      profileId: id,
      gameId,
      name: name ? JSON.parse(name) : id,
    });
  }
  return results;
}

// The profile Vortex was last actually using for this game -- confirmed live against a real
// state.v2 (2026-07-25): `settings###profiles###lastActiveProfile###<gameId>` is real, present,
// and per-game (unlike `settings###profiles###activeProfileId`, which is global across every game
// Vortex manages -- not useful here if some OTHER game happened to be the last one open). Used to
// default-select the right profile in the UI instead of leaving it to guesswork/manual choice,
// since writing to the wrong profile's modState would disable/enable the wrong mods entirely.
async function getLastActiveProfileId(db, gameId = GAME_ID) {
  try {
    const raw = await db.get(`settings###profiles###lastActiveProfile###${gameId}`);
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'LEVEL_NOT_FOUND') return undefined;
    throw err;
  }
}

// Every modKey enabled in the given profile -- Cycle Helper's own scoping for cycle detection
// (lib/cycle-detector.js), matching Vortex's real sortMods exactly: mod_management/index.ts's
// doSortMods scopes to `getSafe(profile.modState, [mod.id, 'enabled'], false)`, the SAME
// `persistent###profiles###<id>###modState###<modKey>###enabled` key getDisabledInstalledMods
// already reads below (confirmed 2026-08-16). A cycle involving a currently-disabled mod isn't a
// cycle Vortex would actually hit on its next real sort, so scanning anything wider would produce
// false positives. No "still actually installed" filter here (unlike getDisabledInstalledMods) --
// an enabled-but-uninstalled modState entry is already an edge case Vortex's own sort would hit the
// same way, not something to special-case around.
async function getEnabledModKeys(db, profileId) {
  const prefix = `persistent###profiles###${profileId}###modState###`;
  const enabled = [];
  for await (const [key, val] of db.iterator({ gte: prefix, lt: prefix + '￿' })) {
    if (!key.endsWith('###enabled')) continue;
    let parsed;
    try { parsed = JSON.parse(val); } catch { parsed = false; }
    if (parsed === true) enabled.push(key.slice(prefix.length, -'###enabled'.length));
  }
  return enabled;
}

// Returns every mod that is (a) disabled in the given profile and (b) still
// actually installed (modState can retain stale entries for mods that were
// later uninstalled — those are not useful to report on).
async function getDisabledInstalledMods(db, profileId) {
  const modPrefix = `persistent###mods###${GAME_ID}###`;
  const installedIds = new Set();
  for await (const key of db.keys({ gte: modPrefix, lt: modPrefix + '￿' })) {
    const rest = key.slice(modPrefix.length);
    const sep = rest.indexOf('###');
    if (sep !== -1) installedIds.add(rest.slice(0, sep));
  }

  const statePrefix = `persistent###profiles###${profileId}###modState###`;
  const disabledIds = [];
  for await (const [key, val] of db.iterator({ gte: statePrefix, lt: statePrefix + '￿' })) {
    if (key.endsWith('###enabled') && val === 'false') {
      disabledIds.push(key.slice(statePrefix.length, -'###enabled'.length));
    }
  }

  const results = [];
  for (const id of disabledIds) {
    if (!installedIds.has(id)) continue; // stale modState entry, mod no longer installed
    const attrPrefix = `persistent###mods###${GAME_ID}###${id}###attributes###`;
    const attrs = {};
    for await (const [key, val] of db.iterator({ gte: attrPrefix, lt: attrPrefix + '￿' })) {
      try {
        attrs[key.slice(attrPrefix.length)] = JSON.parse(val);
      } catch {
        attrs[key.slice(attrPrefix.length)] = val;
      }
    }
    results.push({
      vortexModId: id,
      name: attrs.customFileName || attrs.modName || id,
      fileMD5: attrs.fileMD5,
      tag: attrs.referenceTag,
      modId: attrs.modId,
      fileId: attrs.fileId,
      author: attrs.author,
      category: attrs.category,
      version: attrs.version,
    });
  }
  return results;
}

// Recursively finds .esp/.esl/.esm files under a directory (a mod's staging
// folder). Used to find which plugin(s) a currently-installed mod provides —
// this only works for mods that are actually staged on disk (i.e. not for
// ignored mods, which were never installed and leave nothing to inspect).
function findPluginFiles(dir) {
  let results = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results = results.concat(findPluginFiles(full));
    } else if (/\.(esp|esl|esm)$/i.test(entry.name)) {
      results.push(entry.name);
    }
  }
  return results;
}

// Augments a list of mods (must expose vortexModId, e.g. from
// getDisabledInstalledMods) with the plugin files found in their staging
// folder under stagingDir.
function attachPluginFiles(items, stagingDir) {
  return items.map((item) => ({
    ...item,
    pluginFiles: item.vortexModId ? findPluginFiles(path.join(stagingDir, item.vortexModId)) : [],
  }));
}

// Compares a collection.json against the set of mods ignored in the
// currently-installed revision, without writing anything. `disabledMods`
// should already be scoped to this collection (see filterToCollectionMembers)
// — this function does not re-scope them. If entries carry `pluginFiles`
// (see attachPluginFiles), the matching plugins[] entries are set to
// enabled:false in the returned `plugins` array.
//
// Note on collection.json's `plugins[]`: it has no field linking a plugin
// back to the mod that provides it, and mods that were never installed
// (ignored mods) leave no staged files to inspect — so there is no reliable
// way to strip an ignored mod's plugin entries here. They are left as-is;
// Vortex/the game should simply treat them as missing files since they were
// never deployed, same as any other plugins.txt entry with no backing file.
function computeSync(collection, ignored, disabledMods = [], oldMods = null) {
  const matchesIgnored = makeIdentityMatcher(ignored);

  const removedMods = [];
  const keptMods = [];
  const matchedIgnoredRefs = new Set();
  for (const mod of collection.mods || []) {
    const matchedRef = matchesIgnored(mod.source);
    if (matchedRef) {
      removedMods.push(mod);
      matchedIgnoredRefs.add(matchedRef);
    } else {
      keptMods.push(mod);
    }
  }

  const removedMd5s = new Set(removedMods.filter((m) => m.source?.md5).map((m) => m.source.md5));

  const removedModRules = [];
  const keptModRules = [];
  for (const rule of collection.modRules || []) {
    const refMatch = rule.reference?.fileMD5 && removedMd5s.has(rule.reference.fileMD5);
    const srcMatch = rule.source?.fileMD5 && removedMd5s.has(rule.source.fileMD5);
    if (refMatch || srcMatch) {
      removedModRules.push(rule);
    } else {
      keptModRules.push(rule);
    }
  }

  const unmatched = ignored.filter((m) => !matchedIgnoredRefs.has(m));

  // Mods that are disabled in Vortex right now and are staying in the output
  // (i.e. not already removed as ignored) — since Vortex doesn't carry
  // disabled state forward across a collection revision any more than it
  // does the ignored flag, their known plugin files (if any) are switched to
  // enabled:false directly in the output so no manual step is needed.
  const matchesDisabled = makeIdentityMatcher(disabledMods);
  const disabledKept = [];
  const disabledMatches = [];
  for (const mod of keptMods) {
    const ref = matchesDisabled(mod.source);
    if (ref) {
      disabledKept.push(mod);
      disabledMatches.push({ mod, disabledRef: ref });
    }
  }

  const plugins = (collection.plugins || []).map((p) => ({ ...p }));
  const pluginByLowerName = new Map(plugins.map((p) => [p.name.toLowerCase(), p]));
  const pluginsDisabled = [];
  const modsWithHandledPlugin = new Set();
  for (const { mod, disabledRef } of disabledMatches) {
    for (const fileName of disabledRef.pluginFiles || []) {
      const entry = pluginByLowerName.get(fileName.toLowerCase());
      if (entry) {
        modsWithHandledPlugin.add(mod);
        if (entry.enabled !== false) {
          entry.enabled = false;
          pluginsDisabled.push({ name: entry.name, forMod: mod.name });
        }
      }
    }
  }
  // Disabled-and-kept mods with no plugin we could toggle (no .esp/.esl at
  // all, or its files don't match a known plugins[] entry) — collection.json
  // has no per-mod enabled/disabled field (confirmed against Vortex's own
  // source: ICollectionMod has no such field), so these can only ever be
  // fixed by disabling them in Vortex by hand after the update installs them.
  const disabledNeedsManual = disabledKept.filter((mod) => !modsWithHandledPlugin.has(mod));

  // What the collection AUTHOR changed between the OLD (backed-up) and NEW collection.json, entirely
  // independent of anything the user personally ignored/disabled -- e.g. a mod the author dropped
  // that the user had NOT ignored is otherwise invisible to every check above (those only ever look
  // at the user's own ignored/disabled lists, never the old collection's full mod list). null when
  // oldMods wasn't captured (a backup taken before this comparison existed) -- callers must treat
  // that as "not available", not "nothing changed".
  let authorRemoved = null;
  let authorAdded = null;
  if (oldMods) {
    const newMods = collection.mods || [];
    const matchesOld = makeIdentityMatcher(oldMods.map((m) => m.source));
    const matchedOldSources = new Set();
    for (const mod of newMods) {
      const matched = matchesOld(mod.source);
      if (matched) matchedOldSources.add(matched);
    }
    authorRemoved = oldMods.filter((m) => !matchedOldSources.has(m.source));

    const matchesNew = makeIdentityMatcher(newMods.map((m) => m.source));
    const matchedNewSources = new Set();
    for (const old of oldMods) {
      const matched = matchesNew(old.source);
      if (matched) matchedNewSources.add(matched);
    }
    authorAdded = newMods.filter((m) => !matchedNewSources.has(m.source));
  }

  return {
    removedMods, keptMods, removedModRules, keptModRules, unmatched,
    disabledKept, disabledNeedsManual, plugins, pluginsDisabled,
    authorRemoved, authorAdded,
  };
}

function writePatchedCollection(collection, syncResult, outPath) {
  const patched = {
    ...collection,
    mods: syncResult.keptMods,
    modRules: syncResult.keptModRules,
    plugins: syncResult.plugins,
  };
  fs.writeFileSync(outPath, JSON.stringify(patched, null, 2));
}

module.exports = {
  DEFAULT_STATE_DIR,
  GAME_ID,
  CONFIG_PATH,
  STATE_BACKUPS_DIR,
  TESTED_VORTEX_VERSIONS,
  loadConfig,
  saveConfig,
  scanStagingCollections,
  buildBackupSnapshot,
  extractModsForSnapshot,
  saveBackup,
  loadBackup,
  listBackups,
  isVortexRunning,
  getVortexAppVersion,
  checkVortexVersionCompat,
  withStateDb,
  withStateDbIncludingWal,
  withLiveStateDb,
  listStateBackups,
  pruneStateBackups,
  restoreLiveState,
  validateRuleShape,
  assertRulesShapeKnown,
  applyIgnoresToRules,
  writeIgnoredFlags,
  findCurrentModIds,
  findCurrentModIdsChecked,
  writeDisabledFlags,
  getRules,
  getModValue,
  extractIgnored,
  makeIdentityMatcher,
  ruleReferenceIdentity,
  extractAllMembers,
  filterToCollectionMembers,
  listProfiles,
  getLastActiveProfileId,
  getEnabledModKeys,
  getDisabledInstalledMods,
  attachPluginFiles,
  computeSync,
  writePatchedCollection,
};
