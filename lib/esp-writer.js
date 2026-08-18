'use strict';
// Writes a minimal, valid, dummy Bethesda plugin to satisfy a missing-master dependency -- mirrors
// Wrye Bash's own "Create Dummy Master" feature (Mopy/bash/basher/mod_links.py's
// Mod_CreateDummyMasters, confirmed via reading its real source): a stub plugin with ZERO masters
// of its own, a recognizable author marker so it's never mistaken for a real download, and flags
// guessed purely from the missing file's own extension (the real file doesn't exist -- that's the
// whole point -- so its actual on-disk flags can never be known, only guessed by convention).
//
// NEVER writes into the live Skyrim Data/SKSE folder -- always into a separate, user-configured
// output folder (see TECHNICAL.md's "Missing Masters" section). Matches the user's own real
// workflow: Wrye Bash's dummy masters live in a dedicated folder inside their staging directory
// (e.g. "Wyre Output"), which they then get Vortex to recognize/deploy like any other mod --
// exactly how this project's own orphan-detection work already treats similar generator-tool output
// folders (DynDOLOD Output, BodySlide Output, etc).
//
// Byte layout verified against real files before being written (2026-07-27), not assumed:
//   - Real files (Dawnguard.esm/ccbgssse002-exoticarrows.esl/Unofficial Skyrim Special Edition
//     Patch.esp) all use versionControlInfo=0, formVersion=44, unknown=0 in the outer TES4 record
//     header -- the consistent modern SSE convention regardless of esm/esl/esp.
//   - HEDR subrecord is exactly 12 bytes: version (float32) + numRecords (int32) + nextObjectID
//     (uint32) -- confirmed by reading Dawnguard.esm's own HEDR (version 1.71, matching what this
//     writer produces).
//   - Flag bits confirmed via lib/esp-header.js's own real-file verification: .esm -> Master (0x1)
//     only; .esl -> Master (0x1) AND Light Master (0x200) together, not 0x200 alone; .esp -> no
//     flags. See lib/esp-header.js's header comment for the exact real values this was checked
//     against.

const fs = require('fs');
const path = require('path');
const { FLAG_MASTER, FLAG_LIGHT_MASTER } = require('./esp-header');

const HEDR_VERSION = 1.7;
const FORM_VERSION = 44;
const DUMMY_AUTHOR = 'Mod Scrub Dummy Master';
const TES4_HEADER_SIZE = 24;

function buildSubrecord(sig, dataBuf) {
    const header = Buffer.alloc(6);
    header.write(sig, 0, 4, 'ascii');
    header.writeUInt16LE(dataBuf.length, 4);
    return Buffer.concat([header, dataBuf]);
}

// Extension-only guess (mirrors Wrye Bash's own guess_flags(fn_ext)) -- the real file is, by
// definition, missing, so there is no actual flags value to read; this is the same limitation Wrye
// Bash itself accepts for this feature.
function guessFlags(fileName) {
    const ext = path.extname(fileName).toLowerCase();
    if (ext === '.esm') return FLAG_MASTER;
    if (ext === '.esl') return FLAG_MASTER | FLAG_LIGHT_MASTER;
    return 0; // .esp
}

function buildDummyPluginBuffer(fileName) {
    const flags = guessFlags(fileName);

    const hedrData = Buffer.alloc(12);
    hedrData.writeFloatLE(HEDR_VERSION, 0);
    hedrData.writeInt32LE(0, 4); // numRecords -- this dummy contains no other records
    hedrData.writeUInt32LE(0x800, 8); // nextObjectID -- Creation Kit's own default for a fresh plugin

    const cnamData = Buffer.from(DUMMY_AUTHOR + '\0', 'ascii');

    const subrecords = Buffer.concat([
        buildSubrecord('HEDR', hedrData),
        buildSubrecord('CNAM', cnamData),
    ]);

    const recordHeader = Buffer.alloc(TES4_HEADER_SIZE);
    recordHeader.write('TES4', 0, 4, 'ascii');
    recordHeader.writeUInt32LE(subrecords.length, 4); // dataSize
    recordHeader.writeUInt32LE(flags, 8);
    recordHeader.writeUInt32LE(0, 12); // formId
    recordHeader.writeUInt32LE(0, 16); // versionControlInfo
    recordHeader.writeUInt16LE(FORM_VERSION, 20);
    recordHeader.writeUInt16LE(0, 22); // unknown

    return Buffer.concat([recordHeader, subrecords]);
}

// Writes the dummy plugin to `outputDir` under the EXACT missing filename. Create-only -- refuses
// to overwrite an existing file rather than silently clobbering something already there (a real
// download that happens to share the name, a dummy already created by the user via Wrye Bash, etc).
function createDummyMaster(fileName, outputDir) {
    const fullPath = path.join(outputDir, fileName);
    if (fs.existsSync(fullPath)) {
        throw new Error(`A file already exists at "${fullPath}" -- refusing to overwrite it.`);
    }
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(fullPath, buildDummyPluginBuffer(fileName));
    return fullPath;
}

module.exports = { createDummyMaster, buildDummyPluginBuffer, guessFlags };
