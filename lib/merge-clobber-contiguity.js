'use strict';
// findClobberContiguityViolation (mergeLoadService.js:44-65, `notContiguous`) -- Clobber ONLY.
// Clobber renumbers each selected plugin using ITS OWN real load-order slot as the renumber base
// (recordMergingService.js:82-97) -- if some OTHER, non-selected closure member (a shared master, or
// an unrelated mod pulled in for some other reason) sits BETWEEN two selected plugins in the real
// game load order, those slots aren't truly contiguous once the selected plugins get disabled/
// removed post-merge. zMerge refuses outright rather than build something broken; this ports that
// exact refusal. orderedNames is the closure-in-real-load-order (== zMerge's own real merge.loadOrder,
// which editMergePlugins.js:35-36 builds the SAME way: the full active game load order, filtered down
// to just this merge's own selected + required-master closure, order preserved) -- itemNamesLower is
// the user's directly SELECTED files only, lowercased (== merge.plugins), never the pulled-in masters.
//
// A separate, tiny module (not inlined in lib/merge-v2-worker.js) purely so this pure-logic piece can
// be unit-tested directly -- that file's own main() runs unconditionally on require (it's a spawned
// worker script, never meant to be required as a library), so requiring it for a test would try to
// read real stdin.
function findClobberContiguityViolation(orderedNames, itemNamesLower) {
    let started = false;
    for (const name of orderedNames) {
        const isItem = itemNamesLower.has(name.toLowerCase());
        if (started && !isItem) return name;
        started = isItem;
    }
    return null;
}

module.exports = { findClobberContiguityViolation };
