'use strict';
// Rules Generator Report (Reports area) -- Completed/Exceptions breakdown for a chosen old/new
// collection pair. Own tiny helpers, independent of rules-generator-app.js/stats-app.js -- same
// "self-contained area" convention already used throughout this project (each Reports sub-tab can
// be worked on without touching already-validated code elsewhere).

function $g(id) { return document.getElementById(id); }

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

async function rgReportApi(method, path, body) {
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

// retryFn (queue: vortex-retry-noop-sweep): same fix as rules-generator-app.js's own rgHandleError
// -- Try Again used to always call a hardcoded no-op, silently doing nothing for every failure on
// this page, not just this one report's own generate step.
function rgReportHandleError(e, retryFn) {
  $g('rgReportLoading').classList.add('hidden');
  // Vortex-running always goes through the shared modal (window.showVortexRunningModal), same
  // convention as rules-generator-app.js's own rgHandleError -- confirmed 2026-07-27 this needs to
  // be consistent everywhere: it's a normal precondition, not an error, so it always gets the same
  // warning-styled shared popup rather than sometimes rendering inline as a critical/red callout.
  if (e.status === 409 && e.body?.error === 'vortex-running') {
    window.showVortexRunningModal(retryFn || (() => {}));
    return;
  }
  const box = $g('rgReportCriticalError');
  box.textContent = e.message;
  box.classList.remove('hidden');
}

function rgReportModRow(title, detail) {
  return el('li', {}, [el('strong', {}, title), ' -- ' + detail]);
}

let rgReportPickersLoaded = false;
async function loadRulesGenReportPageOnce() {
  if (rgReportPickersLoaded) return;
  rgReportPickersLoaded = true;
  await rgReportLoadPickers();
}

// Split out from loadRulesGenReportPageOnce (queue: vortex-retry-noop-sweep) so a Vortex-running
// retry can call the real fetch logic directly -- passing the ONCE-guarded wrapper itself as a
// retryFn would silently no-op on the SECOND call (rgReportPickersLoaded is already true by then),
// making Try Again just as broken as the bug this pass fixes, only one level removed.
async function rgReportLoadPickers() {
  try {
    // Reset both selects to just their placeholder first -- this can now run more than once (a
    // Vortex-running retry), so it must not append a duplicate set of options each time.
    $g('rgReportOldSelect').innerHTML = '<option value="">-- Original collection --</option>';
    $g('rgReportNewSelect').innerHTML = '<option value="">-- New collection --</option>';
    $g('rgReportEmpty').classList.add('hidden');

    let vortexBlockedNew = false;
    const [oldRes, workshopRes] = await Promise.all([
      rgReportApi('GET', '/api/rules-generator/collections'),
      rgReportApi('GET', '/api/rules-generator/workshop-collections').catch((e) => {
        // Vortex running only blocks the (live-state-derived) new-collection half -- the
        // Vortex-closed-independent old-collection list still loads fine in parallel. Surfaced via
        // the real shared modal now (queue: vortex-modal-consistency-sweep, director-confirmed live
        // 2026-08-15: this used to fall back to a plain muted inline line here, which read as a
        // quiet, easy-to-miss exception to how every other "Vortex must be closed" moment in this
        // app looks), with a working retry -- not swallowed into a silent, unlabeled empty list.
        if (e.status === 409 && e.body?.error === 'vortex-running') {
          vortexBlockedNew = true;
          window.showVortexRunningModal(rgReportLoadPickers);
          return { collections: [] };
        }
        throw e;
      }),
    ]);

    const oldSelect = $g('rgReportOldSelect');
    oldRes.collections
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((c) => {
        const opt = document.createElement('option');
        opt.value = c.modId; // this API's own field name for what this project calls a modKey elsewhere
        opt.textContent = c.name;
        oldSelect.appendChild(opt);
      });

    const newSelect = $g('rgReportNewSelect');
    workshopRes.collections.forEach((c) => {
      const opt = document.createElement('option');
      opt.value = c.modKey;
      opt.textContent = c.name;
      newSelect.appendChild(opt);
    });
    // Genuinely zero new (Workshop) collections -- Vortex WAS closed, there just aren't any right
    // now. Distinct from the vortex-running case above, which is the modal's job to say now.
    if (workshopRes.collections.length === 0 && !vortexBlockedNew) {
      $g('rgReportEmpty').textContent = 'No new (Workshop) collections found yet.';
      $g('rgReportEmpty').classList.remove('hidden');
    }
  } catch (e) {
    rgReportHandleError(e, rgReportLoadPickers);
  }
}

function rgReportUpdateGenerateButton() {
  $g('rgReportGenerateBtn').disabled = !($g('rgReportOldSelect').value && $g('rgReportNewSelect').value);
}

// A Set of active sections -- empty shows all 4, multi-select (each badge toggles independently),
// matching this app's established "click a badge to filter, click again (or Show all) to clear"
// convention elsewhere (Stats Report, Work Through Report, Rules Generator's own summary badges) --
// workspace UX-PRINCIPLES.md rule 7, applied app-wide 2026-08-15.
//
// 4 sections (2026-08-17, up from the original 2) -- director's own ask: Completed/Exceptions/
// Skipped/Old version each need their own filter badge instead of "Old version"/"Skipped" only
// being reachable bundled inside "Exceptions". "Skipped" bundles all 3 skip KINDS (already-set,
// disabled, no-conflict) under one badge -- they're the same kind of content (a real rule found,
// but not set, with a reason why), just three different reasons, matching this task's own framing
// of "the Skipped section" as one thing. RG_REPORT_SECTION_CONFIG drives both the badge row and the
// section-visibility toggle from one array, rather than 4 near-identical hand-written badges.
let rgReportSectionFilter = new Set();
let rgReportLastCounts = { completed: 0, exceptions: 0, skipped: 0, oldVersion: 0 };
const RG_REPORT_SECTION_CONFIG = [
  { key: 'completed', id: 'rgReportCompletedSection', cls: 'badge--success', label: 'Completed' },
  { key: 'exceptions', id: 'rgReportExceptionsSection', cls: 'badge--warning', label: 'Exceptions' },
  { key: 'skipped', id: 'rgReportSkippedSection', cls: 'badge--warning', label: 'Skipped' },
  { key: 'oldVersion', id: 'rgReportOldVersionSection', cls: 'badge--neutral', label: 'Old version still installed' },
];
const RG_REPORT_SECTION_IDS = Object.fromEntries(RG_REPORT_SECTION_CONFIG.map((s) => [s.key, s.id]));

function rgReportRenderBadges() {
  const badges = $g('rgReportSummaryBadges');
  badges.innerHTML = '';
  for (const { key, cls, label } of RG_REPORT_SECTION_CONFIG) {
    const active = rgReportSectionFilter.has(key);
    badges.appendChild(el('span', { class: `badge ${cls} badge--clickable${active ? ' badge--filter-active' : ''}`, 'data-section': key },
      [el('span', { class: 'badge__count' }, String(rgReportLastCounts[key])), ` ${label}`]));
  }
  badges.appendChild(el('span', { class: `badge badge--show-all${rgReportSectionFilter.size === 0 ? ' badge--filter-active' : ''}` }, 'Show all'));
  for (const [section, id] of Object.entries(RG_REPORT_SECTION_IDS)) {
    $g(id).classList.toggle('hidden', rgReportSectionFilter.size > 0 && !rgReportSectionFilter.has(section));
  }
}

// Renders one report's worth of data into the page -- factored out of rgReportGenerate (2026-08-16)
// so a Clear's own freshReport (returned inline from the write, zero staleness risk -- see
// rules-generator-worker.js's own clear-skipped-write comment) can re-render in place without a
// second /report round-trip that could show stale pre-clear data.
function rgReportRender(report) {
  $g('rgReportClearDoneInfo').classList.add('hidden');

  // Split into 4 independent counts (2026-08-17, was 2: completed/exceptions bundled everything
  // else together) -- exceptions is now unresolvedAnomalies ONLY; skipped sums all 3 skip kinds
  // (already-set/disabled/no-conflict) since they share one badge/section; oldVersion is its own.
  const skipCount = (list) => list.reduce((sum, m) => sum + m.skips.length, 0);
  rgReportLastCounts = {
    completed: report.completed.length + report.resolvedAnomalyCount,
    exceptions: report.exceptions.unresolvedAnomalies.length,
    skipped: skipCount(report.exceptions.skippedAlreadySet) + skipCount(report.exceptions.skippedDisabled) + skipCount(report.exceptions.skippedNoConflict),
    oldVersion: report.exceptions.leftoverOldInstalls.length,
  };
  rgReportRenderBadges();

  $g('rgReportResolvedNote').textContent = report.resolvedAnomalyCount > 0
    ? `That includes ${report.resolvedAnomalyCount} mod(s) where you'd already picked the right match yourself.`
    : '';

  const completedList = $g('rgReportCompletedList');
  completedList.innerHTML = '';
  if (report.completed.length === 0) {
    const rgName = window.themedToolName ? window.themedToolName('rules-generator', 'Rules Generator') : 'Rules Generator';
    completedList.appendChild(el('li', { class: 'muted' }, `Nothing resolved yet -- run ${rgName} and click Apply to Vortex first.`));
  } else {
    for (const c of report.completed) {
      // ruleCount === 0 here (2026-08-16) means every one of this mod's rules is ALREADY correctly
      // applied -- not "nothing to copy" (that case is already silently excluded server-side, see
      // computeReportData's own comment) -- so it reads as fully done, not as a stale "0 rule(s)
      // copied" row that would otherwise imply nothing ever happened for this mod.
      const detail = c.ruleCount > 0
        ? `${c.ruleCount} rule(s) copied from ${c.oldModName}`
        : `already fully set up (copied from ${c.oldModName})`;
      completedList.appendChild(rgReportModRow(c.newModName, detail));
    }
  }

  const decisionList = $g('rgReportNeedsDecisionList');
  decisionList.innerHTML = '';
  if (report.exceptions.unresolvedAnomalies.length === 0) {
    decisionList.appendChild(el('li', { class: 'muted' }, "Nothing here -- you're all caught up!"));
  } else {
    for (const a of report.exceptions.unresolvedAnomalies) {
      // previousChoice (2026-08-16): you picked this before, but the old collection's own rule for
      // it has since changed type -- worth a distinct note so it doesn't read as a totally fresh,
      // never-seen-before question.
      const detail = a.previousChoice
        ? `could match more than one mod: ${a.candidates.join(', ')} -- you previously picked ${a.previousChoice.targetName} (${rgRuleLabel(a.previousChoice.type)}), but that's changed since then`
        : `could match more than one mod: ${a.candidates.join(', ')}`;
      decisionList.appendChild(rgReportModRow(a.modName, detail));
    }
  }

  const leftoverList = $g('rgReportLeftoverList');
  leftoverList.innerHTML = '';
  if (report.exceptions.leftoverOldInstalls.length === 0) {
    leftoverList.appendChild(el('li', { class: 'muted' }, "Nothing here -- you're all caught up!"));
  } else {
    for (const l of report.exceptions.leftoverOldInstalls) {
      leftoverList.appendChild(rgReportModRow(l.newCounterpartName, `the older version (${l.oldModName}) is still installed`));
    }
  }

  // Skipped-already-set exceptions (2026-08-16) -- see index.html's own comment on this section for
  // the full rationale. Each mod's skips rendered as one row per (target, intended-vs-current type)
  // pair, so a mod with several skipped rules shows all of them, not just one.
  const skippedList = $g('rgReportSkippedList');
  skippedList.innerHTML = '';
  const totalSkips = report.exceptions.skippedAlreadySet.reduce((sum, m) => sum + m.skips.length, 0);
  if (totalSkips === 0) {
    skippedList.appendChild(el('li', { class: 'muted' }, "Nothing here -- you're all caught up!"));
    $g('rgReportSkippedActions').classList.add('hidden');
  } else {
    for (const m of report.exceptions.skippedAlreadySet) {
      for (const s of m.skips) {
        skippedList.appendChild(rgReportModRow(
          m.modName,
          `should be ${rgRuleLabel(s.intendedType)} ${s.targetName} (copied from the old collection), but it's currently set to ${rgRuleLabel(s.currentType)}`,
        ));
      }
    }
    $g('rgReportSkippedActions').classList.remove('hidden');
    $g('rgReportClearStatus').textContent = '';
  }

  // Skipped-disabled exceptions (2026-08-16) -- see index.html's own comment on this section for the
  // full rationale. Purely informational, no action button -- nothing was ever written, so there's
  // nothing to clear (unlike the skippedAlreadySet section above).
  const skippedDisabledList = $g('rgReportSkippedDisabledList');
  skippedDisabledList.innerHTML = '';
  const totalSkippedDisabled = report.exceptions.skippedDisabled.reduce((sum, m) => sum + m.skips.length, 0);
  if (totalSkippedDisabled === 0) {
    skippedDisabledList.appendChild(el('li', { class: 'muted' }, "Nothing here -- you're all caught up!"));
  } else {
    for (const m of report.exceptions.skippedDisabled) {
      for (const s of m.skips) {
        skippedDisabledList.appendChild(rgReportModRow(
          m.modName,
          `should be ${rgRuleLabel(s.type)} ${s.targetName} (copied from the old collection), but that mod is disabled in Vortex`,
        ));
      }
    }
  }

  // Skipped-no-conflict exceptions (2026-08-16) -- see index.html's own comment on this section for
  // the full rationale. Same purely-informational, no-action-button shape as skippedDisabled above.
  const skippedNoConflictList = $g('rgReportSkippedNoConflictList');
  skippedNoConflictList.innerHTML = '';
  const totalSkippedNoConflict = report.exceptions.skippedNoConflict.reduce((sum, m) => sum + m.skips.length, 0);
  if (totalSkippedNoConflict === 0) {
    skippedNoConflictList.appendChild(el('li', { class: 'muted' }, "Nothing here -- you're all caught up!"));
  } else {
    for (const m of report.exceptions.skippedNoConflict) {
      for (const s of m.skips) {
        skippedNoConflictList.appendChild(rgReportModRow(
          m.modName,
          `should be ${rgRuleLabel(s.type)} ${s.targetName} (copied from the old collection), but they don't currently share any files`,
        ));
      }
    }
  }

  $g('rgReportResults').classList.remove('hidden');
}

// Same four-option wording Rules Generator's own picker uses (rgRuleLabel in rules-generator-app.js)
// -- duplicated here rather than shared, since this page is deliberately self-contained (see this
// file's own header comment) and it's one small, stable lookup, not worth a cross-file dependency for.
function rgRuleLabel(type) {
  if (type === 'before') return 'before';
  if (type === 'after') return 'after';
  if (type === 'conflicts') return 'never together with';
  return '???';
}

async function rgReportGenerate() {
  $g('rgReportCriticalError').classList.add('hidden');
  $g('rgReportResults').classList.add('hidden');
  $g('rgReportLoading').classList.remove('hidden');
  const oldCollectionKey = $g('rgReportOldSelect').value;
  const newCollectionKey = $g('rgReportNewSelect').value;

  try {
    // No overrides passed in from here -- this report reflects the current, plain state of things.
    // A resolved anomaly still counts as Completed because computeReportData checks each anomaly's
    // OWN candidate pick server-side; passing {} just means "nothing new to resolve from this view".
    const report = await rgReportApi('POST', '/api/rules-generator/report', { oldCollectionKey, newCollectionKey, anomalyOverrides: {} });
    $g('rgReportLoading').classList.add('hidden');
    rgReportSectionFilter.clear(); // fresh report -- always start showing all sections
    rgReportRender(report);
  } catch (e) {
    rgReportHandleError(e, rgReportGenerate);
  }
}

// ---- "Clear these rules" (2026-08-16) -- see index.html's own comment on this section for the full
// rationale. Serious register throughout (TECHNICAL-FRIENDLY-VOICE-GUIDELINES.md): this removes real
// rules from Vortex's live database. Mirrors rules-generator-app.js's own
// rgOpenApplyConfirm/rgConfirmApply preview-then-confirm shape exactly, just for this page's own
// write instead. ----
async function rgReportOpenClearConfirm() {
  $g('rgReportCriticalError').classList.add('hidden');
  const btn = $g('rgReportClearSkippedBtn');
  const statusEl = $g('rgReportClearStatus');
  btn.disabled = true;
  statusEl.textContent = 'Checking what would change…';
  const oldCollectionKey = $g('rgReportOldSelect').value;
  const newCollectionKey = $g('rgReportNewSelect').value;
  try {
    const preview = await rgReportApi('POST', '/api/rules-generator/clear-skipped-preview', { oldCollectionKey, newCollectionKey, anomalyOverrides: {} });
    statusEl.textContent = '';
    if (preview.totalRulesToClear === 0) {
      statusEl.textContent = 'Nothing to clear right now -- it may have already changed since this report was generated. Try Generate Report again.';
      return;
    }
    $g('rgReportClearConfirmModalText').textContent =
      `This clears ${preview.totalRulesToClear} rule(s) across ${preview.totalModsAffected} mod(s) directly from Vortex's database -- only the specific rules shown above, nothing else on those mods. A full backup is taken first.`;
    $g('rgReportClearConfirmModal').classList.remove('hidden');
  } catch (e) {
    rgReportHandleError(e, rgReportOpenClearConfirm);
  } finally {
    btn.disabled = false;
  }
}

async function rgReportConfirmClear() {
  $g('rgReportClearConfirmModal').classList.add('hidden');
  const statusEl = $g('rgReportClearStatus');
  statusEl.textContent = 'Clearing…';
  const oldCollectionKey = $g('rgReportOldSelect').value;
  const newCollectionKey = $g('rgReportNewSelect').value;
  try {
    const result = await rgReportApi('POST', '/api/rules-generator/clear-skipped', { oldCollectionKey, newCollectionKey, anomalyOverrides: {} });
    statusEl.textContent = '';
    // result.freshReport is computed from the SAME in-memory-patched modIndex the clear itself just
    // wrote from -- zero staleness risk, no second /report call (same reasoning rules-generator-
    // app.js's own rgConfirmApply already documents for its own freshAnalysis). Rendered BEFORE the
    // "Cleared" callout is shown -- rgReportRender itself hides that callout at the top of every
    // render (it's meant to reset on a genuinely fresh report), so setting it after avoids the
    // render immediately hiding the very confirmation it's about to show.
    if (result.freshReport) rgReportRender(result.freshReport);
    $g('rgReportClearDoneText').textContent = `${result.totalRulesCleared} rule(s) cleared across ${result.totalModsChanged} mod(s).`;
    $g('rgReportClearDoneInfo').classList.remove('hidden');
  } catch (e) {
    rgReportHandleError(e, rgReportConfirmClear);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  $g('rgReportOldSelect').addEventListener('change', rgReportUpdateGenerateButton);
  $g('rgReportNewSelect').addEventListener('change', rgReportUpdateGenerateButton);
  $g('rgReportGenerateBtn').addEventListener('click', rgReportGenerate);
  $g('rgReportClearSkippedBtn').addEventListener('click', rgReportOpenClearConfirm);
  $g('rgReportClearConfirmModalCancel').addEventListener('click', () => {
    $g('rgReportClearConfirmModal').classList.add('hidden');
  });
  $g('rgReportClearConfirmModalOk').addEventListener('click', rgReportConfirmClear);
  $g('rgReportSummaryBadges').addEventListener('click', (e) => {
    if (e.target.closest('.badge--show-all')) {
      rgReportSectionFilter.clear();
      rgReportRenderBadges();
      return;
    }
    const badge = e.target.closest('.badge--clickable[data-section]');
    if (!badge) return;
    const section = badge.dataset.section;
    if (rgReportSectionFilter.has(section)) rgReportSectionFilter.delete(section); else rgReportSectionFilter.add(section);
    rgReportRenderBadges();
  });
});
