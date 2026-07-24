'use strict';
// Settings UI -- talks only to /api/settings. Fully independent of app.js/sync-app.js, same
// convention as sync-app.js's own header comment: its own tiny $/api helpers so this area can be
// worked on without touching the already-validated Rebuild/Update Collection code at all.

function $g(id) { return document.getElementById(id); }

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
  $g('settingsNexusKeyStatus').textContent = cfg.hasNexusApiKey
    ? 'A key is already stored -- leave blank to keep it, or type a new one to replace it.'
    : 'No key stored yet.';
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
async function waitForServerBack(maxWaitMs) {
  const start = Date.now();
  await new Promise((r) => setTimeout(r, 750));
  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await fetch('/api/settings');
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

async function restartServerAndWait() {
  const statusEl = $g('settingsSaveStatus');
  $g('settingsSaveBtn').disabled = true;
  statusEl.textContent = 'Restarting server…';
  try {
    await settingsApi('POST', '/api/settings/restart-server');
  } catch {
    // The connection can drop/reset mid-response once the server actually starts closing --
    // expected here, not a real failure. Proceed to polling regardless.
  }
  const backUp = await waitForServerBack(20000);
  $g('settingsSaveBtn').disabled = false;
  if (backUp) {
    statusEl.textContent = 'Server restarted.';
    location.reload();
  } else {
    statusEl.textContent = 'Server did not come back within 20s -- check the terminal it was started from.';
  }
}

// ---------- Save ----------
$g('settingsSaveBtn').addEventListener('click', async () => {
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
    };
    const keyInput = $g('settingsNexusKeyInput').value;
    if (keyInput.trim()) body.nexusApiKey = keyInput;
    const result = await settingsApi('POST', '/api/settings', body);
    $g('settingsNexusKeyInput').value = '';
    $g('settingsNexusKeyStatus').textContent = result.hasNexusApiKey
      ? 'A key is already stored -- leave blank to keep it, or type a new one to replace it.'
      : 'No key stored yet.';
    btn.disabled = false;
    if (result.restartRequired) {
      statusEl.textContent = 'Saved.';
      const shouldRestart = await confirmRestart();
      if (shouldRestart) {
        await restartServerAndWait();
      } else {
        $g('settingsRestartBanner').classList.remove('hidden');
      }
    } else {
      $g('settingsRestartBanner').classList.add('hidden');
      statusEl.textContent = 'Saved.';
    }
  } catch (e) {
    statusEl.textContent = `Failed: ${e.message}`;
    btn.disabled = false;
  }
});

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
