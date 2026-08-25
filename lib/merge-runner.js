'use strict';
// Merge Plugins (The Forge) -- spawns lib/merge-worker.js in its own isolated child process for
// every analyze/merge request, mirroring lib/sync-runner.js's runIsolatedSyncOp (same "a native
// crash in the worker must not take down the whole app" reasoning, doubly true here since xelib
// cannot even be safely re-initialized twice in one process -- see the Part A spike findings in
// TECHNICAL.md's "Merge engine" section).

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const appConfig = require('./app-config');

const WORKER_PATH = path.join(__dirname, 'merge-worker.js');
const MERGE_OP_TIMEOUT_MS = 10 * 60 * 1000; // a large collection's worth of plugins can take a while

const CRASH_HELP_TEXT = 'Something went wrong while reading or merging these plugins. ' +
    'Close and reopen the app, then try again with a smaller selection to narrow down which plugin is causing it.';
const TIMEOUT_HELP_TEXT = 'This merge is taking far longer than expected and was stopped. ' +
    'Try again with fewer plugins selected.';

// ---- Failure diagnostics (2026-08-23) ----------------------------------------------------------
// The generic CRASH_HELP_TEXT above is deliberately all the USER ever sees (see the allowlist at the
// bottom of runIsolatedMergeOp -- raw engine text must never leak to the screen). The problem that
// caused: the real explanation went only to console.error, which does not exist at all for anyone
// running the tray launcher with no console window. A genuine merge failure was therefore
// undiagnosable unless someone happened to notice xelib_log.txt and read it by luck.
//
// Everything now lands in a plain .log file under the app's own logs folder instead, alongside every
// other tool's. Deliberately NOT .json: lib/log-aggregation.js's readAllLogs treats EVERY .json file
// in the logs area as a Rebuild Collection run log, so a .json here would quietly turn up in Stats
// Report's and Work Through Report's "Current Issues" as a malformed entry.
//
// The xelib log tail is the important half. The worker's own stderr carried only "Loader failed:" for
// the real 2026-08-23 failure, while the line that actually identified the culprit
// ("Exception loading BHTNFX.esp: System Error. Code: 2.") existed nowhere but xelib_log.txt, which
// xelib writes next to the process working directory and overwrites on every subsequent run.
const XELIB_LOG_TAIL_LINES = 80;

// startedAt guards against the genuinely misleading case: xelib_log.txt persists between runs, so a
// failure that happens BEFORE the loader ever starts (a staging error, say) would otherwise attach
// the PREVIOUS run's trace under a heading claiming it describes this one. Untouched since this run
// began means it isn't this run's log, and saying so plainly beats showing it.
function readXelibLogTail(startedAt) {
    const logPath = path.join(process.cwd(), 'xelib_log.txt');
    try {
        if (fs.statSync(logPath).mtimeMs < startedAt) return null;
        const text = fs.readFileSync(logPath, 'utf8');
        const lines = text.split(/\r?\n/).filter((l) => l.trim());
        return lines.slice(-XELIB_LOG_TAIL_LINES).join('\r\n');
    } catch {
        return null; // no xelib log at all (a failure before the loader ever ran) -- not itself a problem
    }
}

// Best-effort throughout: a diagnostics write must never turn a merge failure into a WORSE failure,
// so every step is wrapped and a write that can't happen is simply skipped. Returns the path written,
// or null.
function writeFailureLog({ mode, itemCount, exitCode, signal, stderrTail, xelibTail }) {
    try {
        const dir = appConfig.getLogsDir('merge-plugins');
        fs.mkdirSync(dir, { recursive: true });
        const logPath = path.join(dir, `merge-failure-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
        const lines = [
            'Merge Plugins -- failure diagnostics',
            `When:      ${new Date().toISOString()}`,
            `Mode:      ${mode}`,
            `Plugins:   ${itemCount}`,
            `Exit code: ${exitCode}${signal ? ` (signal ${signal})` : ''}`,
            '',
            'Worker output:',
            stderrTail ? stderrTail.trim() : '  (none)',
            '',
            'xelib log (last lines) -- the engine\'s own account of what it was loading when it stopped:',
            xelibTail || '  (the engine wrote no log for this run -- it stopped before loading began)',
            '',
        ];
        fs.writeFileSync(logPath, lines.join('\r\n'), 'utf8');
        return logPath;
    } catch {
        return null;
    }
}

// onProgress: optional (current, total, label) callback, called live as '##PROGRESS## ' lines
// arrive on the worker's stderr -- only meaningful for mode: 'merge' (analyze doesn't report
// progress, it's fast enough not to need it).
function runIsolatedMergeOp(input, onProgress) {
    return new Promise((resolve, reject) => {
        const startedAt = Date.now();
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
                } else if (line.startsWith('##WARN## ')) {
                    // The worker's own non-fatal cleanup warning (e.g. a locked sandbox dir) --
                    // never fatal, never user-facing (BUILD-PROMPT-merge-error-handling.md's whole
                    // reason for existing: this exact text once leaked to a tester's screen). Log
                    // for devs only, never add it to stderrTail.
                    console.error(`[merge-runner] ${line.slice('##WARN## '.length)}`);
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
                writeFailureLog({
                    mode: input.mode, itemCount: (input.items || []).length, exitCode: code,
                    signal, stderrTail, xelibTail: readXelibLogTail(startedAt),
                });
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
            // Allowlist, not a denylist (BUILD-PROMPT-merge-error-handling.md): only a message the
            // worker itself explicitly marked ##USERERR## (its own intentional, already-friendly
            // throws -- filename collision, "no plugins provided", etc., see merge-worker.js's
            // userError()) is ever surfaced verbatim. Everything else -- a native xelib error like
            // "Loader failed"/"CopyElement failed", an unmarked crash, or nothing at all -- falls
            // back to the generic CRASH_HELP_TEXT instead. Defensive by default: a future thrown
            // Error that forgets to mark itself user-facing safely falls back too, rather than
            // leaking raw text.
            const trimmed = stderrTail.trim();
            const USERERR_PREFIX = '##USERERR## ';
            if (signal !== 'SIGTERM' && trimmed.startsWith(USERERR_PREFIX)) {
                reject(new Error(trimmed.slice(USERERR_PREFIX.length)));
                return;
            }
            // Both destinations, not one instead of the other: console.error still helps anyone
            // running from a terminal, and the log file covers everyone who isn't.
            const logPath = writeFailureLog({
                mode: input.mode, itemCount: (input.items || []).length, exitCode: code,
                signal, stderrTail, xelibTail: readXelibLogTail(startedAt),
            });
            console.error(`[merge-runner] worker exited ${code}${signal ? ` (signal ${signal})` : ''}: ${trimmed}`);
            if (logPath) console.error(`[merge-runner] details written to ${logPath}`);
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

// residualDependents (optional): plugins outside this merge that still need one of the merged
// originals as a master, computed by the caller (web/merge-routes.js already has the staging/
// collections access this needs -- see its own /master-dependents route) -- purely for the merge
// log's own "heads up" section, doesn't change what actually gets merged.
function mergePlugins(items, outputPath, lightPluginLimit, gameDataDir, onProgress, residualDependents) {
    return runIsolatedMergeOp({ mode: 'merge', items, outputPath, lightPluginLimit, gameDataDir, residualDependents }, onProgress);
}

module.exports = { analyzePlugins, mergePlugins };
