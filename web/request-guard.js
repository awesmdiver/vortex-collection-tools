'use strict';
// Keeps other websites out of this local server. A page open in the same browser can still reach
// 127.0.0.1, so binding to loopback alone is not enough. This runs before routing and before
// express.json, and refuses with a small JSON error. Same checks as the Vortex Bridge and ModPacer
// guards -- keep the three consistent.
//
//   1. Host must be 127.0.0.1:<port> or localhost:<port> (plus config.host:<port> when it was set
//      to a specific address on purpose). Anything else is DNS rebinding -> 403.
//   2. An Origin header is accepted only when it is this server's own page; Sec-Fetch-Site:
//      cross-site is refused -> 403.
//   3. POST/PUT/PATCH/DELETE must carry X-VCT: 1 (a custom header cannot be sent cross-site
//      without a CORS preflight, and this server never grants one) -> 403. A request with a body
//      must be application/json -> 415.
//
// This server sends no Access-Control-* headers anywhere, and must not start to.

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
// Bind addresses that are not something a client puts in a Host header.
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '[::]', '']);

function allowedHosts({ host, port }) {
    const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    const configured = String(host || '').trim().toLowerCase();
    if (!WILDCARD_HOSTS.has(configured)) hosts.add(`${configured}:${port}`);
    return hosts;
}

function hasBody(req) {
    const len = Number(req.headers['content-length']);
    return (Number.isFinite(len) && len > 0) || req.headers['transfer-encoding'] !== undefined;
}

// Returns null when the request is fine, else { status, message, reason }.
function checkRequest(req, hosts) {
    const host = String(req.headers.host || '').toLowerCase();
    if (!hosts.has(host)) {
        return { status: 403, reason: 'foreign Host', message: 'Request refused: this server only answers requests addressed to it on this computer.' };
    }
    const origin = req.headers.origin;
    if (origin !== undefined && origin.toLowerCase() !== `http://${host}`) {
        return { status: 403, reason: 'foreign Origin', message: 'Request refused: it came from another website.' };
    }
    if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') {
        return { status: 403, reason: 'cross-site request', message: 'Request refused: it came from another website.' };
    }
    if (MUTATING.has(req.method)) {
        if (req.headers['x-vct'] !== '1') {
            return { status: 403, reason: 'missing X-VCT header', message: 'Request refused: it did not come from this tool\'s own page.' };
        }
        if (hasBody(req) && !/^application\/json\s*(;|$)/i.test(String(req.headers['content-type'] || ''))) {
            return { status: 415, reason: 'body is not application/json', message: 'Request refused: the body must be JSON.' };
        }
    }
    return null;
}

function createRequestGuard({ host, port }) {
    const hosts = allowedHosts({ host, port });
    return function requestGuard(req, res, next) {
        const refusal = checkRequest(req, hosts);
        if (!refusal) return next();
        // Path only: no query string, no body.
        console.warn(`[security] refused ${req.method} ${String(req.url).split('?')[0]} -- ${refusal.reason}`);
        res.status(refusal.status).json({ error: 'request-refused', message: refusal.message });
    };
}

module.exports = { createRequestGuard, allowedHosts, checkRequest };
