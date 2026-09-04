'use strict';
// Optional, OPPORTUNISTIC HTTP client for the Vortex Collection Helper companion extension --
// F:\Claude Workspace\vortex-tools\vortex-collection-helper (a separate project; read its own
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
//
// A DIFFERENT, now-CONFIRMED case, not the same mystery as above (2026-08-18): the helper genuinely,
// reproducibly blocks during a real Vortex deploy -- confirmed real (a fresh curl DID fail this time,
// unlike Round 2's disproof above) and root-caused via real source: mod_management/util/
// activationStore.ts's saveActivation does synchronous JSON.stringify+JSON.parse+msgpack.encode+
// writeAtomicSync on the WHOLE current mod-type deployment (not just the one mod being deployed --
// confirmed empirically too: a 227K-file mod and a 2K-file mod produced near-identical disruption).
// deployMod's own real DEPLOY_TIMEOUT_MS=30_000 has real, confirmed margin (two real single-mod test
// runs completed in 5.8s/11.9s) and Update Collection v2's own sequential apply loop is safe from this
// by construction (each step awaited before the next fires) -- the real, residual, NOT-yet-mitigated
// risk is a concurrent native `deploy-mods` (confirmed live: ~83s of near-continuous unavailability)
// racing a shorter-timeout helper call from somewhere else. See TECHNICAL.md's own "A DIFFERENT, now
// CONFIRMED case" section (right after this file's own Round 1-4 writeup) for the full investigation.

const http = require('http');
const semver = require('semver'); // already a real dependency of this project -- see isHelperOutdated below

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
const SET_ATTRIBUTES_TIMEOUT_MS = 2000; // same shape as APPLY_TIMEOUT_MS -- a single dispatch, no disk I/O
const DEPLOY_TIMEOUT_MS = 30_000; // real file I/O (hardlink/symlink creation) for one mod's files -- genuinely needs headroom, matching this project's own isolated-worker OP_TIMEOUT_MS convention
const SET_ENABLED_TIMEOUT_MS = 2000; // same shape as SET_ATTRIBUTES_TIMEOUT_MS -- a single dispatch, no disk I/O
const GET_PLUGIN_TIMEOUT_MS = 1500; // a plain state.loadOrder[id] lookup -- same shape/budget as HELPER_TIMEOUT_MS, not a heavy payload like /mods
const SET_PLUGIN_ENABLED_TIMEOUT_MS = 2000; // same shape as SET_ENABLED_TIMEOUT_MS -- a single dispatch, no disk I/O
const CREATE_MOD_TIMEOUT_MS = 2000; // a Redux dispatch plus fs.ensureDirAsync for ONE new folder -- tiny disk I/O (a single mkdir, the real extraction already happened before this is ever called), same order of magnitude as SET_ATTRIBUTES/SET_ENABLED, not DEPLOY_TIMEOUT_MS's real file-linking work
const REMOVE_TIMEOUT_MS = 30_000; // real file I/O (purge deployed links + delete staging folder) -- same headroom as deploy
// Batch timeouts (2026-08-27) -- same per-call cost as the singular versions above, just repeated
// across a whole apply's worth of mods (dozens, realistically) inside ONE HTTP request instead of
// one request per mod. Generous flat budgets rather than a per-item multiplier -- a real collection
// update is bounded by how many mods a revision actually adds, not an unbounded stream.
const APPLY_BATCH_TIMEOUT_MS = 8000; // pure Redux batchDispatch, no disk I/O -- same shape as APPLY_TIMEOUT_MS, wider budget for the whole array
const SET_ENABLED_BATCH_TIMEOUT_MS = 8000; // same shape as APPLY_BATCH_TIMEOUT_MS
const CREATE_MOD_BATCH_TIMEOUT_MS = 20_000; // still real per-item fs.ensureDirAsync (see CREATE_MOD_TIMEOUT_MS), just looped across the whole array server-side
// The REAL, full deploy pipeline across every enabled mod, not one mod -- a genuinely
// whole-collection-scale operation, same order of magnitude as this project's own
// MERGE_OP_TIMEOUT_MS (lib/merge-runner.js, "a large collection's worth of plugins can take a
// while"). LOOT's own plugin sort alone can run 20s+ on a large load order (confirmed,
// docs/VORTEX-PLUGIN-SORT-REFERENCE.md), on top of real file I/O for every mod.
const DEPLOY_ALL_TIMEOUT_MS = 10 * 60 * 1000;
const DEPLOY_ALL_PROGRESS_TIMEOUT_MS = 2000; // a plain state-snapshot read -- see getDeployAllProgress's own comment for why this can still legitimately fail mid-deploy

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
//
// Every failure branch below logs the REAL reason (2026-08-27 -- root-caused from a live report:
// Update Collection's Apply Result showed 5 "Couldn't read this mod's current live rules" failures
// with nothing anywhere explaining why, because this function threw the real reason away at every
// single failure point, reducing it to a bare boolean every caller in this file inherits). Log
// level mirrors the SAME networkFailure split the code already makes for retry purposes, not an
// arbitrary new one: networkFailure:true (res/req 'error', including timeout) is exactly the class
// this file's own header comment already treats as normal/expected/silent-by-design (Helper not
// installed resolves via instant connection-refused) and gets one automatic retry at the
// helperFetch layer below, so console.warn; networkFailure:false (non-2xx, malformed JSON) means a
// REAL response came back but something is genuinely wrong with it, never retried, so console.error.
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
            res.on('error', (err) => { // response stream broke mid-read -- didn't get a complete answer, worth retrying
                console.warn(`[helper] ${method} ${path} -- response stream broke mid-read: ${err && err.message}`);
                finish({ ok: false, networkFailure: true });
            });
            res.on('end', () => {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    // Best-effort: the Helper's own error routes (e.g. /rules/apply) return a real
                    // JSON body ({error: err.message}) on a non-2xx, but every caller of this function
                    // used to see only a bare `ok:false` -- the actual reason was read off the wire
                    // and then thrown away. Surfaced here as errorDetail so a caller that cares (see
                    // applyRuleChange below) can report something more useful than "it failed" when a
                    // rule write is rejected. Parse failure here just means no detail available, same
                    // as before this change -- never treated as a different kind of failure.
                    let errorDetail;
                    try {
                        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                        if (parsed && typeof parsed.error === 'string') errorDetail = parsed.error;
                    } catch { /* no parseable body -- errorDetail stays undefined */ }
                    console.error(`[helper] ${method} ${path} -- non-2xx response: HTTP ${res.statusCode}${errorDetail ? ` (${errorDetail})` : ''}`);
                    finish({ ok: false, networkFailure: false, errorDetail });
                    return;
                }
                try {
                    finish({ ok: true, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
                } catch (parseErr) { // malformed JSON -- a real (if broken) response, not a network failure
                    console.error(`[helper] ${method} ${path} -- malformed JSON response: ${parseErr.message}`);
                    finish({ ok: false, networkFailure: false });
                }
            });
        });
        // Node's own `timeout` option only fires this event -- it does NOT abort the request itself,
        // that's still this handler's own job. req.destroy(err) below emits 'error' with this SAME
        // err, so the req.on('error') handler's own log line already reads "helperFetch timeout" for
        // this case -- no separate timeout-specific log needed.
        req.on('timeout', () => req.destroy(new Error('helperFetch timeout')));
        req.on('error', (err) => { // not installed / Vortex not running / connection refused / reset / destroyed-after-timeout -- never reached a real response
            console.warn(`[helper] ${method} ${path} -- ${err && err.message}`);
            finish({ ok: false, networkFailure: true });
        });
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
    if (retry.ok) return retry.data;
    // Both attempts already logged their own specific reason above -- this line is what makes a
    // persisted failure distinguishable in the log from a transient blip that recovered on retry
    // (which would show only the first attempt's warn line, then a normal, silent success).
    console.warn(`[helper] ${method} ${path} -- giving up after retry (both attempts failed)`);
    return null;
}

// True only if the helper extension is actually installed, running, AND scoped to the expected game.
async function checkHelperAvailable(gameId) {
    const data = await helperFetch('/health');
    return !!data && data.ok === true && (!gameId || data.gameId === gameId);
}

// Full /health payload (including the helper's own reported version, 2026-08-23) for display
// purposes -- Settings' "what am I running" panel. Separate from checkHelperAvailable rather than
// changing that function's own boolean contract, which every other caller in this project relies on.
// null on any failure (helper not installed/not running), same "never throws" convention as every
// other read in this file.
async function getHelperHealth() {
    return helperFetch('/health');
}

// The oldest Helper version this app's own code actually works correctly against.
//
// BUMP THIS whenever this project starts relying on a real fix or endpoint that only exists in a
// newer Helper -- not a nice-to-have. Bumping it is the ONLY thing needed to start warning users;
// the Settings banner reads it straight through GET /api/settings/helper-info.
//
// 0.19.0 (2026-09-02, v1.4.0 release): Duplicate Version Cleanup -- one of this release's two Beta
// tools -- calls removeDownloads (lib/duplicate-version-cleanup.js), which wraps the Helper's
// POST /downloads/remove endpoint (removeDownloadAndFile, commit bafde3e) -- absent before 0.19.0,
// so the Clean step would fail against an older Helper this check would otherwise call "fine."
// 0.19.0 also carries a persistence fix to removeDownloadRecordOnly (commit d5d9f96).
//
// 0.12.0 (2026-08-23, superseded floor, kept for history): carried the null->undefined
// normalization in the Helper's own /mods/set-attributes, which Clear Update Flags depends on to
// genuinely clear a flag rather than store a literal null. A 22-commits-behind Helper is exactly
// what made Clear Update Flags miscount for a while that session, silently, with nothing anywhere
// pointing at the Helper as the cause -- which is the whole reason this check exists.
const MIN_HELPER_VERSION = '0.19.0';

// True when a CONNECTED Helper is older than this app needs. Callers must only ask this once they
// already know the Helper is genuinely connected -- "not connected at all" is a different state with
// its own established handling ("Vortex Connection Required"), deliberately not conflated here.
//
// A missing version counts as outdated, and that's a real inference rather than a guess: the Helper
// only started reporting its own version in /health at all in the same series that produced the fix
// MIN_HELPER_VERSION points at, so a connected Helper that reports nothing is necessarily older than
// the minimum. An unparseable version is treated the same way -- warning about a Helper that turns
// out to be fine is a far cheaper failure than silently wrong results from one that isn't.
function isHelperOutdated(version) {
    if (!version) return true;
    const clean = semver.valid(semver.coerce(version));
    if (!clean) return true;
    return semver.lt(clean, MIN_HELPER_VERSION);
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

// Every real Vortex profile for this game, live -- { gameId, profiles: [{profileId, gameId, name}],
// activeProfileId } straight from Vortex's own in-memory state, or null on ANY failure (not
// installed/running, timeout, older Helper without this endpoint yet). Same "only call after
// checkHelperAvailable" convention as every other read here. Added for Save Cleaner's per-profile
// save folder support -- turns a save folder's raw profile-ID name into a real display name without
// ever needing Vortex closed (see web/save-cleaner-routes.js's attachProfileNames, which falls back
// to the existing state.v2 read -- Vortex-must-be-closed -- only when this returns null).
async function getLiveProfiles() {
    const data = await helperFetch('/profiles');
    return data && Array.isArray(data.profiles) ? data : null;
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

// Detailed variant (2026-08-31, director-caught gap): same real write as applyRuleChange above, but
// preserves the Helper's own error detail (or a plain "couldn't reach it" note) instead of collapsing
// everything to a bare boolean -- confirmed real: a live "Couldn't apply a rule change for X" during
// this session carried zero information about WHY, because helperFetch() throws away a non-2xx
// response's body entirely, and even a clean success/failure distinction (a genuine Helper rejection
// vs. a network hiccup) never reached the caller. Used by applyCollectionModRules, which actually
// surfaces the failure reason to the user; every other applyRuleChange() call site above keeps the
// plain boolean since their own error handling never displays detail -- no reason to touch 5 call
// sites that don't need it.
async function applyRuleChangeDetailed(modId, remove, add) {
    const opts = { timeoutMs: APPLY_TIMEOUT_MS, method: 'POST', body: { modId, remove, add } };
    const first = await helperFetchOnce('/rules/apply', opts);
    if (first.ok) return { ok: !!(first.data && first.data.ok === true) };
    if (!first.networkFailure) return { ok: false, error: first.errorDetail };
    // One retry on a genuine network failure only -- same reasoning as helperFetch's own (a real
    // rejection is deterministic and not worth retrying; a network hiccup might not repeat).
    const retry = await helperFetchOnce('/rules/apply', opts);
    if (retry.ok) return { ok: !!(retry.data && retry.data.ok === true) };
    return { ok: false, error: retry.errorDetail || "Couldn't reach Vortex to apply this rule change." };
}

// Batch form of applyRuleChange (2026-08-27, director-caught excess-call-count finding) -- see the
// Helper extension's own applyRuleChangesBatch header comment for the full "why" (real Vortex
// batches every collection-membership-rule write this same way, never one dispatch per mod).
// `items`: [{modId, remove?, add?}, ...]. Returns the per-item results array (each
// `{modId, ok, error?}`) on a genuine `{ok:true}` response, or `null` on ANY failure (not reachable,
// non-200, network error, malformed response) -- same "never throws" contract as every other
// function here, just returning an array instead of a boolean since a batch can be worth partial
// credit. Same one-bounded-retry-on-network-failure caveat as the singular applyRuleChange's own
// header comment (a lost response after a real server-side dispatch is the same open, low-
// probability risk, just amplified across the whole array) -- not worth a different contract here.
async function applyRuleChangesBatch(items) {
    const data = await helperFetch('/rules/apply-batch', { timeoutMs: APPLY_BATCH_TIMEOUT_MS, method: 'POST', body: { items } });
    return (data && data.ok === true && Array.isArray(data.results)) ? data.results : null;
}

// Sets one or more attributes on an already-registered mod's own live state (version/fileMD5/
// fileId/fileSize/source/archiveId, etc.) -- the metadata refresh Update Collection v2's own Phase 2
// runs after a fast, in-place re-extraction (see lib/rebuild-mod.js), so Vortex's own UI shows
// correct info for that mod afterward without ever going through its own slow InstallManager
// reinstall. Same "one bounded retry on network failure only" contract as every other write here --
// idempotent by nature (setting the same attributes twice is harmless), so the retry carries no
// double-dispatch risk the way applyRuleChange's own retry does.
async function setModAttributes(modId, attributes) {
    const data = await helperFetch('/mods/set-attributes', { timeoutMs: SET_ATTRIBUTES_TIMEOUT_MS, method: 'POST', body: { modId, attributes } });
    return !!data && data.ok === true;
}

// Re-links one mod's CURRENT staging content into the game's Data folder via Vortex's own real
// deploy-single-mod event -- always re-reads that mod's on-disk content fresh, so this correctly
// picks up files a caller just re-extracted. `enable` defaults true (deploy); pass false to
// deactivate/un-link instead. Genuinely idempotent in practice (re-running the same link creation is
// harmless), so the network-failure retry is safe here too.
async function deployMod(modId, enable) {
    const data = await helperFetch('/mods/deploy', { timeoutMs: DEPLOY_TIMEOUT_MS, method: 'POST', body: { modId, enable } });
    return !!data && data.ok === true;
}

// Flips a mod's PROFILE-level Enabled/Disabled flag (the Mods table's own checkbox) -- a genuinely
// SEPARATE concern from deployMod's own `enable` argument. Confirmed live 2026-08-18: deploy-single-
// mod's enable flag only controls file-linking (activator.activate/deactivate); it never touches
// persistent.profiles[profileId].modState[modId].enabled, so calling deployMod(id, false) alone does
// NOT restore a mod's Disabled status -- it leaves the Mods table checkbox showing Enabled while the
// files happen to be unlinked, which Vortex's own next native deploy pass would silently undo (it
// re-links anything the profile still says is enabled). Preserving a real Disabled choice needs BOTH
// this call (fixes the flag Vortex's own deploy logic actually reads) and deployMod(id, false) (un-
// links the files immediately, so nothing is left in an inconsistent pending-deploy state). Same
// idempotent-dispatch reasoning as setModAttributes -- safe to retry on a network failure.
async function setModEnabled(modId, enable) {
    const data = await helperFetch('/mods/set-enabled', { timeoutMs: SET_ENABLED_TIMEOUT_MS, method: 'POST', body: { modId, enable } });
    return !!data && data.ok === true;
}

// Batch form of setModEnabled (2026-08-27, director-caught excess-call-count finding) -- see the
// Helper extension's own setModsEnabledBatch header comment. `items`: [{modId, enable}, ...], all
// against the SAME active profile (resolved server-side, same as the singular endpoint). Returns the
// per-item results array on a genuine `{ok:true}` response, or `null` on ANY failure -- same
// contract as applyRuleChangesBatch above.
async function setModsEnabledBatch(items) {
    const data = await helperFetch('/mods/set-enabled-batch', { timeoutMs: SET_ENABLED_BATCH_TIMEOUT_MS, method: 'POST', body: { items } });
    return (data && data.ok === true && Array.isArray(data.results)) ? data.results : null;
}

// One PLUGIN's own live enabled/loadOrder state straight from Vortex's `state.loadOrder` -- a
// SEPARATE Redux slice from a mod's own profile-level enabled flag (see setModEnabled's own header
// comment for that distinction). Returns null on ANY failure (not reachable, malformed response),
// never throws -- same contract as every other read here. `pluginName` is the raw filename (e.g.
// "DynDOLOD.esp") -- case/basename/.ghost handling all happen server-side (Helper extension's own
// getPluginLoadOrder), so callers pass it exactly as it appears in plugins.txt. `found: false` in the
// response is a real, valid state (Vortex has no live loadOrder entry for this plugin at all), not an
// error -- confirmed live 2026-08-21: a plugin whose owning mod is fully undeployed drops out of
// state.loadOrder entirely rather than lingering with enabled:false.
//
// IMPORTANT, confirmed live: plugins.txt (the on-disk file the actual game reads) is only a snapshot
// Vortex writes out during a real deploy -- it can lag behind this live state indefinitely until a
// deploy actually runs. Prefer this over reading plugins.txt directly whenever "what does Vortex
// itself currently think" is the real question; prefer plugins.txt/on-disk file-existence whenever
// "what will PGPatcher/the game actually see right now" is the real question (those two can
// legitimately disagree until the next deploy).
async function getPluginLoadOrder(pluginName) {
    const data = await helperFetch(`/plugins/${encodeURIComponent(pluginName)}`, { timeoutMs: GET_PLUGIN_TIMEOUT_MS });
    return data && typeof data === 'object' ? data : null;
}

// Flips ONE plugin's own live enabled flag directly -- confirmed live 2026-08-21 (see the Helper
// extension's own setPluginEnabledAction header comment for the full verification writeup: this is
// what Vortex's real "Enable all" notification button dispatches, a plain {type:
// 'SET_PLUGIN_ENABLED', payload} object, not an imported action creator). Genuinely idempotent (re-
// setting the same enabled value twice is harmless), so the standard one-retry-on-network-failure
// contract is safe here too.
//
// Precisely scoped to this ONE plugin -- unlike setModEnabled (which disables an entire mod's worth
// of files, collateral damage and all), this touches nothing else. STILL only an in-memory flag flip
// though: a subsequent deployAllMods() is required to reconcile plugins.txt on disk, same "flag vs.
// deployed reality" split as setModEnabled/deployMod above, one layer down.
async function setPluginEnabled(pluginName, enable) {
    const data = await helperFetch(`/plugins/${encodeURIComponent(pluginName)}/set-enabled`, { timeoutMs: SET_PLUGIN_ENABLED_TIMEOUT_MS, method: 'POST', body: { enabled: enable } });
    return !!data && data.after && data.after.enabled === enable;
}

// Registers a BRAND NEW mod with Vortex's own live state via its real create-mod event -- Update
// Collection v2's own Phase 3 (2026-08-18), installing a collection revision's newly-Added mods for
// real, the SAME real registration step Vortex's own native "Add Mods" flow uses (mod_management/
// index.ts's `api.events.emit('create-mod', gameMode, mod, callback)`). `mod` is the full real IMod
// shape (id/state/type/installationPath/attributes) -- the caller builds it, this is a dumb relay
// like every other write here. Idempotent in practice (re-registering the same modId just overwrites
// the same Redux entry; ensureDirAsync on an already-existing folder is a no-op), so the standard
// one-retry-on-network-failure contract is safe here too.
async function createMod(modId, mod) {
    const data = await helperFetch('/mods/create', { timeoutMs: CREATE_MOD_TIMEOUT_MS, method: 'POST', body: { modId, mod } });
    return !!data && data.ok === true;
}

// Registers a self-downloaded archive into Vortex's own real downloads database, via the real
// ADD_LOCAL_DOWNLOAD action -- root-cause fix (2026-08-28) for spurious Version-column "variant"
// duplicates: without this, a mod created via createMod() for an archive vortex-collection-tools
// downloaded itself (bypassing Vortex's own download manager entirely) has NO archiveId at all on
// its own live record, and Vortex's real grouping logic (InstallManager.ts's checkModVariantsExist)
// then incorrectly groups every mod sharing that same missing archiveId as if they were variants of
// each other. `id` is caller-generated (a fresh crypto.randomUUID()) so the caller can use the SAME
// id as the new mod's own archiveId attribute without a second round trip to ask what got assigned.
// Returns the confirmed archiveId (== the id passed in) on success, or null on any failure -- same
// "never throws" contract as every other function here.
async function registerLocalDownload(id, fileName, fileSize) {
    const data = await helperFetch('/downloads/register-local', { timeoutMs: CREATE_MOD_TIMEOUT_MS, method: 'POST', body: { id, fileName, fileSize } });
    return (data && data.ok === true) ? data.archiveId : null;
}

// Removes ONLY a download's own tracked record from Vortex's downloads list -- the archive FILE on
// disk is never touched (see the Helper's own removeDownloadRecordOnly header comment for the full
// real reasoning: Vortex's own higher-level api.removeDownload() extension method always deletes the
// file, confirmed via direct source read, with no way to opt out -- this dispatches the raw Redux
// action instead, confirmed a pure state removal in every one of Vortex's own real call sites).
// Built for the duplicate-version cleanup work (2026-08-30) --
// diagnostics/2026-08-30-duplicate-version-cleanup-utility-scoping.md has the full investigation
// this exists to act on. Same REMOVE_TIMEOUT_MS budget /mods/remove-record-only already uses (a
// plain Redux dispatch per id, no disk I/O -- generous headroom for a real multi-item batch).
async function removeDownloadRecordOnly(downloadIds) {
    const data = await helperFetch('/downloads/remove-record-only', { timeoutMs: REMOVE_TIMEOUT_MS, method: 'POST', body: { downloadIds } });
    return !!(data && data.ok === true);
}

// Removes a download's record AND its real archive file on disk -- the deliberate OPPOSITE of
// removeDownloadRecordOnly above, and the ONE removal path this project's own diagnostics
// investigation confirmed actually survives a Vortex restart (see
// diagnostics/2026-09-01-duplicate-download-persistence-investigation.md). Built for Duplicate
// Version Cleanup's own orphan-removal step -- callers MUST already have confirmed no OTHER
// surviving download record shares this same archive file before calling this (see
// lib/duplicate-version-cleanup.js's own shared-archive check). Returns the per-item results array
// (`{downloadId, ok, error?}`) on a genuine `{ok:true}` response, or `null` on ANY failure -- same
// "never throws" contract as every other batch function here (createModsBatch, etc.), since each
// item is a real independent async removal with its own filesystem side effect.
async function removeDownloads(downloadIds) {
    const data = await helperFetch('/downloads/remove', { timeoutMs: REMOVE_TIMEOUT_MS, method: 'POST', body: { downloadIds } });
    return (data && data.ok === true && Array.isArray(data.results)) ? data.results : null;
}

// Batch form of createMod (2026-08-27, director-caught excess-call-count finding) -- see the Helper
// extension's own createModsBatch header comment. `mods`: [{modId, mod}, ...]. Returns the per-item
// results array (`{modId, ok, error?}`) on a genuine `{ok:true}` response, or `null` on ANY failure
// -- same "never throws" contract as every other function here. A batch item CAN fail independently
// of its siblings (each is a real async create-mod event with a real filesystem side effect, not a
// single all-or-nothing dispatch the way the rules/set-enabled batches are), so callers must check
// each item's own `ok`, not just that the request as a whole succeeded.
async function createModsBatch(mods) {
    const data = await helperFetch('/mods/create-batch', { timeoutMs: CREATE_MOD_BATCH_TIMEOUT_MS, method: 'POST', body: { mods } });
    return (data && data.ok === true && Array.isArray(data.results)) ? data.results : null;
}

// Fully uninstalls one or more mods (purges deployed links, deletes staging, removes the state.v2
// record) via Vortex's own real remove-mods event -- used for a collection update's "Remove All"
// choice. NOTE (real, open, low-probability risk, same shape as applyRuleChange's own documented
// one): the one bounded network-failure retry could in principle re-issue this call after the FIRST
// attempt actually already succeeded server-side but the response was lost -- a retry against an
// already-removed modId should resolve as a benign "not found" on Vortex's own side rather than
// corrupt anything, but this hasn't been exhaustively proven the way applyRuleChange's own retry
// risk was analyzed. Flagged, not silently assumed safe.
async function removeMods(modIds) {
    const data = await helperFetch('/mods/remove', { timeoutMs: REMOVE_TIMEOUT_MS, method: 'POST', body: { modIds } });
    return !!data && data.ok === true;
}

// Deletes ONLY a mod's own tracked record, deliberately WITHOUT Vortex's real undeploy attempt --
// see vortex-collection-helper's own removeModRecordOnly for the full real reasoning (this exists
// specifically to avoid Vortex's own real, blocking "Mod not found" dialog, confirmed live 2026-08-28
// against a real apply: a mod whose staging folder is already gone makes the real remove-mods event's
// own undeploy step throw, and Vortex's OWN code -- not this project's -- catches that by showing a
// real modal requiring a person to click Ignore/Deploy). Callers must ALREADY have confirmed there's
// nothing real left to undeploy (no staging folder, no archive) before routing a mod here instead of
// through removeMods above -- this function trusts that decision, it doesn't re-verify it.
async function removeModsRecordOnly(modIds) {
    const data = await helperFetch('/mods/remove-record-only', { timeoutMs: REMOVE_TIMEOUT_MS, method: 'POST', body: { modIds } });
    return !!data && data.ok === true;
}

// The REAL, full Vortex deploy pipeline (deploy-mods, the same event the real "Deploy Mods" button
// dispatches) -- NOT deployMod() above, which only re-links one mod and never triggers Vortex's own
// did-deploy reaction chain (the plugin-list rescan + LOOT resort that keeps plugins.txt/
// loadorder.txt current). Update Collection v2 calls this ONLY when it has detected a real plugin
// file (.esp/.esm/.esl) was added/removed/renamed by its own faster per-mod updates -- the one case
// deployMod() genuinely can't reconcile on its own (see docs/VORTEX-DEPLOY-REFERENCE.md).
//
// Deliberately calls helperFetchOnce directly, NOT the shared helperFetch() -- that wrapper retries
// once on a network-level failure (timeout/refused/reset), which is safe for every other write here
// (each is a fast, effectively-idempotent single dispatch) but would be a real, meaningfully bad
// double-dispatch risk for THIS call specifically: a retry firing while the FIRST deploy-mods is
// still genuinely running (a real, confirmed possibility -- see this file's own header comment,
// "A DIFFERENT, now-CONFIRMED case", for why a deploy-mods call can leave the helper's own server
// looking unresponsive for an extended stretch even though the real deploy is still progressing
// normally) could trigger a SECOND full deploy pipeline stacked on top of the first. One attempt
// only; a timeout here means "don't know yet, not "failed" -- the caller should poll
// getDeployAllProgress() to find out what's actually happening rather than assume failure.
async function deployAllMods() {
    const result = await helperFetchOnce('/mods/deploy-all', { timeoutMs: DEPLOY_ALL_TIMEOUT_MS, method: 'POST' });
    return result.ok && result.data && result.data.ok === true;
}

// Best-effort live status for an in-flight deployAllMods() call -- { active, text, percent, done,
// error, externalChangesPending, blockingDialogs } | null. Returns null on ANY failure (never
// throws), which the caller should treat as "no fresh update available right now", not as evidence
// the deploy itself failed -- see the helper extension's own deployAllProgress header comment: the
// SAME event-loop congestion that can make a deploy-mods call look slow from the outside can also
// make THIS polling endpoint time out mid-deploy, entirely separately from whether the real deploy is
// still healthy. Short timeout by design -- this is meant to be polled repeatedly while
// deployAllMods() is in flight, so a single slow/failed poll should never itself block the caller for
// long. externalChangesPending/blockingDialogs (2026-08-29) are the helper's own real, live-read
// Vortex UI-blocking signals -- see getSessionSignals' own header comment in
// vortex-collection-helper/index.js, and diagnostics/2026-08-28-helper-live-vortex-events-spec.md for
// the full design. Passed through here unmodified -- no filtering, same "dumb passthrough" contract
// as every other read in this file.
async function getDeployAllProgress() {
    const data = await helperFetch('/mods/deploy-all/progress', { timeoutMs: DEPLOY_ALL_PROGRESS_TIMEOUT_MS });
    return data && typeof data === 'object' ? data : null;
}

module.exports = {
    checkHelperAvailable, getHelperHealth, getLiveRulesForMod, getAllMods, getAllDownloads, getLiveProfiles, applyRuleChange, applyRuleChangeDetailed,
    applyRuleChangesBatch, setModAttributes, createMod, createModsBatch, registerLocalDownload, removeDownloadRecordOnly, removeDownloads, deployMod, setModEnabled, setModsEnabledBatch,
    removeMods, removeModsRecordOnly, deployAllMods, getDeployAllProgress,
    getPluginLoadOrder, setPluginEnabled,
    HELPER_BASE_URL, MIN_HELPER_VERSION, isHelperOutdated,
};
