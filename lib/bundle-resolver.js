'use strict';
// Resolves a Vortex collection's `source.type === 'bundle'` mods -- a small file (an ESLified ESP,
// a hand-made patch, etc.) the collection author packages directly INSIDE the collection's own
// downloaded package, instead of as a separately downloadable Nexus mod or off-site URL. See
// TECHNICAL.md's "Bundle-type collection mods" section for the full real-world story (director
// report, "Olenveld ESLifier", 2026-08-26): archive-locator.js's normal exact-size -> +/-1KB
// fallback -> md5-compare path can NEVER correctly resolve one of these, because `bundle` is the
// only source type collection.json ever omits an `md5` for -- any same-size candidate it stumbles
// into by coincidence fails the md5 check every time (a real hash string can never `===` `undefined`),
// which reported as a false "archive close to the expected size... but it doesn't match" even when
// nothing was actually wrong.
//
// Confirmed real, live (2026-08-26): the collection's own downloaded package
// (`GTS-Unofficial-Addon-Olenveld-677202-8-1776191935.7z`, sitting in the downloads folder like any
// other Nexus download) already contains the bundled content, under `bundled/<fileExpression>/`:
//
//   bundled/
//   bundled/Bundled - Olenveld ESLifier (v_63_)/
//   bundled/Bundled - Olenveld ESLifier (v_63_)/olenveldfixpack.esp
//
// So a bundle-type mod never needs downloading at all -- it just needs the RIGHT subfolder pulled
// out of an archive this tool (or Vortex) already has. `source.fileExpression` maps EXACTLY to that
// subfolder's name (confirmed against the real value above: spaces, a hyphen, parentheses, and an
// underscore, all literal -- never a glob/regex).
//
// Also confirmed real: `source.fileSize` on a bundle entry describes the COLLECTION'S OWN package,
// not the inner file (81,920 bytes recorded vs. the real inner .esp's 79,325 bytes) -- a second,
// independent reason size/hash matching against the downloads folder was never going to work for
// this source type, on top of the missing md5.

const fs = require('fs');
const path = require('path');

const { ARCHIVE_EXTENSIONS } = require('./archive-locator');
const bridgeClient = require('./vortex-bridge-client');

// Windows-reserved filename characters -- the ONLY sanitization a real fileExpression has ever
// needed here (confirmed value has spaces/parens/hyphens/underscores, all filesystem-safe already);
// this is a defensive floor for a fileExpression this project hasn't seen yet, not a guess this one
// value needs it.
function sanitizeFolderName(name) {
    return String(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'bundled-content';
}

// Locates the collection's OWN downloaded package on disk -- Bridge-first (Vortex's own live
// archiveId/localPath record, the actual truth), falling back to a derived filename ONLY when the
// Vortex Bridge can't answer (not installed/running, or this specific collectionModId isn't in its live
// state for some reason). collectionModId is the collection mod's own Vortex modId -- confirmed
// (lib/update-collection-v2-runner.js's resolveNexusInfoViaBridge, lib/collection-runner.js's
// buildPlan) this is the SAME string as the collection's own staging folder name and the SAME key
// `getAllMods()`'s `data.mods` is indexed by.
//
// A THIRD candidate (2026-09-25 fix, real director report -- "Gate To Sovngarde", 34 bundled mods
// wrongly showing "off-site, import manually") is tried only once BOTH of the above fail: Vortex's
// own staging folder for the collection, `<stagingDir>\<collectionModId>\Bundled\`. Vortex extracts
// a collection's bundled content there itself at install time, and that extracted copy can genuinely
// outlive the original downloaded package archive (cleaned up from downloads, a stale/derived
// filename that no longer matches, no live Vortex Bridge record) -- confirmed real: the director's own
// package archive was gone from downloads, but `E:\Vortex Mods\skyrimse\vortex_collection_QCtyQZfZQ\
// Bundled\` still held every bundled mod's real, already-extracted files. This is DIFFERENT IN KIND
// from the two archive-based candidates above: those resolve a real .7z/.zip this caller then has to
// 7z-list and search inside (resolveBundledEntries, below); this one is already a plain folder on
// disk, so the return shape distinguishes the two -- callers get back EITHER `{ archivePath, via }`
// (something to 7z-list) OR `{ bundledDir, via: 'staging' }` (something to read directly, no archive
// tooling involved at all -- see resolveBundledEntriesFromDir/copyBundledFilesFromDir below).
//
// Tried LAST, not first or interleaved -- the two archive-based candidates above are the normal,
// already-working case (the whole point of a "package" candidate is it can be 7z-listed once and
// reused for every bundled mod in the collection without re-touching disk per mod), so this is a
// fallback for when they're genuinely gone, never a replacement that could reorder/change behavior
// for a collection whose package is still right where it's always been.
//
// Throws `BUNDLE_PACKAGE_NOT_FOUND` (never a bare Error) on any failure to locate a real file --
// callers should treat this exactly like NOT_FOUND from archive-locator.js: a real, honest "we don't
// have this" outcome, not a crash.
async function resolveCollectionPackagePath({ collectionModId, downloadsDir, stagingDir }) {
    if (!collectionModId) {
        const err = new Error(
            'This file comes from inside a collection\'s own download, so it can only be restored as part of '
            + 'that collection. Updating or rebuilding the collection will pick it up.'
        );
        err.code = 'BUNDLE_PACKAGE_NOT_FOUND';
        throw err;
    }

    // Bridge-first: the real, live archiveId -> localPath chain (see cleanup-scan.js's own
    // modInfoFromLiveMods/downloadInfoFromLiveFiles for the same join, established there first).
    try {
        const bridgeUp = await bridgeClient.checkBridgeAvailable();
        if (bridgeUp) {
            const modsData = await bridgeClient.getAllMods();
            const archiveId = modsData?.mods?.[collectionModId]?.archiveId;
            if (archiveId) {
                const downloadsData = await bridgeClient.getAllDownloads();
                const localPath = downloadsData?.files?.[archiveId]?.localPath;
                if (localPath) {
                    const candidate = path.join(downloadsDir, localPath);
                    if (fs.existsSync(candidate)) return { archivePath: candidate, via: 'bridge' };
                }
            }
        }
    } catch {
        // Never fatal -- falls through to the derived-filename path below, same "opportunistic,
        // never a hard requirement" contract every other vortex-bridge-client.js caller follows.
    }

    // Fallback: derive the filename from collectionModId's own naming convention -- confirmed real
    // (this exact collection): the collection's staging folder name IS its downloaded archive's own
    // base filename (`GTS-Unofficial-Addon-Olenveld-677202-8-1776191935` -> `....7z`). Tried across
    // every real archive extension this project already recognizes (archive-locator.js's own
    // ARCHIVE_EXTENSIONS), not just .7z -- a collection's own package can in principle be any of them.
    for (const ext of ARCHIVE_EXTENSIONS) {
        const candidate = path.join(downloadsDir, `${collectionModId}${ext}`);
        if (fs.existsSync(candidate)) return { archivePath: candidate, via: 'derived' };
    }

    // Third candidate: Vortex's own already-extracted staging copy (see this function's own header
    // comment above for the real-world story). collectionModId doubles as the collection's own
    // staging folder name (same fact the header comment above already relies on for the derived-
    // filename candidate), so this needs no new lookup mechanism -- just the one join nothing here
    // checked before this fix.
    if (stagingDir) {
        const bundledDir = path.join(stagingDir, collectionModId, 'Bundled');
        if (fs.existsSync(bundledDir)) return { bundledDir, via: 'staging' };
    }

    const err = new Error(
        `Couldn't find the collection's bundled files. Retry downloading the collection update again.`
    );
    err.code = 'BUNDLE_PACKAGE_NOT_FOUND';
    throw err;
}

// Filters an already-listed archive (sevenzip.js's listArchive() output) down to the files living
// under `bundled/<fileExpression>/`, returning {source, destination} pairs shaped exactly like
// extract-mod.js's own installResolvedFiles() already expects (source = full archive-internal path,
// destination = path relative to the mod's own root, prefix stripped).
//
// fileExpression is treated as a LITERAL folder name throughout -- never a glob/regex. Confirmed real
// value contains spaces, a hyphen, parentheses, and an underscore ("Bundled - Olenveld ESLifier
// (v_63_)"), none of which may be pattern-interpreted.
//
// 7-Zip lists paths with '\' for .7z archives and (confirmed) sometimes '/' depending on archive
// format -- both are normalized here so the prefix match works regardless of which the source
// collection package happens to use.
function resolveBundledEntries(archiveEntries, fileExpression) {
    const prefix = `bundled/${fileExpression}/`.toLowerCase();
    const files = archiveEntries
        .filter((e) => !e.isDir)
        .map((e) => ({ ...e, normalized: e.path.replace(/\\/g, '/') }))
        .filter((e) => e.normalized.toLowerCase().startsWith(prefix));

    if (files.length === 0) {
        const err = new Error(
            `This file wasn't found inside your downloaded collection package, which might be an older `
            + `version. Re-downloading the collection in Vortex should fix this.`
        );
        err.code = 'BUNDLE_FOLDER_NOT_FOUND';
        throw err;
    }

    return files.map((e) => ({ source: e.path, destination: e.normalized.slice(prefix.length) }));
}

// The staging-folder twin of resolveBundledEntries above (2026-09-25 fix) -- same job, same
// fileExpression-is-a-literal-folder-name contract, same BUNDLE_FOLDER_NOT_FOUND on a miss (a mod
// whose own subfolder doesn't exist inside `Bundled\`, even though `Bundled\` itself does -- e.g. a
// sibling mod's folder is there but not this one's), but reads a real, already-extracted directory
// tree instead of listing an archive. `source` here is a real, absolute filesystem path (not an
// archive-internal one) -- callers that need to tell the two shapes apart use resolveCollectionPackagePath's
// own return value (`archivePath` vs `bundledDir`), not this list.
function resolveBundledEntriesFromDir(bundledDir, fileExpression) {
    const rootDir = path.join(bundledDir, fileExpression);
    const files = [];
    if (fs.existsSync(rootDir) && fs.statSync(rootDir).isDirectory()) {
        const walk = (dir, relPrefix) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
                if (entry.isDirectory()) walk(full, rel);
                else files.push({ source: full, destination: rel });
            }
        };
        walk(rootDir, '');
    }

    if (files.length === 0) {
        const err = new Error(
            `This file wasn't found inside your downloaded collection package, which might be an older `
            + `version. Re-downloading the collection in Vortex should fix this.`
        );
        err.code = 'BUNDLE_FOLDER_NOT_FOUND';
        throw err;
    }

    return files;
}

// Copies an already-resolved {source, destination}[] list (resolveBundledEntriesFromDir's own
// output -- real, absolute source paths already sitting on disk) straight into destDir. No 7z/
// scratch-dir step needed at all, unlike lib/extract-resolved-files.js's own extractResolvedFiles --
// the whole point of this candidate is the content is ALREADY extracted, sitting in Vortex's own
// staging area. Mirrors that file's own "verify against disk, report what's missing rather than
// throw" contract (a file could vanish between resolveBundledEntriesFromDir's own listing and this
// copy, however unlikely) so a caller gets the same shaped skipped-files report either way.
function copyBundledFilesFromDir(resolvedFiles, destDir) {
    const skipped = [];
    for (const f of resolvedFiles) {
        if (!fs.existsSync(f.source)) {
            skipped.push({ path: f.source, error: 'This file was gone from the staging Bundled folder by the time it was copied.' });
            continue;
        }
        const destFullPath = path.join(destDir, f.destination);
        fs.mkdirSync(path.dirname(destFullPath), { recursive: true });
        fs.copyFileSync(f.source, destFullPath);
    }
    return skipped;
}

module.exports = {
    resolveCollectionPackagePath, resolveBundledEntries, resolveBundledEntriesFromDir,
    copyBundledFilesFromDir, sanitizeFolderName,
};
