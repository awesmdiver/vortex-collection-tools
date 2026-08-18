'use strict';
// A per-mod "never auto-fix this one" exception list -- SHARED between Rebuild Collection and
// Rebuild Missing Files (queue: rebuild-missing-hand-pick-exceptions). Mirrors
// cleanup-exclude-store.js's own load/save shape: a plain JSON file in a user-chosen folder
// (config.json's modExceptionListDir, no built-in default -- same standing rule as every other
// new data location this project adds, see cleanupExcludeListDir's own comment in app-config.js).
//
// Real case this exists for (director's own live example): "1DustAdeptArmorSE", a hand-pick-only
// FOMOD (the user deliberately installs a SUBSET of what the archive contains). Auto-extracting/
// auto-rebuilding the full archive for a mod like this doesn't restore what's "missing" -- it
// installs content the user never chose, which can cause missing masters or crashes. Rare, but
// real and destructive, so this needs an explicit, persistent opt-out.
//
// IDENTITY: matches by mod NAME (case-insensitive/trimmed) and, when available, by the mod's
// Nexus modId ALONE -- deliberately NOT fileId, and deliberately NOT this codebase's own
// identityKeys()/makeIdentityMatcher (vortex-sync/lib.js). That primitive's top-priority keys
// (content hash, then modId+fileId as a single compound key) are pinned to one specific archive
// version -- exactly wrong here, since a hand-pick-only FOMOD's installer shape is a property of
// the MOD, not of one release: it stays hand-pick across updates, so the exception must survive a
// fileId change too. A mod matches this list if EITHER its modId equals an entry's modId, OR its
// name (trimmed/lowercased) equals an entry's name -- whichever is available; an off-site mod (no
// modId) can only ever match by name. Two different mods sharing a display name could in theory
// collide on the name branch -- a real but rare risk, and a much smaller cost than silently NOT
// excepting a genuinely destructive auto-rebuild (removable in one click from the Reports tab if
// it ever happens).

const fs = require('fs');
const path = require('path');

const FILE_NAME = 'mod-exceptions.json';

function normalizeName(name) {
    return (name || '').trim().toLowerCase();
}

function filePath(dir) {
    return path.join(dir, FILE_NAME);
}

function load(dir) {
    if (!dir) return { mods: [] };
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath(dir), 'utf8'));
        return { mods: Array.isArray(parsed.mods) ? parsed.mods : [] };
    } catch {
        // No file yet (nothing excepted so far) or it's unreadable/corrupt -- an empty list covers
        // both, same as cleanup-exclude-store.js's own "no config yet" read convention.
        return { mods: [] };
    }
}

function save(dir, data) {
    if (!dir) {
        throw new Error('No exception list folder is set. Choose one under Settings first.');
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath(dir), JSON.stringify(data, null, 2));
}

// Builds a plain (source) => boolean matcher from a loaded list -- `source` is a collection.json
// mod's own `source` field ({modId, fileId, ...}) paired with its `name`, same shape classifyMod()
// already receives as `mod`. Loaded ONCE per scan/rebuild batch (not once per mod), same "read
// fresh per request, not per item" convention as ignoredMatchers in rebuild-missing-routes.js.
function makeExceptionMatcher(dir) {
    const { mods } = load(dir);
    if (mods.length === 0) return () => false;
    const byModId = new Map(mods.filter((m) => m.modId != null).map((m) => [m.modId, m]));
    const byName = new Map(mods.map((m) => [normalizeName(m.name), m]));
    return (mod) => {
        const modId = mod?.source?.modId;
        if (modId != null && byModId.has(modId)) return true;
        return byName.has(normalizeName(mod?.name));
    };
}

module.exports = { load, save, makeExceptionMatcher, normalizeName, FILE_NAME };
