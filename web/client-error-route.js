'use strict';
// POST /api/client-error -- the page tells the server what really threw when it was about to show
// "Can't Reach the Server" (a TypeError can be a network failure OR an ordinary bug in the page, and the
// message used to be identical). One masked line goes to the app log so the next occurrence says exactly
// what failed. Mounted BEFORE the app-wide express.json (so its own 2 KB cap applies) and AFTER the request
// guard (so it is same-origin, X-VCT only). At most 20 a minute; the rest are dropped with a 429.

const express = require('express');

const MAX_BODY = '2kb';
const MAX_PER_MINUTE = 20;
const MAX_FIELD = 400;

// No user name in a path, no query strings (they can carry keys), no long token-looking strings.
function maskText(value) {
    return String(value == null ? '' : value)
        .replace(/([A-Za-z]:[\\/]+Users[\\/]+)[^\\/\s]+/gi, '$1<user>')
        .replace(/(\/Users\/|\/home\/)[^/\s]+/g, '$1<user>')
        .replace(/\?[^\s)"']*/g, '?<query>')
        .replace(/(apikey|api_key|token|authorization|password|secret)(["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, '$1$2<hidden>')
        .replace(/\b[A-Za-z0-9+/_=-]{32,}\b/g, '<hidden>')
        .replace(/[\r\n]+/g, ' | ')
        .slice(0, MAX_FIELD);
}

function formatLine(b) {
    const stack = Array.isArray(b.stack) ? b.stack.slice(0, 3).map(maskText).join(' | ') : maskText(b.stack);
    return `[client-error] ${maskText(b.name)}: ${maskText(b.message)} | url=${maskText(b.url)} | page=${maskText(b.page)} | after=${Number(b.seconds) || 0}s | stack=${stack}`;
}

function createClientErrorRouter({ log = (line) => console.warn(line), now = () => Date.now() } = {}) {
    const router = express.Router();
    let windowStart = 0;
    let count = 0;
    router.post('/', express.json({ limit: MAX_BODY }), (req, res) => {
        const t = now();
        if (t - windowStart >= 60000) { windowStart = t; count = 0; }
        count += 1;
        if (count > MAX_PER_MINUTE) return res.status(429).json({ error: 'too-many' });
        const b = req.body && typeof req.body === 'object' ? req.body : {};
        log(formatLine(b));
        res.json({ ok: true });
    });
    // Too big or not JSON: a quiet refusal instead of the default error page with a stack trace.
    router.use((err, req, res, next) => {
        res.status(err && err.status === 413 ? 413 : 400).json({ error: 'refused' });
    });
    return router;
}

module.exports = { createClientErrorRouter, maskText, formatLine };
