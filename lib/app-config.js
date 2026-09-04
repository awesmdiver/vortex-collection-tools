'use strict';
// Single source of truth for this project's persisted, user-editable settings -- staging/downloads/
// backup-root/state.v2 paths, the backup-before-rebuild toggle, and the Nexus API key. Everything
// here is personal-machine-specific (or a credential) and gitignored; config/config.example.json
// documents the shape with null placeholders so a fresh clone of this project has zero hardcoded
// paths baked into shipped source. Read/written by both the web UI (web/settings-routes.js) and the standalone
// terminal tools (lib/vortex-sync/lib.js, whose own CONFIG_PATH points here too -- see its header
// comment) so there is exactly one config file, never two that could drift out of sync.

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'config.json');

// Whenever a field is added/removed/renamed below, also update the committed `config/config.example.json`
// template to match -- nothing enforces this automatically, and it silently drifted out of sync
// before (confirmed 2026-07-27, missing two fields). loadConfig()'s own default-merge means a stale
// example causes no functional bug, which is exactly why it's easy to forget.
const DEFAULT_CONFIG = {
    staging: null,
    downloads: null,
    backupRoot: null,
    // Where Update Collection's own backups (small ignored/disabled JSON snapshots, NOT Rebuild
    // Collection's mod-folder backups above) are saved -- previously hardcoded to
    // lib/vortex-sync/backups/ inside this project's own folder; null here means "use that same
    // default", so this is optional to configure, not required.
    syncBackupRoot: null,
    state: null,
    // Single setting doing double duty: null = unlimited (back up every run, keep them all
    // forever); 0 = off (don't back up at all -- this is the default for a brand-new install,
    // explicit opt-in rather than an assumed safety net); 1-3 = back up every run, but prune down
    // to only the N most recent afterward. Anyone upgrading an existing config.json that already
    // has this set keeps their own saved value -- this default only applies before any config.json
    // exists at all.
    maxBackupsToKeep: 0,
    // A SEPARATE, unrelated backup store -- the full state.v2 safety copies lib.js's
    // backupLiveState takes automatically before every live write (Update Collection's applies,
    // Rules Generator's Apply to Vortex, restore-state itself). Unlike maxBackupsToKeep above,
    // there's no "off" state here -- these backups aren't optional, they're the safety net for a
    // risky write -- so null/undefined means unlimited (today's actual behavior, kept as the
    // default so this is a non-breaking addition), and a positive integer prunes down to the N
    // most recent after each new one is taken.
    maxStateBackupsToKeep: null,
    // How many mods Rebuild Collection extracts in parallel (each is its own independent 7-Zip
    // child process). 1 = sequential, today's original behavior -- the safe default; opt-in only.
    // Clamped to 1-8 in web/settings-routes.js.
    concurrentExtractions: 1,
    nexusApiKey: null,
    // Auto-download a mod's archive from Nexus when it's missing from the downloads folder, instead
    // of just skipping it. Opt-in, default off: only works for Nexus Premium accounts (Nexus's own
    // ad-supported download model refuses automated downloads for free accounts -- see
    // lib/nexus-mod-download.js's header comment), and even when on, read fresh per-run (no restart
    // needed), same convention as maxBackupsToKeep/concurrentExtractions. Never applies to off-site
    // (non-Nexus) mods -- those have no modId/fileId to call the API with in the first place.
    downloadMissingArchives: false,
    // When an off-site (non-Nexus) mod's archive can't be located, but a same-size candidate file
    // WAS found in the downloads folder that just fails the md5 check (a different repack/edition,
    // not a truly missing file), auto-extract that candidate anyway instead of flagging it and
    // waiting for a manual "Force Extract Anyway" click on the log/Work Through Report. Opt-in,
    // default off -- same "read fresh per-run, no restart" convention as downloadMissingArchives.
    // Never applies to a genuinely NOT_FOUND off-site mod (no candidate of the right size at all).
    forceExtractOffSiteMismatches: false,
    // "Don't show this again" for the startup "Vortex version untested" warning (shell.js) -- opt-in
    // to silence, default off so a fresh install always sees it once. Not a path/server field, so
    // toggling it never triggers restartRequired, same convention as downloadMissingArchives.
    hideVortexVersionWarning: false,
    // Application-level log (2026-08-26, lib/app-logger.js) -- ONE plain-text file per server
    // session capturing startup info (port/host/PID/every resolved config path) plus every
    // console.log/info/warn/error call project-wide, tee'd there in addition to the real stdout/
    // stderr. Opt-in, default off, same convention as downloadMissingArchives/
    // forceExtractOffSiteMismatches above. Motivated by two real incidents this repo already has
    // written up (GitHub issue #4 -- root-caused by reading code and guessing, some of it still
    // guesswork; diagnostics/dangling-formid-merge-crash's own root-cause-findings.md, which was
    // only possible at all because Merge Plugins v2's OWN crash-diagnostic file, commit dcf40f9,
    // happened to capture the right trace). This is a SEPARATE, ongoing file from both of those --
    // not a replacement for collection-runner.js's own per-run JSON logs, and not a replacement for
    // merge-v2-runner.js's own per-crash diagnostic file. Read once at server startup (web/server.js
    // decides whether to wrap console.* based on this), same "requires restart" treatment as
    // logsDir/serverPort/serverHost, since the wrapping itself only ever happens once, at boot.
    appLogEnabled: false,
    // Server bind settings -- read once at process startup (web/server.js), so changing any of
    // these needs a restart just like the path fields above. serverHost defaults to loopback-only:
    // this server has no authentication (see server.js's own header comment), so binding anything
    // other than 127.0.0.1/localhost exposes full filesystem/mod-state control to the network.
    serverPort: 4321,
    serverHost: '127.0.0.1',
    autoOpenBrowser: true,
    // Where every tool's log files are stored, shared across the whole app (General settings, not
    // per-tool) -- null means "use the built-in logs/ folder inside this project", matching the
    // null-means-default convention every other path field here already uses. When set, each tool
    // gets its OWN subfolder underneath this root (see getLogsDir below) rather than all tools
    // dumping files into one shared flat folder -- keeps them easy to tell apart once more than one
    // tool writes logs. A path field like staging/downloads, so changing it requires a restart.
    logsDir: null,
    // Clean Up report (lib/cleanup-scan.js): folder where the exclude-list data file lives (names
    // the user explicitly marked "Exclude" from the "unrecognized name" review list -- a
    // folder/archive whose name doesn't match Vortex's own modId-version-timestamp download-naming
    // convention, so it can't be confidently auto-flagged as a real orphan; confirmed real-world
    // 2026-07-27: DynDOLOD/BodySlide/PGPatcher/Pandora/TexGen "fake mod" output folders, and other
    // user-created patch folders, have exactly this shape -- no source archive by design, not an
    // orphan). REQUIRED, no built-in-default fallback -- same "always a user-chosen path, never a
    // silent default" standing rule as staging/downloads/syncBackupRoot (confirmed explicitly by the
    // user 2026-07-27 for every new data location this project adds going forward). A path field
    // like staging/downloads, so changing it requires a restart. The actual list data
    // (lib/cleanup-exclude-store.js) lives in `<this dir>/exclude-list.json`, read fresh on every
    // request -- only the FOLDER location is baked in at startup, not the list contents.
    cleanupExcludeListDir: null,
    // Missing Masters utility (lib/missing-masters-scan.js): READ-ONLY inputs -- the real Skyrim
    // Data folder (where actual .esp/.esm/.esl files live, used to check master presence/read each
    // active plugin's own TES4 header) and the folder containing Plugins.txt (the real, live
    // active-plugin list -- see lib/missing-masters-scan.js's own header for why loadorder.txt
    // turned out to be unnecessary here). REQUIRED, no built-in-default fallback, same standing rule
    // as cleanupExcludeListDir above -- even though these two are OS-standard locations that could
    // in principle be guessed, this project never assumes a location, always asks.
    skyrimDataDir: null,
    pluginsListDir: null,
    // WRITE target for "Create Dummy Master" -- the ONLY path this feature ever writes to. NEVER
    // skyrimDataDir/SKSE or any folder inside the live Data folder (confirmed standing rule
    // 2026-07-27) -- a dummy master is written here instead, mirroring the user's own real Wrye
    // Bash workflow of keeping generated dummy masters in a dedicated folder inside their staging
    // directory (e.g. "Wyre Output") that they separately get Vortex to recognize as a mod, exactly
    // like this project's own DynDOLOD Output/BodySlide Output orphan-detection precedent. REQUIRED,
    // no default, same as every other path field here.
    dummyMastersOutputDir: null,
    // Archive Finder utility (lib/archive-finder-db.js): where the archive/file search index
    // (a small SQLite database) lives. REQUIRED, no built-in-default fallback, same standing rule
    // as cleanupExcludeListDir/skyrimDataDir/etc. -- folded in from the standalone "Archive File
    // Finder" project 2026-07-28 (see TECHNICAL.md), which used to hardcode this to a `data/`
    // folder inside its own source tree. A path field like staging/downloads, so changing it
    // requires a restart (the DB connection is opened once at server startup). Deliberately does
    // NOT get its own "scan folder" setting -- it reuses `downloads` above, since that's the exact
    // same folder ("your mod manager's downloads folder, the still-zipped originals") the
    // standalone tool's own README already told users to point at.
    archiveFinderDbDir: null,
    // Optional default extraction destination -- pre-fills the Extract dialog, but the user can
    // always pick a different folder per extraction. Unlike archiveFinderDbDir, blank is a normal,
    // supported state (same treatment as backupRoot/state above), not something that blocks Save.
    archiveFinderOutputDir: null,
    // Which file extensions to index/search (e.g. .esp/.esm/.esl patches buried inside zipped
    // archives). Edited directly on the Archive Finder page itself (its own Save & Rescan flow),
    // not the Settings page -- read/written fresh per request, no restart needed, since changing
    // this only ever triggers a rescan, never anything server-startup-related.
    archiveFinderExtensions: ['.esp'],
    // Merge Plugins (The Forge, lib/merge-engine.js): optional default output destination for a
    // merged plugin -- pre-fills the Output folder picker, same "blank is fine, not required"
    // treatment as archiveFinderOutputDir above (never the Skyrim Data folder -- enforced in
    // web/merge-routes.js, not just a UI default).
    mergeOutputDir: null,
    // Merge Plugins' own staging-folder auto-copy (2026-08-25) -- a SEPARATE destination from
    // mergeOutputDir above, decoupled on purpose: mergeOutputDir is where the merge's own working
    // files live (the .esp itself, map.json/fidCache.json, the merge log -- lib/merge-v2-worker.js's
    // own output), while this is specifically "where does the FINISHED merged plugin land so Vortex
    // adopts it as its own mod." Today the user has to point mergeOutputDir itself at a spot inside
    // staging for Vortex to ever see the result (see mergeOutputDir's own comment above, "so Vortex
    // can pick up the merged plugin as its own mod") -- this makes that a real, separate, optional
    // step instead: when set, web/merge-routes.js copies (never moves -- mergeOutputDir stays the
    // source of truth, same read-only relationship eslifierOutputDir below has to ITS folder) the
    // finished .esp here right after a successful build. Same "blank is fine, not required"
    // treatment as eslifierOutputDir/mergeOutputDir -- inert until set, never blocks Save. A path
    // field, so changing it requires a restart.
    mergeStagingCopyDir: null,
    // Cycle Helper's Change History (2026-08-18, lib/cycle-helper-history.js): where its growing set
    // of per-session fix-log files is written. Same "blank is fine, not required" treatment as
    // mergeOutputDir/archiveFinderOutputDir above, but with a real built-in default when unset
    // (config/cycle-helper-history/) rather than staying blank -- lib/cycle-helper-history.js's own
    // getHistoryDir() applies that fallback, same pattern as getLogsDir()'s own logsDir fallback
    // below.
    cycleHelperHistoryDir: null,
    // Merge Plugins' own "Merge Settings" (2026-08-17, inspired by zEdit-Revised's zMerge panel of
    // the same name) -- what happens to the SOURCE plugins that were just merged, once the build
    // succeeds. 'disable' (default): sets them disabled directly in Plugins.txt -- per-PLUGIN, not
    // per-mod (see lib/missing-masters-scan.js's disablePluginsInPluginsTxt for why Vortex's own
    // modState LevelDB write is the wrong mechanism for this). 'remove': delete the merged plugin
    // FILES themselves from staging (never the rest of that mod's own folder -- meshes/textures/etc
    // stay). 'backup-remove': same removal, but each file is copied to a new "Backup" folder created
    // next to the merge output first. Read fresh per merge (web/merge-routes.js's own /merge route),
    // not restart-required -- same treatment as downloadMissingArchives/missingMastersRecognizeEslifier.
    // Not a path field, so NOT in settings-routes.js's PATH_FIELDS.
    mergePostMergeAction: 'disable',
    // ESLifier awareness (lib/missing-masters-scan.js): the user's configured ESLifier output
    // folder -- ESLifier is a separate third-party tool that shrinks eligible plugins to the ESL
    // format and re-deploys them from its own staging subfolder, which Missing Masters would
    // otherwise misread as a real "different mod" name collision (confirmed real 2026-07-29 via a
    // live vortex.deployment.json case). Optional/blank is a supported state, same treatment as
    // archiveFinderOutputDir -- the feature is simply inert until it's set, never blocks Save. A
    // path field, so changing it requires a restart.
    eslifierOutputDir: null,
    // Missing Masters scan option: when true and eslifierOutputDir is set, a master whose active
    // alternate truly deployed from that folder is downgraded from a critical "name collision" to a
    // soft, muted acknowledgment instead (see missing-masters-routes.js/missing-masters-app.js).
    // ON by default -- the swap is virtually always intentional once ESLifier is in the picture. Not
    // a path field: read fresh per scan, no restart needed, same convention as
    // downloadMissingArchives -- but unlike that one, this is toggled directly on the Missing
    // Masters page itself (its own dedicated route), not the Settings page.
    missingMastersRecognizeEslifier: true,
    // Mod Exceptions list (lib/mod-exception-store.js): folder where the "never auto-fix this
    // mod" data file lives -- shared between Rebuild Collection and Rebuild Missing Files. REQUIRED,
    // no built-in-default fallback, same standing rule as cleanupExcludeListDir/skyrimDataDir/etc.
    // A path field like staging/downloads, so changing it requires a restart.
    modExceptionListDir: null,
    // Update Collection v2's own small per-collection tracking files (2026-09-01, director's own
    // explicit correction) -- a pre-update collection.json backup snapshot and the
    // "did this tool's own last apply on this collection finish clean" record (ucv2-apply-status.json)
    // used to live INSIDE the collection's own Vortex staging folder, right next to the mod author's
    // real collection.json. Director's own catch: that's a real, live risk -- Vortex owns that folder,
    // and a user updating the SAME collection through Vortex's own native flow (not this tool) can
    // freely replace or clear its contents, silently destroying this tool's own tracking data with
    // zero warning. One folder per collection (keyed by the collection's own Nexus modId, stable
    // across a staging-folder rename) is created underneath this root. REQUIRED, no built-in-default
    // fallback, same standing rule as cleanupExcludeListDir/skyrimDataDir/etc. -- every new data
    // location this project adds must be a user-chosen path, never a silent built-in default.
    ucv2TrackingDir: null,
    // PGPatcher Load Order Editor (docs/plans/2026-08-19-pgpatcher-load-order-tool.md): the folder
    // containing PGPatcher's own modrules.json/settings.json (e.g. "D:\Games\Skyrim SE\PGPatcher\
    // cfg"). Unlike cleanupExcludeListDir/skyrimDataDir/etc., NOT in settings-routes.js's
    // REQUIRED_PATH_FIELDS -- this is a single, brand-new, one-workflow integration; making it
    // globally required would block saving ANY other setting for every install that never touches
    // PGPatcher. Blank is a supported state, same as archiveFinderOutputDir/mergeOutputDir below --
    // the PGPatcher tool itself reports "not configured yet" when this is blank. The tool's own
    // SOURCE (Vortex deployment / game Data folder) deliberately
    // reuses `skyrimDataDir` above rather than a second new field -- it's the exact same folder
    // Missing Masters already asks for. The real PGPatcher OUTPUT folder and which shader
    // patchers are active are deliberately NOT separate settings either -- both are read fresh, on
    // each request, straight from this folder's own settings.json (params.output.dir /
    // params.shaderpatcher.*) so they can never drift out of sync with whatever the director's real
    // PGPatcher GUI is actually configured to do (see web/pgpatcher-routes.js).
    pgpatcherCfgDir: null,
    // Optional -- if set, /build (web/pgpatcher-routes.js) moves the existing PGPatcher output
    // folder's contents into a dated subfolder here before a real build ever touches it. pgtools.exe
    // itself deletes the existing output before doing real work (same as the real GUI); if a build
    // then crashes/hangs/gets killed partway through, the user's prior output is otherwise just gone
    // with no way back. Same "blank is a supported state" treatment as pgpatcherCfgDir above -- no
    // backup step at all until the user opts in, which is today's exact behavior.
    pgpatcherOutputBackupDir: null,
    // Save Cleaner (design/mockup-save-cleaner.html) -- wraps the bundled ReSaver_Renewed.exe.
    // Skyrim SE: where the real save files (.ess + paired .skse) live. Auto-detected on first Settings
    // load (web/settings-routes.js checks the OS-standard "Documents\My Games\Skyrim Special
    // Edition\Saves" location) but always user-editable/overridable after that -- same "blank is a
    // supported state, never a silent built-in default actually used without the user seeing it"
    // rule as every other path field here.
    saveCleanerSavesDir: null,
    // Fallout 4: where the real save files (.fos + paired .fo4se) live. Same auto-detect and
    // configuration as saveCleanerSavesDir, but for Fallout 4 saves instead of Skyrim.
    saveCleanerSavesDirFO4: null,
    // Where automatic backups of a Skyrim save (taken before Save/Save As ever overwrites or replaces
    // anything) are written -- deliberately NEVER the Saves folder itself (ReSaver's own default
    // behavior drops timestamped copies right next to your real saves; the director's own call,
    // per the mockup, was to keep that folder clean and give backups the same Restore + keep-N
    // treatment Vortex Database Backups already has). Blank is a supported state -- Save/Save As
    // both still work without a configured backup folder, just without a safety copy first.
    saveCleanerBackupRoot: null,
    // Where automatic backups of a Fallout 4 save are written. Same convention as
    // saveCleanerBackupRoot but for Fallout 4 saves instead of Skyrim.
    saveCleanerBackupRootFO4: null,
    // Starfield: where the real save files (.sfs + paired .sfse) live. Same auto-detect and
    // configuration as saveCleanerSavesDir, but for Starfield saves.
    saveCleanerSavesDirStarfield: null,
    // Where automatic backups of a Starfield save are written. Same convention as
    // saveCleanerBackupRoot but for Starfield saves.
    saveCleanerBackupRootStarfield: null,
    // Same "null = unlimited, no 0-off state" shape as maxStateBackupsToKeep above (these backups
    // aren't optional the way Rebuild Collection's mod-folder ones are -- a save file is far more
    // valuable to a real playthrough than a re-extractable mod folder). Mockup's own Settings
    // screen suggests 10 as a starting value; that's a UI placeholder, not baked in here.
    // Applied to Skyrim, Fallout 4, and Starfield saves.
    maxSaveCleanerBackupsToKeep: null,
    // File Retriever (2026-09-01): remembers the last folder the user downloaded files to, so the
    // destination field pre-fills on the next visit instead of starting blank every time. Same
    // "blank is a supported state, pre-fills a picker but never blocks the action" treatment as
    // archiveFinderOutputDir/mergeOutputDir above -- but unlike EVERY other field in this file, this
    // one deliberately has NO Settings-page UI element at all (director's own explicit call): it's a
    // silently-remembered convenience value the tool itself manages on every use (see
    // web/file-retriever-routes.js's own /premium-status and /remember-destination), not something
    // the user configures up front. Not restart-required -- read/written fresh per request, same as
    // archiveFinderOutputDir/mergeOutputDir.
    fileRetrieverLastDestFolder: null,
};

function loadConfig() {
    let onDisk = {};
    try {
        onDisk = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch {
        // No config.json yet (fresh install) or it's unreadable/corrupt -- defaults cover it either
        // way; this is a normal, expected first-run state, not an error worth surfacing.
    }
    return { ...DEFAULT_CONFIG, ...onDisk };
}

function saveConfig(partial) {
    const merged = { ...loadConfig(), ...partial };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2));
    return merged;
}

// Resolves a specific tool's actual logs directory. `toolSubdir` names that tool's own subfolder
// (e.g. 'rebuild-collection') -- only used when a custom logsDir root is configured, so the
// default (unconfigured) case stays exactly as it's always been: a single flat logs/ folder next
// to this project's own files, no migration needed for anyone upgrading. Any new tool that starts
// writing logs in the future should call this with its own subdir name (see TECHNICAL.md).
function getLogsDir(toolSubdir) {
    const { logsDir } = loadConfig();
    return logsDir ? path.join(logsDir, toolSubdir) : path.join(__dirname, '..', 'logs');
}

// The configured root itself (or the same built-in default), for Settings' "Open Logs Folder" /
// "Delete all logs" actions, which operate on the whole logs area rather than one tool's subfolder.
function getLogsRoot() {
    const { logsDir } = loadConfig();
    return logsDir || path.join(__dirname, '..', 'logs');
}

module.exports = { CONFIG_PATH, DEFAULT_CONFIG, loadConfig, saveConfig, getLogsDir, getLogsRoot };
