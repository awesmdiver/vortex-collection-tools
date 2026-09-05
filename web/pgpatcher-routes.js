'use strict';
// PGPatcher Load Order Editor -- backend for docs/plans/2026-08-19-pgpatcher-load-order-tool.md.
// Shells out to the real, compiled `pgtools.exe` (built from the sibling fork,
// skyrim-modding/pgpatcher-fork -- see its own handoff for the JSON contract this consumes) rather
// than reimplementing PGPatcher's own conflict-detection/patching logic -- same reasoning as
// lib/bsab-cli.js's own BSA Browser integration: call the real compiled engine as a subprocess,
// never link against or port its GPLv3 code.
//
// Three real steps, matching the plan doc's own "read the data, show the sort window, create
// modrules.json, build the output" flow (steps 2 -- the sort window itself -- is pure client-side
// logic in pgpatcher-app.js, nothing here):
//   1. READ THE DATA  -- POST /load + GET /load/events (SSE)  (spawns `pgtools conflicts`,
//      dry-run, writes nothing; streams real phase/progress lines parsed from its own log output)
//   3. CREATE modrules.json -- POST /save   (backs up the existing file first, then writes it)
//   4. BUILD THE OUTPUT      -- POST /build  (spawns `pgtools patch`, the REAL, unmodified output
//      pipeline -- this is the expensive one, texture patching included, can take a while)

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const express = require('express');
const { createSseSession } = require('./sse-session');
const helperClient = require('../lib/vortex-helper-client');
const syncLib = require('../lib/vortex-sync/lib');
const { pickOpenFileAsync } = require('../lib/vortex-sync/win-dialog');

// Resolved the same way lib/sevenzip.js resolves 7z.exe -- bundled copy first (build-release.ps1's
// own "Bundle pgtools.exe" step stages it at tools/pgtools/pgtools.exe alongside its real runtime
// DLLs/resource folders, so a downloaded release always runs against the exact pgtools build it was
// tested with, with no PGPatcher GUI install required -- see requirePgtoolsInstalled's own comment
// for what that install check actually means now). The old hardcoded sibling-repo dev-build path
// (skyrim-modding/pgpatcher-fork's own build/bin/) is kept as a local-dev-only fallback, checked
// AFTER the bundled path -- this project's own tools/ folder already holds a couple of other
// gitignored, manually-placed dev tools (bsa-browser-cli/, oxipng/) on exactly this pattern, so
// nothing about keeping it is new. Without it, every dev session actively working on THIS project
// would need to manually populate tools/pgtools/ first before PGPatcher features work locally at
// all; keeping it costs nothing when the file isn't there (existsSync just returns false and moves
// on to the next candidate).
const PGTOOLS_EXE_CANDIDATES = [
    path.join(__dirname, '..', 'tools', 'pgtools', 'pgtools.exe'),
    'F:\\Claude Workspace\\skyrim-modding\\pgpatcher-fork\\build\\bin\\pgtools.exe',
];
function resolvePgtoolsExe() {
    for (const p of PGTOOLS_EXE_CANDIDATES) {
        if (fs.existsSync(p)) return p;
    }
    return PGTOOLS_EXE_CANDIDATES[0]; // bundled path -- best "expected" location for the not-found message
}
const PGTOOLS_EXE = resolvePgtoolsExe();

// `opts.onSpawn`, when given, is called with the real child process the instant it's spawned --
// lets a caller keep a reference to kill it early (/load's own Cancel below). `opts.onLine`, when
// given, is called with each complete stdout line as it arrives (buffered across chunk boundaries
// -- pgtools' own spdlog output doesn't line up with OS pipe buffer boundaries) -- this is what
// lets /load turn real log lines into live progress events. Both optional and backward-compatible:
// /build passes neither and behaves exactly as before.
function runPgtools(args, opts = {}) {
    const { onSpawn, onLine } = opts;
    return new Promise((resolve, reject) => {
        const child = spawn(PGTOOLS_EXE, args, { windowsHide: true });
        if (onSpawn) onSpawn(child);
        let stdout = '';
        let stderr = '';
        let pendingLine = '';
        child.stdout.on('data', (d) => {
            const text = d.toString();
            stdout += text;
            if (!onLine) return;
            pendingLine += text;
            const lines = pendingLine.split(/\r?\n/);
            pendingLine = lines.pop(); // last element is a partial line -- hold it for the next chunk
            for (const line of lines) onLine(line);
        });
        child.stderr.on('data', (d) => { stderr += d; });
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
}

// The last handful of log lines, for an error message -- pgtools' own spdlog output can be pages
// long on a real ~2000-mod install; only the tail is ever useful for "what actually went wrong."
function tail(text, lines) {
    const parts = text.split(/\r?\n/).filter(Boolean);
    return parts.slice(-lines).join('\n');
}

// Turns pgtools' own real spdlog lines into live progress events for /load -- confirmed by reading
// PGLib's actual source (PGModManager.cpp, PGDirectory.cpp, PGPatcher.cpp, TaskTracker.cpp), not
// guessed from the GUI. No progress-callback hook is wired up by PGTools itself today (the plumbing
// exists in PGLib but the CLI passes an empty callback) -- parsing these log lines is the real,
// only-available signal, and it's the same mechanism PGPatcher's own GUI progress bar is built on.
// Two phases (NIF loading, mesh/shader conflict-matching) log a real "N/M [P%]" on every
// percentage-point change (TaskTracker::printJobStatus); every other phase only announces its own
// start, with no count. Matched with `.includes()`/unanchored regex rather than exact-line equality
// because spdlog's own configured pattern prefixes every line with a timestamp/level this project
// doesn't control and shouldn't have to keep in lockstep with.
const PGTOOLS_PHASE_LINES = [
    ['Populating mods from Vortex', "Reading your installed mods from Vortex…"],
    ['Finding Relevant Files', 'Finding the mod files that matter…'],
    ['Starting to build texture mappings', 'Mapping textures…'],
    ['Waiting for plugin mesh use mapping to complete', 'Checking which meshes each plugin uses…'],
    ['Waiting for extended texture classification to complete', 'Classifying textures…'],
    ['Waiting for setting plugin model uses to complete', 'Linking plugins to their meshes…'],
    // These two only ever appear on a real `patch` run (/build) -- `conflicts` (/load) is a dry run
    // that never reaches PGTools' own save/finalize step at all, so they're harmless no-ops there.
    ['Waiting for files to finish saving', 'Finishing up…'],
    ['Saving Plugins', 'Saving plugin files…'],
];
// pgtools' own internal task names (TaskTracker's `m_taskName`), translated to plain language.
const PGTOOLS_TASK_LABELS = {
    'Loading NIFs': 'Loading meshes',
    'Mesh Patcher': 'Checking for conflicts',
    // Only ever logged by a real `patch` run (/build) -- `conflicts` (/load) never calls
    // patchTextures at all, so this label is unused there, not a behavior change for /load.
    'Texture Patcher': 'Patching textures',
};
const PGTOOLS_PROGRESS_RE = /(.+?) Progress: (\d+)\/(\d+) \[(\d+)%\]/;
const PGTOOLS_STARTING_RE = /(.+?) Starting\.\.\./;

// spdlog's own configured pattern prefixes every real line with `[timestamp] [level] `
// (e.g. "[2026-08-19 17:54:28.283] [info] Mesh Patcher Progress: 39974/88829 [45%]") -- confirmed
// live: without stripping this first, the unanchored `(.+?)` task-name capture above greedily
// swallows the WHOLE prefix (there's only one "Progress:"/"Starting..." per line, so the lazy
// quantifier still has nowhere else to stop), landing the raw timestamp in the UI instead of a
// clean "Mesh Patcher" label. Strip up to two leading bracket groups before matching.
function stripSpdlogPrefix(line) {
    return line.replace(/^\s*(?:\[[^\]]*\]\s*){1,2}/, '');
}

function parsePgtoolsLine(rawLine) {
    const line = stripSpdlogPrefix(rawLine);
    const progressMatch = line.match(PGTOOLS_PROGRESS_RE);
    if (progressMatch) {
        const [, taskName, current, total, percent] = progressMatch;
        const label = PGTOOLS_TASK_LABELS[taskName] || taskName;
        return {
            type: 'progress',
            message: `${label}…`,
            current: Number(current),
            total: Number(total),
            percent: Number(percent),
        };
    }
    const startingMatch = line.match(PGTOOLS_STARTING_RE);
    if (startingMatch) {
        const label = PGTOOLS_TASK_LABELS[startingMatch[1]] || startingMatch[1];
        return { type: 'phase', message: `${label}…` };
    }
    for (const [needle, message] of PGTOOLS_PHASE_LINES) {
        if (line.includes(needle)) return { type: 'phase', message };
    }
    return null;
}

// PGPatcher's own real settings.json (same cfg folder as modrules.json) is the SOURCE OF TRUTH for
// which shader patchers are active and where real output goes -- deliberately NOT duplicated into
// this project's own config, so it can never drift out of sync with whatever the director's real
// PGPatcher GUI is actually configured to do (see lib/app-config.js's own pgpatcherCfgDir comment).
// Read fresh on every request, never cached.
function readPgpatcherSettings(cfgDir) {
    const settingsPath = path.join(cfgDir, 'settings.json');
    let raw;
    try {
        raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch (e) {
        const err = new Error(`Couldn't read PGPatcher's own settings.json at ${settingsPath}: ${e.message}`);
        // Preserve the original fs error code (ENOENT when the file simply doesn't exist yet -- the
        // expected state before the real PGPatcher GUI has ever been run/saved; undefined for a
        // JSON.parse SyntaxError, since that only happens when the file DOES exist but is corrupted)
        // so requirePgpatcherSettings below can tell those two genuinely different problems apart.
        err.code = e.code;
        throw err;
    }
    const params = raw.params || {};
    const shaderPatcher = params.shaderpatcher || {};
    const shaderTransforms = params.shadertransforms || {};
    const prePatcher = params.prepatcher || {};
    const postPatcher = params.postpatcher || {};
    const patchers = [];
    if (shaderPatcher.truepbr) patchers.push('truepbr');
    if (shaderPatcher.complexmaterial) patchers.push('complexmaterial');
    if (shaderPatcher.parallax) patchers.push('parallax');
    if (shaderTransforms.parallaxtocm) patchers.push('parallaxtocm');
    // Real gap found live (2026-08-19): this used to only read shaderpatcher/shadertransforms,
    // missing prepatcher/postpatcher entirely -- a real build against the director's own real
    // settings.json (fixsss/hairflowmap both on) silently dropped both, producing real output
    // 11,594 files short of the real GUI's own build. fixmeshlighting/fixsss/hairflowmap all have
    // real, confirmed pgtools CLI tokens (PGTools/src/main.cpp's own patcherDefs handling) that
    // match these exact settings.json keys.
    if (prePatcher.fixmeshlighting) patchers.push('fixmeshlighting');
    if (postPatcher.fixsss) patchers.push('fixsss');
    if (postPatcher.hairflowmap) patchers.push('hairflowmap');
    // Real gap found live (2026-08-20): postpatcher.disableprepatchedmaterials WAS wrongly flagged
    // here as having no CLI equivalent -- it does, just under a different name. The GUI's own
    // main.cpp (PGPatcher/src/main.cpp:518-521) wires this exact setting straight to
    // PatcherMeshPostRestoreDefaultShaders::getFactory() -- the SAME patcher PGTools already exposes
    // as `restoredefaultshaders`. Confirmed via a live traced mesh (Legacy of the Dragonborn's
    // heavycuirass_1.nif): our build rejected it as "no changes" and wrote nothing, while the real
    // GUI produced a real output file for it -- this exact patcher being silently missing is why.
    if (postPatcher.disableprepatchedmaterials) patchers.push('restoredefaultshaders');
    // globalpatcher.fixeffectlightingcs, unlike the above, genuinely has no consumer anywhere --
    // confirmed via a full-repo grep (2026-08-20): it's read into PGConfig's own struct and
    // round-tripped back out to settings.json, but nothing, not even the GUI itself, ever reads
    // params.GlobalPatcher.fixEffectLightingCS to do anything with it. Left unmapped deliberately --
    // there's genuinely nothing to map it to.
    const outputDir = params.output && params.output.dir;
    return { patchers, outputDir, settingsPath };
}

function requireConfigured(config, res) {
    if (!config.skyrimDataDir || !config.pgpatcherCfgDir) {
        res.status(400).json({
            error: 'not-configured',
            message: 'Set your Skyrim Data folder and PGPatcher cfg folder under Settings first.',
        });
        return null;
    }
    return { source: config.skyrimDataDir, cfgDir: config.pgpatcherCfgDir };
}

// PGTOOLS_EXE is resolved once at startup from PGTOOLS_EXE_CANDIDATES (see that constant's own
// comment) -- in a real shipped release this is always the bundled copy, so this check tripping at
// all should now be rare (only a missing/corrupted bundle). Nothing here confirmed the file actually
// exists before spawning it, though -- without this, a missing exe surfaces as a raw ENOENT from
// child_process, not a message telling the user what's actually wrong. Same shape as requireConfigured
// above -- writes the response itself and returns falsy on failure, so a caller just does
// `if (!requirePgtoolsInstalled(res)) return;`. The real absolute path is a server-side implementation
// detail, not something a user could act on -- logged server-side, not put in the response the UI
// displays.
//
// Bundling pgtools.exe does NOT mean the real PGPatcher GUI install becomes unnecessary, even though
// this check's own user-facing message currently reads that way -- confirmed directly from the fork's
// own source, not assumed: readPgpatcherSettings() above reads <cfgDir>/settings.json, and the ONLY
// code that ever WRITES that file is PGConfig::saveUserConfig() (PGPatcher/src/PGConfig.cpp), which
// lives entirely in the GUI project, never PGLib/PGTools -- PGTools' own settings.json handling
// (PGTools/src/main.cpp) only ever READS an existing file (warning + falling back to defaults for its
// OWN mesh-blocklist purposes if absent), it has no code path to create one from scratch. So a user
// still needs to install and run the real PGPatcher GUI at least once (configure it, then either hit
// Save in its Settings dialog or run one real patch) before this tool has anything to read. This
// message's wording is a design-side call (this project's own file-ownership rule), not changed here
// -- flagged in this task's own handoff.
function requirePgtoolsInstalled(res) {
    if (fs.existsSync(PGTOOLS_EXE)) return true;
    console.error(`pgtools.exe not found at ${PGTOOLS_EXE}`);
    res.status(400).json({
        error: 'pgtools-not-installed',
        message: "PGPatcher isn't installed yet — you can download PGPatcher below:",
        downloadLinks: [
            { label: 'NEXUSMODS', url: 'https://www.nexusmods.com/skyrimspecialedition/mods/120946' },
            { label: 'GitHub', url: 'https://github.com/hakasapl/PGPatcher' },
        ],
    });
    return false;
}

// Same shape as requireConfigured/requirePgtoolsInstalled above -- writes the response itself and
// returns falsy on failure, so a caller just does
// `const settings = requirePgpatcherSettings(cfg, res); if (!settings) return;` instead of its own
// try/catch. Distinguishes two genuinely different problems that readPgpatcherSettings' own
// preserved e.code lets us tell apart, rather than collapsing both into one raw error message:
// - settings.json genuinely doesn't exist yet (ENOENT) -- the expected state for anyone who hasn't
//   installed and run the real PGPatcher GUI at least once (see requirePgtoolsInstalled's own comment
//   above for the full citation on why bundling pgtools.exe doesn't remove this requirement). Fix is
//   "go run PGPatcher," so this gets the same downloadLinks treatment as requirePgtoolsInstalled.
// - settings.json EXISTS but couldn't be read/parsed (corrupted, or some other fs error) -- a real,
//   different problem. "Go install PGPatcher" would be actively wrong advice here; the fix is
//   re-saving from PGPatcher's own Settings dialog, so this gets its own distinct message and no
//   download links.
// Gate 1 for every route that genuinely needs a live Helper (queue: pgpatcher-helper-gate-on-start).
// Same write-the-response-and-return-falsy shape as requireConfigured/requirePgtoolsInstalled above,
// so a caller reads `if (!(await requireHelperAvailable(res))) return;` and nothing else.
//
// WHY THIS HAS TO COME FIRST, and why it is a SEPARATE gate rather than better wording on the ones
// below it. /load and /build both open with a DynDoLOD-active gate whose disable goes through the
// Helper. With Vortex closed that disable simply fails, and the route answered with
// DYNDOLOD_AUTO_DISABLE_FAILED_MESSAGE -- "DynDoLOD.esp is active and couldn't be disabled
// automatically, disable it yourself in Vortex first." Every word of that is true, and it is the
// right message for a real disable failure. It was just the ONLY thing said when the actual problem
// was that Vortex was not running at all: two genuinely different problems, one of them silently
// standing in for the other. Confirmed live.
//
// With this in front, those messages are untouched and now only ever describe what they actually
// mean: by the time either gate runs, the Helper is known to be reachable, so a failure there is a
// real disable failure and nothing else.
//
// 409 + 'helper-unavailable' is the standardized shape (DESIGN.md, "Helper-unavailable messaging"),
// the same one clear-update-flags-routes.js's own requireHelper and this file's /deploy-all return,
// and the frontend's pgpShowHelperUnavailable renders it.
async function requireHelperAvailable(res) {
    const available = await helperClient.checkHelperAvailable(syncLib.GAME_ID);
    if (!available) {
        res.status(409).json({
            error: 'helper-unavailable',
            message: 'The Vortex Collection Helper extension must be reachable (Vortex genuinely open) to use this tool.',
        });
        return false;
    }
    return true;
}

function requirePgpatcherSettings(cfg, res) {
    try {
        return readPgpatcherSettings(cfg.cfgDir);
    } catch (e) {
        if (e.code === 'ENOENT') {
            res.status(400).json({
                error: 'pgpatcher-not-configured',
                message: "PGPatcher hasn't been set up yet — open the real PGPatcher app, configure it, then click Save (or run a patch) once. Don't have it installed? Download PGPatcher below:",
                downloadLinks: [
                    { label: 'NEXUSMODS', url: 'https://www.nexusmods.com/skyrimspecialedition/mods/120946' },
                    { label: 'GitHub', url: 'https://github.com/hakasapl/PGPatcher' },
                ],
            });
            return null;
        }
        console.error(e.message);
        res.status(400).json({
            error: 'pgpatcher-settings-invalid',
            message: "PGPatcher's own settings file couldn't be read — it may be corrupted. Open PGPatcher and save your settings again from its Settings dialog to fix this.",
        });
        return null;
    }
}

// DynDOLOD gate -- pgtools.exe itself has NO equivalent check (confirmed: PGTools/src/main.cpp never
// calls getActivePlugins), but PGPatcher's own real GUI refuses to run at all while dyndolod.esp is
// active (PGPatcher/src/main.cpp, pgpatcher-fork): "DynDoLOD and TexGen outputs must be disabled
// prior to running PGPatcher." That message also mentions TexGen, but there's no separate TexGen
// check anywhere in the real source -- confirmed by grepping all of main.cpp and PGLib -- so this
// only checks for dyndolod.esp, same as the real code actually does.
//
// Reads the real plugins.txt the exact way BethesdaGame::getActivePlugins does (PGLib/src/common/
// BethesdaGame.cpp): %LOCALAPPDATA%\<per-game AppData folder>\plugins.txt. Confirmed via
// BethesdaGame::getAppDataLocation rather than assumed -- for GameType::SKYRIM_SE specifically the
// literal folder name is "Skyrim Special Edition" (matches this project's own documented load-order
// path in the Skyrim toolkit's own CLAUDE.md). This integration is SE-only (see lib/app-config.js's
// own pgpatcherCfgDir comment), so no VR branch is needed.
//
// A line only counts as active if it's `*`-prefixed (matched case-insensitively, same as the real
// code's own boost::iequals) AND the plugin file actually exists in the Skyrim Data folder -- the
// real getActivePlugins requires that too, so a stale plugins.txt entry left over from an uninstall
// doesn't wrongly block a real run.
function isDynDoLODActive(skyrimDataDir) {
    const localAppData = process.env.LOCALAPPDATA;
    if (!localAppData) return false; // nothing to check against -- fail open rather than block on a guess
    const pluginsPath = path.join(localAppData, 'Skyrim Special Edition', 'plugins.txt');
    let raw;
    try {
        raw = fs.readFileSync(pluginsPath, 'utf8');
    } catch (e) {
        return false; // no plugins.txt found -- nothing to gate on
    }
    for (const rawLine of raw.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#') || !line.startsWith('*')) continue;
        const name = line.slice(1).trim();
        if (name.toLowerCase() !== 'dyndolod.esp') continue;
        if (fs.existsSync(path.join(skyrimDataDir, name))) return true;
    }
    return false;
}

// Real DynDoLOD.esp disable -> re-enable flow, v2 (2026-08-21) -- REPLACES both the original static
// hard block AND the first automated attempt at this (resolveDynDoLODModId + whole-mod setModEnabled,
// commits 652f018/5b3b15a/90cf4b9, reverted in 5670cca). That first attempt disabled the entire mod
// that a stale vortex.deployment.json recorded as dyndolod.esp's "current owner" -- unreliable by
// construction whenever more than one installed mod ships a dyndolod.esp (confirmed live, director's
// own install: 4 different mods all contain one), since disabling the recorded "winner" just promotes
// the next-highest-priority mod that also has the file, and the plugin never actually goes inactive.
// It also had real collateral risk: disabling a whole MOD takes every OTHER file that mod provides
// offline too, not just the one plugin.
//
// This version targets the PLUGIN directly -- Vortex's own `state.loadOrder['dyndolod.esp'].enabled`
// flag, via the Vortex Collection Helper's `POST /plugins/:pluginName/set-enabled`
// (lib/vortex-helper-client.js's setPluginEnabled). Live-verified round-trip against the director's
// own real Vortex (2026-08-21): the dispatch flips the flag instantly and precisely, visible
// immediately in Vortex's own Plugins tab, with zero effect on any mod's other files -- no mod
// resolution needed at all, so the whole unreliable "which mod currently owns this" problem is gone
// by construction, not just patched around. Confirmed (director's own separate test, 2026-08-20) that
// leaving DynDoLOD's OWN mod(s) fully enabled the whole time is safe: PGPatcher's own settings already
// exclude DynDoLOD's generated LOD meshes/textures from its scan, so the only real gate PGPatcher's
// GUI enforces is "is DynDoLOD.esp itself active" -- nothing about the mesh/texture files.
//
// NO DEPLOY NEEDED AT ALL -- corrected 2026-08-21, director's own sharp catch: an earlier version of
// this comment claimed a full deploy was still required to reach plugins.txt. That was wrong, and the
// live test that seemed to "confirm" it was confounded (DynDoLOD.esp's own FILE had already been
// undeployed by earlier, unrelated mod-level testing at the time -- see the docs' own case study).
// The real mechanism, confirmed straight from Vortex's own source
// (extensions/gamebryo-plugin-management/src/util/PluginPersistor.ts): plugins.txt/loadorder.txt are
// written by a Redux PERSISTOR bound to state.loadOrder itself -- ANY change to that state schedules
// a write via `serialize()`'s own 200ms debounce (`doSerialize()`), with NO deploy involved at all.
// `doSerialize()` only ever omits a plugin from the output if it isn't in `mKnownPlugins` (the FILE
// isn't physically deployed) -- as long as this flow never touches the owning mod (it doesn't),
// dyndolod.esp's file stays right where it is, and the persistor's own write correctly reflects the
// new enabled/disabled flag as the `*` prefix within ~200ms. **Live re-verified end to end** (director's
// own real Vortex, 2026-08-21): dispatch disable -> plugins.txt shows `DynDOLOD.esp` unstarred within
// 2s, file still on disk -> dispatch re-enable -> `*DynDOLOD.esp` back within 2s. See
// docs/VORTEX-PLUGIN-ENABLE-DISABLE-REFERENCE.md for the full writeup.
//
// This also fully resolves the original "can't cancel a multi-minute deploy" problem that got the
// FIRST automated attempt reverted -- for THIS gate specifically, there's no deploy to be stuck in at
// all anymore. (The SEPARATE output-mod gate below is a genuinely different case -- that one really
// does need a full deploy, since it's unlinking real files from Data, not flipping a Redux flag -- see
// that section's own header comment.)
const DYNDOLOD_PLUGIN_NAME = 'DynDOLOD.esp';

// Serious register (plain-language-writer skill) -- a real write to Vortex's own live/shared database,
// not a casual confirmation, even though it's now fast. Names the manual alternative too (director's
// own explicit ask from the first build of this feature) -- Cancel here isn't a dead end, it's "go
// disable it yourself in Vortex, then click Start again" (this app never reruns the check on its own).
const DYNDOLOD_CONFIRM_MESSAGE = 'DynDoLOD.esp is not disabled. Would you like to disable it now?\n\nIf not, click Cancel, disable it directly in Vortex yourself, then click Start again.';
const DYNDOLOD_AUTO_DISABLE_FAILED_MESSAGE = "🛑 DynDoLOD.esp is active in your load order, and it couldn't be disabled automatically. Disable it yourself in Vortex first -- you can re-enable it afterward.";
const DYNDOLOD_REENABLE_FAILED_NOTE = " DynDoLOD.esp could not be re-enabled automatically -- re-enable it yourself in Vortex before your next play session.";

// Runs the REAL, full Vortex deploy pipeline (deployAllMods) with live progress streamed through
// whichever SSE session is already running -- used ONLY by the output-mod gate below now (the
// DynDoLOD gate no longer needs a deploy at all, see this section's own header comment). Polls
// getDeployAllProgress() on an interval WHILE deployAllMods() is in flight and always clears the
// interval once the deploy settles, success or not. Returns the same boolean deployAllMods() itself
// returns.
async function runFullDeployWithProgress(emitIfCurrent, phaseLabel) {
    emitIfCurrent({ type: 'phase', message: phaseLabel });
    const pollInterval = setInterval(async () => {
        const progress = await helperClient.getDeployAllProgress();
        if (progress && typeof progress.percent === 'number') {
            emitIfCurrent({ type: 'progress', message: phaseLabel, current: Math.round(progress.percent), total: 100 });
        }
    }, 1000);
    try {
        return await helperClient.deployAllMods();
    } finally {
        clearInterval(pollInterval);
    }
}

// Polls isDynDoLODActive(skyrimDataDir) (a plain plugins.txt + file-existence read) until it matches
// `expectedActive`, or timeoutMs elapses -- confirms the PluginPersistor's own debounced write (see
// this section's own header comment, ~200ms in practice) actually landed on disk before this route
// proceeds, rather than trusting a blind sleep. Always returns the final observed state, even on
// timeout, so the caller can tell a genuine failure apart from "technically still true but we waited
// long enough".
//
// 3s -> 15s (2026-08-21, live failure): the dispatch itself genuinely succeeded (confirmed after the
// fact -- both Vortex's own live Redux state and plugins.txt on disk correctly showed the new value),
// but the write hadn't landed within the old 3s ceiling because Vortex was busy with its own
// background work at that moment ("Checking archives", director's own live report) -- everything
// running on Vortex's single main thread, this project's own HTTP calls to the Helper included, can
// genuinely stall while Vortex is doing something else. Same class of problem as the already-
// documented ~83s deploy-mods block (vortex-helper-client.js's own header comment) -- this poll is a
// much cheaper write than a full deploy, but the same "Vortex's main thread can be busy" risk applies.
// 15s costs nothing in the normal case (the poll still resolves in ~200ms whenever Vortex isn't busy)
// but gives real headroom for exactly this scenario before falling back to
// DYNDOLOD_AUTO_DISABLE_FAILED_MESSAGE's own "do it yourself in Vortex" fallback.
async function waitForDyndolodPluginsTxtState(skyrimDataDir, expectedActive, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (isDynDoLODActive(skyrimDataDir) === expectedActive) return true;
        await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return isDynDoLODActive(skyrimDataDir) === expectedActive;
}

// Re-enables DynDoLOD.esp -- a no-op (returns true) if `disabledThisRequest` is falsy, i.e. this
// request never disabled anything to begin with. No deploy needed here either (see this section's own
// header comment). Never throws (a re-enable failure still needs the caller's own terminal SSE event
// to fire) -- returns false on failure so the caller can append DYNDOLOD_REENABLE_FAILED_NOTE to
// whatever message it was already about to emit.
async function reenableDyndolod(cfg, disabledThisRequest, emitIfCurrent) {
    if (!disabledThisRequest) return true;
    try {
        const enabledOk = await helperClient.setPluginEnabled(DYNDOLOD_PLUGIN_NAME, true);
        if (!enabledOk) return false;
        return await waitForDyndolodPluginsTxtState(cfg.source, true);
    } catch (e) {
        console.error('[pgpatcher] reenableDyndolod failed:', e.message);
        return false;
    }
}

// PGPatcher's own PRIOR OUTPUT gate (2026-08-21) -- a real GUI-only guard, separate from the
// DynDoLOD one above and for a genuinely different reason. The real GUI refuses to run at all if a
// leftover ParallaxGen_Diff.json marker from a previous build already exists in the real Data folder
// (PGPatcher/src/main.cpp:449-456, pgpatcher-fork): "PGPatcher meshes exist in your data directory,
// please delete before re-running." Confirmed this check runs at the very start of the GUI's own
// mainRunnerPrep, BEFORE any file scanning, and confirmed it runs unconditionally on every GUI launch
// (the real GUI has no separate "just check conflicts" mode at all -- mainRunner always chains
// mainRunnerPrep straight into mainRunnerPatch; the conflicts-vs-patch split is entirely this
// project's own pgtools-CLI-only concept). Applied to both /load and /build here for the same
// consistency reason the DynDoLOD gate already is.
//
// pgtools.exe itself has NO equivalent pre-flight check (confirmed: PGTools/src/main.cpp only ever
// WRITES ParallaxGen_Diff.json as part of its own output, never checks for a pre-existing one first)
// -- but unlike DynDoLOD, this isn't just a GUI-policy mismatch to mirror for consistency: if
// PGPatcher's own previous output mod stays enabled/deployed, its own conflict scan would see its
// prior output as just another live mod and could try to re-patch already-patched meshes. A real
// correctness risk for this project's own /build, not only a "match the GUI's own refusal" concern.
//
// Resolving WHICH mod to disable is unambiguous here, unlike DynDoLOD -- this is our own tool's
// configured output.dir (settings.outputDir, already read from PGPatcher's real settings.json), so
// there's exactly one real candidate: whichever live mod's own folder name matches
// path.basename(outputDir) exactly. No fuzzy stripDownloadNameSuffix matching needed (that's for
// cross-referencing a mod's Nexus-derived staging name against an author-recorded collection.json
// source name -- a different problem; this mod's folder name IS the configured output dir, verbatim).
function isPgpatcherOutputDeployed(skyrimDataDir) {
    return fs.existsSync(path.join(skyrimDataDir, 'ParallaxGen_Diff.json'));
}

async function resolveOutputMod(outputDir) {
    const folderName = path.basename(outputDir);
    const allMods = await helperClient.getAllMods();
    if (!allMods || !allMods.mods) return null;
    const enabledSet = new Set(allMods.enabledModKeys || []);
    for (const [modId, mod] of Object.entries(allMods.mods)) {
        const installPath = (mod && mod.installationPath) || modId;
        if (installPath === folderName) return { modId, enabled: enabledSet.has(modId) };
    }
    return null;
}

const OUTPUT_MOD_CONFIRM_MESSAGE = 'PGPatcher’s own previous output is still deployed in your Data folder. Disabling it (and redeploying) makes sure this run doesn’t process its own prior output as input — this can take a few minutes. Would you like to disable it and redeploy?\n\nIf not, click Cancel, disable and redeploy directly in Vortex yourself, then click Start again.';
const OUTPUT_MOD_AUTO_DISABLE_FAILED_MESSAGE = "🛑 PGPatcher's own previous output is still deployed in your Data folder, and it couldn't be disabled automatically. Disable it yourself in Vortex (and redeploy) first -- you can re-enable it afterward once this run finishes.";

// Unlike the DynDoLOD gate (now a plain synchronous preflight check, see this file's own "Real
// DynDoLOD.esp disable" header comment), this one can't be purely synchronous -- resolving the owning
// mod needs a real Vortex call. Returns null if there's nothing to gate on (no leftover marker at
// all, no configured output dir, the owning mod wasn't found, or it's already disabled). Otherwise
// returns `{ modId }` for the caller's own blockUntilOutputModConfirmed to use.
async function checkOutputModGate(cfg, settings) {
    if (!isPgpatcherOutputDeployed(cfg.source)) return null;
    if (!settings.outputDir) return null;
    const resolved = await resolveOutputMod(settings.outputDir);
    if (!resolved || !resolved.enabled) return null;
    return { modId: resolved.modId };
}

// `gate` is the caller's own already-resolved checkOutputModGate() result (or null). Returns true if
// it already wrote a 409 asking the frontend to show the confirm modal and retry.
function blockUntilOutputModConfirmed(gate, req, res) {
    if (!gate) return false;
    if (req.body && req.body.confirmDisableOutputMod) return false;
    res.status(409).json({ error: 'output-mod-active', message: OUTPUT_MOD_CONFIRM_MESSAGE, confirmDisableOutputMod: true });
    return true;
}

// Mod-level disable (this IS the right tool here, unlike DynDoLOD -- there's no individual plugin to
// target, ParallaxGen_Diff.json is a plain marker file, and the mod itself is unambiguous). Returns
// true on success, false on ANY failure.
async function disableOutputModForRequest(modId, emitIfCurrent) {
    emitIfCurrent({ type: 'phase', message: "Disabling PGPatcher's previous output…" });
    const disabledOk = await helperClient.setModEnabled(modId, false);
    if (!disabledOk) return false;
    return runFullDeployWithProgress(emitIfCurrent, "Deploying to disable PGPatcher's previous output…");
}

// Same backup-stamp shape this project already uses everywhere else it backs up a file before
// overwriting it (rebuild-missing-routes.js/rebuild-routes.js/update-collection-v2-runner.js):
// `new Date().toISOString().replace(/[:.]/g, '-')`.
function backupStamp() {
    return new Date().toISOString().replace(/[:.]/g, '-');
}

// Cross-drive backup fallback support. fs.promises.cp's own recursive copy gives no per-file
// progress hook, so a manual async walk-and-copy is used instead -- this also means the copy never
// blocks Node's event loop (unlike the old fs.cpSync), so the server can actually keep serving the
// /build/events SSE connection while a large real output folder (director's own ~1972-mod install)
// copies across physical drives. countFiles walks first for a real total; copyDirWithProgress then
// walks again doing the actual copy, calling onProgress(current, total) as it goes.
async function countFiles(dir) {
    let total = 0;
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        total += entry.isDirectory() ? await countFiles(full) : 1;
    }
    return total;
}

async function copyDirWithProgress(src, dest, total, onProgress) {
    let current = 0;
    let lastEmit = 0;
    async function walk(from, to) {
        await fs.promises.mkdir(to, { recursive: true });
        const entries = await fs.promises.readdir(from, { withFileTypes: true });
        for (const entry of entries) {
            const srcPath = path.join(from, entry.name);
            const destPath = path.join(to, entry.name);
            if (entry.isDirectory()) {
                await walk(srcPath, destPath);
                continue;
            }
            await fs.promises.copyFile(srcPath, destPath);
            current += 1;
            // Throttled to roughly 2/sec -- emitting per-file on a folder with tens of thousands of
            // files would flood the SSE stream for no visible UI benefit. Always emit the final one
            // (current === total) so the bar actually reaches 100% rather than stalling near it.
            const now = Date.now();
            if (now - lastEmit >= 500 || current === total) {
                lastEmit = now;
                onProgress(current, total);
            }
        }
    }
    await walk(src, dest);
}

function createPgpatcherRouter(config) {
    const router = express.Router();

    // Shared "finalize" step for DynDoLOD + the output mod -- director's own 4-case spec (2026-08-21):
    // the 4 cases are every combination of (DynDoLOD.esp enabled/disabled) x (output mod
    // enabled/disabled) at the moment /load's own preflight first runs. Two DIFFERENT treatments:
    // - DynDoLOD: if THIS session's own action disabled it (dyndolodDisabledThisRequest this request,
    //   or dyndolodPendingReenable carried over from an earlier /load), auto-reenable -- free/instant,
    //   we caused it, safe to undo automatically, no confirm needed. If it's CURRENTLY still off and
    //   we never touched it ourselves, offer a confirm instead of silently flipping user-set state we
    //   didn't touch (real, live-tested behavior: the user may have left it off for their own reasons
    //   unrelated to this run).
    // - The output mod: ALWAYS live-checked here, regardless of whether THIS session's own actions
    //   were what disabled it -- if it's disabled for ANY reason when the run ends, the "enable and
    //   deploy" reminder always applies, since the risk (new/existing output not actually live) is the
    //   same either way. Replaces the old outputModIdToReenable/markOutputModPendingIfNeeded session-
    //   history tracking, which missed the case where the mod was disabled before this tool ever
    //   touched it.
    // Used on every exit path where the SESSION is actually ending (both routes' cancel/failure/
    // exception, and /build's own success -- NOT /load's own success, which hands off to /build
    // without touching either yet, same as before). Returns { dyndolodOfferEnable,
    // dyndolodReenableFailed, outputModPendingReenable } for the caller's own terminal event payload.
    let dyndolodPendingReenable = false;
    let outputModPendingReenableModId = null;
    async function finalizeDyndolodAndOutputMod(cfg, settings, dyndolodDisabledThisRequest, emitIfCurrent) {
        let dyndolodReenableFailed = false;
        let dyndolodOfferEnable = false;
        if (dyndolodDisabledThisRequest || dyndolodPendingReenable) {
            if (await reenableDyndolod(cfg, true, emitIfCurrent)) dyndolodPendingReenable = false;
            else dyndolodReenableFailed = true;
        } else if (!isDynDoLODActive(cfg.source)) {
            dyndolodOfferEnable = true;
        }
        if (settings && settings.outputDir) {
            const resolved = await resolveOutputMod(settings.outputDir);
            if (resolved && !resolved.enabled) outputModPendingReenableModId = resolved.modId;
        }
        return { dyndolodOfferEnable, dyndolodReenableFailed, outputModPendingReenable: !!outputModPendingReenableModId };
    }

    // Step 1 -- read the data. Runs the real conflict-detection pass (no output ever written --
    // see PGLib's own dryRun flag, pgpatcher-fork). This genuinely takes a few minutes on a large
    // install (the director's own ~2000-mod install: 3m29s) -- there is no faster real path, the
    // conflict/shader data is a byproduct of the actual mesh-scanning pipeline, not a cheap lookup.
    //
    // POST-kicks-off-then-SSE-streams-progress, same shape as this project's own established
    // pattern (archive-finder-routes.js's /scan + /scan/events) -- not a one-shot GET, because a
    // multi-minute wait with genuinely no feedback beyond a static spinner was the actual bug this
    // was built to fix (director's own real complaint, 2026-08-19: no counter, no way to tell what
    // it's doing or whether it's frozen). loadSession/currentLoadChild/loadCancelled are module-
    // instance state (one load at a time, single local user -- same simplicity every sibling SSE
    // route in this project already assumes).
    const loadSession = createSseSession();
    let currentLoadChild = null;
    let loadCancelled = false;

    router.get('/load/events', (req, res) => {
        if (!loadSession.get()) return res.status(404).end();
        const afterSeq = Number(req.headers['last-event-id'] || 0);
        loadSession.subscribe(res, { afterSeq });
    });

    router.post('/load/cancel', (req, res) => {
        if (!loadSession.isActive() || !currentLoadChild) {
            return res.status(404).json({ error: 'No load is currently running.' });
        }
        loadCancelled = true;
        currentLoadChild.kill();
        res.json({ ok: true });
    });

    router.post('/load', async (req, res) => {
        if (!requirePgtoolsInstalled(res)) return;
        const cfg = requireConfigured(config, res);
        if (!cfg) return;
        // Fetched early now (was fetched further down) -- the new output-mod gate below needs
        // settings.outputDir to know which mod to resolve, and PGPatcher's own real GUI gates this
        // before any file reading at all, so this project's own gate check happens just as early.
        const settings = requirePgpatcherSettings(cfg, res);
        if (!settings) return;
        // Gate 1 -- before the DynDoLOD and output-mod gates below, both of which drive real Helper
        // writes and can say nothing useful without one. See requireHelperAvailable's own comment.
        if (!(await requireHelperAvailable(res))) return;

        // Real interactive disable -> re-enable flow (2026-08-21 v3 -- see this file's own "Real
        // DynDoLOD.esp disable" section header for the full rebuild writeup: targets the plugin
        // directly, no mod resolution, no deploy). EACH GATE NOW ACTS AS SOON AS IT'S OWN CONFIRM
        // LANDS, rather than checking every applicable gate up front and only doing any real work once
        // ALL of them clear -- director's own explicit fix, 2026-08-21: confirming the DynDoLOD prompt
        // used to silently do nothing at all if the output-mod gate was ALSO pending, since both
        // disables were bundled into the same later async step. DynDoLOD's own gate is fast enough (no
        // deploy) to disable synchronously right here, in this preflight block, the instant it's
        // confirmed -- not deferred alongside the output-mod gate, which genuinely does still need a
        // slow deploy and stays deferred to the async body below (with real SSE progress).
        let dyndolodDisabledThisRequest = false;
        if (isDynDoLODActive(cfg.source)) {
            if (!(req.body && req.body.confirmDisableDyndolod)) {
                return res.status(409).json({ error: 'dyndolod-active', message: DYNDOLOD_CONFIRM_MESSAGE, confirmDisableDyndolod: true });
            }
            const disabledOk = await helperClient.setPluginEnabled(DYNDOLOD_PLUGIN_NAME, false);
            const settled = disabledOk && await waitForDyndolodPluginsTxtState(cfg.source, false);
            if (!settled) {
                return res.status(400).json({ error: 'dyndolod-disable-failed', message: DYNDOLOD_AUTO_DISABLE_FAILED_MESSAGE });
            }
            dyndolodDisabledThisRequest = true;
        }

        // PGPatcher's own PRIOR OUTPUT gate (2026-08-21) -- see checkOutputModGate's own header
        // comment. Genuinely needs a real deploy, so this one STAYS deferred: 409 to confirm here,
        // then its own disable+deploy runs inside the async body below with real SSE progress, same as
        // before. (Re-checked fresh here, AFTER the DynDoLOD preflight above -- if DynDoLOD's own
        // disable just ran, that's already reflected in live state by the time this runs.)
        const outputModGate = await checkOutputModGate(cfg, settings);
        if (blockUntilOutputModConfirmed(outputModGate, req, res)) return;

        if (loadSession.isActive()) {
            // DynDoLOD may have already been disabled above (a real write) even though this request
            // is about to bail out -- re-enable it rather than leave it silently disabled over a
            // "session already busy" collision.
            if (dyndolodDisabledThisRequest) await reenableDyndolod(cfg, true, () => {});
            return res.status(409).json({ error: 'A load is already in progress.' });
        }
        if (settings.patchers.length === 0) {
            if (dyndolodDisabledThisRequest) await reenableDyndolod(cfg, true, () => {});
            return res.status(400).json({
                error: 'no-patchers-active',
                message: `No shader patchers are enabled in PGPatcher's own settings (${settings.settingsPath}) -- nothing to check conflicts for.`,
            });
        }

        loadCancelled = false;
        const mySession = loadSession.start({ id: `load-${Date.now()}` });
        res.status(202).json({});
        const emitIfCurrent = (event) => {
            if (loadSession.get() === mySession) loadSession.emit(event);
        };

        // Request-scoped, not module-global -- same reasoning as /build's own identical set.
        // dyndolodDisabledThisRequest itself is already set (or not) from the preflight above.
        let outputModIdToReenable = null;

        (async () => {
            // outputModGate is only reachable here with its own confirm flag already true -- runs
            // BEFORE the real conflict scan, same ordering /build uses. DynDoLOD's own disable already
            // happened in the preflight above (if it was needed) -- nothing left to do for it here.
            if (outputModGate) {
                const disabledOk = await disableOutputModForRequest(outputModGate.modId, emitIfCurrent);
                if (!disabledOk) {
                    // DynDoLOD's own preflight disable may have already succeeded -- finalize handles
                    // reenabling it (or offering to, per the 4-case spec) even though the output mod's
                    // OWN disable is what just failed here.
                    const result = await finalizeDyndolodAndOutputMod(cfg, settings, dyndolodDisabledThisRequest, emitIfCurrent);
                    const note = result.dyndolodReenableFailed ? DYNDOLOD_REENABLE_FAILED_NOTE : '';
                    emitIfCurrent({ type: 'error', message: `${OUTPUT_MOD_AUTO_DISABLE_FAILED_MESSAGE}${note}`, done: true, error: true, outputModPendingReenable: result.outputModPendingReenable, dyndolodOfferEnable: result.dyndolodOfferEnable });
                    return;
                }
                outputModIdToReenable = outputModGate.modId;
            }

            const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgpatcher-conflicts-'));
            const jsonOutput = path.join(workDir, 'conflicts.json');
            const outputDir = path.join(workDir, 'unused-output');

            runPgtools([
                'conflicts',
                settings.patchers.join(','),
                '--source', cfg.source,
                '--output', outputDir,
                '--cfg-dir', cfg.cfgDir,
                '--json-output', jsonOutput,
            ], {
                // Real bug found live (2026-08-21, director's own report): the frontend's own Cancel
                // button had no way to know cancel is only real once pgtools has actually spawned --
                // /load/cancel 404s ("No load is currently running") for the whole preflight output-mod
                // disable+deploy step above (currentLoadChild is still null then), but the button stayed
                // stuck showing "Cancelling…" (disabled) for the REST of the run regardless, since that
                // 404 silently no-ops client-side and nothing else ever resets it mid-stream. This event
                // is the one genuine signal for "cancel will actually do something now" -- emitted the
                // instant the real child process exists, matching this route's own currentLoadChild
                // assignment exactly.
                onSpawn: (c) => { currentLoadChild = c; emitIfCurrent({ type: 'cancellable' }); },
                onLine: (line) => {
                    const parsed = parsePgtoolsLine(line);
                    if (parsed) emitIfCurrent(parsed);
                },
            }).then(async ({ code, stderr }) => {
                currentLoadChild = null;
                // Real bug found live (2026-08-21, director's own report): this used to call
                // reenableAllIfNeeded() (both DynDoLOD AND the output mod) unconditionally right here,
                // BEFORE branching on cancelled/failed/succeeded -- so a genuinely successful load
                // immediately re-enabled AND redeployed the output mod the instant the scan finished,
                // long before the sort screen or /build ever ran, and a CANCELLED load did the exact
                // same thing silently -- a real, potentially multi-minute deploy the user never asked
                // for, triggered just by hitting Cancel. The session is genuinely ENDING on the
                // cancelled/failed branches below (no /build to hand off to), so those call the full
                // finalize step (director's own 4-case spec, 2026-08-21: auto-reenable DynDoLOD if this
                // session disabled it, else offer to enable it if it's still off; always live-check the
                // output mod). The SUCCESS branch is different -- it hands off to /build, so it only
                // records what THIS request itself disabled, same as before.
                if (loadCancelled) {
                    const result = await finalizeDyndolodAndOutputMod(cfg, settings, dyndolodDisabledThisRequest, emitIfCurrent);
                    const note = result.dyndolodReenableFailed ? DYNDOLOD_REENABLE_FAILED_NOTE : '';
                    emitIfCurrent({ type: 'error', message: `Cancelled.${note}`, done: true, error: true, cancelled: true, outputModPendingReenable: result.outputModPendingReenable, dyndolodOfferEnable: result.dyndolodOfferEnable });
                    return;
                }
                if (code !== 0) {
                    const result = await finalizeDyndolodAndOutputMod(cfg, settings, dyndolodDisabledThisRequest, emitIfCurrent);
                    const note = result.dyndolodReenableFailed ? DYNDOLOD_REENABLE_FAILED_NOTE : '';
                    emitIfCurrent({ type: 'error', message: `pgtools conflicts failed (exit ${code}): ${tail(stderr, 20)}${note}`, done: true, error: true, outputModPendingReenable: result.outputModPendingReenable, dyndolodOfferEnable: result.dyndolodOfferEnable });
                    return;
                }
                let mods;
                try {
                    mods = JSON.parse(fs.readFileSync(jsonOutput, 'utf8'));
                } catch (e) {
                    const result = await finalizeDyndolodAndOutputMod(cfg, settings, dyndolodDisabledThisRequest, emitIfCurrent);
                    const note = result.dyndolodReenableFailed ? DYNDOLOD_REENABLE_FAILED_NOTE : '';
                    emitIfCurrent({ type: 'error', message: `Couldn't read pgtools' own output: ${e.message}${note}`, done: true, error: true, outputModPendingReenable: result.outputModPendingReenable, dyndolodOfferEnable: result.dyndolodOfferEnable });
                    return;
                }
                // SUCCESS -- director's own explicit correction (2026-08-21): DynDoLOD.esp should NOT
                // reenable right here. Even though the flip itself is free (no deploy), reenabling it
                // immediately after /load meant it was active again by the time /build's own preflight
                // ran, which either re-gated it for no reason or (if that second reenable silently
                // failed) left it looking "stuck disabled" with no visibility into which of the two
                // reenable attempts actually broke. Now DynDoLOD follows the EXACT same contract as the
                // output mod: disable once here, stay disabled through the sort screen and the real
                // build, reenable only once Build itself actually completes -- finalize (and the offer-
                // to-enable decision) only ever runs at the true end of a session, not here.
                if (dyndolodDisabledThisRequest) dyndolodPendingReenable = true;
                if (outputModIdToReenable) outputModPendingReenableModId = outputModIdToReenable;
                emitIfCurrent({
                    type: 'done',
                    mods,
                    patchers: settings.patchers,
                    done: true,
                    reenableFailedMessage: null,
                    outputModPendingReenable: !!outputModPendingReenableModId,
                });
            }).catch(async (e) => {
                currentLoadChild = null;
                const result = await finalizeDyndolodAndOutputMod(cfg, settings, dyndolodDisabledThisRequest, emitIfCurrent);
                const note = result.dyndolodReenableFailed ? DYNDOLOD_REENABLE_FAILED_NOTE : '';
                emitIfCurrent({ type: 'error', message: `${e.message}${note}`, done: true, error: true, outputModPendingReenable: result.outputModPendingReenable, dyndolodOfferEnable: result.dyndolodOfferEnable });
            }).finally(() => {
                fs.rmSync(workDir, { recursive: true, force: true });
            });
        })();
    });

    // Step 3 -- create modrules.json. Backs up the existing file first (same timestamp convention
    // as every other destructive write in this project), then writes only what changed: `order` is
    // the FULL ranked list top-to-bottom (index 0 = highest priority) -- priority is computed the
    // exact same way PGPatcher's own ModSortDialog::updateMods does it (confirmed by reading
    // ModSortDialog.cpp directly, pgpatcher-fork): `priority = order.length - index`. `unranked` is
    // every mod the editor currently shows in the "New mods" panel -- if any of THOSE already had a
    // real modrules.json entry (e.g. it was ranked before and just got dragged back out), that entry
    // is removed, reverting it to genuinely unranked/new. Every mod name in neither list is left
    // completely untouched -- this never has to be the full authoritative list, only what the
    // session actually touched.
    router.post('/save', (req, res) => {
        const cfg = requireConfigured(config, res);
        if (!cfg) return;
        const { order, unranked, enabled } = req.body || {};
        if (!Array.isArray(order) || order.length === 0) {
            return res.status(400).json({ error: 'No ranked order was provided.' });
        }
        const enabledMap = enabled && typeof enabled === 'object' ? enabled : {};

        const modrulesPath = path.join(cfg.cfgDir, 'modrules.json');
        let modrules;
        try {
            modrules = JSON.parse(fs.readFileSync(modrulesPath, 'utf8'));
        } catch (e) {
            return res.status(500).json({ error: `Couldn't read the existing modrules.json: ${e.message}` });
        }

        const backupPath = `${modrulesPath}.backup-${backupStamp()}`;
        try {
            fs.copyFileSync(modrulesPath, backupPath);
        } catch (e) {
            return res.status(500).json({ error: `Couldn't back up modrules.json before saving: ${e.message}` });
        }

        // `enabled` -- the "will this mod actually be patched" toggle the editor now shows (director's
        // own real-PGPatcher-checkbox request) -- is the frontend's own live state, which already
        // starts from pgtools' own real `enabled` value and can be user-toggled since. Use the SENT
        // value for each ranked mod rather than reading it back off the existing on-disk entry -- the
        // whole point of this being a real, savable toggle. Falls back to the previous existing-file-
        // or-default-true behavior only if a name is somehow missing from the payload (defensive; the
        // frontend always sends one for every mod it knows about).
        const total = order.length;
        order.forEach((name, index) => {
            const existing = modrules[name] || {};
            const hasSentEnabled = Object.prototype.hasOwnProperty.call(enabledMap, name);
            modrules[name] = {
                priority: total - index,
                enabled: hasSentEnabled
                    ? !!enabledMap[name]
                    : (existing.enabled !== undefined ? existing.enabled : true),
                meshesignored: existing.meshesignored !== undefined ? existing.meshesignored : false,
            };
        });
        // Reset priority back to -1 for anything now unranked -- NEVER delete the entry outright.
        // Real modrules.json (confirmed live against the director's own ~1972-entry file) already
        // carries an explicit entry, often WITH priority: -1, for the large majority of known mods --
        // "unranked" does NOT mean "no entry exists" the way this route first assumed. An earlier
        // version of this code called `delete modrules[name]` for every unranked mod, which silently
        // destroyed ~1750 real entries (and whatever enabled/meshesignored state they carried) the
        // first time this was tested live against real data -- caught immediately because the
        // resulting file's own entry count dropped from 1972 to 223, restored from the same save's
        // own backup. Only touch an entry that already exists; a mod with no entry at all needs none.
        if (Array.isArray(unranked)) {
            for (const name of unranked) {
                if (modrules[name]) {
                    modrules[name] = { ...modrules[name], priority: -1 };
                }
            }
        }

        try {
            fs.writeFileSync(modrulesPath, JSON.stringify(modrules, null, 2));
        } catch (e) {
            return res.status(500).json({ error: `Couldn't write modrules.json: ${e.message}` });
        }

        res.json({ backupPath, modCount: total });
    });

    // ModruleSync import-back (design/mockup-pgpatcher-modrulesync-import.html, screen 2's "Import
    // merged file…" button) -- opens a native file picker for the merged modrules.json ModruleSync
    // produced, reads and validates it, and hands the parsed object straight back to the frontend.
    // Deliberately does NOT write anything -- this is a pure browse-then-read action, same shape as
    // rebuild-routes.js's own /import-offsite-archive (its own pickOpenFileAsync precedent). Per this
    // spec's own explicit rule, import never writes modrules.json itself: the frontend applies the
    // imported priorities to its own in-memory Ranked/New lists and marks the session dirty, same as
    // a manual drag-and-drop reorder -- the user still clicks Save (Apply) afterward to persist it.
    router.post('/import-modrules', async (req, res) => {
        let picked;
        try {
            picked = await pickOpenFileAsync({
                title: 'Select the merged modrules.json',
                filter: 'JSON files (*.json)|*.json|All files (*.*)|*.*',
            });
        } catch (e) {
            return res.status(500).json({ error: `File picker failed: ${e.message}` });
        }
        if (!picked) return res.json({ ok: false, cancelled: true });

        let parsed;
        try {
            parsed = JSON.parse(fs.readFileSync(picked, 'utf8'));
        } catch (e) {
            return res.status(400).json({ error: "That file couldn't be read as JSON -- make sure you selected the right file and give it another shot!" });
        }
        // Real modrules.json shape: a plain object keyed by mod name, each value itself a plain
        // object carrying at least a `priority` -- reject an array, a primitive, or an object whose
        // values aren't shaped like a real mod entry, rather than silently passing through something
        // that would just fail (or worse, silently do nothing) once the frontend tries to apply it.
        const looksValid = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            && Object.values(parsed).every((v) => v && typeof v === 'object' && !Array.isArray(v) && 'priority' in v);
        if (!looksValid) {
            return res.status(400).json({ error: "That file has valid JSON, but it doesn't match the format of a modrules.json file. Double-check your export and try again." });
        }
        res.json({ ok: true, path: picked, modrules: parsed });
    });

    // Step 4 -- build the output. Calls the REAL, unmodified `pgtools patch` -- the exact same
    // pipeline PGPatcher's own GUI runs (mesh AND texture patching), so this genuinely takes
    // significantly longer than /load's own dry run (which skips texture patching entirely).
    //
    // Same POST-kicks-off-then-SSE-streams-progress shape as /load above (buildSession/
    // currentBuildChild/buildCancelled mirror loadSession/currentLoadChild/loadCancelled exactly) --
    // the original one-shot version left the sort page showing nothing but a static "building…"
    // message for the whole run, which read as frozen in real live testing (director's own report,
    // 2026-08-20). Reuses parsePgtoolsLine()/PGTOOLS_TASK_LABELS/PGTOOLS_PHASE_LINES completely
    // unchanged -- the only two additions to those shared maps ("Texture Patcher", the finalize-step
    // lines) are real pgtools output /load's own dry run never reaches, so this doesn't change
    // /load's behavior at all, just adds cases /load never actually hits.
    const buildSession = createSseSession();
    let currentBuildChild = null;
    let buildCancelled = false;

    router.get('/build/events', (req, res) => {
        if (!buildSession.get()) return res.status(404).end();
        const afterSeq = Number(req.headers['last-event-id'] || 0);
        buildSession.subscribe(res, { afterSeq });
    });

    // Same real semantics as /load/cancel: requires a live currentBuildChild, which pgtools itself
    // only becomes once the backup step (below) has already finished -- so this can never kill a
    // build mid-backup-move, only mid-pgtools-run. Not a special case built for that -- it falls
    // straight out of mirroring /load/cancel's own existing check precisely.
    router.post('/build/cancel', (req, res) => {
        if (!buildSession.isActive() || !currentBuildChild) {
            return res.status(404).json({ error: 'No build is currently running.' });
        }
        buildCancelled = true;
        currentBuildChild.kill();
        res.json({ ok: true });
    });

    router.post('/build', async (req, res) => {
        if (!requirePgtoolsInstalled(res)) return;
        const cfg = requireConfigured(config, res);
        if (!cfg) return;
        // Fetched early now (was fetched further down) -- the output-mod gate below needs
        // settings.outputDir to know which mod to resolve, and PGPatcher's own real GUI gates this
        // before any file reading at all.
        const settings = requirePgpatcherSettings(cfg, res);
        if (!settings) return;
        if (!settings.outputDir) {
            return res.status(400).json({
                error: 'no-output-dir',
                message: `PGPatcher's own settings.json (${settings.settingsPath}) has no output.dir configured.`,
            });
        }

        // Gate 1, the twin of /load's own -- see requireHelperAvailable. Sits AFTER the no-output-dir
        // check just above deliberately: that one is a configuration problem this app can diagnose
        // and the user can fix with Vortex closed, so it stays the first thing reported, exactly as
        // it is today.
        if (!(await requireHelperAvailable(res))) return;

        // Real interactive disable -> build -> re-enable flow (2026-08-21 v3 -- see this file's own
        // "Real DynDoLOD.esp disable" section header for the full rebuild writeup). EACH GATE NOW ACTS
        // AS SOON AS ITS OWN CONFIRM LANDS (director's own explicit fix, 2026-08-21): DynDoLOD's own
        // gate is fast enough (no deploy) to disable synchronously right here, in this preflight,
        // rather than being bundled with the (much slower) output-mod gate below -- confirming
        // DynDoLOD used to silently do nothing if the output-mod gate was ALSO pending, since both
        // disables lived in the same later async step.
        let dyndolodDisabledThisRequest = false;
        if (isDynDoLODActive(cfg.source)) {
            if (!(req.body && req.body.confirmDisableDyndolod)) {
                return res.status(409).json({ error: 'dyndolod-active', message: DYNDOLOD_CONFIRM_MESSAGE, confirmDisableDyndolod: true });
            }
            const disabledOk = await helperClient.setPluginEnabled(DYNDOLOD_PLUGIN_NAME, false);
            const settled = disabledOk && await waitForDyndolodPluginsTxtState(cfg.source, false);
            if (!settled) {
                return res.status(400).json({ error: 'dyndolod-disable-failed', message: DYNDOLOD_AUTO_DISABLE_FAILED_MESSAGE });
            }
            dyndolodDisabledThisRequest = true;
        }

        // PGPatcher's own PRIOR OUTPUT gate (2026-08-21) -- see checkOutputModGate's own header
        // comment. Genuinely needs a real deploy, so this one STAYS deferred: 409 to confirm here,
        // then its own disable+deploy runs inside the async build body below with real SSE progress.
        const outputModGate = await checkOutputModGate(cfg, settings);
        if (blockUntilOutputModConfirmed(outputModGate, req, res)) return;

        if (buildSession.isActive()) {
            // DynDoLOD may have already been disabled above (a real write) even though this request
            // is about to bail out -- re-enable it rather than leave it silently disabled over a
            // "session already busy" collision.
            if (dyndolodDisabledThisRequest) await reenableDyndolod(cfg, true, () => {});
            return res.status(409).json({ error: 'A build is already in progress.' });
        }
        if (settings.patchers.length === 0) {
            if (dyndolodDisabledThisRequest) await reenableDyndolod(cfg, true, () => {});
            return res.status(400).json({
                error: 'no-patchers-active',
                message: `No shader patchers are enabled in PGPatcher's own settings (${settings.settingsPath}).`,
            });
        }

        // --cfg-dir was missing here entirely until now -- /load (the dry-run scan) always passed it,
        // but this route, the one that writes REAL output, never did. That meant every real build
        // silently ran with an empty mesh blocklist/allowlist/vanillaBSAList/allowedModelRecordTypes,
        // regardless of what the user's own settings.json actually specified -- confirmed live
        // (2026-08-20) this was still true even after pgtools itself gained the ability to read these
        // via --cfg-dir. Passing it here is what actually makes a real build reflect the user's own
        // PGPatcher config, not just the dry-run preview.
        //
        // --consider-allmeshes is opt-in (checkbox default off, matching the real GUI's own default)
        // -- see PGTools/src/main.cpp's own comment on why this defaults off (a real ~10,500-file
        // overshoot / genuine CTD-risk concern, not just a count mismatch).
        //
        // --relax-weight-validation is a TOP-LEVEL pgtools flag (registered on the app itself, not
        // the `patch` subcommand -- same as --no-multithreading/--shortcut), so it must come BEFORE
        // the subcommand name, not after -- confirmed live (2026-08-20) that pgtools' CLI11 parsing
        // only recognizes top-level flags in that position.
        const pgtoolsArgs = [];
        if (req.body && req.body.relaxWeightValidation) {
            pgtoolsArgs.push('--relax-weight-validation');
        }
        pgtoolsArgs.push(
            'patch',
            settings.patchers.join(','),
            '--source', cfg.source,
            '--output', settings.outputDir,
            '--cfg-dir', cfg.cfgDir,
        );
        if (req.body && req.body.considerAllMeshes) {
            pgtoolsArgs.push('--consider-allmeshes');
        }

        buildCancelled = false;
        const mySession = buildSession.start({ id: `build-${Date.now()}` });
        res.status(202).json({});
        const emitIfCurrent = (event) => {
            if (buildSession.get() === mySession) buildSession.emit(event);
        };

        // Request-scoped, not module-global (a second, later build in the same server process must
        // never re-enable DynDoLOD.esp / PGPatcher's own output mod if THIS run never disabled them).
        // dyndolodDisabledThisRequest itself is already set (or not) from the preflight above.
        let outputModIdToReenable = null;

        // Back up the existing output BEFORE pgtools ever touches it -- pgtools itself deletes
        // settings.outputDir's existing contents before doing any real build work (same as the real
        // GUI), so if the pgtools process then crashes, hangs, or gets killed partway through, the
        // user's prior output is otherwise just gone with no way back. Opt-in (config.
        // pgpatcherOutputBackupDir, see that setting's own comment in lib/app-config.js) -- blank
        // skips this entirely, today's exact behavior, no regression for anyone who hasn't set it.
        // A real move (fs.renameSync) when possible, not a copy -- this project's own established
        // pattern for exactly this (lib/rebuild-mod.js's own same-drive swap logic) -- so this stays
        // fast even for a large real output folder when source and backup dir share a drive; that
        // path stays synchronous, it's a metadata-only rename, not a real bottleneck. The whole
        // route body below is wrapped in an async IIFE now because the CROSS-drive fallback isn't --
        // see copyDirWithProgress above.
        (async () => {
            // outputModGate is only reachable here with its own confirm flag already true -- the user
            // has genuinely said yes. Runs BEFORE the backup-move step and pgtools itself -- MUST run
            // before the backup-move below: that step physically moves settings.outputDir elsewhere,
            // which would desync Vortex's own live mod entry (still pointing at the old path) if the
            // mod were still deployed/linked at that moment. Disabling first cleanly un-links it.
            // DynDoLOD's own disable already happened in the preflight above (if it was needed) --
            // nothing left to do for it here.
            if (outputModGate) {
                const disabledOk = await disableOutputModForRequest(outputModGate.modId, emitIfCurrent);
                if (!disabledOk) {
                    // dyndolod's own disable above may have already succeeded
                    const result = await finalizeDyndolodAndOutputMod(cfg, settings, dyndolodDisabledThisRequest, emitIfCurrent);
                    const note = result.dyndolodReenableFailed ? DYNDOLOD_REENABLE_FAILED_NOTE : '';
                    emitIfCurrent({ type: 'error', message: `${OUTPUT_MOD_AUTO_DISABLE_FAILED_MESSAGE}${note}`, done: true, error: true, outputModPendingReenable: result.outputModPendingReenable, dyndolodOfferEnable: result.dyndolodOfferEnable });
                    return;
                }
                outputModIdToReenable = outputModGate.modId;
            }

            let backupPath = null;
            if (config.pgpatcherOutputBackupDir) {
                let hasExistingOutput = false;
                try {
                    hasExistingOutput = fs.existsSync(settings.outputDir) && fs.readdirSync(settings.outputDir).length > 0;
                } catch (e) {
                    // Can't even list the existing output folder -- treat as "nothing to back up" rather
                    // than blocking the build over a folder that may not really be there.
                    hasExistingOutput = false;
                }
                if (hasExistingOutput) {
                    emitIfCurrent({ type: 'phase', message: 'Backing up existing output…' });
                    const destination = path.join(config.pgpatcherOutputBackupDir, backupStamp());
                    try {
                        fs.mkdirSync(config.pgpatcherOutputBackupDir, { recursive: true });
                        fs.renameSync(settings.outputDir, destination);
                        backupPath = destination;
                    } catch (renameErr) {
                        if (renameErr.code === 'EXDEV') {
                            // Backup dir is on a DIFFERENT physical drive than the real output -- a real,
                            // common setup (backing up to a separate drive is genuinely safer, not an
                            // edge case) that a plain OS-level rename can never do, confirmed live
                            // (2026-08-20). Fall back to copy-then-remove-original: copy FIRST and only
                            // remove the source afterward, so a failure at either step can never lose
                            // data -- if the copy itself fails, the original was never touched; if only
                            // the cleanup-after-copy step fails, the original is still safely sitting
                            // right where it was, just alongside a redundant already-made backup. Async
                            // and progress-reporting now (was fs.cpSync/fs.rmSync) -- see
                            // copyDirWithProgress's own comment for why.
                            try {
                                const total = await countFiles(settings.outputDir);
                                await copyDirWithProgress(settings.outputDir, destination, total, (current, totalCount) => {
                                    emitIfCurrent({ type: 'progress', message: 'Backing up existing output…', current, total: totalCount });
                                });
                                backupPath = destination;
                                try {
                                    await fs.promises.rm(settings.outputDir, { recursive: true, force: true });
                                } catch (cleanupErr) {
                                    console.error(`Backed up PGPatcher output to ${destination} but couldn't remove the original at ${settings.outputDir} afterward: ${cleanupErr.message}`);
                                }
                            } catch (copyErr) {
                                // The response already returned 202 above, so this is a terminal SSE
                                // event, not a synchronous 4xx/5xx -- same "serious register, hard
                                // blocker" reasoning as before, just delivered over the stream now.
                                // Re-enable anything this run's own disable steps already succeeded on
                                // -- a backup failure here must not leave either silently disabled.
                                const result = await finalizeDyndolodAndOutputMod(cfg, settings, dyndolodDisabledThisRequest, emitIfCurrent);
                                const note = result.dyndolodReenableFailed ? DYNDOLOD_REENABLE_FAILED_NOTE : '';
                                emitIfCurrent({
                                    type: 'error',
                                    message: `🛑 Couldn't back up your existing PGPatcher output before building (tried moving it, then copying it across drives — both failed). Nothing was deleted or changed — your current output at ${settings.outputDir} is untouched. Build stopped instead of continuing without a backup.${note} (${copyErr.message})`,
                                    done: true,
                                    error: true,
                                    outputModPendingReenable: result.outputModPendingReenable,
                                    dyndolodOfferEnable: result.dyndolodOfferEnable,
                                });
                                return;
                            }
                        } else {
                            // The move itself failed for some other reason -- your existing output is
                            // genuinely a destructive-adjacent thing to touch here, so this is
                            // deliberately NOT a casual message (plain-language-writer skill's serious
                            // register: a hard blocker on a real filesystem write). Do NOT proceed to
                            // build -- with no confirmed backup, letting pgtools delete the existing
                            // output next would be exactly the data loss this step exists to prevent.
                            const result = await finalizeDyndolodAndOutputMod(cfg, settings, dyndolodDisabledThisRequest, emitIfCurrent);
                            const note = result.dyndolodReenableFailed ? DYNDOLOD_REENABLE_FAILED_NOTE : '';
                            emitIfCurrent({
                                type: 'error',
                                message: `🛑 Couldn't back up your existing PGPatcher output before building. Nothing was deleted or changed — your current output at ${settings.outputDir} is untouched. Build stopped instead of continuing without a backup.${note} (${renameErr.message})`,
                                done: true,
                                error: true,
                                outputModPendingReenable: result.outputModPendingReenable,
                                dyndolodOfferEnable: result.dyndolodOfferEnable,
                            });
                            return;
                        }
                    }
                }
            }

            runPgtools(pgtoolsArgs, {
                // Same fix as /load's own onSpawn -- see that route's own comment for the full bug
                // writeup. currentBuildChild only exists from here on, so this is the real moment
                // /build/cancel stops 404ing.
                onSpawn: (c) => { currentBuildChild = c; emitIfCurrent({ type: 'cancellable' }); },
                onLine: (line) => {
                    const parsed = parsePgtoolsLine(line);
                    if (parsed) emitIfCurrent(parsed);
                },
            }).then(async ({ code, stdout, stderr }) => {
                currentBuildChild = null;
                if (buildCancelled) {
                    const result = await finalizeDyndolodAndOutputMod(cfg, settings, dyndolodDisabledThisRequest, emitIfCurrent);
                    const note = result.dyndolodReenableFailed ? DYNDOLOD_REENABLE_FAILED_NOTE : '';
                    emitIfCurrent({ type: 'error', message: `Cancelled.${note}`, done: true, error: true, cancelled: true, outputModPendingReenable: result.outputModPendingReenable, dyndolodOfferEnable: result.dyndolodOfferEnable });
                    return;
                }
                if (code !== 0) {
                    const result = await finalizeDyndolodAndOutputMod(cfg, settings, dyndolodDisabledThisRequest, emitIfCurrent);
                    const note = result.dyndolodReenableFailed ? DYNDOLOD_REENABLE_FAILED_NOTE : '';
                    const backupNote = backupPath
                        ? ` Your previous output was backed up before this build started and is safe at ${backupPath}.`
                        : '';
                    emitIfCurrent({
                        type: 'error',
                        message: `⚠️ The build failed (exit ${code}).${backupNote}${note} Real error: ${tail(stderr, 20)}`,
                        done: true,
                        error: true,
                        outputModPendingReenable: result.outputModPendingReenable,
                        dyndolodOfferEnable: result.dyndolodOfferEnable,
                    });
                    return;
                }
                // SUCCESS -- THIS is where DynDoLOD.esp's own fate actually gets decided now (director's
                // own 4-case spec, 2026-08-21): auto-reenabled if THIS session's own action disabled it
                // (free, no deploy, no confirm needed -- we caused it); offered as a confirm instead if
                // it's still off and this session never touched it (don't silently flip user-set state
                // we didn't touch). The output mod is ALWAYS live-checked here too, regardless of who
                // disabled it or when -- if it's disabled for any reason, the "enable and deploy"
                // reminder applies, since the risk (new output not actually live) is identical either
                // way. See finalizeDyndolodAndOutputMod's own header comment for the full writeup.
                const result = await finalizeDyndolodAndOutputMod(cfg, settings, dyndolodDisabledThisRequest, emitIfCurrent);
                emitIfCurrent({
                    type: 'done',
                    outputDir: settings.outputDir,
                    backupPath,
                    log: tail(stdout, 10),
                    done: true,
                    reenableFailedMessage: result.dyndolodReenableFailed ? DYNDOLOD_REENABLE_FAILED_NOTE.trim() : null,
                    outputModPendingReenable: result.outputModPendingReenable,
                    dyndolodOfferEnable: result.dyndolodOfferEnable,
                });
            }).catch(async (e) => {
                currentBuildChild = null;
                const result = await finalizeDyndolodAndOutputMod(cfg, settings, dyndolodDisabledThisRequest, emitIfCurrent);
                const note = result.dyndolodReenableFailed ? DYNDOLOD_REENABLE_FAILED_NOTE : '';
                const backupNote = backupPath
                    ? ` Your previous output was backed up before this build started and is safe at ${backupPath}.`
                    : '';
                emitIfCurrent({ type: 'error', message: `⚠️ The build failed.${backupNote}${note} Real error: ${e.message}`, done: true, error: true, outputModPendingReenable: result.outputModPendingReenable, dyndolodOfferEnable: result.dyndolodOfferEnable });
            });
        })();
    });

    // Separate, standalone "deploy everything" flow -- offered on the build success screen only when
    // this SAME build's own output-mod disable happened (see /build's own `outputModPendingReenable`
    // flag). DynDoLOD.esp itself is no longer part of this at all (2026-08-21 correction: its own
    // re-enable is now immediate, right in /build's success handler -- it never needed a deploy, see
    // this file's own "Real DynDoLOD.esp disable" header comment). This is deliberately the REAL, full
    // Vortex deploy pipeline (deployAllMods -- the same event the native "Deploy Mods" button
    // dispatches). Fire-and-poll, same POST-kicks-off-then-separately-checked shape as /load and
    // /build, but a plain poll rather than an SSE stream -- deployAllMods()/getDeployAllProgress() are
    // themselves a poll-shaped pair, not a push-based one. One at a time, module-scoped (not
    // per-session like buildSession) -- a real, out-of-band, whole-install Vortex operation, not
    // something scoped to a single PGPatcher build.
    //
    // A build's own output-mod disable is NOT auto-reenabled the instant the build finishes -- it
    // stays off, tracked here as "pending," until the user's own explicit "enable and deploy the
    // changes" confirm accepts it. This endpoint is where that acceptance actually lands: re-enable the
    // pending mod FIRST, then run the one real full deploy that both re-enabling (to relink its
    // deployed files) and "deploy everything" genuinely need anyway -- one deploy covers both, not two.
    // A no-op if nothing's pending. KNOWN GAP, not yet handled: if the user declines this prompt (or
    // navigates away without ever triggering a deploy), the output mod stays disabled indefinitely
    // with no automatic recovery.
    let deployAllInProgress = false;
    router.post('/deploy-all', async (req, res) => {
        if (deployAllInProgress) {
            return res.status(409).json({ error: 'A deploy is already in progress.' });
        }
        // Was an inline copy of exactly this check; folded into the shared requireHelperAvailable
        // once /load and /build needed the same gate, so the three cannot drift into three slightly
        // different 409s. Behaviour is unchanged -- same status, same body.
        if (!(await requireHelperAvailable(res))) return;
        deployAllInProgress = true;
        res.status(202).json({});
        (async () => {
            if (outputModPendingReenableModId) {
                await helperClient.setModEnabled(outputModPendingReenableModId, true);
                outputModPendingReenableModId = null;
            }
            await helperClient.deployAllMods();
        })().finally(() => { deployAllInProgress = false; });
    });

    router.get('/deploy-all/progress', async (req, res) => {
        const progress = await helperClient.getDeployAllProgress();
        // getDeployAllProgress() can legitimately return null mid-deploy (a transient poll failure,
        // not evidence the deploy itself failed) -- fall back to this route's own `deployAllInProgress`
        // flag rather than reporting a false "not active".
        res.json(progress || { active: deployAllInProgress, done: !deployAllInProgress });
    });

    // Accepts the "would you like to enable DynDoLOD.esp?" confirm surfaced when finalizeDyndolod
    // AndOutputMod finds it still off and untouched by this session (director's own 4-case spec,
    // 2026-08-21). Unlike the output mod's own /deploy-all, this needs no deploy at all -- the same
    // free/instant flip reenableDyndolod already uses everywhere else. Fire-and-forget shape (no SSE
    // session, no polling) since it settles in well under a second in the normal case.
    router.post('/enable-dyndolod', async (req, res) => {
        const cfg = requireConfigured(config, res);
        if (!cfg) return;
        const enabledOk = await helperClient.setPluginEnabled(DYNDOLOD_PLUGIN_NAME, true);
        const settled = enabledOk && await waitForDyndolodPluginsTxtState(cfg.source, true);
        if (!settled) {
            return res.status(400).json({ error: 'dyndolod-enable-failed', message: DYNDOLOD_REENABLE_FAILED_NOTE.trim() });
        }
        res.json({ ok: true });
    });

    return router;
}

module.exports = { createPgpatcherRouter };
