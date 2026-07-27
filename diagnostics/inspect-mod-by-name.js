'use strict';
// READ-ONLY diagnostic, reusable -- dumps every persisted field Vortex's state.v2 has for any mod
// whose modId (installationPath) or attribute values contain a given substring, plus any download
// (archive) record that mentions it. Built while designing the "Clean up" report (orphaned staging
// folders / archives with no real relationship to a downloaded mod or collection) to see real ground
// truth instead of guessing at Vortex's actual data shape for a "ghost" mod entry -- see the matching
// test case below and TECHNICAL.md's Clean up design write-up for what this confirmed.
//
// Example finding (2026-07-27): staging folder "College Curriculum - Faction Requirement-79929-
// 1-0-0-1670095062" (no matching archive in the downloads folder either) turned out to have a real
// mods### entry in state.v2 -- Vortex auto-adopts an unrecognized staging folder into a bare mod
// record (installationPath = folder name, no customFileName, no archiveId, no collection rules) --
// so "no relationship with a downloaded mod or collection" has to check the referencing mod's OWN
// attributes/archiveId/collection membership, not just "does any mods### key reference this folder".
//
// Never touches live state.v2 itself -- read via withStateDb's normal copy-then-read path, same
// safety contract as every other read in this project. Requires Vortex to be fully closed.
// Run from the project root: node diagnostics/inspect-mod-by-name.js "<search text>"

const syncLib = require('../lib/vortex-sync/lib.js');

const NEEDLE = process.argv[2];
if (!NEEDLE) {
  console.error('usage: node diagnostics/inspect-mod-by-name.js "<search text>"');
  process.exit(1);
}

// NOTE: prefix-scan via `lt: prefix + '#'` does NOT work here -- '#' (0x23) sorts BEFORE almost
// every real key-segment character (digits/letters are all > 0x23), so that bound would exclude
// nearly everything and silently under-count. Use `gte: prefix` with a manual startsWith+break
// instead (confirmed the hard way: an earlier version of this exact script reported 0 of 4583 real
// mod entries because of this).
async function scanPrefix(db, prefix) {
  const rows = [];
  for await (const [key, value] of db.iterator({ gte: prefix })) {
    if (!key.startsWith(prefix)) break;
    rows.push([key, value]);
  }
  return rows;
}

async function main() {
  await syncLib.withStateDb(syncLib.DEFAULT_STATE_DIR, async (db) => {
    const mods = new Map(); // modId -> { field: value, ... }
    const modRows = await scanPrefix(db, 'persistent###mods###skyrimse###');
    for (const [key, value] of modRows) {
      const rest = key.slice('persistent###mods###skyrimse###'.length);
      const sep = rest.indexOf('###');
      const modId = sep === -1 ? rest : rest.slice(0, sep);
      const field = sep === -1 ? '(root)' : rest.slice(sep + 3);
      if (!modId.includes(NEEDLE) && !value.includes(NEEDLE)) continue;
      let parsed = value;
      try { parsed = JSON.parse(value); } catch { /* keep raw string */ }
      if (!mods.has(modId)) mods.set(modId, {});
      mods.get(modId)[field] = parsed;
    }

    console.log(`=== mods### entries matching "${NEEDLE}" ===`);
    if (mods.size === 0) console.log('(none)');
    for (const [modId, fields] of mods) {
      console.log('\nmodId:', modId);
      console.log(JSON.stringify(fields, null, 2));
    }

    console.log(`\n=== downloads### entries matching "${NEEDLE}" ===`);
    const dlRows = await scanPrefix(db, 'persistent###downloads###files###');
    let found = 0;
    for (const [key, value] of dlRows) {
      if (key.includes(NEEDLE) || value.includes(NEEDLE)) {
        console.log(key, '=', value);
        found++;
      }
    }
    if (found === 0) console.log('(none)');
  });
}

main().catch((err) => { console.error('FAILED:', err); process.exit(1); });
