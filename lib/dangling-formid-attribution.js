'use strict';
// Detection + attribution for the dangling-FormID Merge Plugins v2 crash -- see
// diagnostics/dangling-formid-merge-crash/root-cause-findings-2026-08-26.md for the full
// investigation this is built on (root cause confirmed against real game files, not guessed).
//
// The crash itself is a native XEditLib.dll access violation during a real merge's CopyElement call,
// when a selected plugin's own placed record references an object index that was never a real
// record in its own declared master -- confirmed real: Zelies Handplaced Dwemer Fairies.esp has 3
// such broken references (Irkngthand Sanctuary / Temple of Xrib / Mzinchaleft Gatehouse), none of
// which exist in its own master, Dwemer Fairies.esp. Nothing in the JS layer ever catches this as a
// normal exception (the whole worker process dies) -- this module works PURELY from the crash's own
// aftermath: the xelib_log.txt tail lib/merge-v2-runner.js already captures for the failure-log file,
// plus a read-only re-scan of the plugins the user actually selected (the worker that would have had
// xelib loaded is already gone by the time this runs, so this is deliberately xelib-free, same
// raw-bytes technique the root-cause investigation itself used).
//
// Detection ONLY (never Review/Analyze) -- see the findings doc's own "Why Review/Analyze doesn't hit
// this at all" section: Analyze never resolves embedded FormID references into a new file's own
// numbering, so this exact crash class is structurally unreachable from that path. The caller
// (lib/merge-v2-runner.js) is responsible for only invoking this on a real merge, not an analyze run.

const fs = require('fs');
const { readPluginHeader, TES4_HEADER_SIZE } = require('./esp-header');
const { walkRecordFormIds } = require('./esp-light-flag');

// ---- Step 1: detection ------------------------------------------------------------------------

// The exact 3-part signature confirmed real (diagnostics/dangling-formid-merge-crash/
// 2026-08-26-merge-failure-real-crash.log, lines 27-29 -- repeats verbatim, twice per broken record,
// once each in the real fixture for Irkngthand Sanctuary/Temple of Xrib/Mzinchaleft Gatehouse):
//   Failed to allocate string buffer.  source: [REFR:0E000805] (places [0600080B]
//     < Error: Could not be resolved > in GRUP Cell Temporary Children of Irkngthand04
//     "Irkngthand Sanctuary" [CELL:000466CB]), maxLen: 94, error: Found buffer length 94, expected 155.
// Each xelib_log.txt line is one single (long) line, not wrapped -- readXelibLogTail's own
// lines.slice/join already preserves that. Anchored on "Failed to allocate string buffer" +
// "Could not be resolved" (the two phrases that together are specific to this exact crash class) so
// this never accidentally fires on some OTHER xelib_log.txt line that happens to mention a CELL in
// quotes for an unrelated reason. Deliberately narrow, matching only what was actually observed --
// see the findings doc's own "Not investigated further" section: a differently-shaped dangling
// reference (a non-REFR record, a different subrecord) may need a looser pattern if one is ever seen.
const DANGLING_LINE_RE = /Failed to allocate string buffer\..*?Could not be resolved.*?"([^"]+)"\s*\[CELL:([0-9A-Fa-f]{8})\]/g;

// Returns a deduped list of { formId (uppercase hex string), name } in first-seen order -- a broken
// record with 2 raw log lines (confirmed real: every occurrence in the fixture repeats exactly
// twice) counts once, keyed by CELL id, not by line.
function detectDanglingFormidCells(xelibTail) {
    if (!xelibTail) return [];
    const seen = new Map();
    for (const m of xelibTail.matchAll(DANGLING_LINE_RE)) {
        const [, name, formId] = m;
        const key = formId.toUpperCase();
        if (!seen.has(key)) seen.set(key, { formId: key, name });
    }
    return [...seen.values()];
}

// ---- Step 2: attribution -----------------------------------------------------------------------

// Object index = the low 24 bits of the CELL's own 32-bit FormID (its top byte is a load-order/file
// slot that's meaningless outside the crashed xelib session -- see the findings doc's own "One log
// detail that should NOT be trusted" section for why the SIMILAR-looking file-slot byte on the
// separate "FormID [...] references a master..." line is actively untrustworthy; this is a
// different, safe value -- the CELL's own object index, read directly off the CELL: token itself,
// never inferred from xelib's own confused state).
function objectIndexFromFormId(formIdHex) {
    return parseInt(formIdHex, 16) & 0xffffff;
}

// Read-only, defensive: a plugin file that fails to parse for ANY reason (missing, not a real
// plugin, compressed TES4, truncated/malformed body) just doesn't match -- never throws, since this
// runs inside crash-handling and must never itself become a second crash. Matches on the low 24 bits
// of EVERY record's own FormID (both new records and overrides of a declared master alike -- an
// object index collision either way is a genuine match; this only needs "does this file contain a
// record at this object index", not "is it a new record" the way esp-light-flag.js's own
// scanLightPluginValidity needs).
function pluginContainsObjectIndex(fullPath, objectIndex) {
    try {
        const header = readPluginHeader(fullPath);
        if (!header || header.compressed) return false;
        const bodyStart = TES4_HEADER_SIZE + header.dataSize;
        const stat = fs.statSync(fullPath);
        const bodyLength = Math.max(0, stat.size - bodyStart);
        if (bodyLength === 0) return false;
        const fd = fs.openSync(fullPath, 'r');
        let buf;
        try {
            buf = Buffer.alloc(bodyLength);
            fs.readSync(fd, buf, 0, bodyLength, bodyStart);
        } finally {
            fs.closeSync(fd);
        }
        let found = false;
        walkRecordFormIds(buf, 0, buf.length, (formId) => {
            if ((formId & 0xffffff) === objectIndex) found = true;
        });
        return found;
    } catch {
        return false;
    }
}

// items: the ORIGINAL selected plugins for this merge (input.items inside runMergeV2Isolated --
// {fullPath, fileName, ...}). cells: detectDanglingFormidCells's own output.
//
// Per-record rule (the findings doc's own explicit call): exactly ONE selected plugin containing
// this object index -> attribute this record to it; zero or more than one -> this record's own
// attribution is unknown. Whole-crash rule: every record attributes to the SAME single plugin ->
// name it (Variant 1); any unknown, or different records naming different plugins -> Variant 2
// (name no one, rather than guess wrong).
function attributeDanglingFormids(cells, items) {
    let singlePlugin = null;
    let ambiguous = false;
    for (const cell of cells) {
        const objectIndex = objectIndexFromFormId(cell.formId);
        const matches = (items || []).filter((it) => it.fullPath && pluginContainsObjectIndex(it.fullPath, objectIndex));
        if (matches.length !== 1) {
            ambiguous = true;
            continue;
        }
        const name = matches[0].fileName;
        if (singlePlugin === null) singlePlugin = name;
        else if (singlePlugin !== name) ambiguous = true;
    }
    return ambiguous ? null : singlePlugin;
}

// ---- Step 3: message ---------------------------------------------------------------------------

function oxfordJoin(names) {
    if (names.length === 1) return names[0];
    if (names.length === 2) return `${names[0]} and ${names[1]}`;
    return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

// Exact, Gemini-reviewed wording (queue: dangling-formid-message-gemini-pass) -- converted to this
// codebase's own plain-ASCII convention (-- not an em dash, straight quotes not curly) per that
// review's own conversion note. Do not reintroduce smart typography here.
function buildDanglingFormidMessage(pluginName, locations) {
    const count = locations.length;
    const objectNoun = count === 1 ? 'object' : 'objects';
    const verb = count === 1 ? 'points' : 'point';
    const pronoun = count === 1 ? 'it' : 'them';
    const locationsText = oxfordJoin(locations);
    if (pluginName) {
        return `${pluginName} references game content that doesn't actually exist -- ${count} placed ${objectNoun} `
            + `(in ${locationsText}) ${verb} to something missing from one of its required files. That's an issue `
            + `inside the plugin's own data, not something this merge can fix. Try running the merge without it, `
            + `or let the author know.`;
    }
    return `One of these plugins references game content that doesn't actually exist -- ${count} placed ${objectNoun} `
        + `(in ${locationsText}) ${verb} to something missing from a required file, but it's not clear which plugin `
        + `owns ${pronoun}. That's an issue in the plugin data itself, not something this merge can fix. Try `
        + `merging them one at a time to narrow it down, or let the authors know.`;
}

// ---- Orchestration -------------------------------------------------------------------------------

// The one entry point lib/merge-v2-runner.js's crash branch calls. Returns null when the tail
// doesn't match this crash class at all (a different crash cause -- fall through to the existing
// generic CRASH_HELP_TEXT unchanged, this detection is purely additive). Returns a structured result
// otherwise, matching the shape the findings doc itself proposed handing to the design side.
function describeDanglingFormidCrash(xelibTail, items) {
    const cells = detectDanglingFormidCells(xelibTail);
    if (cells.length === 0) return null;
    const pluginName = attributeDanglingFormids(cells, items);
    const locations = cells.map((c) => c.name);
    return {
        code: 'DANGLING_FORMID_REFERENCE',
        affectedPluginNames: pluginName ? [pluginName] : (items || []).map((it) => it.fileName),
        affectedLocations: locations,
        affectedCount: locations.length,
        message: buildDanglingFormidMessage(pluginName, locations),
    };
}

module.exports = {
    detectDanglingFormidCells,
    objectIndexFromFormId,
    pluginContainsObjectIndex,
    attributeDanglingFormids,
    buildDanglingFormidMessage,
    describeDanglingFormidCrash,
};
