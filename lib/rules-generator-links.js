'use strict';
// The link list: which mod in the MAIN collection matches which mod in the player's NEW collection
// (a 4K upgrade of a 2K mod, a 2K of a 1K, any pair), saved per pair of collections the moment
// Rules Generator applies a pair. Other tools read it (getLinks) and keep it true as the main
// collection updates (followMainUpdate) -- e.g. to find the upgrades whose main mod was dropped.
//
// Matching is NOT redone here: the links come straight from analyzeCollections' own mapping (the
// explicit link rule the player set, or a remembered pick) plus findNewCollectionCounterpart's
// rule (same Nexus mod page + names that resemble each other). No "2K"/"4K" token is ever read --
// normalizeModName already strips every size token, so any size pair works.
//
// One small JSON file per pair under App Data's rules-generator folder, named from both
// collections' stable ids (the Nexus slug when Vortex has it, else the Vortex key) -- never from a
// display name, so a collection renamed on Nexus keeps its list.

const fs = require('fs');
const path = require('path');
const appConfig = require('./app-config');
const rg = require('./rules-generator');

const FILE_VERSION = 1;

function getLinksDir() {
  return appConfig.resolveDataDir('rules-generator', path.join(__dirname, '..', 'config'));
}

function collectionId(entry, fallbackKey) {
  return String((entry && entry.collectionSlug) || fallbackKey);
}

// Filesystem-safe, stable id for a pair: main first, then new.
function pairIdFor(modIndex, mainCollectionKey, newCollectionKey) {
  const clean = (s) => String(s).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return `${clean(collectionId(modIndex.get(mainCollectionKey), mainCollectionKey))}__${clean(collectionId(modIndex.get(newCollectionKey), newCollectionKey))}`;
}

function filePathFor(pairId, dir) {
  return path.join(dir || getLinksDir(), `rules-generator-links-${pairId}.json`);
}

// Stable identity of one mod: Nexus mod page + file + content hash when known, name and version
// for display. modKey is kept too (the key Vortex uses for it right now).
function identityOf(entry) {
  return {
    modKey: entry.modKey,
    modId: entry.modId != null ? String(entry.modId) : null,
    fileId: entry.fileId != null ? String(entry.fileId) : null,
    fileMD5: entry.fileMD5 || null,
    name: rg.displayName(entry),
    version: entry.version || null,
  };
}

function readFile(pairId, dir) {
  try {
    const data = JSON.parse(fs.readFileSync(filePathFor(pairId, dir), 'utf8'));
    return Array.isArray(data.links) ? data : null;
  } catch {
    return null;
  }
}

function getLinks(pairId, { dir } = {}) {
  const data = readFile(pairId, dir);
  return data ? data.links : [];
}

function countLinks(pairId, opts) {
  return getLinks(pairId, opts).length;
}

function writeFile(pairId, data, dir) {
  const p = filePathFor(pairId, dir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

// What the matching can say about a pair. `sure` links are saved as-is; `needsConfirm` rows are
// shown to the player and saved only once picked. Never saves a guess.
//  - mapping (analyzeCollections): foundVia 'link-rule'.
//  - a new mod with no rule link but exactly one main mod on the same Nexus page with a matching
//    name: foundVia 'counterpart' (the same two tests findNewCollectionCounterpart uses).
//  - several main mods fit, or the same page with a name that does not match: needsConfirm.
function collectLinks(modIndex, analysis) {
  const sure = [];
  const needsConfirm = [];
  const mainKeys = analysis.oldMembers.map((m) => m.modKey);
  const mainKeySet = new Set(mainKeys);

  for (const m of analysis.mapping) {
    const mainEntry = modIndex.get(m.oldModKey);
    const newEntry = modIndex.get(m.newModKey);
    if (!mainEntry || !newEntry) continue;
    sure.push({ main: identityOf(mainEntry), new: identityOf(newEntry), foundVia: 'link-rule' });
  }

  for (const a of analysis.anomalies) {
    const newEntry = modIndex.get(a.modKey);
    if (!newEntry) continue;
    needsConfirm.push({
      reason: 'ambiguous',
      new: identityOf(newEntry),
      candidates: a.candidates
        .map((c) => modIndex.get(c.targetKey))
        .filter(Boolean)
        .map(identityOf),
    });
  }

  for (const nl of analysis.noLinkFound) {
    const newEntry = modIndex.get(nl.modKey);
    if (!newEntry || newEntry.modId == null) continue;
    const samePage = mainKeys
      .map((k) => modIndex.get(k))
      .filter((e) => e && e.modId != null && String(e.modId) === String(newEntry.modId) && mainKeySet.has(e.modKey));
    if (samePage.length === 0) continue;
    const nameOk = samePage.filter((e) => rg.namesLikelyMatch(rg.displayName(newEntry), rg.displayName(e)));
    if (nameOk.length === 1) {
      sure.push({ main: identityOf(nameOk[0]), new: identityOf(newEntry), foundVia: 'counterpart' });
    } else {
      needsConfirm.push({
        reason: nameOk.length > 1 ? 'ambiguous' : 'no-name-match',
        new: identityOf(newEntry),
        candidates: (nameOk.length > 1 ? nameOk : samePage).map(identityOf),
      });
    }
  }

  return { sure, needsConfirm };
}

// Writes links for a pair. Existing links stay; one with the same (main, new) mod keys is replaced.
// Returns the number of links the file holds afterwards.
function saveLinks(pairInfo, links, { dir, now = new Date() } = {}) {
  const existing = readFile(pairInfo.pairId, dir);
  const byKey = new Map();
  const keyOf = (l) => `${l.main.modKey}::${l.new.modKey}`;
  for (const l of existing ? existing.links : []) byKey.set(keyOf(l), l);
  const savedAt = now.toISOString();
  for (const l of links) byKey.set(keyOf(l), { ...l, savedAt });
  const data = {
    version: FILE_VERSION,
    pairId: pairInfo.pairId,
    mainCollection: pairInfo.mainCollection,
    newCollection: pairInfo.newCollection,
    updatedAt: savedAt,
    links: [...byKey.values()],
  };
  writeFile(pairInfo.pairId, data, dir);
  return data.links.length;
}

function pairInfoFor(modIndex, mainCollectionKey, newCollectionKey) {
  const describe = (key) => ({ id: collectionId(modIndex.get(key), key), key, name: rg.displayName(modIndex.get(key)) });
  return {
    pairId: pairIdFor(modIndex, mainCollectionKey, newCollectionKey),
    mainCollection: describe(mainCollectionKey),
    newCollection: describe(newCollectionKey),
  };
}

// Called after a successful Apply (never on a read-only run). Saves the links the matching is
// sure about. Best effort: a failure here must never fail the Apply that already wrote to Vortex.
function saveFromApply(modIndex, analysis, mainCollectionKey, newCollectionKey, opts) {
  try {
    const { sure } = collectLinks(modIndex, analysis);
    if (sure.length === 0) return 0;
    return saveLinks(pairInfoFor(modIndex, mainCollectionKey, newCollectionKey), sure, opts);
  } catch (e) {
    console.warn(`[rules-generator-links] couldn't save the link list: ${e.message}`);
    return 0;
  }
}

// "Save the links for this pair". Without `confirmed` it only reports (nothing written). With it,
// saves the sure links plus each confirmed pick -- a pick counts only if it names a candidate the
// matching itself offered for that new mod (the client's list is never trusted).
// confirmed: [{ newModKey, mainModKey }]
function scanOrSave(modIndex, analysis, mainCollectionKey, newCollectionKey, { save = false, confirmed = [], dir, now } = {}) {
  const { sure, needsConfirm } = collectLinks(modIndex, analysis);
  const info = pairInfoFor(modIndex, mainCollectionKey, newCollectionKey);
  if (!save) {
    return { pairId: info.pairId, sureCount: sure.length, needsConfirm, linksSaved: countLinks(info.pairId, { dir }) };
  }
  const picked = [];
  for (const c of confirmed) {
    const row = needsConfirm.find((r) => r.new.modKey === c.newModKey);
    const cand = row && row.candidates.find((x) => x.modKey === c.mainModKey);
    if (cand) picked.push({ main: cand, new: row.new, foundVia: 'confirmed' });
  }
  const linksSaved = saveLinks(info, [...sure, ...picked], { dir, now });
  const left = needsConfirm.filter((r) => !picked.some((p) => p.new.modKey === r.new.modKey));
  return { pairId: info.pairId, sureCount: sure.length, confirmedCount: picked.length, needsConfirm: left, linksSaved };
}

// Keeps the links true when the main collection updates.
//   mainChanges.currentMods: main's own current list of mods, [{ modKey, modId, fileId, fileMD5, name, version }]
//   (the collection's own list -- never what Vortex shows for an old mod, which a half-finished
//   removal leaves wrong).
// A link whose main mod is still listed stays. If it is not listed but the same Nexus page has a
// listed mod with a matching name, the link MOVES to that file (main only updated it). Same page
// but no name match goes to `unsure`; nothing on the page (or no page to follow) goes to `gone`.
// Moved links are saved; gone and unsure links are left in the file for the caller to deal with.
function followMainUpdate(pairId, mainChanges, { dir, save = true, now = new Date() } = {}) {
  const data = readFile(pairId, dir);
  const result = { moved: [], gone: [], unsure: [], kept: 0 };
  if (!data) return result;
  const current = (mainChanges && mainChanges.currentMods) || [];
  const byKey = new Map(current.map((m) => [m.modKey, m]));

  for (const link of data.links) {
    const main = link.main;
    if (byKey.has(main.modKey)) {
      const listed = byKey.get(main.modKey);
      // Same key but a different file (re-installed under one key): follow it quietly.
      if (listed.fileId != null && main.fileId != null && String(listed.fileId) !== String(main.fileId)) {
        result.moved.push({ link, from: { ...main }, to: toIdentity(listed) });
        link.main = toIdentity(listed);
        link.movedAt = now.toISOString();
      } else {
        result.kept += 1;
      }
      continue;
    }
    const page = main.modId != null
      ? current.filter((m) => m.modId != null && String(m.modId) === String(main.modId))
      : [];
    if (page.length === 0) {
      result.gone.push(link);
      continue;
    }
    const nameOk = page.filter((m) => rg.namesLikelyMatch(main.name, m.name));
    if (nameOk.length === 1) {
      result.moved.push({ link, from: { ...main }, to: toIdentity(nameOk[0]) });
      link.main = toIdentity(nameOk[0]);
      link.movedAt = now.toISOString();
    } else {
      result.unsure.push(link);
    }
  }

  if (save && result.moved.length > 0) {
    data.updatedAt = now.toISOString();
    writeFile(pairId, data, dir);
  }
  return result;
}

function toIdentity(m) {
  return {
    modKey: m.modKey,
    modId: m.modId != null ? String(m.modId) : null,
    fileId: m.fileId != null ? String(m.fileId) : null,
    fileMD5: m.fileMD5 || null,
    name: m.name || m.modKey,
    version: m.version || null,
  };
}

// Takes a link out of the list (the caller decided it is finished with, e.g. the upgrade was removed).
function removeLink(pairId, mainModKey, newModKey, { dir } = {}) {
  const data = readFile(pairId, dir);
  if (!data) return false;
  const before = data.links.length;
  data.links = data.links.filter((l) => !(l.main.modKey === mainModKey && l.new.modKey === newModKey));
  if (data.links.length === before) return false;
  data.updatedAt = new Date().toISOString();
  writeFile(pairId, data, dir);
  return true;
}

module.exports = {
  pairIdFor,
  pairInfoFor,
  identityOf,
  collectLinks,
  saveLinks,
  saveFromApply,
  scanOrSave,
  getLinks,
  countLinks,
  followMainUpdate,
  removeLink,
};
