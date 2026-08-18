'use strict';
// "Missing Masters" utility backend -- finds active plugins whose declared masters (from their own
// TES4 header, see lib/esp-header.js) aren't actually available to the game right now. Modeled on
// the user's real Wrye Bash workflow; see TECHNICAL.md's "Missing Masters" section for the full
// design writeup and the real Wrye Bash source findings that grounded it.
//
// Two distinct problem categories, both genuinely crash-causing (Skyrim only loads ACTIVE plugins,
// so a master that exists but isn't active crashes it exactly like a truly-absent one):
//   - 'missing'              -- the master file doesn't exist anywhere in the Data folder at all.
//   - 'present-but-inactive' -- the file exists in the Data folder, but isn't currently active
//                               (explicitly un-starred in Plugins.txt, or ghosted by Vortex). This
//                               is the real gap in Wrye Bash's OWN core "Missing master(s)" status
//                               check (confirmed by reading its source, bosh/__init__.py's
//                               info_status(): it only checks `m not in modInfos`, i.e. presence,
//                               never active-status) -- exactly the user's own "I ignored a mod, so
//                               its .esp isn't installed" scenario. Deliberately reported as its own
//                               category since the fix differs (re-enable it, vs. install/create a
//                               dummy for it).
//
// Active-set derivation, confirmed against the user's REAL live Plugins.txt/Data folder before
// being written (2026-07-27), not assumed:
//   - Plugins.txt does NOT list base masters (Skyrim.esm, Update.esm, Dawnguard.esm, etc.) or a good
//     chunk of Creation-Club .esl content at all -- those are implicitly always active whenever
//     present and un-ghosted. Only genuinely toggleable plugins get an explicit Plugins.txt line
//     (starred "*" = active, unstarred = explicitly disabled).
//   - loadorder.txt turned out to be UNNECESSARY for this feature -- ghost-status (Vortex's own
//     disabled-plugin marker) is read directly off the Data folder's own file listing instead (a
//     ghosted file is physically renamed to "<name>.ghost" there), which is more ground-truth-
//     accurate than trusting a separate bookkeeping file that could in principle be stale. This
//     feature has no need for plugin ORDER (only presence/activation), so loadorder.txt's other
//     purpose (defining sequence) is irrelevant here.
//   - All name comparisons are case-insensitive (matches Windows filesystem + game behavior).

const fs = require('fs');
const path = require('path');
const { readPluginHeader } = require('./esp-header');
// Shared with cleanup-scan.js (lib/download-naming.js) -- stripDownloadNameSuffix turns a raw
// staging folder name back into a clean mod name via the SAME modId-version-timestamp pattern
// Mod Scrub uses for its own exceptions/needsReview classification. Confirmed real 2026-07-27
// (a folder with a non-numeric version string, "1DustAdeptArmorSE-53257-new-1628092406", failed to
// strip under an earlier, stricter version of this pattern, while Vortex's own UI correctly shows
// the clean name "1DustAdeptArmorSE") that real Vortex version strings are NOT always numeric --
// confirmed further against a live screenshot of Vortex's own Version column showing entries like
// "3.4.0.3Beta" and "1.0.1.VampirePatch". Fixed in the SHARED pattern (not a separate, looser
// one-off copy here) since both consumers benefit from the same, more accurate rule -- checked
// against Mod Scrub's own safety use first: a hand-named tool-output folder never ends in a
// "-<number>-...-<10-digit-timestamp>" shape at all, so this fix doesn't newly risk misreading one
// of those as a safe-to-bulk-delete real download, it only recognizes more genuine ones correctly.
const { stripDownloadNameSuffix } = require('./download-naming');

const PLUGIN_EXTENSIONS = ['.esp', '.esm', '.esl'];

function isPluginFile(name) {
    const lower = name.toLowerCase();
    const isGhost = lower.endsWith('.ghost');
    const withoutGhost = isGhost ? lower.slice(0, -'.ghost'.length) : lower;
    return PLUGIN_EXTENSIONS.some((ext) => withoutGhost.endsWith(ext));
}

// Reads Plugins.txt -- returns { starred: Set<lowercased name>, listedNotStarred: Set<lowercased name> }.
function readPluginsTxt(pluginsTxtPath) {
    const starred = new Set();
    const listedNotStarred = new Set();
    const text = fs.readFileSync(pluginsTxtPath, 'utf8');
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        if (line.startsWith('*')) {
            starred.add(line.slice(1).trim().toLowerCase());
        } else {
            listedNotStarred.add(line.toLowerCase());
        }
    }
    return { starred, listedNotStarred };
}

// This tool's first-ever WRITE to Plugins.txt (2026-08-17, Merge Plugins' "Merge Settings" ->
// disable). Every other live write in this app touches Vortex's LevelDB (lib/vortex-sync/lib.js);
// Vortex's own per-PLUGIN enabled/disabled state (its Plugins page, distinct from its Mods page --
// director's own screenshot confirmed the two are separate) lives here instead, in the standard
// Bethesda-game load-order file: a plain-text list, one plugin per line, an active line prefixed
// with '*'. Toggling a plugin off means removing just that '*' -- nothing else about the file
// changes: same line order, same every-other-line content, same encoding/line-endings as read.
//
// Reuses readPluginsTxt's own matching convention (trim the whole line, case-insensitive compare
// against the name after a leading '*') but can't reuse its RETURN SHAPE -- that function collapses
// everything into lowercased Sets, discarding the raw line text/order this write needs to preserve
// byte-for-byte. Splits on a CAPTURING line-ending regex so every '\r\n'/'\r'/'\n' token in the file
// survives untouched in the rejoin, whatever mix the file happens to use -- confirmed this
// installation's own real Plugins.txt is plain CRLF, no BOM, but nothing here assumes that.
// Writes to a temp file and renames over the original (atomic replace) rather than writing in place,
// so a Plugins.txt read by Vortex or the game mid-write is never left half-written.
//
// fileNames: plugin file names (e.g. "SomePlugin.esp") to disable -- case-insensitive, matched by
// filename only (Plugins.txt has no other identity to key on). Returns { disabled: [names actually
// turned off], notFound: [names not found in the file at all, or already inactive] }.
function disablePluginsInPluginsTxt(pluginsTxtPath, fileNames) {
    const wanted = new Set(fileNames.map((f) => f.toLowerCase()));
    const raw = fs.readFileSync(pluginsTxtPath, 'utf8');
    const parts = raw.split(/(\r\n|\r|\n)/); // odd indices are the line-ending tokens themselves, kept verbatim
    const disabled = [];
    for (let i = 0; i < parts.length; i += 2) {
        const content = parts[i];
        const trimmed = content.trim();
        if (!trimmed.startsWith('*')) continue; // not an active line -- nothing to disable, and never a match for listedNotStarred/comment lines either
        const name = trimmed.slice(1).trim();
        const key = name.toLowerCase();
        if (!wanted.has(key)) continue;
        const starIdx = content.indexOf('*'); // exact position, not assumed to be index 0 -- preserves any incidental leading whitespace exactly
        parts[i] = content.slice(0, starIdx) + content.slice(starIdx + 1);
        disabled.push(name);
        wanted.delete(key);
    }
    if (disabled.length) {
        const tmpPath = `${pluginsTxtPath}.vct-tmp`;
        fs.writeFileSync(tmpPath, parts.join(''), 'utf8');
        fs.renameSync(tmpPath, pluginsTxtPath);
    }
    return { disabled, notFound: [...wanted] };
}

// Scans the Data folder directly for plugin files (ground truth for both existence and
// ghost-status) -- returns Map<lowercased base name, { actualFileName, ghosted }>.
function scanDataFolder(dataDir) {
    const filesOnDisk = new Map();
    for (const entry of fs.readdirSync(dataDir, { withFileTypes: true })) {
        if (!entry.isFile() || !isPluginFile(entry.name)) continue;
        const isGhost = entry.name.toLowerCase().endsWith('.ghost');
        const baseName = isGhost ? entry.name.slice(0, -'.ghost'.length) : entry.name;
        filesOnDisk.set(baseName.toLowerCase(), { actualFileName: entry.name, ghosted: isGhost });
    }
    return filesOnDisk;
}

// Computes which base names (lowercased) are currently ACTIVE -- starred in Plugins.txt, or not
// listed there at all (an implicit always-on master/CC-content plugin) -- excluding anything ghosted.
function computeActiveSet(filesOnDisk, pluginsTxt) {
    const active = new Set();
    for (const [key, info] of filesOnDisk) {
        if (info.ghosted) continue;
        if (pluginsTxt.listedNotStarred.has(key)) continue;
        active.add(key);
    }
    return active;
}

// Confirmed real-world need 2026-07-27 -- a raw plugin filename alone doesn't say which MOD it
// belongs to, so a user can't always tell at a glance whether they recognize it. Reuses the
// project's EXISTING `staging` config field (no new Settings field needed) -- a pass over every
// staging subfolder's own top-level files, mapping each plugin filename found back to its owning
// folder, then stripping that folder's own trailing modId-version-timestamp suffix (the same pattern
// cleanup-scan.js's exceptions/needsReview split already relies on) to get a clean display name.
// Benchmarked live against the user's real ~4550-folder staging directory: ~150ms for a full pass --
// cheap enough to rebuild on every scan (including the 5s silent poll), same as the rest of this
// feature's own reads. A folder whose name doesn't match the pattern (a hand-named tool-output
// folder, same "needsReview" shape as elsewhere) is used as-is, unstripped -- still more useful than
// nothing. Returns Map<lowercased plugin filename, mod name> -- a plugin genuinely not found in ANY
// staging folder (never installed at all) simply has no entry, and callers treat that as "unknown".
//
// Also checks one level into a "Data" subfolder (case-insensitive), if the mod folder has one --
// confirmed real 2026-07-27 with an actual "true missing master" case: mod author packaged BOTH
// "1DustAdeptArmor.esp" at the folder root AND "1DustAdeptArmor.esl" nested inside a "data\"
// subfolder (an on/off pick-one-format choice some mod authors ship), and the collection that
// installed this mod picked the .esp -- leaving the .esl sitting right there in the user's own
// staging folder, genuinely present on their disk, just never deployed. A root-only scan completely
// missed it. Deliberately only ONE level deep (root, or root/Data's own root) -- not a general
// recursive walk -- matching exactly the one real nesting pattern this was built to catch, not a
// broader "search everywhere" that would slow this down for comparatively little further benefit.
// Returns { modNameByPlugin, siblingsByModName, hollowInstalls }:
//   - modNameByPlugin: Map<lowercased plugin filename, mod name> (as before).
//   - siblingsByModName: Map<mod name, Set<lowercased plugin filename>> -- every plugin file that
//     mod's own staging folder contains (root + Data), used to detect the "this mod IS installed,
//     just under a different plugin filename" case (see scanMissingMasters' own use of this below).
//   - hollowInstalls: [{ folderName, modName }] -- staging folders found completely EMPTY (zero
//     plugin files at root or in a Data subfolder). Confirmed real 2026-07-27: Vortex's own state.v2
//     can say a mod is "installed" (real archive still intact in Downloads) while its actual staging
//     folder has nothing in it at all -- the FOMOD/extraction step never completed, or its contents
//     were wiped afterward, with Vortex's own records never updated to notice. `folderName` is the
//     RAW staging folder name -- for every real case seen so far this doubles as the mod's own
//     state.v2 key (installationPath === id), which is exactly what a single-mod rebuild needs.
function buildStagingModNameIndex(stagingDir, excludeDirAbs) {
    const modNameByPlugin = new Map();
    const siblingsByModName = new Map();
    const hollowInstalls = [];
    // Map<modName, absolute staging folder path> -- lets the UI offer "Open Staging Folder" for any
    // master whose mod name resolves back to a real folder on disk, without re-deriving the path
    // client-side. If two folders somehow resolve to the same modName (see the merge note below),
    // the LAST one wins -- fine for "open a folder to look around," unlike siblingsByModName which
    // must genuinely capture every plugin file either one has.
    const folderPathByModName = new Map();
    if (!stagingDir || !fs.existsSync(stagingDir)) return { modNameByPlugin, siblingsByModName, hollowInstalls, folderPathByModName };
    let folders;
    try {
        folders = fs.readdirSync(stagingDir, { withFileTypes: true }).filter((e) => e.isDirectory());
    } catch {
        return { modNameByPlugin, siblingsByModName, hollowInstalls, folderPathByModName };
    }
    for (const folder of folders) {
        const modName = stripDownloadNameSuffix(folder.name);
        const modDir = path.join(stagingDir, folder.name);
        // Confirmed real 2026-07-28: the configured Dummy Masters output folder is a flat dumping
        // ground for every dummy stub this app has ever created (e.g. "Wyre Output" sitting directly
        // inside the staging directory), NOT a real mod's own package -- an unrelated pair of dummy
        // stubs sharing that folder (e.g. "Bashed Patch, 0.esp" and "TavernGames.esp") got grouped
        // as "siblings," so siblingsByModName wrongly concluded one was an alternate format of the
        // other just because both happened to be active/present. Still worth KNOWING a given
        // filename lives there, though (modNameByPlugin/folderPathByModName -- lets "Open Staging
        // Folder" point at it) -- what's actually wrong is cross-referencing its contents against
        // each other, so only siblingsByModName/hollowInstalls skip it, never the plain per-file maps.
        const isDummyMastersFolder = !!excludeDirAbs && path.resolve(modDir) === excludeDirAbs;
        let entries;
        try {
            entries = fs.readdirSync(modDir, { withFileTypes: true });
        } catch {
            continue; // unreadable subfolder -- skip it, don't fail the whole index over one mod
        }
        if (entries.length === 0) {
            // An empty Dummy Masters output folder isn't a "hollow install" to offer Rebuild This Mod
            // for -- there's no real archive behind it to rebuild from.
            if (!isDummyMastersFolder) {
                hollowInstalls.push({ folderName: folder.name, modName });
                folderPathByModName.set(modName, modDir);
            }
            continue;
        }
        const modPlugins = new Set();
        for (const entry of entries) {
            if (entry.isFile() && isPluginFile(entry.name)) {
                const key = entry.name.toLowerCase();
                modNameByPlugin.set(key, modName);
                modPlugins.add(key);
            }
        }
        const dataDirEntry = entries.find((e) => e.isDirectory() && e.name.toLowerCase() === 'data');
        if (dataDirEntry) {
            let dataFiles;
            try {
                dataFiles = fs.readdirSync(path.join(modDir, dataDirEntry.name));
            } catch {
                dataFiles = []; // unreadable Data subfolder -- the root-level files above still count
            }
            for (const file of dataFiles) {
                if (isPluginFile(file)) {
                    const key = file.toLowerCase();
                    modNameByPlugin.set(key, modName);
                    modPlugins.add(key);
                }
            }
        }
        if (modPlugins.size > 0) {
            folderPathByModName.set(modName, modDir);
            if (!isDummyMastersFolder) {
                // Rare but real: two differently-named staging folders could resolve to the SAME
                // stripped modName (e.g. two installed revisions) -- merge rather than overwrite so
                // sibling-detection still sees every plugin file either one ever contained.
                const existing = siblingsByModName.get(modName);
                if (existing) for (const p of modPlugins) existing.add(p);
                else siblingsByModName.set(modName, modPlugins);
            }
        }
    }
    return { modNameByPlugin, siblingsByModName, hollowInstalls, folderPathByModName };
}

// Best-effort token-overlap match between a missing master's own filename and a hollow install's
// cleaned name -- e.g. "Snazzy Interiors - Morthal AIO.esp" vs. hollow install "Snazzy Morthal AIO"
// (stripped from "Snazzy Morthal AIO-147759-2-1-1751281253") shares 3 significant tokens. This is
// deliberately a GUESS, shown to the user plainly (not asserted as fact) rather than verified against
// Vortex's own records up front -- per the user's own explicit call: the risk of guessing wrong here
// is cheap (it's just staging/archive data, trivially deleted and re-obtained from Nexus if the
// rebuild turns out to target the wrong mod), so this favors a lightweight, transparent heuristic
// over an elaborate "prove it's the right mod first" search across every installed mod's archive.
function significantTokens(name) {
    return new Set(
        name.toLowerCase()
            .replace(/\.[a-z0-9]{2,4}$/i, '') // strip a trailing file extension if present
            .split(/[^a-z0-9]+/i)
            .filter((t) => t.length >= 3) // skip tiny/noise tokens ("a", "of", "ii" edge cases aside)
    );
}

// Vortex writes vortex.deployment.json to the Data folder root after every deploy -- a definitive,
// per-file record of which mod ACTUALLY deployed each file (`source`, the staging folder name) and
// its exact relPath under Data. Confirmed real 2026-07-27 (the 1DustAdeptArmor.esl case): this
// catches two things the plain Data-folder/staging scans can't on their own --
//   (1) which mod TRULY deployed a given active file -- two unrelated mods can ship an identically
//       named plugin (here, both "1DustAdeptArmorSE" and the completely unrelated "HDT-SMP Dust
//       Adept Armor CBBE 3BA and HIMBO" ship their own "1DustAdeptArmor.esp"), so a naive "found
//       this name in staging somewhere" guess can misattribute which mod is really active.
//   (2) a file Vortex deployed into a NESTED subfolder inside Data itself (e.g.
//       "data\1DustAdeptArmor.esl" -- a redundant extra "data" folder baked into that mod's own
//       staging structure, mirrored verbatim on deploy) -- genuinely present on disk, just
//       invisible to the game, since Skyrim only reads Data's own root, never one of Data's own
//       subfolders.
// Best-effort only: if the manifest is missing/unreadable (Vortex has never deployed, or this is an
// unusual deployment method), every lookup below just comes back empty -- never a hard dependency
// for the rest of this scan.
function readDeploymentManifest(dataDir) {
    const byBaseName = new Map(); // Map<lowercased plugin basename, { source: stripped modName, relPath }>
    try {
        const raw = fs.readFileSync(path.join(dataDir, 'vortex.deployment.json'), 'utf8').replace(/^﻿/, '');
        const data = JSON.parse(raw);
        if (Array.isArray(data.files)) {
            for (const f of data.files) {
                if (!f.relPath || !f.source) continue;
                const baseName = path.basename(f.relPath).toLowerCase();
                if (!isPluginFile(baseName)) continue;
                byBaseName.set(baseName, { source: stripDownloadNameSuffix(f.source), relPath: f.relPath });
            }
        }
    } catch {
        // Missing/unreadable/never-deployed -- fine, this is a best-effort enrichment only.
    }
    return byBaseName;
}

function findPossibleHollowInstall(masterFileName, hollowInstalls) {
    const masterTokens = significantTokens(masterFileName);
    if (masterTokens.size === 0) return null;
    let best = null;
    let bestScore = 0;
    for (const hollow of hollowInstalls) {
        const hollowTokens = significantTokens(hollow.modName);
        if (hollowTokens.size === 0) continue;
        let shared = 0;
        for (const t of hollowTokens) if (masterTokens.has(t)) shared++;
        // Require at least 2 shared significant words AND that they cover most of the SMALLER
        // token set -- guards against a single common/short word (e.g. just "patch") coincidentally
        // matching two unrelated mods.
        const smaller = Math.min(masterTokens.size, hollowTokens.size);
        if (shared < 2 || shared / smaller < 0.5) continue;
        if (shared > bestScore) {
            bestScore = shared;
            best = hollow;
        }
    }
    return best;
}

// Full scan: for every currently-active plugin, reads its own master list and classifies each
// declared master. Returns { total, problemMasters } where problemMasters is one entry per problem
// master, e.g.:
//   { name: 'GTS Patches - OWL.esp', status: 'present-but-inactive', modName: 'GTS Patches - OWL',
//     neededBy: [{ name: 'GTS - New Armors.esp', modName: 'GTS - New Armors' }, ...] }
function scanMissingMasters(dataDir, pluginsTxtPath, stagingDir, dummyMastersOutputDir, eslifierOutputDir) {
    const filesOnDisk = scanDataFolder(dataDir);
    const pluginsTxt = readPluginsTxt(pluginsTxtPath);
    const active = computeActiveSet(filesOnDisk, pluginsTxt);
    const dummyMastersOutputDirAbs = dummyMastersOutputDir ? path.resolve(dummyMastersOutputDir) : null;
    const { modNameByPlugin, siblingsByModName, hollowInstalls, folderPathByModName } = buildStagingModNameIndex(stagingDir, dummyMastersOutputDirAbs);
    // Same stripped name buildStagingModNameIndex would derive for the Dummy Masters output folder
    // itself -- used to keep readyToDeploy from firing on a dummy stub sitting there (see below).
    const dummyMastersModName = dummyMastersOutputDirAbs ? stripDownloadNameSuffix(path.basename(dummyMastersOutputDirAbs)) : null;
    // ESLifier awareness: vortex.deployment.json's own `source` for a file ESLifier produced is the
    // literal (stripped) ESLifier output folder name -- confirmed real 2026-08-14 against the user's
    // own live manifest (E:\...\Data\vortex.deployment.json), where every ESLifier-produced file's
    // `source` is exactly "ESLifier Output", matching that staging folder's own raw name verbatim
    // (stripDownloadNameSuffix is a no-op on it -- it doesn't match the modId-version-timestamp
    // pattern). Deriving eslifierModName the SAME way (stripDownloadNameSuffix on the configured
    // folder's own basename) means this still matches correctly even if the user's folder happens to
    // be named some other stub-suffixed way. Case-insensitive compare below (Windows folder names).
    const eslifierOutputDirAbs = eslifierOutputDir ? path.resolve(eslifierOutputDir) : null;
    const eslifierModName = eslifierOutputDirAbs ? stripDownloadNameSuffix(path.basename(eslifierOutputDirAbs)) : null;
    const deploymentByBaseName = readDeploymentManifest(dataDir);
    const modNameFor = (fileName) => modNameByPlugin.get(fileName.toLowerCase()) || null;
    // "Open Staging Folder" needs a real path to hand to Explorer -- available whenever this
    // master's own mod name resolves back to a folder we actually found on disk (whether that
    // folder is hollow, has an active alternate, or is otherwise just where the mod lives).
    const stagingFolderFor = (fileName) => {
        const modName = modNameFor(fileName);
        return modName ? folderPathByModName.get(modName) || null : null;
    };

    // Confirmed real-world case 2026-07-27: a "missing" master's own mod can genuinely be installed
    // and active RIGHT NOW, just deployed under a DIFFERENT plugin filename from the same mod
    // package (some mod authors ship an on/off pick-one-format choice, e.g. both an .esp and an .esl
    // variant of the same content -- the collection that installed it picked one, the missing master
    // needs the other). Rather than looking like a truly absent mod, this is a format mismatch the
    // user can very likely fix themselves (re-running that mod's own installer/FOMOD with the other
    // choice) -- worth surfacing as its own distinct signal. Only meaningful for 'missing' masters --
    // a 'present-but-inactive' one's own file already exists on disk, so this question doesn't apply.
    function findActiveAlternate(masterFileName) {
        const modName = modNameFor(masterFileName);
        if (!modName) return null;
        const siblings = siblingsByModName.get(modName);
        if (!siblings) return null;
        const masterKey = masterFileName.toLowerCase();
        for (const siblingKey of siblings) {
            if (siblingKey === masterKey) continue;
            if (active.has(siblingKey)) {
                const onDisk = filesOnDisk.get(siblingKey);
                if (!onDisk) continue;
                // A shared NAME doesn't guarantee a shared MOD -- confirmed real 2026-07-27:
                // "1DustAdeptArmor.esp" is shipped by both "1DustAdeptArmorSE" (this master's own mod)
                // AND the totally unrelated "HDT-SMP Dust Adept Armor CBBE 3BA and HIMBO". Cross-check
                // Vortex's own deployment manifest for the file's TRUE source; only fall back to
                // assuming it's this same mod when the manifest has no record for it at all (e.g. it
                // was never deployed through Vortex's own deploy step).
                const deployedEntry = deploymentByBaseName.get(siblingKey);
                const trueSourceModName = deployedEntry ? deployedEntry.source : modName;
                // The user's OWN deliberate ESLifier swap -- confirmed real 2026-08-14 (see this
                // function's own header comment): the true source resolves to the configured
                // ESLifier output folder, so this "name collision" is actually a known, intentional
                // ESL-flagged replacement, not a genuinely different mod stepping on this one's name.
                const eslifierSwap = !!eslifierModName && trueSourceModName.toLowerCase() === eslifierModName.toLowerCase();
                return { name: onDisk.actualFileName, modName: trueSourceModName, sameModAsMaster: trueSourceModName === modName, eslifierSwap };
            }
        }
        return null;
    }

    // Confirmed real 2026-07-27 (1DustAdeptArmor.esl): a "missing" master can genuinely already be
    // deployed on disk -- just one folder too deep inside Data itself (e.g.
    // "Data\data\1DustAdeptArmor.esl", mirroring a redundant "data" subfolder baked into the mod's
    // own staging structure), which Skyrim never reads since it only looks at Data's own root. Only
    // reported when the deployment manifest's own recorded source for that file matches THIS
    // master's own mod (not a same-named file some unrelated mod deployed) and the file genuinely
    // still exists there right now (the manifest itself can go stale between deploys).
    function findDeployedMisplaced(masterFileName, masterModName) {
        if (!masterModName) return null;
        const entry = deploymentByBaseName.get(masterFileName.toLowerCase());
        if (!entry || entry.source !== masterModName) return null;
        const relDir = path.dirname(entry.relPath);
        if (!relDir || relDir === '.') return null; // deployed straight to Data's own root -- not misplaced
        const actualPath = path.join(dataDir, entry.relPath);
        if (!fs.existsSync(actualPath)) return null; // manifest may be stale -- only report what's really there now
        return { relPath: entry.relPath, actualPath, containingFolder: path.dirname(actualPath) };
    }

    // Grouped by the PROBLEM MASTER itself, not the requiring plugin -- confirmed real-world need
    // 2026-07-27 (UX-UI-DEPENDENCY-DESIGNER.md's master-first recommendation, applied against this
    // exact live data): a single widely-required master (e.g. one patch's own prerequisite) can be
    // the root cause behind many separate requiring plugins at once -- a plugin-first list would
    // repeat that same master's name once per requiring plugin, obscuring that fixing it ONE time
    // resolves every one of those dependents. `problemMastersByKey` collects every requiring plugin
    // under its shared master instead.
    const problemMastersByKey = new Map(); // lowercased master name -> { name, status, modName, neededBy: [] }
    let scanned = 0;
    for (const [key, info] of filesOnDisk) {
        if (!active.has(key)) continue;
        scanned++;
        const fullPath = path.join(dataDir, info.actualFileName);
        let header;
        try {
            header = readPluginHeader(fullPath);
        } catch {
            continue; // unreadable file -- skip rather than fail the whole scan over one bad plugin
        }
        if (!header || header.compressed || !header.masters || header.masters.length === 0) continue;

        for (const master of header.masters) {
            const mKey = master.toLowerCase();
            const onDisk = filesOnDisk.get(mKey);
            let status;
            if (!onDisk) status = 'missing';
            else if (!active.has(mKey)) status = 'present-but-inactive';
            else continue; // this particular master is fine -- not a problem for THIS requiring plugin

            // activeAlternate MUST be computed BEFORE readyToDeploy, not gated behind it -- confirmed
            // real 2026-07-27 (1DustAdeptArmor.esl): a mod author packaging BOTH an .esp and .esl
            // variant, one active one not, means the master's OWN file can genuinely sit in staging
            // (modNameByPlugin has it) while the real, still-unresolved problem is a manual
            // active/inactive format mismatch -- NOT a pending Vortex deploy. That needs the user to
            // manually swap files; a "just open Vortex and deploy" message would be actively wrong
            // for it. activeAlternate is the more specific, more actionable diagnosis whenever it
            // applies, so it always wins over the more generic "found in staging somewhere" signal.
            const masterModName = modNameFor(master);
            const activeAlternate = status === 'missing' ? findActiveAlternate(master) : null;
            const deployedMisplaced = status === 'missing' ? findDeployedMisplaced(master, masterModName) : null;
            // Confirmed real-world case 2026-07-27: a single-mod rebuild (Missing Masters' own
            // "Rebuild This Mod") restores a master's file into its STAGING folder, but that alone
            // doesn't put it in the Data folder this scan actually checks -- Vortex itself still has
            // to deploy, a separate step the user has to trigger (open Vortex, confirm "External
            // Changes"/click Deploy Mods). Without this check, a master stays flagged red/critical
            // even right after a successful rebuild, reading as "nothing happened" when the real fix
            // already worked and only deployment is pending. Only applies when there's no
            // activeAlternate or deployedMisplaced (see above) -- both are more specific diagnoses
            // than "found in staging, just needs a normal deploy" whenever they apply. Also excludes
            // a hit that only resolves back to the Dummy Masters output folder itself -- confirmed
            // real 2026-07-28: that folder isn't a real Vortex-tracked mod (see espWriter.
            // createDummyMaster's own "still needs to become an active mod in Vortex" framing), so
            // "Open Vortex and click Deploy Mods" would be actively wrong guidance for a dummy stub
            // sitting there -- a normal deploy wouldn't pick it up at all.
            const readyToDeploy = status === 'missing' && !activeAlternate && !deployedMisplaced
                && modNameByPlugin.has(mKey) && masterModName !== dummyMastersModName;
            if (!problemMastersByKey.has(mKey)) {
                problemMastersByKey.set(mKey, {
                    name: master,
                    status,
                    modName: masterModName,
                    stagingFolderPath: status === 'missing' ? stagingFolderFor(master) : null,
                    readyToDeploy,
                    activeAlternate,
                    deployedMisplaced,
                    possibleHollowInstall: status === 'missing' && !readyToDeploy && !activeAlternate && !deployedMisplaced
                        ? (() => {
                            const hollow = findPossibleHollowInstall(master, hollowInstalls);
                            return hollow ? { folderName: hollow.folderName, modName: hollow.modName, vortexModId: hollow.folderName } : null;
                        })()
                        : null,
                    neededBy: [],
                });
            }
            problemMastersByKey.get(mKey).neededBy.push({ name: info.actualFileName, modName: modNameFor(info.actualFileName) });
        }
    }

    const problemMasters = [...problemMastersByKey.values()];
    for (const m of problemMasters) m.neededBy.sort((a, b) => a.name.localeCompare(b.name));
    // Highest-impact fix first (most requiring plugins), then alphabetical by master name for ties
    // -- stable, scannable order, not scan-order-dependent (fs.readdirSync's own order isn't
    // guaranteed to be alphabetical on every platform).
    problemMasters.sort((a, b) => b.neededBy.length - a.neededBy.length || a.name.localeCompare(b.name));

    return { total: scanned, problemMasters };
}

module.exports = {
    scanMissingMasters,
    // Exported for the create-dummy-master route to re-validate a name still needs one before
    // writing (e.g. re-run scanDataFolder to confirm the master is still actually absent).
    scanDataFolder,
    isPluginFile,
    // Exported 2026-08-17 for lib/merge-plugin-scan.js's own computeMasterDependents (Merge
    // Plugins' pre-build masters-dependency check) -- the exact same "which plugins are truly
    // active right now" primitives this file's own scanMissingMasters already uses, reused rather
    // than reimplemented.
    readPluginsTxt,
    computeActiveSet,
    // Exported 2026-08-17 for web/merge-routes.js's own Merge Settings "disable" action -- see this
    // function's own header comment for why per-plugin disabling needs Plugins.txt, not the modState
    // LevelDB write every other live-write feature in this app uses.
    disablePluginsInPluginsTxt,
};
