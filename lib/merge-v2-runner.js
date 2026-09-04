'use strict';
// Merge Plugins v2 -- spawns lib/merge-v2-worker.js in its own isolated child process (xelib can't be
// re-initialised in-process; a native crash in the worker must not take down the server). Originally
// a NEW file rather than an edit to the now-deleted lib/merge-runner.js, per the director's own
// "build alongside, don't touch the old files" instruction (2026-08-24) -- the same isolation pattern
// was reused, that file itself was left untouched. Now the sole runner for both real merges
// (mergePluginsV2) and the Review step's analyze preview (analyzePluginsV2, 2026-08-25 -- see
// lib/merge-v2-worker.js's own runAnalyzeV2 for that port's own header), once lib/merge-runner.js/
// lib/merge-worker.js were fully retired.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const appConfig = require('./app-config');
const { describeDanglingFormidCrash } = require('./dangling-formid-attribution');

const WORKER_PATH = path.join(__dirname, 'merge-v2-worker.js');
const MERGE_OP_TIMEOUT_MS = 10 * 60 * 1000;

const CRASH_HELP_TEXT = 'Something went wrong while reading or merging these plugins (v2 engine).';
const TIMEOUT_HELP_TEXT = 'This merge is taking far longer than expected and was stopped.';

// ---- Failure diagnostics (2026-08-26, ported from the old v1 lib/merge-runner.js -- see that
// file's own "Failure diagnostics (2026-08-23)" header comment, preserved verbatim below) ----------
// This fix existed for v1 (deleted 2026-08-25 when analyzePlugins was ported onto this v2 engine, see
// commit e98984e) but was never carried over -- a v2 crash went right back to being undiagnosable
// unless the server happened to be running in a visible terminal. Same gap, same fix, same file this
// time: CRASH_HELP_TEXT above is deliberately all the USER ever sees; the real explanation now also
// lands in a plain .log file under the app's own logs folder, alongside every other tool's, rather
// than only console.error (which doesn't exist at all for anyone running the tray launcher).
//
// The xelib log tail is the important half -- confirmed real for the original v1 case (2026-08-23):
// the worker's own stderr carried only "Loader failed:", while the line that actually identified the
// culprit ("Exception loading BHTNFX.esp: System Error. Code: 2.") existed nowhere but xelib_log.txt,
// which xelib writes next to the process working directory and overwrites on every subsequent run.
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
// or null. Same 'merge-plugins' logs subfolder v1 used -- Merge History/other readers of that folder
// don't care which engine produced a given failure log.
// A native crash (this file's whole reason for existing) can leave raw NUL bytes in the worker's
// captured stderr or in xelib's own log file -- confirmed real, 2026-08-27: several old logs from
// the since-retired v1 engine had a literal run of NUL bytes where a crashed native buffer got
// captured mid-write. A NUL byte is still technically valid UTF-8 (Node writes the file fine), but
// most text editors -- VS Code included -- treat ANY NUL byte anywhere in a file as "this is
// binary" and refuse to render it as text at all, defeating the entire point of a log meant to be
// read. Stripped here, once, right before anything is ever written -- not upstream in the
// worker/xelib-tail readers, since "don't let an unreadable byte reach disk" is this function's own
// job, not theirs.
function stripNulBytes(text) {
    return typeof text === 'string' ? text.split(String.fromCharCode(0)).join('') : text;
}

function writeFailureLog({ mode, itemCount, exitCode, signal, stderrTail, xelibTail }) {
    try {
        const dir = appConfig.getLogsDir('merge-plugins');
        fs.mkdirSync(dir, { recursive: true });
        const logPath = path.join(dir, `merge-failure-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
        const cleanStderrTail = stripNulBytes(stderrTail);
        const cleanXelibTail = stripNulBytes(xelibTail);
        const lines = [
            'Merge Plugins (v2 engine) -- failure diagnostics',
            `When:      ${new Date().toISOString()}`,
            `Mode:      ${mode || 'merge'}`,
            `Plugins:   ${itemCount}`,
            `Exit code: ${exitCode}${signal ? ` (signal ${signal})` : ''}`,
            '',
            'Worker output:',
            cleanStderrTail ? cleanStderrTail.trim() : '  (none)',
            '',
            'xelib log (last lines) -- the engine\'s own account of what it was loading when it stopped:',
            cleanXelibTail || '  (the engine wrote no log for this run -- it stopped before loading began)',
            '',
        ];
        fs.writeFileSync(logPath, lines.join('\r\n'), 'utf8');
        return logPath;
    } catch {
        return null;
    }
}

function runMergeV2Isolated(input, onProgress) {
    return new Promise((resolve, reject) => {
        const startedAt = Date.now();
        const child = spawn(process.execPath, [WORKER_PATH], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        let stdout = '';
        let stderrTail = '';
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; child.kill(); }, MERGE_OP_TIMEOUT_MS);

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
                        } catch { /* malformed progress line -- not fatal */ }
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
            // newline would otherwise sit here forever and never reach stderrTail (same real gap
            // v1 hit 2026-07-28).
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
                try { resolve(JSON.parse(stdout)); }
                catch (e) { reject(new Error(`Merge v2 worker produced invalid output: ${e.message}`)); }
                return;
            }
            const trimmed = stderrTail.trim();
            const USERERR_PREFIX = '##USERERR## ';
            if (signal !== 'SIGTERM' && trimmed.startsWith(USERERR_PREFIX)) {
                reject(new Error(trimmed.slice(USERERR_PREFIX.length)));
                return;
            }
            // Both destinations, not one instead of the other: console.error still helps anyone
            // running from a terminal, and the log file covers everyone who isn't.
            const xelibTail = readXelibLogTail(startedAt);
            const logPath = writeFailureLog({
                mode: input.mode, itemCount: (input.items || []).length, exitCode: code,
                signal, stderrTail, xelibTail,
            });
            console.error(`[merge-v2-runner] worker exited ${code}${signal ? ` (signal ${signal})` : ''}: ${trimmed}`);
            if (logPath) console.error(`[merge-v2-runner] details written to ${logPath}`);
            // Dangling-FormID crash (2026-08-27, diagnostics/dangling-formid-merge-crash/root-cause-
            // findings-2026-08-26.md) -- ONE confirmed real crash class turned into an honest, specific
            // message instead of the generic catch-all. Merge only, never Analyze (input.mode ===
            // 'analyze') -- that path structurally never resolves references deeply enough to hit this
            // (see the findings doc's own "Why Review/Analyze doesn't hit this at all" section); the
            // mode check here is a defensive belt-and-suspenders on top of that, not a load-bearing gate.
            // Purely additive: describeDanglingFormidCrash returns null for any OTHER crash cause, and
            // CRASH_HELP_TEXT below is unchanged for that case -- this never replaces the catch-all.
            if (input.mode !== 'analyze') {
                const dangling = describeDanglingFormidCrash(xelibTail, input.items);
                if (dangling) {
                    reject(new Error(dangling.message));
                    return;
                }
            }
            reject(new Error(CRASH_HELP_TEXT));
        });
        child.stdin.write(JSON.stringify(input));
        child.stdin.end();
    });
}

function mergePluginsV2(items, outputPath, gameDataDir, mergeName, method, onProgress) {
    return runMergeV2Isolated({ items, outputPath, gameDataDir, mergeName, method }, onProgress);
}

// analyzePluginsV2 (2026-08-25, merge-v1-analyze-port) -- the Review step's read-only preview,
// finally on the v2 engine. Replaces lib/merge-runner.js's own analyzePlugins (that file, and
// lib/merge-worker.js, are deleted in the same change that adds this) -- same isolated-child-process
// call shape, just a different `mode` in the input this worker's own main() dispatches on.
function analyzePluginsV2(items, gameDataDir) {
    return runMergeV2Isolated({ mode: 'analyze', items, gameDataDir });
}

module.exports = { mergePluginsV2, analyzePluginsV2 };
