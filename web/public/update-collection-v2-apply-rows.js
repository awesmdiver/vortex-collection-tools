'use strict';
// Row bookkeeping for Update Collection v2's Apply Progress screen (2026-09-28) -- pure logic, no DOM,
// so it's a plain require()-able Node module for a real regression test AND a classic <script> global
// for update-collection-v2-app.js (same dual-context pattern update-collection-v2-apply-pills.js and
// update-collection-v2-problem-grouping.js already use). The app file keeps only the thin DOM glue that
// carries out the "ops" this returns.
//
// Why this exists (real run, 2026-09-27, "Body Swap Updated for GTS" rev 33 -> 34): the run succeeded
// (added=45ok/0fail) but several added rows still read "Download pending" once it was done -- e.g.
// "khajiit overhaul MR patch.7z", which the log shows really was installed. Rows were looked up by ONE
// key in a Map<key, row>, and a row only ever changed when a live frame for that exact key arrived, so:
//   - two rows sharing a key overwrote each other in the Map -- the first one could never update;
//   - a row whose key the server never sent (the server re-reviews the collection right before it
//     writes anything and can process a slightly different set than the review the rows were drawn
//     from) simply never changed;
//   - and nothing ever looked at the run's own results to fix up whatever was left.
// Now: every row is addressed by its position, a frame updates EVERY not-yet-finished row that shares
// its key (falling back to a unique name match), and settle() gives every row still standing its real
// final state from the run's own results -- installed / updated / removed / failed, or, if the run
// never touched it, an honest "Not included" -- so no row can end on "Download pending".

const UCV2_ROW_KIND_TO_RESULTS = { update: 'updatedResults', add: 'addedResults', remove: 'removedResults' };

// What settle() shows for a row the run never got to, per the row's own kind.
const UCV2_NOT_INCLUDED_LABEL = 'Not included';
const UCV2_NOT_INCLUDED_TITLE = "This update didn't include this mod.";

function ucv2CreateApplyRowTracker(rows) {
  const byKey = new Map();
  const byName = new Map();
  const state = rows.map(() => 'open'); // 'open' | 'done' | 'failed' | 'not-included'
  rows.forEach((r, i) => {
    const k = String(r.modKey);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(i);
    const n = r.name || '';
    if (!byName.has(n)) byName.set(n, []);
    byName.get(n).push(i);
  });

  // Every row a frame is about: all rows that share its key and haven't reached a final state yet.
  // No row has that key at all -> a name match, but only when exactly one row carries that name (never guess).
  function rowsForFrame(modId, name, kind) {
    let hits = byKey.get(String(modId)) || [];
    if (kind) hits = hits.filter((i) => (rows[i].kind || 'add') === kind);
    if (hits.length === 0 && name) {
      const named = (byName.get(name) || []).filter((i) => !kind || (rows[i].kind || 'add') === kind);
      if (named.length === 1) hits = named;
    }
    return hits.filter((i) => state[i] === 'open');
  }

  const PHASE_PILL = {
    downloading: ['downloading', 'Downloading…'],
    installing: ['extracting', 'Extracting…'],
    'pending-install': ['pending-install', 'Pending install'],
    'batch-installing': ['installing', 'Installing…'],
  };

  // A live SSE frame -> the list of things to do to rows. Ops: {op:'pill', index, key, label, title?},
  // {op:'top', index}, {op:'remove', index} (row finished fine -- fade it out), {op:'failed', index,
  // error, status} (the app picks the label, it owns the status-text table).
  function apply(frame) {
    const ops = [];
    if (frame.type === 'mod-start') {
      if (frame.kind === 'remove') {
        for (const index of rowsForFrame(frame.modId, frame.name, 'remove')) {
          ops.push({ op: 'top', index }, { op: 'pill', index, key: 'removing', label: 'Removing…' });
        }
      }
    } else if (frame.type === 'mod-phase') {
      const [key, label] = PHASE_PILL[frame.phase] || ['pending', 'Working…'];
      for (const index of rowsForFrame(frame.modId, frame.name)) {
        ops.push({ op: 'top', index }, { op: 'pill', index, key, label });
      }
    } else if (frame.type === 'mod-complete') {
      for (const index of rowsForFrame(frame.modId, frame.name, frame.kind === 'remove' ? 'remove' : null)) {
        if (frame.ok === false) {
          state[index] = 'failed';
          ops.push({ op: 'failed', index, error: frame.error || null, status: frame.status || null });
        } else {
          state[index] = 'done';
          ops.push({ op: 'remove', index });
        }
      }
    }
    return ops;
  }

  // The run's own results -> a final state for every row still open. `results` is the run's result object
  // (updatedResults/addedResults/removedResults, as runApply returns them and as the 'mods-settled' frame
  // carries them). Safe to call more than once; rows already final are left alone.
  function settle(results) {
    const ops = [];
    const res = results || {};
    rows.forEach((row, index) => {
      if (state[index] !== 'open') return;
      const kind = row.kind || 'add';
      const list = res[UCV2_ROW_KIND_TO_RESULTS[kind]] || [];
      const keyOf = (r) => String(r.modKey != null ? r.modKey : r.modId);
      let match = list.find((r) => keyOf(r) === String(row.modKey));
      if (!match && row.name) {
        const named = list.filter((r) => r.name === row.name);
        if (named.length === 1) match = named[0];
      }
      if (!match) {
        state[index] = 'not-included';
        ops.push({ op: 'pill', index, key: 'skipped', label: UCV2_NOT_INCLUDED_LABEL, title: UCV2_NOT_INCLUDED_TITLE });
      } else if (match.ok === false) {
        state[index] = 'failed';
        ops.push({ op: 'failed', index, error: match.error || null, status: match.status || null });
      } else {
        state[index] = 'done';
        ops.push({ op: 'remove', index });
      }
    });
    return ops;
  }

  return { apply, settle, stateOf: (i) => state[i], get size() { return rows.length; } };
}

// Tick rate of the Apply screen's silence check (ucv2StartApplyStallPolling in update-collection-v2-app.js; it
// asks Vortex nothing). ucv2NextApplyPollDelay is the back-off shape (double to a ceiling after a failed or slow
// answer, straight back after a quick one), kept as the shared reference for deploy-time polls.
const UCV2_APPLY_POLL_BASE_MS = 1000;
const UCV2_APPLY_POLL_MAX_MS = 15000;
const UCV2_APPLY_POLL_SLOW_MS = 3000;
function ucv2NextApplyPollDelay(currentDelay, ok, tookMs) {
  if (!ok || tookMs > UCV2_APPLY_POLL_SLOW_MS) return Math.min(currentDelay * 2, UCV2_APPLY_POLL_MAX_MS);
  return UCV2_APPLY_POLL_BASE_MS;
}

// What an Update row says about its version (2026-10-23). A row whose only change is the install options
// (same file, other picks) used to show just "FOMOD", which does not say whether the mod is an update at all.
// Now it shows the mod's version, a muted second line, and a tooltip on the Update chip saying what the work is.
// New words below need their Gemini pass.
const UCV2_PICKS_ONLY_NOTE = 'Same version \u00b7 install options changed';
const UCV2_PICKS_ONLY_TIP = 'This mod is already the newest version. Its install options changed, so it is installed again with the new choices.';
// u: a review.updated entry; fromLabel/toLabel: already-formatted version texts. Returns
// { versionText, versionNote, statusTooltip } -- a note and tooltip only for a picks-only row.
function ucv2UpdateRowParts(u, fromLabel, toLabel) {
  if (u.fileChanged === false) {
    return { versionText: toLabel, versionNote: UCV2_PICKS_ONLY_NOTE, statusTooltip: UCV2_PICKS_ONLY_TIP };
  }
  return { versionText: `${fromLabel} \u2192 ${toLabel}`, versionNote: '', statusTooltip: '' };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ucv2UpdateRowParts, UCV2_PICKS_ONLY_NOTE, UCV2_PICKS_ONLY_TIP,
    ucv2CreateApplyRowTracker, UCV2_NOT_INCLUDED_LABEL, UCV2_NOT_INCLUDED_TITLE,
    UCV2_APPLY_POLL_BASE_MS, UCV2_APPLY_POLL_MAX_MS, UCV2_APPLY_POLL_SLOW_MS, ucv2NextApplyPollDelay,
  };
}
