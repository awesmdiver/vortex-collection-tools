'use strict';
// Merge Plugins (The Forge) -- spawns lib/merge-worker.js in its own isolated child process for
// every analyze/merge request, mirroring lib/sync-runner.js's runIsolatedSyncOp (same "a native
// crash in the worker must not take down the whole app" reasoning, doubly true here since xelib
// cannot even be safely re-initialized twice in one process -- see the Part A spike findings in
// TECHNICAL.md's "Merge engine" section).

const { spawn } = require('child_process');
const path = require('path');

const WORKER_PATH = path.join(__dirname, 'merge-worker.js');
const MERGE_OP_TIMEOUT_MS = 10 * 60 * 1000; // a large collection's worth of plugins can take a while

const CRASH_HELP_TEXT = 'Something went wrong while reading or merging these plugins. ' +
    'Close and reopen the app, then try again with a smaller selection to narrow down which plugin is causing it.';
const TIMEOUT_HELP_TEXT = 'This merge is taking far longer than expected and was stopped. ' +
    'Try again with fewer plugins selected.';

// onProgress: optional (current, total, label) callback, called live as '##PROGRESS## ' lines
// arrive on the worker's stderr -- only meaningful for mode: 'merge' (analyze doesn't report
// progress, it's fast enough not to need it).
function runIsolatedMergeOp(input, onProgress) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [WORKER_PATH], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        let stdout = '';
        let stderrTail = '';
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill();
        }, MERGE_OP_TIMEOUT_MS);

        let stderrBuffer = '';
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => {
            stderrBuffer += d.toString();
            let idx;
            while ((idx = stderrBuffer.indexOf('\n')) !== -1) {
                const line = stderrBuffer.slice(0, idx);
                stderrBuffer = stderrBuffer.slice(idx + 1);
                if (line.startsWith('##PROGRESS## ')) {
                    if (onProgress) {
                        try {
                            const { current, total, label } = JSON.parse(line.slice('##PROGRESS## '.length));
                            onProgress(current, total, label);
                        } catch { /* malformed progress line -- skip it, not fatal */ }
                    }
                } else if (line.trim()) {
                    stderrTail += line + '\n';
                }
            }
        });
        child.on('error', (e) => { clearTimeout(timer); reject(e); });
        child.on('close', (code, signal) => {
            clearTimeout(timer);
            // Flush whatever's left in the line buffer -- a final error line with no trailing
            // newline would otherwise sit here forever and never reach stderrTail (confirmed real
            // 2026-07-28: this exact gap swallowed a genuine per-plugin error message). Belt and
            // suspenders alongside the worker's own fix to always terminate its error write with \n.
            if (stderrBuffer.trim()) stderrTail += stderrBuffer.trim() + '\n';
            if (timedOut) {
                reject(new Error(TIMEOUT_HELP_TEXT));
                return;
            }
            if (code === 0) {
                try {
                    resolve(JSON.parse(stdout));
                } catch (e) {
                    reject(new Error(`Merge worker produced invalid output: ${e.message}`));
                }
                return;
            }
            // A real, specific error message (e.g. the filename-collision check, or "no plugins
            // provided") is thrown as a plain Error in the worker and lands here as stderr text --
            // surface that directly rather than the generic crash text, same distinction
            // sync-runner.js's own CRASH_HELP_TEXT makes (only a genuine unexpected/native failure
            // gets the generic message).
            const message = stderrTail.trim();
            if (message && signal !== 'SIGTERM') {
                reject(new Error(message));
                return;
            }
            console.error(`[merge-runner] worker exited ${code}${signal ? ` (signal ${signal})` : ''}: ${stderrTail.trim()}`);
            reject(new Error(CRASH_HELP_TEXT));
        });
        child.stdin.write(JSON.stringify(input));
        child.stdin.end();
    });
}

// gameDataDir (the user's real Skyrim Data folder) lets the worker stage REAL base-game masters
// (hardlinked, not copied -- see merge-worker.js's stageMaster) instead of zero-record dummy stubs.
// A dummy is enough for xelib's own loader, but not enough for copyElement/addRequiredMasters on a
// "new" record that references an actual FormID inside that master (confirmed real 2026-07-28 -- an
// HDPT record's Extra Part list pointing into Skyrim.esm).
function analyzePlugins(items, gameDataDir) {
    return runIsolatedMergeOp({ mode: 'analyze', items, gameDataDir });
}

function mergePlugins(items, outputPath, lightPluginLimit, gameDataDir, onProgress) {
    return runIsolatedMergeOp({ mode: 'merge', items, outputPath, lightPluginLimit, gameDataDir }, onProgress);
}

module.exports = { analyzePlugins, mergePlugins };
