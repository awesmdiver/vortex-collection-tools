'use strict';
// Downloads a SINGLE mod's archive directly from Nexus by modId+fileId, for Rebuild Collection's
// opt-in "download missing archives" setting. Modeled on Vortex's OWN real download mechanism, not
// invented -- see vortex-source-refs.json for the exact source citations. Summary:
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
const { hashFileMd5 } = require('./archive-locator');

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
    if (res.statusCode !== 200) throw new Error(`Nexus account validation failed: HTTP ${res.statusCode}\n${text}`);
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

    const finalName = parseContentDispositionFilename(headers['content-disposition'])
        || `${source.logicalFilename || `mod-${source.modId}-file-${source.fileId}`}${guessExtensionFromContentType(headers['content-type']) || '.zip'}`;

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
    if (actualMd5 !== source.md5) {
        fs.rmSync(tempPath, { force: true });
        const err = new Error(sizeMismatch
            ? 'Downloaded file does not match the file details for the collection (size and content both differ).'
            : 'Downloaded file does not match the file details for the collection.');
        err.code = 'HASH_MISMATCH';
        throw err;
    }

    const finalPath = path.join(destDir, finalName);
    fs.renameSync(tempPath, finalPath);
    return { archivePath: finalPath, fileName: finalName };
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
            const { archivePath, fileName } = await downloadModArchive({ apiKey, gameDomain, source: mod.source, destDir: downloadsDir });
            results.push({ ...base, status: 'DOWNLOADED', archivePath, fileName });
        } catch (e) {
            results.push({ ...base, status: 'FAILED', error: e.message, errorCode: e.code || 'UNKNOWN' });
        }
    }
    return { results, skippedReason: null, premiumAccountName: premium.name };
}

module.exports = { resolveApiKey, checkPremiumStatus, downloadModArchive, downloadMissingArchivesForPlan };
