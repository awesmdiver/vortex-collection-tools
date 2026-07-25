'use strict';
// Persists "I manually obtained this off-site mod's archive and pointed the tool at it" associations
// via the Plan/log-view/Work Through Report "Import" button, keyed by collection + mod name (off-site
// mods -- source.type 'browse'/'direct'/'bundle' -- have no Nexus modId/fileId at all). Read on EVERY
// future plan/rebuild for that collection, not just the run where Import was clicked -- confirmed
// with the user this must survive indefinitely (import today, re-run next week/month, never
// re-import), same "small JSON file, no database" convention as work-through-state.js.

const fs = require('fs');
const path = require('path');

const STATE_PATH = path.join(__dirname, '..', 'offsite-import-map.json');

function loadMap() {
    try {
        return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    } catch {
        return {};
    }
}

function saveMap(map) {
    fs.writeFileSync(STATE_PATH, JSON.stringify(map, null, 2));
    return map;
}

function getImportedFilename(collectionModId, modName) {
    return loadMap()[collectionModId]?.[modName] || null;
}

function setImportedFilename(collectionModId, modName, filename) {
    const map = loadMap();
    if (!map[collectionModId]) map[collectionModId] = {};
    map[collectionModId][modName] = filename;
    return saveMap(map);
}

// Not currently wired to any UI action -- kept available for a future "undo/re-import" control
// rather than left as a TODO, since the shape (per-collection, per-mod-name) is already exactly
// right for it.
function clearImportedFilename(collectionModId, modName) {
    const map = loadMap();
    if (map[collectionModId]) {
        delete map[collectionModId][modName];
        if (Object.keys(map[collectionModId]).length === 0) delete map[collectionModId];
    }
    return saveMap(map);
}

module.exports = { STATE_PATH, loadMap, getImportedFilename, setImportedFilename, clearImportedFilename };
