'use strict';
// Pure grouping logic for Update Collection v2's Apply-result "problems" callout (2026-08-28,
// director's own call, real screenshot: 17 Remove failures under one generic "Applied with some
// problems" title read as a wall of repeated "Remove --" lines). Split out into its own file, no DOM
// dependency at all, so it can be a plain require()-able Node module for a real regression test AND
// a plain classic <script> global for update-collection-v2-app.js's own rendering -- same dual-
// context pattern status-labels.js already established (see that file's own header comment).
//
// Only the six PER-MOD categories get grouped under their own heading -- Update/Remove/Add/
// Keep disabled/Dependency warning/Delete archive. Collection rules/record/membership are
// collection-level (at most one or two entries, each already carrying its own specific message and
// Retry button) and stay ungrouped, rendered exactly as before.
const UCV2_GROUPED_PROBLEM_LABELS = ['Update', 'Remove', 'Add', 'Keep disabled', 'Dependency warning', 'Delete archive'];

// Plain-language heading per grouped category -- drafted here, flagged for a real Gemini pass before
// being treated as final (queue: apply-problems-grouped-headings-gemini-pass), same as any other
// substantial user-facing warning/status copy in this project.
const UCV2_PROBLEM_GROUP_HEADINGS = {
    Update: "These mods couldn't be updated. Retry them below.",
    Remove: "These mods couldn't be removed. Remove them manually in Vortex.",
    Add: "These mods couldn't be added. Retry them below.",
    'Keep disabled': "These mods couldn't be set back to Disabled. Disable them manually in Vortex.",
    'Dependency warning': "These dependency warnings couldn't be recorded.",
    'Delete archive': "These archives couldn't be deleted. Delete them manually if you no longer need them.",
};

// Cross-cutting hash-mismatch group (2026-09-04, director's own exact wording) -- pulled out of the
// normal Update/Add grouping by `p.code === 'HASH_MISMATCH'`, REGARDLESS of which operation (Update
// or Add) it came from. This is now the ONLY way a real HASH_MISMATCH reaches this screen at all:
// rebuildSingleMod already deletes the mismatched file and tries a real fresh redownload first (see
// that function's own header comment) -- a mod only lands here once that redownload has ALSO been
// attempted and STILL didn't match, a genuinely persistent/confirmed problem, not a stale-local-copy
// one. Director's own exact text, shown ONCE for the whole group (not repeated per line) -- a real
// title + explanation, unlike every other group's single heading line, hence `body` and
// `suppressMessage` as new (optional, additive) fields on a group -- every OTHER existing group
// leaves both unset and renders exactly as before.
const HASH_MISMATCH_GROUP_TITLE = '⚠️ File Hash Mismatch';
const HASH_MISMATCH_GROUP_BODY = "The downloaded archive's hash does not match the checksum "
    + 'provided by the mod author. The file may be corrupted, modified, or out of date. Please '
    + 're-download the archive or verify the file source.';

// Splits a flat `problems` array (each {label, name, message, retry, code}, same shape
// update-collection-v2-app.js's own pushProblem already builds) into:
//   - groups: one entry per grouped category that actually has at least one problem. The
//     cross-cutting hash-mismatch group (if any) always comes FIRST, then the six per-operation
//     categories in UCV2_GROUPED_PROBLEM_LABELS' own fixed order (not insertion order -- a stable,
//     predictable reading order regardless of which categories happen to fail), each
//     { label, heading, items } (hash-mismatch also carries `body`/`suppressMessage`).
//   - ungrouped: every remaining problem (Collection rules/record/membership today, and any future
//     label this project adds without also adding it to UCV2_GROUPED_PROBLEM_LABELS), in original
//     order, untouched.
// Pure -- no DOM, no I/O, safe to call from a plain Node test or the browser alike.
function ucv2GroupProblems(problems) {
    const hashMismatchItems = problems.filter((p) => p.code === 'HASH_MISMATCH');
    const rest = problems.filter((p) => p.code !== 'HASH_MISMATCH');

    const byLabel = new Map();
    const ungrouped = [];
    for (const p of rest) {
        if (!UCV2_GROUPED_PROBLEM_LABELS.includes(p.label)) {
            ungrouped.push(p);
            continue;
        }
        if (!byLabel.has(p.label)) byLabel.set(p.label, []);
        byLabel.get(p.label).push(p);
    }
    const groups = UCV2_GROUPED_PROBLEM_LABELS
        .filter((label) => byLabel.has(label))
        .map((label) => ({ label, heading: UCV2_PROBLEM_GROUP_HEADINGS[label], items: byLabel.get(label) }));
    if (hashMismatchItems.length > 0) {
        groups.unshift({
            label: 'Hash mismatch', heading: HASH_MISMATCH_GROUP_TITLE, body: HASH_MISMATCH_GROUP_BODY,
            suppressMessage: true, items: hashMismatchItems,
        });
    }
    return { groups, ungrouped };
}

// Dual-context: a plain classic <script> in the browser (declares these as page globals, `module` is
// undefined there) AND a plain require()-able CommonJS module in Node (used by
// scripts/test-ucv2-group-problems.js) -- same pattern status-labels.js already established.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        ucv2GroupProblems, UCV2_GROUPED_PROBLEM_LABELS, UCV2_PROBLEM_GROUP_HEADINGS,
        HASH_MISMATCH_GROUP_TITLE, HASH_MISMATCH_GROUP_BODY,
    };
}
