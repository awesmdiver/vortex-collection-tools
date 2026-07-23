'use strict';
// Reads a Vortex collection.json and exposes lookup of a mod's source (for archive matching --
// see archive-locator.js) and recorded FOMOD choices (see choice-resolver.js).

const fs = require('fs');

function loadCollection(collectionJsonPath) {
    return JSON.parse(fs.readFileSync(collectionJsonPath, 'utf8'));
}

function findMod(collection, modName) {
    const mod = collection.mods.find((m) => m.name === modName);
    if (!mod) {
        const names = collection.mods.map((m) => m.name).join(', ');
        throw new Error(`Mod "${modName}" not found in collection. Available: ${names}`);
    }
    return mod;
}

module.exports = { loadCollection, findMod };
