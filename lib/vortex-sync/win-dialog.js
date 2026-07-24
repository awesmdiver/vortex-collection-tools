// Native Windows file/folder dialogs, via a spawned PowerShell WinForms dialog.
// Used by the interactive menu (and, for pickFolderAsync, the Settings page's own "Browse..."
// buttons) so paths never have to be typed by hand.

const { spawn, spawnSync } = require('child_process');

function psSingleQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

function showDialog({ save, title, initialDir, filter, defaultFileName }) {
  const dialogType = save ? 'SaveFileDialog' : 'OpenFileDialog';
  const lines = [
    'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
    `$dlg = New-Object System.Windows.Forms.${dialogType}`,
    `$dlg.Title = ${psSingleQuote(title || '')}`,
  ];
  if (initialDir) lines.push(`$dlg.InitialDirectory = ${psSingleQuote(initialDir)}`);
  if (filter) lines.push(`$dlg.Filter = ${psSingleQuote(filter)}`);
  if (defaultFileName) lines.push(`$dlg.FileName = ${psSingleQuote(defaultFileName)}`);
  lines.push('$result = $dlg.ShowDialog()');
  lines.push("if ($result -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dlg.FileName }");

  const res = spawnSync('powershell.exe', ['-NoProfile', '-STA', '-Command', lines.join('; ')], {
    encoding: 'utf8',
  });
  if (res.error) throw res.error;
  const out = (res.stdout || '').trim();
  return out.length > 0 ? out : null;
}

function pickOpenFile({ title = 'Select a file', initialDir, filter = 'JSON files (*.json)|*.json|All files (*.*)|*.*' } = {}) {
  return showDialog({ save: false, title, initialDir, filter });
}

function pickSaveFile({ title = 'Save file', initialDir, filter = 'JSON files (*.json)|*.json|All files (*.*)|*.*', defaultFileName } = {}) {
  return showDialog({ save: true, title, initialDir, filter, defaultFileName });
}

// Async folder picker (FolderBrowserDialog, not Open/SaveFileDialog) -- deliberately spawn(), not
// spawnSync(), unlike the two functions above. Those are only ever called from the interactive CLI
// menu, where blocking the single-purpose terminal process for as long as the dialog is open is a
// non-issue. This one is called from an Express route handler in a long-running web server -- a
// synchronous block there would freeze the ENTIRE app (every other request, every open SSE stream)
// for as long as the user takes to pick a folder, the same class of bug this project already fixed
// once for extract-mod.js's own child-process calls (see rebuild-mod.js's runExtract comment).
function pickFolderAsync({ title = 'Select a folder', initialDir } = {}) {
  return new Promise((resolve, reject) => {
    const lines = [
      'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
      '$dlg = New-Object System.Windows.Forms.FolderBrowserDialog',
      `$dlg.Description = ${psSingleQuote(title)}`,
    ];
    if (initialDir) lines.push(`$dlg.SelectedPath = ${psSingleQuote(initialDir)}`);
    lines.push('$result = $dlg.ShowDialog()');
    lines.push("if ($result -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dlg.SelectedPath }");

    const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', lines.join('; ')], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0 && stderr.trim()) {
        reject(new Error(stderr.trim()));
        return;
      }
      const out = stdout.trim();
      resolve(out.length > 0 ? out : null);
    });
  });
}

module.exports = { pickOpenFile, pickSaveFile, pickFolderAsync };
