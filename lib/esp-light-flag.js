'use strict';
// Real "Flag as Light" for an EXISTING merged plugin -- mirrors Vortex's own real mechanism exactly
// (extensions/gamebryo-plugin-management/src/esp/ESPFile.ts's setLightFlag, in the real Vortex
// checkout at F:\Claude Workspace\vortex-tools\vortex, read directly rather than guessed): a pure
// 4-byte flag read/write at header offset 8, bit 0x200 (FLAG_LIGHT_MASTER, already confirmed in
// esp-header.js against real files). CONFIRMED EMPIRICALLY 2026-08-24 (prompts/queue.json's own
// "merge-flag-as-light" item): a direct byte comparison of a real merge output against the SAME file
// after Vortex's own Mark as Light was clicked on it showed exactly ONE byte differing -- offset 9
// (the flags DWORD's second byte), 0x00 -> 0x02 -- and nothing else. setLightFlag below reproduces
// that exact single-byte diff.
//
// Vortex only lets its own toggle fire when LOOT's real FormID-range analysis
// (isValidAsLightPlugin, sourced from libloot's native getPluginAsync -- Vortex's own JS never
// reimplements this check itself, it's delegated to the native library) says the plugin's own new
// records already fit the light-legal range. This app has no equivalent native LOOT binding, so
// scanLightPluginValidity below is a from-scratch equivalent: a real, non-guessed FormID-range scan
// against docs/reference-esp-vs-esl.md's own documented rule -- not a proxy like a record-count
// estimate (see this module's own header note on lib/merge-v2-worker.js's allocation scheme below).
//
// Confirmed against this app's OWN merge engine's real FormID allocation
// (lib/merge-v2-worker.js's refactorReferences) before writing this scan, not assumed: a record that
// doesn't collide with another merged plugin's own fid keeps its ORIGINAL local FormID completely
// unchanged (just re-prefixed with the merged file's own master-index byte) -- that original value
// can be anywhere in the full 24-bit range, nothing about this engine's own allocation scheme
// constrains it to the light-legal range on its own. A record that DOES collide gets renumbered
// starting at 0x000801, incrementing with no upper bound of its own either. So "under 4,096 new
// records" (the existing Review-step estimate, web/public/merge-app.js's totalNewRecords) is
// necessary but NOT sufficient -- this module is the real check the roadmap research called for,
// scanning the actual finished file rather than trusting that estimate.

const fs = require('fs');
const { readPluginHeader, TES4_HEADER_SIZE, FLAG_LIGHT_MASTER } = require('./esp-header');

// SSE 1.6.1130+ expanded the light-plugin record limit from 2,048 (0x7FF) to 4,096 (0xFFF) --
// docs/reference-esp-vs-esl.md's own documented rule. This app's own target runtime is SKSE
// 1.6.1170 (well past 1.6.1130 -- see the project's own memory/CLAUDE.md notes on the installed
// SKSE version), so 0xFFF is the correct limit here, not the older 0x7FF.
const LIGHT_FORMID_LIMIT = 0xFFF;

// Walks every record in the plugin body (the bytes after the TES4 record), recursing into GRUPs,
// without decoding any record's own subrecord contents -- every field this needs (dataSize, formID)
// lives in each record's own fixed 24-byte header, whether or not that record's DATA is zlib-
// compressed (the compressed flag only affects the bytes AFTER this header, never the header
// itself). GRUP and record headers are both exactly 24 bytes, coincidentally, which is why one loop
// handles both: a GRUP's own "groupSize" already includes its own 24-byte header, same as a record's
// "dataSize" is added ON TOP of its own 24-byte header to find the next sibling.
function walkRecordFormIds(buf, start, end, onFormId) {
    let offset = start;
    while (offset + 24 <= end) {
        const sig = buf.toString('ascii', offset, offset + 4);
        if (sig === 'GRUP') {
            const groupSize = buf.readUInt32LE(offset + 4);
            if (groupSize < 24 || offset + groupSize > end) return; // malformed/truncated -- stop safely, don't guess past it
            walkRecordFormIds(buf, offset + 24, offset + groupSize, onFormId);
            offset += groupSize;
        } else {
            const dataSize = buf.readUInt32LE(offset + 4);
            if (offset + 24 + dataSize > end) return; // malformed/truncated
            const formId = buf.readUInt32LE(offset + 12);
            onFormId(formId);
            offset += 24 + dataSize;
        }
    }
}

// Real FormID-range validity check for an EXISTING, already-built plugin file -- the equivalent of
// LOOT's own isValidAsLightPlugin, computed from scratch against the actual bytes on disk rather
// than a native library this app has no binding for. A record belongs to the plugin ITSELF (as
// opposed to being an override of one of its declared masters) exactly when its FormID's own top
// byte equals the plugin's own master count -- the standard Bethesda convention (master index
// 0..N-1 for the N declared masters, N for the plugin itself) -- so this needs no separate
// new-vs-override bookkeeping the way the merge engine itself does; the byte value alone is enough.
//
// Returns { eligible, newRecordCount, maxLocalFormId, limit }. Throws if the file isn't a readable
// plugin, or its own TES4 record is compressed (essentially never true in practice for a real file;
// same "skip, don't guess" stance esp-header.js's own readPluginHeader already takes for that case).
function scanLightPluginValidity(filePath) {
    const header = readPluginHeader(filePath);
    if (!header) throw new Error(`"${filePath}" doesn't look like a valid plugin file.`);
    if (header.compressed) throw new Error(`"${filePath}"'s own TES4 record is compressed -- can't scan it.`);
    const masterCount = header.masters.length;
    const bodyStart = TES4_HEADER_SIZE + header.dataSize;

    const stat = fs.statSync(filePath);
    const fd = fs.openSync(filePath, 'r');
    let buf;
    try {
        const bodyLength = Math.max(0, stat.size - bodyStart);
        buf = Buffer.alloc(bodyLength);
        if (bodyLength > 0) fs.readSync(fd, buf, 0, bodyLength, bodyStart);
    } finally {
        fs.closeSync(fd);
    }

    let newRecordCount = 0;
    let maxLocalFormId = 0;
    let overLimit = false;
    walkRecordFormIds(buf, 0, buf.length, (formId) => {
        if ((formId >>> 24) !== masterCount) return; // an override of a master's own record, not new
        newRecordCount++;
        const local = formId & 0x00ffffff;
        if (local > maxLocalFormId) maxLocalFormId = local;
        if (local > LIGHT_FORMID_LIMIT) overLimit = true;
    });

    return { eligible: !overLimit, newRecordCount, maxLocalFormId, limit: LIGHT_FORMID_LIMIT };
}

// The actual write -- byte-for-byte the same shape as Vortex's own ESPFile.setLightFlag (read the
// 4-byte flags DWORD at header offset 8, flip bit 0x200, write it back). No validity check of its
// own -- the caller (the /flag-as-light route) is responsible for gating on scanLightPluginValidity
// first, same as Vortex's own UI never lets setLightFlag fire until isValidAsLightPlugin already said
// yes. `enabled: false` (unflag) needs no gate either way -- removing the flag is always safe, same
// as Vortex's own "Mark as Regular" -- though nothing in this app currently calls it with false; it's
// symmetric because the real mechanism is, not because an unflag action is wired up yet.
function setLightFlag(filePath, enabled) {
    const fd = fs.openSync(filePath, 'r+');
    try {
        const flagBuf = Buffer.alloc(4);
        fs.readSync(fd, flagBuf, 0, 4, 8);
        let flags = flagBuf.readUInt32LE(0);
        flags = enabled ? (flags | FLAG_LIGHT_MASTER) : (flags & ~FLAG_LIGHT_MASTER);
        flagBuf.writeUInt32LE(flags >>> 0, 0);
        fs.writeSync(fd, flagBuf, 0, 4, 8);
    } finally {
        fs.closeSync(fd);
    }
}

// walkRecordFormIds exported 2026-08-27 (dangling-FormID merge-crash attribution) -- the exact same
// raw-bytes GRUP walk lib/dangling-formid-attribution.js needs to check which selected plugin owns a
// given object index, reused rather than duplicated (this is the same technique that investigation's
// own root-cause script used, see diagnostics/dangling-formid-merge-crash/root-cause-findings-
// 2026-08-26.md).
module.exports = { scanLightPluginValidity, setLightFlag, walkRecordFormIds, LIGHT_FORMID_LIMIT };
