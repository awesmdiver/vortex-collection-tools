'use strict';
// Real, current Full/Light plugin-slot counts across the WHOLE load order -- built for the Merge
// Plugins Done screen (2026-08-24, merge-light-slot-budget) so it can tell the director how many
// load-order slots a merge actually frees up, not just whether this one merged file qualifies.
//
// A genuinely different number from the per-plugin new-record limit lib/esp-light-flag.js already
// checks (that one asks "does THIS plugin's own FormID range fit under 4,096?"). This one is
// Skyrim's separate, system-wide budget: every ACTIVE plugin takes one load-order byte (000-FD,
// 254 total) UNLESS it's Light-flagged (FE, an ESL/ESPFE), in which case it instead shares that
// single FE slot, sub-indexed 0-4095. Confirmed against the director's own real Vortex status bar
// (2026-08-24): "Active 4348 - Full: 247/254 - Light: 4101/4096" -- he was actually 5 over the
// light-plugin budget at the time, a real, live problem this app previously had no way to surface.
//
// Reuses the SAME "which plugin is truly active right now" ground truth Missing Masters and Merge
// Plugins' own master-dependency check already rely on (lib/missing-masters-scan.js's
// scanDataFolder/readPluginsTxt/computeActiveSet) -- not a second, possibly-drifting
// re-implementation. That's also why this matches Vortex's own status bar: Vortex derives its
// Active/Full/Light counts from the exact same ground truth (Plugins.txt + the real Data folder
// listing), so reusing it here is what makes the two numbers agree rather than a coincidence.
//
// Light classification matches Vortex's own real logic exactly, not just the header flag bit --
// confirmed by reading Vortex's own source (F:\Claude Workspace\vortex-tools\Vortex\extensions\
// gamebryo-plugin-management\src\index.ts's own `isLight`): `flag || extname === '.esl'`. A plugin
// counts as Light if EITHER its header's Light Master bit is set OR it simply has a `.esl` file
// extension -- confirmed necessary, not theoretical: an initial flag-bit-only version of this module
// undercounted the director's own real Light total by exactly 1 (and overcounted Full by 1, same
// total either way) against his live Vortex status bar, traced to a real `.esl` file in his own load
// order whose header flag bit isn't actually set. Missing this fallback would silently disagree with
// Vortex's own numbers on any setup with a plugin like that.

const path = require('path');
const { scanDataFolder, readPluginsTxt, computeActiveSet } = require('./missing-masters-scan');
const { readPluginHeader, FLAG_LIGHT_MASTER } = require('./esp-header');

const FULL_LIMIT = 254;
const LIGHT_LIMIT = 4096;

// { skyrimDataDir, pluginsListDir } -- same config fields every other real-load-order feature in
// this app already requires (Missing Masters, Merge Plugins' master-dependency check).
// Returns { full, fullLimit, light, lightLimit }.
function countActivePluginSlots({ skyrimDataDir, pluginsListDir }) {
    const pluginsTxtPath = path.join(pluginsListDir, 'Plugins.txt');
    const filesOnDisk = scanDataFolder(skyrimDataDir);
    const pluginsTxt = readPluginsTxt(pluginsTxtPath);
    const active = computeActiveSet(filesOnDisk, pluginsTxt);

    let full = 0;
    let light = 0;
    for (const [key, info] of filesOnDisk) {
        if (!active.has(key)) continue;
        // Ghosted files are already excluded via `active` above, so actualFileName here is never
        // the ".ghost"-suffixed name -- its own real extension is what Vortex's own isLight checks.
        const isEslExtension = path.extname(info.actualFileName).toLowerCase() === '.esl';
        let header;
        try {
            header = readPluginHeader(path.join(skyrimDataDir, info.actualFileName));
        } catch {
            continue; // unreadable/moved since the listing was taken -- skip, don't count or crash
        }
        if (!header) continue; // not a valid TES4 record -- same tolerant-skip convention as elsewhere
        if ((header.flags & FLAG_LIGHT_MASTER) || isEslExtension) light++;
        else full++;
    }

    return { full, fullLimit: FULL_LIMIT, light, lightLimit: LIGHT_LIMIT };
}

module.exports = { countActivePluginSlots, FULL_LIMIT, LIGHT_LIMIT };
