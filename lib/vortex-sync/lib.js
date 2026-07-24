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
const BACKUPS_DIR = path.join(__dirname, 'backups');
const BACKUP_SCHEMA_VERSION = 1;

// Vortex versions this tool's live-state writes (apply-ignores, apply-disables)
// have actually been tested against. Vortex occasionally changes its state
// layout between versions — this doesn't guarantee compatibility, but a
// mismatch is a clear signal to double-check before trusting an automated
// write, rather than silently assuming the schema this tool was built
// against still holds.
const TESTED_VORTEX_VERSIONS = ['2.3.0-beta.1'];

// Translates between this module's legacy "stagingDir" field name (used throughout sync-cli.js/
// sync-menu.js) and the unified config's "staging" field -- everything else passes through as-is.
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
  const results = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // "vortex_collection_<id>" is Vortex's own internal folder-naming convention for a collection
    // tracked in its Workshop tab (a collection you're authoring/curating), NOT a real installed
    // collection -- confirmed against a real install (2026-07-24): every one of the user's 7
    // actually-installed collections gets an archive-derived folder name
    // (<Name>-<modId>-<version>-<timestamp>) once installed, while all 29 of their Workshop-tab
    // entries use this raw internal-id naming, whether or not a collection.json happens to be
    // cached there yet (Vortex writes one here while a Workshop collection is actively being
    // edited/re-packaged, independent of any real install). Excluded here so Workshop drafts never
    // show up in the "real collection to rebuild" picker -- see scanAllCollections in
    // state-query-worker.js for the Workshop-dropdown side of this same distinction.
    if (/^vortex_collection_/i.test(entry.name)) continue;
    const collectionJsonPath = path.join(stagingDir, entry.name, 'collection.json');
    if (!fs.existsSync(collectionJsonPath)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(collectionJsonPath, 'utf8'));
      results.push({
        modId: entry.name,
        folderPath: path.join(stagingDir, entry.name),
        collectionJsonPath,
        name: data.info?.name || entry.name,
        author: data.info?.author,
        modCount: data.mods?.length || 0,
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
function buildBackupSnapshot({ collectionModId, collectionName, profileId, profileName, stagingDir, ignored, disabled }) {
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
  };
}

function saveBackup(snapshot, backupsDir = BACKUPS_DIR) {
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

// Lists backups newest-first, for a picker. Skips any file that isn't a
// valid backup rather than failing the whole listing.
function listBackups(backupsDir = BACKUPS_DIR) {
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
    const out = execSync('tasklist', { encoding: 'utf8' });
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
function copyStateDb(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const failed = [];
  const copied = [];
  for (const entry of fs.readdirSync(srcDir)) {
    if (entry.endsWith('.log') || entry === 'LOCK') continue; // skip WAL + lockfile
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

async function withStateDb(stateDir, fn) {
  if (isVortexRunning()) {
    throw new Error('Vortex is currently running. Close it completely and try again.');
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vortex-state-copy-'));
  try {
    let stable = false;
    for (let attempt = 1; attempt <= 3 && !stable; attempt++) {
      stable = copyStateDb(stateDir, tmpDir);
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
function applyIgnoresToRules(rules, ignoredRefs) {
  const matcher = makeIdentityMatcher(ignoredRefs);
  const changed = [];
  const updatedRules = rules.map((rule) => {
    if (rule.ignored === true) return rule;
    const match = matcher(ruleReferenceIdentity(rule));
    if (!match) return rule;
    changed.push({ name: rule.extra?.name || rule.reference?.description || '(unnamed)' });
    return { ...rule, ignored: true };
  });
  return { updatedRules, changed };
}

// Writes ignored:true onto the matching rules for modId in the given (live)
// db. Only writes if something actually changed. Single key read, single key
// write — nothing else in the database is touched.
async function writeIgnoredFlags(db, modId, ignoredRefs) {
  const raw = await db.get(`persistent###mods###${GAME_ID}###${modId}###rules`);
  const rules = JSON.parse(raw);
  assertRulesShapeKnown(rules, modId);
  const { updatedRules, changed } = applyIgnoresToRules(rules, ignoredRefs);
  if (changed.length > 0) {
    await db.put(`persistent###mods###${GAME_ID}###${modId}###rules`, JSON.stringify(updatedRules));
  }
  return changed;
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
// file/version). Falls back to a full scan matching by fileMD5/tag/modId+
// fileId for anything not found directly.
async function findCurrentModIds(db, refs) {
  const results = [];
  const remaining = [];
  for (const ref of refs) {
    if (ref.vortexModId) {
      const fileMD5 = await getModValue(db, ref.vortexModId, 'attributes###fileMD5');
      if (fileMD5 !== undefined) {
        results.push({ vortexModId: ref.vortexModId, matchedRef: ref });
        continue;
      }
    }
    remaining.push(ref);
  }
  if (remaining.length === 0) return results;

  const modPrefix = `persistent###mods###${GAME_ID}###`;
  const ids = new Set();
  for await (const key of db.keys({ gte: modPrefix, lt: modPrefix + '￿' })) {
    const rest = key.slice(modPrefix.length);
    const sep = rest.indexOf('###');
    if (sep !== -1) ids.add(rest.slice(0, sep));
  }
  const alreadyFound = new Set(results.map((r) => r.vortexModId));
  const matcher = makeIdentityMatcher(remaining);
  for (const id of ids) {
    if (alreadyFound.has(id)) continue;
    const fileMD5 = await getModValue(db, id, 'attributes###fileMD5');
    const tag = await getModValue(db, id, 'attributes###referenceTag');
    const modIdAttr = await getModValue(db, id, 'attributes###modId');
    const fileIdAttr = await getModValue(db, id, 'attributes###fileId');
    const identity = {
      fileMD5: fileMD5 !== undefined ? JSON.parse(fileMD5) : undefined,
      tag: tag !== undefined ? JSON.parse(tag) : undefined,
      modId: modIdAttr !== undefined ? JSON.parse(modIdAttr) : undefined,
      fileId: fileIdAttr !== undefined ? JSON.parse(fileIdAttr) : undefined,
    };
    const match = matcher(identity);
    if (match) results.push({ vortexModId: id, matchedRef: match });
  }
  return results;
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
function filterToCollectionMembers(items, rules) {
  const matcher = makeIdentityMatcher(extractAllMembers(rules));
  return items.filter((item) => matcher(item) !== null);
}

// Lists every Vortex profile, with enough info to pick the one that goes
// with a given collection (Vortex names the profile after the collection by
// default when you install one).
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
    const gameId = await db.get(`persistent###profiles###${id}###gameId`).catch(() => undefined);
    const name = await db.get(`persistent###profiles###${id}###name`).catch(() => undefined);
    results.push({
      profileId: id,
      gameId: gameId ? JSON.parse(gameId) : undefined,
      name: name ? JSON.parse(name) : id,
    });
  }
  return results;
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
function computeSync(collection, ignored, disabledMods = []) {
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

  return {
    removedMods, keptMods, removedModRules, keptModRules, unmatched,
    disabledKept, disabledNeedsManual, plugins, pluginsDisabled,
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
  BACKUPS_DIR,
  STATE_BACKUPS_DIR,
  TESTED_VORTEX_VERSIONS,
  loadConfig,
  saveConfig,
  scanStagingCollections,
  buildBackupSnapshot,
  saveBackup,
  loadBackup,
  listBackups,
  isVortexRunning,
  getVortexAppVersion,
  checkVortexVersionCompat,
  withStateDb,
  withLiveStateDb,
  applyIgnoresToRules,
  writeIgnoredFlags,
  findCurrentModIds,
  writeDisabledFlags,
  getRules,
  getModValue,
  extractIgnored,
  extractAllMembers,
  filterToCollectionMembers,
  listProfiles,
  getDisabledInstalledMods,
  attachPluginFiles,
  computeSync,
  writePatchedCollection,
};
