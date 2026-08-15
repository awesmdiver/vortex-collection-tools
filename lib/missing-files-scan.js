'use strict';
// Rebuild Missing Files -- the read-only scan engine. For each mod in a picked collection, this
// resolves its archive the exact same way Rebuild Collection does (classifyMod, rebuild-mod.js),
// then figures out the exact set of files that SHOULD exist in the staging folder by replaying the
// same install resolution extract-mod.js uses for a real rebuild -- FOMOD choice replay
// (choice-resolver.js) for a mod with recorded FOMOD choices, or Vortex's own generic mod-root-
// prefix stripping (simple-installer.js) for a plain archive -- and diffs THAT against what's
// actually on disk. No extraction of the mod's own content needed for this (only a FOMOD's own
// small ModuleConfig.xml is peeked, to read its install steps).
//
// This replaces an earlier, much naiver version of this file that diffed the archive's RAW internal
// paths directly against the staging folder. Confirmed wrong via real-collection testing
// (2026-08-14): a FOMOD-installed mod's raw archive paths don't match what Vortex's installer
// actually produces (e.g. "Armory of the Dragon Cult - Half Res" archives everything under
// "Armory of the Dragon Cult - Half res\00 Data\00Base\...", but the FOMOD install step only copies
// a subset of that into the staging root) -- the naive diff reported the ENTIRE mod as missing
// (hundreds of files) when it was actually installed correctly. A plain "simple" (non-FOMOD)
// archive has the same problem on a smaller scale whenever it has a wrapper folder Vortex strips on
// install (e.g. "Legacy of the Dragonborn - Interesting NPCs Patch", 567 false "missing" files
// before this fix). See TECHNICAL.md for the full incident writeup.
//
// knownVortexModId is always null here (unlike Rebuild Collection's plan, which reads Vortex's
// live state to get this -- see rebuild-routes.js's computePlan) -- these are collections already
// installed on disk, so classifyMod's own archive-basename fallback for targetFolderName matches
// the real staging folder in the overwhelming common case, without the risk/cost of an isolated
// state.v2 read. The one known gap: a mod updated in collection.json but not yet redeployed in
// Vortex has an archive filename that doesn't match its still-staged (older) folder name -- this
// scan would then see "no staging folder" for that one mod rather than a real missing-file diff.
// Accepted trade-off, documented in TECHNICAL.md.
//
// listPickableCollections() deliberately does NOT reuse vortex-sync/lib.js's own
// scanStagingCollections -- that function excludes every "vortex_collection_<id>"-named folder
// unconditionally (Workshop-authoring collections), and this tool's own mockup explicitly wants a
// second "Workshop collections" group for exactly those (an authoring collection has its own real,
// locally-readable collection.json too, same as an installed one -- there's just as much reason to
// check it for missing staging files). A single extra filesystem pass, kept local to this file
// rather than changing scanStagingCollections' own long-standing exclusion (other callers rely on
// that exclusion staying exactly as-is).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadCollection } = require('./collection-parser');
const { classifyMod } = require('./rebuild-mod');
const { listArchive, extractFile } = require('./sevenzip');
const { parseModuleConfigFile, hasUnhandledFeatures } = require('./fomod-parser');
const { resolveChoices } = require('./choice-resolver');
const { findModRoot } = require('./mod-root');
const { resolveSimpleInstall } = require('./simple-installer');
const { existsPlainOrGhosted } = require('./ghost-files');

function isWorkshopFolderName(name) {
    return /^vortex_collection_/i.test(name);
}

// One flat pass over the staging root -- every immediate subfolder with a collection.json is
// pickable, split into "installed" (a normal Vortex-assigned folder name) vs "workshop" (a
// Workshop-authoring folder, per the naming convention above). No Vortex live-state read at all --
// this is purely what's already sitting on disk, matching the mockup's own lack of a "Load Vortex
// Data" step.
function listPickableCollections(stagingDir) {
    let entries;
    try {
        entries = fs.readdirSync(stagingDir, { withFileTypes: true });
    } catch (err) {
        throw new Error(`Could not read staging directory "${stagingDir}": ${err.message}`);
    }
    const installed = [];
    const workshop = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const collectionJsonPath = path.join(stagingDir, entry.name, 'collection.json');
        if (!fs.existsSync(collectionJsonPath)) continue;
        let data;
        try {
            data = JSON.parse(fs.readFileSync(collectionJsonPath, 'utf8'));
        } catch {
            continue; // not a valid collection.json -- skip
        }
        const item = {
            modId: entry.name,
            name: data.info?.name || entry.name,
            modCount: data.mods?.length || 0,
        };
        (isWorkshopFolderName(entry.name) ? workshop : installed).push(item);
    }
    installed.sort((a, b) => a.name.localeCompare(b.name));
    workshop.sort((a, b) => a.name.localeCompare(b.name));
    return { installed, workshop };
}

// Resolves the exact set of files that SHOULD exist in this mod's staging folder, replaying the
// same logic extract-mod.js uses for a real rebuild. Returns { destinations: {source,
// destination}[] } on success -- BOTH fields, not just destination, since a mod with a stripped
// mod-root wrapper (see simple-installer.js/resolveChoices' own header comments) has a source path
// that differs from its destination, and extraction needs the real archive-internal source path to
// find the member at all -- or { unresolvable: reason } when this mod can't be reliably resolved
// without actually extracting (an unhandled FOMOD feature) -- never guesses.
async function resolveExpectedDestinations(mod, archiveEntries, archivePath, sevenZipExe) {
    if (mod.choices?.type === 'fomod') {
        let configPath;
        let rootPrefix;
        try {
            ({ configPath, rootPrefix } = findModRoot(archiveEntries));
        } catch (e) {
            return { unresolvable: `Could not find this mod's FOMOD installer in its archive: ${e.message}` };
        }
        const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmf-fomod-'));
        let parsedFomod;
        try {
            const extractedConfigPath = await extractFile(sevenZipExe, archivePath, configPath, scratchDir);
            parsedFomod = parseModuleConfigFile(extractedConfigPath);
        } catch (e) {
            return { unresolvable: `Could not read this mod's FOMOD installer: ${e.message}` };
        } finally {
            fs.rmSync(scratchDir, { recursive: true, force: true });
        }
        if (hasUnhandledFeatures(parsedFomod)) {
            return { unresolvable: "This mod's FOMOD installer uses a feature this tool can't check yet." };
        }
        // All FOMOD source paths are relative to rootPrefix, not the archive root -- same
        // relative-entries construction as extract-mod.js.
        const rootPrefixLower = rootPrefix.toLowerCase();
        const relativeEntries = rootPrefix
            ? archiveEntries
                .filter((e) => {
                    const lower = e.path.toLowerCase();
                    return lower.startsWith(`${rootPrefixLower}\\`) || lower.startsWith(`${rootPrefixLower}/`);
                })
                .map((e) => ({ ...e, path: e.path.slice(rootPrefix.length + 1) }))
            : archiveEntries;
        let files;
        try {
            ({ files } = resolveChoices(parsedFomod, mod.choices, relativeEntries));
        } catch (e) {
            return { unresolvable: `Could not resolve this mod's recorded FOMOD choices: ${e.message}` };
        }
        // resolveChoices' own `source` is relative to rootPrefix, not the archive root -- re-prepend
        // it here (same construction extract-mod.js's own resolvedFiles uses) so the source path this
        // returns is the real, directly-extractable archive-internal path.
        return {
            destinations: files.map((f) => ({
                source: rootPrefix ? `${rootPrefix}\\${f.source}` : f.source,
                destination: f.destination,
            })),
        };
    }
    // No recorded FOMOD choices -- classifyMod() already confirmed this archive has no real FOMOD
    // installer wizard either (it would have returned SKIP_OPEN_FOMOD otherwise), so this is a
    // genuine "simple" install: Vortex's own generic mod-root-prefix stripping, nothing more.
    const files = resolveSimpleInstall(archiveEntries);
    return { destinations: files };
}

// Scans ONE mod. Returns one of:
//   { bucket: 'missing', name, modId, fileId, targetFolderName, archivePath, missing: {source, destination}[] }
//   { bucket: 'archive-missing', name, modId, fileId, reason }  -- can't diff without the archive
//   { bucket: 'skipped', name, reason }                          -- FOMOD wizard / not installed / unresolvable
//   { bucket: 'ok', name }                                       -- installed, archive resolved, nothing missing
async function scanOneMod(mod, { downloadsDir, stagingDir, sevenZipExe, exceptionMatcher = () => false }) {
    const base = { name: mod.name, modId: mod.source?.modId ?? null, fileId: mod.source?.fileId ?? null };
    let action;
    try {
        action = await classifyMod(mod, { downloadsDir, stagingDir, knownVortexModId: null, sevenZipExe, exceptionMatcher });
    } catch (e) {
        return { bucket: 'archive-missing', ...base, reason: e.message };
    }
    if (action.kind === 'SKIP_EXCEPTED') {
        // Mod Exceptions list (queue: rebuild-missing-hand-pick-exceptions) -- never scanned, same
        // "don't even hash the archive" early-out classifyMod itself already applies for Rebuild
        // Collection. Acknowledged tier, matching the 'ignored' bucket's own treatment below.
        return { bucket: 'excepted', ...base, reason: action.detail };
    }
    if (action.kind === 'SKIP_NO_ARCHIVE') {
        // Can't know what SHOULD be in staging without the archive to list -- no missing-file diff
        // is possible, only surfaced as its own bucket so the report can still show it (with a
        // Download Archive action for Nexus mods) instead of silently dropping it.
        return { bucket: 'archive-missing', ...base, reason: action.detail || 'No archive found.' };
    }
    if (action.kind === 'SKIP_OPEN_FOMOD') {
        return { bucket: 'skipped', name: mod.name, reason: 'This mod opens a FOMOD installer wizard -- can\'t check it for missing files automatically.' };
    }
    if (!action.existingStagingFolder) {
        return { bucket: 'skipped', name: mod.name, reason: 'Not installed in this collection\'s staging folder yet.' };
    }
    let entries;
    try {
        entries = await listArchive(sevenZipExe, action.archivePath);
    } catch (e) {
        return { bucket: 'archive-missing', ...base, reason: `Could not read the archive's contents: ${e.message}` };
    }
    const resolved = await resolveExpectedDestinations(mod, entries, action.archivePath, sevenZipExe);
    if (resolved.unresolvable) {
        return { bucket: 'skipped', name: mod.name, reason: resolved.unresolvable };
    }
    // A ".ghost"-suffixed sibling is Vortex's own present-but-disabled marker (see ghost-files.js) --
    // not a real absence. Without this, a file the user intentionally disabled in Vortex reports as
    // "missing" here (confirmed live: "TGC Winterhold - ELFX Patch.esp", Vortex Ghost status,
    // ".esp.ghost" genuinely present on disk).
    const missing = resolved.destinations.filter((f) => !existsPlainOrGhosted(action.stagingModDir, f.destination));
    if (missing.length === 0) return { bucket: 'ok', name: mod.name };
    return {
        bucket: 'missing', ...base,
        targetFolderName: action.targetFolderName, archivePath: action.archivePath, missing,
    };
}

// Scans every picked collection. Tolerant of one bad/unreadable collection -- matches
// collection-runner.js's own multi-collection tolerance pattern (one failure doesn't lose the
// others' results). onProgress: ({ collectionModId, collectionName, index, total, modName }) => void,
// called as each mod within a collection finishes.
//
// ignoredMatchers (queue: rebuild-missing-ignored-mods): optional Map<collectionModId,
// (source) => ref|null>, one entry per collection -- built by the caller (rebuild-missing-routes.js)
// via vortex-sync/lib.js's own makeIdentityMatcher(listIgnoredMods(...)), a real Vortex-state read
// this file itself deliberately never does (see this file's own header comment). Kept as a pure,
// already-resolved lookup function passed IN, not fetched here, so scanCollections/scanOneMod stay
// exactly as state-read-free and synchronous-per-mod as before -- only the caller needs to be
// Vortex-closed-gated for this, not this whole module.
async function scanCollections(collectionModIds, { stagingDir, downloadsDir, sevenZipExe, onProgress, ignoredMatchers, exceptionMatcher }) {
    const results = [];
    for (const collectionModId of collectionModIds) {
        const collectionJsonPath = path.join(stagingDir, collectionModId, 'collection.json');
        let collection;
        let name = collectionModId;
        try {
            collection = loadCollection(collectionJsonPath);
            name = collection.info?.name || collectionModId;
        } catch (e) {
            results.push({ collectionModId, name, error: `Could not read this collection's collection.json: ${e.message}` });
            continue;
        }
        const isIgnored = ignoredMatchers?.get(collectionModId) || (() => null);
        const mods = collection.mods || [];
        const modsWithMissing = [];
        const modsArchiveMissing = [];
        const modsIgnored = [];
        const modsExcepted = [];
        for (let i = 0; i < mods.length; i++) {
            const mod = mods[i];
            let result;
            try {
                result = await scanOneMod(mod, { downloadsDir, stagingDir, sevenZipExe, exceptionMatcher });
            } catch (e) {
                result = { bucket: 'archive-missing', name: mod.name, modId: mod.source?.modId ?? null, fileId: mod.source?.fileId ?? null, reason: e.message };
            }
            // A mod the director deliberately Ignored in Vortex still shows up as a normal
            // 'missing'/'archive-missing' row otherwise -- indistinguishable from a real problem.
            // Reclassified here, AFTER scanOneMod's own real classification, so the underlying
            // reason (files genuinely missing, or the archive genuinely not matching) is still known
            // -- this only changes how it's SHOWN, not whether it was detected. Covers both problem
            // kinds equally (confirmed live: an Ignored mod's archive not matching reads just as
            // "not a real problem" as an Ignored mod's files being missing -- same reasoning either
            // way, not just the missing-files case).
            if ((result.bucket === 'missing' || result.bucket === 'archive-missing') && isIgnored(mod.source)) {
                result = {
                    bucket: 'ignored', name: mod.name, modId: mod.source?.modId ?? null, fileId: mod.source?.fileId ?? null,
                    reason: 'This mod is marked Ignored in Vortex -- not something to fix here.',
                };
            }
            if (result.bucket === 'missing') modsWithMissing.push(result);
            else if (result.bucket === 'archive-missing') modsArchiveMissing.push(result);
            else if (result.bucket === 'ignored') modsIgnored.push(result);
            else if (result.bucket === 'excepted') modsExcepted.push(result);
            if (onProgress) onProgress({ collectionModId, collectionName: name, index: i + 1, total: mods.length, modName: mod.name });
        }
        results.push({ collectionModId, name, modsWithMissing, modsArchiveMissing, modsIgnored, modsExcepted });
    }
    return results;
}

module.exports = { listPickableCollections, resolveExpectedDestinations, scanOneMod, scanCollections };
