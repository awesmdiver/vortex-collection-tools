'use strict';
// Detects the one specific, common, benign cause of a "changed" .esp/.esm/.esl mismatch: the
// current staging copy has been ESL-flagged (e.g. by ESLify, Cathedral Assets Optimizer, xEdit)
// after the mod was originally installed from this exact archive. Confirmed against a real case
// this session ("Bitchcraft Tats") -- both files were byte-identical except the TES4 record
// header's flags field (bytes 8-11), which differed by exactly bit 0x200, the documented ESL
// (Light Master) flag (confirmed against UESP's Mod File Format/TES4 page). Same content, same
// size, deliberate local customization -- not a real content regression, and not something this
// tool should ever silently "fix" by picking one side, but worth telling apart from a genuine
// content difference in the report.
const fs = require('fs');

const ESL_FLAG = 0x200;
const PLUGIN_EXTENSIONS = new Set(['.esp', '.esm', '.esl']);

function isPluginFile(relPath) {
    const lower = relPath.toLowerCase();
    for (const ext of PLUGIN_EXTENSIONS) if (lower.endsWith(ext)) return true;
    return false;
}

// Returns null if the two files are NOT a pure ESL-flag-only difference (different size, more
// than just that one flag bit differs, or either file can't be read). Otherwise returns which
// side has the flag set.
function checkEslOnlyDifference(pathA, pathB) {
    let a, b;
    try {
        a = fs.readFileSync(pathA);
        b = fs.readFileSync(pathB);
    } catch {
        return null;
    }
    if (a.length !== b.length || a.length < 12) return null;
    if (a.slice(0, 4).toString('latin1') !== 'TES4') return null;

    const flagsA = a.readUInt32LE(8);
    const flagsB = b.readUInt32LE(8);
    if ((flagsA ^ flagsB) !== ESL_FLAG) return null;

    // Every other byte (everything outside the 4-byte flags field at offset 8) must be identical.
    if (!a.slice(0, 8).equals(b.slice(0, 8))) return null;
    if (!a.slice(12).equals(b.slice(12))) return null;

    return { aIsEsl: (flagsA & ESL_FLAG) !== 0, bIsEsl: (flagsB & ESL_FLAG) !== 0 };
}

module.exports = { isPluginFile, checkEslOnlyDifference, ESL_FLAG };
