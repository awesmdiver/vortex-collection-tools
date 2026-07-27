'use strict';
// Rules Generator, Phase 1: data collection and validation only. No UI, no writes, no rule
// application -- see TECHNICAL.md's "Rules Generator (Phase 1 research)" section for the full
// design rationale and everything confirmed against real data + Vortex's own source before this
// was written. Read that section before changing any of the matching logic below.

const fs = require('fs');
const path = require('path');
const syncLib = require('./vortex-sync/lib');

const CONFLICT_RULE_TYPES = ['before', 'after', 'conflicts'];
const GAME_ID = syncLib.GAME_ID;

// ---- Building the mod index (one full DB scan, everything else works off this in-memory) ----

// One pass over the whole DB, building modKey -> { modId, fileId, fileMD5, customFileName,
// logicalFileName, type, rules }. Mirrors the "batch, don't multiply full DB scans" lesson
// state-query-worker.js already documents -- every other function in this file works off this
// in-memory index rather than re-scanning the DB.
async function buildModIndex(db) {
  const index = new Map();
  const get = (modKey) => {
    if (!index.has(modKey)) index.set(modKey, { modKey });
    return index.get(modKey);
  };

  const prefix = `persistent###mods###${GAME_ID}###`;
  for await (const [key, value] of db.iterator({ gte: prefix, lt: prefix + '\xff' })) {
    const rest = key.slice(prefix.length);
    const sep = rest.indexOf('###');
    if (sep === -1) continue;
    const modKey = rest.slice(0, sep);
    const field = rest.slice(sep + 3);
    const entry = get(modKey);

    if (field === 'type') {
      try { entry.type = JSON.parse(value); } catch { /* ignore */ }
    } else if (field === 'installationPath') {
      // The mod's own staging-folder name -- NOT always identical to modKey (same distinction
      // state-query-worker.js's scanAllCollections already relies on). Combine with config.staging
      // (the staging root) to get an absolute path; used only by the conflicting-files feature,
      // which is pure filesystem work and deliberately does NOT need another DB read.
      try { entry.installationPath = JSON.parse(value); } catch { entry.installationPath = value; }
    } else if (field === 'rules') {
      try { entry.rules = JSON.parse(value); } catch { entry.rules = []; }
    } else if (field === 'attributes###modId') {
      try { entry.modId = JSON.parse(value); } catch { /* ignore */ }
    } else if (field === 'attributes###fileId') {
      try { entry.fileId = JSON.parse(value); } catch { /* ignore */ }
    } else if (field === 'attributes###fileMD5') {
      try { entry.fileMD5 = JSON.parse(value); } catch { /* ignore */ }
    } else if (field === 'attributes###customFileName') {
      try { entry.customFileName = JSON.parse(value); } catch { /* ignore */ }
    } else if (field === 'attributes###logicalFileName') {
      try { entry.logicalFileName = JSON.parse(value); } catch { /* ignore */ }
    } else if (field === 'attributes###name') {
      try { entry.name = JSON.parse(value); } catch { /* ignore */ }
    } else if (field === 'attributes###collectionSlug') {
      try { entry.collectionSlug = JSON.parse(value); } catch { /* ignore */ }
    }
  }

  for (const entry of index.values()) {
    if (entry.rules === undefined) entry.rules = [];
  }
  return index;
}

// ---- Reference matching (simplified testModReference -- see TECHNICAL.md for the real,
// full priority order this mirrors: fileMD5 > repo.modId+fileId (as strings) > logicalFileName /
// fileExpression > bare id/idHint. Does NOT implement fileExpression's minimatch glob fallback --
// exact-match only for Phase 1; a report line notes this as a known simplification.) ----

function refMatchesEntry(ref, entry) {
  if (!ref || typeof ref !== 'object' || !entry) return false;

  if (ref.fileMD5 && entry.fileMD5 && ref.fileMD5 === entry.fileMD5) return true;

  if (ref.repo?.modId != null && entry.modId != null) {
    const modIdMatches = String(ref.repo.modId) === String(entry.modId);
    if (!modIdMatches) return false; // different mod page -- don't fall through to weaker checks
    if (ref.repo.fileId != null && entry.fileId != null) {
      return String(ref.repo.fileId) === String(entry.fileId);
    }
    return true;
  }

  if (ref.logicalFileName != null) {
    if (ref.logicalFileName === entry.logicalFileName) return true;
    if (ref.logicalFileName === entry.customFileName) return true;
  }

  if (ref.fileExpression != null && entry.modKey != null) {
    if (entry.modKey === ref.fileExpression || entry.modKey.startsWith(`${ref.fileExpression}-`)) {
      return true;
    }
  }

  // Weakest, checked last on purpose: a bare id/idHint is only the mod's own literal DB key,
  // not portable (see TECHNICAL.md) -- only trust it when nothing stronger was available above.
  if (ref.id != null && ref.id === entry.modKey) return true;

  return false;
}

function resolveRefToModKey(modIndex, ref) {
  if (!ref) return undefined;
  for (const [modKey, entry] of modIndex) {
    if (refMatchesEntry(ref, entry)) return modKey;
  }
  return undefined;
}

// A plain reference descriptor built FROM an index entry (not from a raw rule's own source/
// reference sub-object, which may be sparse or absent -- see the id/idHint-only shape in
// TECHNICAL.md). Used so a reverse-owned rule always has something usable to display/match on.
function entryToReference(entry) {
  return {
    modKey: entry.modKey,
    fileMD5: entry.fileMD5,
    logicalFileName: entry.logicalFileName || entry.customFileName,
    modId: entry.modId,
    fileId: entry.fileId,
  };
}

function invertType(type) {
  if (type === 'before') return 'after';
  if (type === 'after') return 'before';
  return type; // 'conflicts' is symmetric
}

// ---- The core bidirectional lesson, confirmed against Vortex's own source (findRule.ts's
// isConflictResolved) and proven with real data: a mod's OWN rules array is not its full
// effective rule set. This combines self-owned rules with every other mod's rules that
// reference this one back, inverting direction for the reverse half. ----

function getEffectiveRules(modIndex, modKey) {
  const entry = modIndex.get(modKey);
  if (!entry) return [];

  const own = (entry.rules || [])
    .filter((r) => CONFLICT_RULE_TYPES.includes(r.type))
    .map((r) => ({
      type: r.type,
      target: r.reference,
      owner: modKey,
      direction: 'own',
      raw: r,
    }));

  const reverse = [];
  for (const [otherKey, otherEntry] of modIndex) {
    if (otherKey === modKey) continue;
    for (const r of otherEntry.rules || []) {
      if (!CONFLICT_RULE_TYPES.includes(r.type)) continue;
      if (refMatchesEntry(r.reference, entry)) {
        reverse.push({
          type: invertType(r.type),
          target: entryToReference(otherEntry),
          owner: otherKey,
          direction: 'reverse',
          raw: r,
        });
      }
    }
  }

  return [...own, ...reverse];
}

// ---- Collection membership: type === 'requires' (mandatory) OR 'recommends' (optional) rules on
// the collection's own entry -- both are dependency/membership rules, distinct from ordering
// rules (before/after/conflicts). Confirmed 2026-07-26 against real data: missing 'recommends'
// silently dropped a real optional member (LOTD PBR Odds and Ends 2K, "Install ONLY if you use
// GTS Legacy Lite") -- see testModReference.ts's isDependencyRule for the authoritative source. ----

const MEMBERSHIP_RULE_TYPES = ['requires', 'recommends'];

function getCollectionMembers(modIndex, collectionKey) {
  const entry = modIndex.get(collectionKey);
  const members = [];
  const unresolved = [];
  for (const r of entry?.rules || []) {
    if (!MEMBERSHIP_RULE_TYPES.includes(r.type)) continue;
    const resolvedKey = resolveRefToModKey(modIndex, r.reference);
    if (resolvedKey) {
      members.push({ modKey: resolvedKey, optional: r.type === 'recommends', rule: r });
    } else {
      unresolved.push({ reference: r.reference, extra: r.extra, optional: r.type === 'recommends' });
    }
  }
  return { members, unresolved };
}

// Local, zero-network counterpart detection (confirmed 2026-07-26 -- see TECHNICAL.md's
// "Counterpart detection for a rule target that isn't the primary test pair"): two ALREADY-
// INSTALLED mods sharing the same Nexus modId at different fileIds are counterparts (same mod
// page, different resolution) regardless of whether any Vortex rule ever explicitly links them.
// This catches the case a rule-based-only check misses: a mod added to the new collection with
// no link rule set yet (shows "???" in Vortex's own dialog) is still a real counterpart if its
// modId matches something the old mod already has a resolved rule against.
// Confirmed 2026-07-26 (real bug, found live): sharing a modId is NOT enough on its own here.
// A single Nexus mod page can host genuinely different content as sibling files, not just size
// variants of the same thing (e.g. "Tomato's PBR Solitude - Remastered 2k" and "...- Darker
// interior stone" share a modId but are different mods, not a 2k/4k pair) -- confirmed by this
// exact false match surfacing live in the review UI. Requires the SAME name-similarity gate used
// for the primary link detection, not just a bare modId comparison.
function findNewCollectionCounterpart(modIndex, newMemberKeys, targetKey) {
  const target = modIndex.get(targetKey);
  if (!target || target.modId == null) return undefined;
  for (const memberKey of newMemberKeys) {
    if (memberKey === targetKey) continue;
    const member = modIndex.get(memberKey);
    if (
      member?.modId != null &&
      String(member.modId) === String(target.modId) &&
      namesLikelyMatch(displayName(target), displayName(member))
    ) {
      return memberKey;
    }
  }
  return undefined;
}

// ---- Name-similarity gate for link-rule candidates. Confirmed necessary 2026-07-26: "exactly one
// candidate rule pointing at an old-collection member" is NOT a safe signal on its own -- real
// false positives found this session (Praedy's Fort Dawnguard 4K -> Skyland AIO, Tomato's Riften
// PBR 4k -> Faultier's PBR Windows) each had exactly one candidate, same as the genuine pairings,
// with nothing else to distinguish them except that the names don't resemble each other at all.
// Every confirmed-real pairing has matching display names once the resolution-size token is
// stripped; every confirmed-false one doesn't. This is a REQUIRED gate, not just a tie-breaker
// for the multi-candidate case -- see TECHNICAL.md. ----

const SIZE_TOKEN = /\b[1248]k\b/gi;

function normalizeModName(name) {
  return (name || '')
    .toLowerCase()
    .replace(SIZE_TOKEN, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function displayName(entry) {
  return entry?.customFileName || entry?.logicalFileName || entry?.name || entry?.modKey || '';
}

// Exact match after normalization, or one name contains the other (handles a qualifier like
// "- Remastered" that isn't a resolution token, e.g. "Tomato's PBR Solitude" vs
// "Tomato's PBR Solitude - Remastered 2k").
function namesLikelyMatch(nameA, nameB) {
  const a = normalizeModName(nameA);
  const b = normalizeModName(nameB);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

function findCollectionByName(modIndex, name) {
  const lowerName = name.toLowerCase();
  const matches = [];
  for (const entry of modIndex.values()) {
    if (entry.type !== 'collection') continue;
    const displayName = entry.customFileName || entry.name || entry.modKey;
    if (displayName.toLowerCase() === lowerName) matches.push(entry);
  }
  return matches;
}

// ---- Old mod's rule set: DB-primary (freshest, captures live drift), collection.json fallback
// only when the mod has no live DB entry at all. Confirmed 2026-07-26: live DB and
// collection.json mostly agree but DO drift (collection.json can lag real-time manual
// conflict resolution in Vortex) -- see TECHNICAL.md. ----

function getOldModRulesFromCollectionJson(collectionJson, modFileMD5) {
  const rules = collectionJson.modRules || [];
  const own = [];
  const reverse = [];
  for (const r of rules) {
    if (!CONFLICT_RULE_TYPES.includes(r.type)) continue;
    if (r.source?.fileMD5 === modFileMD5) {
      own.push({ type: r.type, target: r.reference, direction: 'own', raw: r });
    } else if (r.reference?.fileMD5 === modFileMD5) {
      reverse.push({ type: invertType(r.type), target: r.source, direction: 'reverse', raw: r });
    }
  }
  return [...own, ...reverse];
}

// oldModIdentity: { modId, fileId } -- only needed for the fallback path (collection.json lookup);
// ignored when the mod is found live in modIndex.
function getOldModRuleSet(modIndex, oldModKey, collectionJson, oldModIdentity) {
  if (modIndex.has(oldModKey)) {
    return { source: 'live-db', rules: getEffectiveRules(modIndex, oldModKey) };
  }
  if (collectionJson && oldModIdentity) {
    // collection.json's mods[].source uses .md5 (NOT .fileMD5 -- see TECHNICAL.md).
    const modEntry = (collectionJson.mods || []).find(
      (m) =>
        String(m.source?.modId) === String(oldModIdentity.modId) &&
        (oldModIdentity.fileId == null || String(m.source?.fileId) === String(oldModIdentity.fileId)),
    );
    if (modEntry) {
      return {
        source: 'collection.json',
        rules: getOldModRulesFromCollectionJson(collectionJson, modEntry.source.md5),
      };
    }
  }
  return { source: 'not-found', rules: [] };
}

// Resolves each rule's target modKey once, excludes the circular link back to the new mod itself
// (that relationship IS the input, not a rule to copy), and de-dupes identical (type, target)
// entries (a real Vortex data quirk found live -- the same rule can be discoverable twice via
// different reference shapes).
function resolvedCopyableRules(modIndex, ruleSet, newModKey) {
  const seen = new Set();
  const out = [];
  for (const r of ruleSet.rules) {
    const targetKey = r.direction === 'own' ? resolveRefToModKey(modIndex, r.target) : r.owner;
    if (targetKey === newModKey) continue;
    const dedupeKey = `${r.type}::${targetKey ?? JSON.stringify(r.target)}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push({ ...r, targetKey });
  }
  return out;
}

// Given a confirmed new-mod -> old-mod link (from an unambiguous mapping, OR from a resolved
// anomaly pick -- both cases are identical once the link itself is known), computes the full set
// of rules to consider copying: fetch the old mod's rule set, resolve+remap each target through any
// new-collection counterpart, dedupe. Lifted out of analyzeCollections's mapping loop (2026-07-26)
// so applyRules' resolved-anomaly path can reuse the exact same computation instead of a second
// copy that could drift. oldToNewMap: Map of oldModKey -> newModKey for every already-confirmed
// mapping (used to detect a rule target that itself already has a confirmed new-collection link).
function computeMappingDetails(modIndex, newModKey, oldModKey, linkRule, newMemberKeySet, oldToNewMap) {
  const ruleSet = getOldModRuleSet(modIndex, oldModKey, null, null);
  const copyable = resolvedCopyableRules(modIndex, ruleSet, newModKey);
  const rulesToConsider = copyable.map((r) => {
    if (!r.targetKey) {
      return { type: r.type, targetKey: null, status: 'unresolved' };
    }
    const ruleLinkedCounterpart = oldToNewMap.get(r.targetKey);
    const localCounterpart = findNewCollectionCounterpart(modIndex, newMemberKeySet, r.targetKey);
    const counterpart = ruleLinkedCounterpart || localCounterpart;
    // Confirmed with the user 2026-07-26: when building a layered collection (2k base + 4k on
    // top), a rule's target ALWAYS gets remapped to its counterpart once one exists in the new
    // collection -- never left pointing at the original. This isn't a guess between two
    // plausible options; it's the deterministic point of the whole exercise (the new collection
    // represents the fully-upgraded stack, so any inter-mod relationship stays inside that
    // upgraded stack once a counterpart exists). Auto-resolved, not sent to manual review --
    // still reported transparently (originalTargetKey kept) so it's visible, just not asked
    // about.
    if (counterpart) {
      return {
        type: r.type,
        targetKey: counterpart,
        status: 'remapped',
        originalTargetKey: r.targetKey,
        counterpartFoundVia: ruleLinkedCounterpart ? 'link-rule' : 'shared-modId',
      };
    }
    return { type: r.type, targetKey: r.targetKey, status: 'no-counterpart' };
  });

  // A second dedupe pass, AFTER remapping: resolvedCopyableRules already deduped by the
  // pre-remap target, so two rules that pointed at different-but-now-remapped-to-the-same
  // target (e.g. one rule already said "after AIO-4k" directly, another said "after AIO-2k" and
  // just got remapped to AIO-4k) would otherwise both survive as separate, redundant entries.
  // Confirmed live 2026-07-26 (Tomato's PBR Solitude 4k had exactly this duplicate).
  const seenAfterRemap = new Set();
  const dedupedRulesToConsider = rulesToConsider.filter((r) => {
    const key = `${r.type}::${r.targetKey}`;
    if (seenAfterRemap.has(key)) return false;
    seenAfterRemap.add(key);
    return true;
  });

  // The old mod's own rules, AS THEY ACTUALLY ARE in Vortex right now -- no remapping, no
  // dedup-after-remap. Confirmed 2026-07-26: shown as a reference popup ("copying from X" is a
  // link) so the user can sanity-check what was actually derived against the real thing, not
  // just trust the processed "rules to copy" list.
  const oldModRules = copyable.map((r) => ({ type: r.type, targetKey: r.targetKey }));

  return {
    newModKey,
    oldModKey,
    ruleSetSource: ruleSet.source,
    linkRule: linkRule ?? null,
    rulesToConsider: dedupedRulesToConsider,
    oldModRules,
  };
}

// The full Phase 1/2 pipeline in one place -- single source of truth shared by
// rules-generator-cli.js and the web route/worker, so the CLI and the UI can never silently
// disagree about what counts as a match. See TECHNICAL.md's "Rules Generator" section for the
// full rationale behind every step here (bidirectional rules, DB-primary/collection.json
// fallback, the required name-similarity gate, the shared-modId counterpart fallback).
//
// Returns a plain-data structure (no functions, JSON-serializable) so it can cross a child-process
// boundary (the isolated DB-access worker) or an HTTP response unchanged.
function analyzeCollections(modIndex, oldCollectionKey, newCollectionKey) {
  const oldCollection = modIndex.get(oldCollectionKey);
  const newCollection = modIndex.get(newCollectionKey);
  const oldMembers = getCollectionMembers(modIndex, oldCollectionKey);
  const newMembers = getCollectionMembers(modIndex, newCollectionKey);
  const oldMemberKeys = new Set(oldMembers.members.map((m) => m.modKey));
  const newMemberKeySet = new Set(newMembers.members.map((m) => m.modKey));
  const newOnlyMembers = newMembers.members.filter((m) => !oldMemberKeys.has(m.modKey));

  const mapping = [];
  const anomalies = [];
  const noLinkFound = [];

  for (const { modKey: newModKey } of newOnlyMembers) {
    const effective = getEffectiveRules(modIndex, newModKey);
    const newEntry = modIndex.get(newModKey);
    const rawCandidates = effective.filter((r) => {
      const targetKey = r.direction === 'own' ? resolveRefToModKey(modIndex, r.target) : r.owner;
      return oldMemberKeys.has(targetKey);
    });
    // Required gate, not just a tie-breaker: a candidate whose name doesn't resemble the new
    // mod's own name is rejected outright, even when it's the ONLY candidate.
    const candidates = rawCandidates.filter((r) => {
      const targetKey = r.direction === 'own' ? resolveRefToModKey(modIndex, r.target) : r.owner;
      return namesLikelyMatch(displayName(newEntry), displayName(modIndex.get(targetKey)));
    });

    if (candidates.length === 1) {
      const oldModKey =
        candidates[0].direction === 'own'
          ? resolveRefToModKey(modIndex, candidates[0].target)
          : candidates[0].owner;
      mapping.push({ newModKey, oldModKey, linkRule: candidates[0].raw });
    } else if (candidates.length === 0) {
      noLinkFound.push({ modKey: newModKey, rawCandidateCount: rawCandidates.length });
    } else {
      anomalies.push({
        modKey: newModKey,
        candidateCount: candidates.length,
        candidates: candidates.map((c) => ({
          targetKey: c.direction === 'own' ? resolveRefToModKey(modIndex, c.target) : c.owner,
          type: c.type,
        })),
      });
    }
  }

  const oldToNewMap = new Map(mapping.map((m) => [m.oldModKey, m.newModKey]));
  const mappingDetails = mapping.map(({ newModKey, oldModKey, linkRule }) =>
    computeMappingDetails(modIndex, newModKey, oldModKey, linkRule, newMemberKeySet, oldToNewMap),
  );

  // Flat modKey -> installationPath lookup, same "build once, look up everywhere" shape as the
  // frontend's own nameByKey -- covers every mod this result touches (both collections, every
  // member, every rule target/counterpart), so the conflicting-files feature can resolve a modKey
  // to its staging folder name without another DB read. Pure filesystem work from here (combine
  // with config.staging), deliberately NOT routed through the isolated DB worker.
  const installationPaths = {};
  const noteInstallPath = (modKey) => {
    if (modKey == null || installationPaths[modKey] !== undefined) return;
    installationPaths[modKey] = modIndex.get(modKey)?.installationPath || null;
  };
  noteInstallPath(oldCollectionKey);
  noteInstallPath(newCollectionKey);
  oldMembers.members.forEach((m) => noteInstallPath(m.modKey));
  newMembers.members.forEach((m) => noteInstallPath(m.modKey));
  mappingDetails.forEach((m) => {
    noteInstallPath(m.newModKey);
    noteInstallPath(m.oldModKey);
    m.rulesToConsider.forEach((r) => {
      noteInstallPath(r.targetKey);
      noteInstallPath(r.originalTargetKey);
    });
  });

  return {
    oldCollection: { modKey: oldCollectionKey, name: displayName(oldCollection) },
    newCollection: { modKey: newCollectionKey, name: displayName(newCollection) },
    oldMembers: oldMembers.members.map((m) => ({ modKey: m.modKey, name: displayName(modIndex.get(m.modKey)), optional: m.optional })),
    oldUnresolved: oldMembers.unresolved,
    newMembers: newMembers.members.map((m) => ({ modKey: m.modKey, name: displayName(modIndex.get(m.modKey)) })),
    newUnresolved: newMembers.unresolved,
    mapping: mappingDetails,
    anomalies,
    noLinkFound,
    installationPaths,
  };
}

// ---- Report (Completed / Exceptions) -- confirmed live 2026-07-27, see TECHNICAL.md's
// "Investigated live" section. Reuses analyzeCollections' own buckets rather than re-deriving
// anything: Completed = the "Ready to copy" mapping (what Apply already writes or has written) plus
// any anomaly the user has picked a real candidate for; Exceptions = whatever's still genuinely
// unresolved, split into the two DIFFERENT reasons that can happen. ----

// Old-collection member got swapped for a different-fileId counterpart in the new collection (a
// 2k->4k style upgrade), but the OLD fileId's own mod entry is still separately tracked in Vortex.
// This can't confirm the old mod is still ENABLED in the active profile (that needs per-profile
// state data this tool doesn't read today -- see Future Work) or that it genuinely file-conflicts
// with anything (that needs a real filesystem scan against every new-collection member, too
// expensive to run here) -- reported as "still installed", not "definitely conflicting", so the
// user can verify/disable it themselves in Vortex rather than being given a false-certain diagnosis.
function findLeftoverOldInstalls(modIndex, oldMembers, newMemberKeySet) {
  const leftovers = [];
  for (const oldMember of oldMembers) {
    if (newMemberKeySet.has(oldMember.modKey)) continue; // old mod IS itself still a new-collection member -- no swap happened
    const counterpartKey = findNewCollectionCounterpart(modIndex, newMemberKeySet, oldMember.modKey);
    if (!counterpartKey) continue; // nothing upgraded this specific mod -- nothing to flag
    leftovers.push({
      oldModKey: oldMember.modKey,
      oldModName: displayName(modIndex.get(oldMember.modKey)),
      newCounterpartKey: counterpartKey,
      newCounterpartName: displayName(modIndex.get(counterpartKey)),
    });
  }
  return leftovers;
}

function computeReportData(modIndex, oldCollectionKey, newCollectionKey, ruleOverrides, anomalyOverrides) {
  const analysis = analyzeCollections(modIndex, oldCollectionKey, newCollectionKey);
  const newMemberKeySet = new Set(analysis.newMembers.map((m) => m.modKey));

  const completed = analysis.mapping
    .map((m) => ({
      newModKey: m.newModKey,
      newModName: displayName(modIndex.get(m.newModKey)),
      oldModName: displayName(modIndex.get(m.oldModKey)),
      ruleCount: m.rulesToConsider.filter((r) => r.status !== 'unresolved').length,
    }))
    .filter((m) => m.ruleCount > 0);

  // anomalyOverrides: modKey -> picked candidate index as a string ('' or missing = still
  // unresolved) -- same convention as computeRulesToApply's own anomalyOverrides handling above.
  const unresolvedAnomalies = [];
  let resolvedAnomalyCount = 0;
  for (const a of analysis.anomalies) {
    const pick = anomalyOverrides ? anomalyOverrides[a.modKey] : undefined;
    const candidate = pick !== undefined && pick !== '' ? a.candidates[Number(pick)] : undefined;
    if (candidate) {
      resolvedAnomalyCount += 1;
    } else {
      unresolvedAnomalies.push({
        modKey: a.modKey,
        modName: displayName(modIndex.get(a.modKey)),
        candidateCount: a.candidateCount,
        candidates: a.candidates.map((c) => displayName(modIndex.get(c.targetKey))),
      });
    }
  }

  const leftoverOldInstalls = findLeftoverOldInstalls(modIndex, analysis.oldMembers, newMemberKeySet);

  return {
    oldCollection: analysis.oldCollection,
    newCollection: analysis.newCollection,
    completed,
    resolvedAnomalyCount,
    exceptions: {
      unresolvedAnomalies,
      leftoverOldInstalls,
    },
  };
}

// ---- Applying rules to Vortex's live database (Phase 2 write path). Reference shape and
// replace-vs-append semantics verified against Vortex's ACTUAL GitHub source (not inferred) -- see
// TECHNICAL.md's "Vortex's real rule-write mechanism" section: ConflictEditor.tsx's
// buildRuleActions() dispatches addModRule with a bare {id, versionMatch} reference (no idHint --
// that's added later by a separate cacheModReference action, not part of the write), and the
// addModRule reducer (reducers/mods.ts) treats before/after as one mutually-exclusive group
// (conflicts is its own singleton group), replacing an existing same-group same-target rule in
// place rather than appending a duplicate. ----

// Vortex's own grouping: before/after are mutually exclusive per target, conflicts stands alone.
function ruleGroup(type) {
  return type === 'before' || type === 'after' ? 'before-after' : type;
}

// The exact reference shape Vortex's own "Manage rules" dialog writes when linking two
// already-installed mods. No idHint (see header comment above) -- Rules Generator only ever links
// mods that are both already installed in the same new collection, so this bare id-only shape is
// the real mechanism here, not a fallback.
function buildRuleReference(targetModKey) {
  return { id: targetModKey, versionMatch: '*' };
}

// Given a mod's CURRENT rules array, adds/replaces one rule -- mirrors addModRule's reducer exactly
// (same group + same target => replace in place; otherwise append). Returns the new array plus
// whether anything actually changed (a true no-op if the exact same rule already exists).
function upsertRule(currentRules, type, targetModKey) {
  const group = ruleGroup(type);
  const idx = currentRules.findIndex(
    (r) => CONFLICT_RULE_TYPES.includes(r.type) && ruleGroup(r.type) === group && r.reference?.id === targetModKey,
  );
  if (idx !== -1 && currentRules[idx].type === type && currentRules[idx].reference?.id === targetModKey) {
    return { rules: currentRules, changed: false }; // already exactly this rule -- true no-op
  }
  const newRule = { type, reference: buildRuleReference(targetModKey) };
  if (idx !== -1) {
    const updated = currentRules.slice();
    updated[idx] = newRule;
    return { rules: updated, changed: true };
  }
  return { rules: [...currentRules, newRule], changed: true };
}

// Re-derives everything fresh from modIndex -- a client-held computed list (rgRuleOverrides/
// rgAnomalyOverrides from the browser) is never trusted for anything that touches the filesystem,
// same principle web/rebuild-routes.js's own header comment already states. ruleOverrides:
// `${newModKey}::${ruleIdx}` -> override type ('' = "???"/no rule). anomalyOverrides: modKey ->
// picked candidate index as a string ('' or missing = still unresolved, skipped entirely).
function computeRulesToApply(modIndex, oldCollectionKey, newCollectionKey, ruleOverrides, anomalyOverrides) {
  const result = analyzeCollections(modIndex, oldCollectionKey, newCollectionKey);
  const newMemberKeySet = new Set(result.newMembers.map((m) => m.modKey));
  const oldToNewMap = new Map(result.mapping.map((m) => [m.oldModKey, m.newModKey]));

  const toApply = []; // { newModKey, type, targetModKey }

  for (const item of result.mapping) {
    // ruleIdx MUST be computed the exact same way the UI does: filter out 'unresolved' rows FIRST,
    // then index the survivors (rgRenderReadyCard's own `resolvable` array in
    // rules-generator-app.js) -- indexing the raw unfiltered array here would silently apply every
    // override to the wrong row whenever a mod has any unresolved rule mixed in before a resolvable
    // one. Confirmed and fixed before this ever reached the UI.
    const resolvable = item.rulesToConsider.filter((r) => r.status !== 'unresolved');
    resolvable.forEach((r, ruleIdx) => {
      if (!r.targetKey) return;
      const overrideKey = `${item.newModKey}::${ruleIdx}`;
      const finalType = Object.prototype.hasOwnProperty.call(ruleOverrides || {}, overrideKey)
        ? ruleOverrides[overrideKey]
        : r.type;
      if (!finalType) return; // "???" override -- explicitly no rule, nothing to write
      toApply.push({ newModKey: item.newModKey, type: finalType, targetModKey: r.targetKey });
    });
  }

  // A resolved anomaly (user picked a real candidate, not "???") is, from here on, identical to an
  // unambiguous mapping -- same computeMappingDetails call, same rule set. No per-rule override
  // exists for these (the review UI only exposes "which candidate", not a per-rule type dropdown),
  // so every resulting rule is applied as computed.
  for (const item of result.anomalies) {
    const pick = anomalyOverrides ? anomalyOverrides[item.modKey] : undefined;
    if (pick === undefined || pick === '') continue; // still "???" -- unresolved, skip entirely
    const candidate = item.candidates[Number(pick)];
    if (!candidate) continue; // stale/invalid index -- ignore rather than throw
    const details = computeMappingDetails(modIndex, item.modKey, candidate.targetKey, null, newMemberKeySet, oldToNewMap);
    details.rulesToConsider.forEach((r) => {
      if (r.status === 'unresolved' || !r.targetKey) return;
      toApply.push({ newModKey: item.modKey, type: r.type, targetModKey: r.targetKey });
    });
  }

  return { toApply, analysis: result };
}

// The real write (or its dry-run preview). `db` is the caller's already-open handle -- a safe
// read-only copy (withStateDb, for dryRun) or the live, already-backed-up database (withLiveStateDb,
// for the real write). dryRun skips every db.put -- used by apply-preview to compute an accurate
// count without touching anything, same preview/write pairing Update Collection's own
// apply-ignores-preview/apply-ignores-write already establish.
async function applyRules(db, modIndex, oldCollectionKey, newCollectionKey, ruleOverrides, anomalyOverrides, { dryRun = false } = {}) {
  const { toApply } = computeRulesToApply(modIndex, oldCollectionKey, newCollectionKey, ruleOverrides, anomalyOverrides);

  // Group by newModKey FIRST, so getEffectiveRules (a full reverse-scan over EVERY mod Vortex has
  // ever tracked, across every collection -- not just these two) is computed once per MOD, not
  // once per RULE. Calling it per-triple was a real, confirmed-live performance bug: a mod needing
  // 23 rules did 23 full index scans instead of 1, and this scales with the size of the user's
  // entire Vortex library, not just this analysis -- exactly what made "Checking what would
  // change..." feel stuck rather than just quick.
  const triplesByMod = new Map(); // newModKey -> [{type, targetModKey}]
  for (const { newModKey, type, targetModKey } of toApply) {
    if (!triplesByMod.has(newModKey)) triplesByMod.set(newModKey, []);
    triplesByMod.get(newModKey).push({ type, targetModKey });
  }

  const byMod = new Map(); // newModKey -> [{type, targetModKey}] (post idempotency filter)
  let skippedAlreadyResolved = 0;
  for (const [newModKey, triples] of triplesByMod) {
    const effective = getEffectiveRules(modIndex, newModKey); // once per mod, not once per rule
    const toKeep = [];
    for (const { type, targetModKey } of triples) {
      // Idempotency, mirroring Vortex's own "???" meaning exactly: if this exact relationship is
      // ALREADY effectively resolved (either direction), there's nothing to write. An existing
      // DIFFERENT-direction resolution (e.g. new mod already has "before X" while the old mod's
      // copied rule says "after X") is deliberately left alone, not overwritten -- Vortex already
      // shows this as resolved (not "???"), and silently flipping an existing explicit decision
      // would be presumptuous. Checked against modIndex's snapshot from the start of this run.
      const alreadyResolved = effective.some((r) => {
        if (ruleGroup(r.type) !== ruleGroup(type)) return false;
        const rTargetKey = r.direction === 'own' ? resolveRefToModKey(modIndex, r.target) : r.owner;
        return rTargetKey === targetModKey;
      });
      if (alreadyResolved) skippedAlreadyResolved += 1;
      else toKeep.push({ type, targetModKey });
    }
    if (toKeep.length > 0) byMod.set(newModKey, toKeep);
  }

  const modsChanged = [];
  let totalRulesWritten = 0;
  for (const [newModKey, rulesToAdd] of byMod) {
    // Read fresh right before writing, same as writeIgnoredFlags/writeDisabledFlags already do --
    // don't rely on modIndex's possibly-stale copy for the actual mutation.
    const raw = await db.get(`persistent###mods###${GAME_ID}###${newModKey}###rules`);
    let currentRules = JSON.parse(raw);
    syncLib.assertRulesShapeKnown(currentRules, newModKey);

    let anyChanged = false;
    let rulesWrittenForMod = 0;
    for (const { type, targetModKey } of rulesToAdd) {
      const { rules: updatedRules, changed } = upsertRule(currentRules, type, targetModKey);
      currentRules = updatedRules;
      if (changed) { anyChanged = true; rulesWrittenForMod += 1; }
    }

    if (anyChanged) {
      if (!dryRun) {
        await db.put(`persistent###mods###${GAME_ID}###${newModKey}###rules`, JSON.stringify(currentRules));
      }
      totalRulesWritten += rulesWrittenForMod;
      modsChanged.push({ newModKey, name: displayName(modIndex.get(newModKey)), rulesWritten: rulesWrittenForMod });
    }
  }

  return {
    mods: modsChanged,
    totalRulesWritten,
    totalModsChanged: modsChanged.length,
    skippedAlreadyResolved,
  };
}

// ---- Conflicting files (mirrors Vortex's own "N conflicting file(s)" indicator on its Manage
// Rules page) -- pure filesystem work, no DB involved, so this runs directly in the web route
// rather than through the isolated DB worker. Vortex's own deployment is case-insensitive
// (Windows/NTFS), so paths are compared lowercased; the returned list keeps mod A's original
// casing for display. ----

function listFilesRecursive(dir) {
  const results = [];
  function walk(current, relBase) {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return; // folder missing/unreadable (e.g. mod uninstalled since) -- treat as no files
    }
    for (const entry of entries) {
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(current, entry.name), rel);
      else if (entry.isFile()) results.push(rel);
    }
  }
  walk(dir, '');
  return results;
}

function computeConflictingFiles(stagingRoot, installationPathA, installationPathB) {
  if (!stagingRoot || !installationPathA || !installationPathB) return [];
  const filesA = listFilesRecursive(path.join(stagingRoot, installationPathA));
  const bByLowercase = new Map();
  for (const f of listFilesRecursive(path.join(stagingRoot, installationPathB))) {
    bByLowercase.set(f.toLowerCase(), f);
  }
  return filesA.filter((f) => bByLowercase.has(f.toLowerCase())).sort((a, b) => a.localeCompare(b));
}

module.exports = {
  buildModIndex,
  refMatchesEntry,
  resolveRefToModKey,
  entryToReference,
  invertType,
  getEffectiveRules,
  getCollectionMembers,
  findCollectionByName,
  getOldModRulesFromCollectionJson,
  getOldModRuleSet,
  findNewCollectionCounterpart,
  normalizeModName,
  displayName,
  namesLikelyMatch,
  resolvedCopyableRules,
  computeMappingDetails,
  analyzeCollections,
  findLeftoverOldInstalls,
  computeReportData,
  computeConflictingFiles,
  ruleGroup,
  buildRuleReference,
  upsertRule,
  computeRulesToApply,
  applyRules,
  CONFLICT_RULE_TYPES,
  MEMBERSHIP_RULE_TYPES,
};
