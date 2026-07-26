#!/usr/bin/env node
// CLI entry point. The web UI (web/public/sync-app.js's Update Collection tab) is the primary,
// recommended way to run this flow -- this flag-based CLI is kept for scripting/automation use.
// (The interactive terminal menu that used to accompany this has been archived -- see
// terminal-flow-archive/, gitignored -- this project is 100% web-UI-driven now.)
//
// Keeps mods you've marked "Ignore" in an installed Vortex collection
// ignored across an update, and auto-disables (or, when there's no plugin to
// toggle, clearly flags for manual action) any mods that are currently
// disabled and belong to that same collection.
//
// IMPORTANT — two things confirmed by hands-on testing (2026-07-13):
// 1. Vortex deletes the currently-installed revision's data as soon as you
//    let a collection update proceed, so `backup` must be run BEFORE
//    clicking "Update" in Vortex.
// 2. Editing collection.json on disk does NOT control what Vortex installs —
//    Vortex's own installer reads it and commits mods to its rules state as
//    soon as the collection package downloads, before you ever get to
//    "Resume". The only way to actually make Vortex skip a mod is
//    `apply-ignores`, which writes ignored:true directly onto the matching
//    rules in Vortex's live state (Vortex must be closed; a full state
//    backup is taken automatically first). `compare` (file-patching) is
//    still useful for the report/audit trail and for disabling plugins of
//    disabled mods, but does not by itself prevent ignored mods from
//    installing — see lib.js's withLiveStateDb for the full explanation.
//
// Read-only commands (list-*, backup, compare without --apply) never open or
// write the live state database — see lib.js's withStateDb. Only
// `apply-ignores --apply` does, via withLiveStateDb.

const fs = require('fs');
const lib = require('./lib/vortex-sync/lib');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function stagingDirOf(args) {
  return args['staging-dir'] || lib.loadConfig().stagingDir;
}

// Surfaces lib.js's identityDriftWarning (see its own comment there) prominently, distinct from the
// normal "removed by the collection author"/"not found installed" output above it -- a schema-drift
// false-positive reads as ordinary removal otherwise, hiding a real tool/Vortex incompatibility.
function printIdentityWarningIfAny(identityWarning) {
  if (identityWarning) console.log(`\n⚠ WARNING: ${identityWarning}`);
}

async function warnIfVortexVersionUntested(stateDir) {
  const { version, tested } = await lib.checkVortexVersionCompat(stateDir);
  if (!tested) {
    console.log(
      `WARNING: Vortex version ${version ?? 'unknown'} has not been tested with this tool's live-state writes ` +
      `(tested against: ${lib.TESTED_VORTEX_VERSIONS.join(', ')}). Vortex occasionally changes its state layout ` +
      'between versions — proceed with extra caution, and double-check the result in Vortex\'s UI afterward.'
    );
  }
}

async function cmdListCollections(args) {
  const stagingDir = stagingDirOf(args);
  if (!stagingDir) {
    console.error('No staging directory configured. Pass --staging-dir <path> (e.g. "E:/Vortex Mods/skyrimse").');
    process.exit(1);
  }
  const collections = lib.scanStagingCollections(stagingDir);
  console.log(`${collections.length} installed collection(s) found under "${stagingDir}":\n`);
  for (const c of collections) {
    console.log(`  ${c.modId}`);
    console.log(`    name: ${c.name}, mods: ${c.modCount}`);
  }
}

async function cmdListIgnored(args) {
  const modId = args['mod-id'];
  if (!modId) {
    console.error('Usage: list-ignored --mod-id <vortex-collection-mod-id> [--state <path-to-state.v2>]');
    process.exit(1);
  }
  const stateDir = args.state || lib.DEFAULT_STATE_DIR;

  const ignored = await lib.withStateDb(stateDir, async (db) => {
    const rules = await lib.getRules(db, modId);
    return lib.extractIgnored(rules);
  });

  console.log(`${ignored.length} mod(s) ignored in "${modId}":\n`);
  for (const m of ignored) {
    console.log(`  - ${m.name}  (md5=${m.fileMD5 || 'n/a'}, tag=${m.tag || 'n/a'})`);
  }
}

async function cmdListDisabled(args) {
  const modId = args['mod-id'];
  const profileId = args['profile-id'];
  if (!modId || !profileId) {
    console.error(
      'Usage: list-disabled --mod-id <installed-collection-mod-id> --profile-id <vortex-profile-id> [--state <path-to-state.v2>]'
    );
    console.error('(--mod-id scopes the report to mods belonging to that collection — a profile can contain several collections.)');
    process.exit(1);
  }
  const stateDir = args.state || lib.DEFAULT_STATE_DIR;
  const disabled = await lib.withStateDb(stateDir, async (db) => {
    const rules = await lib.getRules(db, modId);
    const all = await lib.getDisabledInstalledMods(db, profileId);
    return lib.filterToCollectionMembers(all, rules);
  });
  console.log(`${disabled.length} mod(s) from "${modId}" are currently disabled in profile "${profileId}":\n`);
  for (const m of disabled) {
    console.log(`  - ${m.name}  (md5=${m.fileMD5 || 'n/a'})`);
  }
}

function printSyncResult({ label, collectionPath, ignoredCount, hasProfile, result }) {
  console.log(`Installed collection mod id: ${label}`);
  console.log(`Ignored mods captured: ${ignoredCount}`);
  console.log(`New collection.json (${collectionPath}) mods before: ${result.removedMods.length + result.keptMods.length}`);
  console.log(`Mods removed (matched ignored list): ${result.removedMods.length}`);
  console.log(`Mods kept: ${result.keptMods.length}`);
  console.log(`modRules removed (referenced a removed mod): ${result.removedModRules.length}`);
  if (result.removedMods.length > 0) {
    console.log('\nRemoved:');
    for (const m of result.removedMods) console.log(`  - ${m.name}`);
  }
  if (result.unmatched.length > 0) {
    console.log(
      `\nWARNING: ${result.unmatched.length} ignored mod(s) had no match in the new collection.json ` +
      '(likely already absent from this revision, or removed/replaced upstream):'
    );
    for (const m of result.unmatched) console.log(`  - ${m.name}`);
  }
  console.log(
    '\nNote: removed mods\' plugin entries (if any) are left as-is in "plugins" — collection.json has no ' +
    'reliable link from a plugin file back to the mod that provides it for mods that were never installed.'
  );
  if (hasProfile) {
    console.log(`\nDisabled in Vortex, kept in output: ${result.disabledKept.length}`);
    console.log(`Plugins auto-disabled for those mods: ${result.pluginsDisabled.length}`);
    for (const p of result.pluginsDisabled) console.log(`  - ${p.name}  (${p.forMod})`);
    if (result.disabledNeedsManual.length > 0) {
      console.log(
        `\n*** ACTION NEEDED: ${result.disabledNeedsManual.length} disabled mod(s) have no plugin to auto-disable ` +
        '(collection.json has no per-mod enable/disable field) — disable these manually in Vortex after installing:'
      );
      for (const m of result.disabledNeedsManual) console.log(`  - ${m.name}`);
    }
  }
}

// Reads ignored/disabled data live from Vortex's state. In practice this
// window rarely exists in the real update flow (see `backup`/`compare`
// below) — kept for scripting cases where you genuinely have both the old
// state and new collection.json available at once.
async function cmdSync(args) {
  const modId = args['mod-id'];
  const collectionPath = args.collection;
  if (!modId || !collectionPath) {
    console.error(
      'Usage: sync --mod-id <installed-collection-mod-id> --collection <path-to-new-collection.json> ' +
      '[--profile-id <id>] [--staging-dir <path>] [--out <path>] [--apply] [--state <path-to-state.v2>]'
    );
    process.exit(1);
  }
  const stateDir = args.state || lib.DEFAULT_STATE_DIR;
  const apply = !!args.apply;
  const outPath = args.out;
  const profileId = args['profile-id'];
  const stagingDir = stagingDirOf(args);

  if (apply && !outPath) {
    console.error('--apply requires --out <path> (this tool never overwrites files implicitly).');
    process.exit(1);
  }

  const { ignored, disabled } = await lib.withStateDb(stateDir, async (db) => {
    const rules = await lib.getRules(db, modId);
    const ignored = lib.extractIgnored(rules);
    const disabledRaw = profileId ? await lib.getDisabledInstalledMods(db, profileId) : [];
    let disabled = lib.filterToCollectionMembers(disabledRaw, rules);
    if (stagingDir) disabled = lib.attachPluginFiles(disabled, stagingDir);
    return { ignored, disabled };
  });

  const collection = JSON.parse(fs.readFileSync(collectionPath, 'utf8'));
  const result = lib.computeSync(collection, ignored, disabled);
  printSyncResult({ label: modId, collectionPath, ignoredCount: ignored.length, hasProfile: !!profileId, result });

  if (!apply) {
    console.log('\nDry run only — no file written. Re-run with --apply --out <path> to write the patched collection.json.');
    return;
  }
  lib.writePatchedCollection(collection, result, outPath);
  console.log(`\nWrote patched collection.json to: ${outPath}`);
}

// Phase 1 — run BEFORE clicking "Update" on a collection in Vortex. See
// lib.js's buildBackupSnapshot for why this has to happen before the update.
async function cmdBackup(args) {
  const modId = args['mod-id'];
  if (!modId) {
    console.error('Usage: backup --mod-id <installed-collection-mod-id> [--profile-id <id>] [--staging-dir <path>] [--state <path>] [--sync-backup-root <path>]');
    process.exit(1);
  }
  // No fallback to a hardcoded folder inside this project -- confirmed live this was confusing (a
  // real backup silently landed inside lib/vortex-sync/backups/, nothing resembling a real "Vortex"
  // location, with no way to tell where it actually went). Same required-config convention as
  // --staging-dir above: the web UI's Settings page is the normal way to set this once; --sync-
  // backup-root is the CLI-only equivalent for anyone not using the web UI at all.
  const syncBackupRoot = args['sync-backup-root'] || lib.loadConfig().syncBackupRoot;
  if (!syncBackupRoot) {
    console.error('No backups folder configured. Pass --sync-backup-root <path>, or set it once in the web UI\'s Settings page.');
    process.exit(1);
  }
  const stateDir = args.state || lib.DEFAULT_STATE_DIR;
  const profileId = args['profile-id'];
  const stagingDir = stagingDirOf(args);
  const collections = stagingDir ? lib.scanStagingCollections(stagingDir) : [];
  const collectionName = collections.find((c) => c.modId === modId)?.name || modId;

  const captured = await lib.withStateDb(stateDir, async (db) => {
    const rules = await lib.getRules(db, modId);
    const ignored = lib.extractIgnored(rules);
    let disabled = [];
    let profileName;
    if (profileId) {
      const profiles = await lib.listProfiles(db);
      profileName = profiles.find((p) => p.profileId === profileId)?.name;
      const disabledRaw = await lib.getDisabledInstalledMods(db, profileId);
      disabled = lib.filterToCollectionMembers(disabledRaw, rules);
      if (stagingDir) disabled = lib.attachPluginFiles(disabled, stagingDir);
    }
    return { ignored, disabled, profileName };
  });

  const snapshot = lib.buildBackupSnapshot({
    collectionModId: modId,
    collectionName,
    profileId,
    profileName: captured.profileName,
    stagingDir,
    ignored: captured.ignored,
    disabled: captured.disabled,
  });
  const filePath = lib.saveBackup(snapshot, syncBackupRoot);

  console.log(`Backup saved: ${filePath}`);
  console.log(`${snapshot.ignored.length} ignored mod(s), ${snapshot.disabled.length} disabled mod(s) captured.`);
  console.log('\nNext steps in Vortex:');
  console.log('  1. Click "Update" on this collection.');
  console.log('  2. When the first install screen appears, click "Download Update".');
  console.log('  3. If the "Remove mods from old revision?" screen comes up, choose an option.');
  console.log('  4. On the "Skyrim Special Edition collection added" screen, choose "Later", NOT "Install Now".');
  console.log('  5. Close Vortex, then: apply-ignores --mod-id <new-collection-id> --backup "' + filePath + '" --apply');
  console.log('  6. Reopen Vortex, click "Resume", let it finish installing.');
  console.log('  7. Close Vortex again, then: apply-disables --profile-id <id> --backup "' + filePath + '" --apply');
  console.log('\nOptionally, for the report + plugin auto-disable:');
  console.log('  compare --backup "' + filePath + '" --collection <path-to-new-collection.json>');
}

async function cmdListBackups(args) {
  const backupsDir = args['sync-backup-root'] || lib.loadConfig().syncBackupRoot;
  if (!backupsDir) {
    console.error('No backups folder configured. Pass --sync-backup-root <path>, or set it once in the web UI\'s Settings page.');
    process.exit(1);
  }
  const backups = lib.listBackups(backupsDir);
  console.log(`${backups.length} backup(s) in ${backupsDir}:\n`);
  for (const b of backups) {
    console.log(`  ${b.collectionName}  (${new Date(b.createdAt).toLocaleString()})`);
    console.log(`    ${b.filePath}`);
  }
}

// Phase 2 — run AFTER clicking Update -> Later in Vortex.
async function cmdCompare(args) {
  const backupPath = args.backup;
  const collectionPath = args.collection;
  if (!backupPath || !collectionPath) {
    console.error(
      'Usage: compare --backup <path-to-backup.json> --collection <path-to-new-collection.json> ' +
      '[--out <path>] [--apply]'
    );
    process.exit(1);
  }
  const apply = !!args.apply;
  const outPath = args.out;
  if (apply && !outPath) {
    console.error('--apply requires --out <path> (this tool never overwrites files implicitly).');
    process.exit(1);
  }

  const snapshot = lib.loadBackup(backupPath);
  const collection = JSON.parse(fs.readFileSync(collectionPath, 'utf8'));
  const result = lib.computeSync(collection, snapshot.ignored, snapshot.disabled);
  printSyncResult({
    label: `${snapshot.collectionModId} (from backup "${snapshot.collectionName}")`,
    collectionPath,
    ignoredCount: snapshot.ignored.length,
    hasProfile: !!snapshot.profileId,
    result,
  });

  if (!apply) {
    console.log('\nDry run only — no file written. Re-run with --apply --out <path> to write the patched collection.json.');
    return;
  }
  lib.writePatchedCollection(collection, result, outPath);
  console.log(`\nWrote patched collection.json to: ${outPath}`);
}

// The step that actually keeps ignored mods from installing. Run AFTER
// stepping through Vortex's update screens to "Later" (so the new
// collection's rules exist in state), then CLOSE VORTEX, run this, then
// reopen Vortex and click "Resume". Dry-run by default (reads via the safe
// temp-copy path); --apply writes directly to live state after taking a
// full backup — see lib.js's withLiveStateDb.
async function cmdApplyIgnores(args) {
  const modId = args['mod-id'];
  const backupPath = args.backup;
  if (!modId || !backupPath) {
    console.error('Usage: apply-ignores --mod-id <new-collection-mod-id> --backup <path-to-backup.json> [--apply] [--state <path>]');
    process.exit(1);
  }
  const apply = !!args.apply;
  const stateDir = args.state || lib.DEFAULT_STATE_DIR;
  const snapshot = lib.loadBackup(backupPath);

  if (!apply) {
    const { changed, unmatched, identityWarning } = await lib.withStateDb(stateDir, async (db) => {
      const rules = await lib.getRules(db, modId);
      return lib.applyIgnoresToRules(rules, snapshot.ignored);
    });
    console.log(`DRY RUN — ${changed.length} rule(s) would be set to ignored:true for "${modId}":`);
    for (const c of changed) console.log(`  - ${c.name}`);
    if (unmatched.length > 0) {
      console.log(`${unmatched.length} ignored mod(s) from the backup were not found (removed by the collection author):`);
      for (const u of unmatched) console.log(`  - ${u.name}`);
    }
    printIdentityWarningIfAny(identityWarning);
    console.log('\nRe-run with --apply to actually write this to Vortex\'s live state (Vortex must be fully closed).');
    return;
  }

  await warnIfVortexVersionUntested(stateDir);
  console.log('Writing directly to Vortex\'s live state database (a full backup is taken first)...');
  const { changed, unmatched, backupDir, identityWarning } = await lib.withLiveStateDb(stateDir, async (db) => await lib.writeIgnoredFlags(db, modId, snapshot.ignored));
  console.log(`State backup taken at: ${backupDir}`);
  console.log(`${changed.length} rule(s) set to ignored:true for "${modId}":`);
  for (const c of changed) console.log(`  - ${c.name}`);
  if (unmatched.length > 0) {
    console.log(`${unmatched.length} ignored mod(s) from the backup were not found (removed by the collection author):`);
    for (const u of unmatched) console.log(`  - ${u.name}`);
  }
  printIdentityWarningIfAny(identityWarning);
  console.log('\nYou can now reopen Vortex and click "Resume" on the collection.');
}

// The step that keeps previously-disabled mods disabled, run AFTER Resume
// finishes installing (so the dependent mods actually exist with real ids),
// Vortex closed. Unlike apply-ignores, this cannot run before Resume — a
// dependent mod's id doesn't exist until Vortex installs it.
async function cmdApplyDisables(args) {
  const profileId = args['profile-id'];
  const backupPath = args.backup;
  if (!profileId || !backupPath) {
    console.error('Usage: apply-disables --profile-id <id> --backup <path-to-backup.json> [--apply] [--state <path>]');
    process.exit(1);
  }
  const apply = !!args.apply;
  const stateDir = args.state || lib.DEFAULT_STATE_DIR;
  const snapshot = lib.loadBackup(backupPath);

  if (snapshot.disabled.length === 0) {
    console.log('This backup captured no disabled mods — nothing to do.');
    return;
  }

  if (!apply) {
    const { results: matches, identityWarning } = await lib.withStateDb(stateDir, (db) => lib.findCurrentModIdsChecked(db, snapshot.disabled));
    console.log(`DRY RUN — found ${matches.length}/${snapshot.disabled.length} disabled mod(s) now installed:`);
    for (const m of matches) console.log(`  - ${m.matchedRef.name}  [${m.vortexModId}]`);
    if (matches.length < snapshot.disabled.length) {
      const foundNames = new Set(matches.map((m) => m.matchedRef.name));
      const missing = snapshot.disabled.filter((d) => !foundNames.has(d.name));
      console.log(`\n${missing.length} not found installed yet (Resume may still be running, or they weren't part of this revision):`);
      for (const m of missing) console.log(`  - ${m.name}`);
    }
    printIdentityWarningIfAny(identityWarning);
    console.log('\nRe-run with --apply to set enabled:false on these in Vortex\'s live state (Vortex must be fully closed).');
    return;
  }

  await warnIfVortexVersionUntested(stateDir);
  console.log('Writing directly to Vortex\'s live state database (a full backup is taken first)...');
  const { changed, backupDir, identityWarning } = await lib.withLiveStateDb(stateDir, async (db) => {
    const { results: matches, identityWarning } = await lib.findCurrentModIdsChecked(db, snapshot.disabled);
    return { changed: await lib.writeDisabledFlags(db, profileId, matches), identityWarning };
  });
  console.log(`State backup taken at: ${backupDir}`);
  printIdentityWarningIfAny(identityWarning);
  console.log(`${changed.length} mod(s) set to disabled:`);
  for (const c of changed) console.log(`  - ${c.name}  [${c.vortexModId}]`);
}

// Recovery: lists this project's own state.v2 backups (see lib.js's backupLiveState, taken
// automatically before every apply-ignores/apply-disables --apply) so you have something to point
// restore-state at.
async function cmdListStateBackups() {
  const backups = lib.listStateBackups();
  console.log(`${backups.length} state.v2 backup(s) in ${lib.STATE_BACKUPS_DIR}:\n`);
  for (const b of backups) {
    console.log(`  ${new Date(b.createdAt).toLocaleString()}`);
    console.log(`    ${b.dir}`);
  }
}

// Recovery: restores one of the above backups back over Vortex's LIVE state.v2 directory. Takes a
// fresh backup of whatever is currently live first (so this is itself undoable), same safety
// wrapper as apply-ignores/apply-disables --apply -- see lib.js's restoreLiveState.
async function cmdRestoreState(args) {
  const backupDir = args['backup-dir'];
  if (!backupDir) {
    console.error('Usage: restore-state --backup-dir <path-from-list-state-backups> [--state <path>]');
    process.exit(1);
  }
  const stateDir = args.state || lib.DEFAULT_STATE_DIR;
  console.log('Restoring Vortex\'s live state database from backup (the current live state is backed up first)...');
  const { restoredFrom, preRestoreBackupDir } = lib.restoreLiveState(stateDir, backupDir);
  console.log(`Restored from: ${restoredFrom}`);
  console.log(`Your previous live state was backed up to: ${preRestoreBackupDir}`);
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const args = parseArgs(rest);
  try {
    if (cmd === 'list-collections') {
      await cmdListCollections(args);
    } else if (cmd === 'list-ignored') {
      await cmdListIgnored(args);
    } else if (cmd === 'list-disabled') {
      await cmdListDisabled(args);
    } else if (cmd === 'sync') {
      await cmdSync(args);
    } else if (cmd === 'backup') {
      await cmdBackup(args);
    } else if (cmd === 'list-backups') {
      await cmdListBackups(args);
    } else if (cmd === 'compare') {
      await cmdCompare(args);
    } else if (cmd === 'apply-ignores') {
      await cmdApplyIgnores(args);
    } else if (cmd === 'apply-disables') {
      await cmdApplyDisables(args);
    } else if (cmd === 'list-state-backups') {
      await cmdListStateBackups();
    } else if (cmd === 'restore-state') {
      await cmdRestoreState(args);
    } else {
      console.error('Usage:');
      console.error('  node index.js list-collections [--staging-dir <path>]');
      console.error('  node index.js list-ignored --mod-id <id> [--state <path>]');
      console.error('  node index.js list-disabled --mod-id <id> --profile-id <id> [--state <path>]');
      console.error('');
      console.error('  Recommended workflow (Vortex deletes old collection data as soon as an update starts,');
      console.error('  and editing collection.json does not control what actually installs):');
      console.error('  1) node index.js backup --mod-id <id> [--profile-id <id>] [--staging-dir <path>]   -- BEFORE clicking Update');
      console.error('  2) In Vortex: Update -> Download Update -> (Remove mods from old revision? if shown) -> "Later", NOT "Install Now"');
      console.error('  3) Close Vortex completely, then:');
      console.error('     node index.js apply-ignores --mod-id <new-collection-id> --backup <path> --apply');
      console.error('  4) Reopen Vortex, click "Resume" on the collection. Let it finish installing.');
      console.error('  5) Close Vortex completely again, then:');
      console.error('     node index.js apply-disables --profile-id <id> --backup <path> --apply');
      console.error('  6) node index.js compare --backup <path> --collection <new-collection.json> [--out <path>] [--apply]   -- report + plugin disabling');
      console.error('  node index.js list-backups');
      console.error('');
      console.error('  If something goes wrong during apply-ignores/apply-disables (a full state.v2 backup is');
      console.error('  always taken first automatically):');
      console.error('     node index.js list-state-backups');
      console.error('     node index.js restore-state --backup-dir <path-from-list-state-backups>');
      console.error('');
      console.error('  node index.js sync --mod-id <id> --collection <path> [--profile-id <id>] [--out <path>] [--apply] [--state <path>]  (advanced/scripting)');
      process.exit(1);
    }
  } catch (err) {
    console.error('ERROR:', err.message);
    process.exit(1);
  }
}

main();
