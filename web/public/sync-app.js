'use strict';
// Update Collection UI -- talks only to /api/sync/*. Fully independent of app.js/rebuild-routes.js
// (its own vortex-running banner, its own tiny api() helper) so this area can be worked on without
// touching the already-validated Rebuild Collection code at all.

function $s(id) { return document.getElementById(id); }

function elS(tag, attrs = {}, children = []) {
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

async function syncApi(method, path, body) {
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

function showSyncVortexBanner() { $s('syncVortexBanner').classList.remove('hidden'); }
function hideSyncVortexBanner() { $s('syncVortexBanner').classList.add('hidden'); }
$s('syncVortexRetryBtn').addEventListener('click', () => {
  hideSyncVortexBanner();
  loadSyncCollections();
  loadSyncProfiles();
});
function handleSyncApiError(e) {
  if (e.status === 409 && e.body && e.body.error === 'vortex-running') {
    showSyncVortexBanner();
    return true;
  }
  return false;
}

let syncCollections = [];
let syncBackups = [];

// ---------- Picker ----------

async function loadSyncCollections() {
  try {
    const { collections } = await syncApi('GET', '/api/sync/collections');
    syncCollections = collections;
    const select = $s('syncCollectionSelect');
    select.innerHTML = '';
    if (collections.length === 0) {
      $s('syncCollectionEmpty').textContent = 'No installed collections found.';
      $s('syncCollectionEmpty').classList.remove('hidden');
      return;
    }
    $s('syncCollectionEmpty').classList.add('hidden');
    for (const c of collections) {
      select.appendChild(elS('option', { value: c.modId }, `${c.name} (${c.modCount} mods)`));
    }
  } catch (e) {
    if (!handleSyncApiError(e)) {
      $s('syncCollectionEmpty').textContent = `Error: ${e.message}`;
      $s('syncCollectionEmpty').classList.remove('hidden');
    }
  }
}

async function loadSyncProfiles() {
  try {
    const { profiles } = await syncApi('GET', '/api/sync/profiles');
    const select = $s('syncProfileSelect');
    select.querySelectorAll('option[data-profile]').forEach((o) => o.remove());
    for (const p of profiles) {
      select.appendChild(elS('option', { value: p.profileId, 'data-profile': '1' }, `${p.name} (${p.profileId})`));
    }
  } catch (e) {
    // Non-fatal here -- profiles are only needed for disabled-mod tracking; a vortex-running 409
    // shouldn't block viewing the rest of the picker.
    handleSyncApiError(e);
  }
}

function backupLabel(b) {
  return `${b.collectionName} — ${new Date(b.createdAt).toLocaleString()} (${b.ignored.length} ignored, ${b.disabled.length} disabled)`;
}

async function loadSyncBackups(selectFilePath) {
  const { backups } = await syncApi('GET', '/api/sync/backups');
  syncBackups = backups;
  const select = $s('syncBackupSelect');
  select.innerHTML = '';
  if (backups.length === 0) {
    select.appendChild(elS('option', { value: '' }, 'No backups yet -- create one in step 1'));
    return;
  }
  for (const b of backups) {
    select.appendChild(elS('option', { value: b.filePath }, backupLabel(b)));
  }
  if (selectFilePath) select.value = selectFilePath;
}

function currentSyncBackup() {
  const filePath = $s('syncBackupSelect').value;
  return syncBackups.find((b) => b.filePath === filePath);
}

function renderSyncList(elId, items, textFn) {
  const list = $s(elId);
  list.innerHTML = '';
  for (const item of items) list.appendChild(elS('li', {}, textFn(item)));
}

// ---------- Phase 1: Backup (run BEFORE clicking Update in Vortex) ----------

$s('syncBackupBtn').addEventListener('click', async () => {
  const collectionModId = $s('syncCollectionSelect').value;
  const profileId = $s('syncProfileSelect').value || undefined;
  const statusEl = $s('syncBackupStatus');
  if (!collectionModId) { statusEl.textContent = 'Choose a collection first.'; return; }
  const btn = $s('syncBackupBtn');
  btn.disabled = true;
  statusEl.textContent = 'Backing up…';
  try {
    const result = await syncApi('POST', '/api/sync/backup', { collectionModId, profileId });
    statusEl.textContent = `Done — ${result.ignoredCount} ignored, ${result.disabledCount} disabled mod(s) captured.`;
    $s('syncBackupNextSteps').classList.remove('hidden');
    await loadSyncBackups(result.filePath);
  } catch (e) {
    if (!handleSyncApiError(e)) statusEl.textContent = `Failed: ${e.message}`;
  } finally {
    btn.disabled = false;
  }
});

// ---------- Phase 2: Apply Ignores (run AFTER Vortex Update -> Later, Vortex closed) ----------

$s('syncIgnoresPreviewBtn').addEventListener('click', async () => {
  const modId = $s('syncNewModIdInput').value.trim();
  const backup = currentSyncBackup();
  const statusEl = $s('syncIgnoresStatus');
  if (!modId) { statusEl.textContent = "Enter the new collection's mod id first."; return; }
  if (!backup) { statusEl.textContent = 'Choose a backup first.'; return; }
  statusEl.textContent = 'Checking…';
  $s('syncIgnoresApplyBtn').disabled = true;
  try {
    const result = await syncApi('POST', '/api/sync/apply-ignores/preview', { modId, backupPath: backup.filePath });
    renderSyncList('syncIgnoresList', result.changed, (c) => c.name);
    let text = `DRY RUN — ${result.changed.length} rule(s) would be set to ignored.`;
    if (!result.versionTested) {
      text += ` ⚠ Vortex ${result.vortexVersion ?? 'unknown'} is untested for this tool's live writes -- proceed with extra caution and double-check the result in Vortex afterward.`;
    }
    statusEl.textContent = text;
    $s('syncIgnoresApplyBtn').disabled = false;
  } catch (e) {
    if (!handleSyncApiError(e)) statusEl.textContent = `Failed: ${e.message}`;
  }
});

$s('syncIgnoresApplyBtn').addEventListener('click', async () => {
  const modId = $s('syncNewModIdInput').value.trim();
  const backup = currentSyncBackup();
  const statusEl = $s('syncIgnoresStatus');
  if (!modId || !backup) return;
  const count = $s('syncIgnoresList').children.length;
  if (!confirm(`This writes directly to Vortex's live state database (a full backup is taken first). Set ${count} rule(s) to ignored for "${modId}"?`)) return;
  const btn = $s('syncIgnoresApplyBtn');
  btn.disabled = true;
  statusEl.textContent = "Writing to Vortex's live state…";
  try {
    const result = await syncApi('POST', '/api/sync/apply-ignores/apply', { modId, backupPath: backup.filePath });
    renderSyncList('syncIgnoresList', result.changed, (c) => c.name);
    statusEl.textContent = `Done — ${result.changed.length} rule(s) set to ignored. State backed up to: ${result.backupDir}`;
    $s('syncResumeNextSteps').classList.remove('hidden');
  } catch (e) {
    if (!handleSyncApiError(e)) statusEl.textContent = `Failed: ${e.message}`;
    btn.disabled = false;
  }
});

// ---------- Phase 3: Apply Disables (run AFTER Resume finishes, Vortex closed) ----------

$s('syncDisablesPreviewBtn').addEventListener('click', async () => {
  const backup = currentSyncBackup();
  const statusEl = $s('syncDisablesStatus');
  if (!backup) { statusEl.textContent = 'Choose a backup first.'; return; }
  statusEl.textContent = 'Checking…';
  $s('syncDisablesApplyBtn').disabled = true;
  try {
    const result = await syncApi('POST', '/api/sync/apply-disables/preview', { backupPath: backup.filePath });
    if (result.nothingToDo) {
      renderSyncList('syncDisablesList', [], () => '');
      statusEl.textContent = 'This backup captured no disabled mods — nothing to do.';
      return;
    }
    renderSyncList('syncDisablesList', result.matches, (m) => `${m.matchedRef.name}  [${m.vortexModId}]`);
    let text = `DRY RUN — found ${result.matches.length}/${result.matches.length + result.missing.length} disabled mod(s) now installed.`;
    if (result.missing.length > 0) text += ` ${result.missing.length} not found yet (Resume may still be running, or they weren't part of this revision).`;
    statusEl.textContent = text;
    $s('syncDisablesApplyBtn').disabled = result.matches.length === 0;
  } catch (e) {
    if (!handleSyncApiError(e)) statusEl.textContent = `Failed: ${e.message}`;
  }
});

$s('syncDisablesApplyBtn').addEventListener('click', async () => {
  const backup = currentSyncBackup();
  const statusEl = $s('syncDisablesStatus');
  if (!backup) return;
  if (!backup.profileId) { statusEl.textContent = 'This backup has no profile recorded -- cannot apply disables.'; return; }
  if (!confirm("This writes directly to Vortex's live state database (a full backup is taken first). Set matched mods to disabled?")) return;
  const btn = $s('syncDisablesApplyBtn');
  btn.disabled = true;
  statusEl.textContent = "Writing to Vortex's live state…";
  try {
    const result = await syncApi('POST', '/api/sync/apply-disables/apply', { profileId: backup.profileId, backupPath: backup.filePath });
    renderSyncList('syncDisablesList', result.changed, (c) => `${c.name}  [${c.vortexModId}]`);
    statusEl.textContent = `Done — ${result.changed.length} mod(s) set to disabled. State backed up to: ${result.backupDir}`;
  } catch (e) {
    if (!handleSyncApiError(e)) statusEl.textContent = `Failed: ${e.message}`;
    btn.disabled = false;
  }
});

// ---------- Optional: Compare (pure computation, never touches Vortex's state DB) ----------

$s('syncCompareBtn').addEventListener('click', () => {
  const backup = currentSyncBackup();
  const collectionPath = $s('syncCompareCollectionInput').value.trim();
  if (!backup || !collectionPath) { alert('Choose a backup and enter the new collection.json path first.'); return; }
  const url = `/api/sync/compare/report?backupPath=${encodeURIComponent(backup.filePath)}&collectionPath=${encodeURIComponent(collectionPath)}`;
  window.open(url, '_blank');
});

// ---------- boot ----------

loadSyncCollections();
loadSyncProfiles();
loadSyncBackups();
