#!/usr/bin/env node
// Interactive terminal menu for vortex-collection-sync. Wraps lib.js with
// numbered prompts and native Windows file-picker dialogs instead of CLI
// flags. Run with no arguments (the wrapper script routes here automatically
// when you call it with no subcommand).

const fs = require('fs');
const path = require('path');
const readline = require('readline/promises');
const { spawnSync } = require('child_process');

const lib = require('./lib/vortex-sync/lib');
const dialog = require('./lib/vortex-sync/win-dialog');
const { buildHtmlReport } = require('./lib/vortex-sync/report');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

// Small ANSI color helpers so headers/warnings/errors/success stand out in an
// otherwise plain terminal. Skipped when stdout isn't a TTY (e.g. piped/
// redirected output) so logs/redirects don't fill up with escape codes.
const useColor = process.stdout.isTTY;
const ANSI = { reset: '\x1b[0m', bold: '\x1b[1m', cyan: '\x1b[36m', yellow: '\x1b[33m', red: '\x1b[31m', green: '\x1b[32m', magenta: '\x1b[35m', blue: '\x1b[34m' };
function paint(code, text) {
  return useColor ? `${code}${text}${ANSI.reset}` : text;
}
const header = (text) => paint(ANSI.bold + ANSI.cyan, text);
const warnText = (text) => paint(ANSI.yellow, text);
const errText = (text) => paint(ANSI.red, text);
const okText = (text) => paint(ANSI.green, text);
const highlight = (text) => paint(ANSI.bold + ANSI.magenta, text);
// For the specific button/screen names quoted in step-by-step instructions
// (e.g. click "Update") — these are the exact things to click, and used to
// get lost as plain white text packed in with everything else around them.
const action = (quotedText) => paint(ANSI.bold + ANSI.blue, quotedText);

async function ask(prompt) {
  return (await rl.question(prompt)).trim();
}

async function selectFromList(items, labelFn, promptText) {
  console.log(`\n${promptText}`);
  items.forEach((it, i) => console.log(`  ${i + 1}) ${labelFn(it)}`));
  console.log('  0) Cancel');
  for (;;) {
    const ans = await ask('> ');
    const n = parseInt(ans, 10);
    if (n === 0) return null;
    if (!Number.isNaN(n) && n >= 1 && n <= items.length) return items[n - 1];
    console.log('Invalid selection, try again.');
  }
}

async function confirm(promptText, defaultNo = true) {
  const suffix = defaultNo ? '[y/N]' : '[Y/n]';
  const ans = (await ask(`${promptText} ${suffix} `)).trim().toLowerCase();
  if (ans === '') return !defaultNo;
  return ans === 'y' || ans === 'yes';
}

// Warns if Vortex's app version hasn't been tested with this tool's
// live-state writes — shown before the "proceed?" confirmation so it can
// actually inform the decision, not just log after the fact.
async function warnIfVortexVersionUntested() {
  const { version, tested } = await lib.checkVortexVersionCompat(lib.DEFAULT_STATE_DIR);
  if (!tested) {
    console.log(
      warnText(
        `\n⚠ Vortex version ${version ?? 'unknown'} has not been tested with this tool's live-state writes ` +
        `(tested against: ${lib.TESTED_VORTEX_VERSIONS.join(', ')}). Vortex occasionally changes its state layout ` +
        'between versions — proceed with extra caution, and double-check the result in Vortex\'s UI afterward.'
      )
    );
  }
}

function openInBrowser(filePath) {
  spawnSync('powershell.exe', ['-NoProfile', '-Command', `Start-Process -FilePath '${filePath.replace(/'/g, "''")}'`]);
}

async function requireVortexClosed() {
  if (lib.isVortexRunning()) {
    console.log(warnText('\nVortex is currently running. This tool only ever reads a temp copy of its'));
    console.log(warnText('state database, but the copy step needs the files unlocked first.'));
    console.log(warnText('Close Vortex, then press Enter to continue (or type "q" to quit).'));
    const ans = await ask('> ');
    if (ans.toLowerCase() === 'q') return false;
    if (lib.isVortexRunning()) {
      console.log(warnText('Still running — try again once it\'s closed.'));
      return requireVortexClosed();
    }
  }
  return true;
}

// Resolves the Vortex mod staging directory to scan for collection.json
// files: config.json first, prompting (and offering to save) if missing or
// no longer valid.
async function resolveStagingDir() {
  const config = lib.loadConfig();
  if (config.stagingDir && fs.existsSync(config.stagingDir)) {
    return config.stagingDir;
  }
  console.log('\nWhere does Vortex stage your Skyrim SE mods? (the folder containing one');
  console.log('subfolder per installed mod/collection, e.g. "E:\\Vortex Mods\\skyrimse")');
  for (;;) {
    const answer = await ask(`Staging directory${config.stagingDir ? ` [${config.stagingDir}]` : ''}: `);
    const dir = answer || config.stagingDir;
    if (dir && fs.existsSync(dir)) {
      if (await confirm(`Save "${dir}" as the default for next time?`, false)) {
        lib.saveConfig({ ...config, stagingDir: dir });
      }
      return dir;
    }
    console.log('That path doesn\'t exist — try again.');
  }
}

// filterName, when given, narrows the list to collections whose name matches
// (case-insensitive) — e.g. the collection name recorded in a backup, so
// picking a backup for "GTS Community Edition" doesn't also show unrelated
// installed collections to choose from. Falls back to the full list if
// nothing matches, so a renamed/missing collection doesn't dead-end you.
async function pickInstalledCollection(stagingDir, filterName) {
  const collections = lib.scanStagingCollections(stagingDir);
  if (collections.length === 0) {
    console.log(`No collection.json files found under "${stagingDir}".`);
    return null;
  }
  let candidates = collections;
  if (filterName) {
    const matching = collections.filter((c) => c.name.toLowerCase() === filterName.toLowerCase());
    if (matching.length > 0) {
      candidates = matching;
    } else {
      console.log(warnText(`\nNo installed collection named "${filterName}" found — showing all installed collections instead.`));
    }
  }
  return selectFromList(
    candidates,
    (c) => `${c.name}  (${c.modCount} mods)  [${c.modId}]`,
    'Select an installed collection:'
  );
}

// Finds the profile to use for the disabled-mods check: auto-picks if
// there's exactly one skyrimse profile, or one whose name matches the
// collection; otherwise lets the user choose (or skip the check).
async function resolveProfile(db, collectionName) {
  const profiles = await lib.listProfiles(db);
  const skyrimProfiles = profiles.filter((p) => p.gameId === lib.GAME_ID);
  if (skyrimProfiles.length === 0) return null;
  if (skyrimProfiles.length === 1) return skyrimProfiles[0];

  const nameMatch = skyrimProfiles.find(
    (p) => p.name && collectionName && p.name.toLowerCase() === collectionName.toLowerCase()
  );
  if (nameMatch) return nameMatch;

  console.log('\nMultiple Skyrim SE profiles found — pick the one to check for disabled mods.');
  const items = [...skyrimProfiles, { profileId: null, name: '(skip disabled-mod check)' }];
  return selectFromList(items, (p) => p.name, 'Select a profile:');
}

async function doListIgnored() {
  const stagingDir = await resolveStagingDir();
  const collection = await pickInstalledCollection(stagingDir);
  if (!collection) return;
  if (!(await requireVortexClosed())) return;

  const ignored = await lib.withStateDb(lib.DEFAULT_STATE_DIR, async (db) => {
    const rules = await lib.getRules(db, collection.modId);
    return lib.extractIgnored(rules);
  });
  console.log(`\n${ignored.length} mod(s) ignored in "${collection.name}":\n`);
  for (const m of ignored) console.log(`  - ${m.name}`);
}

async function doListDisabled() {
  const stagingDir = await resolveStagingDir();
  const collection = await pickInstalledCollection(stagingDir);
  if (!collection) return;
  if (!(await requireVortexClosed())) return;

  const result = await lib.withStateDb(lib.DEFAULT_STATE_DIR, async (db) => {
    const rules = await lib.getRules(db, collection.modId);
    const profile = await resolveProfile(db, collection.name);
    if (!profile?.profileId) return null;
    const disabled = await lib.getDisabledInstalledMods(db, profile.profileId);
    return { profile, disabled: lib.filterToCollectionMembers(disabled, rules) };
  });
  if (!result) return;
  console.log(`\n${result.disabled.length} mod(s) from "${collection.name}" are disabled in profile "${result.profile.name}":\n`);
  for (const m of result.disabled) console.log(`  - ${m.name}`);
}

// No fallback to a hardcoded folder inside this project any more -- confirmed live this was
// confusing (a real backup silently landed inside lib/vortex-sync/backups/, nothing resembling a
// real "Vortex" location, with no way to tell where it actually went). Same interactive-prompt
// convention as resolveStagingDir() above -- doesn't need to already exist (saveBackup creates it).
async function resolveSyncBackupRoot() {
  const config = lib.loadConfig();
  if (config.syncBackupRoot) return config.syncBackupRoot;
  console.log('\nWhere should this tool save its own backups (the ignored/disabled mod snapshot');
  console.log('files, NOT Vortex\'s own database)? e.g. "F:\\Vortex Backups\\collection-sync"');
  const answer = await ask('Backups folder: ');
  if (!answer) throw new Error('A backups folder is required before a backup can be created.');
  if (await confirm(`Save "${answer}" as the default for next time?`, false)) {
    lib.saveConfig({ ...config, syncBackupRoot: answer });
  }
  return answer;
}

// Phase 1 — run this BEFORE clicking "Update" on a collection in Vortex.
// Vortex's update flow deletes the currently-installed revision's data
// (staging folder, and the corresponding state entry) as soon as the update
// starts, so there is no later point where both the old ignored/disabled
// data and the new collection.json coexist — everything needed for the
// comparison has to be captured now, to a durable file.
async function doBackup() {
  const stagingDir = await resolveStagingDir();
  const collection = await pickInstalledCollection(stagingDir);
  if (!collection) return;
  const syncBackupRoot = await resolveSyncBackupRoot();
  if (!(await requireVortexClosed())) return;

  const captured = await lib.withStateDb(lib.DEFAULT_STATE_DIR, async (db) => {
    const rules = await lib.getRules(db, collection.modId);
    const ignored = lib.extractIgnored(rules);
    const profile = await resolveProfile(db, collection.name);
    const disabledRaw = profile?.profileId ? await lib.getDisabledInstalledMods(db, profile.profileId) : [];
    const disabled = lib.attachPluginFiles(lib.filterToCollectionMembers(disabledRaw, rules), stagingDir);
    return { ignored, profile, disabled };
  });

  const snapshot = lib.buildBackupSnapshot({
    collectionModId: collection.modId,
    collectionName: collection.name,
    profileId: captured.profile?.profileId,
    profileName: captured.profile?.name,
    stagingDir,
    ignored: captured.ignored,
    disabled: captured.disabled,
  });
  const filePath = lib.saveBackup(snapshot, syncBackupRoot);

  console.log(okText(`\nBackup saved: ${filePath}`));
  console.log(`  ${snapshot.ignored.length} ignored mod(s), ${snapshot.disabled.length} disabled mod(s) captured.`);
  console.log(header('\n=== NEXT STEPS ==='));
  console.log(`1. Open Vortex, click ${action('"Update"')} on ${highlight(collection.name)}.`);
  console.log(`2. When the first install screen appears, click ${action('"Download Update"')}.`);
  console.log(`3. If the ${action('"Remove mods from old revision?"')} screen comes up, choose an option.`);
  console.log(`4. On the ${action('"Skyrim Special Edition collection added"')} screen, choose ${action('"Later"')}, NOT ${action('"Install Now"')}.`);
  console.log('   (Editing collection.json after this point has no effect — Vortex already read it');
  console.log('   and committed the full mod list to its own state as soon as it downloaded.)');
  console.log('5. Close Vortex completely.');
  console.log(`6. Come back here and choose ${action('"Apply ignores to Vortex\'s live state"')} — this is what actually`);
  console.log('   stops the previously-ignored mods from installing.');
  console.log(warnText(`   If it errors that the mod isn't found in Vortex's state yet, try either: in Vortex, go to`));
  console.log(`${warnText('   the Collections page and click')} ${action('"Refresh"')} ${warnText('on the collection; or reopen Vortex, wait a')}`);
  console.log(warnText('   moment, close it again, then retry this step.'));
  console.log(`7. Reopen Vortex and click ${action('"Resume"')} on the collection. Let it finish installing.`);
  console.log(`8. Close Vortex completely again, then choose ${action('"Apply disables to Vortex\'s live state"')} —`);
  console.log('   this re-disables any previously-disabled mods the update just re-enabled.');
  console.log(`9. Optionally, ${action('"Compare new collection.json against a backup"')} for a report and to auto-disable plugins.`);
}

async function pickBackup(promptText) {
  // Picking an EXISTING backup (for apply-ignores/apply-disables/compare) doesn't require
  // syncBackupRoot to be configured -- if it isn't, there's simply nothing to list here, and the
  // browse-for-a-file fallback below still works regardless (e.g. a backup file kept somewhere
  // else entirely).
  const syncBackupRoot = lib.loadConfig().syncBackupRoot;
  const backups = syncBackupRoot ? lib.listBackups(syncBackupRoot) : [];
  let backupPath = null;
  if (backups.length > 0) {
    const items = [...backups, { filePath: '__browse__', collectionName: '(browse for a different backup file...)' }];
    const picked = await selectFromList(
      items,
      (b) => b.filePath === '__browse__'
        ? b.collectionName
        : `${b.collectionName}  —  ${new Date(b.createdAt).toLocaleString()}`,
      promptText
    );
    if (!picked) return null;
    if (picked.filePath !== '__browse__') backupPath = picked.filePath;
  }
  if (!backupPath) {
    backupPath = dialog.pickOpenFile({
      title: 'Select a backup snapshot file',
      initialDir: syncBackupRoot || undefined,
      filter: 'JSON files (*.json)|*.json',
    });
    if (!backupPath) return null;
  }
  return backupPath;
}

// The step that actually keeps ignored mods from installing. Run AFTER
// stepping through Vortex's update screens to "Later" (so the new
// collection's rules exist in state), then close Vortex, run this, then
// reopen Vortex and click "Resume". Always shows a dry-run preview (via the
// safe read-only path) before asking to actually write to live state.
async function doApplyIgnores() {
  const backupPath = await pickBackup('Select the backup with the ignored-mod list to apply:');
  if (!backupPath) {
    console.log('Cancelled.');
    return;
  }
  const snapshot = lib.loadBackup(backupPath);
  console.log(`\nLoaded backup for "${snapshot.collectionName}" (${snapshot.ignored.length} ignored mod(s)).`);

  const stagingDir = snapshot.stagingDir || (await resolveStagingDir());
  const newCollection = await pickInstalledCollection(stagingDir, snapshot.collectionName);
  if (!newCollection) return;
  console.log(`Target: ${newCollection.name}  [${newCollection.modId}]`);

  if (!(await requireVortexClosed())) return;

  const dryRunChanged = await lib.withStateDb(lib.DEFAULT_STATE_DIR, async (db) => {
    const rules = await lib.getRules(db, newCollection.modId);
    return lib.applyIgnoresToRules(rules, snapshot.ignored).changed;
  });

  console.log(`\n${dryRunChanged.length} mod(s) would be set to ignored in Vortex's live state:`);
  for (const c of dryRunChanged) console.log(`  - ${c.name}`);

  if (dryRunChanged.length === 0) {
    console.log('\nNothing to change.');
    return;
  }

  await warnIfVortexVersionUntested();
  console.log(warnText('\nThis WRITES directly to Vortex\'s live state database (a full backup of state.v2 is taken first).'));
  if (!(await confirm('Proceed?'))) {
    console.log('Cancelled — nothing written.');
    return;
  }
  if (!(await requireVortexClosed())) return;

  const { changed, backupDir } = await lib.withLiveStateDb(lib.DEFAULT_STATE_DIR, async (db) => ({
    changed: await lib.writeIgnoredFlags(db, newCollection.modId, snapshot.ignored),
  }));

  console.log(`\nState backup taken at: ${backupDir}`);
  console.log(okText(`${changed.length} mod(s) set to ignored:true.`));
  console.log(highlight(`\n>>> You can now reopen Vortex and click "Resume" on ${newCollection.name}. <<<`));
  console.log(`If it stalls partway through, close Vortex and choose ${action('"Apply disables to Vortex\'s live state"')} —`);
  console.log(`then reopen Vortex and click ${action('"Resume"')} again to let it finish.`);
}

// The step that keeps previously-disabled mods disabled. Run AFTER Resume
// finishes installing (Vortex closed) — unlike doApplyIgnores, this cannot
// run before Resume, since a dependent mod's id doesn't exist until Vortex
// actually installs it.
async function doApplyDisables() {
  const backupPath = await pickBackup('Select the backup with the disabled-mod list to apply:');
  if (!backupPath) {
    console.log('Cancelled.');
    return;
  }
  const snapshot = lib.loadBackup(backupPath);
  if (snapshot.disabled.length === 0) {
    console.log(`\nBackup for "${snapshot.collectionName}" captured no disabled mods — nothing to do.`);
    return;
  }
  if (!snapshot.profileId) {
    console.log('\nThis backup has no profile recorded (disabled-mod check was skipped when it was made) — cannot proceed.');
    return;
  }
  console.log(`\nLoaded backup for "${snapshot.collectionName}" (${snapshot.disabled.length} disabled mod(s)).`);

  if (!(await requireVortexClosed())) return;

  const matches = await lib.withStateDb(lib.DEFAULT_STATE_DIR, (db) => lib.findCurrentModIds(db, snapshot.disabled));
  console.log(`\n${matches.length}/${snapshot.disabled.length} disabled mod(s) found currently installed:`);
  for (const m of matches) console.log(`  - ${m.matchedRef.name}`);

  if (matches.length < snapshot.disabled.length) {
    const foundNames = new Set(matches.map((m) => m.matchedRef.name));
    const missing = snapshot.disabled.filter((d) => !foundNames.has(d.name));
    console.log(`\n${missing.length} not found installed (Resume may still be running, or they weren't part of this revision):`);
    for (const m of missing) console.log(`  - ${m.name}`);
  }

  if (matches.length === 0) {
    console.log('\nNothing to change.');
    return;
  }

  await warnIfVortexVersionUntested();
  console.log(warnText('\nThis WRITES directly to Vortex\'s live state database (a full backup of state.v2 is taken first).'));
  if (!(await confirm('Proceed?'))) {
    console.log('Cancelled — nothing written.');
    return;
  }
  if (!(await requireVortexClosed())) return;

  const { changed, backupDir } = await lib.withLiveStateDb(lib.DEFAULT_STATE_DIR, async (db) => {
    const freshMatches = await lib.findCurrentModIds(db, snapshot.disabled);
    return { changed: await lib.writeDisabledFlags(db, snapshot.profileId, freshMatches) };
  });

  console.log(`\nState backup taken at: ${backupDir}`);
  console.log(okText(`${changed.length} mod(s) set to disabled.`));
}

// Phase 2 (optional, for the report + plugin auto-disable) — run this AFTER
// clicking Update -> Later in Vortex, once the new collection.json has been
// downloaded. Does NOT by itself stop ignored mods from installing — see
// doApplyIgnores for that.
async function doCompareFromBackup() {
  const backupPath = await pickBackup('Select a backup to compare against:');
  if (!backupPath) {
    console.log('Cancelled.');
    return;
  }

  const snapshot = lib.loadBackup(backupPath);
  console.log(`\nLoaded backup for "${snapshot.collectionName}" (${new Date(snapshot.createdAt).toLocaleString()})`);
  console.log(`  ${snapshot.ignored.length} ignored mod(s), ${snapshot.disabled.length} disabled mod(s)`);

  console.log('\nBrowse for the new collection.json (downloaded via Update -> Later)...');
  const newCollectionPath = dialog.pickOpenFile({
    title: 'Select the new collection.json',
    initialDir: snapshot.stagingDir || lib.loadConfig().stagingDir,
    filter: 'collection.json|collection.json|JSON files (*.json)|*.json|All files (*.*)|*.*',
  });
  if (!newCollectionPath) {
    console.log('Cancelled.');
    return;
  }

  const newCollection = JSON.parse(fs.readFileSync(newCollectionPath, 'utf8'));
  const result = lib.computeSync(newCollection, snapshot.ignored, snapshot.disabled);
  const before = newCollection.mods?.length || 0;
  const after = result.keptMods.length;

  console.log(`\nBackup of: ${snapshot.collectionName} [${snapshot.collectionModId}]`);
  console.log(`New collection.json: ${newCollectionPath}`);
  console.log(`Mods before: ${before} -> after: ${after}  (removed ${result.removedMods.length})`);
  console.log(`modRules removed: ${result.removedModRules.length}`);
  if (result.unmatched.length > 0) {
    console.log(warnText(`WARNING: ${result.unmatched.length} ignored mod(s) not found in the new revision.`));
  }
  console.log(
    'Note: removed mods\' plugin entries are left as-is in "plugins" — collection.json has no reliable ' +
    'link from a plugin file back to its mod for mods that were never installed.'
  );
  if (snapshot.profileId) {
    console.log(`Disabled in Vortex, kept in output: ${result.disabledKept.length} (profile "${snapshot.profileName}")`);
    console.log(`Plugins auto-disabled for those mods: ${result.pluginsDisabled.length}`);
    for (const p of result.pluginsDisabled) console.log(`  - ${p.name}  (${p.forMod})`);
    if (result.disabledNeedsManual.length > 0) {
      console.log(
        errText(
          `\n*** ACTION NEEDED: ${result.disabledNeedsManual.length} disabled mod(s) have no plugin to auto-disable ` +
          '(collection.json has no per-mod enable/disable field) — disable these manually in Vortex after installing:'
        )
      );
      for (const m of result.disabledNeedsManual) console.log(`  - ${m.name}`);
    }
  } else {
    console.log('Disabled-mod check was skipped when this backup was made.');
  }

  let outPath = null;
  let applied = false;
  if (result.removedMods.length > 0 || result.disabledKept.length > 0) {
    if (await confirm('\nWrite the patched collection.json now?')) {
      const dir = path.dirname(newCollectionPath);
      const base = path.basename(newCollectionPath, '.json');
      outPath = dialog.pickSaveFile({
        title: 'Save patched collection.json',
        initialDir: dir,
        filter: 'JSON files (*.json)|*.json',
        defaultFileName: `${base}-patched.json`,
      });
      if (outPath) {
        lib.writePatchedCollection(newCollection, result, outPath);
        applied = true;
        console.log(`Wrote: ${outPath}`);
      } else {
        console.log('Cancelled — nothing written.');
      }
    }
  } else {
    console.log('\nNothing to remove and nothing disabled — no changes needed.');
  }

  const reportsDir = path.join(__dirname, 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(reportsDir, `sync-${snapshot.collectionModId}-${stamp}.html`);
  const html = buildHtmlReport({
    collectionInfo: newCollection.info,
    collectionModId: snapshot.collectionModId,
    sourcePath: newCollectionPath,
    outPath,
    applied,
    before,
    after,
    result,
  });
  fs.writeFileSync(reportPath, html);
  console.log(`\nReport: ${reportPath}`);
  openInBrowser(reportPath);
}

async function mainMenu() {
  console.log(header('\n=== Vortex Collection Sync ==='));
  console.log(warnText('Before choosing any option: make sure Vortex is completely closed.'));
  console.log(warnText('After each action, follow the on-screen instructions in order — several steps'));
  console.log(warnText('(Backup -> Apply ignores -> Resume in Vortex -> Apply disables) only work correctly'));
  console.log(warnText('when done in sequence, with Vortex closed at the points that ask for it.'));
  for (;;) {
    console.log(header('\n=== Vortex Collection Sync ==='));
    console.log('  1) List ignored mods in an installed collection');
    console.log('  2) List currently disabled mods in a collection');
    console.log('  3) Backup a collection BEFORE updating it in Vortex');
    console.log('  4) Apply ignores to Vortex\'s live state (after Update -> Later, Vortex closed)');
    console.log('  5) Apply disables to Vortex\'s live state (after Resume finishes, Vortex closed)');
    console.log('  6) Compare new collection.json against a backup (report + plugin auto-disable)');
    console.log('  0) Exit');
    const choice = await ask('> ');
    try {
      if (choice === '1') await doListIgnored();
      else if (choice === '2') await doListDisabled();
      else if (choice === '3') await doBackup();
      else if (choice === '4') await doApplyIgnores();
      else if (choice === '5') await doApplyDisables();
      else if (choice === '6') await doCompareFromBackup();
      else if (choice === '0') break;
      else console.log('Invalid choice.');
    } catch (caughtErr) {
      console.error(errText(`ERROR: ${caughtErr.message}`));
    }
  }
  rl.close();
}

mainMenu();
