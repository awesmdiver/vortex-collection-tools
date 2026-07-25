'use strict';
// Settings UI -- talks only to /api/settings. Fully independent of app.js/sync-app.js, same
// convention as sync-app.js's own header comment: its own tiny $/api helpers so this area can be
// worked on without touching the already-validated Rebuild/Update Collection code at all.

function $g(id) { return document.getElementById(id); }

// Declared up top (not near its listeners further down) so loadSettings()'s own reset of it can
// never run into a temporal-dead-zone ordering question -- see the "Unsaved-changes navigation
// guard" section below for how this is tracked and used.
let settingsDirty = false;

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

// ---------- Load current settings ----------
async function loadSettings() {
  const cfg = await settingsApi('GET', '/api/settings');
  $g('settingsStagingInput').value = cfg.staging || '';
  $g('settingsDownloadsInput').value = cfg.downloads || '';
  $g('settingsBackupRootInput').value = cfg.backupRoot || '';
  $g('settingsStateInput').value = cfg.state || '';
  $g('settingsMaxBackupsInput').value = cfg.maxBackupsToKeep != null ? cfg.maxBackupsToKeep : '';
  $g('settingsConcurrencyInput').value = cfg.concurrentExtractions || 1;
  $g('settingsServerPortInput').value = cfg.serverPort || 4321;
  $g('settingsServerHostInput').value = cfg.serverHost || '127.0.0.1';
  $g('settingsAutoOpenInput').checked = cfg.autoOpenBrowser !== false;
  $g('settingsDownloadMissingInput').checked = cfg.downloadMissingArchives === true;
  $g('settingsForceExtractMismatchInput').checked = cfg.forceExtractOffSiteMismatches === true;
  $g('settingsNexusKeyStatus').textContent = cfg.hasNexusApiKey
    ? 'A key is already stored -- leave blank to keep it, or type a new one to replace it.'
    : 'No key stored yet.';
  settingsDirty = false;
}
loadSettings().catch((e) => {
  $g('settingsSaveStatus').textContent = `Could not load settings: ${e.message}`;
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
    statusEl.textContent = 'Server did not come back within 20s -- check the terminal it was started from.';
  }
}

// ---------- Save ----------
// Extracted into a plain function (not just the button's click handler) so shell.js's "unsaved
// changes" navigation guard can trigger the exact same save path, restart-confirmation flow
// included, rather than a second, drifting copy of this logic. Returns true only once the actual
// POST /api/settings succeeds -- that's the signal the navigation guard cares about (values are
// persisted); a subsequent restart-confirm decline/accept doesn't change that.
async function saveSettings() {
  const btn = $g('settingsSaveBtn');
  const statusEl = $g('settingsSaveStatus');
  btn.disabled = true;
  statusEl.textContent = 'Saving…';
  try {
    const body = {
      staging: $g('settingsStagingInput').value,
      downloads: $g('settingsDownloadsInput').value,
      backupRoot: $g('settingsBackupRootInput').value,
      state: $g('settingsStateInput').value,
      maxBackupsToKeep: $g('settingsMaxBackupsInput').value === '' ? null : Number($g('settingsMaxBackupsInput').value),
      concurrentExtractions: Number($g('settingsConcurrencyInput').value) || 1,
      serverPort: Number($g('settingsServerPortInput').value) || 4321,
      serverHost: $g('settingsServerHostInput').value,
      autoOpenBrowser: $g('settingsAutoOpenInput').checked,
      downloadMissingArchives: $g('settingsDownloadMissingInput').checked,
      forceExtractOffSiteMismatches: $g('settingsForceExtractMismatchInput').checked,
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
    statusEl.textContent = `Failed: ${e.message}`;
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
      $g('settingsSaveStatus').textContent = `Browse failed: ${e.message}`;
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
    statusEl.textContent = `Failed: ${e.message}`;
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
      statusEl.textContent = `No backups found in "${backupRoot}".`;
      return;
    }
    $g('settingsDeleteBackupsModalText').textContent =
      `This will permanently delete ${count} backup${count === 1 ? '' : 's'} from "${backupRoot}".`;
    $g('settingsDeleteBackupsModal').classList.remove('hidden');
  } catch (e) {
    statusEl.textContent = `Failed: ${e.message}`;
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
    statusEl.textContent = `Failed: ${e.message}`;
  }
});
