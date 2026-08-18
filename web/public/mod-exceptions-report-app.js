'use strict';
// Mod Exceptions (Reports sub-tab) -- view/add/remove the shared "never auto-fix this mod" list
// (lib/mod-exception-store.js, served via web/mod-exceptions-routes.js). Reuses $g/el from
// cleanup-app.js, same "self-contained area, shared tiny helpers" convention as this project's
// other *-app.js files (see workshop-report-app.js's own header for the closest sibling pattern).

async function meApi(method, urlPath, body) {
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

function meHandleError(e, box) {
  if (window.isServerUnreachableError && window.isServerUnreachableError(e)) {
    window.showServerUnreachableError();
    return;
  }
  box.textContent = e.message;
  box.classList.remove('hidden');
}

let meRows = [];

// Deliberately NO load-once gate (queue: rebuild-missing-hand-pick-exceptions, director-confirmed
// live 2026-08-15) -- unlike Workshop Report (loadWorkshopReportPageOnce), whose data only ever
// changes through THAT SAME page's own UI actions and stays in sync via in-place row updates, this
// list can be mutated from a completely different page (Rebuild Missing Files' own per-row "Add to
// Exception List" button, web/public/rebuild-missing-app.js) that has no shared in-memory state with
// this file. A once-only fetch showed stale data on every visit after the first, until a full page
// reload. Matches the SAME "no load-once gate, refresh every time the tab is shown" precedent
// cleanup-app.js already established for Missing Masters (its own comment: "it needs to scan every
// time the tab is shown... not just once ever").
async function refreshModExceptionsReport() {
  // Clears any stale status text from a PREVIOUS visit's Add click -- confirmed this was the real
  // source of the director's own "unrelated stray 'Added ...' message" report: meAddStatus was only
  // ever cleared at the START of a fresh Add click, never on tab entry, so old confirmation text sat
  // there indefinitely and read as if something had just happened on THIS visit when it hadn't.
  $g('meAddStatus').textContent = '';
  $g('meCriticalError').classList.add('hidden');
  try {
    const data = await meApi('GET', '/api/mod-exceptions');
    if (!data.configured) {
      const meName = window.themedToolName ? window.themedToolName('report-exceptions', 'Mod Exceptions') : 'Mod Exceptions';
      const rebuildName = window.themedToolName ? window.themedToolName('rebuild', 'Rebuild Collection') : 'Rebuild Collection';
      $g('meNotConfigured').textContent = `Set a folder for the ${meName} list under Settings > ${rebuildName} first.`;
      $g('meNotConfigured').classList.remove('hidden');
    } else {
      $g('meNotConfigured').classList.add('hidden');
    }
    meRows = data.mods || [];
    meRenderRows();
  } catch (e) {
    meHandleError(e, $g('meCriticalError'));
  }
}

// Same skyrimspecialedition-domain, plain-mod-page-only convention already confirmed for this
// project's other Nexus mod-page link (web/rebuild-routes.js's own nexusModUrl, the standalone Log
// View report) -- this toolkit is SSE-only, and the mod's own description page is what's wanted,
// not a ?tab=files deep link. No shared CLIENT-side helper existed for this (only
// nexusCollectionUrl, a different URL shape, and that server-side one in a different file/context),
// so this is the same one-line URL built inline here, not a new cross-file abstraction for a single
// string.
function nexusModUrl(modId) {
  return `https://www.nexusmods.com/skyrimspecialedition/mods/${modId}`;
}

function meRenderRows() {
  const nothingToShow = meRows.length === 0;
  $g('meEmpty').classList.toggle('hidden', !nothingToShow);
  $g('meTableWrap').classList.toggle('hidden', nothingToShow);
  if (nothingToShow) return;

  const sorted = [...meRows].sort((a, b) => a.name.localeCompare(b.name));
  const tbody = $g('meRows');
  tbody.innerHTML = '';
  for (const mod of sorted) {
    const tr = el('tr', {});
    tr.appendChild(el('td', {}, mod.name));
    tr.appendChild(el('td', {}, mod.modId != null ? String(mod.modId) : el('span', { class: 'muted' }, '—')));
    tr.appendChild(el('td', { class: 'muted' }, mod.addedAt ? new Date(mod.addedAt).toLocaleDateString() : '—'));
    const actions = el('td', { class: 'row-actions' });
    // Same conditional-on-modId pattern Workshop Report's own View on Nexus action already uses --
    // an off-site mod (no modId recorded) gets no link at all, nothing to point it at.
    if (mod.modId != null) {
      const viewBtn = el('button', { class: 'btn btn--ghost btn--small' }, 'View on Nexus');
      viewBtn.addEventListener('click', () => window.open(nexusModUrl(mod.modId), '_blank'));
      actions.appendChild(viewBtn);
    }
    const removeBtn = el('button', { class: 'btn btn--ghost btn--small' }, 'Remove');
    removeBtn.addEventListener('click', () => meRemove(mod, removeBtn));
    actions.appendChild(removeBtn);
    tr.appendChild(actions);
    tbody.appendChild(tr);
  }
}

$g('meAddBtn').addEventListener('click', async () => {
  const name = $g('meAddNameInput').value.trim();
  const modIdRaw = $g('meAddModIdInput').value.trim();
  $g('meAddStatus').textContent = '';
  $g('meCriticalError').classList.add('hidden');
  if (!name) {
    $g('meAddStatus').textContent = 'Enter a mod name first.';
    return;
  }
  const btn = $g('meAddBtn');
  btn.disabled = true;
  try {
    const data = await meApi('POST', '/api/mod-exceptions/add', { name, modId: modIdRaw ? Number(modIdRaw) : null });
    meRows = data.mods || [];
    meRenderRows();
    $g('meAddNameInput').value = '';
    $g('meAddModIdInput').value = '';
    $g('meAddStatus').textContent = `Added "${name}".`;
  } catch (e) {
    meHandleError(e, $g('meCriticalError'));
  } finally {
    btn.disabled = false;
  }
});

async function meRemove(mod, btn) {
  btn.disabled = true;
  try {
    const data = await meApi('POST', '/api/mod-exceptions/remove', { name: mod.name });
    meRows = data.mods || [];
    meRenderRows();
  } catch (e) {
    btn.disabled = false;
    meHandleError(e, $g('meCriticalError'));
  }
}
