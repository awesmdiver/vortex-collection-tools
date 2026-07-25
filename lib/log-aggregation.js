'use strict';
// Shared, framework-agnostic log-file aggregation -- reused by web/stats-routes.js (Stats Report's
// "Current Issues") and web/work-through-routes.js (Work Through Report) so both always show the
// EXACT same population of "current problem mods." Extracted from what used to be inline in
// stats-routes.js -- keeping this as one function both callers import, instead of two independently
// -evolving copies, is what guarantees they can never drift apart on what counts as a current issue.

const fs = require('fs');
const path = require('path');

const NON_ACTIONABLE = new Set(['SKIP_IGNORED', 'SKIP_OPTIONAL_NOT_INSTALLED']);

// Reads every log file in logsDir, tagging each with its own filename. One unreadable/corrupt file
// is skipped, not fatal to the whole read.
function readAllLogs(logsDir) {
    let files;
    try {
        files = fs.readdirSync(logsDir).filter((f) => f.endsWith('.json'));
    } catch {
        return [];
    }
    const logs = [];
    for (const f of files) {
        try {
            logs.push({ file: f, ...JSON.parse(fs.readFileSync(path.join(logsDir, f), 'utf8')) });
        } catch {
            // skip -- one bad log shouldn't break the whole report
        }
    }
    return logs;
}

// "What's wrong right now" snapshot -- the LATEST non-dry-run log per collection, deliberately
// broader than rebuild-routes.js's own findLastExtracted() (which requires runStatus === 'completed'
// strictly, correct for "last extracted" labels elsewhere): a collection stuck in halted-critical has
// exactly the problems this view exists to surface, more urgently than a clean completed run. Only
// excludes dry-run (never a real result) and in-progress (its mods array is still being written).
function getCurrentIssues(logsDir) {
    const all = readAllLogs(logsDir).filter((l) => l.runStatus !== 'dry-run-complete');

    const latestByCollection = new Map();
    for (const l of all) {
        if (l.runStatus !== 'completed' && l.runStatus !== 'halted-critical') continue;
        const existing = latestByCollection.get(l.collectionModId);
        if (!existing || new Date(l.startedAt) > new Date(existing.startedAt)) latestByCollection.set(l.collectionModId, l);
    }

    // Problem = not ignored/optional-not-installed and not a clean REBUILT -- i.e. FAILED_*,
    // CRITICAL_MANUAL_RESTORE_NEEDED, SKIP_NO_ARCHIVE, SKIP_OPEN_FOMOD.
    const collections = [...latestByCollection.values()]
        .map((log) => {
            const problemMods = (log.mods || []).filter((m) => !NON_ACTIONABLE.has(m.status) && m.status !== 'REBUILT');
            return {
                collectionModId: log.collectionModId, collectionName: log.collectionName,
                logFile: log.file, startedAt: log.startedAt, runStatus: log.runStatus,
                // targetFolderName included (beyond name/status/detail/modId/fileId) -- needed by
                // the Work Through Report / log-view page's resolvability checks (FAILED_MISMATCH_
                // NOT_TOUCHED needs a recorded targetFolderName to be resolvable via Extract all/
                // Keep modified).
                problemMods: problemMods.map((m) => ({
                    name: m.name, status: m.status, detail: m.detail, modId: m.modId, fileId: m.fileId,
                    targetFolderName: m.targetFolderName, offSite: m.offSite, sourceUrl: m.sourceUrl,
                    code: m.code, candidateFile: m.candidateFile, archiveNotFound: m.archiveNotFound,
                    candidateFiles: m.candidateFiles,
                })),
            };
        })
        .filter((c) => c.problemMods.length > 0)
        .sort((a, b) => b.problemMods.length - a.problemMods.length);

    return { collections };
}

module.exports = { NON_ACTIONABLE, readAllLogs, getCurrentIssues };
