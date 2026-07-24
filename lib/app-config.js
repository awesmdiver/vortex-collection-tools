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
    state: null,
    // Single setting doing double duty: null = unlimited (back up every run, keep them all
    // forever); 0 = off (don't back up at all -- this is the default for a brand-new install,
    // explicit opt-in rather than an assumed safety net); 1-3 = back up every run, but prune down
    // to only the N most recent afterward. Anyone upgrading an existing config.json that already
    // has this set keeps their own saved value -- this default only applies before any config.json
    // exists at all.
    maxBackupsToKeep: 0,
    nexusApiKey: null,
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
