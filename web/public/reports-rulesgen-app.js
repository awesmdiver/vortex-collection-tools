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

function rgReportHandleError(e) {
  $g('rgReportLoading').classList.add('hidden');
  // Vortex-running always goes through the shared modal (window.showVortexRunningModal), same
  // convention as rules-generator-app.js's own rgHandleError -- confirmed 2026-07-27 this needs to
  // be consistent everywhere: it's a normal precondition, not an error, so it always gets the same
  // warning-styled shared popup rather than sometimes rendering inline as a critical/red callout.
  if (e.status === 409 && e.body?.error === 'vortex-running') {
    window.showVortexRunningModal(() => {});
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
  try {
    const [oldRes, workshopRes] = await Promise.all([
      rgReportApi('GET', '/api/rules-generator/collections'),
      rgReportApi('GET', '/api/rules-generator/workshop-collections').catch((e) => {
        // Vortex running is expected/common here -- don't block loading the (Vortex-closed-
        // independent) original-collection list just because this half needs Vortex closed.
        if (e.status === 409) return { collections: [] };
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
    if (workshopRes.collections.length === 0) {
      $g('rgReportEmpty').textContent = 'Close Vortex to load the list of new collections.';
      $g('rgReportEmpty').classList.remove('hidden');
    }
  } catch (e) {
    rgReportHandleError(e);
  }
}

function rgReportUpdateGenerateButton() {
  $g('rgReportGenerateBtn').disabled = !($g('rgReportOldSelect').value && $g('rgReportNewSelect').value);
}

// Which section is currently isolated -- null shows both (Completed/Exceptions), matching this
// app's established "click a badge to filter, click again (or Show all) to clear" convention
// elsewhere (Stats Report, Work Through Report, Rules Generator's own summary badges). Converted
// 2026-07-27 from plain non-clickable badges, for consistency with those.
let rgReportSectionFilter = null;
let rgReportLastCounts = { completed: 0, exceptions: 0 };
const RG_REPORT_SECTION_IDS = { completed: 'rgReportCompletedSection', exceptions: 'rgReportExceptionsSection' };

function rgReportRenderBadges() {
  const badges = $g('rgReportSummaryBadges');
  badges.innerHTML = '';
  const activeCompleted = rgReportSectionFilter === 'completed';
  const activeExceptions = rgReportSectionFilter === 'exceptions';
  const completedBadge = el('span', { class: `badge badge--success badge--clickable${activeCompleted ? ' badge--filter-active' : ''}`, 'data-section': 'completed' },
    [el('span', { class: 'badge__count' }, String(rgReportLastCounts.completed)), ' Completed']);
  const exceptionsBadge = el('span', { class: `badge badge--warning badge--clickable${activeExceptions ? ' badge--filter-active' : ''}`, 'data-section': 'exceptions' },
    [el('span', { class: 'badge__count' }, String(rgReportLastCounts.exceptions)), ' Exceptions']);
  const showAll = el('span', { class: `badge badge--show-all${rgReportSectionFilter === null ? ' badge--filter-active' : ''}` }, 'Show all');
  badges.appendChild(completedBadge);
  badges.appendChild(exceptionsBadge);
  badges.appendChild(showAll);
  for (const [section, id] of Object.entries(RG_REPORT_SECTION_IDS)) {
    $g(id).classList.toggle('hidden', rgReportSectionFilter !== null && rgReportSectionFilter !== section);
  }
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

    rgReportLastCounts = {
      completed: report.completed.length + report.resolvedAnomalyCount,
      exceptions: report.exceptions.unresolvedAnomalies.length + report.exceptions.leftoverOldInstalls.length,
    };
    rgReportSectionFilter = null; // fresh report -- always start showing both sections
    rgReportRenderBadges();

    $g('rgReportResolvedNote').textContent = report.resolvedAnomalyCount > 0
      ? `That includes ${report.resolvedAnomalyCount} mod(s) where you'd already picked the right match yourself.`
      : '';

    const completedList = $g('rgReportCompletedList');
    completedList.innerHTML = '';
    if (report.completed.length === 0) {
      completedList.appendChild(el('li', { class: 'muted' }, 'Nothing resolved yet -- run Rules Generator and click Apply to Vortex first.'));
    } else {
      for (const c of report.completed) {
        completedList.appendChild(rgReportModRow(c.newModName, `${c.ruleCount} rule(s) copied from ${c.oldModName}`));
      }
    }

    const decisionList = $g('rgReportNeedsDecisionList');
    decisionList.innerHTML = '';
    if (report.exceptions.unresolvedAnomalies.length === 0) {
      decisionList.appendChild(el('li', { class: 'muted' }, "Nothing here -- you're all caught up!"));
    } else {
      for (const a of report.exceptions.unresolvedAnomalies) {
        decisionList.appendChild(rgReportModRow(a.modName, `could match more than one mod: ${a.candidates.join(', ')}`));
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

    $g('rgReportResults').classList.remove('hidden');
  } catch (e) {
    rgReportHandleError(e);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  $g('rgReportOldSelect').addEventListener('change', rgReportUpdateGenerateButton);
  $g('rgReportNewSelect').addEventListener('change', rgReportUpdateGenerateButton);
  $g('rgReportGenerateBtn').addEventListener('click', rgReportGenerate);
  $g('rgReportSummaryBadges').addEventListener('click', (e) => {
    if (e.target.closest('.badge--show-all')) {
      rgReportSectionFilter = null;
      rgReportRenderBadges();
      return;
    }
    const badge = e.target.closest('.badge--clickable[data-section]');
    if (!badge) return;
    const section = badge.dataset.section;
    rgReportSectionFilter = rgReportSectionFilter === section ? null : section;
    rgReportRenderBadges();
  });
});
