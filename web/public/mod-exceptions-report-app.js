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

let mePageLoaded = false;
async function loadModExceptionsReportPageOnce() {
  if (mePageLoaded) return;
  mePageLoaded = true;
  await meLoad();
}

async function meLoad() {
  try {
    const data = await meApi('GET', '/api/mod-exceptions');
    if (!data.configured) {
      $g('meNotConfigured').textContent = 'Set a folder for the Mod Exceptions list under Settings > Rebuild Collection first.';
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
    const removeBtn = el('button', { class: 'btn btn--ghost btn--small' }, 'Remove');
    removeBtn.addEventListener('click', () => meRemove(mod, removeBtn));
    tr.appendChild(el('td', {}, removeBtn));
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
