'use strict';
// Work Through Report UI -- an actionable variant of Stats Report's Current Issues, talking to
// /api/work-through/* plus the EXISTING /api/rebuild/logs/:filename/resolve-mismatch and
// /retry-download routes directly (same endpoints the log-view page's own buttons already use).
// Fully independent of app.js/sync-app.js/settings-app.js/stats-app.js -- own tiny helpers, no
// shared state, same convention every other page in this project already follows.
//
// Wrapped in an IIFE so this file's own $g/el/api/baseName/showErrorModal/etc. can't collide with
// same-named helpers in other page scripts sharing this one page's global scope (all loaded via
// plain <script src>, not modules) -- this file loads LAST, so before this fix its declarations
// silently clobbered app.js's/stats-app.js's on `window` (confirmed live: app.js's api() sets
// err.status/err.body for handleApiError's 409-vortex-running check; this file's plainer api()
// didn't, which broke that check EVERYWHERE in the app, not just here -- including the "Load
// Vortex Data" button's red banner on the completely unrelated Rebuild Collection page). Only the
// one name something else genuinely depends on is exported below; everything else stays private.
(function () {

function $g(id) { return document.getElementById(id); }

// The full path never matters to the user, just the file NAME -- there's only one archive/downloads
// folder in this whole app (already known from Settings). Display-only; the real delete action still
// uses the full path passed separately.
function baseName(p) {
  return String(p ?? '').split(/[\\/]/).filter(Boolean).pop() || String(p ?? '');
}

// A FAILED_EXTRACTION_* row with archiveNotFound is the SAME underlying problem as SKIP_NO_ARCHIVE
// (the archive genuinely isn't there), just discovered later, at actual extraction time instead of
// during classification -- gets the same off-site note + Import button either way.
function isArchiveMissingStatus(m) {
  return m.status === 'SKIP_NO_ARCHIVE'
    || ((m.status === 'FAILED_EXTRACTION_NOT_TOUCHED' || m.status === 'FAILED_EXTRACTION_NO_PRIOR_DATA') && m.archiveNotFound);
}

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

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `Request failed (${res.status})`);
  return data;
}

// This page has no Vortex-running concerns of its own (Work Through Report only ever reads/writes
// log files and its own small state file), so the only thing worth checking for is the server being
// fully unreachable -- same shared shell.js modal every other page uses.
function handleWtApiError(e, retryFn) {
  if (isServerUnreachableError(e)) {
    showServerUnreachableError(retryFn);
    return true;
  }
  return false;
}

function fmtDate(iso) {
  return iso ? new Date(iso).toLocaleString() : '--';
}

function showConfirmModal(message) {
  const overlay = $g('wtConfirmModal');
  $g('wtConfirmModalText').textContent = message;
  overlay.classList.remove('hidden');
  return new Promise((resolve) => {
    const cleanup = (result) => { overlay.classList.add('hidden'); resolve(result); };
    $g('wtConfirmModalOk').onclick = () => cleanup(true);
    $g('wtConfirmModalCancel').onclick = () => cleanup(false);
  });
}
function showErrorModal(message) {
  $g('wtErrorModalText').textContent = message;
  $g('wtErrorModal').classList.remove('hidden');
}
$g('wtErrorModalOk').addEventListener('click', () => { $g('wtErrorModal').classList.add('hidden'); });

let wtLoaded = false;
let wtData = null;
const wtExpandedCollections = new Set();
// Restore whatever filter was active before navigating to "View Log", if the URL says so -- same
// convention the log-view page itself already uses for its own status filter
// (applyStatusFilter(new URLSearchParams(location.search).get('status') || '')). This page is a
// full reload (not an SPA route change) every time "Back to Reports" is followed, so reading
// location.search once here at script-load time is enough -- confirmed live this was missing
// before: the log page kept its own selected filter fine, but "Back to Reports" always reset this
// page's filter to "Show all" regardless of what was active before clicking into the log.
// Multi-select (workspace UX-PRINCIPLES.md rule 7, applied app-wide 2026-08-15) -- ?status= can now
// carry a comma-separated list (same convention Stats' own issuesStatusFilter round-trips through
// the log-view page with), parsed into a Set here at script-load time.
const wtInitialStatus = new URLSearchParams(location.search).get('status');
let wtStatusFilter = new Set(wtInitialStatus ? wtInitialStatus.split(',') : []);

function loadWorkThroughPageOnce() {
  if (wtLoaded) return;
  wtLoaded = true;
  loadWorkThroughList();
}

async function loadWorkThroughList() {
  try {
    wtData = await api('GET', '/api/work-through/list');
  } catch (e) {
    if (!handleWtApiError(e, loadWorkThroughList)) {
      $g('wtList').textContent = `Failed to load: ${e.message}`;
    }
    return;
  }
  renderWtBadges();
  renderWtList();
  renderWtProgress();
}

function renderWtProgress() {
  // Only Category B (non-resolvable) items have a completion concept -- resolving a Category A
  // item removes it from the list entirely instead of "completing" it.
  let total = 0, done = 0;
  for (const c of wtData.collections) {
    for (const m of c.problemMods) {
      if (m.resolvable) continue;
      total += 1;
      if (m.completed) done += 1;
    }
  }
  $g('wtProgress').textContent = total > 0
    ? `${done} of ${total} manually-tracked item(s) completed.`
    : 'No manually-tracked items right now.';
}

function renderWtBadges() {
  const badgesEl = $g('wtBadges');
  badgesEl.innerHTML = '';
  const counts = {};
  for (const c of wtData.collections) {
    for (const m of c.problemMods) counts[m.status] = (counts[m.status] || 0) + 1;
  }
  for (const [status, count] of Object.entries(counts)) {
    const active = wtStatusFilter.has(status);
    const badge = el('span', {
      class: `badge badge--clickable badge--${status.toLowerCase()}${active ? ' badge--filter-active' : ''}`,
      'data-status': status,
    }, [el('span', { class: 'badge__count' }, String(count)), ' ' + statusLabel(status)]);
    badge.addEventListener('click', () => {
      if (active) wtStatusFilter.delete(status); else wtStatusFilter.add(status);
      renderWtBadges();
      renderWtList();
    });
    badgesEl.appendChild(badge);
  }
  const showAll = el('span', { class: `badge badge--show-all${wtStatusFilter.size === 0 ? ' badge--filter-active' : ''}` }, 'Show all');
  showAll.addEventListener('click', () => { wtStatusFilter.clear(); renderWtBadges(); renderWtList(); });
  badgesEl.appendChild(showAll);
}

function renderWtList() {
  const listEl = $g('wtList');
  listEl.innerHTML = '';
  if (wtData.collections.length === 0) {
    listEl.appendChild(el('p', { class: 'muted' }, 'No problem mods in any collection\'s latest run -- everything is clean.'));
    return;
  }
  const hasFilter = wtStatusFilter.size > 0;
  const visible = wtData.collections.filter((c) => !hasFilter || c.problemMods.some((m) => wtStatusFilter.has(m.status)));
  if (visible.length === 0) {
    const activeLabels = [...wtStatusFilter].map((s) => `"${s}"`).join(' or ');
    listEl.appendChild(el('p', { class: 'muted' }, `No collection currently has a ${activeLabels} mod.`));
    return;
  }
  const statusQueryValue = [...wtStatusFilter].join(',');
  for (const c of visible) {
    const modsToShow = hasFilter ? c.problemMods.filter((m) => wtStatusFilter.has(m.status)) : c.problemMods;
    const isExpanded = hasFilter || wtExpandedCollections.has(c.collectionModId);

    const header = el('div', { class: 'muted', style: 'display:flex; align-items:center; gap:10px; cursor:pointer;' }, [
      el('span', {}, isExpanded ? '▼' : '▶'),
      el('strong', { style: 'color: var(--text);' }, c.collectionName),
      el('span', {}, `${modsToShow.length} problem mod(s)${hasFilter ? ' matching filter' : ''}, latest run ${fmtDate(c.startedAt)} (${c.runStatus})`),
      el('a', {
        class: 'btn btn--ghost btn--small',
        // Carries the active filter through to the log page (it already reads ?status= on load) and
        // tags where we came from so the log page's back button can say "Back to Reports" and return
        // to this exact sub-tab instead of a generic "Back to Collections".
        href: `/api/rebuild/logs/view/${encodeURIComponent(c.logFile)}?from=work-through${hasFilter ? '&status=' + encodeURIComponent(statusQueryValue) : ''}`,
      }, 'View Log'),
    ]);
    if (!hasFilter) {
      header.addEventListener('click', (e) => {
        if (e.target.closest('a')) return;
        if (wtExpandedCollections.has(c.collectionModId)) wtExpandedCollections.delete(c.collectionModId);
        else wtExpandedCollections.add(c.collectionModId);
        renderWtList();
      });
    } else {
      header.style.cursor = 'default';
    }

    const card = el('div', { class: 'path-row', style: 'flex-direction: column; align-items: stretch; gap: 8px; margin-bottom: 10px;' }, [header]);
    if (isExpanded) {
      for (const m of modsToShow) card.appendChild(modRowEl(m, c));
    }
    listEl.appendChild(card);
  }
}

function modRowEl(m, c) {
  const pill = el('span', { class: 'status-pill status-pill--' + m.status.toLowerCase() }, statusLabel(m.status));
  // Name gets the only flex:1 in this row -- it absorbs all the leftover space, so whatever comes
  // after it (buttons, checkbox+note, the delete-duplicate list) lands at the SAME right-hand edge
  // on every row in this list regardless of how long the name or status pill text is. Confirmed
  // live this was the same complaint as the AMBIGUOUS delete buttons before their own grid fix --
  // "Extract all"/"Keep modified" started at a different X position on every row depending on name
  // length. Every row here is already the same total width (the card wrapper stretches), so a plain
  // flex:1 name achieves the exact same lined-up-column look as a shared CSS grid would, without
  // needing to restructure this whole list into one.
  const nameSpan = el('span', { style: 'flex:1 1 auto; min-width:0;' }, m.name);
  const row = el('div', { class: 'file-list', style: 'display:flex; align-items:center; gap:10px;' }, [pill, nameSpan]);

  if (m.resolvable) {
    if (m.resolveKind === 'mismatch') {
      const extractBtn = el('button', { class: 'btn btn--primary btn--small' }, 'Extract all');
      const keepBtn = el('button', { class: 'btn btn--primary btn--small' }, 'Keep modified');
      extractBtn.addEventListener('click', () => resolveMismatch(c.logFile, m, 'all', [extractBtn, keepBtn]));
      keepBtn.addEventListener('click', () => resolveMismatch(c.logFile, m, 'keep-existing', [extractBtn, keepBtn]));
      row.append(extractBtn, keepBtn);
    } else if (m.resolveKind === 'force-extract') {
      const forceBtn = el('button', { class: 'btn btn--primary btn--small' }, 'Force Extract Anyway');
      forceBtn.addEventListener('click', () => forceExtractOffSite(c.logFile, m, [forceBtn]));
      row.append(forceBtn);
    } else if (m.resolveKind === 'retry-extraction') {
      const retryExtractBtn = el('button', { class: 'btn btn--primary btn--small' }, 'Retry Extraction');
      retryExtractBtn.addEventListener('click', () => retryExtraction(c.logFile, m, [retryExtractBtn]));
      row.append(retryExtractBtn);
    } else if (m.resolveKind === 'delete-duplicate') {
      // Two or more byte-identical duplicate files -- one Delete button per candidate. A shared CSS
      // grid (not one flex row per candidate) so every Delete button lines up in the same column
      // regardless of how long/wrapped each file path is -- confirmed live that per-row flex let the
      // button's position drift whenever one path wrapped to two lines and another didn't.
      const wrap = el('div', { style: 'display:flex; flex-direction:column; gap:6px;' }, [row]);
      const grid = el('div', { style: 'display:grid; grid-template-columns:1fr auto; align-items:start; gap:8px 12px; margin-left:20px;' });
      for (const f of m.candidateFiles) {
        const delBtn = el('button', { class: 'btn btn--ghost btn--small' }, 'Delete');
        delBtn.addEventListener('click', () => deleteArchiveCandidate(c.logFile, m, f, [delBtn]));
        grid.append(el('code', { style: 'font-size:12px; white-space:nowrap;' }, baseName(f)), delBtn);
      }
      wrap.appendChild(grid);
      return wrap;
    } else {
      const retryBtn = el('button', { class: 'btn btn--primary btn--small' }, 'Retry Download');
      retryBtn.addEventListener('click', () => retryDownload(c.logFile, m, [retryBtn]));
      row.append(retryBtn);
    }
  } else {
    const checkbox = el('input', { type: 'checkbox' });
    checkbox.checked = m.completed;
    if (m.completed) row.classList.add('wt-row--completed');
    checkbox.addEventListener('change', () => toggleCompleted(m, checkbox.checked, row, checkbox));
    row.prepend(checkbox);
    // Off-site missing archives can't be fixed by this tool at all -- say so directly instead of
    // just a bare checkbox, with a link to the recorded source URL when collection.json had one.
    if (isArchiveMissingStatus(m) && m.offSite) {
      const note = el('span', { class: 'muted' }, "-- located off-site, obtain manually and install via Vortex.");
      row.appendChild(note);
      if (m.sourceUrl) {
        const link = el('a', { class: 'archive-link', href: m.sourceUrl, target: '_blank', rel: 'noopener noreferrer' }, m.sourceUrl);
        row.appendChild(link);
      }
    }
  }
  // Import is offered for ANY off-site archive-missing row, alongside whatever else is shown (Force
  // Extract Anyway or the plain checkbox+note) -- the reliable path regardless of whether a same-size
  // candidate was auto-detected, since the user explicitly picks the exact file.
  if (isArchiveMissingStatus(m) && m.offSite) {
    const importBtn = el('button', { class: 'btn btn--ghost btn--small' }, 'Import');
    importBtn.addEventListener('click', () => importOffSite(c.logFile, m, [importBtn]));
    row.appendChild(importBtn);
  }
  return row;
}

async function resolveMismatch(logFile, m, resolveMode, buttons) {
  const message = resolveMode === 'all'
    ? "Warning: this will fully replace this mod's staging folder. Continue?"
    : 'Warning: this keeps your modified files as they are, replaces everything else, and restores any missing files. Continue?';
  if (!await showConfirmModal(message)) return;
  buttons.forEach((b) => { b.disabled = true; });
  try {
    await api('POST', `/api/rebuild/logs/${encodeURIComponent(logFile)}/resolve-mismatch`, { modId: m.modId, fileId: m.fileId, name: m.name, resolveMode });
    await loadWorkThroughList(); // re-fetch in place -- preserves filter/expand state, unlike a full reload
  } catch (e) {
    if (!handleWtApiError(e)) showErrorModal(`Failed: ${e.message}`);
    buttons.forEach((b) => { b.disabled = false; });
  }
}

async function retryDownload(logFile, m, buttons) {
  buttons.forEach((b) => { b.disabled = true; b.textContent = 'Downloading…'; });
  try {
    const data = await api('POST', `/api/rebuild/logs/${encodeURIComponent(logFile)}/retry-download`, { modId: m.modId, fileId: m.fileId });
    if (!data.ok) throw new Error(data.error || 'Download failed.');
    await loadWorkThroughList();
  } catch (e) {
    if (!handleWtApiError(e)) showErrorModal(`Failed: ${e.message}`);
    await loadWorkThroughList(); // the route may have already persisted an updated detail message either way
  }
}

async function forceExtractOffSite(logFile, m, buttons) {
  const message = "Warning: this file doesn't exactly match what this collection recorded (a different repack/edition). Extract it anyway? Vortex may prompt you to import it as a new mod afterward -- accept that prompt if so.";
  if (!await showConfirmModal(message)) return;
  buttons.forEach((b) => { b.disabled = true; b.textContent = 'Extracting…'; });
  try {
    const data = await api('POST', `/api/rebuild/logs/${encodeURIComponent(logFile)}/force-extract-offsite`, { name: m.name });
    if (!data.ok) throw new Error(data.error || 'Extraction failed.');
    await loadWorkThroughList();
  } catch (e) {
    if (!handleWtApiError(e)) showErrorModal(`Failed: ${e.message}`);
    buttons.forEach((b) => { b.disabled = false; b.textContent = 'Force Extract Anyway'; });
  }
}

async function deleteArchiveCandidate(logFile, m, filePath, buttons) {
  if (!await showConfirmModal(`Warning: this will permanently delete this file:\n${baseName(filePath)}\n\nContinue?`)) return;
  buttons.forEach((b) => { b.disabled = true; b.textContent = 'Deleting…'; });
  try {
    const data = await api('POST', `/api/rebuild/logs/${encodeURIComponent(logFile)}/delete-archive-candidate`, { modId: m.modId, fileId: m.fileId, name: m.name, filePath });
    if (!data.ok) throw new Error(data.error || 'Delete failed.');
    await loadWorkThroughList();
  } catch (e) {
    if (!handleWtApiError(e)) showErrorModal(`Failed: ${e.message}`);
    buttons.forEach((b) => { b.disabled = false; b.textContent = 'Delete'; });
  }
}

async function retryExtraction(logFile, m, buttons) {
  buttons.forEach((b) => { b.disabled = true; b.textContent = 'Retrying…'; });
  try {
    const data = await api('POST', `/api/rebuild/logs/${encodeURIComponent(logFile)}/retry-extraction`, { modId: m.modId, fileId: m.fileId, name: m.name });
    if (!data.ok) throw new Error(data.error || 'Retry failed.');
    await loadWorkThroughList();
  } catch (e) {
    if (!handleWtApiError(e)) showErrorModal(`Failed: ${e.message}`);
    buttons.forEach((b) => { b.disabled = false; b.textContent = 'Retry Extraction'; });
  }
}

async function importOffSite(logFile, m, buttons) {
  const originalText = buttons[0].textContent;
  buttons.forEach((b) => { b.disabled = true; b.textContent = 'Waiting for file…'; });
  try {
    const data = await api('POST', `/api/rebuild/logs/${encodeURIComponent(logFile)}/import-offsite`, { name: m.name });
    if (data.cancelled) { buttons.forEach((b) => { b.disabled = false; b.textContent = originalText; }); return; }
    if (!data.ok) throw new Error(data.error || 'Import failed.');
    await loadWorkThroughList();
  } catch (e) {
    if (!handleWtApiError(e)) showErrorModal(`Failed: ${e.message}`);
    buttons.forEach((b) => { b.disabled = false; b.textContent = originalText; });
  }
}

async function toggleCompleted(m, checked, row, checkbox) {
  try {
    await api('POST', '/api/work-through/toggle', { key: m.key, completed: checked });
    m.completed = checked;
    row.classList.toggle('wt-row--completed', checked);
    renderWtProgress();
  } catch (e) {
    checkbox.checked = !checked; // revert
    if (!handleWtApiError(e)) showErrorModal(`Failed: ${e.message}`);
  }
}

// The one deliberate seam: stats-app.js (loaded before this file) calls this by name -- when the
// user switches to the Work Through sub-tab, and can't see inside this IIFE otherwise.
window.loadWorkThroughPageOnce = loadWorkThroughPageOnce;

})();
