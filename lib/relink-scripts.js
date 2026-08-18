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
const os = require('os');
const crypto = require('crypto');
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

function md5(filePath) {
    return crypto.createHash('md5').update(fs.readFileSync(filePath)).digest('hex');
}

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

function cacheScript(cache, filePath, bsa) {
    const filename = path.basename(filePath);
    const hash = md5(filePath);
    if (findScriptEntry(cache, filename, hash)) return;
    try {
        const fileRefs = getFileRefs(filePath);
        cache.scripts.push(bsa ? { bsa, filename, hash, fileRefs } : { filename, hash, fileRefs });
    } catch (e) {
        // A malformed/unparseable .pex shouldn't fail the whole scan -- skip it, matching
        // scriptsCache.js's own try/catch-and-log-only behavior around this exact call.
    }
}

function cacheLooseScripts(cache, gameDataDir) {
    const scriptsDir = path.join(gameDataDir, 'scripts');
    let files;
    try {
        files = fs.readdirSync(scriptsDir).filter((f) => f.toLowerCase().endsWith('.pex'));
    } catch {
        return;
    }
    for (const f of files) cacheScript(cache, path.join(scriptsDir, f));
}

async function cacheArchiveScripts(cache, archivePath) {
    const bsa = path.basename(archivePath);
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vct-relink-'));
    try {
        const extracted = await bsabCli.extractScriptsFromArchive(archivePath, tempDir);
        for (const scriptPath of extracted) cacheScript(cache, scriptPath, bsa);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

async function cacheArchives(cache, gameDataDir, onProgress) {
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
        const hash = md5(archivePath);
        if (findArchiveEntry(cache, f, hash)) continue;
        await cacheArchiveScripts(cache, archivePath);
        cache.archives.push({ filename: f, hash });
    }
}

// Refreshes the cache against the real, current Data folder (new/changed archives and loose scripts
// only -- see the cache functions above) and returns it. onProgress: optional (current, total,
// label) callback, called once per archive scanned (the slow part) -- mirrors
// lib/merge-worker.js's own reportProgress shape so callers can wire it the same way.
async function updateScriptsCache(gameDataDir, onProgress) {
    const cache = loadCache();
    cacheLooseScripts(cache, gameDataDir);
    await cacheArchives(cache, gameDataDir, onProgress);
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

// fidMap: { [mergedPluginFileName]: { [oldFormIdHex6]: newFormIdHex6 } } -- lib/merge-worker.js's own
// map.json shape, read fresh by the caller. Mutates `script` in place -- matches relinker.js's own
// fixGetFormCalls exactly, argument indices included (confirmed against real parsed scripts on this
// machine before writing this: arguments[1] = method name, arguments[4] = the raw FormID integer,
// arguments[5] = the target plugin filename, all string-table-index args resolved via
// resolveString()).
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
