'use strict';
// Finds the "mod root" -- the archive-internal folder that is the true root of the FOMOD install
// (the one directly containing "fomod\ModuleConfig.xml"). Some archives put this at the archive
// root; others nest it inside one or more extra containing folders -- confirmed this session with
// "Creation Club - Adjustments Rebalancing and Variants" (59370), whose real archive layout is
// "<archive-name>\<mod display name>\fomod\ModuleConfig.xml", not "fomod\ModuleConfig.xml" at the
// archive root. Every FOMOD-relative source path (in ModuleConfig.xml and, by extension, in the
// files this tool resolves) is relative to this root, not the archive root -- so it must be found
// and stripped/re-applied explicitly rather than assumed away.

function findModRoot(archiveEntries) {
    const matches = archiveEntries.filter(
        (e) => !e.isDir && /(^|[\\/])fomod[\\/]moduleconfig\.xml$/i.test(e.path)
    );
    if (matches.length === 0) {
        throw new Error('No "fomod/ModuleConfig.xml" found anywhere in the archive.');
    }
    if (matches.length > 1) {
        throw new Error(
            `Multiple "fomod/ModuleConfig.xml" found in the archive -- ambiguous, refusing to guess: ` +
            matches.map((m) => m.path).join(', ')
        );
    }
    const configPath = matches[0].path;
    // No leading-separator group when the config sits at the archive root (e.g. exactly
    // "fomod\ModuleConfig.xml", no containing folder) -- match won't find a separator to anchor
    // on in that case, so fall back to an empty prefix rather than crashing on a null match.
    const rootMatch = configPath.match(/^(.*)[\\/]fomod[\\/]moduleconfig\.xml$/i);
    const rootPrefix = rootMatch ? rootMatch[1] : '';
    return { configPath, rootPrefix };
}

// Cheap existence check reused by extract-mod.js/rebuild-mod.js to detect an "Open FOMOD" --
// a mod whose archive genuinely has a FOMOD installer wizard, but whose collection.json has NO
// recorded choices for it. Confirmed with the user this is a real, deliberate, normal pattern for
// a handful of mods in some collections (the collection author leaves the choice to whoever
// installs it, rather than pinning one answer) -- NOT a bug, and NOT something safe to
// auto-select defaults for, since there's no deterministic "correct" answer by design. Such a mod
// must be flagged for manual reinstall through Vortex's own FOMOD wizard, never extracted
// automatically.
function hasFomodInstaller(archiveEntries) {
    return archiveEntries.some((e) => !e.isDir && /(^|[\\/])fomod[\\/]moduleconfig\.xml$/i.test(e.path));
}

module.exports = { findModRoot, hasFomodInstaller };
