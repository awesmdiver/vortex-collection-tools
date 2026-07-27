'use strict';
// READ-ONLY diagnostic, reusable -- compares Vortex's state.v2 read two ways for the currently
// active profile's disabled+installed mods:
//   (a) this tool's real copyStateDb/withStateDb (excludes the *.log WAL -- today's shipped
//       behavior everywhere this project reads Vortex's database)
//   (b) an identical copy that additionally includes the *.log WAL
// Use this whenever a reported ignored/disabled count looks wrong right after changing a lot of
// mods' status in Vortex -- it tells you definitively whether the WAL-exclusion tradeoff
// documented in lib/vortex-sync/lib.js's copyStateDb (accepted to avoid a previously-confirmed
// native LevelDB replay crash risk) is the cause, by showing exactly which mods disagree between
// the two reads.
//
// Confirmed live 2026-07-27: a user re-enabled ~1900 mods, closed Vortex, and Create Backup still
// reported 371 disabled. This script proved the 371 were sitting ONLY in the still-unflushed *.log
// WAL (371 "disabled in excluded but not included", 0 the other way) -- i.e. real writes Vortex had
// made, that this tool's WAL-exclusion was silently discarding. See TECHNICAL.md's WAL-exclusion
// write-up for the full incident and what was decided about fixing the shipped read path.
//
// Never touches live state.v2 itself -- both paths are copy-then-read, same safety contract as
// the real tool. Requires Vortex to be fully closed (same precondition withStateDb enforces).
// Run from the project root: node diagnostics/wal-inclusion-check.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { ClassicLevel } = require('classic-level');
const syncLib = require('../lib/vortex-sync/lib.js');

const STATE_DIR = syncLib.DEFAULT_STATE_DIR;

function copyStateDbIncludingLog(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir)) {
    if (entry === 'LOCK') continue; // still skip the lockfile itself -- irrelevant to data, just a mutex
    fs.copyFileSync(path.join(srcDir, entry), path.join(destDir, entry));
  }
}

async function main() {
  const profileId = await syncLib.withStateDb(STATE_DIR, async (db) => syncLib.getLastActiveProfileId(db));
  console.log('Profile (lastActiveProfileId):', profileId);

  const walExcluded = await syncLib.withStateDb(STATE_DIR, async (db) => syncLib.getDisabledInstalledMods(db, profileId));

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wal-diag-'));
  copyStateDbIncludingLog(STATE_DIR, tmpDir);
  const db2 = new ClassicLevel(tmpDir, { valueEncoding: 'utf8' });
  let walIncluded;
  try {
    walIncluded = await syncLib.getDisabledInstalledMods(db2, profileId);
  } finally {
    await db2.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`Disabled+installed mod count (WAL-excluded read, today's shipped behavior): ${walExcluded.length}`);
  console.log(`Disabled+installed mod count (WAL-included read, experimental):            ${walIncluded.length}`);

  const exclSet = new Set(walExcluded.map((m) => m.vortexModId));
  const inclSet = new Set(walIncluded.map((m) => m.vortexModId));
  const onlyExcluded = walExcluded.filter((m) => !inclSet.has(m.vortexModId));
  const onlyIncluded = walIncluded.filter((m) => !exclSet.has(m.vortexModId));
  console.log(`Disabled in EXCLUDED read but NOT in included: ${onlyExcluded.length}`);
  for (const m of onlyExcluded.slice(0, 10)) console.log(`  - ${m.name}`);
  console.log(`Disabled in INCLUDED read but NOT in excluded: ${onlyIncluded.length}`);
  for (const m of onlyIncluded.slice(0, 10)) console.log(`  - ${m.name}`);
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
