'use strict';
// Framework-agnostic orchestration for the Rules Generator flow, used by
// web/rules-generator-routes.js -- mirrors lib/sync-runner.js's own contract exactly: nothing
// here touches console/req/res, callers own all presentation.

const path = require('path');
const { spawn } = require('child_process');

const WORKER_PATH = path.join(__dirname, 'rules-generator-worker.js');
const OP_TIMEOUT_MS = 30_000;

const CRASH_HELP_TEXT =
    "Couldn't read Vortex's database for this. Make sure Vortex is fully closed and try again -- " +
    'if it keeps happening, a Windows error dialog may be open and hidden behind other windows ' +
    '(check your taskbar).';

const TIMEOUT_HELP_TEXT =
    'This is taking too long -- this usually means a Windows error dialog is open and hidden ' +
    'behind other windows. Check your taskbar, close it, then try again.';

function runIsolated(input) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [WORKER_PATH], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill();
        }, OP_TIMEOUT_MS);

        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });
        child.on('error', (e) => { clearTimeout(timer); reject(e); });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (timedOut) {
                reject(new Error(TIMEOUT_HELP_TEXT));
                return;
            }
            if (code === 0) {
                try {
                    resolve(JSON.parse(stdout));
                } catch (e) {
                    reject(new Error(`Rules Generator worker produced invalid output: ${e.message}`));
                }
                return;
            }
            const message = stderr.trim();
            if (message) console.error(`[rules-generator-runner] worker exited ${code}: ${message}`);
            // A genuine, specific error from the worker (e.g. "collection not found") is more
            // useful surfaced directly than papered over with the generic crash text -- only fall
            // back to CRASH_HELP_TEXT when stderr has nothing actionable in it.
            reject(new Error(message || CRASH_HELP_TEXT));
        });
        child.stdin.write(JSON.stringify(input));
        child.stdin.end();
    });
}

async function listWorkshopCollections(stateDir) {
    const { collections } = await runIsolated({ stateDir, mode: 'list-workshop-collections' });
    return collections;
}

async function analyze(stateDir, oldCollectionKey, newCollectionKey) {
    return runIsolated({ stateDir, mode: 'analyze', oldCollectionKey, newCollectionKey });
}

// Completed/Exceptions report -- read-only. anomalyOverrides lets an already-resolved "Needs your
// input" pick count as Completed rather than an Exception.
async function report(stateDir, oldCollectionKey, newCollectionKey, anomalyOverrides) {
    return runIsolated({ stateDir, mode: 'report', oldCollectionKey, newCollectionKey, anomalyOverrides });
}

// Read-only dry run -- an accurate count for the confirm dialog, no writes. Same
// oldCollectionKey/newCollectionKey plus the frontend's current per-row overrides
// (ruleOverrides: `${newModKey}::${ruleIdx}` -> type; anomalyOverrides: modKey -> picked
// candidate index).
async function applyPreview(stateDir, oldCollectionKey, newCollectionKey, ruleOverrides, anomalyOverrides) {
    return runIsolated({ stateDir, mode: 'apply-preview', oldCollectionKey, newCollectionKey, ruleOverrides, anomalyOverrides });
}

// The real write -- opens Vortex's LIVE state.v2 (full backup taken first, refuses if Vortex is
// running). Same params as applyPreview.
async function apply(stateDir, oldCollectionKey, newCollectionKey, ruleOverrides, anomalyOverrides) {
    return runIsolated({ stateDir, mode: 'apply-write', oldCollectionKey, newCollectionKey, ruleOverrides, anomalyOverrides });
}

module.exports = { listWorkshopCollections, analyze, report, applyPreview, apply };
