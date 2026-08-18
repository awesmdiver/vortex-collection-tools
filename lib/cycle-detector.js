'use strict';
// Rule-cycle detection and culprit ranking for the Cycle Helper tool -- see
// docs/plans/2026-08-16-cycle-helper-research.md for the full design rationale, and
// design/vortex-cycle-helper-mockup.html for the UI this feeds. Pure graph functions, no DB
// access -- callers (lib/cycle-helper-worker.js) build the graph from a real modIndex
// (lib/rules-generator.js's buildModIndex) and pass it in here.

const rg = require('./rules-generator');
const syncLib = require('./vortex-sync/lib');
const GAME_ID = syncLib.GAME_ID;

// ---- Graph building -- mirrors Vortex's OWN sort.ts exactly (re-verified line-by-line against its
// real source 2026-08-16, `mod_management/util/sort.ts`'s `modMapper`/`sortMods`, not just the
// original draft's own recollection of it -- see the research doc's "How Vortex builds the
// dependency graph" section). Only 'before'/'after' rules affect load order (NOT 'conflicts', a
// separate file-conflict concept Vortex's own sort.ts never reads at all). Each rule is read
// directly off its owning mod's own `rules` array -- exactly once, since Vortex only ever stores a
// before/after relationship on one side, never both (rules-generator.js's own getEffectiveRules()
// reverse-scan exists to VIEW a mod's incoming rules too, which would double every edge if used
// here instead of the raw per-mod array -- confirmed against sort.ts's own `mods.forEach(mod =>
// modMapper(mod))` loop, which processes each mod's OWN rules exactly once, no reverse pass).
//
// 'before' on modKey referencing target -> edge modKey -> target (modKey sorts before target).
// 'after' on modKey referencing target -> edge target -> modKey (target sorts before modKey).
// Verified against sort.ts's own two lines: `dependencies.setEdge(mod.id, ref.id)` for 'before',
// `dependencies.setEdge(ref.id, mod.id)` for 'after' -- exact match, first-pass draft was correct.
//
// TWO real corrections made this pass, both found by reading sort.ts fresh rather than trusting
// the original draft's assumptions:
//
// 1. Dropped the `rule.ignored` filter the original draft had. `IModRule.ignored` is a REAL field
//    ("if true, the rule is deactivated and will not have an effect" -- IMod.ts's own doc comment)
//    and IS checked by other Vortex code (install-manager dependency resolution, the "install
//    recommendations" context-menu gate) -- but sort.ts's own `modMapper` does NOT check it at all
//    when building `before`/`after` edges. Confirmed by reading that exact function: no `.ignored`
//    reference anywhere in it. That means an "ignored" ordering rule still affects Vortex's REAL
//    sort and REAL cycle detection today, despite what the field's own doc comment implies --
//    this tool must match that real (if seemingly inconsistent) behavior, not the type's stated
//    intent, since the whole point is agreeing with what Vortex itself will actually report.
// 2. KEPT the self-reference exclusion (`targetKey === modKey`) the original draft had, even though
//    sort.ts itself has no such guard either -- a rule resolving to its own owning mod would become
//    a trivial self-loop "cycle" in Vortex's raw graph. Deliberately different from Vortex here: a
//    self-loop is a degenerate data anomaly, not a real "which rule do I fix" scenario this tool's
//    remove/flip workflow meaningfully addresses (flip just produces another self-loop). Documented
//    divergence, not an oversight.
function buildGraph(modIndex, enabledModKeys) {
  const nodeSet = new Set(enabledModKeys);
  const edges = [];
  for (const modKey of enabledModKeys) {
    const entry = modIndex.get(modKey);
    for (const rule of entry?.rules || []) {
      if (rule.type !== 'before' && rule.type !== 'after') continue;
      const targetKey = rg.resolveRefToModKey(modIndex, rule.reference);
      // A rule pointing at a mod that's disabled/uninstalled/unresolvable has no effect on the
      // CURRENT sort (Vortex's own sortMods only builds edges for mods present in its own `mods`
      // array) -- same "not currently relevant" reasoning, so it's silently skipped here too.
      if (!targetKey || !nodeSet.has(targetKey) || targetKey === modKey) continue;
      if (rule.type === 'before') {
        edges.push({ from: modKey, to: targetKey, ownerModKey: modKey, rule });
      } else {
        edges.push({ from: targetKey, to: modKey, ownerModKey: modKey, rule });
      }
    }
  }
  return { nodes: [...nodeSet], edges };
}

// ---- Topological sort (Kahn's algorithm) -- returns the sorted order, or null if a cycle exists
// anywhere in the graph. Same purpose as Vortex's own alg.topsort, just not pulled in as a
// dependency for one function -- this project has no graphlib install.
function topsort(nodes, edges) {
  const inDegree = new Map(nodes.map((n) => [n, 0]));
  const adj = new Map(nodes.map((n) => [n, []]));
  for (const e of edges) {
    if (!adj.has(e.from) || !inDegree.has(e.to)) continue;
    adj.get(e.from).push(e.to);
    inDegree.set(e.to, inDegree.get(e.to) + 1);
  }
  const queue = nodes.filter((n) => inDegree.get(n) === 0);
  const order = [];
  while (queue.length) {
    const n = queue.shift();
    order.push(n);
    for (const m of adj.get(n)) {
      inDegree.set(m, inDegree.get(m) - 1);
      if (inDegree.get(m) === 0) queue.push(m);
    }
  }
  return order.length === nodes.length ? order : null;
}

// ---- Strongly-connected components (Tarjan's algorithm) -- this is what Vortex's own
// alg.findCycles does under the hood too (confirmed against graphlib's real source): every SCC of
// size > 1 (or a single self-referencing node) is "a cycle" as far as topsort is concerned. Only
// called when topsort() has already failed, so nodes/edges here is normally a modest tangle (the
// director's own reproduction case: 27 of several hundred installed mods), not the whole library
// -- recursive depth is bounded by the longest path actually reachable within that tangle, not
// total mod count.
function findSCCs(nodes, edges) {
  const adj = new Map(nodes.map((n) => [n, []]));
  for (const e of edges) {
    if (adj.has(e.from)) adj.get(e.from).push(e.to);
  }
  let index = 0;
  const indices = new Map();
  const lowlink = new Map();
  const onStack = new Set();
  const stack = [];
  const sccs = [];

  function strongconnect(v) {
    indices.set(v, index);
    lowlink.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);

    for (const w of adj.get(v) || []) {
      if (!indices.has(w)) {
        strongconnect(w);
        lowlink.set(v, Math.min(lowlink.get(v), lowlink.get(w)));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v), indices.get(w)));
      }
    }

    if (lowlink.get(v) === indices.get(v)) {
      const scc = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      const hasSelfLoop = scc.length === 1 && (adj.get(v) || []).includes(v);
      if (scc.length > 1 || hasSelfLoop) sccs.push(scc);
    }
  }

  for (const v of nodes) {
    if (!indices.has(v)) strongconnect(v);
  }
  return sccs;
}

// ---- Shortest elementary cycle inside one SCC -- the "don't dump the whole 27-mod tangle"
// answer (see the research doc's finding #2: Vortex's own findCycles stops at "here's the whole
// SCC" and goes no further). For every node in the SCC, BFS from each of its direct successors
// back to itself; the shortest such round-trip across all starting nodes is the shortest cycle.
// O(V * (V + E)) restricted to the SCC's own nodes/edges -- trivially fast at the tangle sizes
// this tool actually sees (dozens of nodes, not thousands).
function bfsShortestPath(adj, from, to) {
  if (from === to) return [from];
  const visited = new Set([from]);
  const queue = [[from]];
  while (queue.length) {
    const path = queue.shift();
    const node = path[path.length - 1];
    for (const next of adj.get(node) || []) {
      if (next === to) return [...path, next];
      if (!visited.has(next)) {
        visited.add(next);
        queue.push([...path, next]);
      }
    }
  }
  return null;
}

function shortestCycleInSCC(scc, edges) {
  const sccSet = new Set(scc);
  const adj = new Map(scc.map((n) => [n, []]));
  for (const e of edges) {
    if (sccSet.has(e.from) && sccSet.has(e.to)) adj.get(e.from).push(e.to);
  }
  let best = null;
  for (const start of scc) {
    for (const next of adj.get(start)) {
      // bfsShortestPath(adj, next, start) returns a path FROM next TO start, so it already ends
      // in `start` -- drop that trailing duplicate before prepending `start` ourselves, or the
      // result repeats the start node (e.g. ['A','B','A'] instead of ['A','B']), contradicting
      // this function's own contract below. Found by scripts/test-cycle-detector.js 2026-08-16.
      const rest = bfsShortestPath(adj, next, start);
      if (rest && (!best || rest.length < best.length)) {
        best = [start, ...rest.slice(0, -1)];
      }
    }
  }
  return best; // node array; last node connects back to the first (the loop), not repeated in the array
}

// ---- Culprit ranking via edge removal -- a small minimum-feedback-arc-set-style heuristic (see
// the research doc's approach 1): for each edge inside the SCC, try removing just that one and
// re-run findSCCs on the remainder. An edge whose removal makes the SCC fully acyclic ranks
// highest; otherwise rank by how much smaller the remaining tangle gets. O(E) topsort-scale
// re-runs, each cheap at this tangle size.
function rankCulpritEdges(scc, edges) {
  const sccSet = new Set(scc);
  const sccEdges = edges.filter((e) => sccSet.has(e.from) && sccSet.has(e.to));
  return sccEdges
    .map((candidate) => {
      const remaining = sccEdges.filter((e) => e !== candidate);
      const subSccs = findSCCs(scc, remaining);
      const remainingTangleSize = subSccs.reduce((sum, s) => sum + s.length, 0);
      return { edge: candidate, breaksFully: subSccs.length === 0, remainingTangleSize };
    })
    .sort((a, b) => a.remainingTangleSize - b.remainingTangleSize);
}

function edgeKey(e) {
  return `${e.from}=>${e.to}::${e.ownerModKey}`;
}

// ---- Top-level entry point. snapshotRulesByModKey (optional): { modKey: rule[] } captured by a
// prior on-demand snapshot (lib/cycle-helper-snapshot.js) -- when present, a candidate rule that
// differs from (or is entirely absent from) the snapshot's copy of its owning mod's rules gets the
// strongest ranking signal, per the research doc's snapshot-diff approach.
function analyzeCycles(modIndex, enabledModKeys, snapshotRulesByModKey) {
  const { nodes, edges } = buildGraph(modIndex, enabledModKeys);
  const order = topsort(nodes, edges);
  if (order) return { hasCycles: false };

  const sccs = findSCCs(nodes, edges);
  const cycles = sccs.map((scc) => {
    const shortest = shortestCycleInSCC(scc, edges);
    const shortestEdgeKeys = new Set();
    if (shortest) {
      for (let i = 0; i < shortest.length; i++) {
        const from = shortest[i];
        const to = shortest[(i + 1) % shortest.length];
        shortestEdgeKeys.add(`${from}=>${to}`);
      }
    }

    const ranked = rankCulpritEdges(scc, edges);
    const candidates = ranked.map((r) => {
      const inShortestCycle = shortestEdgeKeys.has(`${r.edge.from}=>${r.edge.to}`);
      // A rule "matches" the snapshot when the same owner mod has a same-type rule pointing at
      // the same resolved target -- resolving BOTH sides' references against the current
      // modIndex (mod identity metadata like modId/fileMD5 doesn't change without a reinstall,
      // so resolving an older reference against current data is safe).
      let changedSinceSnapshot = null;
      if (snapshotRulesByModKey) {
        const ownerKey = r.edge.ownerModKey;
        const snapRules = snapshotRulesByModKey[ownerKey];
        if (snapRules === undefined) {
          changedSinceSnapshot = true; // mod wasn't even in the snapshot -- can't have been unchanged
        } else {
          const currentTargetKey = rg.resolveRefToModKey(modIndex, r.edge.rule.reference);
          const stillPresent = snapRules.some((sr) => {
            if (sr.type !== r.edge.rule.type) return false;
            return rg.resolveRefToModKey(modIndex, sr.reference) === currentTargetKey;
          });
          changedSinceSnapshot = !stillPresent;
        }
      }
      return { ...r, inShortestCycle, changedSinceSnapshot };
    });

    // De-dupe candidates that are the SAME effective relationship (same owner, same rule type, same
    // resolved target) before ranking -- confirmed live 2026-08-16 against a real, messy repro: a
    // mod can carry SEVERAL separate rule objects that all now resolve to the same currently-
    // installed target, because each was added against a DIFFERENT past version of that target (a
    // new version-pinned reference is a different object by Vortex's own addModRule/ruleEqual
    // comparison, which checks the full reference -- not the resolved target -- so an update never
    // replaces the old rule, it just piles another one on). All are REAL rule objects (nothing here
    // is invented or discarded from Vortex's actual data), but showing the identical-looking "X must
    // load Y" line 5+ times in the ranked list is confusing, not informative -- keep the
    // best-ranked instance of each unique (owner, type, target) triple only. A single Fix action
    // still only removes/flips the ONE underlying rule object it finds (see applyCandidateFix below)
    // -- if more duplicates remain, the next Scan/Validate will surface the same-looking candidate
    // again, and Fix can simply be run again; this is deliberate (mirrors Vortex's own one-rule-at-
    // a-time reducers) rather than a "remove all matching rules" bulk action this app doesn't have
    // elsewhere either.
    const seenTriples = new Set();
    const dedupedCandidates = candidates.filter((c) => {
      const resolvedTargetKey = rg.resolveRefToModKey(modIndex, c.edge.rule.reference);
      const triple = `${c.edge.ownerModKey}::${c.edge.rule.type}::${resolvedTargetKey}`;
      if (seenTriples.has(triple)) return false;
      seenTriples.add(triple);
      return true;
    });

    // Final ranking: a snapshot match is the strongest signal (a real "you just did this" fact,
    // not an inference), then whether removing/flipping it fully resolves the tangle, then
    // shortest-loop membership, then how small a remainder is left as a tiebreak.
    dedupedCandidates.sort((a, b) => {
      if (a.changedSinceSnapshot !== b.changedSinceSnapshot) {
        if (a.changedSinceSnapshot) return -1;
        if (b.changedSinceSnapshot) return 1;
      }
      if (a.breaksFully !== b.breaksFully) return a.breaksFully ? -1 : 1;
      if (a.inShortestCycle !== b.inShortestCycle) return a.inShortestCycle ? -1 : 1;
      return a.remainingTangleSize - b.remainingTangleSize;
    });

    return {
      modsInvolved: scc,
      modCount: scc.length,
      shortestCycle: shortest,
      candidates: dedupedCandidates,
    };
  });

  return { hasCycles: true, cycles };
}

// ---- Applying a fix (remove or flip) to the culprit rule -- mirrors Vortex's own real reducers
// (reducers/mods.ts, re-confirmed against source 2026-08-16, not just recalled): removeModRule
// filters out the rule matching on {type, reference} (its own ruleEqual/reduceRule helpers); a
// flipped before/after rule stays in the SAME mutually-exclusive group ('before'/'after' are one
// group in addModRule's own grouping) and points at the SAME target, so it's always a
// replace-in-place, never an append. Rather than rebuilding a fresh id-only reference the way
// rules-generator.js's own upsertRule does for ITS freshly-authored rules, this only changes the
// `type` field on the existing rule object in place -- more faithful to a hand-edited rule's real
// reference shape (fileMD5/repo.modId+fileId/logicalFileName/etc, whatever the user's own rule
// actually used), which upsertRule was never designed to preserve.
//
// ruleIO: { readRules(modId): Promise<rules[]>, commit(modId, currentRules, remove, add): Promise<void> }
// -- the ONLY database/network-touching part of this function, factored out (2026-08-18) so this
// same find/validate/decide-what-changes logic runs identically against EITHER Vortex's on-disk
// state.v2 (see makeLevelDbRuleIO below) OR the optional Vortex Collection Helper extension's live
// write endpoint (see lib/cycle-helper-runner.js's makeHelperRuleIO) -- this safety-critical logic
// (which rule to touch, whether it still matches) must stay in exactly ONE place, never duplicated
// per backend. ownerModKey/ruleType/targetModKey identify the exact rule to touch, all computed
// server-side during the prior Scan (a client-held rule is never trusted for a live write, same
// principle as everywhere else in this app) -- ruleType is the type AS SCANNED (before any flip), so
// the lookup below always finds the original rule regardless of which action is requested.
async function applyCandidateFix(ruleIO, modIndex, ownerModKey, ruleType, targetModKey, action) {
  const currentRules = await ruleIO.readRules(ownerModKey);

  const idx = currentRules.findIndex((r) => {
    if (r.type !== ruleType) return false;
    return rg.resolveRefToModKey(modIndex, r.reference) === targetModKey;
  });
  if (idx === -1) {
    throw new Error(
      "That rule couldn't be found anymore -- it may have already changed since the last scan. " +
      'Run Scan again to see the current state before trying again.'
    );
  }

  const originalRule = currentRules[idx];
  let add;
  if (action === 'remove') {
    add = undefined;
  } else if (action === 'flip') {
    // A flipped before/after rule stays in the SAME mutually-exclusive group ('before'/'after' are
    // one group in addModRule's own grouping) and points at the SAME target, so this is always a
    // replace-in-place, never an append -- mirrors makeLevelDbRuleIO's own commit (remove old, add
    // new) and the helper extension's own two-dispatch (removeModRule then addModRule) exactly.
    add = { ...originalRule, type: rg.invertType(ruleType) };
  } else {
    throw new Error(`Unknown fix action: ${action}`);
  }

  await ruleIO.commit(ownerModKey, currentRules, originalRule, add);
  // originalRule -- the exact rule object as found before this write, unchanged -- is what Change
  // History (lib/cycle-helper-history.js) needs to revert a 'remove' later (re-adding it wholesale);
  // a 'flip' revert only needs ruleType (the type as scanned, already a parameter here) to flip back,
  // but the caller logs originalRule regardless for a consistent, self-describing history record.
  return { ownerModKey, action, originalRule };
}

// Reverts one previously-applied fix (see applyCandidateFix above and lib/cycle-helper-history.js's
// own fix-record shape) back to its ORIGINAL rule value. Used by both revert locations -- the
// inline "This session so far" list (web/public/cycle-helper-app.js) and the separate Change
// History page -- both just hand this the same fix record either way, straight from wherever it was
// logged.
//
// Stale-revert guard (docs/plans/2026-08-17-cycle-helper-change-history-revert-plan.md's own open
// question, answered): before writing anything, re-reads the rule's CURRENT value and confirms it
// still matches what the fix record itself says "current" (i.e. post-fix) should be -- fix.newType
// at fix.targetModKey for a flip, or genuine ABSENCE of a rule matching fix.originalRule for a
// remove. If something else changed it again since (a hand-edit in Vortex, another Cycle Helper
// session), this throws with a clear message instead of silently overwriting an unrelated later
// change -- callers should catch this PER-FIX (see cycle-helper-worker.js's 'revert-fixes' mode) so
// one stale row never blocks reverting the others in the same batch.
//
// ruleIO: same contract as applyCandidateFix's own -- see its header comment for the full "why this
// is factored out" rationale.
async function revertFix(ruleIO, modIndex, fix) {
  const { ownerModKey, targetModKey, action } = fix;
  const label = `${fix.ownerName || ownerModKey} → ${fix.targetName || targetModKey}`;
  const staleMessage =
    `Can't revert the "${label}" rule -- it no longer matches what this session recorded. Something ` +
    'else may have changed it since (a hand-edit in Vortex, or another Cycle Helper session). Run ' +
    'Scan again to see its current state before trying again.';

  const currentRules = await ruleIO.readRules(ownerModKey);

  if (action === 'flip') {
    const idx = currentRules.findIndex((r) => {
      if (r.type !== fix.newType) return false;
      return rg.resolveRefToModKey(modIndex, r.reference) === targetModKey;
    });
    if (idx === -1) throw new Error(staleMessage);
    const currentRule = currentRules[idx];
    const restoredRule = { ...currentRule, type: fix.originalType };
    await ruleIO.commit(ownerModKey, currentRules, currentRule, restoredRule);
    return { ownerModKey, action, reverted: true };
  }

  if (action === 'remove') {
    const alreadyPresent = currentRules.some((r) => {
      if (r.type !== fix.originalRule?.type) return false;
      return rg.resolveRefToModKey(modIndex, r.reference) === targetModKey;
    });
    if (alreadyPresent) throw new Error(staleMessage);
    await ruleIO.commit(ownerModKey, currentRules, undefined, fix.originalRule);
    return { ownerModKey, action, reverted: true };
  }

  throw new Error(`Unknown fix action: ${action}`);
}

// Concrete ruleIO backend -- LevelDB-backed, used when writing through Vortex's live state.v2
// directly (withLiveStateDb's already-open db handle). commit() mirrors Vortex's own real reducer
// semantics exactly: remove the old rule (if any) then add the new one (if any) -- the SAME
// "remove-then-add, two separate steps" pattern the companion Vortex Collection Helper extension's
// own applyRuleChange dispatches as two sequential Redux actions (confirmed against its real source,
// which itself mirrors Vortex's built-in Conflict Editor) -- so both backends produce IDENTICAL
// final rule arrays for the identical remove/add pair. `remove`/`add` are always object references
// drawn directly from `currentRules` (or a shallow copy of one) by applyCandidateFix/revertFix
// above, in the SAME read this commit call is finishing -- so `indexOf` reference equality below is
// reliable, no need for a second type/reference match.
function makeLevelDbRuleIO(db) {
  return {
    async readRules(modId) {
      const key = `persistent###mods###${GAME_ID}###${modId}###rules`;
      const raw = await db.get(key);
      const rules = JSON.parse(raw);
      syncLib.assertRulesShapeKnown(rules, modId);
      return rules;
    },
    async commit(modId, currentRules, remove, add) {
      const key = `persistent###mods###${GAME_ID}###${modId}###rules`;
      let updated = currentRules;
      if (remove) {
        const idx = updated.indexOf(remove);
        updated = idx === -1 ? updated : updated.slice(0, idx).concat(updated.slice(idx + 1));
      }
      if (add) updated = updated.concat([add]);
      await db.put(key, JSON.stringify(updated));
    },
  };
}

module.exports = {
  buildGraph,
  topsort,
  findSCCs,
  shortestCycleInSCC,
  rankCulpritEdges,
  edgeKey,
  analyzeCycles,
  applyCandidateFix,
  revertFix,
  makeLevelDbRuleIO,
};
