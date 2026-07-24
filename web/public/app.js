'use strict';

const STATUS_TEXT = {
  REBUILT: 'Rebuilt',
  REBUILD: 'Will rebuild',
  REBUILD_QUEUED: 'Queued',
  SKIP_IGNORED: 'Ignored',
  SKIP_NO_ARCHIVE: 'No archive',
  SKIP_OPTIONAL_NOT_INSTALLED: 'Optional, not installed',
  SKIP_OPEN_FOMOD: 'Open FOMOD',
  FAILED_MISMATCH_NOT_TOUCHED: 'Mismatch (not touched)',
  FAILED_EXTRACTION_NOT_TOUCHED: 'Extraction failed (not touched)',
  FAILED_EXTRACTION_NO_PRIOR_DATA: 'Extraction failed (still missing)',
  CRITICAL_MANUAL_RESTORE_NEEDED: 'CRITICAL',
  pending: 'In progress…',
};

const state = {
  collectionModId: null,
  plan: null,
  resumeLogPath: null,
  eventSource: null,
  progressRows: new Map(), // modName -> <tr>
};

// ---------- tiny helpers ----------

function $(id) { return document.getElementById(id); }
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}
function statusPill(status) {
  const cls = 'status-pill status-pill--' + status.toLowerCase();
  return el('span', { class: cls }, STATUS_TEXT[status] || status);
}

// A real mod name 178 characters long (several Nexus authors concatenate multiple patch names
// into one) combined with the Mod column's deliberate white-space:nowrap forces that column to
// claim nearly the whole table width under table-layout:auto, squeezing the Detail column down to
// a sliver and turning ordinary content into a vertical wall of one-word lines -- confirmed live,
// the exact same bug already fixed in the static log-view page's modRow() (web/rebuild-routes.js)
// but originally missed here, in the live plan/progress tables. Same fix: truncate long names with
// a click-to-expand span instead of relying on CSS alone.
const MOD_NAME_TRUNCATE_AT = 70;
function modNameCell(name) {
  if (!name || name.length <= MOD_NAME_TRUNCATE_AT) return name;
  const short = name.slice(0, MOD_NAME_TRUNCATE_AT - 1) + '…';
  const span = el('span', { class: 'mod-name mod-name--truncated', title: name }, short);
  span.dataset.full = name;
  span.dataset.short = short;
  span.addEventListener('click', () => {
    const stillTruncated = span.classList.toggle('mod-name--truncated');
    span.textContent = stillTruncated ? span.dataset.short : span.dataset.full;
  });
  return span;
}
function showView(name) {
  for (const v of document.querySelectorAll('.view')) v.classList.add('hidden');
  $(`view-${name}`).classList.remove('hidden');
}

// Replaces the native alert() for error messages -- confirmed live this was hard to read for a
// real, genuinely long error (the native-LevelDB-crash explanation, several sentences with its own
// suggested recovery steps): alert()'s box is small, unstyled, and gives no control over sizing.
function showErrorModal(message, title) {
  $('errorModalTitle').textContent = title || 'Error';
  $('errorModalText').textContent = message;
  $('errorModal').classList.remove('hidden');
}
document.querySelector('[data-action="close-error-modal"]').addEventListener('click', () => {
  $('errorModal').classList.add('hidden');
});
$('errorModal').addEventListener('click', (e) => {
  if (e.target.id === 'errorModal') $('errorModal').classList.add('hidden');
});
async function api(method, path, body) {
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

// ---------- Vortex-blocked banner ----------

function showVortexBanner() { $('vortexBanner').classList.remove('hidden'); }
function hideVortexBanner() { $('vortexBanner').classList.add('hidden'); }

// Which action to re-run when "Retry" is clicked -- confirmed live this was hardcoded to always
// re-run loadCollections(), regardless of what actually failed. A "vortex is running" error hit
// while on the Plan view (e.g. after a Workshop fetch's auto-navigate-to-plan) left the view stuck
// showing just its header (back button + title), and clicking Retry silently refreshed the
// invisible collections-picker view instead of re-attempting the plan -- looked like Retry did
// nothing at all. Defaults to loadCollections for the one call site (loadCollections' own error
// handler) that doesn't set anything more specific.
let pendingVortexRetry = loadCollections;

$('vortexRetryBtn').addEventListener('click', () => {
  hideVortexBanner();
  pendingVortexRetry();
});

function handleApiError(e, retryFn) {
  if (e.status === 409 && e.body && e.body.error === 'vortex-running') {
    pendingVortexRetry = retryFn || loadCollections;
    showVortexBanner();
    return true;
  }
  return false;
}

// ---------- Collection picker ----------

let collectionsById = new Map();
let vortexDataEventSource = null;

function renderVortexDataStatus(loadedAt, cachedCount, totalCount) {
  const el2 = $('vortexDataStatus');
  el2.classList.remove('is-fresh');
  if (!loadedAt) {
    el2.textContent = `Not loaded yet — each collection will read Vortex's database individually (more crash exposure if working through several).`;
  } else {
    el2.classList.add('is-fresh');
    el2.textContent = `✓ Loaded ${cachedCount}/${totalCount} collections at ${new Date(loadedAt).toLocaleTimeString()} — viewing a collection won't touch Vortex's database again until you refresh.`;
  }
}

// Workshop-only collections render as a dropdown (mirroring the main collection picker above it),
// not a flat scrolling list -- one shared slug/revision/fetch row underneath acts on whichever
// entry is currently selected. modId is unique per Vortex mod entry, so it's a safe <option> value.
let workshopOnlyCollections = [];

function renderWorkshopOnlyPicker(list) {
  // Rebuilding a <select>'s options wipes its selection back to the first one with no explicit
  // "selected" -- confirmed live: clicking "Fetch from Nexus" triggers exactly this reload, so
  // right after fetching for e.g. "My QOL and Utilities" the picker silently jumped back to
  // whatever's now alphabetically first ("Community Shaders"), discarding the user's selection.
  // Re-select the same modId afterward if it's still in the list.
  const previousModId = $('workshopOnlySelect').value;
  workshopOnlyCollections = list || [];
  const section = $('workshopOnlySection');
  if (workshopOnlyCollections.length === 0) {
    section.classList.add('hidden');
    return;
  }
  section.classList.remove('hidden');
  const select = $('workshopOnlySelect');
  select.innerHTML = '';
  // A fresh page load has no previousModId to restore, so the browser's own default -- select the
  // first real option -- silently jumped straight to whichever collection sorts first alphabetically
  // and immediately ran its (possibly error-state) selection-change handler with nothing actually
  // chosen yet. This placeholder makes "nothing selected" a real, explicit option instead.
  select.appendChild(el('option', { value: '' }, 'Select collection…'));
  for (const w of workshopOnlyCollections) {
    const lastExtracted = w.lastExtracted ? ` — Last extracted: ${new Date(w.lastExtracted).toLocaleString()}` : '';
    // Vortex's own "source" attribute is "user-generated" for any collection authored purely in the
    // Workshop tab, never published -- see onWorkshopSelectionChange's own "never published" case.
    // "(user-generated)" read as jargon-y and didn't clearly convey that meaning; "(local)" is the
    // user-facing version of the same fact.
    const sourceLabel = w.source === 'user-generated' ? 'local' : w.source;
    const label = `${w.name}${sourceLabel ? ` (${sourceLabel})` : ''}${lastExtracted}`;
    select.appendChild(el('option', { value: w.modId }, label));
  }
  if (previousModId && workshopOnlyCollections.some((w) => w.modId === previousModId)) {
    select.value = previousModId;
  }
  onWorkshopSelectionChange();
}

function currentWorkshopSelection() {
  const modId = $('workshopOnlySelect').value;
  return workshopOnlyCollections.find((w) => w.modId === modId);
}

// Fetch and View-on-Nexus both need a real slug + a real selected published revision to make
// sense, so they're always enabled/disabled together.
function setRevisionActionButtonsDisabled(disabled) {
  $('workshopFetchBtn').disabled = disabled;
  $('workshopViewNexusBtn').disabled = disabled;
}

function resetRevisionPicker(placeholderText, isError) {
  const revSelect = $('workshopRevSelect');
  revSelect.innerHTML = '';
  revSelect.appendChild(el('option', { value: '' }, placeholderText));
  revSelect.disabled = true;
  revSelect.classList.toggle('select--error', !!isError);
  setRevisionActionButtonsDisabled(true);
  $('workshopRevHint').classList.add('hidden');
}

// A monotonic token guards against a slower, earlier lookup's response overwriting a newer one if
// the user changes the id/selection again before the first call returns.
let revisionsLoadToken = 0;

// Looks up which revisions of this Nexus collection id are ACTUALLY published (vs. a work-in-
// progress draft) and populates the revision <select> with EVERY one of them, draft or published.
// CORRECTED this session: revisionStatus "draft" does NOT mean "not real/not downloadable" -- it
// means "not made publicly listed/searchable yet" (Nexus's own `collectionStatus: "unlisted"`).
// The user proved this directly with a live Nexus screenshot: a "draft" revision has a real, saved
// package with a working download button, same as a published one -- confirmed independently by
// this tool's own earlier successful fetch of a draft-status revision. An earlier version of this
// filtered to published-only, which silently hid perfectly good, fetchable content for every one
// of the user's own (all still-unlisted) collections. Every real revision is shown here, labeled
// with its own status so the user can see and choose deliberately -- nothing is hidden anymore.
async function lookupRevisions(slug) {
  const revSelect = $('workshopRevSelect');
  const statusEl = $('workshopFetchStatus');
  statusEl.textContent = '';
  if (!slug) { resetRevisionPicker('Enter a collection id first'); return; }
  const token = ++revisionsLoadToken;
  resetRevisionPicker('Looking up revisions…');
  try {
    const data = await api('GET', `/api/rebuild/workshop/nexus-revisions?slug=${encodeURIComponent(slug)}`);
    if (token !== revisionsLoadToken) return; // a newer lookup started -- drop this stale result
    revSelect.innerHTML = '';
    if (data.revisions.length === 0) {
      revSelect.appendChild(el('option', { value: '' }, 'No revisions found'));
      revSelect.disabled = true;
      setRevisionActionButtonsDisabled(true);
    } else {
      for (const r of data.revisions) {
        // updatedAt, not createdAt -- confirmed live this session: Nexus updates a draft/unlisted
        // revision's actual content in place rather than assigning it a new revision number, so
        // createdAt can be many months stale (e.g. "3/23/2026") even seconds after a real content
        // update, making a genuinely fresh revision look untouched.
        const when = new Date(r.updatedAt).toLocaleDateString();
        const statusTag = r.revisionStatus === 'published' ? 'published' : 'draft, not public';
        revSelect.appendChild(el('option', { value: String(r.revisionNumber) }, `Revision ${r.revisionNumber} — updated: ${when} (${statusTag})`));
      }
      revSelect.disabled = false;
      setRevisionActionButtonsDisabled(false);
    }
    const hint = $('workshopRevHint');
    hint.classList.remove('workshop-rev-hint--error'); // this is the informational (not-listed) case, never the error one
    if (data.collectionStatus && data.collectionStatus !== 'listed') {
      hint.textContent = `This collection is "${data.collectionStatus}" on Nexus (not publicly searchable) -- the revisions above are real and fetchable via your own account, but won't be visible to anyone else until you publish and list it.`;
      hint.classList.remove('hidden');
    } else {
      hint.classList.add('hidden');
    }
  } catch (e) {
    if (token !== revisionsLoadToken) return;
    revSelect.innerHTML = '';
    revSelect.appendChild(el('option', { value: '' }, 'Lookup failed'));
    revSelect.disabled = true;
    setRevisionActionButtonsDisabled(true);
    statusEl.textContent = `Failed: ${e.message}`;
  }
}

// Pre-fills the id field from Vortex's own tracked attributes###collectionSlug (always correct,
// regardless of which revision is published) whenever the selection changes, then looks up which
// revisions are actually published for it.
function onWorkshopSelectionChange() {
  const w = currentWorkshopSelection();
  const slug = w && w.collectionSlug ? w.collectionSlug : '';
  $('workshopSlugInput').value = slug;
  if (w && !slug) {
    // Confirmed live against a real case ("My GTS Audio Overhaul"): a Workshop entry with NO
    // collectionSlug recorded in Vortex's own state at all -- also no collectionId, no source,
    // nothing -- means it has never been uploaded/published to NexusMods, not just "not looked up
    // yet". Left as a bare, easy-to-miss disabled dropdown placeholder before ("Enter a collection
    // id first", the same text shown when the user manually clears the field themselves) -- this
    // is a genuinely different, more definitive state, worth a clear, visible explanation instead.
    resetRevisionPicker('No Nexus id on record', true);
    const hint = $('workshopRevHint');
    hint.textContent = `"${w.name}" has no Nexus collection id recorded in Vortex -- it looks like this collection has never been published/uploaded to NexusMods. If it actually has been, you can type its collection id into the field above manually.`;
    hint.classList.add('workshop-rev-hint--error');
    hint.classList.remove('hidden');
    return;
  }
  lookupRevisions(slug);
}

$('workshopOnlySelect').addEventListener('change', onWorkshopSelectionChange);

// Re-looks-up revisions if the user manually edits the id -- needed when Vortex didn't know a
// slug at all (source: "user-generated" collections have none) and the user types one in.
$('workshopSlugInput').addEventListener('change', () => lookupRevisions($('workshopSlugInput').value.trim()));

$('workshopFetchBtn').addEventListener('click', async () => {
  const w = currentWorkshopSelection();
  const statusEl = $('workshopFetchStatus');
  if (!w) return;
  const slug = $('workshopSlugInput').value.trim();
  const revisionNumber = $('workshopRevSelect').value;
  if (!slug) { statusEl.textContent = 'Enter the collection id first.'; return; }
  if (!revisionNumber) { statusEl.textContent = 'Look up and select a published revision first.'; return; }
  const btn = $('workshopFetchBtn');
  btn.disabled = true;
  statusEl.textContent = 'Fetching…';
  try {
    const result = await api('POST', '/api/rebuild/workshop/fetch-from-nexus', { slug, folder: w.folder, revisionNumber });
    // Prefer Vortex's own tracked name (w.name, sourced from customFileName/attributes###name) over
    // whatever Nexus's API returns for the collection -- that's what the user actually sees in
    // both the Workshop and the mods-section dropdown, and the two can genuinely differ (a local
    // rename doesn't get pushed back to Nexus's collection metadata).
    statusEl.textContent = `Done — "${w.name}" revision ${result.revisionNumber}, ${result.modCount} mods. Opening plan…`;
    btn.disabled = false;
    // A fetched collection.json is just as real as any installed collection's -- computePlan/
    // resolveCollectionInfo only read the file and this modId's live Vortex rules, neither of which
    // cares about the vortex_collection_* naming convention (that only decides which dropdown shows
    // it). Go straight to the plan for what was just fetched, same as clicking "View Collection".
    openPlan(w.folder, w.name);
  } catch (e) {
    statusEl.textContent = `Failed: ${e.message}`;
    btn.disabled = false;
  }
});

// The exact published revision is already selected in the dropdown here (unlike the main
// collection list, which has no revision picker of its own) -- no extra lookup needed, just build
// the URL and open it.
$('workshopViewNexusBtn').addEventListener('click', () => {
  const slug = $('workshopSlugInput').value.trim();
  const revisionNumber = $('workshopRevSelect').value;
  if (!slug || !revisionNumber) return;
  window.open(nexusCollectionUrl(slug, revisionNumber), '_blank');
});

async function loadCollections() {
  $('collectionPickerLoading').classList.remove('hidden');
  $('vortexDataBox').classList.add('hidden');
  $('collectionPicker').classList.add('hidden');
  $('collectionEmpty').classList.add('hidden');

  try {
    const { collections, vortexDataLoadedAt, workshopOnlyCollections: workshopOnlyList } = await api('GET', '/api/rebuild/collections');
    $('collectionPickerLoading').classList.add('hidden');

    renderWorkshopOnlyPicker(workshopOnlyList);

    if (collections.length === 0) {
      $('collectionEmpty').textContent = 'No installed collections found.';
      $('collectionEmpty').classList.remove('hidden');
      return;
    }

    collectionsById = new Map(collections.map((c) => [c.modId, c]));
    const cachedCount = collections.filter((c) => c.vortexDataCached).length;
    renderVortexDataStatus(vortexDataLoadedAt, cachedCount, collections.length);
    $('vortexDataBox').classList.remove('hidden');

    // Same "rebuilding a <select> resets its selection" issue as renderWorkshopOnlyPicker --
    // preserve it across a reload (e.g. after "Load Vortex Data" refreshes this same list).
    const select = $('collectionSelect');
    const previousModId = select.value;
    select.innerHTML = '';
    for (const c of collections) {
      const lastExtracted = c.lastExtracted ? ` — Last extracted: ${new Date(c.lastExtracted).toLocaleString()}` : '';
      const label = `${c.vortexDataCached ? '✓ ' : ''}${c.name} (${c.modCount} mods)${lastExtracted}${c.resumableLog ? ' — Resumable' : ''}`;
      select.appendChild(el('option', { value: c.modId }, label));
    }
    if (previousModId && collections.some((c) => c.modId === previousModId)) {
      select.value = previousModId;
    }
    $('collectionPicker').classList.remove('hidden');
  } catch (e) {
    $('collectionPickerLoading').classList.add('hidden');
    if (!handleApiError(e)) {
      $('collectionEmpty').textContent = `Error: ${e.message}`;
      $('collectionEmpty').classList.remove('hidden');
    }
  }
}

$('viewPlanBtn').addEventListener('click', () => {
  const modId = $('collectionSelect').value;
  const c = collectionsById.get(modId);
  if (c) openPlan(c.modId, c.name);
});

// Opens the collection's real Nexus page, at a specific revision when one is known -- e.g.
// https://www.nexusmods.com/games/skyrimspecialedition/collections/qdurkx/revisions/111
function nexusCollectionUrl(slug, revisionNumber) {
  const base = `https://www.nexusmods.com/games/skyrimspecialedition/collections/${encodeURIComponent(slug)}`;
  return revisionNumber ? `${base}/revisions/${revisionNumber}` : base;
}

// The main collection list has no revision picker of its own (unlike the Workshop-only section),
// so this looks up the latest ACTUALLY-published revision on click (same endpoint/logic as the
// Workshop revision picker) rather than guessing -- Vortex's own tracked revision number has
// already been proven untrustworthy for this (see the Workshop-only section's own history).
$('viewNexusBtn').addEventListener('click', async () => {
  const modId = $('collectionSelect').value;
  const c = collectionsById.get(modId);
  if (!c) return;
  if (!c.collectionSlug) {
    showErrorModal('This collection\'s Nexus id isn\'t known yet -- click "Load Vortex Data" first.');
    return;
  }
  const btn = $('viewNexusBtn');
  btn.disabled = true;
  // Open the tab SYNCHRONOUSLY, before the network lookup below -- Chrome's popup blocker ties
  // window.open to the click's "user activation", which expires across an await. Opening it AFTER
  // the awaited lookup (the original version) got silently blocked with zero visible error.
  // Land on the plain collection page first, then redirect to the specific revision once known.
  const tab = window.open(nexusCollectionUrl(c.collectionSlug), '_blank');
  try {
    const data = await api('GET', `/api/rebuild/workshop/nexus-revisions?slug=${encodeURIComponent(c.collectionSlug)}`);
    const latest = data.revisions[0];
    if (tab && latest) tab.location.href = nexusCollectionUrl(c.collectionSlug, latest.revisionNumber);
  } catch (e) {
    showErrorModal(`Could not look up this collection's revisions on Nexus: ${e.message}`);
  } finally {
    btn.disabled = false;
  }
});

// ---------- Browse logs ----------

async function loadLogsForCollection(collectionModId) {
  const select = $('logsLogSelect');
  select.innerHTML = '';
  $('openLogBtn').disabled = true;
  $('logsEmpty').classList.add('hidden');

  const { logs } = await api('GET', `/api/rebuild/logs/${collectionModId}`);
  if (logs.length === 0) {
    $('logsEmpty').classList.remove('hidden');
    return;
  }
  for (const log of logs) {
    const when = new Date(log.startedAt).toLocaleString();
    select.appendChild(el('option', { value: log.file }, when));
  }
  $('openLogBtn').disabled = false;
}

$('viewLogsBtn').addEventListener('click', async () => {
  const modId = $('collectionSelect').value;
  const c = collectionsById.get(modId);
  if (!c) return;
  showView('logs');
  $('logsCollectionName').textContent = c.name;
  await loadLogsForCollection(c.modId);
});

$('openLogBtn').addEventListener('click', () => {
  const filename = $('logsLogSelect').value;
  // Same-tab navigation, not a new tab -- the log-view page now has its own "Back to Collections"
  // link (see web/rebuild-routes.js) to return here, and the new "Extraction" resolve buttons on
  // that page make it a real working session in its own right, not just a quick look-and-close.
  if (filename) location.href = `/api/rebuild/logs/view/${encodeURIComponent(filename)}`;
});

async function refreshVortexData() {
  const btn = $('refreshVortexDataBtn');
  btn.disabled = true;
  const statusEl = $('vortexDataStatus');
  statusEl.classList.remove('is-fresh');

  let count;
  try {
    ({ count } = await api('POST', '/api/rebuild/vortex-data/refresh'));
    hideVortexBanner();
  } catch (e) {
    btn.disabled = false;
    if (!handleApiError(e, refreshVortexData)) showErrorModal(e.message, 'Could not load Vortex data');
    return;
  }

  statusEl.innerHTML = '';
  statusEl.appendChild(el('span', { class: 'spinner' }));
  statusEl.appendChild(document.createTextNode(` Reading Vortex's database once for all ${count} installed collection(s)…`));

  if (vortexDataEventSource) vortexDataEventSource.close();
  const es = new EventSource('/api/rebuild/vortex-data/events');
  vortexDataEventSource = es;
  es.onmessage = (msg) => {
    const frame = JSON.parse(msg.data);
    if (frame.type === 'sync-state-progress') {
      statusEl.innerHTML = '';
      statusEl.appendChild(el('span', { class: 'spinner' }));
      statusEl.appendChild(document.createTextNode(` Reading Vortex state — step ${frame.step} of ${frame.total}: ${frame.label}`));
      return;
    }
    if (frame.type === 'refresh-complete' || frame.type === 'refresh-error') {
      es.close();
      vortexDataEventSource = null;
      btn.disabled = false;
      if (frame.type === 'refresh-error') {
        if (!handleApiError({ message: frame.message }, refreshVortexData)) showErrorModal(frame.message, 'Could not load Vortex data');
      }
      loadCollections();
    }
  };
}
$('refreshVortexDataBtn').addEventListener('click', refreshVortexData);

document.querySelectorAll('[data-action="back-to-picker"]').forEach((b) => b.addEventListener('click', () => {
  showView('picker');
  loadCollections();
}));

// ---------- Plan view ----------

let planEventSource = null;

async function openPlan(collectionModId, name, resumeLogPath) {
  state.collectionModId = collectionModId;
  state.resumeLogPath = resumeLogPath || null;
  showView('plan');
  $('planTitle').textContent = name;
  $('planLoading').classList.remove('hidden');
  $('planContent').classList.add('hidden');
  $('planLoadingText').textContent = 'Reading Vortex state… Please wait as this can take some time for a large collection.';
  $('planProgressBarWrap').classList.add('hidden');
  $('planProgressBar').style.width = '0%';

  try {
    await api('POST', '/api/rebuild/plan', { collectionModId, resumeLogPath });
    hideVortexBanner();
  } catch (e) {
    $('planLoading').classList.add('hidden');
    if (!handleApiError(e, () => openPlan(collectionModId, name, resumeLogPath))) showErrorModal(e.message, 'Could not load plan');
    return;
  }

  if (planEventSource) planEventSource.close();
  const es = new EventSource('/api/rebuild/plan/current/events');
  planEventSource = es;
  es.onmessage = (msg) => handlePlanEvent(JSON.parse(msg.data));
}

function handlePlanEvent(frame) {
  switch (frame.type) {
    case 'phase':
      if (frame.phase === 'sync-state') $('planLoadingText').textContent = 'Reading Vortex state… Please wait as this can take some time for a large collection.';
      else if (frame.phase === 'sync-state-cached') $('planLoadingText').textContent = 'Using cached Vortex data (no database read needed)…';
      break;
    case 'sync-state-progress':
      $('planProgressBarWrap').classList.remove('hidden');
      $('planProgressBar').style.width = `${Math.round((frame.step / frame.total) * 100)}%`;
      $('planLoadingText').textContent = `Reading Vortex state — step ${frame.step} of ${frame.total}: ${frame.label}`;
      break;
    case 'classify-progress': {
      $('planProgressBarWrap').classList.remove('hidden');
      const pct = Math.round((frame.index / frame.total) * 100);
      $('planProgressBar').style.width = `${pct}%`;
      $('planLoadingText').textContent = `Checking mod ${frame.index} of ${frame.total} (${pct}%): ${frame.name}`;
      break;
    }
    case 'plan-ready':
      if (planEventSource) { planEventSource.close(); planEventSource = null; }
      state.plan = frame;
      renderPlan(frame);
      $('planLoading').classList.add('hidden');
      $('planContent').classList.remove('hidden');
      break;
    case 'plan-error':
      if (planEventSource) { planEventSource.close(); planEventSource = null; }
      $('planLoading').classList.add('hidden');
      showErrorModal(frame.message, 'Could not load plan');
      break;
  }
}

function renderPlan(plan) {
  $('planTitle').textContent = `${plan.collectionInfo.name} (${plan.collectionInfo.totalModsInCollection} mods)`;

  if (plan.resumableLog) {
    $('resumeBox').classList.remove('hidden');
    $('resumeMeta').textContent = `(${plan.resumableLog.runStatus}, ${new Date(plan.resumableLog.finishedAt || Date.now()).toLocaleString()})`;
  }

  const summaryEl = $('planSummary');
  summaryEl.innerHTML = '';
  for (const [status, count] of Object.entries(plan.summary)) {
    summaryEl.appendChild(el('span', { class: 'badge badge--' + status.toLowerCase() }, [
      el('span', { class: 'badge__count' }, String(count)), ' ' + (STATUS_TEXT[status] || status),
    ]));
  }

  if (plan.openFomodMods.length > 0) {
    $('openFomodSection').classList.remove('hidden');
    const list = $('openFomodList');
    list.innerHTML = '';
    for (const m of plan.openFomodMods) list.appendChild(el('li', {}, modNameCell(m.name)));
  }

  const body = $('planTableBody');
  body.innerHTML = '';
  // Ignored/optional-not-installed mods carry no action at all -- put them last so the mods that
  // actually matter (will rebuild, need research, etc.) are visible without scrolling past a wall
  // of non-actionable rows.
  const NON_ACTIONABLE = new Set(['SKIP_IGNORED', 'SKIP_OPTIONAL_NOT_INSTALLED']);
  const ignored = plan.modEntries.filter((e) => NON_ACTIONABLE.has(e.status));
  const actionable = plan.modEntries.filter((e) => !NON_ACTIONABLE.has(e.status));
  for (const e of actionable) {
    body.appendChild(el('tr', {}, [
      el('td', {}, modNameCell(e.name)),
      el('td', {}, statusPill(e.status)),
      el('td', { class: 'detail-cell' }, e.detail || ''),
    ]));
  }
  for (const r of plan.rebuildQueue) {
    const status = r.existingStagingFolder ? 'REBUILD' : 'REBUILD_QUEUED';
    let detail = r.existingStagingFolder ? '' : 'No staging folder exists — will create from scratch';
    if (r.otherVersionsNote) detail += (detail ? ' — ' : '') + `a different version of this exact mod IS installed: ${r.otherVersionsNote}`;
    if (r.sharedWithNote) detail += (detail ? '\n\n' : '') + `Already included in:\n${r.sharedWithNote.join('\n')}`;
    body.appendChild(el('tr', {}, [
      el('td', {}, modNameCell(r.name)),
      el('td', {}, statusPill(status)),
      el('td', { class: 'detail-cell' }, detail),
    ]));
  }
  for (const e of ignored) {
    body.appendChild(el('tr', {}, [
      el('td', {}, modNameCell(e.name)),
      el('td', {}, statusPill(e.status)),
      el('td', { class: 'detail-cell' }, e.detail || ''),
    ]));
  }

  const hasWork = plan.rebuildQueue.length > 0;
  for (const id of ['startRebuildBtn', 'startRebuildBtnTop']) $(id).disabled = !hasWork;
  for (const id of ['nothingToRebuildNote', 'nothingToRebuildNoteTop']) $(id).classList.toggle('hidden', hasWork);
}

$('resumeToggle').addEventListener('change', (e) => {
  const resumeLogPath = e.target.checked ? state.plan.resumableLog.path : null;
  const name = $('planTitle').textContent;
  openPlan(state.collectionModId, name, resumeLogPath);
});

// ---------- Confirm modal ----------

for (const id of ['startRebuildBtn', 'startRebuildBtnTop']) {
  $(id).addEventListener('click', () => {
    $('confirmText').textContent = `This will rebuild ${state.plan.rebuildQueue.length} mod(s) in "${state.plan.collectionInfo.name}".`;
    $('confirmModal').classList.remove('hidden');
  });
}
document.querySelector('[data-action="cancel-confirm"]').addEventListener('click', () => {
  $('confirmModal').classList.add('hidden');
});
async function startRebuildRun() {
  try {
    await api('POST', '/api/rebuild/runs', { collectionModId: state.collectionModId, resumeLogPath: state.resumeLogPath });
    startProgressView();
  } catch (e) {
    if (!handleApiError(e, startRebuildRun)) showErrorModal(e.message, 'Could not start rebuild');
  }
}
document.querySelector('[data-action="confirm-run"]').addEventListener('click', () => {
  $('confirmModal').classList.add('hidden');
  startRebuildRun();
});

// ---------- Live progress ----------

function startProgressView() {
  showView('progress');
  window.scrollTo({ top: 0, behavior: 'instant' });
  $('progressTitle').textContent = `Rebuilding ${state.plan.collectionInfo.name}…`;
  $('phaseIndicator').innerHTML = '';
  $('progressTableBody').innerHTML = '';
  state.progressRows.clear();

  for (const r of state.plan.rebuildQueue) {
    const row = el('tr', {}, [
      el('td', {}, modNameCell(r.name)),
      el('td', {}, statusPill('pending')),
      el('td', { class: 'detail-cell' }, ''),
    ]);
    state.progressRows.set(r.name, row);
    $('progressTableBody').appendChild(row);
  }

  if (state.eventSource) state.eventSource.close();
  const es = new EventSource('/api/rebuild/runs/current/events');
  state.eventSource = es;

  es.onmessage = (msg) => {
    const frame = JSON.parse(msg.data);
    handleRunEvent(frame);
  };
  es.onerror = () => {
    // EventSource auto-reconnects with Last-Event-ID; nothing to do here besides letting it retry.
  };
}

function setPhase(text) {
  $('phaseIndicator').innerHTML = '';
  $('phaseIndicator').appendChild(el('span', { class: 'spinner' }));
  $('phaseIndicator').appendChild(document.createTextNode(' ' + text));
}

const PHASE_TEXT = {
  'sync-state': 'Reading Vortex state… Please wait as this can take some time for a large collection.',
  'plan-ready': 'Plan ready',
  'backing-up': 'Backing up current staging folders…',
  rebuilding: 'Rebuilding mods…',
};

function updateProgressRow(name, status, detail) {
  const row = state.progressRows.get(name);
  if (!row) return;
  row.children[1].innerHTML = '';
  row.children[1].appendChild(statusPill(status));
  row.children[2].textContent = detail || '';
  row.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function handleRunEvent(frame) {
  switch (frame.type) {
    case 'phase':
      if (PHASE_TEXT[frame.phase]) setPhase(PHASE_TEXT[frame.phase]);
      break;
    case 'sync-state-progress':
      setPhase(`Reading Vortex state — step ${frame.step} of ${frame.total}: ${frame.label}`);
      break;
    case 'backup-progress':
      setPhase(`Backing up (${frame.index}/${frame.total}): ${frame.modName}`);
      break;
    case 'mod-start':
      updateProgressRow(frame.modName, 'pending', 'Extracting…');
      break;
    case 'mod-complete': {
      let detail = frame.detail || '';
      if (frame.restoredMissingFiles?.length) detail = `Restored ${frame.restoredMissingFiles.length} missing file(s)`;
      if (frame.eslPreserved?.length) detail = (detail ? detail + ' — ' : '') + `Marked as Light, left unchanged: ${frame.eslPreserved.join(', ')}`;
      if (frame.otherVersionsNote) detail = (detail ? detail + ' — ' : '') + `A different version of this exact mod IS installed: ${frame.otherVersionsNote}`;
      if (frame.sharedWithNote) detail = (detail ? detail + '\n\n' : '') + `Already included in:\n${frame.sharedWithNote.join('\n')}`;
      if (frame.archiveName && frame.status !== 'REBUILT') detail = (detail ? detail + ' — ' : '') + `Archive: ${frame.archiveName}`;
      updateProgressRow(frame.name, frame.status, detail);
      break;
    }
    case 'critical-halt':
      showCriticalBanner(frame);
      break;
    case 'run-complete':
      finishProgressView(frame);
      break;
    case 'run-error':
      showErrorModal(frame.message, 'Run error');
      showView('picker');
      break;
  }
}

let pendingCritical = null;
function showCriticalBanner(frame) { pendingCritical = frame; }

function finishProgressView(frame) {
  if (state.eventSource) { state.eventSource.close(); state.eventSource = null; }
  showView('summary');

  const summaryEl = $('summaryBadges');
  summaryEl.innerHTML = '';
  for (const [status, count] of Object.entries(frame.summary)) {
    summaryEl.appendChild(el('span', { class: 'badge badge--' + status.toLowerCase() }, [
      el('span', { class: 'badge__count' }, String(count)), ' ' + (STATUS_TEXT[status] || status),
    ]));
  }

  if (pendingCritical) {
    $('criticalBanner').classList.remove('hidden');
    $('criticalDetail').innerHTML = '';
    $('criticalDetail').appendChild(el('div', {}, [
      el('div', {}, `Mod: ${pendingCritical.modName}`),
      el('div', {}, `Old content at: ${pendingCritical.oldContentDir}`),
      el('div', {}, `New content at: ${pendingCritical.rebuildingDir}`),
      el('div', {}, `Real staging slot: ${pendingCritical.stagingModDir}`),
      el('div', { class: 'muted' }, 'Restore this one by hand, then resume this collection.'),
    ]));
    pendingCritical = null;
  } else {
    $('criticalBanner').classList.add('hidden');
  }

  if (frame.openFomodMods?.length) {
    $('summaryOpenFomodSection').classList.remove('hidden');
    const list = $('summaryOpenFomodList');
    list.innerHTML = '';
    for (const m of frame.openFomodMods) list.appendChild(el('li', {}, m.name));
  } else {
    $('summaryOpenFomodSection').classList.add('hidden');
  }

  $('backupPath').textContent = frame.backupRunDir || '(nothing backed up)';
  $('logPath').textContent = frame.logPath;
  const logFilename = frame.logPath.split(/[\\/]/).pop();
  $('viewLogLink').href = `/api/rebuild/logs/view/${encodeURIComponent(logFilename)}`;
}

document.querySelector('[data-action="reveal-backup"]').addEventListener('click', () => {
  const p = $('backupPath').textContent;
  if (p && p !== '(nothing backed up)') api('POST', '/api/rebuild/reveal', { targetPath: p }).catch(() => {});
});
document.querySelector('[data-action="reveal-log"]').addEventListener('click', () => {
  const p = $('logPath').textContent;
  if (p) api('POST', '/api/rebuild/reveal', { targetPath: p }).catch(() => {});
});

// ---------- boot ----------

loadCollections();
