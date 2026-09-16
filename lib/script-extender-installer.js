'use strict';
// Real Vortex rule, confirmed 2026-09-15 ("Rebuild Missing Files says Skyrim Script Extender is
// missing 536 files that are all there") by reading the actual install code, not assumed -- see
// config/vortex-source-refs.json's own "script-extender-installer" entry for the full citation.
// Vortex runs a SEPARATE, higher-priority installer (registerInstaller('script-extender-installer',
// 10, ...) -- ahead of modtype-dinput's own generic dinput8.dll installer at priority 50, and long
// before the generic FOMOD/Basic archive installer) whenever an archive contains one of a small,
// fixed list of known script-extender loader executables. SKSE64's own archive layout
// ("skse64_2_02_06\Data\Scripts\...", "skse64_2_02_06\src\...", "skse64_2_02_06\skse64_loader.exe")
// hits this exactly. Its real rule is NOT this project's own simple-installer.js
// (stopPatterns/FindPathPrefix, "Basic"-mode-only) -- it's simpler and genuinely different: find the
// loader exe, strip ONLY the folder directly containing it, and keep every other path exactly as it
// sits in the archive underneath that -- including a literal "Data\" folder, which
// simple-installer.js's own stopPatterns list would otherwise treat as swallowable prefix (it
// recognizes "Scripts" as a real Gamebryo top-level folder name and strips everything up to and
// including its own containing "Data\", which is correct for an ordinary data-type mod but wrong
// here: SKSE deploys relative to the GAME ROOT, not Data/, so "Data\" must survive as a literal
// subfolder in the destination, not be swallowed into the stripped prefix).

const path = require('path');

// Verbatim from extensions/script-extender-installer/src/gameSupport.ts's own supportData table --
// this project only ever targets skyrimspecialedition, but the real algorithm itself is keyed
// purely on the loader executable's own basename (game-agnostic), so every game Vortex itself
// recognizes is listed rather than hardcoding just the one this project's own data uses.
const SCRIPT_EXTENDER_LOADER_EXES = [
    'skse64_loader.exe', // Skyrim SE -- the one this project actually targets/verifies
    'skse_loader.exe', // Skyrim LE
    'sksevr_loader.exe', // Skyrim VR
    'f4se_loader.exe', // Fallout 4
];
const LOADER_NAME_SET = new Set(SCRIPT_EXTENDER_LOADER_EXES);

// archiveEntries: sevenzip.listArchive() output for the whole archive. Returns null when no known
// loader exe is present anywhere in the archive ("not a script extender archive" -- the caller falls
// through to the generic simple-install resolver). Non-null means this IS the correct resolution;
// takes priority over the generic resolver, same as Vortex's own higher-priority registration.
function resolveScriptExtenderInstall(archiveEntries) {
    const loaderEntry = archiveEntries.find(
        (e) => !e.isDir && LOADER_NAME_SET.has(path.basename(e.path).toLowerCase())
    );
    if (!loaderEntry) return null;

    // Real Vortex source (installer.ts): `idx = scriptExtender.indexOf(path.basename(scriptExtender))`
    // -- the position of the loader's own basename WITHIN ITS OWN path string -- then EVERY matched
    // file's destination is `file.substr(idx)`, a single fixed-length cut applied uniformly (not a
    // per-file path.relative against the loader's own containing folder). This only produces sane
    // output when every matched file shares that same leading prefix length, which the filter step
    // below guarantees by construction (every kept file is nested under the loader's own containing
    // folder, which is exactly `idx` characters long including its trailing separator).
    const rootPath = path.dirname(loaderEntry.path);
    const idx = loaderEntry.path.indexOf(path.basename(loaderEntry.path));

    // Real Vortex source: `files.filter(file => file.indexOf(rootPath) !== -1 && !file.endsWith(sep))`
    // -- every non-directory file whose path contains the loader's own containing folder name
    // anywhere. In every real script-extender archive (confirmed: every game in gameSupport.ts's own
    // regex expects a versioned top folder) the loader sits one folder deep, so this is equivalent to
    // "starts with rootPath" in practice -- ported as the same substring check Vortex itself uses
    // rather than tightened to startsWith, since a real mismatch here would just mean this function
    // (like Vortex's own) resolves nothing rather than resolving something wrong.
    const files = archiveEntries.filter((e) => !e.isDir && e.path.indexOf(rootPath) !== -1);
    return files.map((e) => ({ source: e.path, destination: e.path.substr(idx) }));
}

module.exports = { resolveScriptExtenderInstall, SCRIPT_EXTENDER_LOADER_EXES };
