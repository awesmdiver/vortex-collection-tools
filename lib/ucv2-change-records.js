'use strict';
// What each Update Collection apply did to a collection (2026-10-25): which mods the new revision removed, updated
// and added, and for every removal whether it finished. Kept inside the collection's existing apply record
// (ucv2-apply-status.json, "changeRecords", newest last on disk) so there is no second place to look.
//
// Why the finish status matters: Vortex shows an old mod as "Uninstalled", half-removed or still installed after a
// time-out, so what Vortex shows can never prove the main collection dropped a mod. This record is the proof: it
// says what the new revision's list dropped, apart from what Vortex ended up showing.
//
// Pure functions only; the runner owns the file reads and writes.

const MAX_RECORDS = 25;

// A mod's stable identity: Nexus page id, file id, content hash when known, plus name and version.
function identityOf(mod) {
    const s = (mod && mod.source) || {};
    const id = { name: mod.name || null, version: mod.version != null ? String(mod.version) : null };
    if (s.modId != null) id.modId = String(s.modId);
    if (s.fileId != null) id.fileId = String(s.fileId);
    if (s.md5) id.md5 = s.md5;
    return id;
}

function updatedIdentity(pair) {
    const from = identityOf(pair.old);
    const to = identityOf(pair.new);
    const out = { name: to.name || from.name, fromVersion: from.version, toVersion: to.version };
    if (to.modId != null || from.modId != null) out.modId = to.modId ?? from.modId;
    if (from.fileId != null) out.fromFileId = from.fileId;
    if (to.fileId != null) out.toFileId = to.fileId;
    if (to.md5) out.md5 = to.md5;
    return out;
}

// A time-out (or Vortex not answering) reads differently from an outright error; both are "not finished".
const TIMEOUT_RE = /time.?out|timed out|couldn.?t confirm|did not answer|didn.?t answer|stopped answering|blocking/i;

function removalOutcome(mod, result) {
    if (!result) {
        // Nothing recorded for it: a mod that was never installed has nothing to remove; any other is unconfirmed.
        return mod.notInstalled ? { status: 'finished' } : { status: 'not finished', reason: 'error', detail: 'No result was recorded for this removal.' };
    }
    if (result.action === 'kept') return { status: 'kept' };
    if (result.action === 'ignored-skipped') return { status: 'kept', reason: 'ignored' };
    if (result.ok === true) return { status: 'finished' };
    const detail = result.error ? String(result.error) : null;
    return { status: 'not finished', reason: detail && TIMEOUT_RE.test(detail) ? 'timeout' : 'error', ...(detail ? { detail } : {}) };
}

// review: the apply's review ({removed, updated, added, ...}); results arrays as runApply builds them.
function buildChangeRecord({ collection, fromRevision, toRevision, review, removedResults, appliedAt }) {
    const results = removedResults || [];
    const byName = new Map(results.map((r) => [r.name, r]));
    return {
        collection: { id: collection && collection.id != null ? String(collection.id) : null, name: (collection && collection.name) || null },
        fromRevision: fromRevision ?? null,
        toRevision: toRevision ?? null,
        appliedAt: appliedAt || new Date().toISOString(),
        removed: (review.removed || []).map((m) => ({ ...identityOf(m), ...removalOutcome(m, byName.get(m.name)) })),
        updated: (review.updated || []).map(updatedIdentity),
        added: (review.added || []).map(identityOf),
    };
}

// Adds one record to a saved list, keeping the newest MAX_RECORDS. The same revision pair applied again replaces the
// older entry, except the optional-mods pass that follows an apply (it only adds): that one adds its mods to the entry.
function appendChangeRecord(existing, record) {
    const list = Array.isArray(existing) ? existing : [];
    const same = (r) => r && r.toRevision === record.toRevision && r.fromRevision === record.fromRevision;
    const onlyAdds = record.removed.length === 0 && record.updated.length === 0;
    const prior = list.find(same);
    if (prior && onlyAdds) {
        const have = new Set((prior.added || []).map((m) => `${m.modId}:${m.fileId}:${m.name}`));
        const extra = record.added.filter((m) => !have.has(`${m.modId}:${m.fileId}:${m.name}`));
        return list.map((r) => (r === prior ? { ...prior, added: [...(prior.added || []), ...extra] } : r)).slice(-MAX_RECORDS);
    }
    return [...list.filter((r) => !same(r)), record].slice(-MAX_RECORDS);
}

// Newest first, for other tools.
function sortNewestFirst(records) {
    return (Array.isArray(records) ? records : []).slice()
        .sort((a, b) => String(b.appliedAt || '').localeCompare(String(a.appliedAt || '')));
}

// A later check confirmed these removals really finished (names): flips them in the newest record that lists them.
function markRemovalsFinished(records, names) {
    const want = new Set(names);
    const list = Array.isArray(records) ? records.map((r) => ({ ...r, removed: (r.removed || []).slice() })) : [];
    for (let i = list.length - 1; i >= 0; i -= 1) {
        let touched = false;
        list[i].removed = list[i].removed.map((m) => {
            if (m.status !== 'not finished' || !want.has(m.name)) return m;
            touched = true;
            const { reason, detail, ...rest } = m;
            return { ...rest, status: 'finished' };
        });
        if (touched) break;
    }
    return list;
}

function countUnfinishedRemovals(record) {
    return ((record && record.removed) || []).filter((m) => m.status === 'not finished').length;
}

module.exports = { buildChangeRecord, appendChangeRecord, sortNewestFirst, markRemovalsFinished, countUnfinishedRemovals, removalOutcome, MAX_RECORDS };
