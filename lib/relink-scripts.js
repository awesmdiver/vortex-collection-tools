'use strict';
// Relink Scripts -- direct port of zEdit-Revised's own relinker.js/scriptsCache.js/pexService.js
// (the director's own fork, cloned locally at F:\Claude Workspace\skyrim-modding\zedit-revised\src\
// javascripts\Services\merge\{relinker,scriptsCache,pexService}.js -- read in full before writing
// this file, same "port from the real reference" methodology already used for translations/SEQ/
// override-merging).
//
// What it does: after a merge, a Papyrus script that calls
// `GetFormFromFile(<formID>, "<mergedAwayPlugin>.esp")` -- or that stores a merged-away plugin's
// filename as a plain string (for `GetFileByName`) -- needs updating, or it keeps looking for a
// form/plugin that no longer exists once the originals are disabled/removed. This scans every
// script currently in play (loose .pex files in Data\scripts, AND scripts packed inside every real
// BSA/BA2 -- see lib/bsab-cli.js) for references to the merged plugins, and for each affected
// script: rewrites GetFormFromFile's own FormID argument using the merge's own map.json (old FormID
// -> new FormID), and blanket-replaces any string-table entry that exactly matches a merged-away
// plugin's filename with the merged plugin's own filename. Saves the edited script to a NEW
// location -- never overwrites the original script file in place.
//
// Adapted from zEdit's own architecture, not copied 1:1: zEdit operates on a persistent, named list
// of saved merges (its own "Relink Scripts" button scans across every saved merge at once, using
// EVERY merge's own map.json together). This tool has no saved-merge list -- Relink Scripts here is
// scoped to the ONE merge that was just built, using that merge's own map.json only, run
// automatically right after the build completes (see web/merge-routes.js).

const fs = require('fs');
const path = require('path');
const { hashFileMd5 } = require('./file-hash');
const os = require('os');
const { PexFile } = require('pex-parser');
const opcodes = require('pex-parser/src/opcodes.js');
const bsabCli = require('./bsab-cli');

const CALLSTATIC = opcodes.find((o) => o.name === 'callstatic');
const PLUGIN_EXPR = /\.(esp|esm|esl)$/i;

// Stock Bethesda SSE archives -- never scanned for scripts (matches zEdit-Revised's own
// app/bethesdaFiles.json "SSE" archive list exactly -- vanilla game assets never reference a user
// mod plugin, and skipping them avoids wasting time on the archives most likely to be present on
// every install).
const STOCK_SSE_ARCHIVES = new Set([
    'skyrim - animations.bsa', 'skyrim - interface.bsa', 'skyrim - meshes0.bsa', 'skyrim - meshes1.bsa',
    'skyrim - misc.bsa', 'skyrim - patch.bsa', 'skyrim - shaders.bsa', 'skyrim - sounds.bsa',
    'skyrim - textures0.bsa', 'skyrim - textures1.bsa', 'skyrim - textures2.bsa', 'skyrim - textures3.bsa',
    'skyrim - textures4.bsa', 'skyrim - textures5.bsa', 'skyrim - textures6.bsa', 'skyrim - textures7.bsa',
    'skyrim - textures8.bsa', 'skyrim - voices_en0.bsa',
].map((s) => s.toLowerCase()));

const CACHE_PATH = path.join(__dirname, '..', 'config', 'relink-scripts-cache.json');

// Was a private readFileSync-based md5() -- it pulled every BSA/BA2 in the Data folder into memory
// whole (796 archives, 85.7 GB, largest 1.99 GB on this install) synchronously, in the main server
// process, after every merge. Now the one shared streaming implementation; see lib/file-hash.js and
// docs/SHARED-CODE-MAP.md's MD5 section.

// ---- Scripts cache (2026-08-18, ported from scriptsCache.js) -- hash-keyed so a repeat scan (this
// runs AUTOMATICALLY after every merge, per the director's own explicit "proactive, not blind"
// follow-up ask) only re-parses scripts/archives that actually changed since last time. A full
// from-scratch scan of a real modlist is genuinely slow -- confirmed directly against this
// installation's own real data: 19,191 loose scripts alone, plus scripts packed in every one of
// potentially hundreds of BSAs. Structure: { scripts: [{filename, hash, fileRefs, bsa?}],
// archives: [{filename, hash}] } -- one flat JSON file (both caches together, this tool has no
// reason to keep them separate the way zEdit's own two-file split does).
function loadCache() {
    try {
        const data = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
        return { scripts: data.scripts || [], archives: data.archives || [] };
    } catch {
        return { scripts: [], archives: [] };
    }
}

function saveCache(cache) {
    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache), 'utf8');
}

function findScriptEntry(cache, filename, hash) {
    return cache.scripts.find((e) => e.filename === filename && e.hash === hash);
}

// ---- Skip the hash entirely for files that genuinely haven't changed (2026-08-23) ----
// The cache used to save the PARSE but never the READ: the hash is part of the lookup key
// (findArchiveEntry/findScriptEntry take it), so every archive had to be hashed -- and therefore
// fully read -- before the cache could say "already known". That is what made an unchanged run cost
// 85.7 GB of I/O.
//
// Size + mtime is the cheap pre-check that fixes it. Both come from one statSync, and if both still
// match what was recorded alongside the hash, the recorded hash is still correct and the file never
// needs opening. Deliberately BOTH, not mtime alone: a same-size edit that preserves mtime is
// contrived, but a size change with an unchanged mtime is not (a truncated or resumed download), and
// either one on its own would miss a real change.
//
// Old cache entries have no size/mtime at all. Those simply miss the pre-check, get hashed once,
// and are stamped in place -- a migration, not an invalidation, so an existing 7 MB cache keeps all
// 64,531 of its parsed entries.
function indexCacheByName(cache) {
    const archives = new Map();
    const scripts = new Map();
    for (const e of cache.archives) archives.set(e.filename, e);
    // Keyed on bsa+filename: the same script filename legitimately appears in several archives, and
    // loose. \u0000 as the separator because it cannot occur in a real filename.
    for (const e of cache.scripts) scripts.set(`${e.bsa || ''}\u0000${e.filename}`, e);
    return { archives, scripts };
}

function statOrNull(filePath) {
    try {
        return fs.statSync(filePath);
    } catch {
        return null;
    }
}

function unchanged(entry, st) {
    return !!entry && !!st && entry.size === st.size && entry.mtimeMs === st.mtimeMs;
}

function findArchiveEntry(cache, filename, hash) {
    return cache.archives.find((e) => e.filename === filename && e.hash === hash);
}

// Every string in a script's own compiled string table that looks like a plugin filename -- matches
// pexService.js's own getFileRefs exactly (a plain string-table scan, not opcode-specific; this is
// what GetFileByName's own blanket string replacement below depends on being complete).
function getFileRefs(scriptPath) {
    const script = new PexFile(scriptPath);
    script.parse();
    return script.stringTable.filter((s) => PLUGIN_EXPR.test(s));
}

// Async now that hashing streams. The size/mtime pre-check applies to LOOSE scripts only: a script
// pulled out of a BSA lives in a fresh temp directory every run, so its mtime is the extraction time
// and could never match a previous run's -- recording it would be storing a value that is guaranteed
// to be useless. Those keep the original hash-based path, and are only reached at all when the
// containing archive itself changed.
async function cacheScript(cache, index, filePath, bsa) {
    const filename = path.basename(filePath);
    const st = statOrNull(filePath);
    const key = `${bsa || ''}\u0000${filename}`;
    if (!bsa && unchanged(index.scripts.get(key), st)) return; // untouched since last run

    const hash = await hashFileMd5(filePath);
    const existing = findScriptEntry(cache, filename, hash);
    if (existing) {
        // Already cached and still identical -- stamp size/mtime so the NEXT run skips the read.
        if (!bsa && st) { existing.size = st.size; existing.mtimeMs = st.mtimeMs; }
        index.scripts.set(key, existing);
        return;
    }
    try {
        const fileRefs = getFileRefs(filePath);
        const entry = bsa ? { bsa, filename, hash, fileRefs } : { filename, hash, fileRefs };
        if (!bsa && st) { entry.size = st.size; entry.mtimeMs = st.mtimeMs; }
        cache.scripts.push(entry);
        index.scripts.set(key, entry);
    } catch (e) {
        // A malformed/unparseable .pex shouldn't fail the whole scan -- skip it, matching
        // scriptsCache.js's own try/catch-and-log-only behavior around this exact call.
    }
}

async function cacheLooseScripts(cache, index, gameDataDir) {
    const scriptsDir = path.join(gameDataDir, 'scripts');
    let files;
    try {
        files = fs.readdirSync(scriptsDir).filter((f) => f.toLowerCase().endsWith('.pex'));
    } catch {
        return;
    }
    for (const f of files) await cacheScript(cache, index, path.join(scriptsDir, f));
}

async function cacheArchiveScripts(cache, index, archivePath) {
    const bsa = path.basename(archivePath);
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vct-relink-'));
    try {
        const extracted = await bsabCli.extractScriptsFromArchive(archivePath, tempDir);
        for (const scriptPath of extracted) await cacheScript(cache, index, scriptPath, bsa);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

async function cacheArchives(cache, index, gameDataDir, onProgress) {
    let files;
    try {
        files = fs.readdirSync(gameDataDir).filter((f) => /\.(bsa|ba2)$/i.test(f));
    } catch {
        return;
    }
    for (let i = 0; i < files.length; i++) {
        const f = files[i];
        if (onProgress) onProgress(i + 1, files.length, f);
        if (STOCK_SSE_ARCHIVES.has(f.toLowerCase())) continue;
        const archivePath = path.join(gameDataDir, f);
        const st = statOrNull(archivePath);
        // The whole point: an unchanged archive is never opened at all. This is what turns an
        // unchanged run from tens of GB of reads into a few hundred statSync calls.
        if (unchanged(index.archives.get(f), st)) continue;

        const hash = await hashFileMd5(archivePath);
        const existing = findArchiveEntry(cache, f, hash);
        if (existing) {
            // Same archive, cache predates size/mtime -- stamp it so the next run skips the read.
            if (st) { existing.size = st.size; existing.mtimeMs = st.mtimeMs; }
            index.archives.set(f, existing);
            continue;
        }
        await cacheArchiveScripts(cache, index, archivePath);
        const entry = { filename: f, hash };
        if (st) { entry.size = st.size; entry.mtimeMs = st.mtimeMs; }
        cache.archives.push(entry);
        index.archives.set(f, entry);
    }
}

// Refreshes the cache against the real, current Data folder (new/changed archives and loose scripts
// only -- see the cache functions above) and returns it. onProgress: optional (current, total,
// label) callback, called once per archive scanned (the slow part) -- mirrors
// lib/merge-v2-worker.js's own reportProgress shape so callers can wire it the same way.
async function updateScriptsCache(gameDataDir, onProgress) {
    const cache = loadCache();
    const index = indexCacheByName(cache);
    await cacheLooseScripts(cache, index, gameDataDir);
    await cacheArchives(cache, index, gameDataDir, onProgress);
    saveCache(cache);
    return cache;
}

// ---- Scan: which currently-cached scripts reference one of the merged plugins? (ported from
// relinker.js's own getScriptsToRelink/getMergedPlugins)
//
// mergedPluginFileNames: the source plugin filenames that were just merged away (items.map(fileName)
// from the just-completed build). Returns the matching cache entries (each { filename, hash,
// fileRefs, bsa? }) -- callers use .length for the proactive "N scripts reference what you just
// merged" count, and pass the array straight into relinkScripts() to actually do the work.
function getScriptsToRelink(cache, mergedPluginFileNames) {
    const mergedSet = new Set(mergedPluginFileNames.map((f) => f.toLowerCase()));
    return cache.scripts.filter((entry) => entry.fileRefs.some((f) => mergedSet.has(f.toLowerCase())));
}

// ---- The actual relink (ported from relinker.js's fixGetFormCalls/fixStrings/relinkScripts) ----

function resolveString(script, arg) {
    return script.stringTable[arg.data];
}

function getFunctions(script) {
    const functions = [];
    script.objects.forEach((object) => {
        object.data.states.forEach((state) => {
            state.functions.forEach((fn) => functions.push(fn.function));
        });
        object.data.properties.forEach((prop) => {
            if (prop.readHandler) functions.push(prop.readHandler);
            if (prop.writeHandler) functions.push(prop.writeHandler);
        });
    });
    return functions;
}

// fidMap: { [mergedPluginFileName]: { [oldFormIdHex6]: newFormIdHex6 } } -- lib/merge-v2-worker.js's
// own map.json shape (writeArtifacts), read fresh by the caller. Mutates `script` in place -- matches
// relinker.js's own fixGetFormCalls exactly, argument indices included (confirmed against real
// parsed scripts on this machine before writing this: arguments[1] = method name, arguments[4] =
// the raw FormID integer, arguments[5] = the target plugin filename, all string-table-index args
// resolved via resolveString()).
function fixGetFormCalls(script, fidMap) {
    const functions = getFunctions(script);
    functions.forEach((fn) => {
        fn.instructions.forEach((n) => {
            if (n.op !== CALLSTATIC.code) return;
            const methodName = resolveString(script, n.arguments[1]);
            if (methodName !== 'GetFormFromFile') return;
            const filename = resolveString(script, n.arguments[5]);
            if (!fidMap.hasOwnProperty(filename)) return;
            const oldFormId = (n.arguments[4].data & 0xFFFFFF).toString(16).toUpperCase().padStart(6, '0');
            const newFormId = fidMap[filename][oldFormId];
            if (!newFormId) return; // this specific FormID wasn't renumbered by this merge (e.g. an override record, which keeps its original id) -- nothing to change
            n.arguments[4].data = parseInt(newFormId, 16);
        });
    });
}

// mergedPlugins: { [oldPluginFileName]: mergedPluginFileName } -- blanket string-table replacement,
// handles GetFileByName and any other plain-string usage of a merged-away plugin's filename (not
// opcode-specific, matches fixStrings' own simplicity exactly).
function fixStrings(script, mergedPlugins) {
    script.stringTable.forEach((str, index) => {
        const newStr = mergedPlugins[str];
        if (!newStr) return;
        script.stringTable[index] = newStr;
    });
}

// Runs the actual relink for one merge -- entries: getScriptsToRelink's own return value (or a
// subset the caller already confirmed the user wants relinked), gameDataDir: for resolving loose
// script paths (BSA-sourced entries are re-extracted fresh here rather than reusing whatever temp
// copy the scan pass made, since that's long gone by the time this runs), fidMap: this merge's own
// map.json content, mergedPluginFileName: the merge's own output filename (what GetFileByName
// strings get rewritten TO), outputDir: where relinked scripts get saved.
//
// Output location: `<outputDir>\Relinker Output\scripts\<filename>` -- scoped to THIS merge's own
// per-merge subfolder (the director's own explicit instruction), not a single shared "Relinker
// Output" folder collecting every relink ever run the way zEdit's own global button does.
async function relinkScripts(entries, { gameDataDir, fidMap, mergedPluginFileName, outputDir }) {
    const mergedPlugins = {};
    for (const pluginFileName of Object.keys(fidMap)) mergedPlugins[pluginFileName] = mergedPluginFileName;

    const relinkerScriptsDir = path.join(outputDir, 'Relinker Output', 'scripts');
    fs.mkdirSync(relinkerScriptsDir, { recursive: true });

    const relinked = [];
    const failed = [];
    for (const entry of entries) {
        let sourcePath;
        let cleanupDir = null;
        try {
            if (entry.bsa) {
                const archivePath = path.join(gameDataDir, entry.bsa);
                if (!fs.existsSync(archivePath)) { failed.push({ filename: entry.filename, message: `Source archive "${entry.bsa}" no longer exists` }); continue; }
                cleanupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vct-relink-'));
                const extracted = await bsabCli.extractScriptsFromArchive(archivePath, cleanupDir);
                sourcePath = extracted.find((p) => path.basename(p).toLowerCase() === entry.filename.toLowerCase());
                if (!sourcePath) { failed.push({ filename: entry.filename, message: `Could not re-extract from "${entry.bsa}"` }); continue; }
            } else {
                sourcePath = path.join(gameDataDir, 'scripts', entry.filename);
                if (!fs.existsSync(sourcePath)) { failed.push({ filename: entry.filename, message: 'Source script no longer exists' }); continue; }
            }

            const script = new PexFile(sourcePath);
            script.parse();
            fixGetFormCalls(script, fidMap);
            fixStrings(script, mergedPlugins);
            script.filePath = path.join(relinkerScriptsDir, entry.filename);
            script.write();
            relinked.push(entry.filename);
        } catch (e) {
            failed.push({ filename: entry.filename, message: e.message });
        } finally {
            if (cleanupDir) fs.rmSync(cleanupDir, { recursive: true, force: true });
        }
    }
    return { relinked, failed, outputDir: relinkerScriptsDir };
}

module.exports = { updateScriptsCache, getScriptsToRelink, relinkScripts };
