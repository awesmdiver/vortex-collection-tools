'use strict';
// Continue Update, light and live (2026-10-23). The old Continue Update ran the whole review again (every mod's
// archive checked, 12 updates and 3 removals offered again) from a cache that could be minutes old, so it kept
// showing problems the person had already fixed by hand. This module is the light version: it works only on
//   * the short list of what the LAST apply did not finish (saved in ucv2-apply-status.json as "unfinished"), and
//   * the groups (new download not linked, old download left over, update arrow, duplicate copies),
// and re-checks all of it against Vortex AS IT IS NOW from one read of the mods, the downloads and the
// collection's rules. Pure functions: the caller does the reads.

const archiveLink = require('./ucv2-archive-link');
const continueClassify = require('./ucv2-continue-classify');

// "modId:fileId" of every file the collection's live rules name (what the collection asks for right now).
function ruleIdentitiesOf(rules) {
    return new Set((rules || [])
        .filter((r) => r && r.reference && r.reference.repo)
        .map((r) => r.reference.repo.modId + ':' + r.reference.repo.fileId));
}

function computeLiveGroups({ liveMods, downloadsFiles, ruleIdentities, hasFiles }) {
    const identities = ruleIdentities || new Set();
    const strays = downloadsFiles ? archiveLink.findStrayOwnArchives({ liveMods, downloadsFiles, identities }).strays : [];
    const oldDownloads = downloadsFiles ? archiveLink.findOldDownloadsOfInstalledMods({ liveMods, downloadsFiles }) : [];
    return {
        strayArchives: strays,
        oldDownloads,
        staleArrows: continueClassify.findStaleUpdateArrows({ liveMods, identities }),
        duplicateCopies: continueClassify.findDuplicateCopies({ liveMods, identities, hasFiles, downloadsFiles }),
    };
}

// What the last apply left unfinished, from its result lists. Each item keeps the Nexus identity of the file it
// concerns (when it has one) so it can be re-checked against Vortex later without any collection.json.
// Names one dependency warning for good: the dependent mod, the dependency it names (name, versions, required
// range) and the file ids of that dependency before and after. A changed file id is a different warning.
function dependencyAckKey(b) {
    return [b.key, b.oldFileId == null ? '' : b.oldFileId, b.newFileId == null ? '' : b.newFileId].join('|');
}

// dependencyBreaks / newRevisionNumber / newRevisionId (optional) let a rule item and the collection item carry what
// Continue Update needs to finish or confirm them itself.
function buildUnfinishedList({ review, updatedResults, addedResults, removedResults, dependencyBreakResults, dependencyBreaks, newRevisionNumber, newRevisionId, newCollectionName, modRulesResult, collectionAttributesUpdated, removedMembershipCleanup, updatedMembershipRefresh }) {
    const out = [];
    const err = (r) => (r && (r.error || r.reason)) || null;
    (review.updated || []).forEach((u, i) => {
        const r = updatedResults && updatedResults[i];
        if (r && r.ok === false) out.push({ kind: 'update', name: u.new.name, source: u.new.source || null, error: err(r) });
    });
    (review.added || []).forEach((m, i) => {
        const r = addedResults && addedResults[i];
        if (r && r.ok === false) out.push({ kind: 'add', name: m.name, source: m.source || null, error: err(r) });
    });
    for (const r of removedResults || []) {
        if (!r || r.ok !== false) continue;
        const m = (review.removed || []).find((x) => x.name === r.name);
        out.push({ kind: 'remove', name: r.name, source: m ? m.source || null : null, error: err(r) });
    }
    for (const r of dependencyBreakResults || []) {
        if (!r || r.ok !== false) continue;
        const b = (dependencyBreaks || []).find((x) => `${x.dependentName} -> ${x.updatedModName}` === r.name);
        out.push({
            kind: 'rule', name: r.name || 'A dependency rule', source: null, error: err(r),
            ...(b ? { dependency: { dependentVortexModId: b.dependentVortexModId, rule: b.rule, ackKey: dependencyAckKey(b) } } : {}),
        });
    }
    if (modRulesResult && modRulesResult.error) out.push({ kind: 'rule', name: 'Load-order rules', source: null, error: String(modRulesResult.error) });
    if (collectionAttributesUpdated === false) {
        out.push({
            kind: 'collection', name: "The collection's own record", source: null, error: null,
            ...(newRevisionNumber != null ? { revision: { number: newRevisionNumber, id: newRevisionId == null ? null : newRevisionId, name: newCollectionName || null } } : {}),
        });
    }
    if (removedMembershipCleanup && removedMembershipCleanup.ok === false) out.push({ kind: 'rule', name: 'Collection membership rules', source: null, error: err(removedMembershipCleanup) });
    if (updatedMembershipRefresh && updatedMembershipRefresh.ok === false) out.push({ kind: 'rule', name: 'Collection membership rules', source: null, error: err(updatedMembershipRefresh) });
    return out;
}

// Which unfinished items are still open in Vortex as it is now. update/add: open until a live mod matches the new
// file; remove: open while a live mod still matches the old file. Items with no file identity (rules, the
// collection record) cannot be proven done from the mod list, so they stay open until a full check finishes them.
// resolve(source) -> a live Vortex mod key or null.
function stillOpen(unfinished, resolve) {
    return (unfinished || []).filter((item) => {
        if (!item.source) return true;
        const live = resolve(item.source);
        if (item.kind === 'update' || item.kind === 'add') return !live;
        if (item.kind === 'remove') return !!live;
        return true;
    });
}

// What Apply checks instead of scanning the collection again (2026-10-24): the review the person confirmed is compared with
// Vortex as it is now, for the mods the apply touches only. Returns how many mods differ.
//   * an update whose new file is already installed (someone finished it), a picks-only update whose file is no longer
//     the new one, a removal whose mod is gone: all differ;
//   * the lists the page confirmed (keys) against the lists the server has: any difference counts.
// resolve(source) -> a live Vortex mod key or null. keyOf: { updated(u), added(m), removed(m) } (the page's own keys).
function countReviewDifferences(review, resolve) {
    let n = 0;
    for (const u of review.updated || []) {
        const newLive = resolve(u.new.source);
        if (u.fileAlreadyNew) { if (!newLive) n += 1; } else if (newLive) n += 1;
    }
    for (const m of review.removed || []) {
        if (!m.notInstalled && !resolve(m.source)) n += 1;
    }
    return n;
}

function confirmedMismatch(review, confirmed, keyOf) {
    if (!confirmed) return 0;
    const diffOf = (serverKeys, pageKeys) => {
        const a = new Set(serverKeys); const b = new Set(pageKeys || []);
        let c = 0;
        for (const k of a) if (!b.has(k)) c += 1;
        for (const k of b) if (!a.has(k)) c += 1;
        return c;
    };
    return diffOf((review.updated || []).map(keyOf.updated), confirmed.updated)
        + diffOf((review.added || []).map(keyOf.added), confirmed.added)
        + diffOf((review.removed || []).filter((m) => !m.notInstalled).map(keyOf.removed), confirmed.removed);
}

// ---- Collection rules: revision to revision (2026-10-24) ----
// A stable text key for one authored rule of a collection revision: type, the source file and the reference file.
function ruleKey(rule) {
    const part = (o) => (o && (o.fileMD5 || o.logicalFileName || o.fileExpression || o.id)) || '?';
    return String(rule && rule.type) + '|' + part(rule && rule.source) + '|' + part(rule && rule.reference);
}

// How the authored rules of the new revision split, for the log and the report (it decides nothing: every wanted rule is
// still verified against the mod list in hand, because the previous apply may not have saved a rule it meant to):
//   unchangedUntouched: the same rule in the previous revision and neither mod was replaced by this apply;
//   touchReplaced: the rule touches a mod this apply updated, added or removed;
//   changed: new in this revision (or changed).
// resolveSource / resolveReference -> a live Vortex mod key or null; touchedIds: Set of live keys the apply replaced.
function computeRuleStats({ modRules, previousKeys, touchedIds, resolve }) {
    const stats = { unchangedUntouched: 0, touchReplaced: 0, changed: 0 };
    for (const rule of modRules || []) {
        const s = resolve(rule.source); const r = resolve(rule.reference);
        const touches = (s && touchedIds.has(s)) || (r && touchedIds.has(r));
        if (touches) stats.touchReplaced += 1;
        else if (previousKeys && previousKeys.has(ruleKey(rule))) stats.unchangedUntouched += 1;
        else stats.changed += 1;
    }
    return stats;
}

module.exports = {
    ruleKey, computeRuleStats,
    countReviewDifferences, confirmedMismatch, ruleIdentitiesOf, computeLiveGroups, buildUnfinishedList, stillOpen, dependencyAckKey };
