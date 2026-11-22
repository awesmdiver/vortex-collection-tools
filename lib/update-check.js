'use strict';
// Tells the person when a newer release of this tool exists. One GET of GitHub's public "latest
// release" answer, about 20 s after start and then every 24 h. Sends nothing from the person's data
// (no key, no id; only the User-Agent below) and keeps the answer in memory only. Any failure
// (offline, rate-limited, a bad answer) is silent: the state simply stays "nothing newer".

const https = require('https');

const RELEASE_URL = 'https://api.github.com/repos/awesmdiver/vortex-collection-tools/releases/latest';
const FIRST_CHECK_MS = 20 * 1000;
const EVERY_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 8000;
const MAX_BYTES = 512 * 1024;

// "v1.6.2", "1.6.2", "1.7.0-beta.1" -> { nums:[1,6,2], pre:'beta.1' }; null when it is not a version.
function parseVersion(text) {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(text || '').trim());
    if (!m) return null;
    return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] || '' };
}

// >0 when a is newer than b. A tail (beta, test) sorts below the same number without one.
function compareVersions(a, b) {
    const pa = parseVersion(a), pb = parseVersion(b);
    if (!pa || !pb) return NaN;
    for (let i = 0; i < 3; i++) if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] > pb.nums[i] ? 1 : -1;
    if (pa.pre === pb.pre) return 0;
    if (!pa.pre) return 1;
    if (!pb.pre) return -1;
    const sa = pa.pre.split('.'), sb = pb.pre.split('.');
    for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
        if (sa[i] === undefined) return -1;
        if (sb[i] === undefined) return 1;
        const na = /^\d+$/.test(sa[i]), nb = /^\d+$/.test(sb[i]);
        if (na && nb) { if (Number(sa[i]) !== Number(sb[i])) return Number(sa[i]) > Number(sb[i]) ? 1 : -1; }
        else if (na !== nb) return na ? -1 : 1;
        else if (sa[i] !== sb[i]) return sa[i] > sb[i] ? 1 : -1;
    }
    return 0;
}

// Only a release page on github.com is ever handed to the page.
function safeReleaseUrl(url) {
    try {
        const u = new URL(String(url));
        if (u.protocol === 'https:' && u.hostname === 'github.com' && !u.username && !u.password) return u.href;
    } catch { /* not an address */ }
    return null;
}

// Turns GitHub's answer into { tag, url } when it is a newer, normal release; otherwise null.
function evaluateRelease(body, currentVersion) {
    if (!body || typeof body !== 'object' || body.draft === true || body.prerelease === true) return null;
    const tag = typeof body.tag_name === 'string' ? body.tag_name.trim() : '';
    const url = safeReleaseUrl(body.html_url);
    if (!url || !parseVersion(tag)) return null;
    return compareVersions(tag, currentVersion) > 0 ? { tag: tag.replace(/^v/i, ''), url } : null;
}

function fetchLatest(getter) {
    return new Promise((resolve) => {
        let done = false;
        const finish = (v) => { if (!done) { done = true; resolve(v); } };
        try {
            const req = (getter || https.get)(RELEASE_URL, {
                headers: { 'User-Agent': 'vortex-collection-tools', Accept: 'application/vnd.github+json' },
                timeout: TIMEOUT_MS,
            }, (res) => {
                if (res.statusCode !== 200) { res.resume(); return finish(null); }
                const chunks = []; let size = 0;
                res.on('data', (c) => { size += c.length; if (size > MAX_BYTES) { res.destroy(); finish(null); } else chunks.push(c); });
                res.on('end', () => { try { finish(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { finish(null); } });
                res.on('error', () => finish(null));
            });
            req.on('timeout', () => { req.destroy(); finish(null); });
            req.on('error', () => finish(null));
        } catch { finish(null); }
    });
}

function createUpdateChecker({ currentVersion, getter } = {}) {
    let state = { newer: false, tag: null, url: null, checkedAt: null };
    let first = null, every = null;
    async function checkNow() {
        try {
            const body = await fetchLatest(getter);
            if (body === null) return state; // failed: keep whatever we knew
            const hit = evaluateRelease(body, currentVersion);
            state = hit ? { newer: true, tag: hit.tag, url: hit.url, checkedAt: Date.now() }
                : { newer: false, tag: null, url: null, checkedAt: Date.now() };
        } catch { /* silent */ }
        return state;
    }
    function start() {
        first = setTimeout(() => { checkNow(); every = setInterval(checkNow, EVERY_MS); if (every.unref) every.unref(); }, FIRST_CHECK_MS);
        if (first.unref) first.unref();
    }
    function stop() { clearTimeout(first); clearInterval(every); }
    return { checkNow, start, stop, getState: () => state };
}

module.exports = { createUpdateChecker, compareVersions, parseVersion, evaluateRelease, safeReleaseUrl, RELEASE_URL, FIRST_CHECK_MS, EVERY_MS };
