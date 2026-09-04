'use strict';
// Cycle Helper UI -- talks only to /api/cycle-helper/* (plus a lazy read of the EXISTING
// /api/rules-generator/conflicts route for the Fix modal's default-pick heuristic below -- no
// second, duplicate conflicts endpoint). See TECHNICAL.md's "Cycle Helper" section and
// docs/plans/2026-08-16-cycle-helper-research.md for the full design rationale. Own tiny api()/$
// helpers, same reasoning as rules-generator-app.js's own (independent of app.js, safe to work on
// without touching already-validated code).

function $ch(id) { return document.getElementById(id); }

function escHtmlCh(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function chApi(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || data.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

function chShowCriticalError(message) {
  const el = $ch('chCriticalError');
  el.innerHTML = `<div class="callout__title">🛑 Couldn't do that</div><p>${escHtmlCh(message)}</p>`;
  el.classList.remove('hidden');
}
function chHideCriticalError() {
  $ch('chCriticalError').classList.add('hidden');
  $ch('chCriticalError').innerHTML = '';
}

// Same shared-modal / retryFn pattern every Vortex-gated action in this app already uses (see
// rules-generator-app.js's own rgHandleError) -- the single shared "Vortex is running" modal only
// has one retry slot, so every call site must pass the real action that actually hit the gate.
function chHandleError(e, retryFn) {
  if (window.isServerUnreachableError && window.isServerUnreachableError(e)) {
    window.showServerUnreachableError(retryFn || (() => {}));
    return;
  }
  if (e.status === 409 && e.body?.error === 'vortex-running') {
    window.showVortexRunningModal(retryFn || (() => {}));
    return;
  }
  chShowCriticalError(e.message);
}

const CH_STEPS = ['Snapshot & prep', 'Scan', 'Fix', 'Apply', 'Validate'];
function chRenderStepper(activeIdx) {
  $ch('chStepper').innerHTML = CH_STEPS.map((label, i) => {
    const cls = i < activeIdx ? 'done' : i === activeIdx ? 'active' : '';
    const num = i < activeIdx ? '✓' : String(i + 1);
    return `<div class="merge-step ${cls}"><b>${num}</b>${label}</div>`;
  }).join('');
}

const CH_SCREEN_IDS = ['chScreenPrep', 'chScreenClean', 'chScreenCycles', 'chScreenApply', 'chScreenValidate', 'chScreenHistory', 'chScreenHistoryReview'];
const CH_SCREEN_STEP = { chScreenPrep: 0, chScreenClean: 1, chScreenCycles: 1, chScreenApply: 3, chScreenValidate: 4 };
// Change History (chScreenHistory/chScreenHistoryReview) is a side flow, not a step in the numbered
// Snapshot->Validate sequence (mirrors design/vortex-cycle-helper-mockup.html's own goScreen) -- no
// entry in CH_SCREEN_STEP above, and the stepper hides entirely rather than showing a misleading
// "step" for either of them.
const CH_SIDE_FLOW_SCREENS = new Set(['chScreenHistory', 'chScreenHistoryReview']);
function chGoScreen(id) {
  CH_SCREEN_IDS.forEach((s) => $ch(s).classList.toggle('hidden', s !== id));
  const isSideFlow = CH_SIDE_FLOW_SCREENS.has(id);
  $ch('chStepper').classList.toggle('hidden', isSideFlow);
  if (!isSideFlow) chRenderStepper(CH_SCREEN_STEP[id]);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ---- Step 0: snapshot status -- pure local-file read, no Vortex dependency, safe to check every
// visit (same "Missing Masters has no load-once gate, it just re-checks" precedent, not the
// once-per-visit gate archivefinder/missingfiles use for their heavier Vortex-touching loads). ----

function chRenderSnapStatus(status) {
  const el = $ch('chSnapStatus');
  el.classList.toggle('taken', !!status.taken);
  if (status.taken) {
    const when = new Date(status.createdAt);
    $ch('chSnapText').textContent = `Snapshot taken ${when.toLocaleString()}`;
    $ch('chSnapBtn').textContent = '📸 Snapshot again';
  } else {
    $ch('chSnapText').textContent = 'No snapshot yet';
    $ch('chSnapBtn').textContent = '📸 Snapshot my rules now';
  }
}

async function chLoadSnapshotStatus() {
  try {
    const status = await chApi('GET', '/api/cycle-helper/snapshot-status');
    chRenderSnapStatus(status);
  } catch {
    // Not worth a critical-error banner for a status pill -- the Snapshot button below will surface
    // any real problem when actually clicked.
  }
}

async function chTakeSnapshot() {
  chHideCriticalError();
  const btn = $ch('chSnapBtn');
  btn.disabled = true;
  try {
    const result = await chApi('POST', '/api/cycle-helper/snapshot');
    chRenderSnapStatus({ taken: true, createdAt: result.createdAt });
  } catch (e) {
    chHandleError(e, chTakeSnapshot);
  } finally {
    btn.disabled = false;
  }
}

// ---- Step 2: scan ----

let chLastResult = null;
let chIsValidating = false; // true when this scan is a post-Apply re-check (Step 5), not a fresh Step 2 scan

// Change History (2026-08-18) -- a "session" is everything between one Scan and the next (confirmed
// with the director 2026-08-17), so both of these reset only when a fresh Scan actually runs (see
// chScan below), never on a post-Apply Validate re-check (that's still the SAME session continuing).
// chHistorySessionId is null until the first fix in a session is applied -- the server hands back
// the (possibly new) session id on every apply-fix response, see chConfirmApply.
let chHistorySessionId = null;
let chSessionFixes = []; // this session's own fix records so far, for the inline "This session so far" list

function chOwnerRuleWord(ruleType) { return ruleType === 'before' ? 'BEFORE' : 'AFTER'; }

// Which graph edge (owner->target, in SORT-ORDER terms) the top-ranked candidate corresponds to --
// used only to decide which arrow in the shortest-cycle visual to highlight as "the suspect".
function chTopCandidateGraphEdge(cycle) {
  const top = cycle.candidates[0];
  if (!top) return null;
  return top.ruleType === 'before'
    ? { from: top.ownerModKey, to: top.targetModKey }
    : { from: top.targetModKey, to: top.ownerModKey };
}

function chRenderCyclePath(cycle) {
  const path = cycle.shortestCycle || [];
  if (!path.length) return '';
  const suspectEdge = chTopCandidateGraphEdge(cycle);
  let html = '';
  path.forEach((node, i) => {
    const next = path[(i + 1) % path.length];
    const isSuspect = suspectEdge && suspectEdge.from === node.modKey && suspectEdge.to === next.modKey;
    html += `<span class="ch-node${isSuspect ? ' suspect' : ''}">${escHtmlCh(node.name)}</span>`;
    if (i < path.length - 1) html += `<span class="ch-arrow${isSuspect ? ' bad' : ''}">→</span>`;
  });
  html += `<span class="ch-wrap-arrow">↩ back to "${escHtmlCh(path[0].name)}" — this is the loop</span>`;
  return html;
}

function chRankLabel(idx) {
  if (idx === 0) return 'Most likely';
  if (idx === 1) return '2nd';
  if (idx === 2) return '3rd';
  return `${idx + 1}th`;
}

function chRenderCandidate(cycleIdx, candIdx, c) {
  const signals = [];
  if (c.changedSinceSnapshot) signals.push('<span class="ch-signal ch-signal--snapshot">📸 Changed since your snapshot</span>');
  if (c.breaksFully) signals.push('<span class="ch-signal ch-signal--removal">🔧 Fixing this breaks the cycle</span>');
  if (c.inShortestCycle) signals.push('<span class="ch-signal ch-signal--shortest">📏 Part of the shortest loop</span>');
  return `
    <div class="ch-candidate${candIdx === 0 ? ' top' : ''}">
      <div class="ch-candidate__head">
        <span class="ch-rank-badge${candIdx === 0 ? '' : ' ch-rank-badge--muted'}">${chRankLabel(candIdx)}</span>
        <span class="ch-candidate__rule">${escHtmlCh(c.ownerName)} <span class="ch-arrow">currently loads ${chOwnerRuleWord(c.ruleType)}</span> ${escHtmlCh(c.targetName)}</span>
      </div>
      <div class="ch-signals">${signals.join('') || '<span class="muted" style="font-size:12px">No strong signal for this one -- just the next-most-likely edge in the tangle.</span>'}</div>
      <div class="ch-candidate__actions">
        <button class="btn btn--small${candIdx === 0 ? ' btn--primary' : ''}" data-cycle-idx="${cycleIdx}" data-cand-idx="${candIdx}">Fix this rule →</button>
      </div>
    </div>`;
}

function chRenderCycleCard(cycle, cycleIdx) {
  const tangleNames = cycle.modsInvolved.map((m) => escHtmlCh(m.name)).join(' &rarr; ');
  const candidatesHtml = cycle.candidates.map((c, i) => chRenderCandidate(cycleIdx, i, c)).join('');
  return `
    <div class="settings-group">
      <div class="mm-header-row">
        <h2>Cycle ${cycleIdx + 1}</h2>
        <span class="muted">${cycle.modCount} mods involved &middot; shortest actual loop shown below</span>
      </div>
      <div class="ch-cyclepath">${chRenderCyclePath(cycle)}</div>
      <details class="chip-list-details">
        <summary><span class="chip-list-details__caret">▸</span> Show the full ${cycle.modCount}-mod tangle Vortex would show you</summary>
        <div class="chip-list-details__body"><div class="ch-full-tangle">${tangleNames}</div></div>
      </details>
      <p class="muted" style="margin:14px 0 14px">Ranked by how likely each rule is the actual cause &mdash; highest first:</p>
      ${candidatesHtml}
    </div>`;
}

function chRenderScanResult(result) {
  chLastResult = result;

  if (!result.hasCycles) {
    if (chIsValidating) {
      $ch('chValidateSuccessWrap').classList.remove('hidden');
      $ch('chValidateStillCyclingWrap').classList.add('hidden');
      chGoScreen('chScreenValidate');
    } else {
      chGoScreen('chScreenClean');
    }
    return;
  }

  const cyclesHtml = result.cycles.map((c, i) => chRenderCycleCard(c, i)).join('');
  if (chIsValidating) {
    $ch('chValidateSuccessWrap').classList.add('hidden');
    $ch('chValidateStillCyclingWrap').classList.remove('hidden');
    chRenderSessionSoFar();
    $ch('chValidateStillCyclingList').innerHTML = cyclesHtml;
    chGoScreen('chScreenValidate');
    return;
  }

  const totalMods = result.cycles.reduce((sum, c) => sum + c.modCount, 0);
  const totalCandidates = result.cycles.reduce((sum, c) => sum + c.candidates.length, 0);
  $ch('chSummaryStats').innerHTML = `
    <span class="badge badge--critical"><span class="badge__count">${result.cycles.length}</span> cycle${result.cycles.length === 1 ? '' : 's'} found</span>
    <span class="badge badge--neutral"><span class="badge__count">${totalMods}</span> mods caught in the tangle</span>
    <span class="badge badge--info"><span class="badge__count">${totalCandidates}</span> candidate rules ranked</span>`;
  $ch('chCyclesList').innerHTML = cyclesHtml;
  chGoScreen('chScreenCycles');
}

function chRenderFreshnessWarning(message) {
  const el = $ch('chFreshnessWarning');
  if (!message) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  el.innerHTML = `<div class="callout__title">⚠️ Vortex didn't finish saving</div><p>${message}</p>`;
  el.classList.remove('hidden');
}

// Fire-and-forget -- deliberately never awaited by its own callers, since this is a bonus check
// that must never delay whatever the user is actually doing. Confirmed live 2026-08-16 (real
// director bug report): a small rule edit made directly in Vortex's own UI, then closed, can still
// be sitting only in state.v2's WAL when Scan runs right after -- Scan's own safe copy-based read
// never sees that WAL (documented native-crash risk to copy/replay it directly), so it can silently
// show stale rule data with nothing telling the user anything was missed. Same voice/shape as
// sync-app.js's own checkBackupFreshnessAsync.
//
// Called from two places (2026-08-18, real director bug report -- this used to be called only
// after chScan already rendered screen 2, so the warning was never visible in time to warn the
// user off scan results that might already be stale): (1) loadCycleHelperPageOnce, so it's already
// running the moment the user lands on screen 1, well before they'd click Scan; (2) chScan itself,
// fired in parallel with the scan request (never awaited, never sequenced after it) so a slow scan
// doesn't delay the check or vice versa. chFreshnessWarning itself sits outside every #chScreen*
// container in index.html, so whichever of these two calls resolves last simply paints the same
// element on whatever screen happens to be visible at that moment -- screen 1 if it beats the scan,
// screen 2 if the scan's own render wins the race. No second warning element needed.
async function chCheckScanFreshnessAsync() {
  try {
    const result = await chApi('POST', '/api/cycle-helper/scan/check-freshness');
    if (result.checked && result.stale) {
      chRenderFreshnessWarning(
        "We spotted unsaved changes still sitting in Vortex's database, so this scan might be missing your most recent rule edits. " +
        'Reopen Vortex, wait a few seconds, close it again, and click <strong>Scan for cycles</strong> once more to be sure.'
      );
    }
  } catch {
    // Best-effort only -- never surface an error for this (see checkScanFreshness's own comment).
  }
}

// Real SSE-streamed progress (2026-08-25) -- POST /scan now only starts the real scan, then returns
// as soon as it's genuinely running server-side; GET /scan/events streams a live tick every second
// while it's in flight (cycle-helper-routes.js's own tickingPhase) plus the final 'done' event
// carrying the exact same result shape this function used to get back directly. No real per-item
// count exists here (a single opaque helperClient/isolated-worker call), so chLoading's text ticks
// with real elapsed time instead of a percentage -- same shape as Rules Generator's own Analyze
// (rules-generator-app.js's rgAnalyze/rgHandleAnalyzeEvent), reused here rather than reinvented.
let chScanEventSource = null;

function chFinishScanStream() {
  if (chScanEventSource) { chScanEventSource.close(); chScanEventSource = null; }
  $ch('chLoading').classList.add('hidden');
  $ch('chScanBtn').disabled = false;
}

function chHandleScanEvent(frame) {
  if (frame.type === 'phase') {
    $ch('chLoading').lastChild.textContent = ` ${frame.message}${frame.seconds ? ` (${frame.seconds}s)` : ''}`;
  } else if (frame.type === 'done') {
    chFinishScanStream();
    chRenderScanResult(frame);
  } else if (frame.type === 'error') {
    chFinishScanStream();
    if (frame.errorCode === 'vortex-running') {
      window.showVortexRunningModal(chScan);
    } else {
      chHandleError(new Error(frame.message || 'The scan failed.'), chScan);
    }
  }
}

async function chScan() {
  chHideCriticalError();
  chRenderFreshnessWarning(null);
  // A fresh Scan is the session boundary itself (see chHistorySessionId's own header comment) --
  // whatever session was in progress is done; the next applied fix (if any) starts a new one.
  chHistorySessionId = null;
  chSessionFixes = [];
  $ch('chLoading').lastChild.textContent = " Reading Vortex's database…";
  $ch('chLoading').classList.remove('hidden');
  $ch('chScanBtn').disabled = true;
  chCheckScanFreshnessAsync(); // parallel with the scan request below, not sequenced after it
  try {
    await chApi('POST', '/api/cycle-helper/scan');
  } catch (e) {
    $ch('chLoading').classList.add('hidden');
    $ch('chScanBtn').disabled = false;
    chHandleError(e, chScan);
    return;
  }
  if (chScanEventSource) chScanEventSource.close();
  const es = new EventSource('/api/cycle-helper/scan/events');
  chScanEventSource = es;
  es.onmessage = (msg) => chHandleScanEvent(JSON.parse(msg.data));
}

// ---- Step 3: fix modal ----

let chSelectedFix = null; // { cycleIdx, candIdx, action }

function chFixOptionHtml(action, selected, recommended, desc) {
  const label = action === 'remove' ? 'Remove this rule' : 'Flip the direction instead';
  const recBadge = recommended ? ' <span style="color:var(--success);font-weight:700">— recommended</span>' : '';
  return `
    <label class="ch-fix-option${selected ? ' sel' : ''}" data-action="${action}">
      <input type="radio" name="chFixType" value="${action}"${selected ? ' checked' : ''}>
      <div>
        <div class="ch-lbl">${label}${recBadge}</div>
        <div class="ch-desc">${desc}</div>
      </div>
    </label>`;
}

function chRenderFixOptions(c, conflictCount) {
  // Default pick: Remove, UNLESS a real, already-proven signal (the SAME "N conflicting file(s)"
  // filesystem check Rules Generator's own UI already shows -- see chCheckConflictsForFix below)
  // says these two mods actually conflict on disk, in which case the rule looks like a genuine,
  // intentional conflict resolution that's just pointing the wrong way -- flipping is more likely
  // the real fix than deleting it outright. Deliberately NOT based on any "reason" field on the
  // rule itself -- confirmed against Vortex's real IModRuleExtra type (IMod.ts) that no such field
  // exists at all, so a fabricated "extra.reason" check would never fire on real data. This is the
  // flip-vs-remove heuristic the research doc flagged as unproven -- see TECHNICAL.md for the full
  // writeup of this decision.
  const flipRecommended = conflictCount != null && conflictCount > 0;
  const removeDesc = 'Deletes the rule entirely. Recommended if you\'re not sure why it\'s there.';
  const flipTargetWord = chOwnerRuleWord(c.ruleType === 'before' ? 'after' : 'before');
  const flipDesc = flipRecommended
    ? `Changes it to "must load ${flipTargetWord}." The rule itself looks intentional (${conflictCount} conflicting file${conflictCount === 1 ? '' : 's'}) — it's just backwards, so flipping is likely the real fix rather than deleting it outright.`
    : `Changes it to "must load ${flipTargetWord}."`;
  chSelectedFix.action = flipRecommended ? 'flip' : 'remove';
  $ch('chFixOptions').innerHTML =
    chFixOptionHtml('remove', chSelectedFix.action === 'remove', false, removeDesc) +
    chFixOptionHtml('flip', chSelectedFix.action === 'flip', flipRecommended, flipDesc);
}

async function chCheckConflictsForFix(c) {
  const aPath = chLastResult.installationPaths?.[c.ownerModKey];
  const bPath = chLastResult.installationPaths?.[c.targetModKey];
  if (!aPath || !bPath) { chRenderFixOptions(c, null); return; }
  try {
    // Reuses Rules Generator's EXISTING conflicts route (pure filesystem comparison, no Vortex/DB
    // dependency) -- same computation, same "N conflicting file(s)" signal, deliberately not
    // duplicated as a second endpoint here.
    const data = await chApi('GET', `/api/rules-generator/conflicts?a=${encodeURIComponent(aPath)}&b=${encodeURIComponent(bPath)}`);
    chRenderFixOptions(c, data.files.length);
  } catch {
    chRenderFixOptions(c, null); // can't check -- fall back to the plain Remove default, no guess
  }
}

function chOpenFixModal(cycleIdx, candIdx) {
  const c = chLastResult.cycles[cycleIdx].candidates[candIdx];
  chSelectedFix = { cycleIdx, candIdx, action: 'remove' };
  $ch('chFixModalRuleText').innerHTML =
    `<strong>${escHtmlCh(c.ownerName)}</strong> currently loads <strong>${chOwnerRuleWord(c.ruleType)}</strong> <strong>${escHtmlCh(c.targetName)}</strong>`;
  chRenderFixOptions(c, null); // shows the plain Remove default immediately, upgraded below once the check resolves
  $ch('chFixModal').classList.remove('hidden');
  chCheckConflictsForFix(c);
}
function chCloseFixModal() { $ch('chFixModal').classList.add('hidden'); }

// ---- Step 4: apply confirmation (serious register -- writes directly to Vortex's live database) ----

function chOpenApplyScreen() {
  const c = chLastResult.cycles[chSelectedFix.cycleIdx].candidates[chSelectedFix.candIdx];
  const beforeWord = chOwnerRuleWord(c.ruleType);
  const afterWord = chSelectedFix.action === 'flip' ? chOwnerRuleWord(c.ruleType === 'before' ? 'after' : 'before') : null;
  chCloseFixModal();
  $ch('chApplyBeforeLine').innerHTML =
    `${escHtmlCh(c.ownerName)} <span style="color:var(--danger);text-decoration:line-through">currently loads ${beforeWord}</span> ${escHtmlCh(c.targetName)}`;
  if (chSelectedFix.action === 'flip') {
    $ch('chApplyAfterLine').innerHTML =
      `${escHtmlCh(c.ownerName)} <span style="color:var(--success);font-weight:600">must load ${afterWord}</span> ${escHtmlCh(c.targetName)}`;
    $ch('chApplyAfterLine').classList.remove('hidden');
  } else {
    $ch('chApplyAfterLine').innerHTML = `${escHtmlCh(c.ownerName)} <span style="color:var(--success);font-weight:600">rule removed</span>`;
    $ch('chApplyAfterLine').classList.remove('hidden');
  }
  chGoScreen('chScreenApply');
}

async function chConfirmApply() {
  const c = chLastResult.cycles[chSelectedFix.cycleIdx].candidates[chSelectedFix.candIdx];
  const btn = $ch('chApplyConfirmBtn');
  btn.disabled = true;
  chHideCriticalError();
  try {
    const result = await chApi('POST', '/api/cycle-helper/apply-fix', {
      ownerModKey: c.ownerModKey,
      ruleType: c.ruleType,
      targetModKey: c.targetModKey,
      action: chSelectedFix.action,
      historySessionId: chHistorySessionId,
    });
    // Change History (2026-08-18) -- the server logs every fix AS IT HAPPENS (never batched), and
    // hands back this session's own id (a new one on this session's first fix, the same one again
    // after that) so the NEXT fix in this same session logs to the same file. chSessionFixes powers
    // the inline "This session so far" list (chRenderSessionSoFar) -- kept even for a fix that
    // didn't resolve the cycle, matching "a fix that didn't work stays applied and stays logged".
    chHistorySessionId = result.historySessionId;
    chSessionFixes.push({
      ownerModKey: result.ownerModKey, ownerName: result.ownerName,
      targetModKey: result.targetModKey, targetName: result.targetName,
      action: result.action, originalType: result.originalType, newType: result.newType,
      originalRule: result.originalRule, resolvedCycle: result.resolvedCycle,
    });
    // Renders the fix's OWN bundled post-write scan (`validation`), never a separate follow-up
    // /scan call -- a fresh scan right after this write can't be trusted to see it yet (LevelDB
    // write-ahead-log timing; see cycle-helper-worker.js's own comment on why). The apply-fix
    // response already contains a same-handle, guaranteed-fresh read.
    chIsValidating = true;
    chRenderScanResult(result.validation);
  } catch (e) {
    chHandleError(e, chConfirmApply);
  } finally {
    btn.disabled = false;
  }
}

function chStartOver() {
  chIsValidating = false;
  chSelectedFix = null;
  chLoadSnapshotStatus();
  chGoScreen('chScreenPrep');
}

// ---- Change History + Revert (2026-08-18) -- see docs/plans/2026-08-17-cycle-helper-change-
// history-revert-plan.md and design/vortex-cycle-helper-mockup.html's screens 6/7. Two revert
// locations share the same POST /api/cycle-helper/history/revert route and the same
// chRunRevert helper below -- the inline one (chSessionFixes, still in-progress) and the Change
// History page (a past session's own saved fixes) hand it the exact same fix-record shape either
// way, no difference in handling. ----

function chRuleWordLower(type) { return type === 'before' ? 'loads before' : 'loads after'; }

// One line describing a single logged fix -- shared by the inline "This session so far" list and
// the Change History review table's own "Original"/"Current" columns (via the two callers below).
function chFixRuleLine(fix) {
  if (fix.action === 'flip') {
    return `${escHtmlCh(fix.ownerName)} → <strong>${chRuleWordLower(fix.newType)}</strong> ${escHtmlCh(fix.targetName)} <span class="muted">(was: ${chRuleWordLower(fix.originalType)})</span>`;
  }
  return `${escHtmlCh(fix.ownerName)} → <span style="color:var(--danger)">rule removed</span> <span class="muted">(was: ${chRuleWordLower(fix.originalRule?.type)} ${escHtmlCh(fix.targetName)})</span>`;
}

// Runs a revert against a batch of fix records (shared by both locations below) and returns
// {reverted, failed} straight from the server -- callers render their own result presentation.
async function chRunRevert(fixes) {
  return chApi('POST', '/api/cycle-helper/history/revert', { fixes });
}

function chRenderSessionSoFar() {
  const wrap = $ch('chSessionSoFarWrap');
  if (!chSessionFixes.length) { wrap.classList.add('hidden'); wrap.innerHTML = ''; return; }
  wrap.classList.remove('hidden');
  wrap.innerHTML = `
    <div class="settings-group">
      <h2 class="ch-eyebrow" style="margin:0 0 10px">This session so far</h2>
      ${chSessionFixes.map((fix, i) => `
        <div class="ch-session-fix-row">
          <span>${chFixRuleLine(fix)}</span>
          <button class="btn btn--small btn--ghost ch-revert-danger" data-fix-idx="${i}">↩ Revert this</button>
        </div>
        <p class="muted" style="margin:8px 0 14px">${fix.resolvedCycle
          ? "This fix resolved the cycle at the time you applied it -- reverting it will very likely bring the cycle back."
          : "This didn't clear the cycle on its own -- it's still applied. Reverting it just undoes this one change; it won't resolve the cycle either, since another rule still needs fixing too. Revert it if you'd rather try a different rule here instead, or leave it as-is and keep going with one of the candidates below."}</p>`).join('')}
    </div>`;
}

async function chRevertSessionFix(idx) {
  const fix = chSessionFixes[idx];
  chHideCriticalError();
  try {
    const result = await chRunRevert([fix]);
    if (result.failed.length) {
      chShowCriticalError(result.failed[0].message);
      return;
    }
    // Reverted -- this effectively restarts the fix-finding process from here (mirrors the
    // mockup's own "revert it if you'd rather try a different rule" framing), so re-scan fresh
    // rather than trying to hand-patch this screen's own already-rendered state. chScan() itself
    // resets chSessionFixes/chHistorySessionId, which is correct here too: this session is done.
    await chScan();
  } catch (e) {
    chHandleError(e, () => {});
  }
}

// ---- Change History screens ----

let chHistorySessions = [];
let chHistoryReviewSession = null;

function chFormatSessionTimestamp(iso) {
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function chSessionSummaryText(session) {
  const n = session.fixes.length;
  const names = [...new Set(session.fixes.map((f) => f.ownerName))];
  const who = names.length <= 2
    ? names.map(escHtmlCh).join(' and ')
    : `${escHtmlCh(names[0])}, ${escHtmlCh(names[1])}, and ${names.length - 2} more`;
  return `${n} rule${n === 1 ? '' : 's'} changed &mdash; ${who}`;
}

async function chOpenHistoryScreen() {
  chGoScreen('chScreenHistory');
  $ch('chHistoryList').innerHTML = '<p class="muted">Loading&hellip;</p>';
  try {
    const { sessions } = await chApi('GET', '/api/cycle-helper/history');
    chHistorySessions = sessions;
    $ch('chHistoryList').innerHTML = sessions.length
      ? sessions.map((s, i) => `
        <div class="settings-group ch-history-card">
          <div class="ch-history-card__head">
            <h2>${chFormatSessionTimestamp(s.appliedAt)}</h2>
            <button class="btn btn--small" data-session-idx="${i}">Review &amp; revert →</button>
          </div>
          <p class="muted" style="margin:6px 0 0">${chSessionSummaryText(s)}</p>
        </div>`).join('')
      : '<p class="muted">No sessions saved yet -- apply a fix here and it\'ll show up here afterward.</p>';
  } catch (e) {
    $ch('chHistoryList').innerHTML = '';
    chHandleError(e, chOpenHistoryScreen);
  }
}

function chUpdateHistoryRevertBtn() {
  const n = document.querySelectorAll('#chHistoryReviewRows .ch-revert-row:checked').length;
  const btn = $ch('chHistoryRevertBtn');
  btn.textContent = n > 0 ? `Revert ${n} selected →` : 'Revert →';
  btn.disabled = n === 0;
}

function chOpenHistoryReview(session) {
  chHistoryReviewSession = session;
  $ch('chHistoryReviewTitle').textContent = `${chFormatSessionTimestamp(session.appliedAt)} — ${session.fixes.length} rule${session.fixes.length === 1 ? '' : 's'} changed`;
  $ch('chHistoryReviewRows').innerHTML = session.fixes.map((fix, i) => {
    const original = fix.action === 'flip' ? chRuleWordLower(fix.originalType) : chRuleWordLower(fix.originalRule?.type);
    const current = fix.action === 'flip' ? chRuleWordLower(fix.newType) : '<span class="ch-danger-text">rule removed</span>';
    return `
      <tr>
        <td class="col-check"><input type="checkbox" class="ch-revert-row" data-fix-idx="${i}" checked></td>
        <td><strong>${escHtmlCh(fix.ownerName)}</strong> vs ${escHtmlCh(fix.targetName)}</td>
        <td class="muted">${original}</td>
        <td>${current}</td>
      </tr>`;
  }).join('');
  $ch('chHistoryReviewSelectAll').checked = true;
  $ch('chHistoryRevertResult').classList.add('hidden');
  $ch('chHistoryRevertResult').innerHTML = '';
  chUpdateHistoryRevertBtn();
  chGoScreen('chScreenHistoryReview');
}

async function chDoHistoryRevert() {
  const idxs = Array.from(document.querySelectorAll('#chHistoryReviewRows .ch-revert-row:checked')).map((el) => Number(el.dataset.fixIdx));
  if (!idxs.length) return;
  const fixes = idxs.map((i) => chHistoryReviewSession.fixes[i]);
  const btn = $ch('chHistoryRevertBtn');
  btn.disabled = true;
  chHideCriticalError();
  try {
    const result = await chRunRevert(fixes);
    const parts = [];
    if (result.reverted.length) parts.push(`<p>🎉 Reverted ${result.reverted.length} rule${result.reverted.length === 1 ? '' : 's'}.</p>`);
    if (result.failed.length) {
      parts.push(
        `<p>⚠️ Couldn't revert ${result.failed.length}:</p><ul style="margin:0;padding-left:20px">` +
        result.failed.map((f) => `<li>${escHtmlCh(f.ownerName)} → ${escHtmlCh(f.targetName)}: ${escHtmlCh(f.message)}</li>`).join('') +
        '</ul>'
      );
    }
    $ch('chHistoryRevertResult').innerHTML = parts.join('');
    $ch('chHistoryRevertResult').classList.toggle('callout--success', result.failed.length === 0);
    $ch('chHistoryRevertResult').classList.toggle('callout--warning', result.failed.length > 0);
    $ch('chHistoryRevertResult').classList.remove('hidden');
  } catch (e) {
    chHandleError(e, chDoHistoryRevert);
  } finally {
    btn.disabled = false;
  }
}

// Exposed for cleanup-app.js's showUtilitiesSubTab seam (same "deliberate seam, function defined by
// a later-loaded script" technique rgLoadPickers already uses). chLoadSnapshotStatus only checks
// the local snapshot-status file, never Vortex's live state, so it's always been safe to run on
// every visit. chCheckScanFreshnessAsync DOES touch Vortex's live database file -- but only ever
// reads a safe copy the same way Scan itself does, so running it here too (rather than waiting for
// a Scan click) doesn't cross that "never touch Vortex's live state just from opening a tab" line,
// it just runs the SAME read earlier so the warning has a chance to show before the user acts on
// possibly-stale scan results, not only after.
function loadCycleHelperPageOnce() {
  chLoadSnapshotStatus();
  chCheckScanFreshnessAsync();
}
window.loadCycleHelperPageOnce = loadCycleHelperPageOnce;

// Exposed for cleanup-app.js's showUtilitiesSubTab when arriving at cyclehelper from a different
// sub-tab. Resets to the Prep screen and clears in-progress validation/fix state, same "start fresh
// on entry" behavior mergeResetOnEntry/ucv2ResetOnEntry already provide for their respective areas.
window.chStartOver = chStartOver;

// ---- Graph View (2026-08-18) -- a spider-web visualization of the scan's own cycle(s), matching
// real Vortex's own conflict graph (mod-dependency-manager/src/views/{GraphView,ConflictGraph}.tsx,
// confirmed against real source): near-fullscreen dialog, right-click a mod to highlight the cycle
// running through it (cytoscape's own real `cxttap` event, same trigger Vortex uses), scroll to
// zoom / drag background to pan / drag a node to reposition it -- all real cytoscape defaults, no
// extra wiring needed for any of those three. The left-hand cycle-card column (push a button, see
// that cycle highlighted) is this project's OWN addition on top of Vortex's real shape, director's
// own explicit ask. Built directly against the approved design/cycle-helper-graph-mockup.html --
// reuses chLastResult (the same data chRenderScanResult already has) and chTopCandidateGraphEdge's
// own owner/target -> from/to convention already established above for the culprit-path arrow.
//
// Built ENTIRELY from chLastResult.cycles -- no new backend route. Each cycle is one SCC (strongly
// connected component, cycle-detector.js's own analyzeCycles), so cycles never share mods; the
// combined graph is just the disjoint union of every cycle's own modsInvolved (nodes) + candidates
// (real directional rules, deduped server-side already -- confirmed by reading cycle-detector.js's
// own rankCulpritEdges/dedupedCandidates directly, not assumed).
//
// A highlight (right-click, or a cycle-card button) traces ONE minimal loop via cytoscape's own
// aStar (chGraphTraceCycleFromNode below), ported directly from real Vortex's own GraphView.tsx --
// NOT "highlight every mod/edge the scan flagged as part of this cycle's tangle", which is what an
// earlier version of this feature did and is wrong (lights up the entire, possibly dozens-of-mods
// strongly-connected component instead of the small loop real Vortex shows; confirmed wrong by the
// director comparing side-by-side against real Vortex screenshots, 2026-08-18).
cytoscape.use(cytoscapeCoseBilkent);

let chGraph = null; // the live cytoscape instance -- created fresh on every open, destroyed on close
let chGraphCycles = []; // [{ modCount, culprit, culpritStartNodeId }], index-aligned with chLastResult.cycles
let chGraphNodeToCycle = new Map(); // modKey -> cycle index, for the right-click handler
let chGraphCtxNodeId = null; // raw modKey right-clicked -- what "Highlight cycle from here" traces from

// A candidate is {ownerModKey, targetModKey, ruleType}. Real edge direction, confirmed against
// Vortex's own sort.ts (cycle-detector.js's buildGraph, re-verified line-by-line against source):
// 'before' on owner referencing target -> edge owner->target (owner sorts before target); 'after'
// -> edge target->owner. Same mapping chTopCandidateGraphEdge above already uses for the single
// top-ranked candidate -- this just applies it to every candidate, not just the top one.
function chGraphEdgeDirection(c) {
  return c.ruleType === 'before'
    ? { from: c.ownerModKey, to: c.targetModKey }
    : { from: c.targetModKey, to: c.ownerModKey };
}

// Also returns the top candidate's own real "from" modKey (see chGraphEdgeDirection) -- the natural
// starting node for this cycle's own trace when a card button is pushed (2026-08-18, see
// chGraphTraceCycleFromNode below): pushing the button and right-clicking that same mod now produce
// the identical traced loop.
function chGraphCulpritInfo(cycle) {
  const top = cycle.candidates[0];
  if (!top) return { html: '', startNodeId: null };
  const { from, to } = chGraphEdgeDirection(top);
  const fromName = from === top.ownerModKey ? top.ownerName : top.targetName;
  const toName = to === top.ownerModKey ? top.ownerName : top.targetName;
  const html = `Likely cause: <b>${escHtmlCh(fromName)}</b> &rarr; <b>${escHtmlCh(toName)}</b> ("load ${top.ruleType}" rule)`;
  return { html, startNodeId: from };
}

// Builds cytoscape elements straight from the scan result -- node ids are raw modKeys (never run
// through a CSS-selector string), always looked up via cy.getElementById() (a hash-map lookup, not
// a selector parse), so no sanitizing is needed regardless of what characters a modKey contains.
// Edge ids include the owning modKey (mirrors cycle-detector.js's own edgeKey() convention) because
// two DIFFERENT rule objects -- one "before" on mod A, one "after" on mod B -- can resolve to the
// exact SAME directed edge A->B; deduping only collapses truly identical (owner, type, target)
// triples, so both can legitimately reach the graph as parallel edges (cytoscape auto-offsets them
// visually when this happens -- real data, not a bug).
function chBuildGraphData(cycles) {
  const elements = [];
  const cycleInfo = [];
  const nodeToCycle = new Map();
  cycles.forEach((cycle, idx) => {
    cycle.modsInvolved.forEach((m) => {
      nodeToCycle.set(m.modKey, idx);
      elements.push({ data: { id: m.modKey, title: m.name } });
    });
    const seenEdgeIds = new Set();
    cycle.candidates.forEach((c) => {
      const { from, to } = chGraphEdgeDirection(c);
      const edgeId = `${from}->${to}::${c.ownerModKey}`;
      if (seenEdgeIds.has(edgeId)) return;
      seenEdgeIds.add(edgeId);
      elements.push({ data: { id: edgeId, source: from, target: to } });
    });
    const culpritInfo = chGraphCulpritInfo(cycle);
    cycleInfo.push({ modCount: cycle.modCount, culprit: culpritInfo.html, culpritStartNodeId: culpritInfo.startNodeId });
  });
  return { elements, cycleInfo, nodeToCycle };
}

function chGraphCycleCardHtml(c, idx) {
  return `<div class="ch-graph-cycle-card${idx === 0 ? ' active' : ''}" data-cycle-idx="${idx}">
    <div class="ch-graph-cycle-card__head">
      <span class="ch-graph-cycle-card__title">Cycle ${idx + 1}</span>
      <span class="ch-graph-cycle-card__count">${c.modCount} mods</span>
    </div>
    <div class="ch-graph-cycle-card__culprit">${c.culprit}</div>
    <button class="ch-graph-cycle-card__btn">${idx === 0 ? 'Showing in graph' : 'Show in graph'}</button>
  </div>`;
}

// Reads this app's OWN real theme CSS custom properties (not Vortex's) -- getComputedStyle picks up
// whatever theme.js has already applied (an inline --accent/etc. override on <html>, see theme.js's
// own applyTheme), so the graph's node/edge colors stay correct across every theme this app ships
// (dark/light/Skyrim), unlike the approved mockup's own hardcoded hex values (never exercised
// against a theme switch there).
function chGraphThemeColor(varName) {
  return getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
}

// Darkens a `#rrggbb` theme color toward black by `amount` (0-1) -- used so a mod's dot reads as a
// darker shade of its own outline/edge color instead of an unrelated neutral panel fill.
function chGraphDarken(hex, amount) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const r = Math.round(((n >> 16) & 255) * (1 - amount));
  const g = Math.round(((n >> 8) & 255) * (1 - amount));
  const b = Math.round((n & 255) * (1 - amount));
  return `rgb(${r}, ${g}, ${b})`;
}

function chGraphBuildStyle() {
  const accent = chGraphThemeColor('--accent');
  const border = chGraphThemeColor('--border-strong');
  const surface = chGraphThemeColor('--surface');
  const text = chGraphThemeColor('--text');
  return [
    {
      selector: 'node',
      style: {
        'background-color': chGraphDarken(border, 0.4),
        label: 'data(title)',
        color: text,
        'text-background-color': surface,
        'text-background-opacity': 1,
        'text-background-padding': 4,
        'text-margin-y': -18,
        'text-border-width': 1,
        'text-border-color': border,
        'text-border-opacity': 1,
        'text-border-style': 'solid',
        'font-size': 11,
        width: 24,
        height: 24,
        'border-width': 2,
        'border-color': border,
      },
    },
    {
      selector: 'edge',
      style: {
        width: 1,
        'curve-style': 'bezier',
        // Real Vortex puts the arrowhead at the edge's MIDPOINT, not its end
        // (genGraphStyle.ts: mid-target-arrow-shape, not target-arrow-shape) --
        // matches, since a dense graph's edge ends get crowded right at the node.
        'mid-target-arrow-shape': 'triangle',
        'arrow-scale': 1.1,
        'line-color': border,
        'mid-target-arrow-color': border,
      },
    },
    { selector: 'edge.cycle-highlight', style: { 'line-color': accent, 'mid-target-arrow-color': accent, width: 2 } },
    { selector: '.cycle-dim', style: { opacity: 0.25 } },
    { selector: 'node.cycle-node', style: { 'border-color': accent, 'background-color': chGraphDarken(accent, 0.4) } },
  ];
}

// Traces the SINGLE minimal loop through startNodeId -- ported directly from real Vortex's own
// GraphView.tsx#highlightCycle (confirmed against source 2026-08-18, re-fetched fresh first): look
// at startNodeId's direct outgoing neighbor NODES, then run cytoscape's own built-in aStar from each
// neighbor back to startNodeId in turn; the FIRST neighbor that has a real directed path back (in
// cytoscape's own outgoer iteration order -- same as Vortex, not "try all and pick shortest") IS the
// traced loop. This is why real Vortex lights up a small handful of edges on a dense 28-mod tangle,
// not the whole strongly-connected component -- the earlier version of this feature highlighted the
// SCC directly (everything Cycle Helper's own scan flagged as part of the tangle) instead of tracing
// one actual loop through it, confirmed wrong by the director comparing side-by-side against real
// Vortex screenshots. Returns null if no path back exists (shouldn't happen for a node this project
// already knows is cycle-flagged, but real Vortex's own algorithm can fail to find one too -- same
// graceful no-highlight-change response, no error surfaced).
function chGraphTraceCycleFromNode(startNodeId) {
  if (!chGraph) return null;
  const startNode = chGraph.getElementById(startNodeId);
  if (startNode.empty()) return null;

  const followers = startNode.outgoers().filter((ele) => ele.isNode());
  let path = null;
  let rootNode = null;
  followers.forEach((followerNode) => {
    if (path) return; // first successful follower wins -- matches real Vortex's own iteration order
    const result = chGraph.elements().aStar({ root: followerNode, goal: startNode, directed: true });
    if (result.found) { path = result.path; rootNode = followerNode; }
  });
  if (!path) return null;

  // aStar's own path runs root -> ... -> goal(=startNode) -- it never includes the edge that got us
  // TO root in the first place (startNode -> root), so that closing edge is added back explicitly,
  // same as real Vortex's own highlightCycle does.
  return {
    closingEdges: startNode.edgesTo(rootNode),
    pathEdges: path.filter((ele) => ele.isEdge()),
    pathNodes: path.filter((ele) => ele.isNode()),
  };
}

// Applies the traced-loop highlight. The SET being highlighted had to match real Vortex exactly (a
// single minimal loop via aStar, confirmed above) -- dimming everything else is this project's own
// addition on top, kept after director review 2026-08-18 ("I'm ok with dimming what is really not
// part of the cycle"), even though real Vortex itself never dims the rest of the graph.
function chGraphHighlightLoop(startNodeId) {
  const trace = chGraphTraceCycleFromNode(startNodeId);
  if (!trace) return false;
  chGraph.elements().removeClass('cycle-dim cycle-highlight cycle-node');
  chGraph.elements().addClass('cycle-dim');
  trace.pathNodes.removeClass('cycle-dim').addClass('cycle-node');
  trace.pathEdges.union(trace.closingEdges).removeClass('cycle-dim').addClass('cycle-highlight');
  return true;
}

function chGraphSetActiveCard(idx) {
  document.querySelectorAll('#chGraphCycleCards .ch-graph-cycle-card').forEach((card) => {
    const active = idx !== null && Number(card.dataset.cycleIdx) === idx;
    card.classList.toggle('active', active);
    card.querySelector('.ch-graph-cycle-card__btn').textContent = active ? 'Showing in graph' : 'Show in graph';
  });
}

// Cycle-card button -- traces from that cycle's own culprit "from" mod (the same one shown in the
// card's "Likely cause" line), so pushing the button and right-clicking that exact mod produce the
// identical highlighted loop.
function chGraphShowCycleCard(idx) {
  if (!chGraph) return;
  const info = chGraphCycles[idx];
  if (!info || !info.culpritStartNodeId) return;
  if (!chGraphHighlightLoop(info.culpritStartNodeId)) return;
  chGraphSetActiveCard(idx);
  $ch('chGraphToolbarLabel').innerHTML = `Showing <b>Cycle ${idx + 1}</b>'s traced loop — everything else is dimmed`;
}

function chShowGraphAll() {
  if (!chGraph) return;
  chGraph.elements().removeClass('cycle-dim cycle-highlight cycle-node');
  chGraphSetActiveCard(null);
  $ch('chGraphToolbarLabel').textContent = 'Showing the whole rule graph';
}

// Real trigger Vortex itself uses (cxttap = right-click/long-press). A node not in any cycle is
// only theoretically possible here (every node in this graph comes from a real cycle by
// construction, since the graph is built purely from chLastResult.cycles) -- kept anyway so the
// context menu's shape matches real Vortex's own (which DOES have non-cycle-eligible nodes in its
// general graph) and stays correct if a future change ever adds non-cycle context to this graph.
function chGraphHandleContext(evt) {
  const nodeId = evt.target.id();
  const inCycle = chGraphNodeToCycle.has(nodeId);
  $ch('chGraphCtxHighlight').style.display = inCycle ? 'block' : 'none';
  $ch('chGraphCtxNoCycle').style.display = inCycle ? 'none' : 'block';
  chGraphCtxNodeId = inCycle ? nodeId : null;
  const menu = $ch('chGraphCtxMenu');
  const pos = evt.originalEvent;
  menu.style.left = `${pos.clientX}px`;
  menu.style.top = `${pos.clientY}px`;
  menu.style.display = 'block';
}

// Right-click "Highlight cycle from here" -- traces from the actual node that was right-clicked
// (not necessarily any cycle card's own culprit mod), same real Vortex trigger and algorithm. Clears
// any active card state since this loop may not match what a specific card button would trace.
function chGraphHighlightFromContextNode() {
  if (chGraphCtxNodeId === null) return;
  if (!chGraphHighlightLoop(chGraphCtxNodeId)) return;
  chGraphSetActiveCard(null);
  $ch('chGraphToolbarLabel').textContent = 'Showing a traced loop — everything else is dimmed';
}

function chOpenGraphModal() {
  if (!chLastResult || !chLastResult.hasCycles) return;
  const { elements, cycleInfo, nodeToCycle } = chBuildGraphData(chLastResult.cycles);
  chGraphCycles = cycleInfo;
  chGraphNodeToCycle = nodeToCycle;

  $ch('chGraphCyclesCallout').innerHTML = `<span class="callout__title">${cycleInfo.length} cycle${cycleInfo.length === 1 ? '' : 's'} found</span>What you're seeing here is our best guess of the rule most likely causing each cycle, ranked by real evidence — not a certainty. If a fix doesn't look right, a little manual digging in Vortex is a normal part of sorting this out.`;
  $ch('chGraphCycleCards').innerHTML = cycleInfo.map((c, i) => chGraphCycleCardHtml(c, i)).join('');
  $ch('chGraphCtxMenu').style.display = 'none';

  $ch('chGraphModal').classList.remove('hidden');

  // The modal was just un-hidden this same tick -- cytoscape needs its container to already have a
  // real, non-zero size to lay out sanely, so defer one frame until the browser's actually painted it.
  requestAnimationFrame(() => {
    if (chGraph) { chGraph.destroy(); chGraph = null; }
    chGraph = cytoscape({
      container: $ch('chGraphCanvas'),
      elements,
      style: chGraphBuildStyle(),
      minZoom: 0.3,
      maxZoom: 2.5,
      wheelSensitivity: 0.2,
      boxSelectionEnabled: false,
    });
    chGraph.layout({
      name: 'cose-bilkent', nodeDimensionsIncludeLabels: true, randomize: false,
      nodeRepulsion: 8000, idealEdgeLength: 160,
    }).run();
    chGraph.on('cxttap', 'node', chGraphHandleContext);
    // Opens already showing Cycle 1's own traced loop, same as the approved mockup -- if there's
    // only one cycle this also means "just show me the thing" with zero extra clicks.
    chGraphShowCycleCard(0);
  });
}

function chCloseGraphModal() {
  $ch('chGraphModal').classList.add('hidden');
  $ch('chGraphCtxMenu').style.display = 'none';
  if (chGraph) { chGraph.destroy(); chGraph = null; }
}

// The dialog is a fixed vw/vh box, so it scales if the browser window itself resizes -- keep
// cytoscape's own internal canvas in sync (matches the approved mockup's own ResizeObserver use).
// Safe to observe unconditionally at load time: while the modal is hidden the canvas has zero size,
// so this fires harmlessly with chGraph still null (guarded below) until the modal actually opens.
new ResizeObserver(() => { if (chGraph) chGraph.resize(); }).observe($ch('chGraphCanvas'));

document.addEventListener('DOMContentLoaded', () => {
  chGoScreen('chScreenPrep');
  $ch('chSnapBtn').addEventListener('click', chTakeSnapshot);
  $ch('chScanBtn').addEventListener('click', chScan);
  $ch('chBackFromCleanBtn').addEventListener('click', chStartOver);

  $ch('chCyclesList').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-cycle-idx]');
    if (!btn) return;
    chOpenFixModal(Number(btn.dataset.cycleIdx), Number(btn.dataset.candIdx));
  });
  $ch('chFixOptions').addEventListener('click', (e) => {
    const opt = e.target.closest('.ch-fix-option');
    if (!opt) return;
    chSelectedFix.action = opt.dataset.action;
    $ch('chFixOptions').querySelectorAll('.ch-fix-option').forEach((o) => o.classList.toggle('sel', o === opt));
    opt.querySelector('input').checked = true;
  });
  $ch('chFixCancelBtn').addEventListener('click', chCloseFixModal);
  $ch('chFixContinueBtn').addEventListener('click', chOpenApplyScreen);

  $ch('chApplyCancelBtn').addEventListener('click', () => chGoScreen('chScreenCycles'));
  $ch('chApplyConfirmBtn').addEventListener('click', chConfirmApply);

  $ch('chValidateStartOverBtn').addEventListener('click', chStartOver);
  $ch('chValidateStillCyclingList').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-cycle-idx]');
    if (!btn) return;
    chOpenFixModal(Number(btn.dataset.cycleIdx), Number(btn.dataset.candIdx));
  });
  $ch('chSessionSoFarWrap').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-fix-idx]');
    if (!btn) return;
    chRevertSessionFix(Number(btn.dataset.fixIdx));
  });

  // ---- Graph View ----
  $ch('chViewGraphBtn').addEventListener('click', chOpenGraphModal);
  $ch('chGraphCloseX').addEventListener('click', chCloseGraphModal);
  $ch('chGraphCloseBtn').addEventListener('click', chCloseGraphModal);
  $ch('chGraphResetBtn').addEventListener('click', chShowGraphAll);
  $ch('chGraphCycleCards').addEventListener('click', (e) => {
    const card = e.target.closest('.ch-graph-cycle-card');
    if (!card) return;
    chGraphShowCycleCard(Number(card.dataset.cycleIdx));
  });
  $ch('chGraphUsageToggle').addEventListener('click', () => {
    const panel = $ch('chGraphUsagePanel');
    const open = panel.classList.toggle('open');
    $ch('chGraphUsageToggle').textContent = open ? 'Hide Usage Instructions' : 'Show Usage Instructions';
  });
  $ch('chGraphCanvas').addEventListener('contextmenu', (e) => e.preventDefault());
  $ch('chGraphCtxHighlight').addEventListener('click', () => {
    chGraphHighlightFromContextNode();
    $ch('chGraphCtxMenu').style.display = 'none';
  });
  document.addEventListener('click', (e) => {
    const menu = $ch('chGraphCtxMenu');
    if (menu.style.display === 'block' && !menu.contains(e.target)) menu.style.display = 'none';
  });

  // ---- Change History + Revert ----
  $ch('chViewHistoryBtn').addEventListener('click', chOpenHistoryScreen);
  $ch('chHistoryBackBtn').addEventListener('click', (e) => { e.preventDefault(); chGoScreen('chScreenPrep'); });
  $ch('chHistoryReviewBackBtn').addEventListener('click', (e) => { e.preventDefault(); chGoScreen('chScreenHistory'); });
  $ch('chHistoryList').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-session-idx]');
    if (!btn) return;
    chOpenHistoryReview(chHistorySessions[Number(btn.dataset.sessionIdx)]);
  });
  $ch('chHistoryReviewSelectAll').addEventListener('change', (e) => {
    document.querySelectorAll('#chHistoryReviewRows .ch-revert-row').forEach((cb) => { cb.checked = e.target.checked; });
    chUpdateHistoryRevertBtn();
  });
  $ch('chHistoryReviewRows').addEventListener('change', (e) => {
    if (e.target.classList.contains('ch-revert-row')) chUpdateHistoryRevertBtn();
  });
  $ch('chHistoryCancelBtn').addEventListener('click', () => chGoScreen('chScreenHistory'));
  $ch('chHistoryRevertBtn').addEventListener('click', chDoHistoryRevert);
});
