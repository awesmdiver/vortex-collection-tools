'use strict';
// Duplicate Version Cleanup (Utilities sub-tab, 2026-09-01) -- built against the approved
// design/mockup-duplicate-version-cleanup.html. Reuses $g/el from cleanup-app.js, same
// "self-contained area, shared tiny helpers" convention every other *-app.js file here follows.
// Backend: lib/duplicate-version-cleanup.js (detection + the 8-step remove/redownload/reinstall/
// reassign recipe) via web/duplicate-version-cleanup-routes.js. See
// design/SPEC-duplicate-version-cleanup-tool.md and
// diagnostics/2026-09-01-duplicate-download-persistence-investigation.md for the full "why".

const DVC_STEPS = ['Scan', 'Review', 'Clean'];

const dvcState = {
  groups: [], // Map-like lookup by id -- see dvcGroupById below
  selected: new Set(), // group.id
  eventSource: null,
  picked: new Set(), // Screen 1's own scope picker -- collectionModId
  collectionsById: new Map(), // collectionModId -> { name, modCount }
};

async function dvcApi(method, path, body) {
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

function escHtmlDvc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function dvcHandleError(e) {
  if (window.isServerUnreachableError && window.isServerUnreachableError(e)) {
    window.showServerUnreachableError();
    return;
  }
  const box = $g('dvcCriticalError');
  const title = (e.body && e.body.error === 'helper-unavailable') ? '🛑 Vortex Connection Required'
    : (e.body && e.body.error === 'not-configured') ? '🛑 Setup Required'
      : '🛑 Something Went Wrong';
  box.innerHTML = `<div class="callout__title">${escHtmlDvc(title)}</div><p>${escHtmlDvc(e.message)}</p>`;
  box.classList.remove('hidden');
}
function dvcHideCriticalError() { $g('dvcCriticalError').classList.add('hidden'); }

function dvcRenderStepper(activeIdx) {
  $g('dvcStepper').innerHTML = DVC_STEPS.map((label, i) => {
    const cls = i < activeIdx ? 'done' : i === activeIdx ? 'active' : '';
    const num = i < activeIdx ? '✓' : String(i + 1);
    return `<div class="merge-step ${cls}"><b>${num}</b>${label}</div>`;
  }).join('');
}

function dvcGoScreen(id, stepIdx) {
  ['dvcScreen1', 'dvcScreen2', 'dvcScreen3'].forEach((s) => $g(s).classList.toggle('hidden', s !== id));
  dvcRenderStepper(stepIdx);
  window.scrollTo(0, 0);
}

function dvcGroupById(id) {
  return dvcState.groups.find((g) => g.id === id);
}

// A group is only bulk-selectable when it has at least one real orphan entry -- a group whose only
// non-survivor entries are all 'legit' (flagged) has nothing this action would actually touch.
function dvcSelectableIds() {
  return dvcState.groups.filter((g) => g.removable.some((r) => r.kind === 'orphan')).map((g) => g.id);
}

function dvcVersionCellHtml(g) {
  return g.removable.map((r) => (r.kind === 'legit'
    ? `<span class="status-pill status-pill--version-flagged" title="${escHtmlDvc(r.note)}">⚠ ${escHtmlDvc(r.version)}</span>`
    : `<span class="status-pill status-pill--version">${escHtmlDvc(r.version)}</span>`)).join('');
}

function dvcRowHtml(g) {
  const checked = dvcState.selected.has(g.id);
  return `<tr class="${checked ? 'selected' : ''}">
    <td><input type="checkbox" data-id="${escHtmlDvc(g.id)}" ${checked ? 'checked' : ''} ${g.removable.every((r) => r.kind !== 'orphan') ? 'disabled' : ''}></td>
    <td class="mod-name-cell" title="${escHtmlDvc(g.mod)}">${escHtmlDvc(g.mod)}</td>
    <td>${dvcVersionCellHtml(g)}</td>
    <td class="collections-cell">${g.collections.map((c) => `<div>${escHtmlDvc(c)}</div>`).join('') || '<div class="muted">(none)</div>'}</td>
  </tr>`;
}

function dvcRenderGroups() {
  $g('dvcGroupsTbody').innerHTML = dvcState.groups.map(dvcRowHtml).join('');
  document.querySelectorAll('#dvcGroupsTbody input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener('change', () => {
      if (cb.checked) dvcState.selected.add(cb.dataset.id); else dvcState.selected.delete(cb.dataset.id);
      cb.closest('tr').classList.toggle('selected', cb.checked);
      dvcUpdateCount();
    });
  });
  const all = dvcSelectableIds();
  $g('dvcGroupsHeaderCb').checked = all.length > 0 && all.every((id) => dvcState.selected.has(id));
}

function dvcUpdateCount() {
  const total = dvcSelectableIds().length;
  $g('dvcSelCount').textContent = `${dvcState.selected.size} of ${total} selected`;
  $g('dvcCleanBtn').textContent = `Clean up ${dvcState.selected.size} mod${dvcState.selected.size === 1 ? '' : 's'} →`;
  $g('dvcCleanBtn').disabled = dvcState.selected.size === 0;
  $g('dvcGroupsHeaderCb').checked = total > 0 && dvcState.selected.size === total;
  $g('dvcReviewTitle').textContent = `${dvcState.groups.length} duplicate group${dvcState.groups.length === 1 ? '' : 's'} found`;
}

$g('dvcGroupsHeaderCb').addEventListener('change', (e) => {
  dvcState.selected = e.target.checked ? new Set(dvcSelectableIds()) : new Set();
  dvcRenderGroups(); dvcUpdateCount();
});
$g('dvcSelectAllBtn').addEventListener('click', () => {
  dvcState.selected = new Set(dvcSelectableIds());
  dvcRenderGroups(); dvcUpdateCount();
});
$g('dvcClearBtn').addEventListener('click', () => {
  dvcState.selected.clear();
  dvcRenderGroups(); dvcUpdateCount();
});
$g('dvcInvertBtn').addEventListener('click', () => {
  const all = dvcSelectableIds();
  dvcState.selected = new Set(all.filter((id) => !dvcState.selected.has(id)));
  dvcRenderGroups(); dvcUpdateCount();
});

// ---------- Screen 1: collection picker + scan ----------

// Real checkbox picker (2026-09-01), ported from Rebuild Missing Files' own
// rmfRenderPickerGroup/rmfUpdatePickCount (web/public/rebuild-missing-app.js) -- same
// .coll-card/.picker-grid component and cart-bar pattern, not a new one-off. Two real differences
// from that source: no per-card "last checked/fixed" sub-line (this tool has no equivalent state to
// show), and the Scan button is NEVER disabled at zero picked -- see dvcUpdatePickCount below.

let dvcCartTagsOpen = false;

function dvcRenderPickerGroup(sectionId, gridId, countId, items, countText) {
  $g(sectionId).classList.toggle('hidden', items.length === 0);
  if (items.length === 0) return;
  $g(countId).textContent = countText;
  const grid = $g(gridId);
  grid.innerHTML = '';
  for (const item of items) {
    dvcState.collectionsById.set(item.modId, item);
    const checkbox = el('input', { type: 'checkbox', 'data-mod-id': item.modId });
    checkbox.checked = dvcState.picked.has(item.modId);
    const subLine = el('div', { class: 'sub' }, `${item.modCount} mod${item.modCount === 1 ? '' : 's'}`);
    const card = el('label', { class: `coll-card${checkbox.checked ? ' sel' : ''}` }, [
      checkbox,
      el('div', { class: 'meta' }, [el('div', { class: 'name' }, item.name), subLine]),
    ]);
    checkbox.addEventListener('change', () => {
      card.classList.toggle('sel', checkbox.checked);
      if (checkbox.checked) dvcState.picked.add(item.modId);
      else dvcState.picked.delete(item.modId);
      dvcUpdatePickCount();
    });
    grid.appendChild(card);
  }
}

function dvcUpdatePickCount() {
  const n = dvcState.picked.size;
  $g('dvcPickCountNum').textContent = String(n);
  $g('dvcPickCountPlural').textContent = n === 1 ? '' : 's';

  const toggleBtn = $g('dvcCartToggleBtn');
  toggleBtn.hidden = n === 0;
  if (n === 0) dvcCartTagsOpen = false;

  const tagList = $g('dvcCartTagList');
  tagList.classList.toggle('open', dvcCartTagsOpen);
  tagList.innerHTML = '';
  for (const id of dvcState.picked) {
    const name = dvcState.collectionsById.get(id)?.name || id;
    const tag = el('span', { class: 'rmf-cartbar__tag' }, [name]);
    const removeBtn = el('button', { title: 'Remove' }, '×');
    removeBtn.addEventListener('click', () => {
      dvcState.picked.delete(id);
      const checkbox = document.querySelector(`.coll-card input[type="checkbox"][data-mod-id="${id}"]`);
      if (checkbox) { checkbox.checked = false; checkbox.closest('.coll-card').classList.remove('sel'); }
      dvcUpdatePickCount();
    });
    tag.appendChild(removeBtn);
    tagList.appendChild(tag);
  }
}
$g('dvcCartToggleBtn').addEventListener('click', () => {
  dvcCartTagsOpen = !dvcCartTagsOpen;
  dvcUpdatePickCount();
});

async function dvcLoadCollections() {
  $g('dvcPickerLoading').classList.remove('hidden');
  try {
    const data = await dvcApi('GET', '/api/duplicate-version-cleanup/collections');
    dvcRenderPickerGroup('dvcInstalledSection', 'dvcInstalledGrid', 'dvcInstalledCount', data.installed || [], `${(data.installed || []).length} found`);
    dvcRenderPickerGroup('dvcWorkshopSection', 'dvcWorkshopGrid', 'dvcWorkshopCount', data.workshop || [], "collections you're authoring, not installed");
  } catch (e) {
    // Best-effort only -- the picker just stays empty if this fails; a whole-install scan still
    // works fine with nothing checked.
  } finally {
    $g('dvcPickerLoading').classList.add('hidden');
  }
}

$g('dvcScanBtn').addEventListener('click', dvcStartScan);
async function dvcStartScan() {
  dvcHideCriticalError();
  $g('dvcScanningState').style.display = '';
  $g('dvcScanBtn').disabled = true;
  const collectionModIds = [...dvcState.picked];
  try {
    const { groups } = await dvcApi('POST', '/api/duplicate-version-cleanup/scan', { collectionModIds });
    dvcState.groups = groups;
    // Every group with at least one plain orphan is pre-checked -- a flagged-only group starts
    // unchecked, since there's nothing in it this bulk action would touch anyway.
    dvcState.selected = new Set(dvcSelectableIds());
    dvcRenderGroups();
    dvcUpdateCount();
    if (groups.length === 0) {
      dvcState.selected.clear();
      $g('dvcReviewTitle').textContent = 'No duplicate versions found';
    }
    dvcGoScreen('dvcScreen2', 1);
  } catch (e) {
    dvcHandleError(e);
  } finally {
    $g('dvcScanningState').style.display = 'none';
    $g('dvcScanBtn').disabled = false;
  }
}

$g('dvcBackBtn').addEventListener('click', () => dvcGoScreen('dvcScreen1', 0));

// Confirm modal removed (2026-09-01, director's own direct ask -- it was broken, checking the box
// and clicking Clean up never dismissed it) -- Clean up now goes straight to the clean step. If a
// real confirm step is wanted back later, it needs to actually close on click, unlike this one.
$g('dvcCleanBtn').addEventListener('click', () => {
  dvcStartClean();
});

// ---------- Screen 3: clean (progress, then result) ----------

async function dvcStartClean() {
  dvcGoScreen('dvcScreen3', 2);
  $g('dvcCleanProgress').style.display = '';
  $g('dvcCleanResult').classList.add('hidden');
  $g('dvcCleanBar').style.width = '0%';
  $g('dvcCleanPhaseText').textContent = 'Starting…';
  $g('dvcCleanRowsContainer').innerHTML = '';
  const cancelBtn = $g('dvcCancelCleanBtn');
  cancelBtn.disabled = true;
  cancelBtn.textContent = 'Cancel';

  const selections = [...dvcState.selected].map((id) => {
    const g = dvcGroupById(id);
    return { modId: g.modId, installedVortexModId: g.installedVortexModId };
  });

  try {
    await dvcApi('POST', '/api/duplicate-version-cleanup/clean', { selections });
  } catch (e) {
    $g('dvcCleanProgress').style.display = 'none';
    dvcHandleError(e);
    dvcGoScreen('dvcScreen2', 1);
    return;
  }

  if (dvcState.eventSource) dvcState.eventSource.close();
  const es = new EventSource('/api/duplicate-version-cleanup/clean/events');
  dvcState.eventSource = es;
  es.onmessage = (msg) => dvcHandleCleanEvent(JSON.parse(msg.data));
}

function dvcRowLine(name, ok, error, skipped) {
  const div = document.createElement('div');
  div.className = 'apply-row';
  const icon = skipped ? '↷' : ok ? '✓' : '✗';
  div.innerHTML = `<div><div class="apply-row__name">${icon} ${escHtmlDvc(name)}</div>`
    + (error ? `<div class="apply-row__step">${escHtmlDvc(error)}</div>` : '') + '</div>';
  return div;
}

function dvcHandleCleanEvent(frame) {
  if (frame.type === 'cancellable') {
    $g('dvcCancelCleanBtn').disabled = false;
  } else if (frame.type === 'group-start') {
    $g('dvcCleanPhaseText').textContent = `Group ${frame.index} of ${frame.total} — ${frame.name}`;
    $g('dvcCleanBar').style.width = `${Math.round(((frame.index - 1) / frame.total) * 100)}%`;
  } else if (frame.type === 'group-phase') {
    const phaseLabel = { capturing: 'Checking what needs to survive…', removing: 'Removing old entries…', downloading: 'Downloading…', reinstalling: 'Reinstalling…', registering: 'Registering with Vortex…', reassigning: 'Reassigning to collections…' }[frame.phase] || frame.phase;
    $g('dvcCleanPhaseText').textContent = `Group ${frame.index} of ${frame.total} — ${frame.name}: ${phaseLabel}`;
  } else if (frame.type === 'group-complete') {
    $g('dvcCleanBar').style.width = `${Math.round((frame.index / frame.total) * 100)}%`;
    $g('dvcCleanRowsContainer').appendChild(dvcRowLine(frame.name, frame.ok, frame.error, frame.skipped));
    if (frame.refusedOrphans && frame.refusedOrphans.length > 0) {
      for (const r of frame.refusedOrphans) {
        const div = document.createElement('div');
        div.className = 'apply-row__step';
        div.style.marginLeft = '16px';
        div.textContent = `⚠ Kept one orphaned entry untouched: ${r.reason}`;
        $g('dvcCleanRowsContainer').appendChild(div);
      }
    }
  } else if (frame.type === 'clean-complete') {
    if (dvcState.eventSource) { dvcState.eventSource.close(); dvcState.eventSource = null; }
    dvcRenderCleanResult(frame.results, frame.cancelled, frame.totalSelected);
  } else if (frame.type === 'clean-error') {
    if (dvcState.eventSource) { dvcState.eventSource.close(); dvcState.eventSource = null; }
    $g('dvcCleanProgress').style.display = 'none';
    dvcHandleError(new Error(frame.message || 'The cleanup failed.'));
    dvcGoScreen('dvcScreen2', 1);
  }
}

function dvcRenderCleanResult(results, cancelled, totalSelected) {
  $g('dvcCleanProgress').style.display = 'none';
  $g('dvcCleanResult').classList.remove('hidden');
  const okCount = results.filter((r) => r.ok && !r.skipped).length;
  const skippedCount = results.filter((r) => r.skipped).length;
  const failedCount = results.filter((r) => !r.ok).length;
  const neverAttempted = cancelled && typeof totalSelected === 'number' ? totalSelected - results.length : 0;
  const callout = $g('dvcCleanResultCallout');
  const title = $g('dvcCleanResultTitle');
  const body = $g('dvcCleanResultBody');
  if (cancelled) {
    // A cancelled run is a real, honest partial success, not a failure -- whatever groups already
    // finished before this landed genuinely stayed cleaned up (their Helper writes already happened
    // and can't be un-sent), same reasoning clear-update-flags-app.js's own cancelled branch uses.
    callout.className = 'callout callout--warning';
    title.textContent = `⚠️ Cancelled — ${okCount} of ${totalSelected} group${totalSelected === 1 ? '' : 's'} cleaned up`;
    body.textContent = `You cancelled before the rest were processed. The ${okCount} group${okCount === 1 ? '' : 's'} already cleaned up ${okCount === 1 ? 'is' : 'are'} genuinely done — cancelling doesn't undo that. `
      + `${neverAttempted} group${neverAttempted === 1 ? '' : 's'} never got started — re-scan and select them again anytime.`
      + (failedCount > 0 ? ` ${failedCount} had a problem before the cancel landed.` : '');
  } else if (failedCount === 0) {
    callout.className = 'callout callout--success';
    title.textContent = `🎉 ${okCount} duplicate group${okCount === 1 ? '' : 's'} cleaned up`;
    body.textContent = 'Each mod now shows just the one real, installed version — reassigned back to every collection it belonged to.'
      + (skippedCount > 0 ? ` ${skippedCount} group${skippedCount === 1 ? '' : 's'} had nothing left to do and ${skippedCount === 1 ? 'was' : 'were'} skipped.` : '');
  } else {
    callout.className = 'callout callout--warning';
    title.textContent = `⚠️ Cleaned up ${okCount} of ${results.length}, ${failedCount} had a problem`;
    body.textContent = 'Scroll up to see exactly which mod failed and why. Nothing else was touched — re-scan and try again for the ones that failed.';
  }
}

$g('dvcCancelCleanBtn').addEventListener('click', async () => {
  const btn = $g('dvcCancelCleanBtn');
  btn.textContent = 'Stopping after this group finishes…';
  btn.disabled = true;
  try {
    await dvcApi('POST', '/api/duplicate-version-cleanup/clean/cancel', {});
  } catch (e) {
    // Already finished or already gone -- the stream's own 'clean-complete' event resolves the UI
    // either way, same as clear-update-flags-app.js's own cancel handler.
  }
});

$g('dvcDoneBtn').addEventListener('click', () => {
  dvcState.selected.clear();
  dvcGoScreen('dvcScreen1', 0);
});

// ---------- Deploy Mods (final step, not in the original mockup -- see prompts/handoff-latest.md) ----------

$g('dvcDeployBtn').addEventListener('click', dvcStartDeploy);
async function dvcStartDeploy() {
  $g('dvcDeployBtn').disabled = true;
  $g('dvcDeployBtn').textContent = 'Deploying…';
  $g('dvcDeployStatus').textContent = '';
  try {
    await dvcApi('POST', '/api/duplicate-version-cleanup/deploy-all', {});
    const poll = async () => {
      const progress = await dvcApi('GET', '/api/duplicate-version-cleanup/deploy-all/progress');
      if (progress.unknown || progress.done) {
        $g('dvcDeployBtn').textContent = 'Deploy Mods';
        $g('dvcDeployBtn').disabled = false;
        $g('dvcDeployStatus').textContent = progress.error ? `Deploy reported an issue: ${progress.error}` : 'Deployed ✓';
        return;
      }
      $g('dvcDeployStatus').textContent = progress.text || 'Deploying…';
      setTimeout(poll, 1000);
    };
    setTimeout(poll, 500);
  } catch (e) {
    $g('dvcDeployBtn').textContent = 'Deploy Mods';
    $g('dvcDeployBtn').disabled = false;
    dvcHandleError(e);
  }
}

// ---------- Reset-on-entry (same seam every other Utilities sub-tab uses, see cleanup-app.js) ----------

function dvcResetOnEntry() {
  if (dvcState.eventSource) { dvcState.eventSource.close(); dvcState.eventSource = null; }
  dvcState.groups = [];
  dvcState.selected.clear();
  dvcState.picked.clear();
  dvcHideCriticalError();
  $g('dvcScanningState').style.display = 'none';
  dvcGoScreen('dvcScreen1', 0);
  dvcUpdatePickCount();
  dvcLoadCollections();
}
window.dvcResetOnEntry = dvcResetOnEntry;

dvcRenderStepper(0);
