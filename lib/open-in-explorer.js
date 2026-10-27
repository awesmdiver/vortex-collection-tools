// Opens a folder in Explorer, or selects a file in it, without ever going through a shell.
//
// The path comes from a request body or a saved setting, so it is treated as plain data: it is
// passed to explorer.exe as an argument, never glued into a command string (a folder named
// `a" & calc & "` is a legal-looking name inside staging and used to start the second program).
// Windows file names cannot hold `"` or line breaks, so a path that does is refused outright.

const path = require('path');
const { spawn } = require('child_process');

function assertSafePath(p) {
    if (typeof p !== 'string' || p.length === 0) throw new Error('A path is required.');
    if (/["\r\n\0]/.test(p)) throw new Error('That path has characters a Windows path cannot hold.');
}

// Returns { args, options } for explorer.exe. Exposed so tests can assert exactly what would run.
function buildExplorerCall(targetPath, { select = false } = {}) {
    assertSafePath(targetPath);
    if (select) {
        // explorer.exe's own parser only recognises `/select,` when the quotes sit around the
        // path alone, so this one argument is built by hand and passed verbatim (no shell). The
        // path has no `"` (checked above), so it cannot close its own quotes early.
        return {
            args: [`/select,"${path.resolve(targetPath)}"`],
            options: { detached: true, stdio: 'ignore', windowsVerbatimArguments: true },
        };
    }
    return {
        args: [path.resolve(targetPath)],
        options: { detached: true, stdio: 'ignore' },
    };
}

function runExplorer(targetPath, opts) {
    const { args, options } = buildExplorerCall(targetPath, opts);
    const child = spawn('explorer.exe', args, options);
    child.on('error', () => {});
    child.unref();
}

function openFolderInExplorer(folderPath) {
    runExplorer(folderPath, { select: false });
}

function revealInExplorer(targetPath) {
    runExplorer(targetPath, { select: true });
}

module.exports = { buildExplorerCall, openFolderInExplorer, revealInExplorer };
