'use strict';
// File Retriever (Utilities sub-tab, 2026-09-01) -- built against the approved
// design/mockup-file-retriever.html. Reuses $g/el from cleanup-app.js, same "self-contained area,
// shared tiny helpers" convention every other *-app.js file here already follows. See
// lib/file-retriever-runner.js's own header comment for the real design this is wired to (the
// Nexus `uid`/category research, the Premium-direct vs. website-fallback download split).

// Default category (2026-09-01, director's own follow-up ask): Main Files, not "show all" -- most
// mods' Optional/Miscellaneous/Archive files are the rare exception, not what someone opens this
// tool looking for first. Still an empty Set = show all everywhere else in this file (the "Show
// all" chip, frMatchesActiveCategory) -- only the STARTING value changes, the mechanism doesn't.
function frDefaultCategories() { return new Set(['MAIN']); }

const FR_LAST_GAME_KEY = 'fileRetriever.lastGame';

const frState = {
  mod: null, // { modId, name, author, pictureUrl, summary, nexusUrl }
  gameDomain: 'skyrimspecialedition', // captured at lookup time so switching the picker mid-flow can't change which game the current mod belongs to
  files: [], // every file this mod has, from the lookup response (fileId/uid/name/version/category/categoryLabel/sizeKb/uploadedTime/websiteUrl)
  activeCategories: frDefaultCategories(), // empty = show all, same convention as every other filter-badge row in this app
  selected: new Set(), // fileId
  isPremium: false,
  destInputRestored: false,
};

// Restores the last-picked game (a nicety, not required -- lightweight localStorage remember, same
// as this tool's own original destination-folder judgment call before that moved server-side).
try {
  const rememberedGame = localStorage.getItem(FR_LAST_GAME_KEY);
  if (rememberedGame) $g('frGamePicker').value = rememberedGame;
} catch { /* localStorage unavailable -- just start on the default game */ }

$g('frGamePicker').addEventListener('change', (e) => {
  try { localStorage.setItem(FR_LAST_GAME_KEY, e.target.value); } catch { /* best-effort remember */ }
});

const FR_STEPS = ['Enter a mod', 'Choose files', 'Download'];

async function frApi(method, path, body) {
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

function frHandleError(e) {
  if (window.isServerUnreachableError && window.isServerUnreachableError(e)) {
    window.showServerUnreachableError();
    return;
  }
  const box = $g('frCriticalError');
  // A hard blocker (the request is flatly refused, not just risky) gets a real title + body, same
  // two-part callout shape every other tool in this app already uses -- a plain single-line message
  // in a critical-colored box read as unstructured next to the rest of the app (2026-09-01,
  // director-caught). No API key configured is the one case with its own copy; anything else falls
  // back to a generic title so the box never renders visually empty.
  const title = (e.body && e.body.error === 'not-configured')
    ? '🛑 Nexus API Key Required'
    : '🛑 Something Went Wrong';
  const body = (e.body && e.body.error === 'not-configured')
    ? 'You must enter a valid Nexus API key in Settings before continuing.'
    : e.message;
  box.innerHTML = `<div class="callout__title">${escHtmlFr(title)}</div><p>${escHtmlFr(body)}</p>`;
  box.classList.remove('hidden');
}
function frHideCriticalError() {
  $g('frCriticalError').classList.add('hidden');
}

function frRenderStepper(activeIdx) {
  $g('frStepper').innerHTML = FR_STEPS.map((label, i) => {
    const cls = i < activeIdx ? 'done' : i === activeIdx ? 'active' : '';
    const num = i < activeIdx ? '✓' : String(i + 1);
    return `<div class="merge-step ${cls}"><b>${num}</b>${label}</div>`;
  }).join('');
}

function frGoScreen(id, stepIdx) {
  ['frScreen1', 'frScreen2', 'frScreen3', 'frScreen4'].forEach((s) => $g(s).classList.toggle('hidden', s !== id));
  frRenderStepper(stepIdx);
  window.scrollTo(0, 0);
}

// ---------- Screen 1: look up a mod ----------

$g('frLookupBtn').addEventListener('click', frLookup);
$g('frModIdInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); frLookup(); }
});

async function frLookup() {
  frHideCriticalError();
  const raw = $g('frModIdInput').value.trim();
  const modId = Number(raw);
  if (!raw || !Number.isInteger(modId) || modId <= 0) {
    frHandleError(new Error('Enter a valid Nexus mod ID (a positive whole number).'));
    return;
  }
  const gameDomain = $g('frGamePicker').value;
  $g('frLookupBtn').disabled = true;
  $g('frLookupBtn').textContent = 'Looking up…';
  try {
    const result = await frApi('POST', '/api/file-retriever/lookup', { modId, gameDomain });
    frState.mod = result.mod;
    frState.gameDomain = gameDomain;
    frState.files = result.files;
    // Falls back to "show all" when this specific mod genuinely has no Main Files at all (a real,
    // if uncommon, case -- some mods ship everything as Optional/Misc) -- defaulting to a filter
    // that hides every one of this mod's files would read as "No files found for this mod" when
    // files plainly exist, which is worse than just showing everything for that one mod.
    frState.activeCategories = result.files.some((f) => f.category === 'MAIN') ? frDefaultCategories() : new Set();
    frState.selected.clear();
    frFileSort.column = 'date';
    frFileSort.direction = 'desc';
    frRenderModInfo();
    frRenderCategoryFilters();
    frRenderFiles();
    frGoScreen('frScreen2', 1);
  } catch (e) {
    frHandleError(e);
  } finally {
    $g('frLookupBtn').disabled = false;
    $g('frLookupBtn').textContent = 'Look up →';
  }
}

function frRenderModInfo() {
  const m = frState.mod;
  $g('frModThumb').src = m.pictureUrl || '';
  $g('frModThumb').alt = m.name || '';
  $g('frModName').textContent = m.name || `Mod ${m.modId}`;
  $g('frModMeta').innerHTML = `by ${escHtmlFr(m.author || 'unknown')} &middot; `
    + `<a href="${escHtmlFr(m.nexusUrl)}" target="_blank" rel="noopener">View on Nexus</a> &middot; `
    + `<button class="link-btn" id="frChangeModBtn" style="padding:0">Not this mod?</button>`;
  $g('frChangeModBtn').addEventListener('click', () => frGoScreen('frScreen1', 0));
}

function escHtmlFr(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- Screen 2: category filter + file selection ----------

// Fixed order (not derived from whatever categories this mod happens to have) so the filter row
// never reflows between mods -- same reasoning DESIGN.md's filter-badge convention already follows
// elsewhere (a consistent, predictable row beats a data-driven one that jumps around).
const FR_CATEGORY_ORDER = [
  { key: 'MAIN', label: 'Main Files' },
  { key: 'OPTIONAL', label: 'Optional Files' },
  { key: 'MISCELLANEOUS', label: 'Miscellaneous Files' },
  { key: 'OLD_VERSION', label: 'File Archive' },
];

function frCategoriesPresent() {
  const present = new Set(frState.files.map((f) => f.category));
  // ARCHIVED is an alternate spelling some API responses use for the same "File Archive" section
  // (see lib/file-retriever-runner.js's own CATEGORY_LABELS) -- folded into OLD_VERSION here so the
  // filter row shows one "File Archive" chip, not two near-duplicates, regardless of which spelling
  // this particular mod's response happened to use.
  if (present.has('ARCHIVED')) present.add('OLD_VERSION');
  return FR_CATEGORY_ORDER.filter((c) => present.has(c.key));
}

function frRenderCategoryFilters() {
  const cats = frCategoriesPresent();
  const chips = [
    `<span class="badge badge--clickable badge--show-all ${frState.activeCategories.size === 0 ? 'badge--filter-active' : ''}" data-cat="__all">Show all</span>`,
    ...cats.map((c) => {
      const active = frState.activeCategories.has(c.key);
      return `<span class="badge badge--clickable badge--info ${active ? 'badge--filter-active' : ''}" data-cat="${c.key}">${c.label}</span>`;
    }),
  ];
  $g('frCategoryFilterRow').innerHTML = chips.join('');
  document.querySelectorAll('#frCategoryFilterRow .badge').forEach((elm) => {
    elm.addEventListener('click', () => {
      const cat = elm.dataset.cat;
      if (cat === '__all') frState.activeCategories.clear();
      else if (frState.activeCategories.has(cat)) frState.activeCategories.delete(cat);
      else frState.activeCategories.add(cat);
      frRenderCategoryFilters();
      frRenderFiles();
    });
  });
}

function frMatchesActiveCategory(file) {
  if (frState.activeCategories.size === 0) return true;
  const cat = file.category === 'ARCHIVED' ? 'OLD_VERSION' : file.category;
  return frState.activeCategories.has(cat);
}

// Single-active-sort-column state, same convention Merge Plugins' own mergeResultsSort/
// mergeHandleHeaderSortClick already establishes for a sortable .plan-table -- click a column to
// sort ascending, click the SAME column again to reverse, click a DIFFERENT column to switch to it
// (always starting ascending). Defaults to Date, newest first (2026-09-01, director's own follow-up
// -- reverted from the earlier Name-ascending default now that Main Files is ALSO the default
// filter: the near-identical-name grouping problem that justified Name-first was really about the
// full, unfiltered list mixing in every old archived variant; with Main Files as the starting view
// there's little left to scatter, and the tool's actual most-common use is "grab the newest file").
// Name/Date/Size/Version all stay real sort options either way -- only the STARTING column/
// direction changed.
const frFileSort = { column: 'date', direction: 'desc' };
const FR_SORT_KEYS = {
  name: (f) => f.name.toLowerCase(),
  date: (f) => (f.uploadedTime ? new Date(f.uploadedTime).getTime() : 0),
  size: (f) => f.sizeKb || 0,
  version: (f) => f.version,
};

function frVisibleFiles() {
  const rows = frState.files.filter(frMatchesActiveCategory);
  const key = FR_SORT_KEYS[frFileSort.column];
  const sorted = [...rows].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  return frFileSort.direction === 'desc' ? sorted.reverse() : sorted;
}

document.querySelectorAll('.fr-files-table th.sortable').forEach((th) => {
  th.addEventListener('click', () => {
    const col = th.dataset.col;
    if (frFileSort.column === col) frFileSort.direction = frFileSort.direction === 'asc' ? 'desc' : 'asc';
    else { frFileSort.column = col; frFileSort.direction = 'asc'; }
    frRenderFiles();
  });
});

function frRenderSortArrows() {
  Object.keys(FR_SORT_KEYS).forEach((col) => {
    $g(`frSortArrow-${col}`).textContent = col === frFileSort.column ? (frFileSort.direction === 'asc' ? '▲' : '▼') : '';
  });
}

// "Mmm DD, YYYY - hh:mmAM/PM" (2026-09-01, director's own exact spec) -- day/hour/minute always
// zero-padded, 12-hour clock, no space before AM/PM. Built by hand rather than
// toLocaleString()/Intl, which don't guarantee this exact shape (zero-padded day in particular)
// consistently across environments/locales.
const FR_MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function frFormatDate(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return '';
  const pad2 = (n) => String(n).padStart(2, '0');
  const hours24 = d.getHours();
  const ampm = hours24 >= 12 ? 'PM' : 'AM';
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  return `${FR_MONTH_NAMES[d.getMonth()]} ${pad2(d.getDate())}, ${d.getFullYear()} - ${pad2(hours12)}:${pad2(d.getMinutes())}${ampm}`;
}
function frFormatSize(sizeKb) {
  if (!sizeKb) return '';
  return sizeKb >= 1024 ? `${(sizeKb / 1024).toFixed(1)} MB` : `${sizeKb} KB`;
}

function frFileRowHtml(f) {
  const checked = frState.selected.has(f.fileId);
  const name = escHtmlFr(f.name);
  return `<tr class="${checked ? 'selected' : ''}">
    <td class="col-check"><input type="checkbox" data-file-id="${f.fileId}" ${checked ? 'checked' : ''}></td>
    <td class="file-row__name" title="${name}">${name}</td>
    <td class="file-row__date">${escHtmlFr(frFormatDate(f.uploadedTime))}</td>
    <td class="file-row__size">${escHtmlFr(frFormatSize(f.sizeKb))}</td>
    <td class="file-row__version">${escHtmlFr(f.version)}</td>
  </tr>`;
}

function frRenderFiles() {
  const visible = frVisibleFiles();
  $g('frFilesContainer').innerHTML = visible.map(frFileRowHtml).join('');
  $g('frNoFiles').classList.toggle('hidden', visible.length > 0);
  frRenderSortArrows();
  document.querySelectorAll('#frFilesContainer input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const fileId = Number(cb.dataset.fileId);
      if (cb.checked) frState.selected.add(fileId); else frState.selected.delete(fileId);
      cb.closest('tr').classList.toggle('selected', cb.checked);
      frUpdateSelectionCount();
    });
  });
  frUpdateSelectionCount();
}

function frUpdateSelectionCount() {
  const visIds = frVisibleFiles().map((f) => f.fileId);
  const selInView = visIds.filter((id) => frState.selected.has(id)).length;
  $g('frSelCount').textContent = `${selInView} of ${visIds.length} selected`;
  const n = frState.selected.size;
  $g('frContinueBtn').disabled = n === 0;
  $g('frContinueBtn').textContent = n > 0 ? `Continue (${n}) →` : 'Continue →';
}

$g('frSelectAllBtn').addEventListener('click', () => {
  frVisibleFiles().forEach((f) => frState.selected.add(f.fileId));
  frRenderFiles();
});
$g('frClearBtn').addEventListener('click', () => {
  frVisibleFiles().forEach((f) => frState.selected.delete(f.fileId));
  frRenderFiles();
});
$g('frInvertBtn').addEventListener('click', () => {
  frVisibleFiles().forEach((f) => (frState.selected.has(f.fileId) ? frState.selected.delete(f.fileId) : frState.selected.add(f.fileId)));
  frRenderFiles();
});
$g('frBackBtn').addEventListener('click', () => frGoScreen('frScreen1', 0));

$g('frContinueBtn').addEventListener('click', async () => {
  frHideCriticalError();
  try {
    const status = await frApi('GET', '/api/file-retriever/premium-status');
    frState.isPremium = !!status.isPremium;
    // Pre-fills from the server-remembered folder (2026-09-01, moved off localStorage -- persists
    // across browsers/machines, same as every other path setting in this app) -- but only the FIRST
    // time this screen is reached this visit, same "don't clobber an in-progress edit" protection
    // destInputRestored always provided: going Back to Screen 2 and forward again must not overwrite
    // whatever the user already typed here.
    if (!frState.destInputRestored && status.lastDestFolder) {
      $g('frDestInput').value = status.lastDestFolder;
    }
    frState.destInputRestored = true;
  } catch {
    frState.isPremium = false; // best-effort -- worst case this just shows the website-fallback copy
  }
  const n = frState.selected.size;
  const note = $g('frPathModeNote');
  if (frState.isPremium) {
    note.className = 'callout callout--info';
    note.innerHTML = `<div class="callout__title">⚡ Nexus Premium Download</div>`
      + `<div class="callout__body">With your Nexus Premium account, ${n} file${n === 1 ? '' : 's'} will be downloaded directly to the selected location.</div>`;
    $g('frDownloadBtn').textContent = `Download ${n} file${n === 1 ? '' : 's'} →`;
  } else {
    note.className = 'callout callout--info';
    note.innerHTML = `<div class="callout__title">🌐 Opening download pages</div>`
      + `<div class="callout__body">No Premium key configured -- opening each file's Nexus download page in your browser so you can grab it manually.</div>`;
    $g('frDownloadBtn').textContent = `Open ${n} download page${n === 1 ? '' : 's'} →`;
  }
  frGoScreen('frScreen3', 2);
});

// ---------- Screen 3: destination ----------

$g('frBrowseBtn').addEventListener('click', async () => {
  try {
    const res = await frApi('POST', '/api/settings/browse-folder', { title: 'Choose where to save the downloaded files', initialDir: $g('frDestInput').value.trim() || undefined });
    if (res.path) $g('frDestInput').value = res.path;
  } catch (e) {
    frHandleError(e);
  }
});
$g('frBackToFilesBtn').addEventListener('click', () => frGoScreen('frScreen2', 1));

$g('frDownloadBtn').addEventListener('click', async () => {
  frHideCriticalError();
  const destDir = $g('frDestInput').value.trim();
  if (!destDir) {
    frHandleError(new Error('Choose a destination folder first.'));
    return;
  }
  // Best-effort, fire-and-forget (2026-09-01, moved off localStorage into config.json -- see
  // web/file-retriever-routes.js's own /remember-destination) -- a failure here should never stop a
  // real download from proceeding, so this is deliberately not awaited and has no error handler
  // beyond the network layer's own default (a rejected fetch promise with nothing chained to it).
  frApi('POST', '/api/file-retriever/remember-destination', { destDir }).catch(() => {});

  const selectedFiles = frState.files.filter((f) => frState.selected.has(f.fileId));
  frGoScreen('frScreen4', 2);
  $g('frProgress').classList.remove('hidden');
  $g('frResult').classList.add('hidden');

  if (frState.isPremium) {
    await frRunDirectDownload(selectedFiles, destDir);
  } else {
    frRunWebsiteFallback(selectedFiles, destDir);
  }
});

let frDownloadEventSource = null;

async function frRunDirectDownload(selectedFiles, destDir) {
  $g('frPhaseText').textContent = `Downloading ${selectedFiles[0].name} ${selectedFiles[0].version} — 1 of ${selectedFiles.length}`;
  $g('frBar').style.width = '0%';
  try {
    await frApi('POST', '/api/file-retriever/download', { modId: frState.mod.modId, gameDomain: frState.gameDomain, files: selectedFiles, destDir });
  } catch (e) {
    if (e.status !== 409) {
      frShowResult({ ok: false, message: e.message });
      return;
    }
    // 409 just means a download is already in flight (another tab) -- still attach below.
  }
  if (frDownloadEventSource) frDownloadEventSource.close();
  const es = new EventSource('/api/file-retriever/download/events');
  frDownloadEventSource = es;
  es.onmessage = (msg) => frHandleDownloadEvent(JSON.parse(msg.data), destDir);
}

function frHandleDownloadEvent(frame, destDir) {
  if (frame.type === 'progress') {
    const pct = frame.total ? Math.round(((frame.current - 1) / frame.total) * 100) : 0;
    $g('frBar').style.width = pct + '%';
    $g('frPhaseText').textContent = `${frame.message} — ${frame.current} of ${frame.total}`;
  } else if (frame.type === 'done') {
    $g('frBar').style.width = '100%';
    if (frDownloadEventSource) { frDownloadEventSource.close(); frDownloadEventSource = null; }
    frShowResult({ ok: !frame.error, results: frame.results, destDir });
  } else if (frame.type === 'error') {
    if (frDownloadEventSource) { frDownloadEventSource.close(); frDownloadEventSource = null; }
    frShowResult({ ok: false, message: frame.message || 'The download failed.' });
  }
}

// No-Premium path -- entirely client-side, per the build spec: every file's own websiteUrl already
// came back on the lookup response, so there's nothing to ask the server for here. Instant, so this
// skips straight to the result screen rather than pretending there's real progress to show.
function frRunWebsiteFallback(selectedFiles, destDir) {
  for (const f of selectedFiles) {
    window.open(f.websiteUrl, '_blank');
  }
  frShowResult({
    ok: true, destDir, openedInBrowser: true,
    results: selectedFiles.map((f) => ({ fileId: f.fileId, name: f.name, version: f.version, category: f.categoryLabel, ok: true })),
  });
}

function frShowResult({ ok, message, results, destDir, openedInBrowser }) {
  $g('frProgress').classList.add('hidden');
  $g('frResult').classList.remove('hidden');
  const callout = $g('frResultCallout');
  const title = $g('frResultTitle');
  const body = $g('frResultBody');
  const list = $g('frResultList');
  list.innerHTML = '';

  if (message) {
    callout.className = 'callout callout--critical';
    title.textContent = '🛑 Download failed';
    body.textContent = message;
    return;
  }

  const okCount = (results || []).filter((r) => r.ok !== false).length;
  const failCount = (results || []).length - okCount;
  if (openedInBrowser) {
    callout.className = 'callout callout--info';
    title.textContent = `🌐 Opened ${okCount} download page${okCount === 1 ? '' : 's'}`;
    body.innerHTML = `Finish each download in the browser tab${okCount === 1 ? '' : 's'} that just opened.`;
  } else if (failCount === 0) {
    callout.className = 'callout callout--success';
    title.textContent = `🎉 ${okCount} file${okCount === 1 ? '' : 's'} downloaded`;
    body.innerHTML = `Saved to <strong>${escHtmlFr(destDir)}</strong>.`;
  } else {
    callout.className = 'callout callout--warning';
    title.textContent = `⚠️ ${okCount} of ${(results || []).length} files downloaded`;
    body.innerHTML = `Saved to <strong>${escHtmlFr(destDir)}</strong>. ${failCount} file${failCount === 1 ? '' : 's'} failed -- see below.`;
  }
  for (const r of results || []) {
    const li = document.createElement('li');
    li.textContent = `${r.ok !== false ? '✓' : '✗'} ${r.name} — ${r.version} (${r.category})${r.ok === false && r.error ? `: ${r.error}` : ''}`;
    list.appendChild(li);
  }
}

function frResetOnEntry() {
  if (frDownloadEventSource) { frDownloadEventSource.close(); frDownloadEventSource = null; }
  frState.mod = null;
  frState.files = [];
  frState.activeCategories = frDefaultCategories();
  frState.selected.clear();
  frFileSort.column = 'date';
  frFileSort.direction = 'desc';
  $g('frModIdInput').value = '';
  frHideCriticalError();
  frGoScreen('frScreen1', 0);
}
window.frResetOnEntry = frResetOnEntry;

$g('frDoneBtn').addEventListener('click', frResetOnEntry);
