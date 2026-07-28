'use strict';
// Single source of truth for this project's persisted, user-editable settings -- staging/downloads/
// backup-root/state.v2 paths, the backup-before-rebuild toggle, and the Nexus API key. Everything
// here is personal-machine-specific (or a credential) and gitignored; config.example.json documents
// the shape with null placeholders so a fresh clone of this project has zero hardcoded paths baked
// into shipped source. Read/written by both the web UI (web/settings-routes.js) and the standalone
// terminal tools (lib/vortex-sync/lib.js, whose own CONFIG_PATH points here too -- see its header
// comment) so there is exactly one config file, never two that could drift out of sync.

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

// Whenever a field is added/removed/renamed below, also update the committed `config.example.json`
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
