#!/usr/bin/env node
// Isolated child process for ALL Update-Collection state-DB operations -- both read-only dry-run
// previews AND real live writes. See lib/sync-runner.js's runIsolatedSyncOp for why this must run
// outside whatever process calls it (native LevelDB crash risk -- same rationale as
// lib/state-query-worker.js, which this mirrors). Deliberately a SEPARATE file from that worker:
// different protocol (mode-dispatched, not a collections batch), and deliberate blast-radius
// containment for the higher-stakes live-write modes (apply-ignores-write, apply-disables-write) --
// a bug here can never accidentally be exercised by a Rebuild Collection read, or vice versa.
//
// Protocol: reads one JSON line from stdin: { syncLibPath, stateDir, mode, ...params }.
// Writes one JSON line to stdout on success: whatever shape that mode's operation returns.
// A native crash during any DB open still fails the whole process (nothing can be salvaged once
// that happens) -- surfaced to the parent as a non-zero/abnormal exit, same as state-query-worker.js.

function readStdin() {
    return new Promise((resolve, reject) => {
        let data = '';
        process.stdin.on('data', (c) => { data += c; });
        process.stdin.on('end', () => resolve(data));
        process.stdin.on('error', reject);
    });
}

async function main() {
    const input = JSON.parse(await readStdin());
    const { syncLibPath, stateDir, mode } = input;
    const syncLib = require(syncLibPath);

    let result;
    switch (mode) {
        case 'list-profiles': {
            result = await syncLib.withStateDb(stateDir, async (db) => ({
                profiles: await syncLib.listProfiles(db),
                lastActiveProfileId: await syncLib.getLastActiveProfileId(db),
            }));
            break;
        }
        // Read-only report, callable any time regardless of workflow phase -- mirrors sync-cli.js's
        // own list-ignored command.
        case 'list-ignored': {
            const { modId } = input;
            result = await syncLib.withStateDb(stateDir, async (db) => {
                const rules = await syncLib.getRules(db, modId);
                return { ignored: syncLib.extractIgnored(rules) };
            });
            break;
        }
        // Read-only report, callable any time -- mirrors sync-cli.js's own list-disabled command.
        case 'list-disabled': {
            const { modId, profileId } = input;
            result = await syncLib.withStateDb(stateDir, async (db) => {
                const rules = await syncLib.getRules(db, modId);
                const all = await syncLib.getDisabledInstalledMods(db, profileId);
                return { disabled: syncLib.filterToCollectionMembers(all, rules) };
            });
            break;
        }
        // Phase 1 -- run BEFORE clicking "Update" on a collection in Vortex. Read-only.
        case 'backup-capture': {
            const { collectionModId, profileId, stagingDir } = input;
            result = await syncLib.withStateDb(stateDir, async (db) => {
                const rules = await syncLib.getRules(db, collectionModId);
                const ignored = syncLib.extractIgnored(rules);
                let disabled = [];
                let profileName;
                if (profileId) {
                    const profiles = await syncLib.listProfiles(db);
                    profileName = profiles.find((p) => p.profileId === profileId)?.name;
                    const disabledRaw = await syncLib.getDisabledInstalledMods(db, profileId);
                    disabled = syncLib.filterToCollectionMembers(disabledRaw, rules);
                    if (stagingDir) disabled = syncLib.attachPluginFiles(disabled, stagingDir);
                }
                return { ignored, disabled, profileName };
            });
            break;
        }
        // Phase 2 dry-run -- read-only, via the safe temp-copy path.
        case 'apply-ignores-preview': {
            const { modId, ignoredRefs } = input;
            result = await syncLib.withStateDb(stateDir, async (db) => {
                const rules = await syncLib.getRules(db, modId);
                const { changed, unmatched, identityWarning } = syncLib.applyIgnoresToRules(rules, ignoredRefs);
                return { changed, unmatched, identityWarning };
            });
            break;
        }
        // Phase 2 real write -- opens Vortex's LIVE state.v2 directly. withLiveStateDb takes a full
        // state.v2 backup first and refuses if Vortex is running or the backup is incomplete.
        case 'apply-ignores-write': {
            const { modId, ignoredRefs } = input;
            result = await syncLib.withLiveStateDb(stateDir, async (db) => await syncLib.writeIgnoredFlags(db, modId, ignoredRefs));
            break;
        }
        // Phase 3 dry-run -- read-only. Can only meaningfully run AFTER Resume (a dependent mod's
        // id doesn't exist in state until Vortex actually installs it), but nothing here enforces
        // that -- it will just find fewer/zero matches if run too early, which the caller surfaces.
        case 'apply-disables-preview': {
            const { disabledRefs } = input;
            result = await syncLib.withStateDb(stateDir, async (db) => {
                const { results: matches, identityWarning } = await syncLib.findCurrentModIdsChecked(db, disabledRefs);
                return { matches, identityWarning };
            });
            break;
        }
        // Phase 3 real write -- same live-state safety wrapper as apply-ignores-write.
        case 'apply-disables-write': {
            const { profileId, disabledRefs } = input;
            result = await syncLib.withLiveStateDb(stateDir, async (db) => {
                const { results: matches, identityWarning } = await syncLib.findCurrentModIdsChecked(db, disabledRefs);
                return { changed: await syncLib.writeDisabledFlags(db, profileId, matches), identityWarning };
            });
            break;
        }
        // Restores a previous state.v2 backup over the live directory -- the restore half of the
        // safety net backupLiveState (used by every write mode above) exists to provide. Same
        // isolated-process treatment as any other live-state operation for consistency, even though
        // this one is pure filesystem copying with no ClassicLevel open of its own.
        case 'restore-state': {
            const { backupDir } = input;
            result = syncLib.restoreLiveState(stateDir, backupDir);
            break;
        }
        default:
            throw new Error(`Unknown state-write-worker mode: "${mode}"`);
    }

    process.stdout.write(JSON.stringify(result));
}

main().catch((e) => {
    process.stderr.write(e.message || String(e));
    process.exit(1);
});
