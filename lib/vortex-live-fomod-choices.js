'use strict';
// Shared "does this mod already have a real FOMOD choice, anywhere" check -- extracted 2026-09-17
// ("Open FOMOD mods get an Install button") from lib/update-collection-v2-runner.js, which already
// had this working out exactly right (2026-09-01, "CORRECTED... for the fomod, if installed
// correctly, it's skipped in the clean-up phase"): Vortex's own live `attributes.installerChoices`
// is set the moment a real FOMOD wizard genuinely finishes, independent of whether a collection's
// own local collection.json ever captured a copy of it. Rebuild Collection's classifyMod() and
// Rebuild Missing Files' scanOneMod() only ever looked at collection.json's own recorded `choices` --
// so a mod the director already installed correctly through Vortex's own wizard (SDA Patch Hub SE,
// Ashe - Crystal Heart SE) still read as a genuine Open FOMOD, purely because THIS project's own
// collection.json snapshot never recorded it. This module is the ONE place that check now lives;
// lib/update-collection-v2-runner.js imports it back rather than keeping its own copy.
//
// Helper-first, no state.v2 fallback for this specific check -- deliberately matching Update
// Collection v2's own original scope exactly (it never had one either): `helperAvailable ?
// await helperClient.getAllMods() : null`. Vortex closed simply means this check can't run; every
// caller already has its own existing "no live data, use what collection.json/the archive say"
// fallback path for everything else, so this degrades the same way.

const syncLib = require('./vortex-sync/lib');
const helperClient = require('./vortex-helper-client');

// One entry per live-installed mod: {vortexModId, fileMD5, tag, modId, fileId}, fed into
// vortex-sync/lib.js's own makeIdentityMatcher -- the SAME identity-matching primitive every other
// live/collection.json cross-reference in this project already uses.
function buildLiveIdentityIndex(mods) {
    const refs = Object.keys(mods).map((vortexModId) => {
        const attrs = mods[vortexModId].attributes || {};
        return { vortexModId, fileMD5: attrs.fileMD5, tag: attrs.referenceTag, modId: attrs.modId, fileId: attrs.fileId };
    });
    return syncLib.makeIdentityMatcher(refs);
}

// sourceLike: a collection.json mod's own `source` object ({md5, tag, modId, fileId, ...}).
// Returns the real, live Vortex modId (the mods###<gameId>###<modId> key) or null.
function resolveLiveModId(matcher, sourceLike) {
    const match = matcher(sourceLike);
    return match ? match.vortexModId : null;
}

// A `choices` value only counts as a real, usable FOMOD choice when it's genuinely fomod-typed AND
// has at least one real recorded option -- an empty/malformed value is the same as "nothing
// recorded" for every purpose this project uses `choices` for.
function isRealFomodChoices(choices) {
    return !!(choices && choices.type === 'fomod' && Array.isArray(choices.options) && choices.options.length > 0);
}

// Thin, mockable wrapper around the one real network call this module makes -- kept separate so
// scripts/test-*.js can mock `module.exports.loadLiveModsData` directly (this project's own
// established "reassign the exported property, not the bare local binding" convention) instead of
// reaching into helperClient itself. Never throws; a Helper hiccup here degrades to "no live data",
// same as every other live read in this project.
async function loadLiveModsData(helperAvailable) {
    if (!helperAvailable) return null;
    try {
        return await helperClient.getAllMods();
    } catch {
        return null;
    }
}

// The one entry point real callers use: given a collection's own mods array, returns a NEW array
// where any mod with NO real recorded choices of its own, but a real live Vortex
// attributes.installerChoices, has that live value substituted in as its own `choices` -- so
// classifyMod()/scanOneMod() (which only ever look at `mod.choices`) see it as if collection.json
// had recorded it correctly all along. A mod that already has its own real recorded choices is
// returned completely unchanged (never overwritten by a live value -- collection.json's own record,
// when it's real, is always trusted first, matching Update Collection v2's own original rule
// exactly). Falls through to the original `mods` array unchanged when live data isn't available at
// all (Helper unreachable) -- exactly Update Collection v2's own existing behavior for this check.
async function resolveEffectiveChoicesForMods(mods, { helperAvailable, liveModsData: preloaded } = {}) {
    const liveModsData = preloaded !== undefined ? preloaded : await loadLiveModsData(helperAvailable);
    if (!liveModsData || !liveModsData.mods) return mods;
    const matcher = buildLiveIdentityIndex(liveModsData.mods);
    return mods.map((mod) => {
        if (isRealFomodChoices(mod.choices)) return mod;
        const vortexModId = resolveLiveModId(matcher, mod.source);
        const liveMod = vortexModId ? liveModsData.mods[vortexModId] : null;
        const liveChoices = liveMod && liveMod.attributes && liveMod.attributes.installerChoices;
        if (isRealFomodChoices(liveChoices)) return { ...mod, choices: liveChoices, _liveInstallerChoices: true };
        return mod;
    });
}

// "Open FOMOD mods get an Install button" (2026-09-17): after a real Install action resolves and
// extracts a mod's files from a fresh picker answer, this saves the SAME choices back to Vortex's
// own live state -- so the mod is never asked about again, matching real Vortex's own behavior after
// its wizard finishes (installerChoices set on the mod, confirmed via IMod.ts) and Update Collection
// v2's own established convention for a newly-created mod (createMod's own attributes payload).
// Uses the ALREADY-existing, generic vortex-helper-client.js setModAttributes(modId, attributes) --
// no new Helper endpoint needed, since installerChoices is just another attribute on an
// already-registered mod. Never throws; returns a plain result object describing exactly what
// happened (or didn't), since a caller may want to log or surface this rather than silently
// swallow it:
//   { saved: true, vortexModId }
//   { saved: false, reason: 'helper-unavailable' }       -- Vortex isn't reachable right now
//   { saved: false, reason: 'no-live-match' }             -- Helper reachable, but this mod isn't a
//                                                             currently-registered live Vortex mod
//                                                             (e.g. never actually installed there)
//   { saved: false, reason: 'write-failed', message }     -- Helper reachable, mod found, but the
//                                                             real setModAttributes dispatch itself
//                                                             failed
async function savePicksToVortex(mod, choices, { helperAvailable, liveModsData: preloaded } = {}) {
    const liveModsData = preloaded !== undefined ? preloaded : await loadLiveModsData(helperAvailable);
    if (!liveModsData || !liveModsData.mods) return { saved: false, reason: 'helper-unavailable' };
    const matcher = buildLiveIdentityIndex(liveModsData.mods);
    const vortexModId = resolveLiveModId(matcher, mod.source);
    if (!vortexModId) return { saved: false, reason: 'no-live-match' };
    try {
        const ok = await helperClient.setModAttributes(vortexModId, { installerChoices: choices });
        return ok ? { saved: true, vortexModId } : { saved: false, reason: 'write-failed', message: 'Helper reported failure.' };
    } catch (e) {
        return { saved: false, reason: 'write-failed', message: e.message };
    }
}

module.exports = {
    buildLiveIdentityIndex, resolveLiveModId, isRealFomodChoices, loadLiveModsData, resolveEffectiveChoicesForMods,
    savePicksToVortex,
};
