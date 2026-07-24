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
  $g('settingsBackupEnabledCheckbox').checked = cfg.backupEnabled !== false;
  $g('settingsNexusKeyStatus').textContent = cfg.hasNexusApiKey
    ? 'A key is already stored -- leave blank to keep it, or type a new one to replace it.'
    : 'No key stored yet.';
}
loadSettings().catch((e) => {
  $g('settingsSaveStatus').textContent = `Could not load settings: ${e.message}`;
});

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
      backupEnabled: $g('settingsBackupEnabledCheckbox').checked,
    };
    const keyInput = $g('settingsNexusKeyInput').value;
    if (keyInput.trim()) body.nexusApiKey = keyInput;
    const result = await settingsApi('POST', '/api/settings', body);
    $g('settingsNexusKeyInput').value = '';
    $g('settingsNexusKeyStatus').textContent = result.hasNexusApiKey
      ? 'A key is already stored -- leave blank to keep it, or type a new one to replace it.'
      : 'No key stored yet.';
    $g('settingsRestartBanner').classList.toggle('hidden', !result.restartRequired);
    statusEl.textContent = 'Saved.';
  } catch (e) {
    statusEl.textContent = `Failed: ${e.message}`;
  } finally {
    btn.disabled = false;
  }
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
