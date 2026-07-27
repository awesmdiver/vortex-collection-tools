'use strict';
// Stats Report UI -- talks only to /api/stats and /api/rebuild/logs/:collectionModId (reused
// directly, no new endpoint needed for drill-down). Fully independent of app.js/sync-app.js/
// settings-app.js, same convention each of those already follows: own tiny helpers, no shared state.
//
// Wrapped in an IIFE so this file's own $g/el/api/etc. can't collide with same-named helpers in
// other page scripts sharing this one page's global scope (all loaded via plain <script src>, not
// modules). Confirmed live this collision is real, not theoretical: adding work-through-app.js
// (loaded after this file) with its own `api()`/`el()` silently overwrote THIS file's versions on
// `window` -- and, transitively, app.js's too, since app.js loads before both. Only the two names
// something else genuinely depends on are exported below; everything else stays private.
(function () {

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

async function api(method, path) {
  const res = await fetch(path, { method });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `Request failed (${res.status})`);
  return data;
}

// This page has no Vortex-running concerns of its own (Reports only ever reads log/state files this
// tool already owns), so the only thing worth checking for is the server being fully unreachable --
// same shared shell.js modal every other page uses.
function handleStatsApiError(e, retryFn) {
  if (isServerUnreachableError(e)) {
    showServerUnreachableError(retryFn);
    return true;
  }
  return false;
}

function fmtMs(ms) {
  if (ms == null) return '--';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}
function fmtDate(iso) {
  return iso ? new Date(iso).toLocaleString() : '--';
}

let loaded = false;
let currentPeriod = 'all';

async function loadOverview(period) {
  currentPeriod = period;
  document.querySelectorAll('.stats-period-btn').forEach((b) => {
    b.classList.toggle('btn--primary', b.dataset.period === period);
    b.classList.toggle('btn--ghost', b.dataset.period !== period);
  });

  let data;
  try {
    data = await api('GET', `/api/stats/overview?period=${encodeURIComponent(period)}`);
  } catch (e) {
    if (!handleStatsApiError(e, () => loadOverview(period))) {
      $g('statsOverviewMeta').textContent = `Failed to load: ${e.message}`;
    }
    return;
  }

  $g('statsOverviewMeta').textContent =
    `${data.totalRuns} run(s) across ${data.totalCollections} collection(s). ` +
    `Timing data available for ${data.logsWithTimingData} of ${data.logsTotal} run(s) -- older runs predate this feature.`;

  const badgesEl = $g('statsSummaryBadges');
  badgesEl.innerHTML = '';
  for (const [status, count] of Object.entries(data.summaryTotals)) {
    // Informational only (not clickable) -- unlike the Plan/log-view pages, there's no single flat
    // mod table at this aggregate level to filter, so these are just totals, same visual style.
    badgesEl.appendChild(el('span', { class: 'badge badge--' + status.toLowerCase() }, [
      el('span', { class: 'badge__count' }, String(count)), ' ' + statusLabel(status),
    ]));
  }

  $g('statsTimingMeta').textContent = data.topBottlenecks.length > 0
    ? `Highest avg rebuild time per mod: ${data.topBottlenecks[0].collectionName} (${fmtMs(data.topBottlenecks[0].avgMsPerMod)}/mod, ${data.topBottlenecks[0].samples} sample(s)).`
    : 'No timing samples yet for this period -- run a real rebuild to start collecting data.';

  const body = $g('statsConcurrencyBody');
  body.innerHTML = '';
  for (const b of data.concurrencyBreakdown) {
    body.appendChild(el('tr', {}, [
      el('td', {}, b.concurrency),
      el('td', {}, String(b.runCount)),
      el('td', {}, String(b.samplesWithTiming)),
      el('td', {}, b.avgRebuildMs != null ? `${fmtMs(b.avgRebuildMs)} (${b.samplesWithTiming} sample${b.samplesWithTiming === 1 ? '' : 's'})` : '--'),
    ]));
  }

  const select = $g('statsCollectionSelect');
  const prevValue = select.value;
  select.innerHTML = '';
  select.appendChild(el('option', { value: '' }, '-- select a collection --'));
  for (const c of data.collections) {
    select.appendChild(el('option', { value: c.collectionModId }, `${c.collectionName} (${c.runCount} run${c.runCount === 1 ? '' : 's'})`));
  }
  if (prevValue && data.collections.some((c) => c.collectionModId === prevValue)) select.value = prevValue;
}

// Current Issues state -- cached fetch (issuesData) so filtering/expanding re-renders instantly
// without refetching. Collapsed by default: just Collection + View Log per the user's own request
// (drill down for the real mod list, rather than dumping everything at once). A status filter
// (clicking a badge, same clickable-badge pattern as the log/plan pages) auto-expands every
// collection that has at least one match and hides collections that don't, showing only the
// matching mods within each -- "click SKIP_OPEN_FOMOD, see everywhere I still need to work through
// Vortex's installer, grouped by collection" was the explicit ask.
let issuesData = null;
const expandedCollections = new Set();
let issuesStatusFilter = null;

async function loadIssues() {
  const listEl = $g('statsIssuesList');
  try {
    issuesData = await api('GET', '/api/stats/issues');
  } catch (e) {
    if (!handleStatsApiError(e, loadIssues)) {
      listEl.textContent = `Failed to load: ${e.message}`;
    }
    return;
  }
  renderIssuesBadges();
  renderIssuesList();
}

function renderIssuesBadges() {
  const badgesEl = $g('statsIssuesBadges');
  badgesEl.innerHTML = '';
  const counts = {};
  for (const c of issuesData.collections) {
    for (const m of c.problemMods) counts[m.status] = (counts[m.status] || 0) + 1;
  }
  for (const [status, count] of Object.entries(counts)) {
    const active = issuesStatusFilter === status;
    const badge = el('span', {
      class: `badge badge--clickable badge--${status.toLowerCase()}${active ? ' badge--filter-active' : ''}`,
      'data-status': status,
    }, [el('span', { class: 'badge__count' }, String(count)), ' ' + statusLabel(status)]);
    // Toggle, not just a one-way filter set -- click an active badge again to clear it, same as
    // clicking "Show all" below (both are valid ways to reset).
    badge.addEventListener('click', () => {
      issuesStatusFilter = active ? null : status;
      renderIssuesBadges();
      renderIssuesList();
    });
    badgesEl.appendChild(badge);
  }
  const showAll = el('span', { class: `badge badge--show-all${issuesStatusFilter === null ? ' badge--filter-active' : ''}` }, 'Show all');
  showAll.addEventListener('click', () => { issuesStatusFilter = null; renderIssuesBadges(); renderIssuesList(); });
  badgesEl.appendChild(showAll);
}

function renderIssuesList() {
  const listEl = $g('statsIssuesList');
  listEl.innerHTML = '';
  if (issuesData.collections.length === 0) {
    listEl.appendChild(el('p', { class: 'muted' }, 'No problem mods in any collection\'s latest run -- everything is clean.'));
    return;
  }
  const visible = issuesData.collections.filter((c) =>
    !issuesStatusFilter || c.problemMods.some((m) => m.status === issuesStatusFilter));
  if (visible.length === 0) {
    listEl.appendChild(el('p', { class: 'muted' }, `No collection currently has a "${issuesStatusFilter}" mod.`));
    return;
  }
  for (const c of visible) {
    const modsToShow = issuesStatusFilter ? c.problemMods.filter((m) => m.status === issuesStatusFilter) : c.problemMods;
    const isExpanded = issuesStatusFilter != null || expandedCollections.has(c.collectionModId);

    const header = el('div', { class: 'muted', style: 'display:flex; align-items:center; gap:10px; cursor:pointer;' }, [
      el('span', {}, isExpanded ? '▼' : '▶'),
      el('strong', { style: 'color: var(--text);' }, c.collectionName),
      el('span', {}, `${modsToShow.length} problem mod(s)${issuesStatusFilter ? ' matching filter' : ''}, latest run ${fmtDate(c.startedAt)} (${c.runStatus})`),
      el('a', {
        class: 'btn btn--ghost btn--small',
        // Carries the active filter through to the log page (it already reads ?status= on load) and
        // tags where we came from so the log page's back button can say "Back to Reports" and return
        // to this exact sub-tab instead of a generic "Back to Collections".
        href: `/api/rebuild/logs/view/${encodeURIComponent(c.logFile)}?from=stats${issuesStatusFilter ? '&status=' + encodeURIComponent(issuesStatusFilter) : ''}`,
      }, 'View Log'),
    ]);
    if (!issuesStatusFilter) {
      header.addEventListener('click', (e) => {
        if (e.target.closest('a')) return; // let View Log navigate normally, don't toggle
        if (expandedCollections.has(c.collectionModId)) expandedCollections.delete(c.collectionModId);
        else expandedCollections.add(c.collectionModId);
        renderIssuesList();
      });
    } else {
      header.style.cursor = 'default'; // auto-expanded while filtering -- nothing to toggle
    }

    const card = el('div', { class: 'path-row', style: 'flex-direction: column; align-items: stretch; gap: 8px; margin-bottom: 10px;' }, [header]);
    if (isExpanded) {
      for (const m of modsToShow) {
        card.appendChild(el('div', { class: 'file-list' }, [
          el('span', { class: 'status-pill status-pill--' + m.status.toLowerCase() }, statusLabel(m.status)),
          ' ' + m.name,
        ]));
      }
    }
    listEl.appendChild(card);
  }
}

async function loadCollectionHistory(collectionModId) {
  const body = $g('statsCollectionHistoryBody');
  body.innerHTML = '';
  if (!collectionModId) return;
  let data;
  try {
    data = await api('GET', `/api/rebuild/logs/${encodeURIComponent(collectionModId)}`);
  } catch (e) {
    if (!handleStatsApiError(e, () => loadCollectionHistory(collectionModId))) {
      body.appendChild(el('tr', {}, [el('td', { colspan: '8' }, `Failed to load: ${e.message}`)]));
    }
    return;
  }
  for (const log of data.logs || []) {
    const p = log.phaseDurationsMs || {};
    body.appendChild(el('tr', {}, [
      el('td', {}, fmtDate(log.startedAt)),
      el('td', {}, log.runStatus || '--'),
      el('td', {}, String(log.totalMods ?? '--')),
      el('td', {}, fmtMs(log.durationMs)),
      el('td', {}, fmtMs(p.syncStateMs)),
      el('td', {}, fmtMs(p.backupMs)),
      el('td', {}, fmtMs(p.rebuildMs)),
      el('td', {}, log.concurrentExtractions != null ? String(log.concurrentExtractions) : '--'),
    ]));
  }
}

document.querySelectorAll('.stats-period-btn').forEach((btn) => {
  btn.addEventListener('click', () => loadOverview(btn.dataset.period));
});
$g('statsCollectionSelect').addEventListener('change', (e) => loadCollectionHistory(e.target.value));

function loadStatsPageOnce() {
  if (loaded) return;
  loaded = true;
  loadOverview(currentPeriod);
  loadIssues();
}

// Reports area now has three inner sub-tabs -- still few enough that a small flat toggle is
// simpler than shell.js's TOOL_AREAS-style array. Stats Report is the default on first entry,
// matching this area's exact behavior before the Work Through Report/Update Compare Report splits.
const REPORTS_SUB_TABS = ['stats', 'workthrough', 'updatecompare', 'rulesgen'];
const REPORTS_SUB_TAB_LABELS = { stats: 'Reports > Stats Report', workthrough: 'Reports > Work Through Report', updatecompare: 'Reports > Update Compare Report', rulesgen: 'Reports > Rules Generator Report' };
function showReportsSubTab(id) {
  if (typeof setPageLabel === 'function') setPageLabel(REPORTS_SUB_TAB_LABELS[id] || 'Reports');
  for (const tab of REPORTS_SUB_TABS) {
    $g(`reports-sub-area-${tab}`).classList.toggle('hidden', tab !== id);
    $g(`reports-sub-${tab}`).classList.toggle('btn--primary', tab === id);
    $g(`reports-sub-${tab}`).classList.toggle('btn--ghost', tab !== id);
  }
  if (id === 'stats') loadStatsPageOnce();
  else if (id === 'workthrough' && typeof loadWorkThroughPageOnce === 'function') loadWorkThroughPageOnce();
  else if (id === 'rulesgen' && typeof loadRulesGenReportPageOnce === 'function') loadRulesGenReportPageOnce();
}
for (const tab of REPORTS_SUB_TABS) {
  $g(`reports-sub-${tab}`).addEventListener('click', () => showReportsSubTab(tab));
}
document.getElementById('nav-reports').addEventListener('click', () => showReportsSubTab('stats'));

// Called by sync-app.js's Generate Report button (sync-app.js loads BEFORE this file, so it can't
// see inside this IIFE otherwise -- same "deliberate seam" as showReportsSubTab/window.setPageLabel
// elsewhere in this project). Embeds the report at `url` in an iframe instead of window.open()'ing
// a separate tab -- shows it inline, under Reports, like Stats/Work Through Report.
function showUpdateCompareReport(url) {
  if (typeof showToolArea === 'function') showToolArea('reports');
  showReportsSubTab('updatecompare');
  $g('updateComparePlaceholder').classList.add('hidden');
  const frame = $g('updateCompareFrame');
  frame.classList.remove('hidden');
  frame.src = url;
}
$g('updateCompareBackBtn').addEventListener('click', () => {
  if (typeof showToolArea === 'function') showToolArea('sync');
});
window.showUpdateCompareReport = showUpdateCompareReport;

// The one deliberate seam: shell.js (loaded BEFORE this file) calls this by name on a deep-link
// (?reports=... / clicking the Reports nav tab), and it can't see inside this IIFE otherwise.
window.showReportsSubTab = showReportsSubTab;

})();
