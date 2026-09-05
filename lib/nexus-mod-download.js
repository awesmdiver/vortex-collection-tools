'use strict';
// Downloads a SINGLE mod's archive directly from Nexus by modId+fileId, for Rebuild Collection's
// opt-in "download missing archives" setting. Modeled on Vortex's OWN real download mechanism, not
// invented -- see config/vortex-source-refs.json for the exact source citations. Summary:
//   - Vortex's real "download this exact modId+fileId" trigger (onDownloadRequirement.ts) builds an
//     nxm://<domain>/mods/<modId>/files/<fileId> URL and emits a 'start-download' event.
//   - The real resolving handler (nexus_integration/eventHandlers.ts's downloadFile) contains
//     Vortex's own explicit policy gate: "nexusmods can't let users download files directly from
//     client, without showing ads" -- free (non-Premium) accounts are REFUSED client-side, by
//     design, to protect Nexus's ad-supported revenue model. This module respects the same rule: it
//     checks Premium status first and refuses to even attempt a download for a non-Premium account,
//     exactly like Vortex itself does, rather than trying to work around it.
//   - The real underlying REST call (node-nexus-api's Nexus.ts getDownloadURLs) is
//     GET /v1/games/{gameId}/mods/{modId}/files/{fileId}/download_link.json, no key/expires needed
//     for Premium accounts (those params are only for the free-user nxm-link-click flow, which this
//     project does not implement -- see the ad-model point above).
//
// Only ever called for mod.source.type === 'nexus' entries -- off-site ('browse'/'direct'/'bundle')
// mods have no modId/fileId at all, so there is structurally no API call to make for them (see
// lib/collection-runner.js's buildPlan for how those are surfaced instead: the collection's own
// recorded URL, or a "no URL available" note).

const fs = require('fs');
const path = require('path');
const { httpsRequest, downloadToFile, resolveApiKey } = require('./nexus-collection-download');
const { hashFileMd5, resolveDomainDownloadsDir } = require('./archive-locator');
const { isRecognizedDownloadName } = require('./download-naming');

const APP_NAME = 'vortex-collection-extractor';
const APP_VERSION = '1.0.0';
const PREMIUM_CACHE_TTL_MS = 5 * 60 * 1000;

let premiumCache = null; // module-level: checked once per run (or every 5min), not once per mod

// GET /v1/users/validate.json -- the real endpoint Vortex itself uses to know isPremium.
async function checkPremiumStatus(apiKey, { forceRefresh = false } = {}) {
    if (!forceRefresh && premiumCache && (Date.now() - premiumCache.checkedAt) < PREMIUM_CACHE_TTL_MS) {
        return premiumCache;
    }
    const res = await httpsRequest('https://api.nexusmods.com/v1/users/validate.json', {
        method: 'GET',
        headers: { apikey: apiKey, 'Application-Name': APP_NAME, 'Application-Version': APP_VERSION },
    });
    const text = res.body.toString('utf8');
    if (res.statusCode !== 200) {
        // 401 is Nexus's own real response for a missing/invalid/expired API key on this endpoint --
        // confirmed via Nexus's own public API docs, same "APIKEY header" auth every other call in
        // this project's Nexus modules uses. A raw "HTTP 401\n<body>" message reads as an unexplained
        // technical failure; this is the one specific, actionable case worth a real translated
        // message (2026-09-04, real gap: resolveApiKey() already has a clear message for a
        // COMPLETELY MISSING key, but nothing translated an invalid one's real HTTP failure).
        // The raw status/body stay on the error (never dropped) for logging -- only the PRIMARY
        // message changes for this one case.
        const err = new Error(res.statusCode === 401
            ? "Your Nexus API key doesn't look valid -- check it on the Settings page."
            : `Nexus account validation failed: HTTP ${res.statusCode}\n${text}`);
        err.code = res.statusCode === 401 ? 'INVALID_API_KEY' : 'HTTP_ERROR';
        err.rawStatus = res.statusCode;
        err.rawBody = text;
        throw err;
    }
    const json = JSON.parse(text);
    premiumCache = { isPremium: !!json.is_premium, name: json.name, checkedAt: Date.now() };
    return premiumCache;
}

// GET /v1/games/{gameId}/mods/{modId}/files/{fileId}/download_link.json -- the real per-file
// resolve call. Response is an array of {URI,...} for Premium (multiple CDN mirrors) -- take the
// first; some responses instead come back as a single object, so handle both shapes.
async function resolveDownloadLink(apiKey, gameDomain, modId, fileId) {
    const url = `https://api.nexusmods.com/v1/games/${encodeURIComponent(gameDomain)}/mods/${modId}/files/${fileId}/download_link.json`;
    const res = await httpsRequest(url, {
        method: 'GET',
        headers: { apikey: apiKey, 'Application-Name': APP_NAME, 'Application-Version': APP_VERSION },
    });
    const text = res.body.toString('utf8');
    if (res.statusCode !== 200) {
        // A 403 here does NOT necessarily mean "this account isn't Premium" -- that's already
        // checked once, up front, before any per-mod call is attempted (see
        // downloadMissingArchivesForPlan). Confirmed live against a real Premium account: Nexus also
        // returns 403 for a mod that's been taken down/hidden ("Mod not available: <id>"), a
        // completely different, per-mod condition. Nexus's own JSON body's "message" field is the
        // real, specific reason either way -- surface that directly instead of assuming.
        let apiMessage = null;
        try { apiMessage = JSON.parse(text).message; } catch { /* not JSON, fall through to raw text */ }
        const err = new Error(`Nexus rejected this download (HTTP ${res.statusCode}): ${apiMessage || text}`);
        err.code = res.statusCode === 403 ? 'FORBIDDEN' : 'HTTP_ERROR';
        throw err;
    }
    const json = JSON.parse(text);
    const first = (Array.isArray(json) ? json : [json])[0];
    const uri = first && (first.URI || first.uri);
    if (!uri) throw new Error(`Could not find a URL in download_link response: ${text}`);
    return uri;
}

// GET /v1/games/{gameId}/mods/{modId}.json -- basic mod details (name/author/picture/summary), for
// File Retriever's own "confirm this is the mod you meant" card (2026-09-01). Nothing else in this
// project needed a bare mod-details lookup before -- every existing caller already has a specific
// modId+fileId from a collection.json entry and only ever needs the FILE's own details
// (resolveFileDetails below), never the mod page's.
async function getModDetails(apiKey, gameDomain, modId) {
    const url = `https://api.nexusmods.com/v1/games/${encodeURIComponent(gameDomain)}/mods/${modId}.json`;
    const res = await httpsRequest(url, {
        method: 'GET',
        headers: { apikey: apiKey, 'Application-Name': APP_NAME, 'Application-Version': APP_VERSION },
    });
    const text = res.body.toString('utf8');
    if (res.statusCode === 404) {
        const err = new Error(`No mod found with id ${modId} on ${gameDomain}.`);
        err.code = 'NOT_FOUND';
        throw err;
    }
    if (res.statusCode !== 200) throw new Error(`Could not fetch mod details (HTTP ${res.statusCode}): ${text}`);
    return JSON.parse(text);
}

// GET /v1/games/{gameId}/mods/{modId}/files.json -- every file Nexus has ever hosted for this mod,
// across every category (Main/Optional/Miscellaneous/Old Version -- Nexus's own internal name for
// what the website calls "File Archive"). Each entry already carries its own real `uid` (the
// website's own permanent download-page identifier, see diagnostics/
// 2026-09-01-nexus-file-uid-download-url.md for the full research this is built on) and
// `category_name` -- no derivation needed for either.
async function getModFiles(apiKey, gameDomain, modId) {
    const url = `https://api.nexusmods.com/v1/games/${encodeURIComponent(gameDomain)}/mods/${modId}/files.json`;
    const res = await httpsRequest(url, {
        method: 'GET',
        headers: { apikey: apiKey, 'Application-Name': APP_NAME, 'Application-Version': APP_VERSION },
    });
    const text = res.body.toString('utf8');
    if (res.statusCode !== 200) throw new Error(`Could not fetch this mod's file list (HTTP ${res.statusCode}): ${text}`);
    const json = JSON.parse(text);
    return json.files || [];
}

// GET /v1/games/{gameId}/mods/{modId}/files/{fileId}.json -- single-file details, keyed by the
// EXACT fileId we already have (source.fileId), no version/timestamp guessing needed. Used to
// recover Nexus's own on-disk naming convention -- the raw download_link.json/CDN response gives
// back the mod author's own plain uploaded filename, with none of Nexus's own
// "-<modId>-<version>-<uploadedTimestamp>" suffix baked in (confirmed 2026-07-28: neither Vortex's
// own install-time code generates this suffix either -- F:\Claude Workspace\vortex-tools\Vortex\src\
// renderer\src\extensions\nexus_integration\util\modIdManager.ts's deriveModInstallName is a pure
// pass-through of whatever the DOWNLOADED FILE was already named -- so it must come from Nexus's own
// manual/website download flow specifically). This endpoint's own `file_name` field turned out to
// already BE that exact fully-formed name -- validated live against 5 real, already-installed mods
// this session (modIds 37693/146873/97050/22878/132292): every one of this endpoint's `file_name`
// values matched that mod's own real staging-folder name byte-for-byte, including a non-numeric
// version segment ("2.8b" -> "...-2-8b-..."). No reconstruction/dot-to-dash guessing needed at all
// -- just read this field directly. See TECHNICAL.md's "Naming-convention gap #3" for the full
// writeup and validation data.
async function resolveFileDetails(apiKey, gameDomain, modId, fileId) {
    const url = `https://api.nexusmods.com/v1/games/${encodeURIComponent(gameDomain)}/mods/${modId}/files/${fileId}.json`;
    const res = await httpsRequest(url, {
        method: 'GET',
        headers: { apikey: apiKey, 'Application-Name': APP_NAME, 'Application-Version': APP_VERSION },
    });
    const text = res.body.toString('utf8');
    if (res.statusCode !== 200) throw new Error(`Could not fetch file details (HTTP ${res.statusCode}): ${text}`);
    return JSON.parse(text);
}

function parseContentDispositionFilename(header) {
    if (!header) return null;
    const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(header);
    return m ? decodeURIComponent(m[1]) : null;
}

function guessExtensionFromContentType(contentType) {
    if (!contentType) return null;
    if (contentType.includes('7z')) return '.7z';
    if (contentType.includes('rar')) return '.rar';
    if (contentType.includes('zip')) return '.zip';
    return null;
}

// Downloads ONE mod's archive into destDir, verifying actual md5 against source.md5 BEFORE it's
// considered real (same verify-before-trust spirit as rebuild-mod.js's temp-folder-then-swap
// extraction) -- never leaves a wrong/partial file at a name locateArchive() could find. md5 is the
// real authority, not fileSize (see the size-mismatch-but-hash-matches comment below) -- a size
// mismatch alone is never fatal on its own, only noted in the message if the hash ALSO fails.
// Throws with .code: 'FORBIDDEN' | 'HTTP_ERROR' | 'DOWNLOAD_ERROR' | 'HASH_MISMATCH' --
// FORBIDDEN/HTTP_ERROR cover real per-mod Nexus-side conditions (mod taken down, pinned file version
// removed, etc.), not just an account-level Premium gate (that's checked once, separately, before
// any of these are attempted -- see checkPremiumStatus).
async function downloadModArchive({ apiKey, gameDomain, source, destDir }) {
    const downloadUrl = await resolveDownloadLink(apiKey, gameDomain, source.modId, source.fileId);
    fs.mkdirSync(destDir, { recursive: true });
    const tempPath = path.join(destDir, `.download-${source.modId}-${source.fileId}.part`);
    let headers = {};
    try {
        await downloadToFile(downloadUrl, tempPath, { onHeaders: (h) => { headers = h; } });
    } catch (e) {
        fs.rmSync(tempPath, { force: true });
        const err = new Error(`Failed to download archive for modId=${source.modId} fileId=${source.fileId}: ${e.message}`);
        err.code = 'DOWNLOAD_ERROR';
        throw err;
    }

    const rawName = parseContentDispositionFilename(headers['content-disposition'])
        || `${source.logicalFilename || `mod-${source.modId}-file-${source.fileId}`}${guessExtensionFromContentType(headers['content-type']) || '.zip'}`;

    // Swap in Nexus's own fully-formed, naming-convention-correct file_name when available (see
    // resolveFileDetails above) -- best-effort only: a real download that lands under a slightly
    // plainer name (rawName) beats failing the whole operation over a metadata lookup hiccup.
    let finalName = rawName;
    try {
        const fileDetails = await resolveFileDetails(apiKey, gameDomain, source.modId, source.fileId);
        if (fileDetails && fileDetails.file_name) finalName = fileDetails.file_name;
    } catch {
        // Fall back to rawName -- see comment above.
    }

    // MD5 is the real authority here, not fileSize -- confirmed real-world this session: a
    // manually-downloaded, genuinely correct file for "Eyes Nouveaux - Ultra" had an MD5 that
    // matched collection.json's own recorded md5 EXACTLY (cross-checked two independent ways), yet
    // its actual size was 3 bytes off from collection.json's recorded fileSize -- the size field
    // itself was simply wrong in the collection's own manifest, not a problem with the download. A
    // size mismatch alone is only a red flag worth NOTING (attached to the SIZE_MISMATCH error, only
    // ever thrown if the hash ALSO doesn't match); no size pre-filter needed here to save work the
    // way archive-locator.js's folder-wide search does -- this is already the one specific file just
    // downloaded, so hashing it costs nothing extra regardless of whether the size matched.
    const actualSize = fs.statSync(tempPath).size;
    const sizeMismatch = actualSize !== source.fileSize;
    const actualMd5 = await hashFileMd5(tempPath);
    // source.md5 == null (2026-08-31, lib/nexus-mod-requirements.js's own missing-prerequisite
    // install flow) -- the ONE real, deliberate exception to "md5 is the real authority" above.
    // Every EXISTING caller (Rebuild Collection, Missing Masters, this file's own collection-curated
    // Added/Updated mods) always has a real, curator-recorded source.md5 to verify against, so this
    // check is completely unchanged for all of them. A mod this project resolves itself (not from
    // any collection's own curation -- confirmed via real research that NEITHER Nexus REST v1 nor its
    // GraphQL API exposes a file-level hash anywhere, so there is no pre-known value to check
    // against in the first place) has nothing to verify against yet; this trusts the freshly-hashed
    // download as the real, correct value going forward (the caller then records THIS actualMd5 as
    // the new mod's own source.md5, same as if a collection curator had recorded it).
    if (source.md5 != null && actualMd5 !== source.md5) {
        fs.rmSync(tempPath, { force: true });
        const err = new Error(sizeMismatch
            ? 'Downloaded file does not match the file details for the collection (size and content both differ).'
            : 'Downloaded file does not match the file details for the collection.');
        err.code = 'HASH_MISMATCH';
        throw err;
    }

    // Nexus's own file_name (or the content-disposition-derived rawName fallback) is the single
    // source of truth for this archive's name -- it must never drift from what Nexus itself calls
    // it. Always resolve to this EXACT path and replace whatever's already there, rather than
    // uniquifying with a ".1"/".2" suffix on collision -- confirmed real 2026-08-25: repeated
    // Download Archive attempts (retrying past the stale-server domain bug) left "...1611931647.7z",
    // "...1611931647.1.7z", and "...1611931647.1.1.7z" side by side in the downloads folder. There
    // should only ever be ONE copy of a given Nexus file on disk, and the md5 check above already
    // guarantees this fresh download is the correct one to keep.
    const finalPath = path.join(destDir, finalName);
    if (fs.existsSync(finalPath)) fs.rmSync(finalPath, { force: true });
    fs.renameSync(tempPath, finalPath);
    return { archivePath: finalPath, fileName: finalName, md5: actualMd5, fileSize: actualSize };
}

// Batch entry point for a plan's SKIP_NO_ARCHIVE (NOT_FOUND, type==='nexus') mods. Checks Premium
// ONCE via checkPremiumStatus's own cache, not per mod -- if the account isn't Premium, no download
// is attempted for ANY mod (matching Vortex's own client-side refusal), the caller is expected to
// surface skippedReason to the user/log instead. Sequential, not parallel: this is bandwidth-bound
// (not CPU-bound like extraction), and parallel requests risk Nexus API rate limits.
async function downloadMissingArchivesForPlan({ mods, downloadsDir, gameDomain, apiKey, onProgress }) {
    const premium = await checkPremiumStatus(apiKey);
    if (!premium.isPremium) {
        return { results: [], skippedReason: 'not-premium', premiumAccountName: premium.name };
    }
    const results = [];
    for (let i = 0; i < mods.length; i++) {
        const mod = mods[i];
        if (onProgress) onProgress({ index: i + 1, total: mods.length, modName: mod.name });
        const base = { modId: mod.source.modId, fileId: mod.source.fileId, name: mod.name };
        try {
            // mod.domainName (a real, per-mod field Nexus/Vortex's own collection.json schema
            // carries for a mod cross-listed under a different game's own catalog) takes priority
            // over the collection-wide `gameDomain` fallback -- same fix as web/rebuild-missing-
            // routes.js's Download Archive (commit a12787a, "TES Arena Bikini Armor"/modId 106393:
            // an SE collection's own info.domainName is "skyrimspecialedition", but that ONE mod's
            // entry carries domainName "skyrim"). A single `gameDomain` string handed to this WHOLE
            // batch can't represent a per-mod override, so this has to be resolved per-mod, right
            // here in the loop -- not by the callers, which only ever have one collection-wide value.
            const modGameDomain = mod.domainName || gameDomain;
            // Same per-mod resolution on the FILESYSTEM side as modGameDomain is for the API side --
            // a cross-listed mod's archive belongs in ITS OWN domain's downloads folder, not the
            // collection-wide one. See resolveDomainDownloadsDir's own header comment.
            const modDestDir = resolveDomainDownloadsDir(downloadsDir, mod.domainName);
            const { archivePath, fileName } = await downloadModArchive({ apiKey, gameDomain: modGameDomain, source: mod.source, destDir: modDestDir });
            results.push({ ...base, status: 'DOWNLOADED', archivePath, fileName });
        } catch (e) {
            results.push({ ...base, status: 'FAILED', error: e.message, errorCode: e.code || 'UNKNOWN' });
        }
    }
    return { results, skippedReason: null, premiumAccountName: premium.name };
}

module.exports = {
    resolveApiKey, checkPremiumStatus, downloadModArchive, downloadMissingArchivesForPlan,
    resolveDownloadLink, getModDetails, getModFiles,
};
