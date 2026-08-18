'use strict';
// Optional, OPPORTUNISTIC HTTP client for the Vortex Collection Helper companion extension --
// F:\Claude Workspace\skyrim-modding\vortex-collection-helper (a separate project; read its own
// README.md/TECHNICAL.md for the full story). That extension runs INSIDE Vortex's own renderer
// process and exposes its live, in-memory Redux state over a small localhost-only HTTP server -- no
// WAL, no staleness window, no crash risk, at all, for whatever it covers. Confirmed live 2026-08-17
// against a real running Vortex: `GET /health` -> `{ok:true,gameId:"skyrimse"}`, `GET /rules/:modId`
// -> that mod's real, correctly-shaped `rules[]`.
//
// Director's explicit scoping (2026-08-18): prefer this when it's running, fall back to the existing
// state.v2 read path unchanged when it's not -- additive/opportunistic, never a replacement, since
// most users won't have this extra extension installed. Every function here therefore fails fast and
// silently on ANY error (not installed, Vortex not running, port not bound, a slow/hung response) and
// returns a falsy result for the caller to fall back on -- never throws, never hangs.
//
// 2026-08-18 update: the helper extension now ALSO exposes `GET /mods` -- the whole live
// `state.persistent.mods[gameId]` subtree plus which mods are enabled in the active profile, i.e.
// everything lib/rules-generator.js's buildModIndex needs, sourced live instead of from state.v2.
// Confirmed live against a real large install: a real response is ~46MB (4,555 mods, full Nexus
// metadata per mod) -- MUCH bigger than /health or /rules/:modId, so it gets its own longer timeout.
//
// 2026-08-18 update #1b: the helper extension now ALSO exposes `GET /downloads` -- the WHOLE live
// `state.persistent.downloads.files` subtree, same "dumb relay" shape as /mods but a structurally
// different Redux subtree, needed for Clean Up's own scanArchives (which reads BOTH mods### and
// downloads###files### state.v2 subtrees, unlike Cycle Helper/Rules Generator which only ever
// needed mods###).
//
// 2026-08-18 update #2: the helper extension now ALSO exposes `POST /rules/apply` -- the WRITE path.
// Dispatches Vortex's own real `addModRule`/`removeModRule` action creators (the SAME actions
// Vortex's own built-in Conflict Editor dispatches for a hand-made rule edit), not a database write.
// Deliberately a dumb relay: it does NOT resolve which rule to touch or compute the new one -- the
// caller supplies the exact, already-resolved `remove`/`add` rule objects (see
// lib/cycle-detector.js's `applyCandidateFix`/`revertFix`, which own that resolution logic).
//
// 2026-08-18 update #3 -- a real, director-reported connection reliability bug, investigated across
// FOUR rounds of live diagnosis rather than guessed at, and NOT fully resolved -- read this whole
// note before touching timeouts/retries/connection settings again, and see TECHNICAL.md's Cycle
// Helper section for the complete writeup. Real symptom: a genuine multi-step Cycle Helper session
// (Scan -> apply a fix -> re-scan -> apply another fix -> revert) against this project's own
// long-running dev server hit the "Vortex is currently running" modal repeatedly, despite the helper
// genuinely running throughout, and despite a plain `curl` to the exact same port succeeding
// instantly at the exact same moments.
//   Round 1 (STALE POOLED CONNECTION, global `fetch`/undici): switched to Node's classic `http`
//   module with `agent: false` to rule this out. The real failure reproduced anyway, with diagnostic
//   logging showing a genuine `timeout` on a request whose connection had JUST been freshly opened --
//   stale-socket-reuse was not the (or not the whole) mechanism.
//   Round 2 (VORTEX'S OWN EVENT LOOP BUSY): added a bounded retry to tolerate it. Disproved directly:
//   at the exact moments calls through this project's own server were timing out repeatedly, a
//   fresh `curl` process hit the same port instantly, every time. If Vortex's own event loop were the
//   bottleneck, curl would have been slow too.
//   Round 3 (PER-PROCESS CONNECTION CHURN): the failures were specific to this one long-running
//   process and self-healed after ~15-30s of no attempts, then broke again under renewed load --
//   tried a small dedicated `keepAlive` Agent (reusing a few long-lived connections instead of a
//   fresh one per call) to cut churn.
//   Round 4: the keep-alive Agent did NOT reliably fix it either -- re-reproduced the same "a couple
//   of calls succeed, then it gets stuck failing for an extended period" pattern with it in place,
//   sometimes better than `agent:false`, sometimes not, with no clearly reproducible trigger. Reverted
//   to `agent:false` (the simplest option, and never worse than the Agent in direct comparison) and
//   added a real, verified-correct load reduction instead: `lib/cycle-helper-runner.js`'s
//   `applyFixViaHelper` no longer makes a SECOND ~46MB `/mods` call for post-write validation -- it
//   predicts the result locally from the known remove/add pair, since `commit()` only returns
//   normally once Vortex's own reducer has genuinely accepted it. This measurably reduced (but did
//   not eliminate) how often the failure reproduced across repeated live testing.
//   HONEST CONCLUSION: after this investigation, the failure is real, intermittent, and NOT fully
//   understood -- it may be specific to this development machine/session's own unusually heavy,
//   repeated large-payload load (many dozens of 46MB fetches over hours of testing, well beyond any
//   normal usage pattern) rather than something a typical user would hit doing occasional Scan/Apply
//   clicks. The one bounded retry and the halved `/mods` load are real, verified, low-risk
//   improvements, kept regardless -- but this is NOT a confirmed complete fix, and the fallback to
//   state.v2 (see web/cycle-helper-routes.js) is what actually keeps a real failure from ever
//   blocking the user outright: it just means an occasional Apply-fix/Scan may need Vortex closed
//   that one time, exactly like before this feature existed.

const http = require('http');

const HELPER_HOST = '127.0.0.1';
const HELPER_PORT = 59595;
const HELPER_BASE_URL = `http://${HELPER_HOST}:${HELPER_PORT}`;
// Short by design -- see header comment; must never noticeably slow the common "not installed" case.
// That's genuinely true regardless of this value: "not installed" resolves via TCP connection-refused
// (confirmed live, ~18ms) rather than by waiting out the timeout, so raising this ceiling costs the
// common case nothing.
const HELPER_TIMEOUT_MS = 1500;
const MODS_TIMEOUT_MS = 5000; // /mods is a real, large payload (~46MB on a large real install) -- needs genuine headroom, not the short budget
const APPLY_TIMEOUT_MS = 2000; // a real write dispatch -- fast (two sequential Redux dispatches, no LevelDB, no disk I/O), but a write deserves more headroom than a plain health check; not the heavy /mods payload either, so it sits between the two

// `false` -- a fresh, disposable socket per call, never pooled/reused. See the header comment's
// round 3/4 notes: a small dedicated keep-alive Agent was tried here too and did NOT reliably fix
// the real failure (sometimes better, sometimes not, no clean win either way) -- reverted rather
// than kept as unproven complexity. `false` is the simplest option and was never worse in direct
// comparison.
const agent = false;

// One attempt, no retry -- returns { ok: true, data } | { ok: false, networkFailure: bool }.
// networkFailure distinguishes "never got a real response" (timeout, connection refused/reset --
// worth one retry, see helperFetch below) from "got a real non-2xx/malformed response" (retrying
// would just get the same answer again, not worth the extra round trip).
function helperFetchOnce(path, { timeoutMs, method, body }) {
    return new Promise((resolve) => {
        const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
        let settled = false;
        const finish = (result) => { if (!settled) { settled = true; resolve(result); } };

        const req = http.request({
            host: HELPER_HOST,
            port: HELPER_PORT,
            path,
            method,
            agent,
            headers: bodyStr !== undefined
                ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) }
                : undefined,
            timeout: timeoutMs,
        }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('error', () => finish({ ok: false, networkFailure: true })); // response stream broke mid-read -- didn't get a complete answer, worth retrying
            res.on('end', () => {
                if (res.statusCode < 200 || res.statusCode >= 300) { finish({ ok: false, networkFailure: false }); return; }
                try {
                    finish({ ok: true, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
                } catch {
                    finish({ ok: false, networkFailure: false }); // malformed JSON -- a real (if broken) response, not a network failure
                }
            });
        });
        // Node's own `timeout` option only fires this event -- it does NOT abort the request itself,
        // that's still this handler's own job.
        req.on('timeout', () => req.destroy(new Error('helperFetch timeout')));
        req.on('error', () => finish({ ok: false, networkFailure: true })); // not installed / Vortex not running / connection refused / reset / destroyed-after-timeout -- never reached a real response
        if (bodyStr !== undefined) req.write(bodyStr);
        req.end();
    });
}

// One bounded retry on a NETWORK-level failure only (timeout/refused/reset -- never on a real
// non-2xx response, which would just repeat the same answer). A real, low-risk mitigation kept from
// this investigation (see header comment) even though it doesn't fully eliminate the underlying
// intermittent failure -- tolerates a genuine one-off blip without masking a real "not installed"
// case, which fails via instant connection-refused on both the first attempt AND the retry, adding
// at most ~20ms.
async function helperFetch(path, { timeoutMs = HELPER_TIMEOUT_MS, method = 'GET', body } = {}) {
    const opts = { timeoutMs, method, body };
    const first = await helperFetchOnce(path, opts);
    if (first.ok) return first.data;
    if (!first.networkFailure) return null;
    const retry = await helperFetchOnce(path, opts);
    return retry.ok ? retry.data : null;
}

// True only if the helper extension is actually installed, running, AND scoped to the expected game.
async function checkHelperAvailable(gameId) {
    const data = await helperFetch('/health');
    return !!data && data.ok === true && (!gameId || data.gameId === gameId);
}

// modId's rules array straight from Vortex's own live in-memory state -- null on ANY failure
// (mod not found, timeout, connection refused, malformed response), never throws. Callers should
// only call this after checkHelperAvailable() has already confirmed the helper is up, to avoid
// paying the per-call timeout cost on every single mod when it's simply not installed.
async function getLiveRulesForMod(modId) {
    const data = await helperFetch(`/rules/${encodeURIComponent(modId)}`);
    return data && Array.isArray(data.rules) ? data.rules : null;
}

// { gameId, profileId, enabledModKeys, mods } straight from Vortex's own live state -- null on ANY
// failure, never throws. Callers should only call this after checkHelperAvailable() has already
// confirmed the helper is up (same reasoning as getLiveRulesForMod), since this is a much heavier
// request than a plain health check.
async function getAllMods() {
    const data = await helperFetch('/mods', { timeoutMs: MODS_TIMEOUT_MS });
    if (!data || !data.mods || typeof data.mods !== 'object' || !Array.isArray(data.enabledModKeys)) return null;
    return data;
}

// { gameId, files } straight from Vortex's own live `state.persistent.downloads.files` -- null on
// ANY failure, never throws. A structurally different subtree from getAllMods() above
// (state.persistent.downloads, not state.persistent.mods), so it's a separate call/endpoint rather
// than folded into /mods -- a caller that only needs the mods half (most callers) shouldn't pay for
// this one too. Same "only call after checkHelperAvailable" convention, same MODS_TIMEOUT_MS budget
// (a real large install's downloads list is a comparable-scale payload to /mods).
async function getAllDownloads() {
    const data = await helperFetch('/downloads', { timeoutMs: MODS_TIMEOUT_MS });
    if (!data || !data.files || typeof data.files !== 'object') return null;
    return data;
}

// Applies a real rule change through Vortex's own reducer -- `remove`/`add` are each
// `{type, reference} | undefined`, exactly Vortex's own IModRule shape, already fully resolved by
// the caller (this function does no rule-resolution of its own, matching the endpoint's own "dumb
// relay" contract). Returns `true` only on a genuine `{ok:true}` 200 response -- `false` on ANY
// failure (not reachable, non-200, network error, malformed response), never throws, same contract
// as every other function here. Callers should only call this after checkHelperAvailable() has
// already confirmed the helper is up.
//
// NOTE (see header comment): Vortex's own dispatch happens synchronously inside the extension's
// request handler BEFORE it writes a response. That means a network-level failure reported by THIS
// call can still mean the write genuinely succeeded server-side even though the caller sees `false`
// -- confirmed live during this investigation (a "failed" apply, re-checked via a fresh read, had
// actually taken effect). helperFetch's own one-retry-on-network-failure therefore carries a real,
// if narrow, double-dispatch risk specifically for this endpoint (a retry could re-apply a change
// that already landed) -- flagged here plainly rather than silently accepted. Not worth guarding
// against further right now: `remove` then `add` mirrors Vortex's own real reducer grouping
// semantics (a flip's `add` replaces-in-place within the same before/after group rather than
// appending, matching lib/cycle-detector.js's own makeLevelDbRuleIO commit), so a duplicate dispatch
// of the SAME pair is very likely a no-op in practice -- but this hasn't been exhaustively proven for
// every case (e.g. a duplicate re-add on top of an already-reverted 'remove'), so treat it as a real,
// open, low-probability edge case, not a closed one.
async function applyRuleChange(modId, remove, add) {
    const data = await helperFetch('/rules/apply', { timeoutMs: APPLY_TIMEOUT_MS, method: 'POST', body: { modId, remove, add } });
    return !!data && data.ok === true;
}

module.exports = { checkHelperAvailable, getLiveRulesForMod, getAllMods, getAllDownloads, applyRuleChange, HELPER_BASE_URL };
