'use strict';
// Merge Plugins v2 -- spawns lib/merge-v2-worker.js in its own isolated child process, same
// isolation pattern as lib/merge-runner.js (xelib can't be re-initialised in-process; a native crash
// in the worker must not take down the server). A NEW file, not an edit to merge-runner.js, per the
// director's own "build alongside, don't touch the old files" instruction (2026-08-24) -- the pattern
// is reused, the file itself is not modified. WORKER_PATH below is the only real difference from that
// file's own runIsolatedMergeOp.

const { spawn } = require('child_process');
const path = require('path');

const WORKER_PATH = path.join(__dirname, 'merge-v2-worker.js');
const MERGE_OP_TIMEOUT_MS = 10 * 60 * 1000;

function runMergeV2Isolated(input, onProgress) {
    return new Promise((resolve, reject) => {
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
            if (stderrBuffer.trim()) stderrTail += stderrBuffer.trim() + '\n';
            if (timedOut) {
                reject(new Error('This merge is taking far longer than expected and was stopped.'));
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
            console.error(`[merge-v2-runner] worker exited ${code}${signal ? ` (signal ${signal})` : ''}: ${trimmed}`);
            reject(new Error('Something went wrong while reading or merging these plugins (v2 engine).'));
        });
        child.stdin.write(JSON.stringify(input));
        child.stdin.end();
    });
}

function mergePluginsV2(items, outputPath, gameDataDir, mergeName, onProgress) {
    return runMergeV2Isolated({ items, outputPath, gameDataDir, mergeName }, onProgress);
}

module.exports = { mergePluginsV2 };
