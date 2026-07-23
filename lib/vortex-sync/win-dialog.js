// Native Windows file dialogs, via a spawned PowerShell WinForms dialog.
// Used by the interactive menu so paths never have to be typed by hand.

const { spawnSync } = require('child_process');

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

module.exports = { pickOpenFile, pickSaveFile };
