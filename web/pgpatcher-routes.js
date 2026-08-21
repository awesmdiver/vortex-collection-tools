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
        throw new Error(`Couldn't read PGPatcher's own settings.json at ${settingsPath}: ${e.message}`);
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

function blockIfDynDoLODActive(cfg, res) {
    if (!isDynDoLODActive(cfg.source)) return false;
    res.status(400).json({
        error: 'dyndolod-active',
        message: "🛑 DynDOLOD is active in your load order. Disable it (and redeploy) before running PGPatcher, then re-enable it afterward to generate LODs against PGPatcher's own output.",
    });
    return true;
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

    router.post('/load', (req, res) => {
        if (!requirePgtoolsInstalled(res)) return;
        const cfg = requireConfigured(config, res);
        if (!cfg) return;
        if (blockIfDynDoLODActive(cfg, res)) return;
        if (loadSession.isActive()) {
            return res.status(409).json({ error: 'A load is already in progress.' });
        }
        let settings;
        try {
            settings = readPgpatcherSettings(cfg.cfgDir);
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
        if (settings.patchers.length === 0) {
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
            onSpawn: (c) => { currentLoadChild = c; },
            onLine: (line) => {
                const parsed = parsePgtoolsLine(line);
                if (parsed) emitIfCurrent(parsed);
            },
        }).then(({ code, stderr }) => {
            currentLoadChild = null;
            if (loadCancelled) {
                emitIfCurrent({ type: 'error', message: 'Cancelled.', done: true, error: true, cancelled: true });
                return;
            }
            if (code !== 0) {
                emitIfCurrent({ type: 'error', message: `pgtools conflicts failed (exit ${code}): ${tail(stderr, 20)}`, done: true, error: true });
                return;
            }
            try {
                const mods = JSON.parse(fs.readFileSync(jsonOutput, 'utf8'));
                emitIfCurrent({ type: 'done', mods, patchers: settings.patchers, done: true });
            } catch (e) {
                emitIfCurrent({ type: 'error', message: `Couldn't read pgtools' own output: ${e.message}`, done: true, error: true });
            }
        }).catch((e) => {
            currentLoadChild = null;
            emitIfCurrent({ type: 'error', message: e.message, done: true, error: true });
        }).finally(() => {
            fs.rmSync(workDir, { recursive: true, force: true });
        });
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

    router.post('/build', (req, res) => {
        if (!requirePgtoolsInstalled(res)) return;
        const cfg = requireConfigured(config, res);
        if (!cfg) return;
        if (blockIfDynDoLODActive(cfg, res)) return;
        if (buildSession.isActive()) {
            return res.status(409).json({ error: 'A build is already in progress.' });
        }
        let settings;
        try {
            settings = readPgpatcherSettings(cfg.cfgDir);
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
        if (settings.patchers.length === 0) {
            return res.status(400).json({
                error: 'no-patchers-active',
                message: `No shader patchers are enabled in PGPatcher's own settings (${settings.settingsPath}).`,
            });
        }
        if (!settings.outputDir) {
            return res.status(400).json({
                error: 'no-output-dir',
                message: `PGPatcher's own settings.json (${settings.settingsPath}) has no output.dir configured.`,
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
                                emitIfCurrent({
                                    type: 'error',
                                    message: `🛑 Couldn't back up your existing PGPatcher output before building (tried moving it, then copying it across drives — both failed). Nothing was deleted or changed — your current output at ${settings.outputDir} is untouched. Build stopped instead of continuing without a backup. (${copyErr.message})`,
                                    done: true,
                                    error: true,
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
                            emitIfCurrent({
                                type: 'error',
                                message: `🛑 Couldn't back up your existing PGPatcher output before building. Nothing was deleted or changed — your current output at ${settings.outputDir} is untouched. Build stopped instead of continuing without a backup. (${renameErr.message})`,
                                done: true,
                                error: true,
                            });
                            return;
                        }
                    }
                }
            }

            runPgtools(pgtoolsArgs, {
                onSpawn: (c) => { currentBuildChild = c; },
                onLine: (line) => {
                    const parsed = parsePgtoolsLine(line);
                    if (parsed) emitIfCurrent(parsed);
                },
            }).then(({ code, stdout, stderr }) => {
                currentBuildChild = null;
                if (buildCancelled) {
                    emitIfCurrent({ type: 'error', message: 'Cancelled.', done: true, error: true, cancelled: true });
                    return;
                }
                if (code !== 0) {
                    const backupNote = backupPath
                        ? ` Your previous output was backed up before this build started and is safe at ${backupPath}.`
                        : '';
                    emitIfCurrent({
                        type: 'error',
                        message: `⚠️ The build failed (exit ${code}).${backupNote} Real error: ${tail(stderr, 20)}`,
                        done: true,
                        error: true,
                    });
                    return;
                }
                emitIfCurrent({ type: 'done', outputDir: settings.outputDir, backupPath, log: tail(stdout, 10), done: true });
            }).catch((e) => {
                currentBuildChild = null;
                const backupNote = backupPath
                    ? ` Your previous output was backed up before this build started and is safe at ${backupPath}.`
                    : '';
                emitIfCurrent({ type: 'error', message: `⚠️ The build failed.${backupNote} Real error: ${e.message}`, done: true, error: true });
            });
        })();
    });

    return router;
}

module.exports = { createPgpatcherRouter };
