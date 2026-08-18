// Native Windows file/folder dialogs, via a spawned PowerShell WinForms dialog.
// Used by the interactive menu (and, for pickFolderAsync, the Settings page's own "Browse..."
// buttons) so paths never have to be typed by hand.

const { spawn, spawnSync } = require('child_process');

function psSingleQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

// A dialog shown via plain $dlg.ShowDialog() has no owner window, so Windows' focus-stealing
// prevention can leave it opening BEHIND whatever window already has focus (the browser, most
// often) instead of on top -- confirmed live, and TopMost alone (tried first) wasn't enough to fix
// it either: TopMost only affects z-order, not actual input focus, and Windows' foreground-lock
// mechanism still refuses to let a spawned background process (this PowerShell instance, launched
// by Node -- never itself the foreground app) call SetForegroundWindow directly. The real fix needs
// the standard bypass for that lock: temporarily attach this thread's input queue to whatever
// window currently has focus, which grants the exemption needed to legitimately hand focus over,
// then detach again immediately. Off-screen + zero size + Opacity 0 + no taskbar entry so the owner
// itself is never visible or clickable, only exists to hold the TopMost flag + a real window handle.
const OWNER_FORM_LINES = [
  'Add-Type -MemberDefinition \'' +
    '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); ' +
    '[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId); ' +
    '[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach); ' +
    '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd); ' +
    '[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();' +
    '\' -Name NativeMethods -Namespace VortexToolsWin32 -PassThru | Out-Null',
  '$__owner = New-Object System.Windows.Forms.Form',
  "$__owner.StartPosition = 'Manual'",
  // Confirmed live: an owner at extreme off-screen coordinates (-2000,-2000) left the real dialog
  // in a broken state where a single click on its title bar closed it outright (no drag needed,
  // no Cancel/X click -- ShowDialog() then never returns, hanging the whole request forever).
  // On-screen at (0,0) with Size(1,1) + Opacity 0 is still completely invisible/unclickable, but
  // doesn't confuse whatever positioning/centering logic the real dialog uses relative to its owner.
  '$__owner.Location = New-Object System.Drawing.Point(0, 0)',
  '$__owner.Size = New-Object System.Drawing.Size(1, 1)',
  '$__owner.Opacity = 0',
  '$__owner.ShowInTaskbar = $false',
  '$__owner.TopMost = $true',
  '$__owner.Show() | Out-Null',
  '$__fgWin = [VortexToolsWin32.NativeMethods]::GetForegroundWindow()',
  '$__fgThread = [VortexToolsWin32.NativeMethods]::GetWindowThreadProcessId($__fgWin, [ref]0)',
  '$__curThread = [VortexToolsWin32.NativeMethods]::GetCurrentThreadId()',
  '[VortexToolsWin32.NativeMethods]::AttachThreadInput($__curThread, $__fgThread, $true) | Out-Null',
  '[VortexToolsWin32.NativeMethods]::SetForegroundWindow($__owner.Handle) | Out-Null',
  '[VortexToolsWin32.NativeMethods]::AttachThreadInput($__curThread, $__fgThread, $false) | Out-Null',
];

function showDialog({ save, title, initialDir, filter, defaultFileName }) {
  const dialogType = save ? 'SaveFileDialog' : 'OpenFileDialog';
  const lines = [
    'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
    ...OWNER_FORM_LINES,
    `$dlg = New-Object System.Windows.Forms.${dialogType}`,
    `$dlg.Title = ${psSingleQuote(title || '')}`,
  ];
  if (initialDir) lines.push(`$dlg.InitialDirectory = ${psSingleQuote(initialDir)}`);
  if (filter) lines.push(`$dlg.Filter = ${psSingleQuote(filter)}`);
  if (defaultFileName) lines.push(`$dlg.FileName = ${psSingleQuote(defaultFileName)}`);
  lines.push('$result = $dlg.ShowDialog($__owner)');
  lines.push('$__owner.Close()');
  lines.push("if ($result -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dlg.FileName }");

  const res = spawnSync('powershell.exe', ['-NoProfile', '-STA', '-Command', lines.join('; ')], {
    encoding: 'utf8', windowsHide: true,
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

// Shared by pickFolderAsync/pickOpenFileAsync below. DIALOG_TIMEOUT_MS is a safety net, not an
// expected-latency limit -- confirmed live this session that a single click on the real dialog's
// title bar could close it in a way ShowDialog() never returns from at all, leaving the spawned
// PowerShell process alive (Responding: True, just permanently stuck) and the calling HTTP request
// pending forever with no way for the UI to recover. 10 minutes is deliberately generous (a real
// user genuinely browsing for a file shouldn't ever hit it) -- it exists purely so a repeat of that
// bug (or any other hang) can't wedge the button/request permanently; the process is killed and the
// promise rejects with a clear, recoverable error instead.
const DIALOG_TIMEOUT_MS = 10 * 60 * 1000;

function spawnDialogPowerShell(lines) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', lines.join('; ')], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`Dialog process did not respond within ${DIALOG_TIMEOUT_MS / 1000}s -- it may have been closed in a stuck state. Try again.`));
    }, DIALOG_TIMEOUT_MS);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0 && stderr.trim()) {
        reject(new Error(stderr.trim()));
        return;
      }
      const out = stdout.trim();
      resolve(out.length > 0 ? out : null);
    });
  });
}

// Async folder picker -- deliberately spawn(), not spawnSync(), unlike the two sync functions
// above. Those are only ever called from the interactive CLI menu, where blocking the
// single-purpose terminal process for as long as the dialog is open is a non-issue. This one is
// called from an Express route handler in a long-running web server -- a synchronous block there
// would freeze the ENTIRE app (every other request, every open SSE stream) for as long as the user
// takes to pick a folder, the same class of bug this project already fixed once for extract-mod.js's
// own child-process calls (see rebuild-mod.js's runExtract comment).
//
// Deliberately does NOT use WinForms' own FolderBrowserDialog class. Confirmed live: under classic
// Windows PowerShell (.NET Framework, what powershell.exe is), FolderBrowserDialog still renders as
// the decades-old SHBrowseForFolder tree view (no address bar, no search, tiny fixed size) -- it
// never got the modern Explorer-style redesign that shipped for OpenFileDialog/SaveFileDialog
// (those wrap the newer IFileDialog COM API on modern Windows). That mismatch was jarring: the
// Settings page's folder Browse buttons looked like a completely different, much older app than
// Rebuild Collection's own file-picker (the off-site "Import" button, via pickOpenFileAsync below).
// Fix: drive that SAME modern OpenFileDialog in "pick a folder" mode instead -- a long-standing,
// widely-used technique (CheckFileExists off + ValidateNames off lets the user click Open after
// just navigating into a folder, without selecting a real file; the chosen folder is then whatever
// directory that placeholder "file" would have lived in).
function pickFolderAsync({ title = 'Select a folder', initialDir } = {}) {
  const lines = [
    'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
    ...OWNER_FORM_LINES,
    '$dlg = New-Object System.Windows.Forms.OpenFileDialog',
    `$dlg.Title = ${psSingleQuote(title)}`,
    '$dlg.CheckFileExists = $false',
    '$dlg.CheckPathExists = $true',
    '$dlg.ValidateNames = $false',
    '$dlg.Multiselect = $false',
    `$dlg.FileName = ${psSingleQuote('Folder Selection.')}`,
    `$dlg.Filter = ${psSingleQuote('Folders|*.no-real-files-match-this-placeholder-filter')}`,
  ];
  if (initialDir) lines.push(`$dlg.InitialDirectory = ${psSingleQuote(initialDir)}`);
  lines.push('$result = $dlg.ShowDialog($__owner)');
  lines.push('$__owner.Close()');
  lines.push("if ($result -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output ([System.IO.Path]::GetDirectoryName($dlg.FileName)) }");
  return spawnDialogPowerShell(lines);
}

// Async file-open picker, same non-blocking spawn() reasoning as pickFolderAsync above (this is
// called from an Express route, not the interactive CLI menu) -- used by the off-site "Import"
// button so the user can point at an archive file wherever they actually saved it, instead of
// having to move it into the downloads folder by hand first.
function pickOpenFileAsync({ title = 'Select a file', initialDir, filter = 'All files (*.*)|*.*' } = {}) {
  const lines = [
    'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
    ...OWNER_FORM_LINES,
    '$dlg = New-Object System.Windows.Forms.OpenFileDialog',
    `$dlg.Title = ${psSingleQuote(title)}`,
    `$dlg.Filter = ${psSingleQuote(filter)}`,
  ];
  if (initialDir) lines.push(`$dlg.InitialDirectory = ${psSingleQuote(initialDir)}`);
  lines.push('$result = $dlg.ShowDialog($__owner)');
  lines.push('$__owner.Close()');
  lines.push("if ($result -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dlg.FileName }");
  return spawnDialogPowerShell(lines);
}

module.exports = { pickOpenFile, pickSaveFile, pickFolderAsync, pickOpenFileAsync };
