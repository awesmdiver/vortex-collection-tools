'use strict';
// Shared Deploy poll engine (2026-09-14, "Rebuild Collection, Rebuild Missing Files, and Update
// Collection: the same Deploy step on every Done screen") -- the real fire-and-poll loop (percent/
// text tracking, stall-hint fact-message-or-tick-count, rule-cycle detection) used to live only in
// update-collection-v2-app.js's own ucv2DeployAll; Rebuild Missing Files had its own smaller copy
// (rmfStartDeploy, modeled on Missing Masters' own mmDeployAll); Rebuild Collection had none at all.
// One engine now, used by all three, against the shared web/deploy-routes.js
// (POST /api/deploy/all, GET /api/deploy/all/progress -- ONE in-flight flag for the whole app, not
// one per tool, so a deploy started from one tool's Done screen correctly blocks a second click from
// another tool's).
//
// Each tool still owns 100% of its own DOM/markup/rendering and result wording (per the director's
// own instruction: "Progress and result text: reuse what's there today") -- this only owns the "do I
// have real news to report yet" logic, via callbacks. Loaded before app.js/rebuild-missing-app.js/
// update-collection-v2-app.js in index.html, since all three call into it.

const DEPLOY_STALL_THRESHOLD_TICKS = 15;

function escHtmlDeploy(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Real, helper-reported fact instead of a tick-count guess (2026-08-29, originally
// ucv2DeployStallMessage) -- GET .../all/progress folds in externalChangesPending/blockingDialogs,
// read live from Vortex's own Redux state by the helper: when either is set, Vortex genuinely IS
// sitting on a dialog right now, so the hint can show immediately instead of waiting out
// DEPLOY_STALL_THRESHOLD_TICKS. Returns null when neither signal is set, so the caller falls back to
// its own tick-count-only default hint.
function deployStallMessage(progress) {
  const dialogs = (progress && progress.blockingDialogs) || [];
  if (dialogs.length > 0 && dialogs[0].title) {
    return `⚠️ Vortex is waiting on you — check its window (<b>${escHtmlDeploy(dialogs[0].title)}</b>) to continue.`;
  }
  if (progress && progress.externalChangesPending) {
    return '⚠️ Vortex has a popup open — check it and confirm the external changes.';
  }
  return null;
}

// Shared "ThemedName (Cycle Helper)" cross-tool reference substitution (moved from
// update-collection-v2-app.js's own ucv2ThemedCycleMessage, 2026-09-14 -- the logic was already
// tool-agnostic, just namespaced to one tool AND already used for two unrelated cases there: the
// deploy-blocked-by-cycles message this file's own poll engine surfaces below, AND Update Collection
// v2's own retry-pass guard, a totally different code ('cycle-detected') for a totally different
// failure -- kept generic here for exactly that reason, not narrowed to deploy. The server has no
// access to the browser's active theme, so it sends the plain "using Cycle Helper" fallback wording
// with a distinct `code`; this is the one place that swap happens, for every server-authored cycle
// message. `matchCode` lets each caller gate on its own real code rather than assuming every themed
// message uses the same one.
function themedCycleMessage(rawMessage, code, matchCode) {
  if (code !== matchCode || !rawMessage) return rawMessage;
  const themedName = window.themedToolName ? window.themedToolName('cycle-helper', 'Cycle Helper') : 'Cycle Helper';
  const cycleHelperRef = themedName === 'Cycle Helper' ? 'Cycle Helper' : `${themedName} (Cycle Helper)`;
  return rawMessage.replace('using Cycle Helper', `using ${cycleHelperRef}`);
}

// Fires a real deploy and polls it to completion. `apiFn` is whichever tool-scoped API helper the
// caller already has (ucv2Api/rmfApi/the plain api() in app.js) -- all three share the exact same
// (method, path, body) => Promise<json> shape, so this takes it as a parameter rather than assuming
// one. `apiBase` is the shared mount point ('/api/deploy'); a caller never needs anything else.
//
// Callbacks (all optional):
//   onStart()             -- right before the POST fires (hide pending/result, show progress at 0%)
//   onError(err)           -- the POST itself failed (helper unreachable, network error, etc.)
//   onTick(progress)       -- every successful poll, real percent/text
//   onStall(show, message) -- whenever the stall-hint state changes (message is the real helper-
//                             reported fact when available, null for the generic tick-count fallback)
//   onDone(progress)       -- once, when the poll reports done:true. progress.error set means
//                             failure (possibly deploy-blocked-by-cycles -- check progress.code)
async function startDeploy(apiBase, apiFn, { onStart, onError, onTick, onStall, onDone } = {}) {
  onStart?.();
  try {
    await apiFn('POST', `${apiBase}/all`, {});
  } catch (e) {
    onError?.(e);
    return;
  }
  // Tracks consecutive ticks with NO real progress (a failed poll, or a successful one reporting the
  // exact same percent/text as last time) -- reset the instant real progress is seen, so a genuinely
  // fast deploy never shows a stall hint at all. Same approach ucv2DeployAll's own poll always used.
  let noProgressStreak = 0;
  let lastProgressKey = null;
  const interval = setInterval(async () => {
    let progress;
    try {
      progress = await apiFn('GET', `${apiBase}/all/progress`);
    } catch {
      noProgressStreak += 1;
      onStall?.(noProgressStreak >= DEPLOY_STALL_THRESHOLD_TICKS, null);
      return; // one failed poll is not evidence the deploy failed -- try again next tick
    }
    const progressKey = progress ? `${progress.percent ?? ''}|${progress.text ?? ''}` : null;
    if (progressKey !== null && progressKey === lastProgressKey) noProgressStreak += 1;
    else noProgressStreak = 0;
    lastProgressKey = progressKey;
    // Real signal wins over the tick-count guess -- shows the instant the helper reports Vortex is
    // genuinely blocked, named by its real dialog title, rather than waiting out the threshold.
    const factMessage = deployStallMessage(progress);
    onStall?.(!!factMessage || noProgressStreak >= DEPLOY_STALL_THRESHOLD_TICKS, factMessage);
    onTick?.(progress);
    if (!progress || !progress.done) return;
    clearInterval(interval);
    onStall?.(false);
    onDone?.(progress);
  }, 1000);
}
