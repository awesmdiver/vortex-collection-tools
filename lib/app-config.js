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
    // Server bind settings -- read once at process startup (web/server.js), so changing any of
    // these needs a restart just like the path fields above. serverHost defaults to loopback-only:
    // this server has no authentication (see server.js's own header comment), so binding anything
    // other than 127.0.0.1/localhost exposes full filesystem/mod-state control to the network.
    serverPort: 4321,
    serverHost: '127.0.0.1',
    autoOpenBrowser: true,
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

module.exports = { CONFIG_PATH, DEFAULT_CONFIG, loadConfig, saveConfig };
