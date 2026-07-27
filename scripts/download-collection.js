#!/usr/bin/env node
// Downloads a published collection's packaged bundle directly via Nexus's v2 GraphQL API,
// bypassing the nxm:// protocol handler entirely (which would otherwise launch Vortex). Confirmed
// via Nexus-Mods/node-nexus-api's own source (src/Nexus.ts's getCollectionRevisionGraph,
// src/types.ts's IRevision.downloadLink, src/parameters.ts's GRAPHQL_URL) that:
//   - the GraphQL endpoint is https://api.nexusmods.com/v2/graphql
//   - it accepts the SAME simple personal API key as the REST v1 API, via an "APIKEY" header
//     (not OAuth -- OAuth is an alternative, not a requirement)
//   - the collectionRevision query's IRevision type has a real downloadLink field
//
// Usage: node download-collection.js <collectionSlug> [revisionNumber] [--output <dir>]
// Example: node download-collection.js lxvyai 1

const fs = require('fs');
const path = require('path');
const https = require('https');
const appConfig = require('../lib/app-config');

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

async function getCollectionRevision(apiKey, slug, revisionNumber) {
    const query = `
        query($slug: String!, $revision: Int) {
            collectionRevision(slug: $slug, revision: $revision) {
                revisionNumber
                downloadLink
                fileSize
                status
                collection { name slug }
            }
        }
    `;
    const variables = { slug, revision: revisionNumber || null };
    const payload = JSON.stringify({ query, variables });

    const res = await httpsRequest('https://api.nexusmods.com/v2/graphql', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'APIKEY': apiKey,
            'Application-Name': 'vortex-collection-extractor-test',
            'Application-Version': '1.0.0',
        },
    }, payload);

    const text = res.body.toString('utf8');
    if (res.statusCode !== 200) {
        throw new Error(`GraphQL request failed: HTTP ${res.statusCode}\n${text}`);
    }
    const json = JSON.parse(text);
    if (json.errors) {
        throw new Error(`GraphQL errors: ${JSON.stringify(json.errors, null, 2)}`);
    }
    return json.data.collectionRevision;
}

function downloadFile(url, destPath) {
    return new Promise((resolve, reject) => {
        const doGet = (u, redirectsLeft) => {
            https.get(u, (res) => {
                console.log('  download response:', res.statusCode, 'content-length:', res.headers['content-length'], 'content-encoding:', res.headers['content-encoding']);
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
                let received = 0;
                res.on('data', (d) => { received += d.length; });
                const file = fs.createWriteStream(destPath);
                res.pipe(file);
                file.on('finish', () => {
                    file.close(() => {
                        if (!res.complete) {
                            reject(new Error(`Response ended prematurely -- received ${received} bytes, connection closed before full body arrived.`));
                        } else {
                            resolve();
                        }
                    });
                });
                file.on('error', reject);
                res.on('aborted', () => reject(new Error(`Response aborted after ${received} bytes.`)));
            }).on('error', reject);
        };
        doGet(url, 5);
    });
}

async function main() {
    const args = process.argv.slice(2);
    const slug = args[0];
    let revisionNumber = null;
    let outputDir = 'F:/Claude Temp Files';
    for (let i = 1; i < args.length; i++) {
        if (args[i] === '--output') outputDir = args[++i];
        else if (!isNaN(parseInt(args[i], 10))) revisionNumber = parseInt(args[i], 10);
    }
    if (!slug) {
        console.error('Usage: node download-collection.js <collectionSlug> [revisionNumber] [--output <dir>]');
        process.exit(2);
    }

    const apiKey = resolveApiKey();
    console.log(`Querying collection "${slug}"${revisionNumber ? ` revision ${revisionNumber}` : ' (latest)'}...`);
    const revision = await getCollectionRevision(apiKey, slug, revisionNumber);
    if (!revision) {
        console.error('No revision data returned (collection/revision not found, or not accessible).');
        process.exit(1);
    }
    console.log('Collection:', revision.collection?.name, '| revision:', revision.revisionNumber, '| status:', revision.status, '| fileSize:', revision.fileSize);
    console.log('downloadLink raw value:', JSON.stringify(revision.downloadLink));
    if (!revision.downloadLink) {
        console.error('No downloadLink in the response -- cannot proceed.');
        process.exit(1);
    }

    // downloadLink is a relative API path (e.g. "/v2/collections/470868/revisions/727911/download_link"),
    // not a direct URL -- it's a second endpoint that itself returns the actual signed download URL,
    // mirroring the v1 REST download_link.json pattern (premium-gated single/multi-mirror link).
    const linkUrl = new URL(revision.downloadLink, 'https://api.nexusmods.com');
    console.log('Fetching real download URL from:', linkUrl.href);
    const linkRes = await httpsRequest(linkUrl.href, {
        method: 'GET',
        headers: { 'APIKEY': apiKey, 'Application-Name': 'vortex-collection-extractor-test', 'Application-Version': '1.0.0' },
    });
    const linkText = linkRes.body.toString('utf8');
    console.log('download_link response:', linkRes.statusCode, linkText.slice(0, 500));
    if (linkRes.statusCode !== 200) {
        throw new Error(`download_link fetch failed: HTTP ${linkRes.statusCode}\n${linkText}`);
    }
    const linkJson = JSON.parse(linkText);
    const links = linkJson.download_links || linkJson;
    const realUrl = Array.isArray(links) ? (links[0]?.URI || links[0]?.uri) : (links.URI || links.uri || links.url);
    if (!realUrl) {
        throw new Error(`Could not find a URL field in download_link response: ${linkText}`);
    }

    fs.mkdirSync(outputDir, { recursive: true });
    const destPath = path.join(outputDir, `${slug}-revision-${revision.revisionNumber}.7z`);
    console.log(`Downloading to "${destPath}"...`);
    await downloadFile(realUrl, destPath);
    const stat = fs.statSync(destPath);
    console.log(`Done. Downloaded ${stat.size} bytes (expected ${revision.fileSize}).`);
}

main().catch((e) => {
    console.error('ERROR:', e.message);
    process.exit(1);
});
