'use strict';
// Framework-agnostic core orchestration for rebuilding a Vortex collection's staging folder.
// Extracted from rebuild-collection.js so the terminal CLI and the web UI (web/server.js) run the
// exact same tested engine -- neither reimplements this logic. Nothing here touches
// console/readline/process.exit; callers (the CLI or the web routes) own all presentation.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { loadCollection } = require('./collection-parser');
const { classifyMod, rebuildMod } = require('./rebuild-mod');
const { locateArchive } = require('./archive-locator');
const nexusModDownload = require('./nexus-mod-download');
const { getImportedFilename, setImportedFilename } = require('./offsite-import-map');

const SYNC_LIB_PATH = path.join(__dirname, 'vortex-sync', 'lib.js');
const STATE_QUERY_WORKER_PATH = path.join(__dirname, 'state-query-worker.js');

// Statuses that represent a fully-resolved outcome from a prior run -- safe to skip entirely on
// resume. CRITICAL_MANUAL_RESTORE_NEEDED is deliberately excluded: that mod's underlying issue
// needs a human look, so it gets re-classified (and, if the user has fixed things, re-attempted)
// on resume rather than silently skipped forever.
const RESUMABLE_STATUSES = new Set([
    'REBUILT', 'SKIP_NO_ARCHIVE', 'SKIP_OPTIONAL_NOT_INSTALLED', 'SKIP_OPEN_FOMOD',
    'FAILED_MISMATCH_NOT_TOUCHED', 'FAILED_EXTRACTION_NOT_TOUCHED', 'FAILED_EXTRACTION_NO_PRIOR_DATA',
]);

function modKey(source) {
    return `${source.modId}:${source.fileId}`;
}

// lib/vortex-sync is this project's own in-tree module (formerly the separate sibling project
// vortex-collection-sync, merged in), reused for everything Vortex-live-state-related. Shared here
// so both rebuild-collection.js and web/server.js get the same friendly error instead of a raw
// MODULE_NOT_FOUND stack trace.
function loadSyncLib() {
    try {
        return require(SYNC_LIB_PATH);
    } catch (e) {
        if (e.code === 'MODULE_NOT_FOUND') {
            const err = new Error(
                `Could not find the in-tree vortex-sync module at "${SYNC_LIB_PATH}" -- this ` +
                `indicates a broken installation, not a missing sibling project.`
            );
            err.code = 'SYNC_LIB_NOT_FOUND';
            throw err;
        }
        throw e;
    }
}

// How long a normal (non-crashed) state query should ever reasonably take, even for a large
// Vortex install -- past this, the worker is presumed stuck, not just slow. Confirmed this
// session: when the native assertion crash happens, the OS's assertion dialog can spawn BEHIND
// other windows, showing nothing on top and nothing in a taskbar glance -- from the user's side
// it looks identical to a silent hang, not an obvious crash, with no clue to go check for it.
const STATE_QUERY_TIMEOUT_MS = 30_000;

// Rendered via #errorModalText, which already has white-space: pre-line in styles.css -- these
// \n-separated numbered lines render as a real list with no JS/rendering changes needed.
const CRASH_HELP_TEXT =
    'Could not load the collection. Reading Vortex\'s database failed, possibly due to a crash from ' +
    'files still being written by a recent Vortex session.\n\n' +
    '1. If a Windows error dialog appeared, check your taskbar (it can open behind other windows) and click Abort.\n' +
    '2. Try again.\n' +
    '3. If it keeps happening, close this application, open Vortex, wait a moment, then close Vortex normally, and restart this application.';

const TIMEOUT_HELP_TEXT =
    'Could not load the collection. Reading Vortex\'s database is taking too long -- this usually ' +
    'means a Windows error dialog is open and hidden behind other windows.\n\n' +
    '1. Check your taskbar and click Abort on it, then try again.\n' +
    '2. If it keeps happening, close this application, open Vortex, wait a moment, then close Vortex normally, and restart this application.';

// Runs lib/state-query-worker.js in an ISOLATED child process, for one or more collections in a
// SINGLE shared DB open (see loadSyncState/loadSyncStateBatch below -- batching directly reduces
// how many times this risky operation runs when working through several collections in one
// sitting). Confirmed this session, reproducibly, across multiple different collections -- this
// is a property of Vortex's overall state database, not any one collection's data:
// vortex-collection-sync's withStateDb (via classic-level/LevelDB) can hit a native assertion
// crash reading certain real-world write-ahead-log shapes, even with Vortex fully closed. A
// native crash is unrecoverable in-process, so this MUST run outside whatever process called it
// (critical for web/server.js, which must survive a bad read and keep serving other requests, not
// just for a one-shot CLI invocation). The crash blocks on a native OS dialog requiring manual
// dismissal (click Abort, never Retry/Ignore -- continuing past a violated invariant risks
// silently wrong data) -- confirmed this can spawn BEHIND other windows with zero on-screen
// indication, so a timeout here proactively kills the worker and tells the caller explicitly what
// to go check for, rather than leaving them staring at an unexplained stall.
// Progress-marker line prefix state-query-worker.js writes to stderr -- see its own header comment
// for why this rides stderr rather than stdout (stdout is reserved for the single final JSON
// result line) and why it's step-based (1/2/3) rather than a real byte/percent estimate.
const PROGRESS_PREFIX = '##PROGRESS## ';

// onProgress (optional, in `input`): ({step, total, label}) => void, called as each of the
// worker's 3 full-scan passes BEGINS. Stripped out of `input` before it's sent to the child (it's
// a local callback, not something the child process needs or could even receive over JSON).
function runIsolatedStateQuery(input) {
    const { onProgress, ...payload } = input;
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [STATE_QUERY_WORKER_PATH], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        let stdout = '';
        let stderr = ''; // real (non-progress-marker) stderr only -- what a crash message actually shows
        let stderrLineBuf = '';
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill();
        }, STATE_QUERY_TIMEOUT_MS);

        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => {
            stderrLineBuf += d;
            let idx;
            while ((idx = stderrLineBuf.indexOf('\n')) !== -1) {
                const line = stderrLineBuf.slice(0, idx);
                stderrLineBuf = stderrLineBuf.slice(idx + 1);
                if (line.startsWith(PROGRESS_PREFIX)) {
                    if (onProgress) {
                        try { onProgress(JSON.parse(line.slice(PROGRESS_PREFIX.length))); } catch { /* malformed progress line -- ignore */ }
                    }
                } else {
                    stderr += `${line}\n`;
                }
            }
        });
        child.on('error', (e) => { clearTimeout(timer); reject(e); });
        child.on('close', (code, signal) => {
            clearTimeout(timer);
            stderr += stderrLineBuf; // flush any trailing partial (no-newline) line
            if (timedOut) {
                reject(new Error(TIMEOUT_HELP_TEXT));
                return;
            }
            if (code === 0) {
                try {
                    resolve(JSON.parse(stdout));
                } catch (e) {
                    reject(new Error(`Vortex state worker produced invalid output: ${e.message}`));
                }
                return;
            }
            reject(new Error(CRASH_HELP_TEXT + (stderr.trim() ? ` (details: ${stderr.trim()})` : '') + ` [exit ${code}${signal ? `, signal ${signal}` : ''}]`));
        });
        child.stdin.write(JSON.stringify(payload));
        child.stdin.end();
    });
}

// Resolves a chosen collection's modId (== its staging folder name) into the standard
// collectionInfo shape, loading collection.json too. Throws a plain Error on failure --
// callers decide how to present that (CLI: console.error+exit; web: JSON error response).
function resolveCollectionInfo(stagingDir, collectionModId) {
    const collectionJsonPath = path.join(stagingDir, collectionModId, 'collection.json');
    if (!fs.existsSync(collectionJsonPath)) {
        throw new Error(`No collection.json found at "${collectionJsonPath}".`);
    }
    const collection = loadCollection(collectionJsonPath);
    // Matches scanStagingCollections' own convention (vortex-collection-sync/lib.js) so a
    // collection looks the same whether it was reached via the picker or via a direct modId.
    const name = collection.info?.name || collectionModId;
    return { modId: collectionModId, collectionJsonPath, name, collection };
}

function toSyncStateResult(raw) {
    if (raw.error) {
        const err = new Error(raw.error);
        err.code = 'SYNC_STATE_ERROR';
        throw err;
    }
    return {
        ignored: raw.ignored, removedMods: raw.removedMods, keptMods: raw.keptMods,
        knownVortexModIds: new Map(raw.knownVortexModIdEntries),
        otherVersionsByModId: raw.otherVersionsByModId || {},
        sharedWithCollectionsByKey: raw.sharedWithCollectionsByKey || {},
        liveName: raw.liveName,
        collectionSlug: raw.collectionSlug,
    };
}

// The one syncLib.withStateDb call this whole tool needs: ignored mods, kept/removed, and each
// kept mod's REAL Vortex-tracked staging folder name (see lib/rebuild-mod.js's classifyMod header
// for why this matters -- Vortex never renames a mod's folder on update, only refreshes its
// contents in place, so trusting the archive's own filename can miss the real, already-installed
// location entirely). Runs in an isolated child process (see runIsolatedStateQuery above) --
// this is the one operation in the whole tool confirmed able to hard-crash its caller. Single-
// collection convenience wrapper around loadSyncStateBatch -- used by the CLI, which only ever
// handles one collection per invocation. stagingDir is needed here too (not just in the batch
// version) so the CLI path also gets cross-collection membership info (scanAllCollections) --
// without it, only the web UI's batch refresh would ever compute "shared with other collections".
async function loadSyncState({ state, collectionModId, collection, stagingDir, onProgress }) {
    const results = await runIsolatedStateQuery({
        syncLibPath: SYNC_LIB_PATH, state, collections: [{ modId: collectionModId, collection }], stagingDir, onProgress,
    });
    return toSyncStateResult(results[collectionModId]);
}

// Same as loadSyncState, but for MULTIPLE collections in one shared DB open -- the web UI's
// "load Vortex data once" optimization (see web/routes.js's /api/vortex-data/refresh). `entries`
// is [{modId, collection}, ...]. Returns { results: Map<modId, syncStateResult | {error}>,
// workshopOnlyCollections } -- a single bad collection (e.g. one Vortex hasn't written to its
// state yet) doesn't lose the others' results. workshopOnlyCollections lists every Vortex-tracked
// collection with NO collection.json at all (never published, or published but only the Workshop
// copy is kept locally) -- these were never in `entries` to begin with (scanStagingCollections
// can't find them), so this is the only place that surfaces them; stagingDir is required to
// compute it, optional to keep this function usable without it if a caller doesn't care.
async function loadSyncStateBatch({ state, entries, stagingDir, onProgress }) {
    const raw = await runIsolatedStateQuery({
        syncLibPath: SYNC_LIB_PATH, state, collections: entries, stagingDir, onProgress,
    });
    const results = new Map();
    for (const { modId } of entries) {
        try {
            results.set(modId, { ok: true, data: toSyncStateResult(raw[modId]) });
        } catch (e) {
            results.set(modId, { ok: false, error: e.message });
        }
    }
    return { results, workshopOnlyCollections: raw.__workshopOnly || [] };
}

function loadResumeLog(resumePath) {
    const log = JSON.parse(fs.readFileSync(resumePath, 'utf8'));
    const resolved = new Map();
    for (const entry of log.mods || []) {
        if (RESUMABLE_STATUSES.has(entry.status) && entry.modId != null && entry.fileId != null) {
            resolved.set(`${entry.modId}:${entry.fileId}`, entry);
        }
    }
    return resolved;
}

function writeLog(logPath, logData) {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, JSON.stringify(logData, null, 2));
}

function summarize(mods) {
    const summary = {};
    for (const m of mods) summary[m.status] = (summary[m.status] || 0) + 1;
    return summary;
}

// Called out separately (not just buried in the general summary) per the user's explicit request
// -- an Open FOMOD (real FOMOD wizard, no recorded choices, no deterministic default to replay)
// needs a manual reinstall through Vortex, and should be easy to spot in the report.
function getOpenFomodMods(modEntries) {
    return modEntries.filter((e) => e.status === 'SKIP_OPEN_FOMOD');
}

// Off-site (source.type 'browse'/'direct'/'bundle') mods with a missing archive -- this tool can
// never auto-download these regardless of settings, so the Plan page surfaces them as their own
// "go get this by hand, then tell us" callout instead of just a passive row in the table.
function getOffSiteMissingMods(modEntries) {
    return modEntries.filter((e) => e.status === 'SKIP_NO_ARCHIVE' && e.offSite);
}

// Formats the "a different version of this exact mod is already installed elsewhere" note --
// entries come from state-query-worker.js's buildModVersionIndex (version/fileId, the fields
// Vortex's OWN code actually trusts -- see that function's comment for why NOT modVersion/isPrimary).
function describeOtherVersions(entries) {
    if (!entries || entries.length === 0) return null;
    return entries.map((e) => {
        const enabledText = e.enabledProfiles && e.enabledProfiles.length > 0 ? 'enabled' : 'installed but not enabled';
        const variantText = e.variant ? ` via "${e.variant}"` : '';
        return `v${e.version || '?'} (fileId ${e.fileId || '?'}, ${enabledText}${variantText})`;
    }).join('; ');
}

// Reads and parses the latest non-dry-run log for ONE other collection -- the expensive part of
// findModStatusInOtherCollectionLog (a real readdirSync + N readFileSync+JSON.parse calls). Cached
// per otherCollectionModId (via the caller-supplied Map, one per buildPlan() call) since a large
// collection can share dozens of mods with the SAME other collection -- confirmed live this was the
// actual bottleneck for big collections: without caching, this exact same disk read+parse work was
// repeated once per shared mod instead of once per distinct other collection.
function loadLatestCompletedLog(logsDir, otherCollectionModId, cache) {
    if (cache.has(otherCollectionModId)) return cache.get(otherCollectionModId);
    let files;
    try {
        files = fs.readdirSync(logsDir).filter((f) => f.startsWith(`rebuild-${otherCollectionModId}-`) && f.endsWith('.json'));
    } catch {
        cache.set(otherCollectionModId, null);
        return null;
    }
    let latest = null;
    for (const f of files) {
        let log;
        try { log = JSON.parse(fs.readFileSync(path.join(logsDir, f), 'utf8')); } catch { continue; }
        if (log.runStatus === 'dry-run-complete') continue; // informational only, not a real completion
        if (!latest || new Date(log.startedAt) > new Date(latest.startedAt)) latest = log;
    }
    cache.set(otherCollectionModId, latest);
    return latest;
}

// Checks THIS tool's own logs to see if a shared mod (by modId+fileId) was already successfully
// REBUILT as part of another installed collection's most recent completed run -- directly relevant
// when a mod ends up mismatched/failed here: was this a wrong extraction, or does the exact same
// file/choices combination already work fine as part of a different collection? Real, confirmed-
// live case this was built for: "Dragon Priests Retexture SE - Half Res", shared by 3 collections,
// each recording different FOMOD choices for the identical underlying file.
function findModStatusInOtherCollectionLog(logsDir, otherCollectionModId, modId, fileId, cache) {
    if (!logsDir) return null;
    const latest = loadLatestCompletedLog(logsDir, otherCollectionModId, cache);
    if (!latest) return null;
    const entry = (latest.mods || []).find((m) => m.modId === modId && m.fileId === fileId);
    return entry ? { status: entry.status, finishedAt: latest.finishedAt || latest.startedAt } : null;
}

// Formats the "this exact mod is also referenced by other installed collections" note -- mirrors
// Vortex's own real "+2 collections" badge (see state-query-worker.js's scanAllCollections for the
// confirmed-against-Vortex's-actual-source membership logic), cross-referenced against this tool's
// own run logs so a mismatch reads as "a different collection's own choices produced this content",
// not an unexplained, possibly-alarming failure.
// Returns an array (one entry per other collection), not a joined string -- callers render each
// collection on its own line ("Already included in:" followed by one collection per line) instead
// of a semicolon-separated run-on sentence, which got unreadable fast as the shared-collection
// count grew.
function describeSharedWithCollections(entries, { logsDir, modId, fileId, logCache }) {
    if (!entries || entries.length === 0) return null;
    return entries.map((c) => {
        const logInfo = findModStatusInOtherCollectionLog(logsDir, c.collectionModId, modId, fileId, logCache);
        let statusNote;
        if (!logInfo) statusNote = 'not yet rebuilt by this tool';
        else if (logInfo.status === 'REBUILT') statusNote = `already rebuilt ${new Date(logInfo.finishedAt).toLocaleDateString()}`;
        else statusNote = `last status there: ${logInfo.status}`;
        return `${c.collectionName} (${statusNote})`;
    });
}

// Builds modEntries (SKIP_IGNORED + classified skip results) and rebuildQueue (mods needing a
// real rebuild this run). onModClassified(entry, index, total) fires per mod as classification
// completes -- archive-hashing across dozens (or, for a big collection, 100+) mods takes real
// time, so index/total lets a caller show real "X of Y checked" progress rather than an
// unexplained spinner. For a mod headed into rebuildQueue (not yet a final modEntries status), a
// synthetic {name, status: 'REBUILD_QUEUED', existingStagingFolder} is passed instead -- purely
// for progress display, never written to modEntries/the log.
async function buildPlan({ collectionModId, removedMods, keptMods, knownVortexModIds, resumed, downloadsDir, stagingDir, sevenZipExe, otherVersionsByModId, sharedWithCollectionsByKey, logsDir, onModClassified, downloadMissingArchivesEnabled = false, forceExtractOffSiteMismatchesEnabled = false }) {
    const modEntries = [];
    const rebuildQueue = [];
    const total = removedMods.length + keptMods.length;
    let index = 0;
    // One cache for this whole buildPlan() call -- see loadLatestCompletedLog's own comment for why
    // this eliminates the real, confirmed bottleneck on large collections (the same other-collection
    // log otherwise gets re-read+re-parsed once per shared mod instead of once per other collection).
    const sharedLogCache = new Map();

    for (const mod of removedMods) {
        index += 1;
        const entry = { name: mod.name, modId: mod.source?.modId, fileId: mod.source?.fileId, status: 'SKIP_IGNORED' };
        modEntries.push(entry);
        if (onModClassified) onModClassified(entry, index, total);
    }

    for (const mod of keptMods) {
        index += 1;
        const key = modKey(mod.source);
        const priorEntry = resumed?.get(key);
        if (priorEntry) {
            modEntries.push(priorEntry);
            if (onModClassified) onModClassified(priorEntry, index, total);
            continue;
        }
        const knownVortexModId = knownVortexModIds.get(key);
        // Manually-imported association (Import button) always takes priority -- resolved fresh on
        // every buildPlan() call, not just the run where Import was clicked, so it's picked up on any
        // future re-plan/rebuild for this collection with zero re-import needed.
        const importedFilename = collectionModId ? getImportedFilename(collectionModId, mod.name) : null;
        const overrideArchivePath = importedFilename ? path.join(downloadsDir, importedFilename) : null;
        const action = await classifyMod(mod, {
            downloadsDir, stagingDir, knownVortexModId, sevenZipExe,
            forceExtractOffSiteMismatch: forceExtractOffSiteMismatchesEnabled,
            overrideArchivePath,
        });
        const base = { name: mod.name, modId: mod.source?.modId, fileId: mod.source?.fileId };
        // Only meaningful when the SPECIFIC file this collection pins has no exact match --
        // state-query-worker.js already only populates this for exactly that case.
        const otherVersionsNote = mod.source?.modId != null
            ? describeOtherVersions(otherVersionsByModId?.[mod.source.modId])
            : null;
        // Which OTHER installed collections also reference this exact mod (real, live Vortex modKey
        // match, not a guess -- see scanAllCollections) -- meaningful regardless of match/mismatch
        // status, so computed and attached unconditionally alongside otherVersionsNote.
        const sharedWithNote = describeSharedWithCollections(sharedWithCollectionsByKey?.[key], {
            logsDir, modId: mod.source?.modId, fileId: mod.source?.fileId, logCache: sharedLogCache,
        });
        if (action.kind === 'SKIP_NO_ARCHIVE') {
            // Cross-referencing collection.json's own "optional" flag here: confirmed via real
            // investigation (a 24-mod collection, checked each mod's Vortex state directly) that a
            // missing archive for an OPTIONAL mod usually means the collection author never
            // required it and the user simply chose not to install it -- not a real problem needing
            // research, unlike a missing archive for a REQUIRED mod (that's a genuine "you're
            // missing something you're supposed to have" case, kept as SKIP_NO_ARCHIVE). Not a
            // perfect signal on its own -- some optional mods get installed anyway -- but a missing
            // archive AND optional=true together is a strong, real signal this was never installed
            // by choice, worth its own distinct status rather than lumping it in with genuine gaps.
            const optional = mod.optional === true;
            const status = optional ? 'SKIP_OPTIONAL_NOT_INSTALLED' : 'SKIP_NO_ARCHIVE';
            // Type-aware detail: an off-site mod (source.type !== 'nexus' -- 'browse'/'direct'/
            // 'bundle', confirmed via real collection.json examples to carry a url field sometimes
            // but NEVER a modId/fileId) can never be auto-downloaded regardless of the setting, so
            // it gets its own message instead of the "will download" suffix. NOT_FOUND and
            // HASH_MISMATCH are both eligible for that suffix -- from the user's perspective, neither
            // means a usable archive is actually present (a HASH_MISMATCH "candidate" is a same-size
            // coincidence, not the real file -- confirmed real-world: an unrelated archive happened to
            // match a 441-byte mod's size exactly). Only AMBIGUOUS (multiple candidates that ARE
            // byte-identical correct matches) keeps its technical detail -- a real duplicate-file
            // situation needing a human, where downloading again would only add a third correct copy.
            const isMissingLikeCode = action.code === 'NOT_FOUND' || action.code === 'HASH_MISMATCH';
            let detail;
            if (optional) {
                detail = 'Marked optional in this collection and not installed -- likely by choice, not a missing file.';
            } else if (mod.source?.type !== 'nexus' && action.code === 'HASH_MISMATCH' && action.candidateFile) {
                // A real file of the EXACT right size was found -- almost certainly the user's own
                // manual download attempt for this off-site mod -- but its content doesn't match
                // what this collection recorded (a different repack/edition). Distinct from the
                // generic "nothing here yet" message below: this one gets a "Force Extract Anyway"
                // resolve action on the log/Work Through Report page instead of just "go download it."
                detail = `A new file was found (${path.basename(action.candidateFile)}), but does not match what is expected by this collection. If valid, please install via Vortex directly.`;
            } else if (mod.source?.type !== 'nexus') {
                detail = mod.source?.url
                    ? `No archive file found. This is an off-site mod -- download manually from: ${mod.source.url}`
                    : 'No archive file found. This file is an off-site mod and no URL available.';
            } else if (isMissingLikeCode && downloadMissingArchivesEnabled) {
                detail = 'No archive file found. Will download during rebuild.';
            } else {
                detail = action.detail;
            }
            if (otherVersionsNote) detail += ` -- a different version of this exact mod IS installed: ${otherVersionsNote}`;
            if (sharedWithNote) detail += `\nAlready included in:\n${sharedWithNote.join('\n')}`;
            // Surfaced as their own fields (not just baked into `detail` text) so the log-view page's
            // Extraction column can render its own "obtain manually" message + a clickable link
            // (sourceUrl) or a "Force Extract Anyway" button (candidateFile, only ever set alongside
            // code === 'HASH_MISMATCH' -- that combination is the canonical "eligible to force
            // extract" check used everywhere: Plan page styling, log-view button, Work Through Report).
            const offSite = !optional && mod.source?.type !== 'nexus';
            const entry = {
                ...base, status, detail, code: !optional ? action.code : undefined,
                offSite: offSite || undefined, sourceUrl: offSite ? mod.source?.url : undefined,
                candidateFile: (offSite && action.code === 'HASH_MISMATCH') ? action.candidateFile : undefined,
                // AMBIGUOUS is real either way (off-site or Nexus) -- the delete-a-duplicate UI isn't
                // scoped to off-site mods the way Force Extract Anyway is.
                candidateFiles: (!optional && action.code === 'AMBIGUOUS') ? action.candidateFiles : undefined,
            };
            modEntries.push(entry);
            if (onModClassified) onModClassified(entry, index, total);
        } else if (action.kind === 'SKIP_OPEN_FOMOD') {
            const detailParts = [];
            if (otherVersionsNote) detailParts.push(`A different version of this exact mod IS installed: ${otherVersionsNote}`);
            if (sharedWithNote) detailParts.push(`Already included in:\n${sharedWithNote.join('\n')}`);
            const entry = { ...base, status: 'SKIP_OPEN_FOMOD', detail: detailParts.length > 0 ? detailParts.join('\n\n') : undefined };
            modEntries.push(entry);
            if (onModClassified) onModClassified(entry, index, total);
        } else {
            // A REBUILD that will create the folder from scratch (no existing staging folder) is
            // exactly the case confirmed live this session: our tool recreates the collection's
            // pinned (older) file as a brand-new, disabled mod entry, while a NEWER version of the
            // same modId may already be installed and active via a different collection -- not
            // harmful (Vortex won't auto-enable the new entry), but worth knowing before assuming
            // "missing" meant "broken".
            const otherVersionsRebuildNote = !action.existingStagingFolder ? otherVersionsNote : null;
            rebuildQueue.push({
                mod, action,
                base: { ...base, otherVersionsNote: otherVersionsRebuildNote || undefined, sharedWithNote: sharedWithNote || undefined },
            });
            if (onModClassified) {
                onModClassified({ ...base, status: 'REBUILD_QUEUED', existingStagingFolder: action.existingStagingFolder }, index, total);
            }
        }
    }

    return { modEntries, rebuildQueue };
}

// Re-classifies ONLY the mods that were just successfully downloaded (not a full buildPlan pass --
// those are already resolved) -- called after lib/nexus-mod-download.js's
// downloadMissingArchivesForPlan() reports DOWNLOADED for one or more mods. Mutates modEntries in
// place (replaces the stale SKIP_NO_ARCHIVE entry -- removed entirely if the mod now heads into
// rebuildQueue instead) and returns rebuildQueue-shaped items for the caller to push. A download
// that somehow doesn't resolve to REBUILD (e.g. archive-locator's own AMBIGUOUS if the download
// happened to land next to an unrelated same-size file, or SKIP_OPEN_FOMOD) is handled too, rather
// than assuming success always means REBUILD.
async function reclassifyDownloadedMods({ downloadedMods, modEntries, knownVortexModIds, otherVersionsByModId, sharedWithCollectionsByKey, downloadsDir, stagingDir, sevenZipExe, logsDir }) {
    const newRebuildItems = [];
    const sharedLogCache = new Map(); // see loadLatestCompletedLog's comment -- one cache per call
    for (const mod of downloadedMods) {
        const key = modKey(mod.source);
        const idx = modEntries.findIndex((e) => e.modId === mod.source?.modId && e.fileId === mod.source?.fileId);
        const action = await classifyMod(mod, { downloadsDir, stagingDir, knownVortexModId: knownVortexModIds.get(key), sevenZipExe });
        const base = { name: mod.name, modId: mod.source?.modId, fileId: mod.source?.fileId };
        const otherVersionsNote = mod.source?.modId != null ? describeOtherVersions(otherVersionsByModId?.[mod.source.modId]) : null;
        const sharedWithNote = describeSharedWithCollections(sharedWithCollectionsByKey?.[key], {
            logsDir, modId: mod.source?.modId, fileId: mod.source?.fileId, logCache: sharedLogCache,
        });

        if (action.kind === 'REBUILD') {
            if (idx !== -1) modEntries.splice(idx, 1);
            const otherVersionsRebuildNote = !action.existingStagingFolder ? otherVersionsNote : null;
            newRebuildItems.push({
                mod, action,
                base: { ...base, otherVersionsNote: otherVersionsRebuildNote || undefined, sharedWithNote: sharedWithNote || undefined },
            });
        } else {
            const entry = action.kind === 'SKIP_OPEN_FOMOD'
                ? { ...base, status: 'SKIP_OPEN_FOMOD', detail: action.detail }
                : { ...base, status: 'SKIP_NO_ARCHIVE', detail: action.detail, code: action.code };
            if (idx !== -1) modEntries[idx] = entry; else modEntries.push(entry);
        }
    }
    return newRebuildItems;
}

function buildLogData({ collectionInfo, stagingDir, downloadsDir, backupRoot, dryRun, startedAt, runStatus, modEntries, downloadResults, concurrentExtractions, phaseDurationsMs }) {
    return {
        schemaVersion: 3, // additive: concurrentExtractions + phaseDurationsMs are new and optional (Stats Report)
        collectionModId: collectionInfo.modId,
        collectionName: collectionInfo.name,
        collectionJsonPath: collectionInfo.collectionJsonPath,
        stagingDir, downloadsDir, backupRoot, dryRun,
        startedAt,
        finishedAt: runStatus === 'in-progress' ? null : new Date().toISOString(),
        durationMs: Date.now() - Date.parse(startedAt),
        runStatus,
        totalMods: modEntries.length,
        summary: summarize(modEntries),
        // Which concurrency setting was actually used for this run's rebuild phase, and how long
        // each phase took -- lets the Stats Report correlate concurrency with real rebuild-phase
        // duration instead of noisy total wall-clock (which also includes sync-state/backup time,
        // neither of which concurrency affects). null until the caller actually reaches/uses that
        // phase -- a run that dies early honestly logs null rather than a value it never used.
        concurrentExtractions: concurrentExtractions ?? null,
        phaseDurationsMs: phaseDurationsMs ?? null, // { syncStateMs, backupMs, rebuildMs }, each number|null
        downloadedArchives: downloadResults ? {
            attempted: downloadResults.results.length,
            succeeded: downloadResults.results.filter((r) => r.status === 'DOWNLOADED').length,
            failed: downloadResults.results.filter((r) => r.status === 'FAILED').length,
            skippedReason: downloadResults.skippedReason || null,
            entries: downloadResults.results,
        } : undefined,
        mods: modEntries,
    };
}

// Full-collection pre-run backup: persisted, cross-drive, never auto-deleted -- the user's own
// explicit extra-insurance request for the first real-run round. Only mods with an EXISTING
// staging folder have anything to back up; a mod with no staging folder at all has nothing to
// protect (see lib/rebuild-mod.js). onProgress({index, total, modName}) fires per mod copied.
// async + fs.promises.cp() (NOT fs.cpSync) is load-bearing, not a style choice -- confirmed live
// this session: a 25+ second backup showed literally nothing on the web UI (no phase text, no
// per-mod progress, straight from "downloading" to "rebuilding") because the old synchronous
// fs.cpSync() blocked Node's ENTIRE single-threaded event loop for the whole backup. Every
// runState.emit()'s res.write() call was already queued correctly, but couldn't actually flush
// over the socket until the blocking call finally returned -- at which point every queued SSE
// frame (backing-up phase, every backup-progress event, backup-complete) arrived in one burst,
// immediately followed by "rebuilding", so the browser painted and instantly overwrote it before
// a human could ever see it. Awaiting each mod's copy yields back to the event loop between mods,
// letting each queued write actually reach the browser in real time.
async function runBackup({ rebuildQueue, backupRoot, collectionModId, runTimestamp, onProgress }) {
    const toBackUp = rebuildQueue.filter(({ action }) => action.existingStagingFolder);
    const backupRunDir = path.join(backupRoot, `${collectionModId}-${runTimestamp}`);
    fs.mkdirSync(backupRunDir, { recursive: true });
    let index = 0;
    for (const { action, mod } of toBackUp) {
        index += 1;
        if (onProgress) onProgress({ index, total: toBackUp.length, modName: mod.name });
        await fs.promises.cp(action.stagingModDir, path.join(backupRunDir, action.targetFolderName), { recursive: true });
    }
    return { backupRunDir, backedUpCount: toBackUp.length };
}

// Deletes the OLDEST backup folders for this collection once the count exceeds maxBackupsToKeep --
// an opt-in retention limit (null/undefined = don't prune at all, keep every backup forever,
// today's existing behavior, unchanged unless a user explicitly sets a limit via Settings). 0 is a
// real, meaningful value here (prune down to none kept, including the one just made this run) --
// NOT the same as null/"unlimited", so this deliberately checks for null/undefined specifically,
// not falsiness. Folder names are "<collectionModId>-<runTimestamp>", and runTimestamp is an
// ISO-derived string (colons/dots replaced with dashes), so a plain lexicographic sort already
// reflects chronological order -- no need to parse dates back out of the folder name.
function pruneOldBackups({ backupRoot, collectionModId, maxBackupsToKeep }) {
    if (maxBackupsToKeep == null) return { deleted: [] };
    let entries;
    try {
        entries = fs.readdirSync(backupRoot, { withFileTypes: true });
    } catch {
        return { deleted: [] };
    }
    const prefix = `${collectionModId}-`;
    const matching = entries
        .filter((e) => e.isDirectory() && e.name.startsWith(prefix))
        .map((e) => e.name)
        .sort(); // oldest first
    const excess = matching.length - maxBackupsToKeep;
    if (excess <= 0) return { deleted: [] };
    const toDelete = matching.slice(0, excess);
    for (const name of toDelete) {
        fs.rmSync(path.join(backupRoot, name), { recursive: true, force: true });
    }
    return { deleted: toDelete };
}

// The per-mod rebuild loop. Mutates AND returns modEntries; onModStart/onModComplete fire around
// each rebuildMod() call. Halts (stops STARTING new mods, returns {haltedCritical: true}) on
// CRITICAL_MANUAL_RESTORE_NEEDED -- the one non-self-healing failure mode; everything else logs
// and continues.
//
// concurrency (default 1, today's exact original sequential behavior): a hand-rolled worker pool,
// not a new dependency -- each rebuildMod() call already only ever spawns its OWN independent
// extract-mod.js child process (see rebuild-mod.js's runExtract, itself already async/non-blocking)
// and touches only that mod's own uniquely-named paths (<stagingModDir>.rebuilding/.old, derived
// from its own targetFolderName), so N of these running "at once" is really just N independent
// child processes, no different from a user opening N terminal windows. The bookkeeping below
// (nextIndex, modEntries.push, haltedCritical) has no real race to guard against either: Node's
// single-threaded event loop still runs each worker's callback body to completion before the next
// one gets a turn, even when their underlying child processes overlap in wall-clock time. Once one
// mod hits CRITICAL_MANUAL_RESTORE_NEEDED, no NEW mod is started (workers check haltedCritical
// before pulling the next item) but any already-in-flight ones are left to finish naturally --
// there's no safe way to abort a mid-extraction/mid-swap operation, and nothing else about letting
// them finish is unsafe.
//
// pauseController (optional -- lib/pause-controller.js; omitted entirely by the CLI's own direct
// caller, which has no pause UI): same "only ever stops PULLING new work" treatment as
// haltedCritical, checked alongside it in each worker's while condition. The difference from
// haltedCritical is that a pause is reversible -- confirmed with the user this must be a TRUE,
// immediate "continue like nothing happened" on cancel, not just a dismissed popup. That's what the
// outer for(;;) loop below is for: once a batch of workers stops early because of a pause (not
// haltedCritical, not queue-exhausted), it awaits pauseController.waitForChange() (event-driven,
// zero polling cost while idle) and either spawns a FRESH batch to refill the now-open worker slots
// (cancelPause) or stops for good (confirmPause) -- see lib/pause-controller.js's own header
// comment for the full state machine.
async function runRebuild({ rebuildQueue, collectionJsonPath, downloadsDir, stagingDir, modEntries, onModStart, onModComplete, concurrency = 1, pauseController }) {
    let haltedCritical = false;
    let nextIndex = 0;

    async function worker() {
        while (!haltedCritical && !(pauseController && pauseController.isPaused())) {
            const myIndex = nextIndex++;
            if (myIndex >= rebuildQueue.length) return;
            const { mod, action, base } = rebuildQueue[myIndex];
            if (onModStart) onModStart(mod);
            if (pauseController) pauseController.markStarted();
            const result = await rebuildMod(mod, action, { collectionJsonPath, downloadsDir, stagingDir });
            if (pauseController) pauseController.markFinished();
            // Surfaced so a FAILED_* entry in the report is actionable without reverse-engineering it
            // via Vortex or a manual archive search first -- confirmed live: a mismatch flagged only
            // by mod name left no way to find the actual archive (the user's own real archive filename
            // for "Bitchcraft Tats" is "1.0-82644-1-0-1727545168.7z", containing none of the mod's own
            // name at all).
            const archiveName = action.archivePath ? path.basename(action.archivePath) : undefined;
            // Leaves a clear trail (same principle as every other manual/forced action in this log)
            // that this REBUILT entry did NOT come from an exact collection.json match -- either the
            // Settings toggle or a manual "Force Extract Anyway" click accepted a same-size-but-
            // different-content off-site file instead.
            const entry = { ...base, targetFolderName: action.targetFolderName, archiveName, ...result };
            // result may already carry its OWN note (e.g. "recreated from scratch") -- append rather
            // than overwrite, so neither trail is lost.
            if (action.forcedMismatch) {
                const forcedMismatchNote = 'Force-extracted: this off-site archive did not exactly match what the collection recorded (different repack/edition) -- accepted anyway per settings/manual override.';
                entry.note = entry.note ? `${entry.note} ${forcedMismatchNote}` : forcedMismatchNote;
            } else if (action.importedOverride) {
                const importedNote = 'Manually imported: this off-site archive was never verified against collection.json (different size/content, or simply not checked) -- accepted via explicit user import.';
                entry.note = entry.note ? `${entry.note} ${importedNote}` : importedNote;
            }
            modEntries.push(entry);
            if (onModComplete) onModComplete(entry);
            if (entry.status === 'CRITICAL_MANUAL_RESTORE_NEEDED') {
                haltedCritical = true;
            }
        }
    }

    const workerCount = Math.max(1, Math.min(concurrency, rebuildQueue.length || 1));

    for (;;) {
        const batchSize = Math.max(0, Math.min(workerCount, rebuildQueue.length - nextIndex));
        if (batchSize > 0) {
            await Promise.all(Array.from({ length: batchSize }, () => worker()));
        }
        if (haltedCritical || nextIndex >= rebuildQueue.length || !pauseController) break;
        // Every worker in that batch stopped early, and it wasn't haltedCritical or a drained
        // queue -- the only other reason is a pause. Wait for it to resolve one way or the other
        // before deciding what to do next.
        await pauseController.waitForChange();
        if (pauseController.getState() === 'paused') {
            return { haltedCritical: false, pausedConfirmed: true };
        }
        // Else cancelled (state back to 'running') -- loop back and spawn a fresh batch sized to
        // whatever's left, restoring full concurrency immediately.
    }
    return { haltedCritical, pausedConfirmed: false };
}

// Manually resolves a single mod that already came back FAILED_MISMATCH_NOT_TOUCHED from a real
// run -- triggered from the log-view page's "Extraction" column (see rebuild-mod.js's resolveMode
// header comment for what 'all'/'keep-existing' each do). Deliberately reuses the ORIGINAL run's
// own recorded targetFolderName rather than re-resolving it via findCurrentModIds/Vortex's live
// state: a FAILED_MISMATCH_NOT_TOUCHED status already proves a real staging folder exists at that
// exact path (rebuildMod only ever returns it when action.existingStagingFolder was true), so this
// action needs no live Vortex-state read at all, unlike a normal plan/rebuild -- can run with
// Vortex open.
async function resolveMismatchedMod({ collectionModId, stagingDir, downloadsDir, modId, fileId, name, targetFolderName, resolveMode }) {
    const collectionInfo = resolveCollectionInfo(stagingDir, collectionModId);
    // Off-site mods (source.type 'browse'/'direct', e.g. a Google Drive link) have no Nexus
    // modId/fileId at all -- confirmed live with a real "browse"-type mod ("High Poly Head") that hit
    // FAILED_MISMATCH_NOT_TOUCHED with a real, resolvable staging folder and archive, but no way to
    // re-locate it via the modId/fileId path. Falls back to an exact name match in that case; name
    // isn't a database key so it's guarded against ambiguity rather than silently picking one.
    const mod = (modId != null && fileId != null)
        ? collectionInfo.collection.mods.find((m) => m.source?.modId === modId && m.source?.fileId === fileId)
        : (() => {
            const matches = collectionInfo.collection.mods.filter((m) => m.name === name && m.source?.modId == null);
            if (matches.length > 1) throw new Error(`Multiple off-site mods named "${name}" found in this collection.json -- can't disambiguate without a modId/fileId.`);
            return matches[0];
        })();
    if (!mod) throw new Error(`Mod ${modId != null ? `modId=${modId} fileId=${fileId}` : `named "${name}"`} not found in this collection's collection.json.`);

    const archivePath = await locateArchive(downloadsDir, mod.source);
    const stagingModDir = path.join(stagingDir, targetFolderName);
    if (!fs.existsSync(stagingModDir)) {
        // Folder NAME only, not the full path -- there's only one staging location in this whole
        // app (configured once in Settings), so the full path is never meaningful to the user here.
        throw new Error(`Expected an existing staging folder named "${targetFolderName}" (from the original run's own log) but it's gone.`);
    }
    const action = { kind: 'REBUILD', targetFolderName, archivePath, stagingModDir, existingStagingFolder: true };

    const result = await rebuildMod(mod, action, { collectionJsonPath: collectionInfo.collectionJsonPath, downloadsDir, stagingDir }, resolveMode);
    return { mod, result, archiveName: path.basename(archivePath) };
}

// Manual "Retry Extraction" for a FAILED_EXTRACTION_NOT_TOUCHED/NO_PRIOR_DATA mod whose failure
// was NOT archive-not-found (that gets its own Retry Download/Import path) -- e.g. a transient
// Windows file-lock during the 7z-scratch copy step, confirmed real-world this session (an EPERM
// on a freshly-extracted .ini file, almost certainly antivirus/indexer briefly holding a handle).
// Re-locates the SAME archive and re-attempts the exact same classify+extract flow from scratch.
// Reuses the log's own recorded targetFolderName (same identity reasoning as resolveMismatchedMod),
// but -- unlike that function -- does NOT assume existingStagingFolder: NOT_TOUCHED means the real
// staging folder existed before this run, NO_PRIOR_DATA means it never did, so this checks fresh
// rather than hardcoding either way. No resolveMode passed through: if the retry succeeds cleanly
// it's REBUILT; if it succeeds but reveals a genuine content mismatch, it correctly comes back
// FAILED_MISMATCH_NOT_TOUCHED instead (its own resolvable status with Extract all/Keep modified),
// never silently forced.
async function retryExtraction({ collectionModId, stagingDir, downloadsDir, modId, fileId, name, targetFolderName }) {
    const collectionInfo = resolveCollectionInfo(stagingDir, collectionModId);
    const mod = (modId != null && fileId != null)
        ? collectionInfo.collection.mods.find((m) => m.source?.modId === modId && m.source?.fileId === fileId)
        : (() => {
            const matches = collectionInfo.collection.mods.filter((m) => m.name === name && m.source?.modId == null);
            if (matches.length > 1) throw new Error(`Multiple off-site mods named "${name}" found in this collection.json -- can't disambiguate without a modId/fileId.`);
            return matches[0];
        })();
    if (!mod) throw new Error(`Mod ${modId != null ? `modId=${modId} fileId=${fileId}` : `named "${name}"`} not found in this collection's collection.json.`);

    let archivePath;
    try {
        archivePath = await locateArchive(downloadsDir, mod.source);
    } catch (e) {
        // The archive situation can genuinely change between the original failure and this retry
        // (e.g. it's now AMBIGUOUS because a second copy showed up, or it's gone missing) -- report
        // that as a fresh SKIP_NO_ARCHIVE-shaped outcome instead of letting it throw uncaught, so the
        // route can update the log with the CURRENT real state (and offer Retry Download/Import/
        // delete-duplicate) instead of just a dead 500 that leaves the log's old data unchanged.
        return {
            kind: 'SKIP_NO_ARCHIVE',
            detail: (e.code === 'NOT_FOUND' || e.code === 'HASH_MISMATCH') ? 'No archive file found.' : e.message,
            code: e.code, candidateFile: e.candidates?.[0],
            candidateFiles: e.code === 'AMBIGUOUS' ? e.candidates : undefined,
        };
    }
    const stagingModDir = path.join(stagingDir, targetFolderName);
    const existingStagingFolder = fs.existsSync(stagingModDir);
    const action = { kind: 'REBUILD', targetFolderName, archivePath, stagingModDir, existingStagingFolder };

    const result = await rebuildMod(mod, action, { collectionJsonPath: collectionInfo.collectionJsonPath, downloadsDir, stagingDir });
    return { mod, result, archiveName: path.basename(archivePath) };
}

// Retries a single mod's Nexus download on demand -- from the log-view page's "Retry Download"
// button (SKIP_NO_ARCHIVE mods) or the Work Through Report's equivalent. Distinct from
// resolveMismatchedMod above: that one already has a real staging folder to compare against
// (a mismatch), so it never needs Vortex-state; this one has NEVER had an archive before, so
// there's nothing to compare -- once the archive exists, it's classified and rebuilt exactly like
// any other never-before-installed mod. knownVortexModId: null is deliberate, not a shortcut to fix
// later -- Vortex has never tracked this mod (it never had an archive), so classifyMod's own
// archiveBaseName fallback for targetFolderName is exactly right, same as a real first-time
// install. No live Vortex-state lookup needed, matching this function's own no-DB-access spirit.
async function retryMissingArchiveDownload({ collectionModId, stagingDir, downloadsDir, sevenZipExe, modId, fileId }) {
    const collectionInfo = resolveCollectionInfo(stagingDir, collectionModId);
    const mod = collectionInfo.collection.mods.find((m) => m.source?.modId === modId && m.source?.fileId === fileId);
    if (!mod) throw new Error(`Mod modId=${modId} fileId=${fileId} not found in this collection's collection.json.`);
    if (mod.source?.type !== 'nexus') {
        const err = new Error('Only Nexus-hosted mods can be downloaded this way.');
        err.code = 'NOT_NEXUS';
        throw err;
    }

    const apiKey = nexusModDownload.resolveApiKey();
    const premium = await nexusModDownload.checkPremiumStatus(apiKey);
    if (!premium.isPremium) {
        const err = new Error("Nexus API only allows automated downloads for Premium accounts -- this respects Nexus's ad-supported download model for free users. Download this archive manually from Nexus and let Vortex install it, or upgrade to Premium.");
        err.code = 'NOT_PREMIUM';
        throw err;
    }

    try {
        await nexusModDownload.downloadModArchive({
            apiKey, gameDomain: collectionInfo.collection.info?.domainName, source: mod.source, destDir: downloadsDir,
        });
    } catch (e) {
        const err = new Error(`Download failed. Please download via Vortex. (${e.message})`);
        err.code = 'DOWNLOAD_FAILED';
        throw err;
    }

    const action = await classifyMod(mod, { downloadsDir, stagingDir, knownVortexModId: null, sevenZipExe });
    if (action.kind !== 'REBUILD') {
        // code/candidateFile/candidateFiles must travel with the outcome, not just detail --
        // confirmed live this was a real bug: a retry that re-downloaded into an already-ambiguous
        // downloads folder came back detail="Multiple matching files were found..." but a STALE
        // code left over from the ORIGINAL classification (still "NOT_FOUND"), so the log-view
        // page's AMBIGUOUS-gated delete-duplicate UI never appeared despite the detail text
        // correctly describing exactly that situation.
        return {
            kind: action.kind, detail: action.detail, code: action.code,
            candidateFile: action.candidateFile, candidateFiles: action.candidateFiles,
        };
    }
    const result = await rebuildMod(mod, action, { collectionJsonPath: collectionInfo.collectionJsonPath, downloadsDir, stagingDir });
    return { kind: 'REBUILD', targetFolderName: action.targetFolderName, archiveName: path.basename(action.archivePath), ...result };
}

// Deletes ONE candidate archive file -- the log/Work Through Report's AMBIGUOUS "delete a duplicate"
// action (real-world case: two byte-identical copies of the same archive under different
// filenames). Validated to actually be inside downloadsDir (defense in depth -- the route calling
// this also validates it's one of the log entry's own recorded candidateFiles first).
function deleteArchiveCandidate({ downloadsDir, filePath }) {
    const resolvedDownloads = path.resolve(downloadsDir);
    const resolvedFile = path.resolve(filePath);
    if (path.dirname(resolvedFile) !== resolvedDownloads) {
        throw new Error('Refusing to delete a file outside the configured downloads folder.');
    }
    fs.unlinkSync(resolvedFile);
}

// Re-checks a single mod from scratch (classify + extract), no download attempt -- used right after
// deleteArchiveCandidate() above once only one candidate remains: the normal locateArchive() path
// just needs to run again, there's nothing left to fetch. Also reused as a plain "try this mod
// again" primitive more generally. knownVortexModId: null -- same "never tracked before" reasoning
// as retryMissingArchiveDownload/forceExtractOffSiteMod.
async function reclassifyMod({ collectionModId, stagingDir, downloadsDir, sevenZipExe, modId, fileId, name }) {
    const collectionInfo = resolveCollectionInfo(stagingDir, collectionModId);
    const mod = (modId != null && fileId != null)
        ? collectionInfo.collection.mods.find((m) => m.source?.modId === modId && m.source?.fileId === fileId)
        : (() => {
            const matches = collectionInfo.collection.mods.filter((m) => m.name === name && m.source?.modId == null);
            if (matches.length > 1) throw new Error(`Multiple off-site mods named "${name}" found in this collection.json -- can't disambiguate without a modId/fileId.`);
            return matches[0];
        })();
    if (!mod) throw new Error(`Mod ${modId != null ? `modId=${modId} fileId=${fileId}` : `named "${name}"`} not found in this collection's collection.json.`);

    const action = await classifyMod(mod, { downloadsDir, stagingDir, knownVortexModId: null, sevenZipExe });
    if (action.kind !== 'REBUILD') {
        return {
            kind: action.kind, detail: action.detail, code: action.code,
            candidateFile: action.candidateFile, candidateFiles: action.candidateFiles,
        };
    }
    const result = await rebuildMod(mod, action, { collectionJsonPath: collectionInfo.collectionJsonPath, downloadsDir, stagingDir });
    return { kind: 'REBUILD', targetFolderName: action.targetFolderName, archiveName: path.basename(action.archivePath), ...result };
}

// Manual "Force Extract Anyway" -- the log/Work Through Report equivalent of the Settings toggle,
// for a SKIP_NO_ARCHIVE entry that has a recorded candidateFile (a real file of the exact right
// size that just failed the md5 check). Off-site only, name-based lookup like resolveMismatchedMod
// above (no modId/fileId for these). knownVortexModId: null -- same reasoning as
// retryMissingArchiveDownload: this mod has never had a matching archive before as far as this tool
// is concerned, so classifyMod's own archiveBaseName fallback for targetFolderName is correct.
async function forceExtractOffSiteMod({ collectionModId, stagingDir, downloadsDir, sevenZipExe, name }) {
    const collectionInfo = resolveCollectionInfo(stagingDir, collectionModId);
    const matches = collectionInfo.collection.mods.filter((m) => m.name === name && m.source?.modId == null);
    if (matches.length > 1) throw new Error(`Multiple off-site mods named "${name}" found in this collection.json -- can't disambiguate without a modId/fileId.`);
    const mod = matches[0];
    if (!mod) throw new Error(`Off-site mod named "${name}" not found in this collection's collection.json.`);

    const action = await classifyMod(mod, { downloadsDir, stagingDir, knownVortexModId: null, sevenZipExe, forceExtractOffSiteMismatch: true });
    if (action.kind !== 'REBUILD') {
        // Either it turned out there's no HASH_MISMATCH candidate after all (NOT_FOUND -- the file
        // that prompted this click is gone), or it's SKIP_OPEN_FOMOD -- either way, nothing to force.
        // code/candidateFile/candidateFiles must travel too, not just detail -- same stale-code bug
        // already fixed in retryMissingArchiveDownload above.
        return {
            kind: action.kind, detail: action.detail, code: action.code,
            candidateFile: action.candidateFile, candidateFiles: action.candidateFiles,
        };
    }
    const result = await rebuildMod(mod, action, { collectionJsonPath: collectionInfo.collectionJsonPath, downloadsDir, stagingDir });
    const forcedMismatchNote = 'Force-extracted: this off-site archive did not exactly match what the collection recorded (different repack/edition) -- accepted anyway per manual override.';
    return {
        kind: 'REBUILD', targetFolderName: action.targetFolderName, archiveName: path.basename(action.archivePath),
        ...result, note: result.note ? `${result.note} ${forcedMismatchNote}` : forcedMismatchNote,
    };
}

// "Import" button -- the user has a real archive file for an off-site mod sitting SOMEWHERE on
// disk (wherever they saved it, not necessarily the downloads folder) and points at it via a
// native file picker (the route calling this already ran that picker). MOVES it into downloadsDir
// (not copy -- per explicit request, avoiding permanent duplicate disk usage the user would
// otherwise have to clean up by hand) and records the association in offsite-import-map.json,
// keyed by collection + mod name, so every FUTURE plan/rebuild for this collection picks it up
// automatically -- no re-import needed next week, next month, etc. Dedupes on a same-name
// collision (e.g. importing two different mods that both happened to download as "archive.zip")
// by appending " (n)" rather than silently overwriting an unrelated file already in downloadsDir.
function importOffSiteArchive({ downloadsDir, collectionModId, name, pickedFilePath }) {
    let destName = path.basename(pickedFilePath);
    let destPath = path.join(downloadsDir, destName);
    let n = 1;
    while (fs.existsSync(destPath) && path.resolve(destPath) !== path.resolve(pickedFilePath)) {
        const ext = path.extname(destName);
        const base = path.basename(destName, ext);
        destPath = path.join(downloadsDir, `${base} (${n})${ext}`);
        n += 1;
    }
    if (path.resolve(destPath) !== path.resolve(pickedFilePath)) {
        try {
            fs.renameSync(pickedFilePath, destPath);
        } catch (e) {
            // EXDEV = source and destination are on different drives -- rename() can't cross those on
            // Windows, so fall back to copy+delete (still an overall "move" from the user's perspective).
            if (e.code !== 'EXDEV') throw e;
            fs.copyFileSync(pickedFilePath, destPath);
            fs.unlinkSync(pickedFilePath);
        }
    }
    const filename = path.basename(destPath);
    setImportedFilename(collectionModId, name, filename);
    return { filename };
}

// Extracts an off-site mod using its already-recorded Import association (offsite-import-map.json)
// -- the log-view/Work Through Report "Import" button's immediate-resolve step, called right after
// importOffSiteArchive() above. Same off-site name-based lookup as forceExtractOffSiteMod/
// resolveMismatchedMod; knownVortexModId: null for the same "never tracked before" reasoning as
// retryMissingArchiveDownload.
async function extractImportedOffSiteMod({ collectionModId, stagingDir, downloadsDir, sevenZipExe, name }) {
    const collectionInfo = resolveCollectionInfo(stagingDir, collectionModId);
    const matches = collectionInfo.collection.mods.filter((m) => m.name === name && m.source?.modId == null);
    if (matches.length > 1) throw new Error(`Multiple off-site mods named "${name}" found in this collection.json -- can't disambiguate without a modId/fileId.`);
    const mod = matches[0];
    if (!mod) throw new Error(`Off-site mod named "${name}" not found in this collection's collection.json.`);

    const importedFilename = getImportedFilename(collectionModId, name);
    if (!importedFilename) throw new Error(`No imported archive is recorded for "${name}" -- import one first.`);
    const overrideArchivePath = path.join(downloadsDir, importedFilename);

    const action = await classifyMod(mod, { downloadsDir, stagingDir, knownVortexModId: null, sevenZipExe, overrideArchivePath });
    if (action.kind !== 'REBUILD') {
        // code/candidateFile/candidateFiles must travel too, not just detail -- same stale-code bug
        // already fixed in retryMissingArchiveDownload/forceExtractOffSiteMod above.
        return {
            kind: action.kind, detail: action.detail, code: action.code,
            candidateFile: action.candidateFile, candidateFiles: action.candidateFiles,
        };
    }
    const result = await rebuildMod(mod, action, { collectionJsonPath: collectionInfo.collectionJsonPath, downloadsDir, stagingDir });
    const importedNote = 'Manually imported: this off-site archive was never verified against collection.json (different size/content, or simply not checked) -- accepted via explicit user import.';
    return {
        kind: 'REBUILD', targetFolderName: action.targetFolderName, archiveName: path.basename(action.archivePath),
        ...result, note: result.note ? `${result.note} ${importedNote}` : importedNote,
    };
}

module.exports = {
    RESUMABLE_STATUSES,
    modKey,
    loadSyncLib,
    resolveCollectionInfo,
    loadSyncState,
    loadSyncStateBatch,
    loadResumeLog,
    writeLog,
    summarize,
    getOpenFomodMods,
    getOffSiteMissingMods,
    buildPlan,
    reclassifyDownloadedMods,
    buildLogData,
    runBackup,
    pruneOldBackups,
    runRebuild,
    resolveMismatchedMod,
    retryExtraction,
    retryMissingArchiveDownload,
    deleteArchiveCandidate,
    reclassifyMod,
    forceExtractOffSiteMod,
    importOffSiteArchive,
    extractImportedOffSiteMod,
};
