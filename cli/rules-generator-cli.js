#!/usr/bin/env node
'use strict';
// Rules Generator, Phase 1 deliverable: prints exactly what the tool would find, for a human to
// eyeball against Vortex directly -- no UI, no writes, no rule application yet. See
// TECHNICAL.md's "Rules Generator (Phase 1 research)" section before changing anything here.
// All real logic lives in lib/rules-generator.js's analyzeCollections -- this file only formats
// its output for the terminal; the web UI (Phase 2) calls the exact same function.
//
// Usage: node rules-generator-cli.js [--old "Collection Name"] [--new "Collection Name"]
// Defaults match this project's own validated test fixture if no flags are given.

const syncLib = require('../lib/vortex-sync/lib');
const rg = require('../lib/rules-generator');

function parseArgs(argv) {
  const out = { old: 'GTS - PBR Visual Overhaul', new: 'Rules Generator' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--old') out.old = argv[++i];
    else if (argv[i] === '--new') out.new = argv[++i];
  }
  return out;
}

function section(title) {
  console.log(`\n${'='.repeat(70)}\n${title}\n${'='.repeat(70)}`);
}

function describeEntry(entry) {
  if (!entry) return '(not found)';
  return `${rg.displayName(entry)}  [key: ${entry.modKey}]`;
}

function describeByKey(modIndex, key) {
  return key ? describeEntry(modIndex.get(key)) : '(not found)';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = syncLib.loadConfig();
  const stateDir = config.state || syncLib.DEFAULT_STATE_DIR;

  await syncLib.withStateDb(stateDir, async (db) => {
    const modIndex = await rg.buildModIndex(db);

    section('1. Resolved collection identity');
    const oldMatches = rg.findCollectionByName(modIndex, args.old);
    const newMatches = rg.findCollectionByName(modIndex, args.new);
    if (oldMatches.length !== 1) {
      console.log(`OLD collection "${args.old}": found ${oldMatches.length} match(es), expected 1.`);
      oldMatches.forEach((m) => console.log('  -', describeEntry(m)));
      return;
    }
    if (newMatches.length !== 1) {
      console.log(`NEW collection "${args.new}": found ${newMatches.length} match(es), expected 1.`);
      newMatches.forEach((m) => console.log('  -', describeEntry(m)));
      return;
    }
    console.log('Original collection:', describeEntry(oldMatches[0]));
    console.log('New collection:     ', describeEntry(newMatches[0]));

    const result = rg.analyzeCollections(modIndex, oldMatches[0].modKey, newMatches[0].modKey);

    section('2. Collection membership');
    console.log(`Original collection members (${result.oldMembers.length}):`);
    result.oldMembers.forEach((m) => console.log('  -', m.name, m.optional ? '[optional]' : ''));
    if (result.oldUnresolved.length > 0) {
      console.log(`  UNRESOLVED: ${result.oldUnresolved.length}`);
      result.oldUnresolved.forEach((u) => console.log('    -', JSON.stringify(u.reference)));
    }
    console.log(`New collection members (${result.newMembers.length}):`);
    result.newMembers.forEach((m) => console.log('  -', m.name));
    if (result.newUnresolved.length > 0) {
      console.log(`  UNRESOLVED: ${result.newUnresolved.length}`);
      result.newUnresolved.forEach((u) => console.log('    -', JSON.stringify(u.reference)));
    }

    section('3. Raw rule shapes (real examples, not normalized)');
    const sampleKey = result.mapping[0]?.newModKey;
    console.log('A live DB rule, as found on', sampleKey, ':');
    console.log(JSON.stringify((modIndex.get(sampleKey)?.rules || [])[0], null, 2));

    section('4. Old -> new mapping (link rule identification)');
    result.mapping.forEach((m) => {
      console.log(describeByKey(modIndex, m.newModKey));
      console.log(`  -> old counterpart: ${describeByKey(modIndex, m.oldModKey)}`);
      console.log(`  -> link rule: ${JSON.stringify(m.linkRule)}`);
    });
    result.anomalies.forEach((a) =>
      console.log(
        `${describeByKey(modIndex, a.modKey)}: found ${a.candidateCount} name-matching candidate link rule(s), expected exactly 1.`,
      ),
    );
    result.noLinkFound.forEach((n) =>
      console.log(
        `${describeByKey(modIndex, n.modKey)}: no name-matching link found (${n.rawCandidateCount} raw candidate(s)).`,
      ),
    );

    section('5. Full effective rule set found on each mapped old mod');
    result.mapping.forEach((m) => {
      console.log(`\nOld mod: ${describeByKey(modIndex, m.oldModKey)}  (source: ${m.ruleSetSource})`);
      console.log(`Rules to consider copying (${m.rulesToConsider.length}):`);
      m.rulesToConsider.forEach((r) =>
        console.log(`  ${r.type} -> ${describeByKey(modIndex, r.targetKey)}`),
      );
    });

    section('6. Mapping table + remap decisions (the final rule set to copy)');
    result.mapping.forEach((m) => {
      console.log(`\nFor ${describeByKey(modIndex, m.newModKey)} (copying from ${describeByKey(modIndex, m.oldModKey)}):`);
      m.rulesToConsider.forEach((r) => {
        if (r.status === 'unresolved') {
          console.log(`  ${r.type} -> (target not resolved to an installed mod -- SKIP + report)`);
        } else if (r.status === 'remapped') {
          console.log(
            `  ${r.type} -> ${describeByKey(modIndex, r.targetKey)}  ` +
              `[REMAPPED from ${describeByKey(modIndex, r.originalTargetKey)}` +
              `${r.counterpartFoundVia === 'shared-modId' ? ' (found via shared modId, no link rule set yet)' : ''}]`,
          );
        } else {
          console.log(`  ${r.type} -> ${describeByKey(modIndex, r.targetKey)}  [no counterpart -- keep as-is]`);
        }
      });
    });

    section('7. Anomalies (name-matching candidate count != 1)');
    console.log(result.anomalies.length === 0 ? 'None.' : '');
    result.anomalies.forEach((a) =>
      console.log(`${describeByKey(modIndex, a.modKey)}: ${a.candidateCount} name-matching candidates`),
    );

    section('8. No link found (no name-matching candidate at all)');
    console.log(result.noLinkFound.length === 0 ? 'None.' : '');
    result.noLinkFound.forEach((n) =>
      console.log(`${describeByKey(modIndex, n.modKey)} (${n.rawCandidateCount} raw candidate(s) rejected)`),
    );
  });
}

main().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
