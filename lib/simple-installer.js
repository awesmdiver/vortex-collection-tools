'use strict';
// Resolves a "simple" (non-FOMOD, no recorded choices) mod's archive into its final
// {source, destination} file list -- there's no installer wizard, but Vortex still strips a
// leading "mod root" wrapper folder before copying, using the exact same mechanism as the
// FOMOD nested-root case (see mod-root.js and choice-resolver.js's module header): confirmed via
// Vortex's own source, github.com/Nexus-Mods/Vortex, `installer_fomod_native/tester.ts`'s
// `isBasic` flag and `installer.ts`'s `getStopPatterns(gameId, ...)` call -- a non-FOMOD archive
// is handled by the SAME native installer in "Basic" mode, passed the SAME stopPatterns list as
// the FOMOD nested-root-prefix mechanism (`ArchiveStructure.FindPathPrefix` in the fomod-installer
// C# source): scan the archive's file list in listing order, find the FIRST path that matches ANY
// of a fixed list of "this looks like real mod content" regexes (an .esp/.esm/.esl/.bsa/.ba2 file,
// or a recognized Bethesda-engine top-level folder name, or "fomod/ModuleConfig.xml"), and strip
// everything before that match as the archive's mod-root prefix. Because the regex isn't anchored
// to the first path segment, this naturally walks through multiple nested wrapper folders (e.g. an
// extra "Data\" folder before "meshes\") in one pass -- no separate "Data"-stripping step needed.

// Verbatim from Vortex's own source (src/renderer/src/extensions/installer_fomod_shared/utils/
// gameSupport.ts: `stopPatterns('skyrimse')` = uniPatterns + gamebryoPatterns + ["skse"]).
const GAMEBRYO_TOP_LEVEL = [
    'distantlod', 'textures', 'meshes', 'music', 'shaders', 'video', 'interface', 'fonts',
    'scripts', 'facegen', 'menus', 'lodsettings', 'lsdata', 'sound', 'strings', 'trees', 'asi',
    'tools', 'calientetools',
];
const toWordExp = (name) => `(^|/)${name}(/|$)`;
const SKYRIMSE_STOP_PATTERNS = [
    toWordExp('fomod'), // uniPatterns
    String.raw`[^/]*\.esp$`,
    String.raw`[^/]*\.esm$`,
    String.raw`[^/]*\.esl$`,
    String.raw`[^/]*\.bsa$`,
    String.raw`[^/]*\.ba2$`,
    String.raw`fomod/ModuleConfig\.xml$`,
    ...GAMEBRYO_TOP_LEVEL.map(toWordExp),
    toWordExp('skse'),
];

// Faithful port of fomod-installer's ArchiveStructure.FindPathPrefix(fileList, expressions):
// find the FIRST entry (in archive-listing order) whose path matches ANY stop pattern, return
// everything before the match start as the prefix. Empty string if nothing matches -- meaning
// the archive already has real content (or a recognized name) at its true root, nothing to strip.
function findPathPrefix(filePaths, patterns) {
    const combined = new RegExp(patterns.join('|'), 'i');
    for (const filePath of filePaths) {
        const normalized = filePath.replace(/\\/g, '/');
        const match = combined.exec(normalized);
        if (match) return filePath.slice(0, match.index);
    }
    return '';
}

function stripTrailingSep(p) {
    return p.replace(/[\\/]+$/, '');
}

// archiveEntries: sevenzip.listArchive() output for the whole archive.
function resolveSimpleInstall(archiveEntries) {
    const filePaths = archiveEntries.filter((e) => !e.isDir).map((e) => e.path);
    const prefix = stripTrailingSep(findPathPrefix(filePaths, SKYRIMSE_STOP_PATTERNS));
    const prefixLower = prefix.toLowerCase();
    const stripLen = prefix ? prefix.length + 1 : 0;
    // Real Vortex source (src/ModInstaller.Adaptor.Typed/Installer.cs:180): `ArchiveFile.
    // StartsWith(prefix) ? ArchiveFile.Substring(prefix.Length) : ArchiveFile` -- a file is only
    // stripped if it's actually NESTED under the detected prefix. A file sitting OUTSIDE it (e.g. a
    // real case that exposed this: a root-level README.md sibling to a "Data\" folder, where "Data"
    // was the detected prefix from other files inside it) keeps its original, unstripped path --
    // installed at the mod's true root, exactly where it already sits in the archive. Blindly
    // slicing every path by the same fixed length (the old behavior here) mangled any such sibling
    // file into garbage (e.g. "README.md".slice(5) => "E.md"), a real, confirmed false-positive
    // mismatch source. Matched case-insensitively since Windows paths are case-insensitive and stop
    // patterns are already matched that way (RegexOptions.IgnoreCase on the real C# side too).
    return filePaths.map((p) => {
        const startsWithPrefix = prefix && p.toLowerCase().startsWith(prefixLower);
        return { source: p, destination: startsWithPrefix ? p.slice(stripLen) : p };
    });
}

module.exports = { resolveSimpleInstall, findPathPrefix, SKYRIMSE_STOP_PATTERNS };
