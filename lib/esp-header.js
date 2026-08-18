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
                let name = dataBuf.toString('ascii', subDataStart, subDataStart + subSize);
                if (name.endsWith('\0')) name = name.slice(0, -1);
                masters.push(name);
            }
            offset = subDataStart + subSize;
        }
        return { flags, masters, compressed: false };
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
