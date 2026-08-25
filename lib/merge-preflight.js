'use strict';
// Merge Plugins (The Forge) -- load-list resolution and pre-flight validation. Pure filesystem +
// header reads, NO xelib: this deliberately runs in the main server process, before
// lib/merge-runner.js spawns the isolated worker at all, so a merge that cannot possibly load never
// starts and never has to be diagnosed from a native crash.
//
// Root cause this exists to fix (2026-08-23, the director's own "Merge Plugins Test" run):
// lib/merge-worker.js's stageItems used to build its load list by walking the CHOSEN ITEMS' declared
// masters once, in discovery order, and handing that straight to xelib. Two independent defects fell
// out of that, both confirmed live:
//
//   1. ONE LEVEL DEEP. Masters were only ever read off the items. A master's OWN masters were never
//      resolved, so they were neither staged nor listed. Real example from that run:
//      LegacyoftheDragonborn.esm needs _ResourcePack.esl, and Unofficial Skyrim Special Edition
//      Patch.esp needs five Creation Club plugins -- none of which were anywhere in the load list.
//
//   2. DISCOVERY ORDER, NOT DEPENDENCY ORDER. lib/merge-worker.js's own loadAll() already documents
//      the hard requirement ("fileNames MUST list every master before any plugin that depends on
//      it"), but the list was ordered by whichever item happened to mention a master first. Masters
//      depend on other masters, and that order does not respect it. That is what actually killed the
//      director's run: BHTNFX.esp landed at slot 11 while its own master, Unofficial Skyrim Special
//      Edition Patch.esp, landed at slot 28 -- seventeen slots too late. xelib died with
//      "Exception loading BHTNFX.esp: System Error. Code: 2. The system cannot find the file
//      specified", naming a file that was sitting right there in the sandbox. The message is about
//      the unresolvable MASTER reference, not the plugin it names.
//
// resolveLoadList below fixes both: full transitive closure, then a topological sort. The pre-flight
// checks are a separate, additive safety net over the same resolved list -- see checkLoadList.

const fs = require('fs');
const path = require('path');
const { readPluginHeader } = require('./esp-header');

// One resolved entry per file that will be handed to xelib.
//   kind: 'item'   -- a chosen plugin, copied into the sandbox from its real staging folder
//         'master' -- a declared master, hardlinked/copied in from the real game Data folder, or
//                     stubbed with a zero-record dummy when it isn't installed at all
//   sourcePath: where the real file lives, or null when nothing was found (dummy territory)
//   masters: its own declared masters, or null when the header couldn't be read
function readMasters(sourcePath) {
    if (!sourcePath) return null;
    try {
        const header = readPluginHeader(sourcePath);
        if (!header) return null;
        // A compressed-header plugin reports masters: null -- genuinely unknown, not "none".
        return header.masters;
    } catch {
        return null;
    }
}

// Full transitive master closure, then a topological sort so every master precedes everything that
// depends on it.
//
// Cycles are impossible in a well-formed Bethesda master graph (a plugin cannot be its own
// ancestor), but a corrupt or hand-edited header could still produce one, and an infinite loop here
// would hang the whole merge. Kahn's algorithm handles that for free: anything still carrying
// unsatisfied dependencies when the queue drains is appended in discovery order and reported as a
// problem, rather than silently dropped or spun on forever.
//
// Ties are broken by discovery order (a stable sort), so an ordinary merge -- where nothing was
// mis-ordered to begin with -- comes out in the same order it always did.
function resolveLoadList(items, gameDataDir) {
    const entries = new Map(); // lowercased filename -> entry
    const cycles = [];

    for (const item of items) {
        const key = item.fileName.toLowerCase();
        if (entries.has(key)) {
            // Two chosen plugins sharing a filename -- lib/merge-worker.js's stageItems raises its
            // own user-facing error for this, and checkLoadList reports it too. Keep the first.
            continue;
        }
        entries.set(key, {
            fileName: item.fileName,
            kind: 'item',
            sourcePath: item.fullPath,
            modName: item.modName || null,
            masters: readMasters(item.fullPath),
        });
    }

    // Breadth-first closure over declared masters. A master already present as an ITEM is left as an
    // item (it's being merged, not staged from Data) -- the same precedence stageItems always used.
    const queue = [...entries.values()];
    while (queue.length) {
        const entry = queue.shift();
        for (const masterName of entry.masters || []) {
            const key = masterName.toLowerCase();
            if (entries.has(key)) continue;
            const realPath = gameDataDir ? path.join(gameDataDir, masterName) : null;
            const sourcePath = realPath && fs.existsSync(realPath) ? realPath : null;
            const added = {
                fileName: masterName,
                kind: 'master',
                sourcePath,
                modName: null,
                masters: readMasters(sourcePath),
            };
            entries.set(key, added);
            queue.push(added); // <- the recursion the old one-level walk never did
        }
    }

    // Kahn's algorithm. Edge master -> dependent; an entry is emitted once every master it declares
    // that is actually IN this list has already been emitted.
    const all = [...entries.values()];
    const remaining = new Map(all.map((e) => [e.fileName.toLowerCase(), new Set(
        (e.masters || []).map((m) => m.toLowerCase()).filter((k) => entries.has(k)),
    )]));
    const dependentsOf = new Map(all.map((e) => [e.fileName.toLowerCase(), []]));
    for (const e of all) {
        for (const k of remaining.get(e.fileName.toLowerCase())) {
            dependentsOf.get(k).push(e.fileName.toLowerCase());
        }
    }

    const order = [];
    // Discovery order preserved among entries that are equally ready -- see the stability note above.
    let ready = all.filter((e) => remaining.get(e.fileName.toLowerCase()).size === 0);
    const queued = new Set(ready.map((e) => e.fileName.toLowerCase()));
    while (ready.length) {
        const next = [];
        for (const entry of ready) {
            order.push(entry);
            for (const depKey of dependentsOf.get(entry.fileName.toLowerCase())) {
                const set = remaining.get(depKey);
                set.delete(entry.fileName.toLowerCase());
                if (set.size === 0 && !queued.has(depKey)) {
                    queued.add(depKey);
                    next.push(entries.get(depKey));
                }
            }
        }
        ready = next;
    }
    if (order.length < all.length) {
        for (const e of all) {
            if (!queued.has(e.fileName.toLowerCase())) {
                cycles.push(e.fileName);
                order.push(e);
            }
        }
    }

    return { order, cycles };
}

// Everything that can stop a plugin from loading, checked over the RESOLVED list (so it sees the
// staged masters too, not just the chosen items). Each problem carries a plain-language `detail`
// the UI shows verbatim -- see web/public/merge-app.js's own renderer.
//
// `blocking` is the judgement call worth knowing about: only a file that genuinely cannot be read at
// all stops the merge. A declared master that isn't installed is REPORTED but not blocking, because
// lib/merge-worker.js's stageMaster has always substituted a zero-record dummy for exactly that case
// and plenty of real merges depend on it working that way. Turning it into a hard stop would break
// merges that succeed today.
function checkLoadList(items, gameDataDir, activePluginNames) {
    const { order, cycles } = resolveLoadList(items, gameDataDir);
    const problems = [];

    const seenItemNames = new Set();
    for (const item of items) {
        const key = item.fileName.toLowerCase();
        if (seenItemNames.has(key)) {
            problems.push({
                fileName: item.fileName,
                kind: 'duplicate-name',
                blocking: true,
                detail: 'Two of the plugins you picked have this same file name, so only one of them can be merged. Remove one and try again.',
            });
        }
        seenItemNames.add(key);
    }

    const active = activePluginNames
        ? new Set(activePluginNames.map((n) => n.toLowerCase()))
        : null;

    for (const entry of order) {
        if (entry.kind === 'item') {
            if (!entry.sourcePath || !fs.existsSync(entry.sourcePath)) {
                problems.push({
                    fileName: entry.fileName,
                    kind: 'file-missing',
                    blocking: true,
                    detail: 'This plugin\'s file is no longer in your mods folder. It may have been removed or moved since the list was built. Refresh and pick your plugins again.',
                });
                continue;
            }
            if (entry.masters === null) {
                problems.push({
                    fileName: entry.fileName,
                    kind: 'unreadable',
                    blocking: true,
                    detail: 'This plugin\'s file couldn\'t be read. It may be damaged or incomplete. Reinstall the mod it came from, then try again.',
                });
            }
            continue;
        }
        // kind === 'master'
        if (!entry.sourcePath) {
            const activeNote = active && active.has(entry.fileName.toLowerCase())
                ? ' It\'s switched on in your load order, but the file itself isn\'t in your Data folder.'
                : '';
            problems.push({
                fileName: entry.fileName,
                kind: 'master-missing',
                blocking: false,
                detail: `Needed by the plugins you picked, but it isn't installed in your Data folder.${activeNote} The merge can still run, but anything that depends on this file may not carry over correctly.`,
            });
            continue;
        }
        if (entry.masters === null) {
            problems.push({
                fileName: entry.fileName,
                kind: 'unreadable',
                blocking: true,
                detail: 'This file is needed by the plugins you picked, but it couldn\'t be read. It may be damaged or incomplete. Reinstall the mod it came from, then try again.',
            });
        }
    }

    for (const fileName of cycles) {
        problems.push({
            fileName,
            kind: 'circular',
            blocking: true,
            detail: 'This plugin and one of the files it depends on each list the other as a requirement, which can\'t be loaded. Leave it out of the merge, or reinstall the mod it came from.',
        });
    }

    return { order, problems, blocked: problems.some((p) => p.blocking) };
}

module.exports = { resolveLoadList, checkLoadList };
