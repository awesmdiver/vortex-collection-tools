'use strict';
const { sortByVortexWalkOrder } = require('./vortex-file-order');

// Finds the "mod root" -- the archive-internal folder that is the true root of the FOMOD install
// (the one directly containing "fomod\ModuleConfig.xml"). Some archives put this at the archive
// root; others nest it inside one or more extra containing folders -- confirmed this session with
// "Creation Club - Adjustments Rebalancing and Variants" (59370), whose real archive layout is
// "<archive-name>\<mod display name>\fomod\ModuleConfig.xml", not "fomod\ModuleConfig.xml" at the
// archive root. Every FOMOD-relative source path (in ModuleConfig.xml and, by extension, in the
// files this tool resolves) is relative to this root, not the archive root -- so it must be found
// and stripped/re-applied explicitly rather than assumed away.

// Real Vortex rule, confirmed 2026-09-15 ("mods it couldn't check show up instead of hiding") by
// reading the actual install code, not assumed -- see config/vortex-source-refs.json's own
// "fomod-multi-config-selection" entry for the full citation trail. Vortex's own FOMOD install goes
// through the native `Nexus-Mods/fomod-installer` (C#) engine, not the Electron/TS side --
// `ModFormatManager.cs`'s `GetRequirements()`:
//     var fomodMatch = modFiles.FirstOrDefault(x => ScriptMatch(x, scriptFile));
// -- the FIRST fomod/ModuleConfig.xml in the FILE LIST wins, full stop. No depth/shallowest
// comparison, no sorting by name, and -- confirmed by reading the surrounding method -- NO
// ambiguous-case refusal exists anywhere in that code path either: it throws only when the loop
// finds ZERO matches (`!HasFoundScriptType`), never for finding more than one. An archive with two
// "fomod/ModuleConfig.xml" files (e.g. "Better Skyrim Parties", one at the archive root and a second
// inside "main patches\") is NOT a real Vortex-side ambiguity at all -- it's an entirely normal,
// silently-order-dependent pick Vortex already makes every time it installs that mod.
//
// REVISED 2026-09-16 ("pick a FOMOD installer in Vortex's exact file order"): "the file list" is
// NOT the archive's own internal listing order (7z's `-slt` order, what this project used at first).
// Vortex extracts the archive to a temp folder BEFORE it ever calls GetRequirements(), and builds
// `modFiles` by walking that real, on-disk folder --
// `src/renderer/src/extensions/mod_management/InstallManager.ts`'s `buildFileList()`, via
// `src/renderer/src/util/walk.ts`'s `walk()`. Confirmed by reading `walk()` directly: it lists one
// directory (`fs.readdirAsync`), adds every direct child (file or subfolder, as a bare path) to the
// list in THAT readdir order, then recurses into each subfolder ONE AT A TIME in that same order --
// each subfolder's entire subtree finishes before the next sibling subfolder even starts. So two
// candidates that diverge at a shared ancestor are ordered by whichever diverging SIBLING sorts
// first there, regardless of nesting depth -- a real, confirmed case: an archive with
// "00 Main\fomod\ModuleConfig.xml" AND a shallower "fomod\ModuleConfig.xml" at the archive root
// picks "00 Main"'s copy, because "00 Main" and "fomod" are ROOT-level siblings and "00 Main" sorts
// first in NTFS's own directory order (case-insensitive, digits-before-letters) -- despite its own
// match sitting one folder deeper. lib/vortex-file-order.js's `sortByVortexWalkOrder` replicates
// this ordering; see its own header comment for the NTFS-collation approximation it uses and why.
// Matched against Better Skyrim Parties (this project's own original real test case) before this
// revision shipped: its "fomod" root folder already sorted before its "main patches" folder either
// way, so the earlier archive-listing-order implementation happened to agree by coincidence -- this
// revision is required for the general case, not just that one archive.
//
// REVISED again 2026-09-16 (same task): the match rule itself was also too strict. Vortex's real
// ScriptMatch (ModFormatManager.cs):
//     Path.GetFileName(filePath).Contains(scriptFile, StringComparison.OrdinalIgnoreCase)
//         && Path.GetFileName(Path.GetDirectoryName(filePath))?.Contains(FomodRoot, ...) == true
// (scriptFile = "ModuleConfig.xml", FomodRoot = "fomod") -- the filename CONTAINS "ModuleConfig.xml"
// and the IMMEDIATE PARENT FOLDER's own bare name CONTAINS "fomod", both case-insensitive -- not an
// exact "fomod\ModuleConfig.xml" match. Widening to this exact rule was checked empirically before
// changing it, not assumed safe: a read-only pass over every real mod across all 22 of the director's
// real collection folders (4,362 mods) found the wider rule NEVER changes which file wins (0 cases)
// and only ever ADDS extra candidates that are backup/versioned copies of an already-real config
// sitting in the SAME folder (e.g. "ModuleConfig.xml~", "ModuleConfig.xml.1.1.OLD") -- and those
// always lose to the real "ModuleConfig.xml" anyway, by construction: a name that's the real
// filename PLUS a trailing suffix is always lexicographically greater than the real filename alone
// (a proper prefix always sorts first), so sortByVortexWalkOrder always still picks the genuine
// config even with these loose extra matches present. Widened rather than left narrow: it matches
// Vortex's own real, verified behavior exactly (this project's whole point), with no observed or
// structural downside.
function isFomodConfigCandidate(filePath) {
    const segs = filePath.split(/[\\/]/);
    const filename = segs[segs.length - 1];
    const parent = segs.length > 1 ? segs[segs.length - 2] : '';
    return filename.toLowerCase().includes('moduleconfig.xml') && parent.toLowerCase().includes('fomod');
}

function findModRoot(archiveEntries) {
    const matches = archiveEntries
        .filter((e) => !e.isDir)
        .map((e) => e.path)
        .filter(isFomodConfigCandidate);
    if (matches.length === 0) {
        throw new Error('No "fomod/ModuleConfig.xml" found anywhere in the archive.');
    }
    const configPath = sortByVortexWalkOrder(matches)[0];
    // rootPrefix = everything before the config's own immediate containing folder -- i.e. drop the
    // last two path segments (the filename, then its parent folder), whatever their real names
    // actually are. No longer regex-based against a literal "fomod" segment (the widened match above
    // means the real containing folder can be ANY name that merely contains "fomod", e.g.
    // "MyFomodStuff") -- computed by locating the last two path separators directly instead, which
    // also preserves the path's own original separator characters verbatim (no split/join
    // normalization), matching the previous regex-based extraction's own behavior exactly for every
    // case it already handled.
    const lastSep = Math.max(configPath.lastIndexOf('\\'), configPath.lastIndexOf('/'));
    const beforeParent = configPath.slice(0, lastSep);
    const secondLastSep = Math.max(beforeParent.lastIndexOf('\\'), beforeParent.lastIndexOf('/'));
    const rootPrefix = secondLastSep === -1 ? '' : configPath.slice(0, secondLastSep);
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
// Legacy "C# Script" FOMOD detection (item 13a, diagnostics/fomod-parity/findings-log.md,
// 2026-09-15). Real, current, shipped Vortex still supports this non-XML installer type --
// confirmed via the actual spawned process (`ModInstaller.IPC.csproj` project-references
// `ModInstaller.Adaptor.Dynamic`, whose `ModFormatManager` registers `CSharpScriptType`
// (`FileNames=["script.cs"]`) alongside `XmlScriptType` when compiled with `USE_CSHARP_SCRIPT`,
// true for Vortex's real Windows build) -- and the SAME `ScriptMatch`/`GetRequirements` rule
// (filename contains the target name, immediate parent folder contains "fomod", both
// case-insensitive) applies to it as to ModuleConfig.xml above. Before this, `hasFomodInstaller()`
// returned `false` for a script.cs-only archive, so `classifyMod()` never reached `SKIP_OPEN_FOMOD`
// -- it silently fell through to a plain `REBUILD` with NO installer logic applied at all (any
// recorded `choices` simply ignored).
//
// DETECTION ONLY, deliberately -- executing arbitrary C# install logic is permanently out of scope
// for a static-analysis tool. Real-world impact confirmed negligible: 0 of 200 real archives sampled
// use this format (it predates the FOMOD Creation Tool's modern GUI, which only ever emits
// XmlScript) -- so this stays a clear "we don't support this installer type" signal reusing the
// existing SKIP_OPEN_FOMOD status machinery (see rebuild-mod.js::classifyMod's own use of this),
// rather than a new, separately-wired status threaded through every consumer for a format that
// appears effectively extinct in real Skyrim SE mods.
function isLegacyScriptCandidate(filePath) {
    const segs = filePath.split(/[\\/]/);
    const filename = segs[segs.length - 1];
    const parent = segs.length > 1 ? segs[segs.length - 2] : '';
    return filename.toLowerCase().includes('script.cs') && parent.toLowerCase().includes('fomod');
}

function hasFomodInstaller(archiveEntries) {
    return archiveEntries.some((e) => !e.isDir && isFomodConfigCandidate(e.path));
}

function hasLegacyScriptInstaller(archiveEntries) {
    return archiveEntries.some((e) => !e.isDir && isLegacyScriptCandidate(e.path));
}

module.exports = { findModRoot, hasFomodInstaller, hasLegacyScriptInstaller };
