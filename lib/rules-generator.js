'use strict';
// Rules Generator, Phase 1: data collection and validation only. No UI, no writes, no rule
// application -- see TECHNICAL.md's "Rules Generator (Phase 1 research)" section for the full
// design rationale and everything confirmed against real data + Vortex's own source before this
// was written. Read that section before changing any of the matching logic below.

const fs = require('fs');
const path = require('path');
const syncLib = require('./vortex-sync/lib');
const anomalyMemoryStore = require('./rules-generator-anomaly-memory');

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
    } else if (field === 'attributes###version') {
      // Not read here before 2026-08-16 -- only state-query-worker.js's own buildModVersionIndex read
      // this field, for a different purpose. Added for disambiguateCandidateNames (below): two
      // genuinely different mod installs (real, separate modKeys -- a re-installed duplicate, or two
      // distinct Nexus files) can share the exact same display name, and version is the first,
      // cheapest real distinguishing signal available to tell them apart in a candidate list.
      try { entry.version = JSON.parse(value); } catch { /* ignore */ }
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

  // Enabled/disabled state (2026-08-16) -- which mods are enabled in Vortex's CURRENT active
  // profile for this game. Needed so a rule whose TARGET is currently disabled can be recognized
  // as not-actually-real (Vortex wouldn't apply it right now) rather than proposed as ordinary
  // copyable work -- director's own real find: "Northern Roads - Fixes and Optimization" carries a
  // real, current rule against Faultier's PBR Landscapes, but the mod itself has never been
  // enabled, which is why it doesn't show anywhere in Vortex's own Manage Rules dialog. Same source
  // Cycle Helper already uses for an analogous "only enabled mods are real" scoping decision (see
  // syncLib.getEnabledModKeys' own header comment -- matches Vortex's real sortMods scoping
  // exactly: getSafe(profile.modState, [mod.id, 'enabled'], false)). If the active profile can't be
  // determined at all (no profile ever selected for this game), entry.enabled is left `undefined`
  // on every entry rather than defaulting to false -- an unknown profile must never be read as
  // "everything is disabled".
  const profileId = await syncLib.getLastActiveProfileId(db);
  if (profileId) {
    const enabledModKeys = new Set(await syncLib.getEnabledModKeys(db, profileId));
    for (const entry of index.values()) {
      entry.enabled = enabledModKeys.has(entry.modKey);
    }
  }

  return index;
}

// Live-data equivalent of buildModIndex above (2026-08-18) -- sourced from the optional Vortex
// Collection Helper extension's `GET /mods` response (lib/vortex-helper-client.js) instead of a
// state.v2 LevelDB iteration, so Cycle Helper's Snapshot/Scan can work with Vortex still OPEN (see
// lib/cycle-helper-runner.js's snapshotViaHelper/scanViaHelper). Produces the IDENTICAL
// Map<modKey, entry> shape buildModIndex does -- same field names on every entry -- just reading
// them from the extension's real, NESTED Redux `IMod` shape (`mod.attributes.modId`, etc) instead of
// buildModIndex's own flattened `attributes###modId` LevelDB keys. Confirmed against a real /mods
// response (2026-08-18, a 4,555-mod install): nesting is the only structural difference -- every
// field buildModIndex captures exists at the equivalent nested path here (`mod.type`,
// `mod.installationPath`, `mod.rules`, `mod.attributes.{modId,fileId,version,fileMD5,
// customFileName,logicalFileName,name,collectionSlug}`). `enabledModKeys` comes straight from the
// extension's own /mods response (it already resolved the active profile itself), so unlike
// buildModIndex this never needs its own separate profile/getEnabledModKeys lookup.
function buildModIndexFromLiveData(mods, enabledModKeys) {
  const index = new Map();
  const enabledSet = new Set(enabledModKeys || []);
  for (const modKey of Object.keys(mods || {})) {
    const mod = mods[modKey] || {};
    const attrs = mod.attributes || {};
    index.set(modKey, {
      modKey,
      type: mod.type,
      installationPath: mod.installationPath,
      rules: mod.rules || [],
      modId: attrs.modId,
      fileId: attrs.fileId,
      version: attrs.version,
      fileMD5: attrs.fileMD5,
      customFileName: attrs.customFileName,
      logicalFileName: attrs.logicalFileName,
      name: attrs.name,
      collectionSlug: attrs.collectionSlug,
      enabled: enabledSet.has(modKey),
    });
  }
  return index;
}

// ---- Reference matching (simplified testModReference -- see TECHNICAL.md for the real fields this
// mirrors and, critically, the CONTROL FLOW: re-verified against Vortex's actual
// testModReference.ts 2026-08-16 after a real false-positive-cycle bug report, and it is an
// AND-chain of constraints, NOT a fallback/priority chain. Every field PRESENT on a reference is a
// REQUIRED match -- if `ref.fileMD5` is set and doesn't match the candidate, testRef hard-fails
// immediately (`if (truthy(ref.fileMD5) && !fuzzyVersion && mod.fileMD5 !== ref.fileMD5) return
// false`) and never even reaches its own logicalFileName/fileExpression checks. The ORIGINAL
// version of this function got this backwards: it checked fileMD5 first, but on a mismatch fell
// through to try logicalFileName/fileExpression/id as independent alternatives instead of failing
// outright -- so a rule pinned to an OLD, uninstalled file version (fileMD5 for a version no longer
// present, but logicalFileName shared with whatever's CURRENTLY installed under that name) got
// wrongly resolved to the current install, fabricating graph edges -- and therefore cycles -- that
// Vortex's own real matcher never produces for that same data. Confirmed live 2026-08-16 (Cycle
// Helper false-positive bug report): two stale, old-version-pinned rules on "Hvergelmir Brows"
// resolved to the CURRENT "ESLified Patches" install under the old fallback logic, fabricating a
// cycle Vortex itself does not report; under this corrected AND-chain logic they correctly fail to
// resolve to anything (their pinned fileMD5 doesn't exist anymore) and drop out of the graph
// entirely, exactly matching Vortex's real behavior. Does NOT implement fileExpression's minimatch
// glob fallback or Vortex's tag-based matching -- still a deliberate, documented simplification,
// just now correct about WHICH fields short-circuit and WHICH ones must all agree together. ----

function refMatchesEntry(ref, entry) {
  if (!ref || typeof ref !== 'object' || !entry) return false;

  // `id`/`idHint`, when present, is Vortex's own strictest and unconditionally-enforced field
  // (testRef's very first gate: `if (ref.id != null && ... && ref.id !== modId) return false`) --
  // it must equal the candidate's own modKey, full stop, checked before anything else.
  if (ref.id != null && ref.id !== entry.modKey) return false;

  // At least one field must be present that could plausibly identify SOME mod (mirrors
  // hasIdentifyingMarker) -- otherwise every candidate would trivially "match" a reference with
  // nothing real to check.
  const hasMarker =
    ref.id != null || ref.fileMD5 != null || ref.fileExpression != null ||
    ref.logicalFileName != null || ref.repo?.modId != null;
  if (!hasMarker) return false;

  // fileMD5, when present, is a hard constraint -- a mismatch fails the WHOLE reference outright,
  // it does not fall through to try matching some other way.
  if (ref.fileMD5 != null && entry.fileMD5 != null && ref.fileMD5 !== entry.fileMD5) return false;

  // repo.modId(+fileId), when present, is a hard constraint -- a different mod page, or the same
  // page but a different file, both fail outright rather than falling through to weaker checks.
  if (ref.repo?.modId != null) {
    if (entry.modId == null || String(ref.repo.modId) !== String(entry.modId)) return false;
    if (ref.repo.fileId != null && entry.fileId != null && String(ref.repo.fileId) !== String(entry.fileId)) {
      return false;
    }
  }

  // logicalFileName, when present, is a hard constraint too -- UNLESS fileExpression is ALSO set,
  // in which case Vortex defers entirely to fileExpression's own check below instead (testRef's own
  // `ref.fileExpression == null` carve-out on this exact gate).
  if (ref.logicalFileName != null && ref.fileExpression == null) {
    const matches = ref.logicalFileName === entry.logicalFileName || ref.logicalFileName === entry.customFileName;
    if (!matches) return false;
  }

  // fileExpression, when present, is a hard constraint -- this project's own simplified exact/
  // prefix match against modKey (no minimatch glob support, a documented, deliberate scope
  // limitation, unchanged from before).
  if (ref.fileExpression != null && entry.modKey != null) {
    const matches = entry.modKey === ref.fileExpression || entry.modKey.startsWith(`${ref.fileExpression}-`);
    if (!matches) return false;
  }

  // Every field actually present on the reference passed its own check above (id already
  // confirmed equal, if set) -- this is a match.
  return true;
}

function resolveRefToModKey(modIndex, ref) {
  if (!ref) return undefined;
  // refMatchesEntry's very first gate requires ref.id (when present) to equal the candidate's own
  // modKey exactly, unconditionally -- so when ref.id is set, modIndex.get(ref.id) is the ONLY
  // entry that could possibly match; every other entry fails that gate immediately regardless of
  // any other field. Short-circuits to an O(1) Map lookup instead of a full linear scan for this
  // (by far the most common -- this app's own writes are always id-only) case. Added 2026-08-16:
  // a real performance need once poolRuleLinks (analyzeCollections) started resolving references
  // for EVERY pool member's full rules array, not just a small "new-only" set -- some mods carry
  // 100+ rules, and a full ~4,500-entry linear scan per rule multiplied into real, measured slowness.
  if (ref.id != null) return refMatchesEntry(ref, modIndex.get(ref.id)) ? ref.id : undefined;
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
// stagingRoot/fileListCache: threaded through for the no-current-conflict check below (see its own
// comment) -- stagingRoot is `config.staging` (null when unconfigured, in which case the check is
// skipped entirely, same "can't verify, don't filter" fallback computeFamilyInference already uses).
function computeMappingDetails(modIndex, newModKey, oldModKey, linkRule, newMemberKeySet, oldToNewMap, stagingRoot = null, fileListCache = null) {
  const ruleSet = getOldModRuleSet(modIndex, oldModKey, null, null);
  // A rule whose target reference doesn't resolve to ANY mod in Vortex's CURRENT live data is a
  // stale/orphaned entry, not a real current rule -- confirmed real 2026-08-15 against two live
  // repro mods (Praedy's College of Winterhold 2K, Exist's Caves PBR - 2k): both phantom
  // references pointed at a mod since uninstalled or swapped for a different file variant of the
  // same Nexus page (same modId, different fileId/timestamp), genuinely absent from modIndex under
  // every strategy refMatchesEntry tries -- not a matching bug here, verified by directly querying
  // the live DB for the reference's fileMD5/logicalFileName/fileExpression/modId and finding
  // nothing. Vortex's own "Manage rules" dialog already silently omits these (confirmed live,
  // side-by-side against this app's report for both repro mods); this app's own raw scan didn't,
  // surfacing them as a misleading "(unknown)" target instead. Dropped entirely here -- before
  // EITHER downstream consumer (rulesToConsider, oldModRules) ever sees them -- rather than kept
  // and merely labeled, per the director's own explicit correction: a genuinely unresolvable
  // reference isn't a countable/actionable item at all. Only 'own'-direction rules can hit this
  // (a 'reverse' rule's targetKey is always its owner's own real modKey, never unresolved, by
  // construction -- see resolvedCopyableRules above). A REAL, current rule whose target simply has
  // no counterpart in the NEW collection ('no-counterpart' status below) is a different, still-real
  // case and stays visible -- this filter never touches that one.
  const copyable = resolvedCopyableRules(modIndex, ruleSet, newModKey).filter((r) => r.targetKey != null);
  const rulesToConsider = copyable.map((r) => {
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

  // A rule whose target is currently DISABLED in Vortex's active profile isn't real, actionable
  // work (2026-08-16) -- director's own live find: "before Better Dynamic Snow SE" and "before
  // Northern Roads - Fixes and Optimization" both showed as "Ready to copy" for Faultier's PBR
  // Landscapes 4k, but neither appeared anywhere in Vortex's own Manage Rules dialog for either the
  // 2k or 4k mod. Confirmed live: Northern Roads - Fixes and Optimization has never been enabled
  // (Status: Disabled, "Enabled Time: Never") -- Vortex's own conflict-driven dialog correctly never
  // lists a disabled mod, since it wouldn't deploy any files or affect load order right now. Pulled
  // OUT of rulesToConsider into its own bucket here -- NOT simply dropped -- so the exception report
  // can still surface "we found this real rule, but its target is off, so we didn't set it",
  // distinct from a reference that doesn't resolve to anything at all (already handled above, before
  // `copyable` is even built). Checks `!== false` (not falsy) -- `entry.enabled` is `undefined` when
  // the active profile couldn't be determined (buildModIndex's own comment), in which case this must
  // be a no-op, not a wrongful "everything is disabled".
  const skippedDisabledRules = [];
  const enabledFilteredRulesToConsider = dedupedRulesToConsider.filter((r) => {
    if (modIndex.get(r.targetKey)?.enabled !== false) return true;
    skippedDisabledRules.push({ type: r.type, targetKey: r.targetKey });
    return false;
  });

  // A rule whose target has ZERO current file conflicts with newModKey isn't practically actionable
  // right now either (2026-08-16, same investigation as the disabled-target check above) --
  // director's own live find: "before Better Dynamic Snow SE" showed as "Ready to copy" for
  // Faultier's PBR Landscapes 4k, but that mod has 0 conflicting files with either the 2k or 4k
  // Landscapes variant (confirmed via computeConflictingFiles, the SAME per-row check the UI already
  // displays) -- Vortex's own conflict-driven Manage Rules dialog would never surface it, so copying
  // it does nothing wrong but also nothing useful. Pulled into its own bucket, NOT dropped, same
  // "still real, just not actionable right now" treatment as skippedDisabledRules. Only ever runs
  // when stagingRoot is configured AND both mods have a known installationPath -- hasAnyConflict
  // returns `null` (not `false`) whenever it can't actually check, and `null` never filters anything
  // out, matching computeFamilyInference's own "can't verify, don't touch" fallback.
  const newModPath = modIndex.get(newModKey)?.installationPath;
  const skippedNoConflictRules = [];
  const conflictFilteredRulesToConsider = enabledFilteredRulesToConsider.filter((r) => {
    if (!stagingRoot || !fileListCache) return true;
    const targetPath = modIndex.get(r.targetKey)?.installationPath;
    if (hasAnyConflict(stagingRoot, newModPath, targetPath, fileListCache) !== false) return true;
    skippedNoConflictRules.push({ type: r.type, targetKey: r.targetKey });
    return false;
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
    rulesToConsider: conflictFilteredRulesToConsider,
    skippedDisabledRules,
    skippedNoConflictRules,
    oldModRules,
  };
}

// ---- Candidate name disambiguation (2026-08-16) -- confirmed real, live: two candidates in the SAME
// list can be genuinely DIFFERENT mod installs (different modKeys -- a duplicate/re-installed copy,
// or two distinct Nexus files) that happen to share the identical display name. Director's own real
// repro: "Exist's Caves PBR - 4k -- could match more than one mod: Exist's Caves PBR - 2k, Exist's
// Caves PBR - 2k" -- two candidates, same rendered name, zero way to tell them apart, worst of all in
// the LIVE anomaly picker where a wrong blind pick writes a rule to the wrong mod.
//
// This is NOT the same thing as analyzeCollections' own seenTargets de-dupe (above) -- that collapses
// the SAME relationship discovered twice (own + reverse direction), which is correct to hide. This is
// the opposite case: a real, ambiguous choice the user has to make correctly, so it must never be
// hidden, only made distinguishable.
//
// Only disambiguates candidates that actually COLLIDE on display name -- every other, non-ambiguous
// case renders exactly as clean as before. Tries version first (buildModIndex, added alongside this
// -- the common case for a re-downloaded/updated duplicate), then fileId, then a short modKey suffix,
// escalating only if the previous tier still doesn't fully separate every key in that collision group
// (e.g. version is ALSO identical, or missing on one side).
//
// Shared by both places a candidate list is rendered (the separate Report tab's computeReportData,
// and analyzeCollections' own live anomalies -- consumed directly by the in-app picker,
// rgRenderAnomalyItem) so the two layers can never drift into disagreeing labels for the same data.
function disambiguateCandidateNames(modIndex, targetKeys) {
  const labels = new Map();
  const byName = new Map(); // display name -> [targetKey,...]
  for (const targetKey of targetKeys) {
    const name = displayName(modIndex.get(targetKey));
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(targetKey);
  }

  for (const [name, keys] of byName) {
    if (keys.length === 1) {
      labels.set(keys[0], name);
      continue;
    }
    const tiers = [
      (k) => { const v = modIndex.get(k)?.version; return v ? `v${v}` : null; },
      (k) => { const f = modIndex.get(k)?.fileId; return f != null ? `file ${f}` : null; },
      (k) => k.slice(-8),
    ];
    let suffixes = new Map(keys.map((k) => [k, null]));
    for (const tier of tiers) {
      const candidate = new Map(keys.map((k) => [k, tier(k)]));
      const values = [...candidate.values()];
      const allDistinctAndPresent = values.every((v) => v != null) && new Set(values).size === values.length;
      if (allDistinctAndPresent) { suffixes = candidate; break; }
    }
    for (const k of keys) {
      const suffix = suffixes.get(k);
      labels.set(k, suffix ? `${name} (${suffix})` : name);
    }
  }

  return labels;
}

// The full Phase 1/2 pipeline in one place -- single source of truth shared by
// rules-generator-cli.js and the web route/worker, so the CLI and the UI can never silently
// disagree about what counts as a match. See TECHNICAL.md's "Rules Generator" section for the
// full rationale behind every step here (bidirectional rules, DB-primary/collection.json
// fallback, the required name-similarity gate, the shared-modId counterpart fallback).
//
// Returns a plain-data structure (no functions, JSON-serializable) so it can cross a child-process
// boundary (the isolated DB-access worker) or an HTTP response unchanged.
//
// anomalyMemory: the {choices: {...}} shape rulesGeneratorAnomalyMemory.loadAnomalyChoices() returns
// (default {} -- callers that don't care about remembered picks, e.g. a synthetic test fixture, get
// today's plain "always ask" behavior). Loaded ONCE by the caller (the worker, typically) and passed
// in here rather than read from disk inside this function itself -- same "everything passed in"
// shape ruleOverrides/anomalyOverrides/relationshipOverrides already establish elsewhere in this
// file, never re-derived here.
//
// stagingRoot (2026-08-16, `config.staging`, null when unconfigured): threaded straight through to
// every computeMappingDetails call below for its own no-current-conflict check (see that function's
// own comment). This DOES mean analyzeCollections can now touch the filesystem (via
// computeMappingDetails -> hasAnyConflict), a deliberate departure from computeFamilyInference/
// computeRelationshipCandidates' own "filesystem work only in the route layer, analyzeCollections
// itself never touches disk" convention -- necessary here because, unlike those two (purely
// additive, advisory-only fields), this filter has to change what's actually WRITTEN by a real
// Apply, not just what's displayed, so it has to run wherever computeRulesToApply/applyRules do (the
// isolated DB worker), not as a separate route-layer pass after the fact. A single memoized
// `fileListCache` (Map), created once per call, is shared across every computeMappingDetails call
// this function makes -- see hasAnyConflict's own header comment for why that matters.
function analyzeCollections(modIndex, oldCollectionKey, newCollectionKey, anomalyMemory = { choices: {} }, stagingRoot = null) {
  const fileListCache = new Map();
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
    const targetKeyOf = (r) => (r.direction === 'own' ? resolveRefToModKey(modIndex, r.target) : r.owner);
    const rawCandidates = effective.filter((r) => oldMemberKeys.has(targetKeyOf(r)));
    // Required gate, not just a tie-breaker: a candidate whose name doesn't resemble the new
    // mod's own name is rejected outright, even when it's the ONLY candidate.
    const nameMatchedCandidates = rawCandidates.filter((r) =>
      namesLikelyMatch(displayName(newEntry), displayName(modIndex.get(targetKeyOf(r)))),
    );
    // De-dupe by resolved target BEFORE counting -- getEffectiveRules deliberately returns BOTH the
    // 'own' half of a relationship AND the 'reverse' half discovered from the other mod's own rules
    // (see its own header comment); once a relationship is written on BOTH sides (Step 1's
    // Relationship Check dual-write, or any other rule genuinely reciprocated in Vortex), the SAME
    // real link surfaces as TWO separate entries here, one per direction. Without this de-dupe, a
    // single clean link would count as 2 "candidates" and get wrongly bucketed as an ambiguous
    // anomaly. Confirmed real 2026-08-16: 9 mods with a freshly dual-written, fully-resolved
    // relationship flipped from a clean single mapping into a false "2 possible matches" anomaly the
    // moment their reciprocal side got written, purely from this miscount, not a real ambiguity.
    const seenTargets = new Set();
    const candidates = nameMatchedCandidates.filter((r) => {
      const t = targetKeyOf(r);
      if (seenTargets.has(t)) return false;
      seenTargets.add(t);
      return true;
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
      const candidateTargetKeys = candidates.map((c) => (c.direction === 'own' ? resolveRefToModKey(modIndex, c.target) : c.owner));

      // Remembered-choice check (2026-08-16) -- director's own real find: EVERY candidate here
      // already has a real, current rule against newModKey (that's the only way it became a
      // candidate in the first place -- see rawCandidates above), so "does a rule already exist"
      // can never distinguish "already decided by a human" from "still genuinely ambiguous", it's
      // true for all of them, always. The only reliable signal is remembering the actual pick, made
      // once via the anomaly picker (persisted on a real Apply -- see applyRules' own comment), and
      // replaying it here instead of asking again. Matched on BOTH targetKey AND type -- a rule that
      // changed since the pick was recorded (e.g. the old collection's own rule flipped
      // before->after) must NOT be silently trusted; it falls through to a normal anomaly below,
      // flagged with `previousChoice` so the picker can show what changed instead of asking cold.
      const remembered = anomalyMemoryStore.getAnomalyChoice(anomalyMemory, oldCollectionKey, newCollectionKey, newModKey);
      const rememberedIdx = remembered ? candidateTargetKeys.indexOf(remembered.targetKey) : -1;
      if (remembered && rememberedIdx !== -1 && candidates[rememberedIdx].type === remembered.type) {
        mapping.push({ newModKey, oldModKey: remembered.targetKey, linkRule: candidates[rememberedIdx].raw });
        continue;
      }

      // Disambiguates ONLY when two+ candidates in THIS mod's own list collide on display name (see
      // disambiguateCandidateNames' own header comment) -- consumed directly by the live in-app
      // picker (rgRenderAnomalyItem), not just the separate Report tab.
      const targetLabels = disambiguateCandidateNames(modIndex, candidateTargetKeys);
      anomalies.push({
        modKey: newModKey,
        candidateCount: candidates.length,
        candidates: candidates.map((c, i) => ({
          targetKey: candidateTargetKeys[i],
          type: c.type,
          targetLabel: targetLabels.get(candidateTargetKeys[i]),
        })),
        // Present only when a previously-recorded pick still names one of today's candidates, but
        // that candidate's own type has since changed -- e.g. the old collection's rule flipped
        // before->after after the pick was made. `null` (not omitted) when nothing was ever
        // recorded, so the frontend can tell "never picked" apart from "picked, still matches"
        // (the latter never reaches here at all -- it's promoted to mapping above) with one field.
        previousChoice: remembered && rememberedIdx !== -1 ? { targetKey: remembered.targetKey, type: remembered.type } : null,
      });
    }
  }

  const oldToNewMap = new Map(mapping.map((m) => [m.oldModKey, m.newModKey]));
  const mappingDetails = mapping.map(({ newModKey, oldModKey, linkRule }) =>
    computeMappingDetails(modIndex, newModKey, oldModKey, linkRule, newMemberKeySet, oldToNewMap, stagingRoot, fileListCache),
  );

  // "Incomplete" links -- a mapping already exists (analyzeCollections found a real rule-based
  // candidate above), but that rule only lives on ONE mod's own `rules` array, not both. Director's
  // own framing, confirmed live 2026-08-16: "a good relationship is only when both sides have a rule
  // against the other" -- matches what was independently found tracing Vortex's real
  // ConflictEditor.tsx source (getRuleSpec only reliably finds a rule that lives on the CURRENTLY-
  // OPEN mod's own rules array; the other side depends on a separate, cached, easy-to-miss
  // cross-mod list). This app's own candidate-matching (getEffectiveRules, above) is deliberately
  // bidirectional-tolerant -- a rule on EITHER side is enough to count as "linked" for copying rules
  // between collections -- but Vortex's own dialog needs BOTH sides literally written to reliably
  // display as resolved regardless of which mod's dialog is opened. Real repro, confirmed live: 4K
  // had a literal "after 2K" rule; 2K had nothing back -- Vortex's dialog, opened for 2K, showed
  // "???" despite the relationship being fully valid from this app's own (correct) perspective. ----
  const incompleteLinks = computeIncompleteLinks(modIndex, mappingDetails);

  // ---- poolRuleLinks (2026-08-16): every RESOLVED conflict-type rule where BOTH ends are pool
  // members (new+old collection members, deduped -- the exact same pool computeRelationshipCandidates
  // already builds and its own header comment explains in full: real Vortex conflicts aren't scoped
  // to collection membership at all). Computed HERE, not in the route layer, because resolving a raw
  // rule reference to a real modKey needs modIndex, which the route layer never has (see the
  // isolated-DB-worker architecture note above computeRelationshipCandidates). Feeds
  // computeFamilyInference (family-pattern inference, added 2026-08-16) with everything it needs to
  // find cross-family evidence and already-resolved pairs WITHOUT ever touching modIndex itself --
  // same "resolve inside analyzeCollections, consume as plain data outside it" split
  // installationPaths already established for the filesystem-conflict half.
  const poolKeys = new Set([...newMembers.members.map((m) => m.modKey), ...oldMembers.members.map((m) => m.modKey)]);
  const poolRuleLinks = [];
  for (const sourceKey of poolKeys) {
    const entry = modIndex.get(sourceKey);
    for (const r of entry?.rules || []) {
      if (!CONFLICT_RULE_TYPES.includes(r.type)) continue;
      const targetKey = resolveRefToModKey(modIndex, r.reference);
      if (!targetKey || targetKey === sourceKey || !poolKeys.has(targetKey)) continue;
      poolRuleLinks.push({ sourceKey, targetKey, type: r.type });
    }
  }

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
    incompleteLinks,
    poolRuleLinks,
    installationPaths,
  };
}

// For each already-confirmed mapping (newModKey <-> oldModKey), checks whether BOTH mods have a
// LITERAL conflict-type rule pointing at the other -- not just "effectively resolved" via
// getEffectiveRules' reverse-scan (that's what mapping/candidate-matching above already uses, on
// purpose, since it's the right check for "is there a rule relationship to copy"). This is a
// stricter, different question: "will Vortex's OWN 'Manage rules' dialog show this as resolved no
// matter which of the two mods' dialog gets opened" -- see this function's own caller (above) for
// the full rationale. Returns one entry per pair missing exactly one side; a pair missing BOTH
// sides can't happen here (mapping already requires at least one real rule to exist), and a pair
// with both sides already literal is fully resolved -- skipped entirely.
function computeIncompleteLinks(modIndex, mapping) {
  const results = [];
  for (const m of mapping) {
    const newEntry = modIndex.get(m.newModKey);
    const oldEntry = modIndex.get(m.oldModKey);
    if (!newEntry || !oldEntry) continue;
    const ownRule = (newEntry.rules || []).find(
      (r) => CONFLICT_RULE_TYPES.includes(r.type) && refMatchesEntry(r.reference, oldEntry),
    );
    const reverseRule = (oldEntry.rules || []).find(
      (r) => CONFLICT_RULE_TYPES.includes(r.type) && refMatchesEntry(r.reference, newEntry),
    );
    if ((ownRule && reverseRule) || (!ownRule && !reverseRule)) continue; // both literal, or neither (shouldn't happen -- mapping implies at least one) -- nothing to flag
    // Whichever side already has the literal rule is authoritative -- the fix is always "write the
    // SAME relationship, from the OTHER mod's own perspective" on the missing side, never a guess.
    const known = ownRule || reverseRule;
    const fix = ownRule
      ? { fixModKey: m.oldModKey, fixTargetKey: m.newModKey, fixType: invertType(known.type) }
      : { fixModKey: m.newModKey, fixTargetKey: m.oldModKey, fixType: invertType(known.type) };
    results.push({ newModKey: m.newModKey, oldModKey: m.oldModKey, ...fix });
  }
  return results;
}

// ---- Family-pattern inference (2026-08-16) -- the real payoff, director's own words: "if we solve
// this, we are golden." Step 1's own direct pass (computeIncompleteLinks + the 'missing' half below)
// only ever links mods that ARE the same product (namesLikelyMatch after stripping the 1k/2k/4k/8k
// size token). It never looks at CROSS-family conflicts -- two genuinely DIFFERENT mods that each
// ship multiple resolution tiers and happen to conflict with each other. Real repro, confirmed live:
// "Exist's Caves PBR" and "Faultier's PBR Landscapes" each ship 2k/4k variants. The SAME-tier
// cross-family pairs (4k<->4k, 2k<->2k) already have a rule (author-provided or Vortex's own
// same-tier suggestion) -- but the MISMATCHED-tier pairs (Exist's-2k<->Faultier's-4k and its mirror)
// stay "???" forever, because neither Vortex's own suggestion engine nor this tool's own direct pass
// ever proposes anything for a tier mismatch. Director's own framing of the fix: look at what's
// already KNOWN about how these two families relate (their OTHER, same-tier pairs), and if every
// known pair agrees on direction, apply that same direction to the missing pair.
//
// "Family" reuses normalizeModName exactly as-is (the SIZE_TOKEN regex already strips 1k/2k/4k/8k) --
// no new grouping logic. Evidence pool is analysis.poolRuleLinks -- the SAME new+old, deduped pool
// computeRelationshipCandidates' own 'missing' half already uses (see its own header comment for why
// old-collection-only members have to be included: Vortex's real conflict detection isn't scoped to
// collection membership at all).
//
// SAFETY RULE (the most important part, mirrors computeMappingDetails' own "Confirmed with the user
// 2026-07-26" counterpart-remap precedent): only infer when EVERY known same-family-pair between
// family A and family B agrees on direction. Zero evidence -> nothing to infer from, left alone
// (stays "???", unchanged from today). Disagreeing evidence -> never guessed between two conflicting
// signals; surfaced as its own 'ambiguous' kind for a manual pick instead, reusing the exact same
// card UI as 'missing'/'incomplete'.
//
// A pair already having ANY rule (either direction, even just one-sided/"incomplete") is treated as
// resolved and left alone here -- this pass's job is strictly "genuinely ??? cross-family pairs",
// matching the director's own explicit scope. A cross-family pair that's incomplete (one side only)
// is a real, currently out-of-scope gap this pass doesn't touch -- computeIncompleteLinks only
// covers the SAME-family (mapping-derived) case today; flagged here as a known limitation, not
// silently expanded into.
//
// Writes reuse the EXACT SAME mechanism as every other Step 1 fix -- an 'inferred' entry becomes
// `relationshipOverrides[modKeyA] = {targetKey: modKeyB, type}` on the frontend (auto-filled, same
// "confident default" precedent 'incomplete' already established), which computeRulesToApply's own
// relationshipOverrides loop (below) already dual-writes with forceLiteral. No new write path.
function computeFamilyInference(analysis, stagingRoot) {
  if (!stagingRoot) return { inferred: [], ambiguous: [] };

  const nameByKey = new Map();
  for (const m of analysis.newMembers) nameByKey.set(m.modKey, m.name);
  for (const m of analysis.oldMembers) if (!nameByKey.has(m.modKey)) nameByKey.set(m.modKey, m.name);

  const familyOf = new Map(); // modKey -> normalized family key
  const membersByFamily = new Map(); // family key -> [modKey]
  for (const [modKey, name] of nameByKey) {
    const fam = normalizeModName(name);
    if (!fam) continue;
    familyOf.set(modKey, fam);
    if (!membersByFamily.has(fam)) membersByFamily.set(fam, []);
    membersByFamily.get(fam).push(modKey);
  }

  const pairKey = (a, b) => (a < b ? `${a}::${b}` : `${b}::${a}`);

  // Every pool-to-pool pair that already has SOME rule (either direction) -- resolved, not this
  // pass's concern (see header comment on the incomplete-cross-family limitation).
  const resolvedPairs = new Set();
  for (const link of analysis.poolRuleLinks || []) resolvedPairs.add(pairKey(link.sourceKey, link.targetKey));

  // Cross-family evidence, grouped by sorted family-pair key. Same-family links are deliberately
  // excluded (famSource === famTarget) -- that's Step 1's own direct pass's job, a different axis.
  const evidenceByFamPair = new Map();
  for (const link of analysis.poolRuleLinks || []) {
    const famSource = familyOf.get(link.sourceKey);
    const famTarget = familyOf.get(link.targetKey);
    if (!famSource || !famTarget || famSource === famTarget) continue;
    // Normalize direction to "famLo -> type -> famHi" so every evidence entry for this family-pair
    // is directly comparable regardless of which member/direction it was originally found from.
    const [famLo, famHi, dirFromLo] =
      famSource < famTarget ? [famSource, famTarget, link.type] : [famTarget, famSource, invertType(link.type)];
    const key = `${famLo}::${famHi}`;
    if (!evidenceByFamPair.has(key)) evidenceByFamPair.set(key, []);
    evidenceByFamPair.get(key).push({ ...link, direction: dirFromLo });
  }

  const inferred = [];
  const ambiguous = [];
  const seenPairs = new Set(); // a pair only ever needs evaluating once even if reachable via multiple evidence family-pairs

  for (const [famPairKey, entries] of evidenceByFamPair) {
    const [famLo, famHi] = famPairKey.split('::');
    const directions = new Set(entries.map((e) => e.direction));
    const membersLo = membersByFamily.get(famLo) || [];
    const membersHi = membersByFamily.get(famHi) || [];

    for (const keyLo of membersLo) {
      for (const keyHi of membersHi) {
        const pk = pairKey(keyLo, keyHi);
        if (seenPairs.has(pk)) continue;
        seenPairs.add(pk);
        if (resolvedPairs.has(pk)) continue; // already has a rule, either direction -- not "???"

        // Same real-conflict gate the 'missing' half already requires -- never flag a pair with
        // nothing actually wrong just because the families happen to be pattern-linked elsewhere.
        const pathLo = analysis.installationPaths[keyLo];
        const pathHi = analysis.installationPaths[keyHi];
        if (!pathLo || !pathHi) continue;
        const files = computeConflictingFiles(stagingRoot, pathLo, pathHi);
        if (files.length === 0) continue;

        const evidenceOut = entries.map((e) => ({
          sourceKey: e.sourceKey,
          sourceName: nameByKey.get(e.sourceKey) || e.sourceKey,
          targetKey: e.targetKey,
          targetName: nameByKey.get(e.targetKey) || e.targetKey,
          type: e.type,
        }));

        if (directions.size === 1) {
          inferred.push({
            modKeyA: keyLo,
            nameA: nameByKey.get(keyLo) || keyLo,
            modKeyB: keyHi,
            nameB: nameByKey.get(keyHi) || keyHi,
            type: entries[0].direction, // keyLo -> type -> keyHi
            conflictCount: files.length,
            evidence: evidenceOut,
          });
        } else {
          ambiguous.push({
            modKeyA: keyLo,
            nameA: nameByKey.get(keyLo) || keyLo,
            modKeyB: keyHi,
            nameB: nameByKey.get(keyHi) || keyHi,
            conflictCount: files.length,
            evidence: evidenceOut,
          });
        }
      }
    }
  }

  return { inferred, ambiguous };
}

// ---- Step 1: Relationship Check -- catches a new-collection mod that CONFLICTS with a mod already
// in the collection but has never had ANY Vortex rule between them, so analyzeCollections' own
// rule-based candidate search (above) correctly finds nothing -- there's no rule object to find,
// because none was ever created. Confirmed real, live 2026-08-16: "Faultier's PBR Skyrim AIO 4k"
// was added fresh with zero old-collection rule candidates (correctly landing in noLinkFound by
// today's logic), but conflicts with "Faultier's PBR Skyrim AIO 2k" (already in the collection) on
// 8,089 files, with Vortex's own Conflicts editor showing an unresolved "???" for that pair --
// nothing in this app was ever telling the user that needed a decision. See
// design/vortex-rules-generator-relationship-check-mockup.html for the approved UI this feeds, and
// TECHNICAL.md's "Rules Generator" section for the full rationale.
//
// Scope: only ever checks analysis.noLinkFound (today's "nothing needed" bucket) against every
// OTHER mod worth checking -- both fellow new-collection members (analysis.newMembers) AND
// old-collection members (analysis.oldMembers), not just one or the other. Confirmed live
// 2026-08-16 directly against the director's own real repro: in the actual old/new pairing this
// happens in ("GTS - PBR Visual Overhaul" -> "My PBR 4K Upgrade"), "Faultier's PBR Skyrim AIO 2k"
// is a member of the OLD collection only -- it was never carried into the NEW one at all (a clean
// swap, not a coexistence) -- yet it's still separately installed and enabled, and Vortex's own
// "Manage rules" dialog shows a real, live "???" row between it and the freshly-added 4k with 8,089
// conflicting files. Vortex's own Conflicts editor is not scoped to collection membership at all --
// it lists every real file conflict between anything currently ENABLED, regardless of which
// collection (if any) either mod nominally belongs to -- so checking new-collection members alone
// missed this exact real case entirely. oldMembers is already scoped to mods that resolve to a
// REAL, currently-installed modIndex entry (see getCollectionMembers), so "still installed" is
// already guaranteed by construction, no extra check needed. Deliberately does NOT touch
// analysis.mapping (already resolved) or analysis.anomalies (already flagged via a different,
// existing mechanism) -- both already have a real stored rule pointing somewhere, which is a
// fundamentally different situation from "no rule was ever created at all".
//
// Deliberately NOT folded into analyzeCollections itself: this needs real filesystem access
// (computeConflictingFiles), same reason /conflicts is its own route rather than part of the
// DB-worker's analyze() call. This function is called from the WEB ROUTE layer, fed
// analyzeCollections' own already-computed result -- it never re-derives modKey/name/
// installationPath data itself, and never re-scans the DB.
//
// Pre-filtered by namesLikelyMatch BEFORE any filesystem work -- computeConflictingFiles does a
// full recursive directory listing of both mods' staging folders, real work that shouldn't run for
// every O(n^2) pair in a large collection. Same "required gate" reasoning as analyzeCollections' own
// candidate name-similarity gate above -- reused here for the identical purpose (is this plausibly
// the same mod family), not just borrowed as a coincidence.
//
// No conflict-count threshold -- every real conflict (even 1-3 files) is reported, matching the
// approved mockup's own two examples (8,089 and 212 files, both shown, no cutoff) -- the director's
// own call, already made. A mod with zero real conflicts against anything stays purely in
// noLinkFound, exactly as before -- this function adds a NEW signal on top, it never removes
// anything from the existing bucket.
//
// Second half (kind: 'incomplete', added 2026-08-16): analysis.incompleteLinks -- a mapping already
// exists (a real rule was found), but it only lives on one mod's own side, so Vortex's own dialog
// can't reliably show it resolved from BOTH mods' perspective. No filesystem work needed here at
// all (the relationship and its direction are already fully known from analyzeCollections' own
// modIndex read) -- this half is pure data reshaping, unlike the noLinkFound half above.
function computeRelationshipCandidates(analysis, stagingRoot) {
  const results = [];

  if (stagingRoot) {
    const nameByKey = new Map(analysis.newMembers.map((m) => [m.modKey, m.name]));
    // The candidate pool a noLinkFound mod might conflict with: every OTHER new-collection member,
    // PLUS every old-collection member (a mod key can legitimately appear in both -- deduped here so
    // it's only ever checked once). See this function's own header comment for why oldMembers has to
    // be included too, confirmed against the director's own real repro.
    const otherPool = new Map();
    for (const m of analysis.newMembers) otherPool.set(m.modKey, m.name);
    for (const m of analysis.oldMembers) if (!otherPool.has(m.modKey)) otherPool.set(m.modKey, m.name);

    for (const { modKey } of analysis.noLinkFound) {
      const ownName = nameByKey.get(modKey);
      const ownPath = analysis.installationPaths[modKey];
      if (!ownName || !ownPath) continue;
      const candidates = [];
      for (const [otherKey, otherName] of otherPool) {
        if (otherKey === modKey) continue;
        if (!namesLikelyMatch(ownName, otherName)) continue;
        const otherPath = analysis.installationPaths[otherKey];
        if (!otherPath) continue;
        const files = computeConflictingFiles(stagingRoot, ownPath, otherPath);
        if (files.length > 0) {
          candidates.push({ targetKey: otherKey, targetName: otherName, conflictCount: files.length });
        }
      }
      if (candidates.length > 0) {
        candidates.sort((a, b) => b.conflictCount - a.conflictCount);
        results.push({ modKey, name: ownName, kind: 'missing', candidates });
      }
    }
  }

  // nameByKey covering BOTH collections (a fixModKey/fixTargetKey pair here can be either
  // collection's member) -- built fresh rather than reusing the noLinkFound-only one above, which
  // may not exist at all when stagingRoot is unset.
  const fullNameByKey = new Map();
  for (const m of analysis.newMembers) fullNameByKey.set(m.modKey, m.name);
  for (const m of analysis.oldMembers) fullNameByKey.set(m.modKey, m.name);
  for (const link of analysis.incompleteLinks || []) {
    results.push({
      modKey: link.fixModKey,
      name: fullNameByKey.get(link.fixModKey) || link.fixModKey,
      kind: 'incomplete',
      candidates: [{
        targetKey: link.fixTargetKey,
        targetName: fullNameByKey.get(link.fixTargetKey) || link.fixTargetKey,
        knownType: link.fixType,
      }],
    });
  }

  // Family-pattern inference (2026-08-16) -- see computeFamilyInference's own header comment for the
  // full rationale. 'inferred': read-only, auto-applied (same shape/semantics as 'incomplete' --
  // one already-known candidate, pre-filled by default on the frontend). 'ambiguous': known evidence
  // exists but disagrees on direction, so it gets a real manual pick (both directions offered, same
  // as 'missing') instead of a guess.
  const { inferred, ambiguous } = computeFamilyInference(analysis, stagingRoot);
  for (const item of inferred) {
    results.push({
      modKey: item.modKeyA,
      name: item.nameA,
      kind: 'inferred',
      candidates: [{ targetKey: item.modKeyB, targetName: item.nameB, knownType: item.type, conflictCount: item.conflictCount }],
      evidence: item.evidence,
    });
  }
  for (const item of ambiguous) {
    results.push({
      modKey: item.modKeyA,
      name: item.nameA,
      kind: 'ambiguous',
      candidates: [{ targetKey: item.modKeyB, targetName: item.nameB, conflictCount: item.conflictCount }],
      evidence: item.evidence,
    });
  }

  return results;
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

// Shared "already applied" filter (2026-08-16) -- reduces a mapping array's own rulesToConsider down
// to only what's STILL genuinely pending, per computeApplyPlan's own idempotency check (the same one
// applyRules itself uses for the real write). Used by BOTH the isolated worker's own 'analyze' mode
// (so the in-app Ready-to-copy UI's own per-mod rule breakdown reflects this too, not just the
// separate Report tab) and computeReportData below -- one filtering pass, not two that could drift.
//
// Deliberately does NOT drop a mod from the mapping array, even when every one of its rules turns out
// to already be applied -- unlike computeReportData's own "Completed" list (which has its own,
// separate reason to exclude/relabel a zero-rule mod), the in-app UI's existing "Nothing to copy for
// this mod" fallback (rgRenderReadyCard) already reads correctly for that case, and this app's own
// mapping membership has never meant "has resolvable rules" -- a mod with zero resolvable rules from
// the START already shows there today, unfiltered. This function ONLY makes the per-rule DATA
// accurate; whether/how "this mod is now fully resolved" gets its own distinct badge/bucket in the
// in-app UI (mirroring computeReportData's own alreadyComplete flag) is a real, separate UX question,
// deliberately left open rather than silently decided here -- see TECHNICAL.md.
//
// Never touches computeRulesToApply/applyRules internals -- both always re-derive fresh from
// modIndex on every call, so this is a display-only filter with zero effect on what a real Apply
// actually writes.
function filterMappingToPending(mapping, pendingTripleKeys) {
  return mapping.map((m) => ({
    ...m,
    rulesToConsider: m.rulesToConsider.filter((r) => {
      if (r.status === 'unresolved') return true; // a different, unrelated status -- untouched by this filter
      return pendingTripleKeys.has(`${m.newModKey}::${r.type}::${r.targetKey}`);
    }),
  }));
}

// The 4 "exception" lists Step 3 (Exceptions, the live in-app tool's own third stepper step,
// 2026-08-17) and the separate Report tab's own Exceptions section both need -- extracted out of
// computeReportData so BOTH call sites reuse the exact same computation rather than a second,
// possibly-drifting one. Deliberately excludes unresolvedAnomalies (computeReportData's own
// "Needs a decision" via anomalies) -- that's Step 1's/the live tool's "Needs your input" domain,
// unrelated to this step's own mockup scope (design/vortex-rules-generator-relationship-check-
// mockup.html's #screenExceptions covers only skippedAlreadySet/leftoverOldInstalls/skippedDisabled/
// skippedNoConflict).
//
// rawSkips: computeApplyPlan's own skippedAlreadySet output (the caller already has this from its
// own computeRulesToApply/computeApplyPlan call -- never recomputed here, same "once per report, not
// twice" reasoning computeApplyPlan's own header comment documents for its per-mod batching).
function computeSkipExceptions(modIndex, analysis, rawSkips) {
  const newMemberKeySet = new Set(analysis.newMembers.map((m) => m.modKey));
  const leftoverOldInstalls = findLeftoverOldInstalls(modIndex, analysis.oldMembers, newMemberKeySet);

  // Skipped-already-set exceptions (2026-08-16) -- see computeApplyPlan's own header comment for the
  // full rationale (director's real-world cycle root cause).
  const skipTargetLabels = disambiguateCandidateNames(modIndex, [...new Set(rawSkips.map((s) => s.targetModKey))]);
  const skippedByMod = new Map();
  for (const s of rawSkips) {
    if (!skippedByMod.has(s.newModKey)) skippedByMod.set(s.newModKey, []);
    skippedByMod.get(s.newModKey).push({
      targetKey: s.targetModKey,
      targetName: skipTargetLabels.get(s.targetModKey) || displayName(modIndex.get(s.targetModKey)),
      intendedType: s.intendedType,
      currentType: s.currentType,
    });
  }
  const skippedAlreadySet = [...skippedByMod.entries()].map(([modKey, skips]) => ({
    modKey,
    modName: displayName(modIndex.get(modKey)),
    skips,
  }));

  // Skipped-disabled exceptions (2026-08-16) -- see computeMappingDetails' own header comment on
  // skippedDisabledRules for the full rationale (director's real-world find: a real rule, but its
  // target was never enabled in Vortex). Aggregated straight off analysis.mapping -- computeMappingDetails
  // already did this filtering once, on the same modIndex, when analyzeCollections built this mapping
  // array.
  const disabledTargetLabels = disambiguateCandidateNames(
    modIndex,
    [...new Set(analysis.mapping.flatMap((m) => m.skippedDisabledRules.map((r) => r.targetKey)))],
  );
  const skippedDisabled = analysis.mapping
    .filter((m) => m.skippedDisabledRules.length > 0)
    .map((m) => ({
      modKey: m.newModKey,
      modName: displayName(modIndex.get(m.newModKey)),
      skips: m.skippedDisabledRules.map((r) => ({
        targetKey: r.targetKey,
        targetName: disabledTargetLabels.get(r.targetKey) || displayName(modIndex.get(r.targetKey)),
        type: r.type,
      })),
    }));

  // Skipped-no-conflict exceptions (2026-08-16) -- see computeMappingDetails' own header comment on
  // skippedNoConflictRules for the full rationale (director's real-world find: a real rule, but its
  // target has zero current file conflicts with the new mod). Only ever populated when stagingRoot
  // was actually configured for the analyzeCollections call that built `analysis` (computeMappingDetails'
  // own check), empty otherwise, same "can't verify, don't touch" fallback.
  const noConflictTargetLabels = disambiguateCandidateNames(
    modIndex,
    [...new Set(analysis.mapping.flatMap((m) => m.skippedNoConflictRules.map((r) => r.targetKey)))],
  );
  const skippedNoConflict = analysis.mapping
    .filter((m) => m.skippedNoConflictRules.length > 0)
    .map((m) => ({
      modKey: m.newModKey,
      modName: displayName(modIndex.get(m.newModKey)),
      skips: m.skippedNoConflictRules.map((r) => ({
        targetKey: r.targetKey,
        targetName: noConflictTargetLabels.get(r.targetKey) || displayName(modIndex.get(r.targetKey)),
        type: r.type,
      })),
    }));

  return { leftoverOldInstalls, skippedAlreadySet, skippedDisabled, skippedNoConflict };
}

function computeReportData(modIndex, oldCollectionKey, newCollectionKey, ruleOverrides, anomalyOverrides, anomalyMemory = { choices: {} }, stagingRoot = null) {
  const analysis = analyzeCollections(modIndex, oldCollectionKey, newCollectionKey, anomalyMemory, stagingRoot);

  // "Already applied" filtering (2026-08-16) -- director's real find: this list previously showed
  // EVERY resolvable rule from analysis.mapping as still-pending, with zero check for whether Apply
  // had already written it in an earlier run. Confirmed live: "Exist's Caves PBR - 4k" showed
  // "1 rule, 1 after" here while Vortex's own "Manage rules" dialog already had that exact rule,
  // locked, correctly set. computeMappingDetails (which builds rulesToConsider) works purely from
  // the OLD mod's own rule set -- it never checks the NEW mod's current state at all; only
  // computeApplyPlan (the real Apply path) has that idempotency check. Reused directly here rather
  // than re-implemented -- toApply already IS every rulesToConsider entry (plus resolved anomalies),
  // shaped into the exact triples computeApplyPlan expects; toWrite is the subset STILL genuinely
  // pending after the same check applyRules itself would run. Computed ONCE for the whole batch (not
  // per mod) for the same performance reason computeApplyPlan's own header comment already documents.
  const { toApply } = computeRulesToApply(modIndex, oldCollectionKey, newCollectionKey, ruleOverrides || {}, anomalyOverrides || {}, {}, anomalyMemory, stagingRoot);
  const { toWrite, skippedAlreadySet: rawSkips } = computeApplyPlan(modIndex, toApply);
  const pendingTripleKeys = new Set(toWrite.map((t) => `${t.newModKey}::${t.type}::${t.targetModKey}`));

  const completed = analysis.mapping
    .map((m) => {
      const resolvable = m.rulesToConsider.filter((r) => r.status !== 'unresolved');
      // Distinguishes two genuinely different "nothing to show" reasons: a mod that never had
      // anything transferable to begin with (resolvable.length === 0 -- pre-existing behavior,
      // silently excluded below exactly as before) vs. one where every resolvable rule turned out to
      // already be correctly applied (resolvable.length > 0, but nothing survives the pending
      // filter -- the director's own new case, which must stay visible, not vanish).
      const stillPending = resolvable.filter((r) => pendingTripleKeys.has(`${m.newModKey}::${r.type}::${r.targetKey}`));
      return {
        newModKey: m.newModKey,
        newModName: displayName(modIndex.get(m.newModKey)),
        oldModName: displayName(modIndex.get(m.oldModKey)),
        ruleCount: stillPending.length,
        hadResolvableRules: resolvable.length > 0,
      };
    })
    // A mod that never had anything transferable (resolvable.length was already 0) stays silently
    // excluded, exactly as before this fix -- unrelated to "already applied", nothing changed there.
    // A mod whose rules are now ALL already-applied (hadResolvableRules but ruleCount 0) is kept --
    // see below for how it's rendered.
    .filter((m) => m.ruleCount > 0 || m.hadResolvableRules);

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
      // disambiguateCandidateNames (above analyzeCollections) -- only changes anything when two+ of
      // THIS mod's own candidates collide on display name (real repro: "Exist's Caves PBR - 4k --
      // could match more than one mod: Exist's Caves PBR - 2k, Exist's Caves PBR - 2k").
      const targetLabels = disambiguateCandidateNames(modIndex, a.candidates.map((c) => c.targetKey));
      unresolvedAnomalies.push({
        modKey: a.modKey,
        modName: displayName(modIndex.get(a.modKey)),
        candidateCount: a.candidateCount,
        candidates: a.candidates.map((c) => targetLabels.get(c.targetKey) || displayName(modIndex.get(c.targetKey))),
        // Present only when a previously-recorded pick's TYPE no longer matches today's candidate --
        // see analyzeCollections' own previousChoice comment. A still-matching pick never reaches
        // here at all (promoted straight to mapping), so this is always a genuine "something changed
        // since you last decided this" signal, never a stale no-op note.
        previousChoice: a.previousChoice
          ? { targetName: targetLabels.get(a.previousChoice.targetKey) || displayName(modIndex.get(a.previousChoice.targetKey)), type: a.previousChoice.type }
          : null,
      });
    }
  }

  // rawSkips/toWrite were already computed once, above, from the SAME computeRulesToApply +
  // computeApplyPlan pure in-memory pipeline applyRules itself uses for the real write (every
  // override map empty -- "what would a plain Apply do/skip right now") -- reused here rather than a
  // second call, same "once per report, not twice" reasoning computeApplyPlan's own header comment
  // already documents for its per-mod batching. See computeSkipExceptions' own header comment for
  // why this is now shared with Step 3 (the live in-app tool's own Exceptions step) rather than
  // computed inline here.
  const { leftoverOldInstalls, skippedAlreadySet, skippedDisabled, skippedNoConflict } = computeSkipExceptions(modIndex, analysis, rawSkips);

  return {
    oldCollection: analysis.oldCollection,
    newCollection: analysis.newCollection,
    completed,
    resolvedAnomalyCount,
    exceptions: {
      unresolvedAnomalies,
      leftoverOldInstalls,
      skippedAlreadySet,
      skippedDisabled,
      skippedNoConflict,
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
// relationshipOverrides (Step 1: Relationship Check): modKey -> {targetKey, type} ('before'/'after')
// or missing/null = still "???", skipped entirely -- same semantics as the other two overrides.
function computeRulesToApply(modIndex, oldCollectionKey, newCollectionKey, ruleOverrides, anomalyOverrides, relationshipOverrides, anomalyMemory = { choices: {} }, stagingRoot = null) {
  const result = analyzeCollections(modIndex, oldCollectionKey, newCollectionKey, anomalyMemory, stagingRoot);
  const newMemberKeySet = new Set(result.newMembers.map((m) => m.modKey));
  const oldToNewMap = new Map(result.mapping.map((m) => [m.oldModKey, m.newModKey]));
  // Own cache, separate from analyzeCollections' own internal one above -- this is a DIFFERENT call
  // path (anomaly-resolution, below), not worth threading a shared cache across two separate
  // function calls for. Some cache-reuse loss between the two is fine; each unique staging folder
  // still only gets listed once WITHIN this specific loop, which is what actually matters at scale.
  const anomalyFileListCache = new Map();

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
  //
  // anomalyChoicesToRemember (2026-08-16): every pick made here, collected so applyRules can persist
  // it (on a REAL write only -- see its own comment) via rulesGeneratorAnomalyMemory. This is what
  // lets analyzeCollections' own remembered-choice check above stop re-asking the SAME question on a
  // future scan, once a human has actually decided it once.
  const anomalyChoicesToRemember = [];
  for (const item of result.anomalies) {
    const pick = anomalyOverrides ? anomalyOverrides[item.modKey] : undefined;
    if (pick === undefined || pick === '') continue; // still "???" -- unresolved, skip entirely
    const candidate = item.candidates[Number(pick)];
    if (!candidate) continue; // stale/invalid index -- ignore rather than throw
    anomalyChoicesToRemember.push({ newModKey: item.modKey, targetKey: candidate.targetKey, type: candidate.type });
    const details = computeMappingDetails(modIndex, item.modKey, candidate.targetKey, null, newMemberKeySet, oldToNewMap, stagingRoot, anomalyFileListCache);
    details.rulesToConsider.forEach((r) => {
      if (r.status === 'unresolved' || !r.targetKey) return;
      toApply.push({ newModKey: item.modKey, type: r.type, targetModKey: r.targetKey });
    });
  }

  // Step 1's picks (Relationship Check) are, from here on, just another rule to write directly --
  // no remapping/counterpart logic needed (unlike mapping/anomalies, this ISN'T "copy an old mod's
  // rule set", it's a single, explicit, one-off rule the user picked for exactly this one pair).
  // Same "??? means explicitly no rule, nothing to write" semantics ruleOverrides already has above
  // -- a modKey with no override, or an override missing targetKey/type, writes nothing.
  //
  // Written on BOTH mods' sides (the pick itself, plus its inverse on the target's own rules array)
  // -- confirmed necessary against Vortex's REAL source, not a guess: this app's existing
  // mapping/anomaly rule-copying only ever writes one side (mirroring how the OLD mod's own rule was
  // itself presumably one-sided), which is fine there because Vortex's dependency-resolution/sort
  // logic (testModReference.ts) is itself already bidirectional-aware. But Vortex's own "Manage
  // rules" DIALOG (ConflictEditor.tsx) is not: getRuleSpec() only reliably finds a rule that lives on
  // the CURRENTLY-OPEN mod's own `rules` array; a rule living only on the OTHER mod's side falls back
  // to a separate, cached cross-mod list (index.tsx's dependencyState.modRules, rebuilt by
  // updateMetaRules on gamemode-activated/profile-did-change/deploy events) -- and updateMetaRules
  // silently DROPS a mod from that cache entirely if it lacks fileExpression/fileMD5/logicalFileName
  // (a real, plausible gap for a freshly-added Workshop mod, confirmed live 2026-08-16: a
  // Relationship Check pick written only on the "new" mod's side stayed "???" in Vortex's own dialog
  // for the OTHER mod, even after a full Vortex restart + the Collections "Refresh" button, neither
  // of which touches that missing-attribute cache gap). Writing both directions means whichever mod's
  // dialog the user opens finds the rule via the PRIMARY, uncached, always-reliable check -- no
  // dependency on that fragile cache at all.
  //
  // forceLiteral: true -- applyRules' general idempotency check (getEffectiveRules, deliberately
  // bidirectional -- see its own comment) would otherwise treat "the OTHER mod already has this
  // relationship, found via the reverse scan" as "already resolved, nothing to write" -- which is
  // EXACTLY today's real broken state (4K's own rule exists, 2K's does not) and would silently skip
  // writing 2K's own literal copy, defeating the entire point of this fix. forceLiteral tells
  // applyRules to check ONLY that mod's own literal rules array for this specific triple, not the
  // bidirectional-effective view, so each side's literal copy gets written independently of whether
  // the other side already covers it semantically.
  //
  // Reads override.modKey from the VALUE, not the object's own key (Object.values, not entries) --
  // confirmed necessary live 2026-08-16: family-pattern inference can produce several DISTINCT fixes
  // that all originate from the SAME source mod (e.g. one "hub" mod conflicting with several
  // different unrelated products), which a modKey-as-object-key map can't represent (later entries
  // silently clobbered earlier ones sharing that key -- only 4 of 9 real inferred fixes actually
  // wrote). The frontend keys these entries by a compound `${modKey}::${targetKey}` string instead
  // (unique per PAIR, not per source mod) for exactly this reason -- the object's own key only needs
  // to be unique for dictionary purposes here, never used for anything semantic on this side.
  for (const override of Object.values(relationshipOverrides || {})) {
    if (!override || !override.modKey || !override.targetKey || !override.type) continue;
    toApply.push({ newModKey: override.modKey, type: override.type, targetModKey: override.targetKey, forceLiteral: true });
    toApply.push({ newModKey: override.targetKey, type: invertType(override.type), targetModKey: override.modKey, forceLiteral: true });
  }

  return { toApply, analysis: result, anomalyChoicesToRemember };
}

// ---- Exception report: skipped rules (2026-08-16) -- director's own real-world root cause: the OLD
// collection's own rule set is internally consistent (acyclic) by construction, but if the user has
// manually set even ONE rule differently in the NEW collection before running Rules Generator, the
// idempotency check below deliberately leaves that existing rule alone rather than overwriting an
// explicit decision -- correct in isolation, but it means the new collection can end up with one edge
// pointing the "wrong" way relative to everything else that DID get copied faithfully, producing a
// real cycle even though the old collection never had one. Confirmed and reproduced live, surfaced by
// Cycle Helper (already shipped).
//
// Factored out of applyRules (below) so the SAME pure, modIndex-only computation (no `db` access at
// all -- the check itself never needs it, only the eventual write does) can also power the read-only
// Report tab's own exception list, without giving that tab a live-DB dependency it doesn't otherwise
// have. Given `toApply` (computeRulesToApply's own output), returns which triples would actually be
// written (`toWrite`) vs skipped, and -- the new part -- WHICH skips represent a genuine, reportable
// mismatch: the new mod already has a rule for that exact (mod, target) pair, but a DIFFERENT type
// than what the old collection's own copy says. A skip where the already-set type happens to
// COINCIDE with what would have been written isn't a real discrepancy (nothing to report or fix,
// upsertRule's own true-no-op logic already treats an exact match the same way) -- only genuine
// mismatches go into skippedAlreadySet.
function computeApplyPlan(modIndex, toApply) {
  // Group by newModKey FIRST, so getEffectiveRules (a full reverse-scan over EVERY mod Vortex has
  // ever tracked, across every collection -- not just these two) is computed once per MOD, not
  // once per RULE. Calling it per-triple was a real, confirmed-live performance bug: a mod needing
  // 23 rules did 23 full index scans instead of 1, and this scales with the size of the user's
  // entire Vortex library, not just this analysis -- exactly what made "Checking what would
  // change..." feel stuck rather than just quick.
  const triplesByMod = new Map(); // newModKey -> [{type, targetModKey, forceLiteral}]
  for (const { newModKey, type, targetModKey, forceLiteral } of toApply) {
    if (!triplesByMod.has(newModKey)) triplesByMod.set(newModKey, []);
    triplesByMod.get(newModKey).push({ type, targetModKey, forceLiteral: !!forceLiteral });
  }

  const toWrite = []; // {newModKey, type, targetModKey}
  const skippedAlreadySet = []; // {newModKey, targetModKey, intendedType, currentType} -- genuine mismatches only
  let skippedAlreadyResolved = 0;
  for (const [newModKey, triples] of triplesByMod) {
    const effective = getEffectiveRules(modIndex, newModKey); // once per mod, not once per rule
    const ownRules = (modIndex.get(newModKey)?.rules || []).filter((r) => CONFLICT_RULE_TYPES.includes(r.type));
    for (const { type, targetModKey, forceLiteral } of triples) {
      // Idempotency, mirroring Vortex's own "???" meaning exactly: if this exact relationship is
      // ALREADY effectively resolved (either direction), there's nothing to write. An existing
      // DIFFERENT-direction resolution (e.g. new mod already has "before X" while the old mod's
      // copied rule says "after X") is deliberately left alone, not overwritten -- Vortex already
      // shows this as resolved (not "???"), and silently flipping an existing explicit decision
      // would be presumptuous. Checked against modIndex's snapshot from the start of this run.
      //
      // forceLiteral (Step 1: Relationship Check's own dual-write only -- see computeRulesToApply's
      // own comment on why): checks ONLY this mod's own literal rules array, not the bidirectional
      // getEffectiveRules view -- the whole point of writing both sides is to guarantee a LITERAL
      // entry on each mod independently of whether the other side already covers it semantically
      // (Vortex's own "Manage rules" dialog needs the literal entry on whichever mod's dialog is
      // open, not just an effectively-true relationship).
      //
      // .find(), not .some() -- the actual matched rule is what makes skippedAlreadySet possible
      // (need its real .type to compare against what was intended, not just a yes/no).
      //
      // Confirmed real, live 2026-08-16: for the non-forceLiteral (general) path, the matched rule
      // can live on EITHER side -- effective's own 'reverse' half means the literal entry is on the
      // TARGET mod's own rules array, not newModKey's, with its type inverted for display here. A
      // real repro: "Northern Roads - Fixes and Optimization" owned a literal "before Landscapes-4k"
      // rule; Landscapes-4k itself had nothing of its own for that target at all -- the mismatch only
      // surfaced via the reverse scan. literalOwnerKey/literalType/literalTargetKey below capture
      // exactly where the REAL, literal rule lives and what its RAW (un-inverted) type is, so
      // clearSkippedRules (which must remove the actual stored rule, not a display-only inversion of
      // it) knows which mod's array to touch. Getting this wrong wouldn't just report incorrectly --
      // it would make Clear a silent no-op for any skip whose literal rule lives on the other side.
      let matchedType;
      let literalOwnerKey;
      let literalType;
      let literalTargetKey;
      if (forceLiteral) {
        const rawMatch = ownRules.find((r) => ruleGroup(r.type) === ruleGroup(type) && r.reference?.id === targetModKey);
        if (rawMatch) {
          matchedType = rawMatch.type;
          literalOwnerKey = newModKey;
          literalType = rawMatch.type;
          literalTargetKey = targetModKey;
        }
      } else {
        const effMatch = effective.find((r) => {
          if (ruleGroup(r.type) !== ruleGroup(type)) return false;
          const rTargetKey = r.direction === 'own' ? resolveRefToModKey(modIndex, r.target) : r.owner;
          return rTargetKey === targetModKey;
        });
        if (effMatch) {
          matchedType = effMatch.type;
          if (effMatch.direction === 'own') {
            literalOwnerKey = newModKey;
            literalType = effMatch.raw.type;
            literalTargetKey = targetModKey;
          } else {
            literalOwnerKey = effMatch.owner;
            literalType = effMatch.raw.type; // RAW, un-inverted type as literally stored on the owner's own side
            literalTargetKey = newModKey;
          }
        }
      }

      if (matchedType !== undefined) {
        skippedAlreadyResolved += 1;
        if (matchedType !== type) {
          skippedAlreadySet.push({
            newModKey, targetModKey, intendedType: type, currentType: matchedType,
            literalOwnerKey, literalType, literalTargetKey,
          });
        }
      } else {
        toWrite.push({ newModKey, type, targetModKey });
      }
    }
  }

  return { toWrite, skippedAlreadySet, skippedAlreadyResolved };
}

// Concrete ruleIO backend -- LevelDB-backed (2026-08-18), used by applyRules/clearSkippedRules/
// switchSkippedRules below when writing through Vortex's live state.v2 directly (or its safe
// read-only copy, for a dry-run preview -- `db` is the caller's already-open handle either way,
// same "caller owns which DB mode" contract this project's own DB-touching functions already
// follow). Mirrors lib/cycle-detector.js's own makeLevelDbRuleIO exactly, generalized from a single
// {remove, add} pair to an ORDERED ARRAY of them -- Rules Generator's own writes can touch several
// rules on the SAME mod in one call (a whole collection's worth of Apply, not Cycle Helper's
// one-rule-at-a-time fix), so `commit` applies every op in `ops`, in order, against the CALLER's own
// `currentRules` (passed in explicitly, not re-read here, so `remove`'s own object-reference
// equality against `indexOf` stays reliable -- see cycle-detector.js's own commit for the same
// reasoning), then writes the WHOLE final array back in ONE db.put, regardless of how many ops it
// took -- LevelDB writes are cheap/local, so batching them costs nothing and matches this file's own
// prior "one read-modify-write per mod" behavior exactly.
function makeLevelDbRuleIO(db) {
  return {
    async readRules(modId) {
      const raw = await db.get(`persistent###mods###${GAME_ID}###${modId}###rules`).catch((err) => {
        if (err.code === 'LEVEL_NOT_FOUND') return '[]';
        throw err;
      });
      const rules = JSON.parse(raw);
      syncLib.assertRulesShapeKnown(rules, modId);
      return rules;
    },
    async commit(modId, currentRules, ops) {
      let rules = currentRules;
      for (const { remove, add } of ops) {
        if (remove) {
          const idx = rules.indexOf(remove);
          rules = idx === -1 ? rules : rules.slice(0, idx).concat(rules.slice(idx + 1));
        }
        if (add) rules = rules.concat([add]);
      }
      await db.put(`persistent###mods###${GAME_ID}###${modId}###rules`, JSON.stringify(rules));
    },
  };
}

// Computes the {remove, add} op needed to upsert one rule against a KNOWN, in-memory rules array --
// pure function, no I/O. Mirrors upsertRule's own matching/replace-in-place semantics exactly (same
// group/target match, same buildRuleReference-built id-only reference), just expressed as an
// explicit remove/add pair instead of a single "here's the whole new array" return, so BOTH ruleIO
// backends below can commit it identically (LevelDB: apply the pair against its own in-memory copy,
// one db.put per mod; helper: one POST /rules/apply dispatch per pair, matching Vortex's own real
// addModRule/removeModRule action shape exactly). Returns `null` for a true no-op (already exactly
// this rule) -- same "skip, don't write" case upsertRule itself already short-circuits.
function computeUpsertOp(workingRules, type, targetModKey) {
  const group = ruleGroup(type);
  const idx = workingRules.findIndex(
    (r) => CONFLICT_RULE_TYPES.includes(r.type) && ruleGroup(r.type) === group && r.reference?.id === targetModKey,
  );
  if (idx !== -1 && workingRules[idx].type === type && workingRules[idx].reference?.id === targetModKey) {
    return { workingRules, op: null }; // already exactly this rule -- true no-op
  }
  const newRule = { type, reference: buildRuleReference(targetModKey) };
  if (idx !== -1) {
    const removedRule = workingRules[idx];
    const updated = workingRules.slice(0, idx).concat(workingRules.slice(idx + 1)).concat([newRule]);
    return { workingRules: updated, op: { remove: removedRule, add: newRule } };
  }
  return { workingRules: workingRules.concat([newRule]), op: { remove: undefined, add: newRule } };
}

// The real write (or its dry-run preview). `ruleIO` is the caller's already-set-up backend --
// `makeLevelDbRuleIO(db)` (a safe read-only copy for dryRun, or the live, already-backed-up database
// for the real write) or `makeHelperRuleIO()` (2026-08-18, writes through the optional Vortex
// Collection Helper extension instead -- see its own header comment and TECHNICAL.md's Rules
// Generator section for why/how). dryRun skips every ruleIO.commit call -- used by apply-preview to
// compute an accurate count without touching anything, same preview/write pairing Update Collection's
// own apply-ignores-preview/apply-ignores-write already establish.
async function applyRules(ruleIO, modIndex, oldCollectionKey, newCollectionKey, ruleOverrides, anomalyOverrides, relationshipOverrides, { dryRun = false, anomalyMemory = { choices: {} }, stagingRoot = null } = {}) {
  const { toApply, anomalyChoicesToRemember } = computeRulesToApply(modIndex, oldCollectionKey, newCollectionKey, ruleOverrides, anomalyOverrides, relationshipOverrides, anomalyMemory, stagingRoot);
  const { toWrite, skippedAlreadySet, skippedAlreadyResolved } = computeApplyPlan(modIndex, toApply);

  const byMod = new Map(); // newModKey -> [{type, targetModKey}]
  for (const { newModKey, type, targetModKey } of toWrite) {
    if (!byMod.has(newModKey)) byMod.set(newModKey, []);
    byMod.get(newModKey).push({ type, targetModKey });
  }

  const modsChanged = [];
  let totalRulesWritten = 0;
  for (const [newModKey, rulesToAdd] of byMod) {
    // Read fresh right before writing, same as writeIgnoredFlags/writeDisabledFlags already do --
    // don't rely on modIndex's possibly-stale copy for the actual mutation. A mod that has NEVER
    // had any rule at all (no before/after/conflicts, no requires/recommends -- confirmed real
    // 2026-08-16: a freshly-added mod with zero rule history, e.g. via Step 1's Relationship Check
    // catching a brand-new conflict) has no `###rules` key in the DB at all yet, not an empty array
    // -- ruleIO.readRules returns `[]` for that case (see makeLevelDbRuleIO's own LEVEL_NOT_FOUND
    // handling), same convention vortex-sync/lib.js's own field readers already follow.
    const currentRules = await ruleIO.readRules(newModKey);

    let workingRules = currentRules;
    const ops = [];
    let rulesWrittenForMod = 0;
    for (const { type, targetModKey } of rulesToAdd) {
      const result = computeUpsertOp(workingRules, type, targetModKey);
      workingRules = result.workingRules;
      if (result.op) { ops.push(result.op); rulesWrittenForMod += 1; }
    }

    if (ops.length > 0) {
      if (!dryRun) {
        await ruleIO.commit(newModKey, currentRules, ops);
        // Patch the SAME in-memory modIndex the write itself just computed from -- see
        // vortex-sync/lib.js's own "Staleness" comment on withLiveStateDb for the full rationale.
        // A caller that needs an accurate "what does it look like now" answer right after this write
        // (e.g. re-running analyzeCollections on this SAME modIndex) gets one with zero risk of the
        // WAL/compaction staleness a second withStateDb read would carry -- no second DB read at all.
        const entry = modIndex.get(newModKey);
        if (entry) entry.rules = workingRules;
      }
      totalRulesWritten += rulesWrittenForMod;
      modsChanged.push({ newModKey, name: displayName(modIndex.get(newModKey)), rulesWritten: rulesWrittenForMod });
    }
  }

  // Remember every anomaly pick made in THIS apply (2026-08-16) -- only on a REAL write, never a
  // dryRun preview, matching the director's own "on Apply" wording. This is what lets a FUTURE scan
  // skip re-asking the same question -- see analyzeCollections' own remembered-choice comment.
  // Deliberately unconditional on `anyChanged`/toWrite -- a pick whose rules were ALL already
  // correctly set (nothing left to write) still represents a real, confirmed decision worth
  // remembering, same as one that wrote something new.
  if (!dryRun) {
    for (const choice of anomalyChoicesToRemember) {
      anomalyMemoryStore.saveAnomalyChoice(oldCollectionKey, newCollectionKey, choice.newModKey, choice.targetKey, choice.type);
    }
  }

  return {
    mods: modsChanged,
    totalRulesWritten,
    totalModsChanged: modsChanged.length,
    skippedAlreadyResolved,
    skippedAlreadySet,
  };
}

// ---- Clearing skipped rules (2026-08-16) -- the other half of the exception report above: once the
// director can SEE which rules got skipped because the new collection already had a conflicting
// entry, the fix is to clear ONLY those specific rules and re-run Apply, so the old collection's rule
// set gets copied over fully and faithfully. Director's own explicit scoping requirement, the single
// most important thing to get right here: a new-collection mod can have OTHER, genuinely unrelated
// manual rules that have nothing to do with what Rules Generator manages -- this must NEVER touch
// anything beyond the exact (mod, target, type) entries identified in the skips list.
//
// Same "read current rules fresh, find the one matching entry, remove it, write back" mechanic as
// cycle-detector.js's own applyCandidateFix -- mirrored deliberately, not reinvented (same DB shape,
// same removeModRule semantics being replicated). Matched by {type === literalType (the RAW,
// un-inverted type as actually stored -- see computeApplyPlan's own comment on why this can differ
// from currentType) AND resolveRefToModKey(reference) === literalTargetKey} -- precise enough that
// any OTHER rule on that same mod, even one pointing at the exact same target with a DIFFERENT type,
// survives untouched.
//
// Operates on literalOwnerKey, NOT newModKey -- confirmed real, live: the literal rule a skip entry
// describes can live on EITHER side (computeApplyPlan's own reverse-direction discovery), so clearing
// by newModKey alone would silently no-op for any skip whose literal rule actually lives on the
// target's own array instead.
//
// `skips` is always re-derived fresh from the LIVE db by the caller (rules-generator-worker.js),
// never trusted from the client -- same principle every other DB-touching computation in this file
// already follows (see computeRulesToApply's own header comment). A skip entry that's gone stale
// (the rule already changed since the report was generated) is silently skipped, not thrown on --
// this is a batch operation over a client-triggered but server-recomputed list, and one stale entry
// shouldn't fail the whole clear.
async function clearSkippedRules(ruleIO, modIndex, skips) {
  const byMod = new Map(); // literalOwnerKey -> [{literalTargetKey, literalType}]
  for (const s of skips) {
    if (!byMod.has(s.literalOwnerKey)) byMod.set(s.literalOwnerKey, []);
    byMod.get(s.literalOwnerKey).push({ targetModKey: s.literalTargetKey, currentType: s.literalType });
  }

  const modsChanged = [];
  let totalRulesCleared = 0;
  for (const [literalOwnerKey, toRemove] of byMod) {
    const currentRules = await ruleIO.readRules(literalOwnerKey);

    let workingRules = currentRules;
    const ops = [];
    let rulesClearedForMod = 0;
    for (const { targetModKey, currentType } of toRemove) {
      const idx = workingRules.findIndex(
        (r) => r.type === currentType && resolveRefToModKey(modIndex, r.reference) === targetModKey,
      );
      if (idx === -1) continue; // already changed/removed since the report ran -- skip, don't throw
      const removedRule = workingRules[idx];
      workingRules = workingRules.slice(0, idx).concat(workingRules.slice(idx + 1));
      ops.push({ remove: removedRule, add: undefined });
      rulesClearedForMod += 1;
    }

    if (rulesClearedForMod > 0) {
      await ruleIO.commit(literalOwnerKey, currentRules, ops);
      const entry = modIndex.get(literalOwnerKey);
      if (entry) entry.rules = workingRules; // same in-memory patch pattern applyRules' own write loop uses
      totalRulesCleared += rulesClearedForMod;
      modsChanged.push({ newModKey: literalOwnerKey, name: displayName(modIndex.get(literalOwnerKey)), rulesCleared: rulesClearedForMod });
    }
  }

  return { mods: modsChanged, totalRulesCleared, totalModsChanged: modsChanged.length };
}

// ---- Switching a skipped-already-set rule (2026-08-17) -- Step 3 (Exceptions, the live in-app
// tool's own third stepper step)'s per-mod "Switch to match the old collection" pick, and its bulk
// "Switch all" button. Where clearSkippedRules above only removes the conflicting literal entry
// (leaving a SEPARATE Apply run to write the old collection's version back in), this does both in
// one pass -- matching Step 3's own single "Save my picks" action, no second click needed.
//
// The removal and the addition can legitimately target DIFFERENT mods' own rules arrays: the literal
// entry to remove lives on `literalOwnerKey` (either side, per computeApplyPlan's own reverse-
// direction discovery -- see clearSkippedRules' own comment), but the replacement always belongs on
// `newModKey` specifically -- the exact {newModKey, intendedType, targetModKey} triple a normal Apply
// would have written there in the first place (matches computeApplyPlan's own toWrite shape). Ops are
// batched per AFFECTED mod key (not per skip) so a mod touched by both a removal and an addition in
// the same call gets exactly one read-modify-write, never two racing against each other.
async function switchSkippedRules(ruleIO, modIndex, skips) {
  const opsByMod = new Map(); // modKey -> { removals: [{type, targetModKey}], additions: [{type, targetModKey}] }
  const ensure = (key) => {
    if (!opsByMod.has(key)) opsByMod.set(key, { removals: [], additions: [] });
    return opsByMod.get(key);
  };
  for (const s of skips) {
    ensure(s.literalOwnerKey).removals.push({ type: s.literalType, targetModKey: s.literalTargetKey });
    ensure(s.newModKey).additions.push({ type: s.intendedType, targetModKey: s.targetModKey });
  }

  const modsChanged = [];
  let totalRulesChanged = 0;
  for (const [modKey, { removals, additions }] of opsByMod) {
    const currentRules = await ruleIO.readRules(modKey);

    let workingRules = currentRules;
    const commitOps = [];
    let changedForMod = 0;
    for (const { type, targetModKey } of removals) {
      const idx = workingRules.findIndex((r) => r.type === type && resolveRefToModKey(modIndex, r.reference) === targetModKey);
      if (idx === -1) continue; // already changed/removed since the report ran -- skip, don't throw
      const removedRule = workingRules[idx];
      workingRules = workingRules.slice(0, idx).concat(workingRules.slice(idx + 1));
      commitOps.push({ remove: removedRule, add: undefined });
      changedForMod += 1;
    }
    for (const { type, targetModKey } of additions) {
      const result = computeUpsertOp(workingRules, type, targetModKey);
      workingRules = result.workingRules;
      if (result.op) { commitOps.push(result.op); changedForMod += 1; }
    }

    if (changedForMod > 0) {
      await ruleIO.commit(modKey, currentRules, commitOps);
      const entry = modIndex.get(modKey);
      if (entry) entry.rules = workingRules; // same in-memory patch pattern applyRules' own write loop uses
      totalRulesChanged += changedForMod;
      modsChanged.push({ newModKey: modKey, name: displayName(modIndex.get(modKey)), rulesChanged: changedForMod });
    }
  }

  return { mods: modsChanged, totalRulesChanged, totalModsChanged: modsChanged.length };
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

// ---- Cached file-set lookups (2026-08-16) -- for computeMappingDetails' own "does this rule have
// any CURRENT real effect" check (see its own header comment). computeConflictingFiles above
// re-lists BOTH staging folders on every single call, fine for the bounded, name-pre-filtered pools
// computeFamilyInference/computeRelationshipCandidates already use it for, but far too expensive to
// call once per rule per mod across a WHOLE collection's mapping (a mod like Faultier's PBR
// Landscapes 4k alone has dozens of rules, and its own folder would get re-listed for every one of
// them). `cache` is a plain Map<installationPath, Set<lowercase file>>, created ONCE per
// analyzeCollections call and threaded through every computeMappingDetails call it makes -- each
// unique staging folder gets listed at most once per analysis, no matter how many rules reference it. ----

function getFileSetCached(stagingRoot, installationPath, cache) {
  if (!installationPath) return null;
  if (cache.has(installationPath)) return cache.get(installationPath);
  const set = new Set(listFilesRecursive(path.join(stagingRoot, installationPath)).map((f) => f.toLowerCase()));
  cache.set(installationPath, set);
  return set;
}

// Returns true/false when it CAN determine an answer, or `null` when it genuinely can't (no
// stagingRoot configured, or either mod has no installationPath on record) -- `null` must never be
// treated as "no conflict, filter it out"; only a real `false` means that.
function hasAnyConflict(stagingRoot, installationPathA, installationPathB, cache) {
  if (!stagingRoot || !installationPathA || !installationPathB) return null;
  const setA = getFileSetCached(stagingRoot, installationPathA, cache);
  const setB = getFileSetCached(stagingRoot, installationPathB, cache);
  if (!setA || !setB) return null;
  if (setA.size === 0 || setB.size === 0) return false;
  const [smaller, larger] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
  for (const f of smaller) {
    if (larger.has(f)) return true;
  }
  return false;
}

module.exports = {
  buildModIndex,
  buildModIndexFromLiveData,
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
  disambiguateCandidateNames,
  computeMappingDetails,
  analyzeCollections,
  computeRelationshipCandidates,
  computeFamilyInference,
  findLeftoverOldInstalls,
  filterMappingToPending,
  computeSkipExceptions,
  computeReportData,
  computeConflictingFiles,
  ruleGroup,
  buildRuleReference,
  upsertRule,
  computeUpsertOp,
  computeRulesToApply,
  computeApplyPlan,
  applyRules,
  clearSkippedRules,
  switchSkippedRules,
  makeLevelDbRuleIO,
  CONFLICT_RULE_TYPES,
  MEMBERSHIP_RULE_TYPES,
};
