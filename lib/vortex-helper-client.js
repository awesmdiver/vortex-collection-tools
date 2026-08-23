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

// Full /health payload (including the helper's own reported version, 2026-08-23) for display
// purposes -- Settings' "what am I running" panel. Separate from checkHelperAvailable rather than
// changing that function's own boolean contract, which every other caller in this project relies on.
// null on any failure (helper not installed/not running), same "never throws" convention as every
// other read in this file.
async function getHelperHealth() {
    return helperFetch('/health');
}

// The oldest Helper version this app's own code actually works correctly against (2026-08-23).
//
// BUMP THIS whenever this project starts relying on a real fix or endpoint that only exists in a
// newer Helper -- the same way 0.12.0 is a real dependency today, not a nice-to-have: it carries the
// null->undefined normalization in the Helper's own /mods/set-attributes, which Clear Update Flags
// depends on to genuinely clear a flag rather than store a literal null. A 22-commits-behind Helper
// is exactly what made Clear Update Flags miscount for a while this session, silently, with nothing
// anywhere pointing at the Helper as the cause -- which is the whole reason this check exists.
// Bumping it is the ONLY thing needed to start warning users; the Settings banner reads it straight
// through GET /api/settings/helper-info.
const MIN_HELPER_VERSION = '0.12.0';

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
// error } | null. Returns null on ANY failure (never throws), which the caller should treat as "no
// fresh update available right now", not as evidence the deploy itself failed -- see the helper
// extension's own deployAllProgress header comment: the SAME event-loop congestion that can make a
// deploy-mods call look slow from the outside can also make THIS polling endpoint time out mid-deploy,
// entirely separately from whether the real deploy is still healthy. Short timeout by design -- this
// is meant to be polled repeatedly while deployAllMods() is in flight, so a single slow/failed poll
// should never itself block the caller for long.
async function getDeployAllProgress() {
    const data = await helperFetch('/mods/deploy-all/progress', { timeoutMs: DEPLOY_ALL_PROGRESS_TIMEOUT_MS });
    return data && typeof data === 'object' ? data : null;
}

module.exports = {
    checkHelperAvailable, getHelperHealth, getLiveRulesForMod, getAllMods, getAllDownloads, applyRuleChange,
    setModAttributes, createMod, deployMod, setModEnabled, removeMods, deployAllMods, getDeployAllProgress,
    getPluginLoadOrder, setPluginEnabled,
    HELPER_BASE_URL, MIN_HELPER_VERSION, isHelperOutdated,
};
