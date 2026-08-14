'use strict';
// Downloads a published collection's packaged bundle directly via Nexus's v2 GraphQL API,
// bypassing the nxm:// protocol handler entirely (which would otherwise launch Vortex). Confirmed
// via Nexus-Mods/node-nexus-api's own source (src/Nexus.ts's getCollectionRevisionGraph,
// src/types.ts's IRevision.downloadLink, src/parameters.ts's GRAPHQL_URL) that:
//   - the GraphQL endpoint is https://api.nexusmods.com/v2/graphql
//   - it accepts the SAME simple personal API key as the REST v1 API, via an "APIKEY" header
//   - the collectionRevision query's IRevision type has a downloadLink field
//
// Live-tested against a real collection ("My Dragonborn UI for GTS", slug "lxvyai"): the
// downloadLink field is NOT a direct URL -- it's a relative API path
// (e.g. "/v2/collections/470868/revisions/727911/download_link") that must itself be GETted
// (same APIKEY header) to get a real signed CDN URL back, wrapped as
// {"download_links":[{"URI": "https://premium-files.nexus-cdn.com/..."}]}. Also confirmed live:
// the downloaded bundle is a small .7z containing ONLY collection.json (+ empty bundled/patches
// folders for locally-supplied files) -- it is NOT the mod archives themselves, so its size has
// no relation to the collection's total mod payload (fileSize from the GraphQL response describes
// the full collection, not this bundle).
//
// IMPORTANT: this only ever pulls the LAST REVISION UPLOADED TO NEXUS. A collection actively being
// curated in Vortex's Workshop can be ahead of what's published -- see the caller-facing warning
// text in web/routes.js's /api/workshop/fetch-from-nexus handler.

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const appConfig = require('./app-config');

const GRAPHQL_URL = 'https://api.nexusmods.com/v2/graphql';

// Project's own unified config.json (set via the Settings page) is the primary source -- this used
// to hardcode a path into a completely separate, sibling project's own key file, which broke the
// instant this project was used on a machine without that other project installed. $NEXUS_API_KEY
// remains as a power-user/CI escape hatch (e.g. running this headless without ever touching the
// Settings UI), checked only if no key is configured.
function resolveApiKey() {
    const configured = appConfig.loadConfig().nexusApiKey;
    if (configured) return configured;
    if (process.env.NEXUS_API_KEY) return process.env.NEXUS_API_KEY.trim();
    throw new Error('No Nexus API key configured -- enter one on the Settings page (or set $NEXUS_API_KEY).');
}

function httpsRequest(url, options, body) {
    return new Promise((resolve, reject) => {
        const req = https.request(url, options, (res) => {
            const chunks = [];
            res.on('data', (d) => chunks.push(d));
            res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

async function graphqlRequest(apiKey, query, variables) {
    const payload = JSON.stringify({ query, variables });
    const res = await httpsRequest(GRAPHQL_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'APIKEY': apiKey,
            'Application-Name': 'vortex-collection-extractor',
            'Application-Version': '1.0.0',
        },
    }, payload);
    const text = res.body.toString('utf8');
    if (res.statusCode !== 200) throw new Error(`GraphQL request failed: HTTP ${res.statusCode}\n${text}`);
    const json = JSON.parse(text);
    if (json.errors) {
        const err = new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
        err.graphqlErrors = json.errors;
        throw err;
    }
    return json.data;
}

// A slug/id with NO Nexus presence at all (never published, not even a draft -- confirmed live
// this session: distinct from "exists but nothing published yet", which resolves the query fine
// and is handled separately below) makes the GraphQL request itself fail with a top-level
// {"errors":[{"code":"NOT_FOUND", "message":"Collection not found", ...}]} -- the raw form of that
// is an ugly JSON blob, not actionable. Gives a clean, specific message for exactly this case;
// returns null (meaning "not this case, rethrow the original error") otherwise.
function friendlyNotFoundError(e, slug) {
    if (e.graphqlErrors && e.graphqlErrors.some((g) => g.extensions && g.extensions.code === 'NOT_FOUND')) {
        return new Error(
            `No collection found on Nexus for id "${slug}". Double-check the id (from the ` +
            `collection's Nexus URL, e.g. nexusmods.com/.../collections/<id>) -- or it may ` +
            `genuinely not exist there yet if it's still Workshop-only and has never been published.`
        );
    }
    return null;
}

const REVISION_FIELDS = 'revisionNumber downloadLink fileSize status';

// collectionRevision(slug, revision) requires an explicit revision number -- passing null does NOT
// mean "latest" (confirmed live: returns a "CollectionRevision not found" GraphQL error). For
// "latest", go through collection(slug) { latestPublishedRevision { ... } } instead -- confirmed
// via schema introspection this field exists specifically for this purpose.
async function fetchCollectionRevision(apiKey, slug, revisionNumber) {
    if (revisionNumber) {
        const query = `query($slug: String!, $revision: Int!) { collectionRevision(slug: $slug, revision: $revision) { ${REVISION_FIELDS} collection { name slug } } }`;
        let data;
        try {
            data = await graphqlRequest(apiKey, query, { slug, revision: revisionNumber });
        } catch (e) {
            throw friendlyNotFoundError(e, slug) || e;
        }
        if (!data.collectionRevision) throw new Error(`No such collection/revision: slug="${slug}", revision=${revisionNumber}.`);
        return data.collectionRevision;
    }
    const query = `query($slug: String!) { collection(slug: $slug) { name slug latestPublishedRevision { ${REVISION_FIELDS} } } }`;
    let data;
    try {
        data = await graphqlRequest(apiKey, query, { slug });
    } catch (e) {
        throw friendlyNotFoundError(e, slug) || e;
    }
    if (!data.collection || !data.collection.latestPublishedRevision) {
        // Confirmed live: a collection with only a draft revision (never fully published) returns
        // null here even though collectionRevision(slug, revision: N) resolves it fine directly --
        // "latest published" and "latest" are genuinely different states on Nexus's side.
        throw new Error(`No PUBLISHED revision found for slug="${slug}" -- it may still be in draft. If you know the revision number (e.g. from the nxm:// "Add collection" link), enter it explicitly.`);
    }
    return { ...data.collection.latestPublishedRevision, collection: { name: data.collection.name, slug: data.collection.slug } };
}

// Lists a collection's real, saved revisions for a UI picker. CORRECTED this session after the
// user directly proved the original assumption wrong: `revisionStatus: "draft"` does NOT mean
// "nothing real here" -- it means "not made publicly listed/searchable yet" (tracks
// `collectionStatus: "unlisted"` at the collection level). A draft revision has a real, saved,
// fully-working download exactly like a published one -- proven directly twice: (1) successfully
// fetched a real, correct 79-mod collection.json from a revisionStatus:"draft" revision earlier
// this session; (2) the user showed a live Nexus page for a revisionStatus:"draft" revision with a
// real 22.0MB package and a working "Add collection" download button. The earlier version filtered
// to `revisionStatus === 'published'` only, which silently hid perfectly good, fetchable content
// for every one of the user's own still-"unlisted" collections -- since ALL of them are personal/
// unlisted, that filter made the whole feature useless for their actual, real use case. Every real
// revision the API returns is offered here now; revisionStatus is still surfaced per-entry (not
// dropped) so the picker can label draft-vs-published, not silently erase the distinction.
async function fetchCollectionRevisions(apiKey, slug) {
    const query = `query($slug: String!) {
        collection(slug: $slug) {
            name slug collectionStatus
            publicRevisions { revisionNumber revisionStatus createdAt updatedAt }
        }
    }`;
    let data;
    try {
        data = await graphqlRequest(apiKey, query, { slug });
    } catch (e) {
        throw friendlyNotFoundError(e, slug) || e;
    }
    if (!data.collection) throw new Error(`No collection found on Nexus for id "${slug}".`);
    const revisions = (data.collection.publicRevisions || []).slice().sort((a, b) => b.revisionNumber - a.revisionNumber);
    return {
        name: data.collection.name, slug: data.collection.slug,
        collectionStatus: data.collection.collectionStatus, revisions,
    };
}

// The one revision that actually reflects "when did I last touch this" for a private/unlisted
// Workshop collection -- deliberately NOT fetchCollectionRevisions' own default sort
// (revisionNumber descending). Confirmed real, live (2026-08-14): Nexus updates a draft/unlisted
// revision's CONTENT in place rather than assigning it a new revisionNumber, so a genuinely
// fresher revision can still sort BEHIND an older, larger revisionNumber if picked that way.
// updatedAt is the only field that actually reflects "was this the one most recently changed."
// Shared by rebuild-missing-routes.js's own refresh-from-Nexus flow (always-newest, no picker) and
// the Workshop Report (which shows this exact updatedAt as "Last updated on Nexus").
function resolveNewestRevision(revisions) {
    if (!revisions || revisions.length === 0) return null;
    return revisions.reduce((a, b) => (new Date(b.updatedAt) > new Date(a.updatedAt) ? b : a));
}

async function resolveRealDownloadUrl(apiKey, relativeLink) {
    const linkUrl = new URL(relativeLink, 'https://api.nexusmods.com');
    const res = await httpsRequest(linkUrl.href, {
        method: 'GET',
        headers: { 'APIKEY': apiKey, 'Application-Name': 'vortex-collection-extractor', 'Application-Version': '1.0.0' },
    });
    const text = res.body.toString('utf8');
    if (res.statusCode !== 200) throw new Error(`download_link fetch failed: HTTP ${res.statusCode}\n${text}`);
    const json = JSON.parse(text);
    const links = json.download_links || json;
    const uri = Array.isArray(links) ? (links[0] && (links[0].URI || links[0].uri)) : (links.URI || links.uri || links.url);
    if (!uri) throw new Error(`Could not find a URL in download_link response: ${text}`);
    return uri;
}

// onHeaders(res.headers), if given, fires once the real 200 response is confirmed (after
// following any redirects) -- lets a caller read Content-Disposition/Content-Type before the body
// is piped to disk. Existing callers pass no options and are unaffected.
function downloadToFile(url, destPath, { onHeaders } = {}) {
    return new Promise((resolve, reject) => {
        const doGet = (u, redirectsLeft) => {
            https.get(u, (res) => {
                if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                    if (redirectsLeft <= 0) return reject(new Error('Too many redirects'));
                    res.resume();
                    doGet(res.headers.location, redirectsLeft - 1);
                    return;
                }
                if (res.statusCode !== 200) {
                    const chunks = [];
                    res.on('data', (d) => chunks.push(d));
                    res.on('end', () => reject(new Error(`Download failed: HTTP ${res.statusCode}\n${Buffer.concat(chunks).toString('utf8').slice(0, 500)}`)));
                    return;
                }
                if (onHeaders) onHeaders(res.headers);
                let received = 0;
                res.on('data', (d) => { received += d.length; });
                const file = fs.createWriteStream(destPath);
                res.pipe(file);
                file.on('finish', () => {
                    file.close(() => {
                        if (!res.complete) reject(new Error(`Response ended prematurely -- received ${received} bytes.`));
                        else resolve();
                    });
                });
                file.on('error', reject);
                res.on('aborted', () => reject(new Error(`Response aborted after ${received} bytes.`)));
            }).on('error', reject);
        };
        doGet(url, 5);
    });
}

// Downloads the given collection's latest (or specific) published revision and extracts
// collection.json into destDir. Returns { collectionJsonPath, revisionNumber, status, collectionName, modCount }.
async function fetchAndExtractCollectionJson({ slug, revisionNumber, destDir, sevenZipExe }) {
    const { extractFile } = require('./sevenzip');
    const apiKey = resolveApiKey();
    const revision = await fetchCollectionRevision(apiKey, slug, revisionNumber);
    if (!revision.downloadLink) throw new Error(`Nexus returned no downloadLink for slug="${slug}" (revision status: ${revision.status}).`);
    const realUrl = await resolveRealDownloadUrl(apiKey, revision.downloadLink);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-collection-'));
    const bundlePath = path.join(tmpDir, `${slug}-r${revision.revisionNumber}.7z`);
    try {
        await downloadToFile(realUrl, bundlePath);
        fs.mkdirSync(destDir, { recursive: true });
        const extractedPath = await extractFile(sevenZipExe, bundlePath, 'collection.json', destDir);
        const parsed = JSON.parse(fs.readFileSync(extractedPath, 'utf8'));
        return {
            collectionJsonPath: extractedPath,
            revisionNumber: revision.revisionNumber,
            status: revision.status,
            collectionName: revision.collection && revision.collection.name,
            modCount: Array.isArray(parsed.mods) ? parsed.mods.length : 0,
        };
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

module.exports = { resolveApiKey, httpsRequest, fetchCollectionRevision, fetchCollectionRevisions, resolveNewestRevision, resolveRealDownloadUrl, downloadToFile, fetchAndExtractCollectionJson };
