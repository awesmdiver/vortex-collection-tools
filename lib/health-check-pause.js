'use strict';
// Pauses Vortex's Health Check (Settings > Health Check (Beta)) for the length of a long job, then puts the
// person's own switches back exactly as they were.
//
// WHY: Vortex re-runs that check over the whole mod list on every mod install/enable/disable/remove and every
// change to the downloads list, so a big install sets off one check per item (the working theory for the Bridge
// timeouts on a large Update Collection). See the Bridge guide, recipe 11.
//
// SAFETY RULES (all load-bearing):
//  - The snapshot is written to disk BEFORE anything is changed, so a crash can never leave the switches off
//    with no record of what they were.
//  - Only the switches that were ON are turned off, and only those are turned back on. We never assume a
//    default: the snapshot is exactly what Vortex reported.
//  - Restore runs in a `finally` (also on failure/cancel). If it fails, the snapshot file is KEPT and the next
//    start of the tool tries again (recoverPendingSnapshot), but only while the switches still read as off, so a
//    change the person made in between is never overwritten.
//  - One pause per run. A call made while another pause is open (nested, or a second job at the same time) joins
//    it and only the last one out restores.
//  - Anything unavailable (setting off, old Bridge, Vortex without a Health Check, failed read) means "no
//    pause": the work itself still runs.

const fs = require('fs');
const path = require('path');

const SWITCHES = ['modRequirementsEnabled', 'fileRequirementsEnabled'];

const PAUSED_LINE = "Vortex's Health Check is paused until this finishes";
const RESTORE_FAILED_LINE = "⚠️ We couldn't switch Vortex's Health Check back on. Open Vortex, go to Settings, then Health Check, and turn it back on. We'll try again the next time this tool starts.";

function defaultSnapshotPath() {
    return path.join(__dirname, '..', 'config', 'health-check-snapshot.json');
}

function readSnapshotFile(file) {
    try {
        const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!snap || typeof snap !== 'object') return null;
        const on = {};
        let any = false;
        for (const k of SWITCHES) { if (snap[k] === true) { on[k] = true; any = true; } }
        return any ? on : null;
    } catch {
        return null;
    }
}

function removeFile(file) {
    try { fs.unlinkSync(file); } catch { /* already gone */ }
}

// `bridge` needs getBridgeHealth, bridgeHasHealthCheckRoutes, getHealthCheckSettings, setHealthCheckSettings
// (the real vortex-bridge-client has all four). `isEnabled` is read fresh at every job start.
function createHealthCheckPauser({ bridge, snapshotPath = defaultSnapshotPath(), isEnabled = () => true, log = console } = {}) {
    let count = 0;
    let ready = null; // resolves once the first entrant has finished pausing (or decided not to)
    let on = null; // switches we turned off, { modRequirementsEnabled?: true, fileRequirementsEnabled?: true }
    let paused = false;

    async function pause() {
        try {
            if (fs.existsSync(snapshotPath)) await recoverPendingSnapshot(); // a leftover from an earlier run goes first
            const health = await bridge.getBridgeHealth();
            if (!health || !bridge.bridgeHasHealthCheckRoutes(health.version)) return;
            const cur = await bridge.getHealthCheckSettings();
            if (!cur || cur.supported === false) return;
            const snap = {};
            for (const k of SWITCHES) if (cur[k] === true) snap[k] = true;
            if (Object.keys(snap).length === 0) return; // both already off: nothing to change
            try {
                fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
                fs.writeFileSync(snapshotPath, JSON.stringify({ ...snap, savedAt: new Date().toISOString() }));
            } catch (e) {
                log.warn(`[health-check-pause] could not save the snapshot (${e.message}) -- not pausing.`);
                return;
            }
            on = snap;
            const off = {};
            for (const k of Object.keys(snap)) off[k] = false;
            if (await bridge.setHealthCheckSettings(off)) {
                paused = true;
                log.log('[health-check-pause] Vortex Health Check paused.');
            } else {
                // The write may still have landed (a timeout means unknown): put it back right away.
                log.warn('[health-check-pause] could not confirm the pause -- putting the switches back.');
                await restore();
            }
        } catch (e) {
            log.warn(`[health-check-pause] pause skipped: ${e.message}`);
        }
    }

    // Returns true when nothing is left to put back.
    async function restore() {
        if (!on) return true;
        const back = { ...on };
        let ok = false;
        try { ok = await bridge.setHealthCheckSettings(back); } catch { ok = false; }
        if (ok) {
            removeFile(snapshotPath);
            log.log('[health-check-pause] Vortex Health Check restored.');
            on = null;
            paused = false;
            return true;
        }
        log.error('[health-check-pause] could not restore the Health Check switches; snapshot kept for the next start.');
        on = null;
        paused = false;
        return false;
    }

    // work: async () => any. opts.onPaused(line) fires once the pause is really in place; opts.onRestoreFailed(line)
    // if the switches could not be put back.
    async function withHealthCheckPaused(work, { onPaused, onRestoreFailed } = {}) {
        let enabled = false;
        try { enabled = count > 0 || isEnabled() !== false; } catch { enabled = false; }
        if (!enabled) return work();

        if (count === 0) {
            count = 1;
            ready = pause();
        } else {
            count += 1;
        }
        await ready;
        if (paused && onPaused) { try { onPaused(PAUSED_LINE); } catch { /* progress is best effort */ } }
        try {
            return await work();
        } finally {
            count -= 1;
            if (count === 0) {
                const restored = await restore();
                ready = null;
                if (!restored && onRestoreFailed) { try { onRestoreFailed(RESTORE_FAILED_LINE); } catch { /* best effort */ } }
            }
        }
    }

    // Run once at start: a snapshot left by a crash or a failed restore is put back, but only when the switches
    // still read as off.
    async function recoverPendingSnapshot() {
        const snap = readSnapshotFile(snapshotPath);
        if (!snap) { removeFile(snapshotPath); return false; }
        try {
            const health = await bridge.getBridgeHealth();
            if (!health || !bridge.bridgeHasHealthCheckRoutes(health.version)) return false; // Vortex not up yet: keep it
            const cur = await bridge.getHealthCheckSettings();
            if (!cur) return false; // keep the snapshot, try next start
            if (cur.supported === false) { removeFile(snapshotPath); return false; }
            const back = {};
            for (const k of Object.keys(snap)) if (cur[k] === false) back[k] = true; // never touch one that reads on
            if (Object.keys(back).length > 0 && !(await bridge.setHealthCheckSettings(back))) return false;
            removeFile(snapshotPath);
            log.log('[health-check-pause] restored the Health Check switches left off by an earlier run.');
            return Object.keys(back).length > 0;
        } catch (e) {
            log.warn(`[health-check-pause] recovery skipped: ${e.message}`);
            return false;
        }
    }

    return { withHealthCheckPaused, recoverPendingSnapshot, _state: () => ({ count, paused }) };
}

let defaultPauser = null;
function getDefaultPauser() {
    if (!defaultPauser) {
        defaultPauser = createHealthCheckPauser({
            bridge: require('./vortex-bridge-client'),
            // Read fresh at every job start, like the other per-run settings.
            isEnabled: () => require('./app-config').loadConfig().pauseVortexHealthCheck !== false,
        });
    }
    return defaultPauser;
}

function withHealthCheckPaused(work, opts) {
    return getDefaultPauser().withHealthCheckPaused(work, opts);
}

function recoverPendingSnapshot() {
    return getDefaultPauser().recoverPendingSnapshot();
}

module.exports = { createHealthCheckPauser, withHealthCheckPaused, recoverPendingSnapshot, PAUSED_LINE, RESTORE_FAILED_LINE };
