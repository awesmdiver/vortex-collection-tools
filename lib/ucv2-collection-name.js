'use strict';
// The collection's own name (2026-10-24): an author can rename a collection on Nexus after it was installed. Vortex keeps the
// name it saw at install time in the collection record's customFileName (its own install writes only that attribute, from
// the Nexus name), so the list drifts from Nexus. An update writes the current Nexus name there, in the same call that
// writes the revision details, unless the person gave the collection a name of their own.

const clean = (s) => (typeof s === 'string' ? s.trim() : '');

// The name an update should write into Vortex, or null for "leave it".
//   nexusName: revision.collection.name just fetched. vortexName: the record's customFileName now.
//   recordedNexusName: the Nexus name this tool wrote or saw last time (the update record's nexusName), when it has one.
// A name that differs from what Nexus had last time is the person's own, and is never overwritten. With no earlier
// record there is no way to tell, so the Vortex name is taken to be the install-time Nexus name (what Vortex wrote).
function nameToWrite({ nexusName, vortexName, recordedNexusName }) {
    const nexus = clean(nexusName);
    if (!nexus) return null;
    const vortex = clean(vortexName);
    if (vortex === nexus) return null;
    const recorded = clean(recordedNexusName);
    if (vortex && recorded && vortex !== recorded) return null;
    return nexus;
}

// The one quiet line on the review when Nexus calls the collection something else than Vortex does.
function renameNote(nexusName, vortexName) {
    const nexus = clean(nexusName);
    if (!nexus || !clean(vortexName) || nexus === clean(vortexName)) return null;
    return `Now called ${nexus} on Nexus.`;
}

// THE name every screen shows (2026-10-24): what Vortex shows (the record's customFileName in the live mod list) until the update
// has written the new name; the new name once it has. The local collection.json's title and the revision's own name are
// never shown: they are Nexus's name, which flips from screen to screen when Nexus renamed the collection.
//   liveMods: the Bridge's mod list (mods map). Returns the Vortex name or null (Vortex did not answer / no custom name).
function vortexNameOf(liveMods, collectionModId) {
    const attrs = (liveMods && liveMods[collectionModId] && liveMods[collectionModId].attributes) || {};
    return clean(attrs.customFileName) || null;
}
// The collection with its liveName filled from the live list, when the earlier lookup did not have it.
function withLiveName(collection, liveMods) {
    if (!collection || clean(collection.liveName)) return collection;
    const live = vortexNameOf(liveMods, collection.modId);
    return live ? { ...collection, liveName: live } : collection;
}
function displayName({ vortexName, fallbackName, newName, written }) {
    if (written && clean(newName)) return clean(newName);
    return clean(vortexName) || clean(fallbackName) || '';
}

module.exports = { nameToWrite, renameNote, vortexNameOf, withLiveName, displayName };
