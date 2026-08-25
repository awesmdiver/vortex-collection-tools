'use strict';
// Minimal Bethesda plugin (.esp/.esm/.esl) TES4-record reader -- reads just enough to get a
// plugin's own master list (the MAST subrecords) and its record flags, nothing else. Built for the
// "Missing Masters" utility (see TECHNICAL.md's own section for the full design writeup) -- no
// existing code in this project reads raw plugin bytes, and Bethesda's format is small/stable
// enough (unchanged since Skyrim's original release) that a purpose-built reader beats pulling in
// a full ESP library just for this one narrow need.
//
// Verified against real files before being written, not assumed from memory (2026-07-27):
//   - TES4 record header is a fixed 24 bytes: signature(4) + dataSize(4) + flags(4) + formId(4) +
//     versionControlInfo(4) + formVersion(2) + unknown(2).
//   - Subrecords within that dataSize are signature(4) + size(2, uint16 LE) + data(size bytes),
//     confirmed by reading Dawnguard.esm's real TES4 body: HEDR, CNAM (author), then a MAST/DATA
//     pair per master ("Skyrim.esm"/"Update.esm"), each MAST immediately followed by an 8-byte
//     legacy DATA subrecord that's safe to skip over (not master-list-relevant).
//   - Real record-flags values confirmed by reading Update.esm/Dawnguard.esm (0x81 = Master 0x1 +
//     Localized 0x80) and ccbgssse002-exoticarrows.esl (0x281 = Master 0x1 + Localized 0x80 +
//     Light Master 0x200) -- an SSE light-master (.esl) plugin has BOTH the Master and Light
//     Master bits set together, not just 0x200 alone.

const fs = require('fs');

// Bethesda plugin strings are WINDOWS-1252, not ASCII (2026-08-23 fix). Node's 'ascii' decoder masks
// the high bit off every byte, so a master named "Café.esp" (0xE9) came back as "Cafi.esp" (0x69) --
// matching nothing on disk. Missing Masters then reported a master as missing while it sat right
// there; worse, Merge Plugins' own stageMaster() takes these names and CREATES FILES from them, so a
// mangled name meant the real master was never staged and an empty dummy was written under the wrong
// filename instead.
//
// Deliberately NOT plain 'latin1'. latin1 is byte-exact with Windows-1252 only across 0xA0-0xFF (the
// accented letters, and the realistic case); the two disagree across 0x80-0x9F, where Windows-1252
// puts typographic punctuation -- curly quotes, en/em dashes -- and latin1 puts C1 control
// characters. Those are legal in Windows filenames and do turn up in real mod names (a smart
// apostrophe, 0x92), and since this name is compared against readdir output, decoding it as U+0092
// instead of U+2019 fails the match exactly as ASCII did. Verified: 0x92 decodes to "’" here and to
// an invisible control character under latin1.
//
// TextDecoder covers the whole range correctly and needs no lookup table. It requires a full-ICU
// Node, which every official nodejs.org build is (and the release bundles one of those -- see
// build-release.ps1), but the fallback keeps a small-ICU build working at latin1's level rather than
// throwing: never worse than the behaviour this replaces.
const WIN1252_DECODER = (() => {
    try {
        return new TextDecoder('windows-1252');
    } catch {
        return null;
    }
})();

function decodeWin1252(buf, start, end) {
    return WIN1252_DECODER
        ? WIN1252_DECODER.decode(buf.subarray(start, end))
        : buf.toString('latin1', start, end);
}

const TES4_HEADER_SIZE = 24;
const FLAG_MASTER = 0x1;
const FLAG_LOCALIZED = 0x80;
const FLAG_LIGHT_MASTER = 0x200;
const FLAG_COMPRESSED = 0x00040000;

// Reads a plugin's TES4 record. Returns null if the file doesn't start with a valid TES4 record
// (too short, wrong signature). Returns { flags, masters: null, compressed: true } for the rare
// compressed-TES4 case rather than implementing zlib-inflate support -- a header this small is
// essentially never compressed in practice, and the safe direction on ambiguity here is "skip,
// don't guess" (same convention as this project's other deliberately-conservative pattern checks).
function readPluginHeader(filePath) {
    const fd = fs.openSync(filePath, 'r');
    try {
        const headerBuf = Buffer.alloc(TES4_HEADER_SIZE);
        const headerBytesRead = fs.readSync(fd, headerBuf, 0, TES4_HEADER_SIZE, 0);
        if (headerBytesRead < TES4_HEADER_SIZE) return null;
        if (headerBuf.toString('ascii', 0, 4) !== 'TES4') return null;

        const dataSize = headerBuf.readUInt32LE(4);
        const flags = headerBuf.readUInt32LE(8);
        if (flags & FLAG_COMPRESSED) return { flags, masters: null, compressed: true };

        const dataBuf = Buffer.alloc(dataSize);
        fs.readSync(fd, dataBuf, 0, dataSize, TES4_HEADER_SIZE);

        const masters = [];
        let offset = 0;
        while (offset + 6 <= dataBuf.length) {
            const subSig = dataBuf.toString('ascii', offset, offset + 4);
            const subSize = dataBuf.readUInt16LE(offset + 4);
            const subDataStart = offset + 6;
            if (subDataStart + subSize > dataBuf.length) break; // malformed/truncated -- stop safely
            if (subSig === 'MAST') {
                // Real string data -- decoded as Windows-1252, see decodeWin1252 above. The two
                // reads either side of this (the TES4 magic and the 4-byte subrecord signatures)
                // stay 'ascii' on purpose: those are fixed ASCII tokens by the format's own
                // definition, not text, and comparing them against ASCII literals is what makes the
                // parse work.
                let name = decodeWin1252(dataBuf, subDataStart, subDataStart + subSize);
                if (name.endsWith('\0')) name = name.slice(0, -1);
                masters.push(name);
            }
            offset = subDataStart + subSize;
        }
        // dataSize (2026-08-24, merge-flag-as-light) -- additive; every existing caller destructures
        // only the fields it needs, so this doesn't change their behavior. Lets a caller compute
        // where the TES4 record ends (TES4_HEADER_SIZE + dataSize) without re-parsing the header --
        // lib/esp-light-flag.js's own record-body walk needs exactly that to find where to start.
        return { flags, masters, compressed: false, dataSize };
    } finally {
        fs.closeSync(fd);
    }
}

module.exports = {
    readPluginHeader,
    TES4_HEADER_SIZE,
    FLAG_MASTER,
    FLAG_LOCALIZED,
    FLAG_LIGHT_MASTER,
    FLAG_COMPRESSED,
};
