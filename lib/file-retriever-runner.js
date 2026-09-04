'use strict';
// File Retriever (2026-09-01) -- pulls specific files/versions for a Nexus mod directly, bypassing
// the website when it's being uncooperative (ads, wait timers, a file the UI buries). Built on the
// real Nexus API research in diagnostics/2026-09-01-nexus-file-uid-download-url.md: every file in
// GET /v1/games/{gameDomain}/mods/{modId}/files.json already carries its own real `uid` (the
// website's own permanent per-file download-page id, distinct from the mod-scoped `file_id` this
// project tracks everywhere else) and `category_name` (Main/Optional/Miscellaneous/Old Version --
// the four sections the website's own Files tab groups into, "Old Version" being Nexus's internal
// name for what the website labels "File Archive").
//
// Two real download paths, same split every other download-capable tool in this project already
// makes: a Premium API key downloads every selected file directly (reuses downloadModArchive/
// resolveDownloadLink -- the exact mechanism Rebuild Collection's own "download missing archives"
// setting already uses); without one, this returns the real website download-page URL for each
// selected file (built from its own `uid`) for the frontend to open in a new tab -- the user
// finishes the download there themselves, same as clicking through manually, just without having to
// find the file on the mod's own (often huge, hard-to-navigate) Files tab first.

const nexusModDownload = require('./nexus-mod-download');

const NEXUS_SE_GAME_DOMAIN = 'skyrimspecialedition';

// Real Nexus domain slugs for the three games this app themes for (2026-09-01, multi-game support --
// confirmed against real Nexus mod-page URLs, e.g. nexusmods.com/fallout4/mods/... and
// nexusmods.com/starfield/mods/...). Every route that accepts a caller-supplied gameDomain validates
// against this set rather than passing an arbitrary string straight to the Nexus API.
const NEXUS_GAME_DOMAINS = {
    skyrimspecialedition: NEXUS_SE_GAME_DOMAIN,
    fallout4: 'fallout4',
    starfield: 'starfield',
};

// Nexus's own internal category_name values -> the plain label the website's own Files tab shows.
// "OLD_VERSION" is the one non-obvious mapping (confirmed live, 2026-09-01, against a real mod's
// files.json response) -- every other value already reads as its own label.
const CATEGORY_LABELS = {
    MAIN: 'Main Files',
    OPTIONAL: 'Optional Files',
    MISCELLANEOUS: 'Miscellaneous Files',
    OLD_VERSION: 'File Archive',
    ARCHIVED: 'File Archive', // some older API responses use this spelling instead of OLD_VERSION
};

function categoryLabel(categoryName) {
    return CATEGORY_LABELS[categoryName] || categoryName || 'Other';
}

// One combined lookup for the app's own Screen 1 -> Screen 2 transition: mod details (for the
// confirmation card) plus every file Nexus has ever hosted for it (for the category-filtered
// checkbox list). Two real API calls, run together rather than the frontend making two separate
// round trips.
async function lookupMod({ apiKey, gameDomain = NEXUS_SE_GAME_DOMAIN, modId }) {
    const [mod, files] = await Promise.all([
        nexusModDownload.getModDetails(apiKey, gameDomain, modId),
        nexusModDownload.getModFiles(apiKey, gameDomain, modId),
    ]);
    return {
        mod: {
            modId: Number(modId),
            name: mod.name,
            author: mod.author,
            pictureUrl: mod.picture_url || null,
            summary: mod.summary || null,
            nexusUrl: `https://www.nexusmods.com/${gameDomain}/mods/${modId}`,
        },
        files: files.map((f) => ({
            fileId: f.file_id,
            uid: f.uid,
            name: f.name,
            version: f.version,
            fileName: f.file_name,
            category: f.category_name,
            categoryLabel: categoryLabel(f.category_name),
            sizeKb: f.size_kb,
            uploadedTime: f.uploaded_time,
            // The website's own permanent per-file download page -- built directly from `uid`, the
            // exact mechanism diagnostics/2026-09-01-nexus-file-uid-download-url.md confirms live.
            // Always included (not just for the no-Premium path) so the frontend can offer "View on
            // Nexus" for any one file regardless of which download path this run actually takes.
            websiteUrl: `https://www.nexusmods.com/api/files/${f.uid}/download`,
        })),
    };
}

// Direct download for a Premium account -- sequential (same Nexus rate-limit discipline every other
// batch download in this project already follows, see downloadMissingArchivesForPlan's own header
// comment), one real Nexus API call per file plus the actual transfer. onProgress fires before each
// file starts and once it finishes/fails, matching this app's own standard SSE progress shape.
async function downloadSelected({ apiKey, gameDomain = NEXUS_SE_GAME_DOMAIN, modId, files, destDir, onProgress = () => {} }) {
    const results = [];
    let i = 0;
    for (const file of files) {
        i += 1;
        onProgress({ type: 'progress', current: i, total: files.length, message: `Downloading ${file.name} ${file.version}…` });
        try {
            const result = await nexusModDownload.downloadModArchive({
                apiKey, gameDomain,
                source: {
                    modId, fileId: file.fileId, md5: null,
                    fileSize: file.sizeKb ? file.sizeKb * 1024 : undefined,
                    logicalFilename: file.fileName || file.name,
                },
                destDir,
            });
            results.push({ fileId: file.fileId, name: file.name, version: file.version, category: file.category, ok: true, path: result.archivePath });
            onProgress({ type: 'file-done', fileId: file.fileId, ok: true, path: result.archivePath });
        } catch (e) {
            results.push({ fileId: file.fileId, name: file.name, version: file.version, category: file.category, ok: false, error: e.message });
            onProgress({ type: 'file-done', fileId: file.fileId, ok: false, error: e.message });
        }
    }
    return results;
}

module.exports = { NEXUS_SE_GAME_DOMAIN, NEXUS_GAME_DOMAINS, lookupMod, downloadSelected, categoryLabel };
