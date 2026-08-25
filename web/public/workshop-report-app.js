'use strict';
// Workshop Report (Reports sub-tab) -- see web/workshop-report-routes.js's own header for the full
// data-source/pacing writeup. This file only renders what that router returns/streams; el()/
// nexusCollectionUrl() come from app.js (loaded earlier), same "shared tiny helpers, self-contained
// per file" convention as this project's other *-app.js files.

function $g(id) { return document.getElementById(id); }

async function wrApi(method, urlPath, body) {
  const res = await fetch(urlPath, {
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

// retryFn (queue: vortex-retry-noop-sweep): found via the same grep as the other 4 files in this
// pass (not originally in scope, but the identical bug, so fixed alongside them) -- same fix as
// rebuild-missing-app.js's own rmfHandleError (b3eb0c7).
function wrHandleError(e, box, retryFn) {
  if (e.status === 409 && e.body?.error === 'vortex-running') {
    window.showVortexRunningModal(retryFn || (() => {}));
    return;
  }
  if (window.isServerUnreachableError && window.isServerUnreachableError(e)) {
    window.showServerUnreachableError();
    return;
  }
  box.textContent = e.message;
  box.classList.remove('hidden');
}

// Small bucketed "X ago" formatter -- no existing shared helper in this app to reuse (checked
// before writing this). Used both for "Last checked: X ago" and each row's own "Last updated" cell.
function wrRelativeTime(iso) {
  if (!iso) return '';
  const diffSec = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (diffSec < 60) return 'just now';
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? '' : 's'} ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hour${diffHr === 1 ? '' : 's'} ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay === 1) return 'yesterday';
  if (diffDay < 7) return `${diffDay} days ago`;
  const diffWeek = Math.round(diffDay / 7);
  if (diffWeek < 8) return `${diffWeek} week${diffWeek === 1 ? '' : 's'} ago`;
  const diffMonth = Math.round(diffDay / 30);
  if (diffMonth < 12) return `${diffMonth} month${diffMonth === 1 ? '' : 's'} ago`;
  const diffYear = Math.round(diffDay / 365);
  return `${diffYear} year${diffYear === 1 ? '' : 's'} ago`;
}

// ---------- Load (cached only -- never touches Nexus/Vortex on its own) ----------

let wrPageLoaded = false;
async function loadWorkshopReportPageOnce() {
  if (wrPageLoaded) return;
  wrPageLoaded = true;
  await wrLoadRows();
}

// Split out from loadWorkshopReportPageOnce (queue: vortex-retry-noop-sweep) so a Vortex-running
// retry can re-run the real fetch -- passing the once-guarded wrapper itself would silently no-op
// on a second call, since wrPageLoaded is already true by then.
async function wrLoadRows() {
  try {
    const data = await wrApi('GET', '/api/workshop-report/rows');
    wrRenderLastChecked(data.checkedAt);
    if (data.rows && data.rows.length > 0) wrRenderRows(data.rows);
  } catch (e) {
    wrHandleError(e, $g('wrCriticalError'), wrLoadRows);
  }
}

function wrRenderLastChecked(checkedAt) {
  $g('wrLastChecked').textContent = checkedAt ? `Last checked: ${wrRelativeTime(checkedAt)}` : 'Never checked yet';
}

// ---------- Check Nexus for updates ----------

let wrEventSource = null;

// Named (not just an inline listener body) so a Vortex-running retry can re-run this exact check.
async function wrStartCheck() {
  $g('wrCheckBtn').disabled = true;
  $g('wrCriticalError').classList.add('hidden');
  const wrap = $g('wrProgressWrap');
  wrap.classList.remove('hidden');
  $g('wrProgressBar').style.width = '0%';
  $g('wrProgressText').textContent = 'Starting…';

  try {
    await wrApi('POST', '/api/workshop-report/check');
  } catch (e) {
    // A 409 from "a check is already running" (e.g. another tab) is safe to just attach below --
    // a genuine 'vortex-running' 409 is a real failure, not something to silently attach past.
    if (e.status !== 409 || e.body?.error === 'vortex-running') {
      $g('wrCheckBtn').disabled = false;
      wrap.classList.add('hidden');
      wrHandleError(e, $g('wrCriticalError'), wrStartCheck);
      return;
    }
  }

  if (wrEventSource) wrEventSource.close();
  const es = new EventSource('/api/workshop-report/check/events');
  wrEventSource = es;
  es.onmessage = (msg) => wrHandleCheckEvent(JSON.parse(msg.data));
}
$g('wrCheckBtn').addEventListener('click', wrStartCheck);

function wrHandleCheckEvent(frame) {
  if (frame.type === 'collection-checking') {
    const pct = frame.total ? Math.round((frame.index / frame.total) * 100) : 100;
    $g('wrProgressBar').style.width = pct + '%';
    $g('wrProgressText').textContent = `Checking "${frame.name}" — ${frame.index} / ${frame.total}`;
  } else if (frame.type === 'check-complete') {
    $g('wrProgressWrap').classList.add('hidden');
    $g('wrCheckBtn').disabled = false;
    if (wrEventSource) { wrEventSource.close(); wrEventSource = null; }
    wrRenderLastChecked(frame.checkedAt);
    wrRenderRows(frame.rows);
  } else if (frame.type === 'check-error') {
    $g('wrProgressWrap').classList.add('hidden');
    $g('wrCheckBtn').disabled = false;
    if (wrEventSource) { wrEventSource.close(); wrEventSource = null; }
    wrHandleError(new Error(frame.message || 'The check failed.'), $g('wrCriticalError'), wrStartCheck);
  }
}

// ---------- Rows ----------

// Kept around (not just passed straight through) so a per-row Fetch from Nexus can update ONE
// row in place afterward, per the queue instruction, instead of re-running a full Check Nexus for
// updates just to reflect one row's new state.
let wrCurrentRows = [];

// null (no sort applied -- the report's own default row order) until the header's first click,
// then toggles between the two states forever -- no 3rd "back to default" click, per the task's
// own explicit instruction (the director asked for exactly two directions, not a reset). Never
// reset by a data reload (loadWorkshopReportPageOnce/check-complete/wrFetchFromNexus's in-place
// update) -- deliberate: the whole point of sorting is spotting the most out-of-date collections
// at a glance, and a fresh "Check Nexus for updates" run is exactly when that view is most useful,
// not the moment to silently drop it. Same "plain variable the data-loading paths never touch"
// approach already used for Rebuild Missing Files' own rmfKindFilter.
let wrSortDirection = null;

// Rows with no updatedAt (never checked, or no slug on record) always sort to the very end,
// regardless of direction -- there's no meaningful "how out of date" answer for them, and
// interleaving them by some default date value would be actively misleading in a report whose
// whole point is spotting real staleness.
function wrSortedRows(rows, direction) {
  if (!direction) return rows;
  const withDate = rows.filter((r) => r.updatedAt);
  const withoutDate = rows.filter((r) => !r.updatedAt);
  withDate.sort((a, b) => {
    const diff = new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
    return direction === 'newest' ? -diff : diff;
  });
  return [...withDate, ...withoutDate];
}

$g('wrUpdatedHeader').addEventListener('click', () => {
  wrSortDirection = wrSortDirection === 'newest' ? 'oldest' : 'newest';
  wrRenderRows(wrCurrentRows);
});

function wrRenderRows(rows) {
  wrCurrentRows = rows || [];
  $g('wrSortArrow').textContent = wrSortDirection ? (wrSortDirection === 'newest' ? '▼' : '▲') : '';
  // Single choke point (2026-08-24, workshop-report-real-staleness-check) -- every path that can
  // change which rows have a real update available (a fresh check, a per-row update clearing its
  // own flag, the bulk action finishing) already re-renders through here, so this is the one place
  // that needs to keep the button's own enabled state in sync, rather than every call site
  // remembering to do it separately.
  wrRefreshUpdateAllBtnState();

  const tbody = $g('wrRows');
  tbody.innerHTML = '';
  const nothingToShow = wrCurrentRows.length === 0;
  $g('wrEmpty').classList.toggle('hidden', !nothingToShow);
  if (nothingToShow) {
    // Stray fix, found incidentally (2026-08-24) -- this claimed Vortex had to be closed
    // unconditionally, stale since the Helper-first fix (workshop-report-helper-and-refetch) made
    // that only a fallback requirement, not a real one whenever the Helper's reachable. Dropped
    // rather than reworded to describe the Helper/fallback split -- that detail doesn't change what
    // the user does next (click the button either way).
    $g('wrEmpty').textContent = 'No Workshop collections found yet. Click "Check Nexus for updates" to look.';
  }
  $g('wrTableWrap').classList.toggle('hidden', nothingToShow);
  if (nothingToShow) return;

  for (const row of wrSortedRows(wrCurrentRows, wrSortDirection)) {
    const tr = el('tr', {});
    tr.appendChild(el('td', {}, row.name));
    tr.appendChild(el('td', {}, row.slug ? el('code', {}, row.slug) : el('span', { class: 'muted' }, '—')));
    tr.appendChild(el('td', {}, wrBuildRevisionCell(row)));
    tr.appendChild(el('td', {}, wrBuildUpdatedCell(row)));
    tr.appendChild(el('td', {}, wrBuildActionsCell(row)));
    tbody.appendChild(tr);
  }
}

function wrBuildRevisionCell(row) {
  if (row.revisionNumber == null) {
    const reason = row.checkError === 'no-slug' ? 'No Nexus id on record'
      : row.checkError === 'no-revisions' ? 'No revisions found'
      : row.checkError ? "Couldn't check"
      : 'Not checked yet';
    return el('span', { class: 'status-pill status-pill--neutral' }, reason);
  }
  const published = row.revisionStatus === 'published';
  const children = [
    document.createTextNode(`${row.revisionNumber} `),
    el('span', { class: `status-pill ${published ? 'status-pill--success' : 'status-pill--warning'}` }, published ? 'published' : 'draft'),
  ];
  // The concrete answer to "there is nothing on the page that says hey Rev 2 is available"
  // (2026-08-24, workshop-report-real-staleness-check) -- reuses status-pill--info verbatim, the
  // same class this app already uses elsewhere for an informational badge, no new CSS. Only ever
  // true for an already-fetched row with a real, updatedAt-based staleness signal -- see
  // web/workshop-report-routes.js's own comment on why this can't just compare revisionNumber.
  if (row.updateAvailable) {
    children.push(document.createTextNode(' '));
    children.push(el('span', { class: 'status-pill status-pill--info' }, '🆕 Update available'));
  }
  return el('span', {}, children);
}

function wrBuildUpdatedCell(row) {
  if (!row.updatedAt) return el('span', { class: 'muted' }, '—');
  const abs = new Date(row.updatedAt).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
  return el('div', {}, [
    el('div', {}, abs),
    el('div', { class: 'muted', style: 'font-size:12px;margin-top:1px' }, wrRelativeTime(row.updatedAt)),
  ]);
}

function wrBuildActionsCell(row) {
  const actions = el('div', { class: 'row-actions row-actions--left' });
  if (row.fetched) {
    // btn--primary (blue) -- this was bare `.btn`, which has no background/color of its own and
    // fell through to an unstyled browser-default button. Matches this app's other primary row
    // actions (e.g. Rebuild Missing Files' own "Extract from Archive").
    const openBtn = el('button', { class: 'btn btn--primary btn--small' }, '📂 Open Staging Folder');
    openBtn.addEventListener('click', () => wrOpenStagingFolder(row));
    actions.appendChild(openBtn);
    // Real gap this fixed (queue: workshop-report-classic-and-refetch): the report could show a
    // NEWER revisionNumber straight from Nexus (wrBuildRevisionCell, right next to this) for a row
    // that's already fetched, but there was categorically no action to actually pull it -- only
    // "not yet downloaded" rows ever got a fetch button. That first pass showed this button for
    // EVERY fetched row with a slug regardless of whether an update actually existed -- the
    // director's own real complaint ("everything basically now has an Update from Nexus button,
    // but the button should only show if there really is an update"). Now gated on the real
    // staleness signal (2026-08-24, workshop-report-real-staleness-check): row.updateAvailable,
    // computed server-side by comparing against workshop-report-fetch-state.js's own tracker of
    // what was actually fetched last time (see web/workshop-report-routes.js's own comment for why
    // that comparison is on updatedAt, never revisionNumber alone). Reuses the exact same
    // wrDoFetchFromNexus call the first-fetch button already uses (same route, same
    // backup-before-overwrite write, same in-place row update) -- no further server change needed
    // for this half beyond the gate. No slug on a fetched row shouldn't happen in practice (a slug
    // is how it got fetched in the first place), but if it ever does, this just omits the button,
    // same tolerance the not-fetched branch below already applies for a missing slug.
    if (row.slug && row.updateAvailable) {
      const updateBtn = el('button', { class: 'btn btn--ghost btn--small' }, '🔄 Update from Nexus');
      updateBtn.addEventListener('click', () => wrFetchFromNexus(row, updateBtn));
      actions.appendChild(updateBtn);
    }
  } else if (row.slug) {
    // Real bug this fixes (queue: workshop-report-fetch-button): a Workshop collection Vortex
    // tracks but that's never been fetched has no local collection.json, so Merge Plugins' own
    // picker (scanStagingCollections) can never see it -- confirmed via code read, not guessed.
    // Reuses Rebuild Missing Files' OWN first-fetch action (POST /refresh-from-nexus, same route,
    // same always-newest-revision resolution) rather than a new fetch implementation. No slug, no
    // button -- nothing to fetch without a Nexus id on record.
    const fetchBtn = el('button', { class: 'btn btn--primary btn--small' }, '⬇ Fetch from Nexus');
    fetchBtn.addEventListener('click', () => wrFetchFromNexus(row, fetchBtn));
    actions.appendChild(fetchBtn);
  } else {
    actions.appendChild(el('span', { class: 'muted', style: 'font-size:12.5px' }, 'Not downloaded yet'));
  }
  if (row.slug) {
    const viewBtn = el('button', { class: 'btn btn--ghost btn--small' }, 'View on Nexus');
    viewBtn.addEventListener('click', () => {
      window.open(nexusCollectionUrl(row.slug, row.revisionNumber || undefined), '_blank');
    });
    actions.appendChild(viewBtn);
  }
  return actions;
}

// ---------- Fetch from Nexus (first-fetch AND re-fetch/update -- both call the same core) ----------

// Core network call + row mutation + re-render, with NO UI chrome of its own (no button state, no
// banners) -- both wrFetchFromNexus (the per-row button) and wrUpdateAllFromNexus (the bulk action
// below) call this same function, so the actual fetch/update logic is one real implementation, not
// two that could drift. Each caller owns its own feedback instead: a single-row click gets its own
// "Fetched!" banner immediately; a bulk run collects results across every row first and shows one
// aggregate summary at the end, so N sequential per-row banners don't flash-and-overwrite each other.
// Returns { ok, error? } -- never throws.
async function wrDoFetchFromNexus(row) {
  try {
    await wrApi('POST', '/api/rebuild-missing/refresh-from-nexus', {
      collectionModId: row.collectionModId, slug: row.slug,
    });
    // Update this ONE row in place -- no full Check Nexus for updates re-run needed, per the
    // queue instruction. refreshCollectionFromNexus's own result has revisionNumber but NOT
    // revisionStatus/updatedAt (those come from fetchCollectionRevisions, a separate call this
    // route never makes) -- rather than show a half-right, possibly-wrong draft/published pill,
    // leave revision info as "not checked yet" until the next real Check Nexus for updates.
    // updateAvailable flips to false immediately (2026-08-24, workshop-report-real-staleness-check)
    // -- this collection is, by definition, now current as of the revision just fetched, so the
    // badge/button must clear right away rather than waiting for the next full check.
    Object.assign(row, {
      fetched: true, revisionNumber: null, revisionStatus: null, updatedAt: null, checkError: null,
      updateAvailable: false,
    });
    wrRenderRows(wrCurrentRows);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e };
  }
}

async function wrFetchFromNexus(row, btn) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Fetching…';
  $g('wrCriticalError').classList.add('hidden');
  $g('wrFetchResult').classList.add('hidden');
  const { ok, error } = await wrDoFetchFromNexus(row);
  if (!ok) {
    btn.disabled = false;
    btn.textContent = original;
    wrHandleError(error, $g('wrCriticalError'), () => wrFetchFromNexus(row, btn));
    return;
  }
  // Honest, not "done" -- this only wrote collection.json (metadata), same backup-before-
  // overwrite handling as everywhere else this route is called from. No mod files landed in
  // staging yet. Deliberately NOT promising this makes the collection ready for Merge Plugins --
  // confirmed live (queue: workshop-report-fetch-button) that Merge Plugins' own picker
  // (scanStagingCollections) excludes any "vortex_collection_*"-named folder by NAME, regardless
  // of what's inside it, so this fetch alone (or a later Rebuild Missing Files/Rebuild Collection
  // run against the same folder) can't make it Merge-Plugins-visible either -- that's a separate,
  // still-open gap, not something this button claims to solve.
  const resultBox = $g('wrFetchResult');
  resultBox.innerHTML = '';
  const missingFilesName = window.themedToolName ? window.themedToolName('missing-files', 'Rebuild Missing Files') : 'Rebuild Missing Files';
  const rebuildName = window.themedToolName ? window.themedToolName('rebuild', 'Rebuild Collection') : 'Rebuild Collection';
  resultBox.appendChild(document.createTextNode(`Fetched! We grabbed "${row.name}"'s info from Nexus — the mod files themselves aren't in your staging folder yet. Run `));
  resultBox.appendChild(el('strong', {}, missingFilesName));
  resultBox.appendChild(document.createTextNode(' or '));
  resultBox.appendChild(el('strong', {}, rebuildName));
  resultBox.appendChild(document.createTextNode(' next to pull those in.'));
  resultBox.classList.remove('hidden');
}

// ---------- Update all (bulk, only the rows with a real update available) ----------

// Enabled state lives here, called from wrRenderRows so it's always in sync with whatever's
// currently on screen -- a fresh check, a per-row update clearing its own updateAvailable, or this
// bulk action finishing all can each change which rows qualify, and this is the one place that
// re-derives the button's disabled/title state from wrCurrentRows rather than each call site having
// to remember to do it.
function wrRefreshUpdateAllBtnState() {
  const btn = $g('wrUpdateAllBtn');
  const staleCount = wrCurrentRows.filter((r) => r.updateAvailable).length;
  btn.disabled = staleCount === 0;
  btn.title = staleCount === 0 ? 'No updates found yet — run Check Nexus for updates first.' : '';
}

// Sequential, not parallel (queue: workshop-report-real-staleness-check) -- same "one collection at
// a time, not a parallel blast" pacing rule web/workshop-report-routes.js's own header comment
// already establishes for the per-collection revision check, applied here for the same reason
// (avoid hammering Nexus's API with N requests at once). Continues past a single collection's
// failure rather than stopping the whole batch -- the friendlier choice for a batch action, so one
// bad slug/network hiccup doesn't strand every other genuinely-available update; reports a summary
// of exactly what happened rather than pretending everything succeeded.
async function wrUpdateAllFromNexus() {
  const btn = $g('wrUpdateAllBtn');
  const stale = wrCurrentRows.filter((r) => r.updateAvailable);
  if (stale.length === 0) return; // shouldn't be reachable while correctly disabled, but a safe no-op either way
  const originalLabel = btn.textContent;
  btn.disabled = true;
  $g('wrCriticalError').classList.add('hidden');
  $g('wrFetchResult').classList.add('hidden');

  const results = [];
  for (let i = 0; i < stale.length; i++) {
    const row = stale[i];
    btn.textContent = `Updating ${i + 1} of ${stale.length}…`;
    // A throwaway stand-in, not a real DOM button -- wrDoFetchFromNexus's own row update re-renders
    // the WHOLE table after every success, which would leave any real per-row button reference
    // stale by the time the next iteration runs. wrDoFetchFromNexus only ever reads/writes
    // .textContent/.disabled on it, never expects a real DOM node.
    const { ok } = await wrDoFetchFromNexus(row);
    results.push({ name: row.name, ok });
  }

  btn.textContent = originalLabel;
  wrRefreshUpdateAllBtnState();

  const failed = results.filter((r) => !r.ok);
  const resultBox = $g('wrFetchResult');
  resultBox.textContent = failed.length === 0
    ? `Updated all ${results.length} collection${results.length === 1 ? '' : 's'} from Nexus.`
    : `Updated ${results.length - failed.length} of ${results.length} — ${failed.length} failed: ${failed.map((f) => f.name).join(', ')}.`;
  resultBox.classList.remove('hidden');
}
$g('wrUpdateAllBtn').addEventListener('click', wrUpdateAllFromNexus);

// Reuses Rebuild Missing Files' own open-staging-folder route directly rather than a new one
// (queue instruction) -- collectionModId doubles as the staging folder name, same convention
// listPickableCollections/rmfOpenStagingFolder already rely on.
async function wrOpenStagingFolder(row) {
  try {
    await wrApi('POST', '/api/rebuild-missing/open-staging-folder', { targetFolderName: row.collectionModId });
  } catch (e) {
    wrHandleError(e, $g('wrCriticalError'), () => wrOpenStagingFolder(row));
  }
}
