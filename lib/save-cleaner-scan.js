'use strict';
// Save Cleaner -- everything that reads the Saves folder and enriches ReSaver_Renewed's own report,
// WITHOUT needing the exe at all: listing save pairs (Step 1), a fast header-only read for the
// per-save character/level/location metadata the mockup's own save picker shows, the "next save
// number" filename logic for Save As (Step 5), and the real mod/collection-name resolution for
// orphaned scripts the CLI's own --data-dir flag can't provide (it can only say "still shipped by
// something installed," never name a specific already-uninstalled mod -- see this file's own header
// comment further down, and fallrimtools-resaver-renewed's own handoff for the CLI-side limit).
//
// Header parsing is deliberately NOT done via the CLI (`report` does a full ESS.readESS -- a real
// decompress + Papyrus parse, ~5-9s even on a fast save per real testing) -- Step 1 has to list
// dozens of saves near-instantly, so this reads only the small PLAIN (uncompressed) header block
// every Skyrim SE save starts with, verified against this project's own bundled ReSaver fork's
// source (resaver/ess/Header.java + resaver/ess/WStringElement.java -> mf/BufferUtil.java,
// F:\Claude Workspace\skyrim-modding\fallrimtools-resaver-renewed) rather than guessed:
//   13 bytes  "TESV_SAVEGAME" magic
//   int32     header size (asserted < 256 by ReSaver's own reader -- the whole header is tiny)
//   int32     version
//   int32     save number
//   WString   player name       (uint16 length prefix + that many raw bytes)
//   int32     level
//   WString   location (editor id)
//   WString   game date (display string, as Bethesda wrote it -- not reformatted here)
//   WString   race id (editor id, e.g. "BretonRace")
//   int16     sex (0 = male, 1 = female -- same convention ReSaver_Renewed.java's own -i/--inventory
//             flag's getInfo() output already uses)
//   float32   current XP
//   float32   XP needed for next level
//   int64     Windows FILETIME (100ns ticks since 1601-01-01 -- same conversion Header.java's own
//             getInfo() uses: millis = ticks/10000 - 11644473600000)
// then screenshot width/height + pixel data, which this never reads.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { stripDownloadNameSuffix } = require('./download-naming');

const HEADER_READ_BYTES = 1024; // generous margin over the <256-byte header this format guarantees

// Per-game config -- save file extension, magic header bytes, and default save folder locations.
// saveDirs are resolved dynamically since they depend on the Documents folder, which may be
// OneDrive-redirected (see resolveDocumentsDir comment below).
const GAMES = {
    skyrim: {
        ext: '.ess',
        cosaveExt: '.skse',
        cosaveName: 'SKSE',
        magicPrefix: 'TESV',
        magicBytes: 13,
    },
    fallout4: {
        ext: '.fos',
        cosaveExt: '.fo4se',
        cosaveName: 'F4SE',
        magicPrefix: 'FO4_',
        magicBytes: 12,
    },
    starfield: {
        ext: '.sfs',
        cosaveExt: '.sfse',
        cosaveName: 'SFSE',
        magicPrefix: 'BCPS',
        magicBytes: 4,
    },
};

function getGameSaveDirs(game) {
    const docs = resolveDocumentsDir();
    const dirMap = {
        skyrim: [
            path.join(docs, 'My Games', 'Skyrim Special Edition', 'Saves'),
            path.join(docs, 'My Games', 'Skyrim Special Edition GOG', 'Saves'),
            path.join(docs, 'My Games', 'Skyrim VR', 'Saves'),
        ],
        fallout4: [
            path.join(docs, 'My Games', 'Fallout4', 'Saves'),
        ],
        starfield: [
            path.join(docs, 'My Games', 'Starfield', 'Saves'),
        ],
    };
    return dirMap[game] || [];
}

function readWString(buf, offset) {
    const len = buf.readUInt16LE(offset);
    const value = buf.toString('latin1', offset + 2, offset + 2 + len);
    return { value, next: offset + 2 + len };
}

// Returns null on anything unparseable (wrong magic, truncated read, corrupt file) rather than
// throwing -- Step 1's save list must keep showing every OTHER save even if one file is bad; the
// caller falls back to filename/size/mtime only for that one row.
function readSaveHeader(essPath, game = 'skyrim') {
    let fd;
    try {
        fd = fs.openSync(essPath, 'r');
        const buf = Buffer.alloc(HEADER_READ_BYTES);
        const bytesRead = fs.readSync(fd, buf, 0, HEADER_READ_BYTES, 0);
        const gameConfig = GAMES[game];
        if (bytesRead < 20 || buf.toString('ascii', 0, gameConfig.magicPrefix.length) !== gameConfig.magicPrefix) return null;
        let offset = gameConfig.magicBytes; // magic + "_SAVEGAME"
        offset += 4; // header size (unused -- not validated here, ReSaver's own reader already guarantees this file's shape)
        offset += 4; // version
        const saveNumber = buf.readInt32LE(offset); offset += 4;
        const name = readWString(buf, offset); offset = name.next;
        const level = buf.readInt32LE(offset); offset += 4;
        const location = readWString(buf, offset); offset = location.next;
        const gameDate = readWString(buf, offset); offset = gameDate.next;
        const raceId = readWString(buf, offset); offset = raceId.next;
        const sex = buf.readInt16LE(offset); offset += 2;
        const currentXp = buf.readFloatLE(offset); offset += 4;
        const neededXp = buf.readFloatLE(offset); offset += 4;
        const filetime = buf.readBigInt64LE(offset); offset += 8;
        const savedAtMs = Number(filetime / 10000n - 11644473600000n);
        return {
            saveNumber,
            name: name.value,
            level,
            location: location.value,
            gameDate: gameDate.value,
            race: raceId.value.replace(/Race$/i, ''),
            sex: sex === 0 ? 'male' : 'female',
            currentXp,
            neededXp,
            savedAt: Number.isFinite(savedAtMs) ? new Date(savedAtMs).toISOString() : null,
        };
    } catch {
        return null;
    } finally {
        if (fd !== undefined) {
            try { fs.closeSync(fd); } catch { /* already closed/invalid -- nothing to clean up */ }
        }
    }
}

// The real Documents folder -- NOT necessarily `os.homedir()/Documents`. Confirmed real on this very
// project's own dev machine: OneDrive's "Documents" redirection moves it to e.g.
// `D:\OneDrive\Documents`, which a naive homedir-based guess would miss entirely (this was caught by
// actually testing this function against a real machine, not assumed). The registry's own
// `User Shell Folders\Personal` value is what Explorer/every other Windows app itself resolves this
// through, so reading the same key is the only genuinely reliable way -- falls back to the naive
// path only if that read fails for any reason (a non-standard Windows setup, PowerShell unavailable).
function resolveDocumentsDir() {
    try {
        const out = execSync(
            "powershell -NoProfile -Command \"(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders').Personal\"",
            { encoding: 'utf8', windowsHide: true },
        ).trim();
        if (out) return out;
    } catch {
        // fall through to the naive guess below
    }
    return path.join(os.homedir(), 'Documents');
}

// Auto-detect the default save folder for a game (Skyrim first, then Fallout 4, etc).
// Returns null if none of them exist -- Settings still lets the user Browse... to wherever
// their saves actually live either way.
function resolveDefaultSavesDir(game = 'skyrim') {
    if (!GAMES[game]) return null;
    const dirs = getGameSaveDirs(game);
    return dirs.find((p) => fs.existsSync(p)) || null;
}

// One row per SAVE, not per file -- Step 1's own explicit design ("42 saves, not 84 files"). A
// save with no cosave next to it still gets a row (hasCosave: false); a lone cosave with no
// matching save file is not a save at all and is silently skipped.
//
// Scans the top level AND one level into every subfolder -- confirmed real, testing this against a
// real Saves folder: vanilla Skyrim SE writes saves flat, but a real install here organizes them
// into per-profile subfolders (random-looking IDs, one per save-game slot the launcher manages)
// with zero .ess files sitting directly in the root at all. A flat top-level-only scan found 0
// saves against a folder that genuinely has dozens; scanning one level of subfolders too handles
// both layouts without needing to know which one a given install actually uses.
function listSaves(savesDir, game = 'skyrim') {
    if (!savesDir || !fs.existsSync(savesDir)) return [];
    const gameConfig = GAMES[game];
    const SAVE_EXT = gameConfig.ext;
    const COSAVE_EXT = gameConfig.cosaveExt;
    let topEntries;
    try {
        topEntries = fs.readdirSync(savesDir, { withFileTypes: true });
    } catch {
        return [];
    }
    // profileFolderId is the immediate subfolder name a save lives in (Vortex's own per-profile save
    // separation names this folder after the real profile ID -- e.g. "2PHCxF547"), or null for a save
    // sitting directly in savesDir's own root (no profile-specific layout in use). Raw ID only here;
    // resolving it to the profile's real display name needs Vortex's own state DB, which this
    // filesystem-only function has no access to -- the route handler cross-references it.
    const candidateDirs = [{ dir: savesDir, profileFolderId: null }];
    for (const entry of topEntries) {
        if (entry.isDirectory()) candidateDirs.push({ dir: path.join(savesDir, entry.name), profileFolderId: entry.name });
    }
    const rows = [];
    for (const { dir, profileFolderId } of candidateDirs) {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            if (!entry.isFile() || !entry.name.toLowerCase().endsWith(SAVE_EXT)) continue;
            const essPath = path.join(dir, entry.name);
            const cosaveName = entry.name.slice(0, -SAVE_EXT.length) + COSAVE_EXT;
            const cosavePath = path.join(dir, cosaveName);
            let stat;
            try {
                stat = fs.statSync(essPath);
            } catch {
                continue; // vanished between readdir and stat -- skip rather than crash the whole list
            }
            const header = readSaveHeader(essPath, game);
            rows.push({
                filename: entry.name,
                essPath,
                profileFolderId,
                cosavePath: fs.existsSync(cosavePath) ? cosavePath : null,
                sizeBytes: stat.size,
                mtime: stat.mtime.toISOString(),
                header, // null if unparseable -- frontend falls back to the filename alone
            });
        }
    }
    rows.sort((a, b) => new Date(b.mtime).getTime() - new Date(a.mtime).getTime());
    return rows;
}

// Step 5's "next save number" -- mirrors the mockup's own stated rule exactly: only the save-number
// segment changes, every byte after it (playerRefID/name/location/timestamp/etc.) is carried over
// verbatim from the file that was actually opened, since the cleaned output has no real new in-game
// moment of its own to derive a fresh suffix from. A number already in use anywhere in the folder
// (not just same-character) is skipped so the suggestion never itself lands on an overwrite prompt
// the user didn't ask for; Autosave/Quicksave (no number to bump) just gets the next free regular
// SaveNN with their own remainder appended.
// `saves` is whatever `listSaves(savesDir)` already returned -- reused rather than re-scanning the
// filesystem a second time, and correctly sees every save regardless of which per-profile subfolder
// (if any) it actually lives in, same as listSaves' own two-level scan.
// Same real per-character file ID web/public/save-cleaner-app.js's own scParsePlayerFileId reads
// (e.g. "Save24_F341709A_0_526F77616E_..." -> "F341709A") -- kept as a separate, independent parser
// here rather than shared, since this file has no access to that browser-side module and the regex
// itself is tiny and stable (the real Bethesda save filename format, not something either side owns).
function parsePlayerIdFromFilename(filename) {
    const m = /^[^_]+_([0-9A-Fa-f]+)_/.exec(filename);
    return m ? m[1] : null;
}

function suggestNextSaveName(saves, currentFilename, game = 'skyrim') {
    const gameConfig = GAMES[game];
    const SAVE_EXT = gameConfig.ext;
    const base = currentFilename.replace(new RegExp(`${SAVE_EXT}$`, 'i'), '');
    let rest = null;
    let startNum = 1;
    const numberedMatch = base.match(/^Save(\d+)(_.*)$/i);
    if (numberedMatch) {
        startNum = parseInt(numberedMatch[1], 10) + 1;
        rest = numberedMatch[2];
    } else {
        const autoMatch = base.match(/^(?:Autosave\d*|Quicksave)(_.*)$/i);
        rest = autoMatch ? autoMatch[1] : `_${base}`;
    }
    // Scope the "already in use" check to the SAME character only, not every save in the whole
    // folder -- confirmed real, director-reported 2026-08-26: a folder holding several characters'
    // saves (a common real layout -- see profileFolderId's own header comment) suggested "Save45" for
    // a character whose own saves only went up to 24, because some OTHER character in the same folder
    // happened to have a Save44. The ONLY real collision that matters is with this character's own
    // files; a different character's Save25 living in the same folder is a different, unrelated save,
    // never a real overwrite risk. Falls back to every save in the folder when the current file's own
    // id can't be parsed (matches the prior, pre-fix behavior for that edge case).
    const currentId = parsePlayerIdFromFilename(currentFilename);
    const sameCharacterSaves = currentId ? saves.filter((s) => parsePlayerIdFromFilename(s.filename) === currentId) : saves;
    const existingNumbers = new Set();
    for (const s of sameCharacterSaves) {
        const m = s.filename.match(/^Save(\d+)_/i);
        if (m) existingNumbers.add(parseInt(m[1], 10));
    }
    let n = startNum;
    while (existingNumbers.has(n)) n++;
    return `Save${n}${rest}${SAVE_EXT}`;
}

// ---- Real mod/collection-name resolution for orphaned scripts (this app's own real value-add over
// the bare CLI, per the mockup's own "The real advantage" section) ----
//
// Mirrors lib/missing-masters-scan.js's own buildStagingModNameIndex pattern exactly (same walk:
// stripDownloadNameSuffix per staging folder, root files + one level into a Data subfolder) but
// indexes each folder's Scripts/*.pex basenames instead of plugin files. Deliberately does NOT
// attempt to recover which mod used to ship a script that's no longer installed anywhere -- per
// this task's own confirmed scope decision, there is no reliable historical record of "mod X's
// Scripts folder used to contain file Y.pex" anywhere in this app once that mod's own staging
// folder is gone (confirmed by reading every existing historical-snapshot mechanism: collection
// backup snapshots and Merge History's own merge.json records both exist, but neither one records a
// removed mod's own file list). An unresolved script honestly reports "not currently provided by
// anything installed" instead of a guessed mod name.
function buildScriptOriginIndex(stagingDir) {
    const byScriptName = new Map(); // lowercased script basename (no .pex) -> { modName, stagingFolderName }
    if (!stagingDir || !fs.existsSync(stagingDir)) return byScriptName;
    let folders;
    try {
        folders = fs.readdirSync(stagingDir, { withFileTypes: true }).filter((e) => e.isDirectory());
    } catch {
        return byScriptName;
    }
    const indexOneScriptsDir = (scriptsDir, modName, stagingFolderName) => {
        let files;
        try {
            files = fs.readdirSync(scriptsDir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const f of files) {
            if (!f.isFile() || !f.name.toLowerCase().endsWith('.pex')) continue;
            const key = f.name.slice(0, -4).toLowerCase();
            if (!byScriptName.has(key)) byScriptName.set(key, { modName, stagingFolderName });
        }
    };
    for (const folder of folders) {
        const modDir = path.join(stagingDir, folder.name);
        const modName = stripDownloadNameSuffix(folder.name);
        indexOneScriptsDir(path.join(modDir, 'Scripts'), modName, folder.name);
        indexOneScriptsDir(path.join(modDir, 'Data', 'Scripts'), modName, folder.name);
    }
    return byScriptName;
}

// A real Skyrim save filename's own 5th underscore-delimited segment is the game's native
// current-location tag -- e.g. "Save24_F341709A_0_526F77616E_Tamriel_000403_...ess" -> "Tamriel".
// Vanilla Skyrim populates this reliably for most areas but has a known, real bug leaving it
// wrong/generic for worldspace REGIONS specifically -- exactly what the "Regional Save Names" SKSE
// plugin (github.com/powerof3/RegionalSaveNames) exists to fix: its own real source (read directly,
// not ported -- it's a one-line hook that no-ops the game's own broken name-writing call, nothing to
// reimplement) confirms it doesn't invent a new filename format at all, it just stops vanilla from
// clobbering this SAME native field for regions. So the segment is always worth reading; whether it's
// trustworthy as a real REGION name (vs. some other internal cell/quest tag like "APStartCell") is
// what isRegionalSaveNamesInstalled below answers -- gate on that before using this for display.
function parseRegionFromFilename(filename) {
    const m = /^[^_]+_[0-9A-Fa-f]+_\d+_[0-9A-Fa-f]+_([^_]+)_/.exec(filename);
    return m ? m[1] : null;
}

// True if the "Regional Save Names" SKSE plugin (github.com/powerof3/RegionalSaveNames) is
// installed -- a pure SKSE DLL with no plugin.esp, so it can't be detected via the load order the
// way a normal mod can; this scans staging folders for its own DLL directly, same "scan staging
// folders for a specific known file" shape buildScriptOriginIndex above already uses. Best-effort:
// no staging folder configured yet, or the folder is unreadable, just means "not detected."
function isRegionalSaveNamesInstalled(stagingDir) {
    if (!stagingDir || !fs.existsSync(stagingDir)) return false;
    let folders;
    try {
        folders = fs.readdirSync(stagingDir, { withFileTypes: true }).filter((e) => e.isDirectory());
    } catch {
        return false;
    }
    for (const folder of folders) {
        // Same root-vs-Data ambiguity buildScriptOriginIndex's own Scripts/Data-Scripts pair
        // handles -- a mod's staging folder can put the game-relative tree straight at its own
        // root, or nested one level under Data, depending on how it was packaged/installed.
        for (const pluginsDir of [
            path.join(stagingDir, folder.name, 'SKSE', 'Plugins'),
            path.join(stagingDir, folder.name, 'Data', 'SKSE', 'Plugins'),
        ]) {
            let files;
            try {
                files = fs.readdirSync(pluginsDir);
            } catch {
                continue;
            }
            // The real shipped file is "po3_RegionalSaveNames.dll" -- powerof3's own author-prefix
            // naming convention, not a bare match on the repo's own name. Confirmed real 2026-08-25:
            // an exact "RegionalSaveNames.dll" match silently never fired against a real install.
            // Match loosely (ends with, case-insensitive) so a differently-cased or re-packaged copy
            // is still found.
            if (files.some((f) => /regionalsavenames\.dll$/i.test(f))) return true;
        }
    }
    return false;
}

// Folder-name -> collection display name, for every mod belonging to a currently-installed
// collection -- same matching key (source.logicalFilename || name, normalized) used elsewhere in
// this app (lib/merge-plugin-scan.js's own scanCollectionPlugins), so a script's collection
// attribution stays consistent with how every other tool here already resolves it.
function buildCollectionNameIndex(collections) {
    const collectionByFolderKey = new Map();
    for (const collection of collections) {
        let modsArray;
        try {
            modsArray = JSON.parse(fs.readFileSync(collection.collectionJsonPath, 'utf8')).mods || [];
        } catch {
            continue;
        }
        for (const mod of modsArray) {
            if (!mod) continue;
            const matchKey = (mod.source && mod.source.logicalFilename) || mod.name;
            if (!matchKey) continue;
            collectionByFolderKey.set(String(matchKey).trim().toLowerCase(), collection.name);
        }
    }
    return collectionByFolderKey;
}

// Enriches ONE orphaned-script group (as returned by ReSaver_Renewed's own `report`,
// problems.unattachedInstances.byScriptName[i] -- {scriptName, count, currentlyProvided}) with a
// real mod/collection name when this app can actually resolve one.
function resolveScriptOrigin({ scriptOriginIndex, collectionNameIndex }, scriptName) {
    const match = scriptOriginIndex.get(String(scriptName).toLowerCase());
    if (!match) return { modName: null, collectionName: null };
    const collectionName = collectionNameIndex.get(match.modName.toLowerCase()) || null;
    return { modName: match.modName, collectionName };
}

module.exports = {
    GAMES,
    resolveDefaultSavesDir,
    readSaveHeader, listSaves, suggestNextSaveName,
    buildScriptOriginIndex, buildCollectionNameIndex, resolveScriptOrigin,
    parseRegionFromFilename, isRegionalSaveNamesInstalled,
};
