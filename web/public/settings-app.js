'use strict';
// Settings UI -- talks only to /api/settings. Fully independent of app.js/sync-app.js, same
// convention as sync-app.js's own header comment: its own tiny $/api helpers so this area can be
// worked on without touching the already-validated Rebuild/Update Collection code at all.

function $g(id) { return document.getElementById(id); }

// Declared up top (not near its listeners further down) so loadSettings()'s own reset of it can
// never run into a temporal-dead-zone ordering question -- see the "Unsaved-changes navigation
// guard" section below for how this is tracked and used.
let settingsDirty = false;

// Fields with no valid blank state -- Rebuild Collection can't scan a collection without
// staging/downloads, and Update Collection can't save a backup without somewhere real to put it.
// backupRoot/state are deliberately excluded: backupRoot only matters if backups are turned on
// (off by default), and state auto-detects a real default.
const REQUIRED_FIELDS = [
  { key: 'staging', inputId: 'settingsStagingInput', label: 'Vortex staging folder' },
  { key: 'downloads', inputId: 'settingsDownloadsInput', label: 'Vortex downloads folder' },
  { key: 'syncBackupRoot', inputId: 'settingsSyncBackupRootInput', label: 'Backups folder (Update Collection)' },
  { key: 'cleanupExcludeListDir', inputId: 'settingsCleanupExcludeListDirInput', label: 'Exclude list location (Vortex Scrub)' },
  { key: 'skyrimDataDir', inputId: 'settingsSkyrimDataDirInput', label: 'Skyrim Data folder (Missing Masters)' },
  { key: 'pluginsListDir', inputId: 'settingsPluginsListDirInput', label: 'Plugins.txt location (Missing Masters)' },
  { key: 'dummyMastersOutputDir', inputId: 'settingsDummyMastersOutputDirInput', label: 'Dummy Masters output folder (Missing Masters)' },
  { key: 'archiveFinderDbDir', inputId: 'settingsArchiveFinderDbDirInput', label: 'Archive Finder database folder' },
];

async function settingsApi(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `Request failed (${res.status})`);
  return data;
}

// This page has no Vortex-running concerns of its own (Settings never touches Vortex's state DB),
// so unlike app.js's/sync-app.js's own handleApiError/handleSyncApiError, the only thing this
// checks for is the server being fully unreachable -- same shared shell.js modal either way.
function handleSettingsApiError(e, retryFn) {
  if (isServerUnreachableError(e)) {
    showServerUnreachableError(retryFn);
    return true;
  }
  return false;
}

// ---------- Theme ----------
// 'system' (default) means no explicit override -- styles.css follows the OS/browser's own
// prefers-color-scheme media query in that case. index.html's inline bootstrap script applies
// whatever was already stored here before first paint, so this only needs to handle live changes
// made from this page itself.
function applyTheme(theme) {
  if (theme === 'dark' || theme === 'light') {
    document.documentElement.setAttribute('data-theme', theme);
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
}

const themeSelect = $g('settingsThemeSelect');
themeSelect.value = localStorage.getItem('theme') || 'system';
themeSelect.addEventListener('change', () => {
  const theme = themeSelect.value;
  localStorage.setItem('theme', theme);
  applyTheme(theme);
});

// ---------- Two-pane category layout + rail pinning ----------
// See DESIGN.md's "Settings -- two-pane category layout" and "Pinning" sections. Every field stays
// in the DOM at all times -- switching category (or pinning a rail row) only ever toggles which
// .settings-pane is visible / moves a .settings-rail__row between the rail and its Pinned group.
// Nothing here touches loadSettings()/saveSettings() below; those already read/write every field
// regardless of which pane happens to be showing.
const SETTINGS_CATEGORY_ORDER = ['rebuild', 'update', 'missing', 'scrub', 'archive', 'paths', 'general'];
const SETTINGS_LAST_CATEGORY_KEY = 'settingsLastCategory';
const SETTINGS_PINNED_KEY = 'settingsPinnedCategories';

function loadPinnedCategories() {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_PINNED_KEY) || '[]');
    return new Set(Array.isArray(raw) ? raw : []);
  } catch {
    return new Set();
  }
}
const pinnedCategories = loadPinnedCategories();
function savePinnedCategories() {
  localStorage.setItem(SETTINGS_PINNED_KEY, JSON.stringify(Array.from(pinnedCategories)));
}

function showSettingsCategory(cat) {
  localStorage.setItem(SETTINGS_LAST_CATEGORY_KEY, cat);
  document.querySelectorAll('.settings-pane').forEach((p) => p.classList.toggle('active', p.id === `pane-${cat}`));
  document.querySelectorAll('.settings-rail__item').forEach((b) => b.classList.toggle('active', b.dataset.cat === cat));
  // Same "land at the top of the new view" fix shell.js's own showToolArea already applies when
  // switching tool areas -- without it, switching category leaves you wherever the PREVIOUS
  // category's pane happened to be scrolled to.
  window.scrollTo(0, 0);
}

function setRailStarVisual(star, on) {
  star.classList.toggle('on', on);
  star.textContent = on ? '★' : '☆';
  star.title = on ? 'Unpin' : 'Pin to top';
}

// One fixed order every rail row lives in, whether it's currently in the main list or the Pinned
// group -- pinning/unpinning only ever lifts a row out or drops it back in, it never reorders
// whichever rows stay put (same rule, same reasoning, as Home's HOME_CANONICAL_ORDER).
function categoryOf(row) { return row.querySelector('.settings-rail__item').dataset.cat; }
function insertRailRowInOrder(container, row, beforeNode) {
  const myIndex = SETTINGS_CATEGORY_ORDER.indexOf(categoryOf(row));
  const rows = Array.from(container.querySelectorAll(':scope > .settings-rail__row'));
  const sibling = rows.find((sib) => sib !== row && SETTINGS_CATEGORY_ORDER.indexOf(categoryOf(sib)) > myIndex);
  if (sibling) container.insertBefore(row, sibling);
  else if (beforeNode) container.insertBefore(row, beforeNode);
  else container.appendChild(row);
}

// Builds the "📌 Pinned" label + divider the first time anything is pinned; returns the divider so
// callers can insert pinned rows before it -- label -> pinned rows -> divider -> the rest, matching
// design/vortex-settings-mockup.html. Without this anchor, a plain appendChild would land new rows
// AFTER the divider (the container's only children at that point are the label and the divider), so
// the divider ends up sitting directly under the label instead of below the pinned rows.
function ensurePinnedRailGroup() {
  const container = $g('settingsRailPinnedGroup');
  let divider = container.querySelector('.settings-rail__divider');
  if (!divider) {
    const label = document.createElement('div');
    label.className = 'settings-rail__group';
    label.textContent = '📌 Pinned';
    divider = document.createElement('div');
    divider.className = 'settings-rail__divider';
    container.appendChild(label);
    container.appendChild(divider);
  }
  return divider;
}
function clearPinnedRailGroupIfEmpty() {
  const container = $g('settingsRailPinnedGroup');
  if (!container.querySelector('.settings-rail__row')) container.innerHTML = '';
}

// Moves ONE rail row to reflect `pinned` -- used both for a live star click and for applying
// persisted pins at load. The row itself (and its listeners) is the same real node either way --
// re-parenting it moves it, it never gets cloned.
function applyCategoryPinState(cat, pinned) {
  const star = document.querySelector(`.settings-rail__pin[data-pin-key="${CSS.escape(cat)}"]`);
  if (!star) return;
  const row = star.closest('.settings-rail__row');
  setRailStarVisual(star, pinned);
  if (pinned) {
    const divider = ensurePinnedRailGroup();
    insertRailRowInOrder($g('settingsRailPinnedGroup'), row, divider);
  } else {
    insertRailRowInOrder($g('settingsRail'), row);
  }
  clearPinnedRailGroupIfEmpty();
}

function toggleCategoryPin(cat) {
  const pinning = !pinnedCategories.has(cat);
  if (pinning) pinnedCategories.add(cat); else pinnedCategories.delete(cat);
  savePinnedCategories();
  applyCategoryPinState(cat, pinning);
}

$g('settingsRail').addEventListener('click', (e) => {
  const pin = e.target.closest('.settings-rail__pin');
  if (pin) { toggleCategoryPin(pin.dataset.pinKey); return; }
  const item = e.target.closest('.settings-rail__item');
  if (item) showSettingsCategory(item.dataset.cat);
});

// Apply any pins already persisted from a previous visit, then land on the last-open category (or
// the first one, on a genuinely first visit) -- all before the very first paint.
for (const cat of pinnedCategories) applyCategoryPinState(cat, true);
const savedCategory = localStorage.getItem(SETTINGS_LAST_CATEGORY_KEY);
showSettingsCategory(SETTINGS_CATEGORY_ORDER.includes(savedCategory) ? savedCategory : SETTINGS_CATEGORY_ORDER[0]);

// ---------- Load current settings ----------
async function loadSettings() {
  const cfg = await settingsApi('GET', '/api/settings');
  $g('settingsStagingInput').value = cfg.staging || '';
  $g('settingsDownloadsInput').value = cfg.downloads || '';
  $g('settingsBackupRootInput').value = cfg.backupRoot || '';
  $g('settingsSyncBackupRootInput').value = cfg.syncBackupRoot || '';
  $g('settingsStateInput').value = cfg.state || '';
  $g('settingsLogsDirInput').value = cfg.logsDir || '';
  $g('settingsCleanupExcludeListDirInput').value = cfg.cleanupExcludeListDir || '';
  $g('settingsSkyrimDataDirInput').value = cfg.skyrimDataDir || '';
  $g('settingsPluginsListDirInput').value = cfg.pluginsListDir || '';
  $g('settingsDummyMastersOutputDirInput').value = cfg.dummyMastersOutputDir || '';
  $g('settingsArchiveFinderDbDirInput').value = cfg.archiveFinderDbDir || '';
  $g('settingsArchiveFinderOutputDirInput').value = cfg.archiveFinderOutputDir || '';
  $g('settingsMaxBackupsInput').value = cfg.maxBackupsToKeep != null ? cfg.maxBackupsToKeep : '';
  $g('settingsMaxStateBackupsInput').value = cfg.maxStateBackupsToKeep != null ? cfg.maxStateBackupsToKeep : '';
  $g('settingsConcurrencyInput').value = cfg.concurrentExtractions || 1;
  $g('settingsServerPortInput').value = cfg.serverPort || 4321;
  $g('settingsServerHostInput').value = cfg.serverHost || '127.0.0.1';
  $g('settingsAutoOpenInput').checked = cfg.autoOpenBrowser !== false;
  $g('settingsDownloadMissingInput').checked = cfg.downloadMissingArchives === true;
  $g('settingsForceExtractMismatchInput').checked = cfg.forceExtractOffSiteMismatches === true;
  $g('settingsHideVortexVersionWarningInput').checked = cfg.hideVortexVersionWarning === true;
  $g('settingsNexusKeyStatus').textContent = cfg.hasNexusApiKey
    ? 'A key is already stored -- leave blank to keep it, or type a new one to replace it.'
    : 'No key stored yet.';
  // Exclude-list CONTENTS live in their own data file now (lib/cleanup-exclude-store.js), not in
  // config.json -- fetched separately. Gracefully empty if cleanupExcludeListDir isn't set yet.
  try {
    const ignored = await settingsApi('GET', '/api/cleanup/ignored');
    renderCleanupIgnoredList('staging', ignored.staging || []);
    renderCleanupIgnoredList('archives', ignored.archives || []);
  } catch {
    renderCleanupIgnoredList('staging', []);
    renderCleanupIgnoredList('archives', []);
  }
  await loadBackupRatioDismissInfo();
  settingsDirty = false;
}

// mdBold/escHtml are globals defined in sync-app.js (loaded before this file, same page) -- reused
// here rather than redefined, per this project's own "no duplicate helpers across files on the same
// page" convention.
function renderBackupRatioDismissBody(count) {
  const intro = "Before a backup, we flag any collection with an unusually large share of mods Ignored or Disabled — a nudge in case it was accidental.";
  const tail = count > 0
    ? `You've marked **${count} collection${count === 1 ? '' : 's'}** as normal, so we skip the nudge for those.`
    : "You haven't silenced this for any collections yet.";
  $g('settingsBackupRatioDismissBody').innerHTML = `${mdBold(escHtml(intro))} ${mdBold(escHtml(tail))}`;
}

async function loadBackupRatioDismissInfo() {
  try {
    const { count } = await settingsApi('GET', '/api/sync/backup-ratio-dismiss-info');
    renderBackupRatioDismissBody(count);
  } catch {
    renderBackupRatioDismissBody(0);
  }
}

loadSettings().catch((e) => {
  if (!handleSettingsApiError(e, loadSettings)) {
    $g('settingsSaveStatus').textContent = `Could not load settings: ${e.message}`;
  }
});

// ---------- Restart flow ----------
// Polls a cheap, always-available GET until it succeeds again. The small initial delay matters: the
// OLD process keeps answering successfully for a brief window after the restart request is sent
// (server.close() is called a moment later, on the server side, not instantly) -- polling too early
// risks a false "it's back" the instant the OLD process's very last response lands, before it's
// actually been replaced. By the time this first poll fires, the old process has already stopped
// accepting new connections.
async function waitForServerBack(maxWaitMs, origin) {
  const start = Date.now();
  await new Promise((r) => setTimeout(r, 750));
  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await fetch(`${origin}/api/settings`);
      if (res.ok) return true;
    } catch { /* still down -- keep polling */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function confirmRestart() {
  $g('settingsRestartModal').classList.remove('hidden');
  return new Promise((resolve) => {
    $g('settingsRestartCancelBtn').onclick = () => { $g('settingsRestartModal').classList.add('hidden'); resolve(false); };
    $g('settingsRestartConfirmBtn').onclick = () => { $g('settingsRestartModal').classList.add('hidden'); resolve(true); };
  });
}

// newOrigin lets a port/host change be handled correctly: if the server comes back on a
// DIFFERENT address than this tab is currently on, polling/reloading against the OLD address
// would spin until timeout (nothing ever answers there again) -- navigate to the new one instead.
// 0.0.0.0 is a bind-all address, not something a browser can navigate to, so it's normalized to
// 127.0.0.1 here the same way server.js does for its own auto-open.
async function restartServerAndWait(newOrigin) {
  const statusEl = $g('settingsSaveStatus');
  $g('settingsSaveBtn').disabled = true;
  statusEl.textContent = 'Restarting server…';
  try {
    await settingsApi('POST', '/api/settings/restart-server');
  } catch {
    // The connection can drop/reset mid-response once the server actually starts closing --
    // expected here, not a real failure. Proceed to polling regardless.
  }
  const target = newOrigin || location.origin;
  const backUp = await waitForServerBack(20000, target);
  $g('settingsSaveBtn').disabled = false;
  if (backUp) {
    statusEl.textContent = 'Server restarted.';
    if (target === location.origin) location.reload();
    else location.href = target;
  } else {
    statusEl.textContent = "Server didn't come back within 20s -- check the terminal it was started from.";
  }
}

// ---------- Header: Restart Server / Stop Server ----------
// Standalone versions of the same restart mechanics above, for when the user just wants to pick up
// a server-side code change (or a hung state) with nothing in Settings actually changed -- the
// Save-triggered restart flow above only ever fires when result.restartRequired comes back true,
// which never happens here. Reuses waitForServerBack (already defined above) but reports to this
// header's own status line/buttons rather than the Save button's, since that's what the user
// actually clicked.
function setServerActionStatus(text) {
  const el = $g('settingsServerActionStatus');
  el.textContent = text;
  el.classList.toggle('hidden', !text);
}

$g('settingsRestartServerBtn').addEventListener('click', async () => {
  $g('settingsRestartServerBtn').disabled = true;
  $g('settingsStopServerBtn').disabled = true;
  setServerActionStatus('Restarting server…');
  try {
    await settingsApi('POST', '/api/settings/restart-server');
  } catch {
    // The connection can drop/reset mid-response once the server actually starts closing --
    // expected here, not a real failure. Proceed to polling regardless.
  }
  const backUp = await waitForServerBack(20000, location.origin);
  if (backUp) {
    setServerActionStatus('Server restarted.');
    location.reload();
  } else {
    $g('settingsRestartServerBtn').disabled = false;
    $g('settingsStopServerBtn').disabled = false;
    setServerActionStatus("Server didn't come back within 20s -- check the terminal it was started from.");
  }
});

$g('settingsStopServerBtn').addEventListener('click', () => {
  $g('settingsStopServerModal').classList.remove('hidden');
});
$g('settingsStopServerCancelBtn').addEventListener('click', () => {
  $g('settingsStopServerModal').classList.add('hidden');
});
$g('settingsStopServerConfirmBtn').addEventListener('click', async () => {
  $g('settingsStopServerModal').classList.add('hidden');
  $g('settingsRestartServerBtn').disabled = true;
  $g('settingsStopServerBtn').disabled = true;
  setServerActionStatus('Stopping server…');
  try {
    await settingsApi('POST', '/api/shutdown');
  } catch {
    // Same expected mid-shutdown connection drop as the restart flow above.
  }
  setServerActionStatus('Server stopped. Run start-server.bat (or start-server.ps1) to use this app again.');
});

// ---------- Save ----------
// Extracted into a plain function (not just the button's click handler) so shell.js's "unsaved
// changes" navigation guard can trigger the exact same save path, restart-confirmation flow
// included, rather than a second, drifting copy of this logic. Returns true only once the actual
// POST /api/settings succeeds -- that's the signal the navigation guard cares about (values are
// persisted); a subsequent restart-confirm decline/accept doesn't change that.
async function saveSettings() {
  const btn = $g('settingsSaveBtn');
  const statusEl = $g('settingsSaveStatus');
  // Checked BEFORE anything is disabled/sent -- a required field left blank is a mistake worth
  // catching immediately (no round trip needed), same intent as the server-side backstop in
  // web/settings-routes.js (which exists for a corrupt/manually-edited config.json, not the normal
  // path through this form).
  const missing = REQUIRED_FIELDS.filter((f) => $g(f.inputId).value.trim() === '');
  if (missing.length > 0) {
    statusEl.textContent = `Required setting(s) missing: ${missing.map((f) => f.label).join(', ')}.`;
    return;
  }
  btn.disabled = true;
  statusEl.textContent = 'Saving…';
  try {
    const body = {
      staging: $g('settingsStagingInput').value,
      downloads: $g('settingsDownloadsInput').value,
      backupRoot: $g('settingsBackupRootInput').value,
      syncBackupRoot: $g('settingsSyncBackupRootInput').value,
      state: $g('settingsStateInput').value,
      logsDir: $g('settingsLogsDirInput').value,
      cleanupExcludeListDir: $g('settingsCleanupExcludeListDirInput').value,
      skyrimDataDir: $g('settingsSkyrimDataDirInput').value,
      pluginsListDir: $g('settingsPluginsListDirInput').value,
      dummyMastersOutputDir: $g('settingsDummyMastersOutputDirInput').value,
      archiveFinderDbDir: $g('settingsArchiveFinderDbDirInput').value,
      archiveFinderOutputDir: $g('settingsArchiveFinderOutputDirInput').value,
      maxBackupsToKeep: $g('settingsMaxBackupsInput').value === '' ? null : Number($g('settingsMaxBackupsInput').value),
      maxStateBackupsToKeep: $g('settingsMaxStateBackupsInput').value === '' ? null : Number($g('settingsMaxStateBackupsInput').value),
      concurrentExtractions: Number($g('settingsConcurrencyInput').value) || 1,
      serverPort: Number($g('settingsServerPortInput').value) || 4321,
      serverHost: $g('settingsServerHostInput').value,
      autoOpenBrowser: $g('settingsAutoOpenInput').checked,
      downloadMissingArchives: $g('settingsDownloadMissingInput').checked,
      forceExtractOffSiteMismatches: $g('settingsForceExtractMismatchInput').checked,
      hideVortexVersionWarning: $g('settingsHideVortexVersionWarningInput').checked,
    };
    const keyInput = $g('settingsNexusKeyInput').value;
    if (keyInput.trim()) body.nexusApiKey = keyInput;
    const result = await settingsApi('POST', '/api/settings', body);
    $g('settingsNexusKeyInput').value = '';
    $g('settingsNexusKeyStatus').textContent = result.hasNexusApiKey
      ? 'A key is already stored -- leave blank to keep it, or type a new one to replace it.'
      : 'No key stored yet.';
    btn.disabled = false;
    settingsDirty = false;
    if (result.restartRequired) {
      statusEl.textContent = 'Saved.';
      const shouldRestart = await confirmRestart();
      if (shouldRestart) {
        const resultHost = result.serverHost === '0.0.0.0' ? '127.0.0.1' : result.serverHost;
        const newOrigin = `http://${resultHost}:${result.serverPort}`;
        await restartServerAndWait(newOrigin);
      } else {
        $g('settingsRestartBanner').classList.remove('hidden');
      }
    } else {
      $g('settingsRestartBanner').classList.add('hidden');
      statusEl.textContent = 'Saved.';
    }
    return true;
  } catch (e) {
    if (!handleSettingsApiError(e)) statusEl.textContent = `Failed: ${e.message}`;
    btn.disabled = false;
    return false;
  }
}
$g('settingsSaveBtn').addEventListener('click', saveSettings);

// ---------- Unsaved-changes navigation guard ----------
// settingsDirty tracks whether anything's changed since the last successful load/save -- reset on
// each loadSettings() call and on a successful saveSettings(). Delegated listener on the whole
// settings area (not one per field) so a field added later is covered automatically. window.* hooks
// are the deliberate seam shell.js's nav-click guard uses -- shell.js otherwise knows nothing about
// this file's internals (same "each area owns its own state" convention as app.js/sync-app.js).
// settingsThemeSelect excluded -- it saves to localStorage instantly on its own 'change' listener
// above and isn't part of saveSettings()'s payload at all, so it would be a false "unsaved" trigger.
function markDirty(e) { if (e.target.id !== 'settingsThemeSelect') settingsDirty = true; }
document.getElementById('area-settings').addEventListener('input', markDirty);
document.getElementById('area-settings').addEventListener('change', markDirty);
window.settingsIsDirty = () => settingsDirty;
window.settingsSave = saveSettings;

// ---------- Browse (native folder picker) ----------
document.querySelectorAll('.settings-browse-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const input = $g(btn.dataset.target);
    btn.disabled = true;
    try {
      const result = await settingsApi('POST', '/api/settings/browse-folder', { initialDir: input.value || undefined });
      if (result.path) input.value = result.path;
    } catch (e) {
      if (!handleSettingsApiError(e)) $g('settingsSaveStatus').textContent = `Browse failed: ${e.message}`;
    } finally {
      btn.disabled = false;
    }
  });
});

$g('settingsClearNexusKeyBtn').addEventListener('click', async () => {
  const statusEl = $g('settingsSaveStatus');
  try {
    const result = await settingsApi('POST', '/api/settings', { clearNexusApiKey: true });
    $g('settingsNexusKeyInput').value = '';
    $g('settingsNexusKeyStatus').textContent = 'No key stored yet.';
    statusEl.textContent = result.hasNexusApiKey ? 'Failed to clear.' : 'Key cleared.';
  } catch (e) {
    if (!handleSettingsApiError(e)) statusEl.textContent = `Failed: ${e.message}`;
  }
});

// ---------- Delete all backups ----------
$g('settingsDeleteBackupsBtn').addEventListener('click', async () => {
  const statusEl = $g('settingsDeleteBackupsStatus');
  try {
    const { backupRoot, count } = await settingsApi('GET', '/api/settings/backups-info');
    if (!backupRoot) {
      statusEl.textContent = 'No backup root folder is configured -- nothing to delete.';
      return;
    }
    if (count === 0) {
      statusEl.textContent = 'No backups found.';
      return;
    }
    $g('settingsDeleteBackupsModalText').textContent =
      `This will permanently delete ${count} backup${count === 1 ? '' : 's'}.`;
    $g('settingsDeleteBackupsModal').classList.remove('hidden');
  } catch (e) {
    if (!handleSettingsApiError(e)) statusEl.textContent = `Failed: ${e.message}`;
  }
});
$g('settingsDeleteBackupsCancelBtn').addEventListener('click', () => {
  $g('settingsDeleteBackupsModal').classList.add('hidden');
});
$g('settingsDeleteBackupsConfirmBtn').addEventListener('click', async () => {
  const statusEl = $g('settingsDeleteBackupsStatus');
  $g('settingsDeleteBackupsModal').classList.add('hidden');
  statusEl.textContent = 'Deleting…';
  try {
    const { deletedCount } = await settingsApi('POST', '/api/settings/delete-backups');
    statusEl.textContent = deletedCount > 0 ? `Deleted ${deletedCount} backup${deletedCount === 1 ? '' : 's'}.` : 'Nothing to delete.';
  } catch (e) {
    if (!handleSettingsApiError(e)) statusEl.textContent = `Failed: ${e.message}`;
  }
});

// ---------- Logs (Open Logs Folder / Delete all logs) ----------
$g('settingsOpenLogsBtn').addEventListener('click', async () => {
  const statusEl = $g('settingsDeleteLogsStatus');
  try {
    await settingsApi('POST', '/api/settings/open-logs-folder');
  } catch (e) {
    if (!handleSettingsApiError(e)) statusEl.textContent = `Failed: ${e.message}`;
  }
});
$g('settingsDeleteLogsBtn').addEventListener('click', async () => {
  const statusEl = $g('settingsDeleteLogsStatus');
  try {
    const { count } = await settingsApi('GET', '/api/settings/logs-info');
    if (count === 0) {
      statusEl.textContent = 'No logs found.';
      return;
    }
    $g('settingsDeleteLogsModalText').textContent =
      `This will permanently delete ${count} log file${count === 1 ? '' : 's'}.`;
    $g('settingsDeleteLogsModal').classList.remove('hidden');
  } catch (e) {
    if (!handleSettingsApiError(e)) statusEl.textContent = `Failed: ${e.message}`;
  }
});
$g('settingsDeleteLogsCancelBtn').addEventListener('click', () => {
  $g('settingsDeleteLogsModal').classList.add('hidden');
});
$g('settingsDeleteLogsConfirmBtn').addEventListener('click', async () => {
  const statusEl = $g('settingsDeleteLogsStatus');
  $g('settingsDeleteLogsModal').classList.add('hidden');
  statusEl.textContent = 'Deleting…';
  try {
    const { deletedCount } = await settingsApi('POST', '/api/settings/delete-logs');
    statusEl.textContent = deletedCount > 0 ? `Deleted ${deletedCount} log file${deletedCount === 1 ? '' : 's'}.` : 'Nothing to delete.';
  } catch (e) {
    if (!handleSettingsApiError(e)) statusEl.textContent = `Failed: ${e.message}`;
  }
});

// ---------- Delete all Update Collection backups (two separate stores, same pattern as above) ----------
$g('settingsSyncDeleteBackupsBtn').addEventListener('click', async () => {
  const statusEl = $g('settingsSyncDeleteBackupsStatus');
  try {
    const { backupRoot, count } = await settingsApi('GET', '/api/sync/backups-info');
    if (!backupRoot) {
      statusEl.textContent = 'No Update Collection backups folder is configured -- nothing to delete.';
      return;
    }
    if (count === 0) {
      statusEl.textContent = 'No backups found.';
      return;
    }
    $g('settingsSyncDeleteBackupsModalText').textContent =
      `This will permanently delete ${count} backup${count === 1 ? '' : 's'}.`;
    $g('settingsSyncDeleteBackupsModal').classList.remove('hidden');
  } catch (e) {
    if (!handleSettingsApiError(e)) statusEl.textContent = `Failed: ${e.message}`;
  }
});
$g('settingsSyncDeleteBackupsCancelBtn').addEventListener('click', () => {
  $g('settingsSyncDeleteBackupsModal').classList.add('hidden');
});
$g('settingsSyncDeleteBackupsConfirmBtn').addEventListener('click', async () => {
  const statusEl = $g('settingsSyncDeleteBackupsStatus');
  $g('settingsSyncDeleteBackupsModal').classList.add('hidden');
  statusEl.textContent = 'Deleting…';
  try {
    const { deletedCount } = await settingsApi('POST', '/api/sync/delete-backups');
    statusEl.textContent = deletedCount > 0 ? `Deleted ${deletedCount} backup${deletedCount === 1 ? '' : 's'}.` : 'Nothing to delete.';
  } catch (e) {
    if (!handleSettingsApiError(e)) statusEl.textContent = `Failed: ${e.message}`;
  }
});

$g('settingsStateDeleteBackupsBtn').addEventListener('click', async () => {
  const statusEl = $g('settingsStateDeleteBackupsStatus');
  try {
    const { count } = await settingsApi('GET', '/api/sync/state-backups-info');
    if (count === 0) {
      statusEl.textContent = 'No backups found.';
      return;
    }
    $g('settingsStateDeleteBackupsModalText').textContent =
      `This will permanently delete ${count} Vortex database backup${count === 1 ? '' : 's'}.`;
    $g('settingsStateDeleteBackupsModal').classList.remove('hidden');
  } catch (e) {
    if (!handleSettingsApiError(e)) statusEl.textContent = `Failed: ${e.message}`;
  }
});
$g('settingsStateDeleteBackupsCancelBtn').addEventListener('click', () => {
  $g('settingsStateDeleteBackupsModal').classList.add('hidden');
});
$g('settingsStateDeleteBackupsConfirmBtn').addEventListener('click', async () => {
  const statusEl = $g('settingsStateDeleteBackupsStatus');
  $g('settingsStateDeleteBackupsModal').classList.add('hidden');
  statusEl.textContent = 'Deleting…';
  try {
    const { deletedCount } = await settingsApi('POST', '/api/sync/delete-state-backups');
    statusEl.textContent = deletedCount > 0 ? `Deleted ${deletedCount} backup${deletedCount === 1 ? '' : 's'}.` : 'Nothing to delete.';
  } catch (e) {
    if (!handleSettingsApiError(e)) statusEl.textContent = `Failed: ${e.message}`;
  }
});

// ---------- Backup ratio warning: "Remind me for all collections again" ----------
// No confirm modal -- unlike the destructive backup/log deletes above, this only clears a preference
// (see lib/backup-ratio-dismiss-state.js's own comment); re-dismissing a still-normal collection
// later costs one click.
$g('settingsBackupRatioResetBtn').addEventListener('click', async () => {
  const statusEl = $g('settingsBackupRatioResetStatus');
  statusEl.textContent = 'Resetting…';
  try {
    await settingsApi('POST', '/api/sync/backup-ratio-dismiss-reset');
    renderBackupRatioDismissBody(0);
    statusEl.textContent = 'Done -- every collection will get the nudge again if it qualifies.';
  } catch (e) {
    if (!handleSettingsApiError(e)) statusEl.textContent = `Failed: ${e.message}`;
  }
});

// ---------- Restore a Vortex database backup ----------
// GET /api/sync/state-backups and POST /api/sync/restore-state already existed server-side (built
// during an earlier session's stability audit) with no UI ever wired up to them -- this was the
// standing "backend ready, UI missing" gap noted in TECHNICAL.md's Future Work.
$g('settingsStateRestoreBtn').addEventListener('click', async () => {
  const statusEl = $g('settingsStateDeleteBackupsStatus');
  const select = $g('settingsStateRestoreSelect');
  try {
    const { backups } = await settingsApi('GET', '/api/sync/state-backups');
    select.innerHTML = '';
    for (const b of backups) {
      const opt = document.createElement('option');
      opt.value = b.dir;
      opt.textContent = new Date(b.createdAt).toLocaleString();
      select.appendChild(opt);
    }
    const hasBackups = backups.length > 0;
    select.classList.toggle('hidden', !hasBackups);
    $g('settingsStateRestoreEmpty').classList.toggle('hidden', hasBackups);
    $g('settingsStateRestoreConfirmBtn').disabled = !hasBackups;
    $g('settingsStateRestoreModal').classList.remove('hidden');
  } catch (e) {
    if (!handleSettingsApiError(e)) statusEl.textContent = `Failed: ${e.message}`;
  }
});
$g('settingsStateRestoreCancelBtn').addEventListener('click', () => {
  $g('settingsStateRestoreModal').classList.add('hidden');
});
$g('settingsStateRestoreConfirmBtn').addEventListener('click', async () => {
  const statusEl = $g('settingsStateDeleteBackupsStatus');
  const backupDir = $g('settingsStateRestoreSelect').value;
  if (!backupDir) return;
  $g('settingsStateRestoreModal').classList.add('hidden');
  $g('settingsStateRestoreResultActions').classList.add('hidden');
  statusEl.textContent = 'Restoring…';
  try {
    const { restoredFrom, preRestoreBackupDir } = await settingsApi('POST', '/api/sync/restore-state', { backupDir });
    // No raw paths in the status text -- the Reveal buttons below represent each location instead.
    statusEl.textContent = 'Restored successfully. A safety backup of your database from right before this restore was also saved.';
    $g('settingsStateRevealRestoredBtn').dataset.path = restoredFrom;
    $g('settingsStateRevealPreRestoreBtn').dataset.path = preRestoreBackupDir;
    $g('settingsStateRestoreResultActions').classList.remove('hidden');
  } catch (e) {
    // Server already returns a clear, complete message either way (including the 409
    // vortex-running case) -- no special-casing needed here.
    if (!handleSettingsApiError(e)) statusEl.textContent = `Failed: ${e.message}`;
  }
});
$g('settingsStateRevealRestoredBtn').addEventListener('click', () => {
  const p = $g('settingsStateRevealRestoredBtn').dataset.path;
  if (p) settingsApi('POST', '/api/rebuild/reveal', { targetPath: p }).catch(() => {});
});
$g('settingsStateRevealPreRestoreBtn').addEventListener('click', () => {
  const p = $g('settingsStateRevealPreRestoreBtn').dataset.path;
  if (p) settingsApi('POST', '/api/rebuild/reveal', { targetPath: p }).catch(() => {});
});

// ---------- Vortex Scrub exclude list ----------
// Lets the user maintain (view/remove/manually add) the "known-safe, don't ask again" list that
// Vortex Scrub's (Utilities area) needsReview "Exclude" actions write to
// (lib/cleanup-exclude-store.js). Same checkbox + bulk-action convention as Vortex Scrub's own
// exception lists, for consistency (confirmed 2026-07-27: a lone Remove button per row wasn't
// wanted -- checkboxes + Remove Selected/Remove All instead), inside a <details> disclosure so a
// long-since-grown list doesn't dominate the Settings page by default. Immediate actions, same as
// Delete all backups -- no Save Settings needed.

// "Select all" checkbox: removed 2026-07-27 as redundant with Remove All, then put back the same
// day once the user actually tried a large list -- select-all-then-uncheck-a-few beats checking 20
// boxes individually when you want most-but-not-all removed. Same reasoning applied back to Vortex
// Scrub's own lists.
const CLEANUP_IGNORED_IDS = {
  staging: {
    list: 'settingsCleanupIgnoredStagingList', empty: 'settingsCleanupIgnoredStagingEmpty',
    count: 'settingsCleanupIgnoredStagingCount', selectAll: 'settingsCleanupIgnoredStagingSelectAllInput',
    removeSelected: 'settingsCleanupIgnoredStagingRemoveSelectedBtn', removeAll: 'settingsCleanupIgnoredStagingRemoveAllBtn',
  },
  archives: {
    list: 'settingsCleanupIgnoredArchivesList', empty: 'settingsCleanupIgnoredArchivesEmpty',
    count: 'settingsCleanupIgnoredArchivesCount', selectAll: 'settingsCleanupIgnoredArchivesSelectAllInput',
    removeSelected: 'settingsCleanupIgnoredArchivesRemoveSelectedBtn', removeAll: 'settingsCleanupIgnoredArchivesRemoveAllBtn',
  },
};
let cleanupIgnoredNames = { staging: [], archives: [] };

function updateCleanupRemoveSelectedEnabled(kind) {
  const ids = CLEANUP_IGNORED_IDS[kind];
  const anyChecked = !!document.querySelector(`#${ids.list} .cleanup-ignored-check:checked`);
  $g(ids.removeSelected).disabled = !anyChecked;
}

function renderCleanupIgnoredList(kind, names) {
  cleanupIgnoredNames[kind] = names;
  const ids = CLEANUP_IGNORED_IDS[kind];
  const listEl = $g(ids.list);
  listEl.innerHTML = '';
  $g(ids.empty).classList.toggle('hidden', names.length > 0);
  $g(ids.count).textContent = names.length;
  for (const name of names) {
    const li = document.createElement('li');
    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'cleanup-ignored-check';
    checkbox.dataset.name = name;
    label.appendChild(checkbox);
    label.appendChild(document.createTextNode(' ' + name));
    li.appendChild(label);
    listEl.appendChild(li);
  }
  $g(ids.selectAll).checked = false;
  updateCleanupRemoveSelectedEnabled(kind);
}

async function removeCleanupIgnored(kind, names) {
  if (names.length === 0) return;
  const statusEl = $g('settingsCleanupStatus');
  try {
    const { list } = await settingsApi('POST', '/api/cleanup/ignored/remove', { kind, names });
    renderCleanupIgnoredList(kind, list);
    statusEl.textContent = `Removed ${names.length} item${names.length === 1 ? '' : 's'} -- they'll be re-evaluated on the next scan.`;
  } catch (e) {
    if (!handleSettingsApiError(e)) statusEl.textContent = `Failed: ${e.message}`;
  }
}

for (const kind of ['staging', 'archives']) {
  const ids = CLEANUP_IGNORED_IDS[kind];
  $g(ids.selectAll).addEventListener('change', (ev) => {
    document.querySelectorAll(`#${ids.list} .cleanup-ignored-check`).forEach((cb) => { cb.checked = ev.target.checked; });
    updateCleanupRemoveSelectedEnabled(kind);
  });
  $g(ids.list).addEventListener('change', (ev) => {
    if (ev.target.classList.contains('cleanup-ignored-check')) updateCleanupRemoveSelectedEnabled(kind);
  });
  $g(ids.removeSelected).addEventListener('click', () => {
    const names = [...document.querySelectorAll(`#${ids.list} .cleanup-ignored-check:checked`)].map((cb) => cb.dataset.name);
    removeCleanupIgnored(kind, names);
  });
  $g(ids.removeAll).addEventListener('click', () => removeCleanupIgnored(kind, cleanupIgnoredNames[kind]));
}

async function addCleanupIgnored(kind, inputId) {
  const input = $g(inputId);
  const name = input.value.trim();
  if (!name) return;
  const statusEl = $g('settingsCleanupStatus');
  try {
    const { list } = await settingsApi('POST', '/api/cleanup/exclude', { kind, names: [name] });
    renderCleanupIgnoredList(kind, list);
    input.value = '';
    statusEl.textContent = `Added "${name}" to the exclude list.`;
  } catch (e) {
    if (!handleSettingsApiError(e)) statusEl.textContent = `Failed: ${e.message}`;
  }
}
$g('settingsCleanupAddStagingBtn').addEventListener('click', () => addCleanupIgnored('staging', 'settingsCleanupAddStagingInput'));
$g('settingsCleanupAddArchiveBtn').addEventListener('click', () => addCleanupIgnored('archives', 'settingsCleanupAddArchiveInput'));
