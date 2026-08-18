'use strict';
// Work Through Report backend -- an actionable variant of Stats Report's "Current Issues"
// (lib/log-aggregation.js's getCurrentIssues(), same underlying population, guaranteed to never
// drift from what Stats Report shows). Every problem mod is tagged one of two ways:
//   - resolvable: true  -- this tool can actually fix it (FAILED_MISMATCH_NOT_TOUCHED via the
//     existing /api/rebuild/logs/:filename/resolve-mismatch, or a Nexus-hosted SKIP_NO_ARCHIVE via
//     the new /api/rebuild/logs/:filename/retry-download). Resolving either mutates the log file
//     in place, so a fixed mod just stops appearing on the next /list read -- no completion state
//     to manage for these at all.
//   - resolvable: false -- everything else (SKIP_OPEN_FOMOD, CRITICAL_MANUAL_RESTORE_NEEDED,
//     FAILED_EXTRACTION_*, off-site SKIP_NO_ARCHIVE). These get a persisted manual "completed"
//     checkbox (lib/work-through-state.js) since there's no way for this tool to fix them itself.
//
// A separate file from web/stats-routes.js on purpose -- different concern (mutable completion
// state + a toggle action) and different action surface, matching this project's existing
// settings-routes.js-vs-rebuild-routes.js precedent of separate files per distinct concern even
// when related.

const express = require('express');
const { getCurrentIssues } = require('../lib/log-aggregation');
const { makeKey, setCompleted, pruneToKeys } = require('../lib/work-through-state');
const appConfig = require('../lib/app-config');

// A FAILED_EXTRACTION_* row with archiveNotFound is the SAME underlying problem as SKIP_NO_ARCHIVE
// (the archive genuinely isn't there), just discovered later, at actual extraction time instead of
// during classification (e.g. an Import'd/force-extracted file deleted again before the real run).
function isArchiveMissingStatus(m) {
    return m.status === 'SKIP_NO_ARCHIVE'
        || ((m.status === 'FAILED_EXTRACTION_NOT_TOUCHED' || m.status === 'FAILED_EXTRACTION_NO_PRIOR_DATA') && m.archiveNotFound);
}
// Two or more byte-identical duplicate files for the same mod, confirmed real-world ("Diverse
// 4thUnknown Dragons" had the exact same archive under two different filenames) -- resolvable
// in-tool via a "delete a duplicate" action, distinct from the generic Retry Download path (which
// would be pointless here -- the correct file is already present, just duplicated).
function isAmbiguous(m) {
    return m.status === 'SKIP_NO_ARCHIVE' && m.code === 'AMBIGUOUS' && Array.isArray(m.candidateFiles) && m.candidateFiles.length > 1;
}
function isResolvable(m) {
    // An off-site archive-missing row (source.type 'browse'/'direct'/'bundle') can never be
    // downloaded by this tool regardless -- excluded here so it falls into the Category B checkbox
    // path instead of offering a "Retry Download" button that would just fail with NOT_NEXUS every
    // time. The one off-site exception: a recorded hash-mismatch candidateFile (a real, same-size
    // file that just failed the md5 check) IS resolvable in-tool, via "Force Extract Anyway" --
    // SKIP_NO_ARCHIVE-only, since candidateFile is only ever recorded during classification.
    return (m.status === 'FAILED_MISMATCH_NOT_TOUCHED' && !!m.targetFolderName)
        || isAmbiguous(m)
        || (isArchiveMissingStatus(m) && !m.offSite)
        || (m.status === 'SKIP_NO_ARCHIVE' && m.offSite && m.code === 'HASH_MISMATCH' && !!m.candidateFile)
        // FAILED_EXTRACTION_* that ISN'T archive-missing failed for some other reason (confirmed
        // real-world: a transient Windows file-lock during the 7z-scratch copy step) -- a plain
        // retry of the same classify+extract flow is the right recovery, distinct from Retry
        // Download/Import which only make sense when the archive itself was the problem.
        || ((m.status === 'FAILED_EXTRACTION_NOT_TOUCHED' || m.status === 'FAILED_EXTRACTION_NO_PRIOR_DATA') && !isArchiveMissingStatus(m) && !!m.targetFolderName);
}
function resolveKindFor(m) {
    if (m.status === 'FAILED_MISMATCH_NOT_TOUCHED') return 'mismatch';
    if (isAmbiguous(m)) return 'delete-duplicate';
    if ((m.status === 'FAILED_EXTRACTION_NOT_TOUCHED' || m.status === 'FAILED_EXTRACTION_NO_PRIOR_DATA') && !isArchiveMissingStatus(m)) return 'retry-extraction';
    if (m.offSite && m.code === 'HASH_MISMATCH') return 'force-extract';
    return 'download';
}

function createWorkThroughRouter() {
    const router = express.Router();
    const logsDir = appConfig.getLogsDir('rebuild-collection');

    router.get('/list', (req, res) => {
        const { collections } = getCurrentIssues(logsDir);

        const validKeys = [];
        const out = collections.map((c) => ({
            ...c,
            problemMods: c.problemMods.map((m) => {
                if (isResolvable(m)) {
                    return { ...m, resolvable: true, resolveKind: resolveKindFor(m) };
                }
                const key = makeKey({ collectionModId: c.collectionModId, modId: m.modId, fileId: m.fileId, name: m.name });
                validKeys.push(key);
                return { ...m, resolvable: false, key };
            }),
        }));

        // Prune stale entries (a real rerun already fixed something that was previously checked off),
        // then read back the now-clean state to merge in.
        const state = pruneToKeys(validKeys).completed;
        for (const c of out) {
            for (const m of c.problemMods) {
                if (!m.resolvable) {
                    m.completed = !!state[m.key];
                    m.completedAt = state[m.key]?.completedAt || null;
                }
            }
        }
        res.json({ collections: out });
    });

    router.post('/toggle', (req, res) => {
        const { key, completed } = req.body || {};
        if (!key || typeof key !== 'string') return res.status(400).json({ error: 'key is required.' });

        // Re-derive current valid (Category B) keys and reject a stale one -- e.g. a rerun already
        // pruned it -- rather than silently recording a flag for something no longer a real problem.
        const { collections } = getCurrentIssues(logsDir);
        const validKeys = new Set();
        for (const c of collections) {
            for (const m of c.problemMods) {
                if (!isResolvable(m)) {
                    validKeys.add(makeKey({ collectionModId: c.collectionModId, modId: m.modId, fileId: m.fileId, name: m.name }));
                }
            }
        }
        if (!validKeys.has(key)) return res.status(404).json({ error: 'This item is no longer a current problem mod.' });

        const state = setCompleted(key, !!completed);
        res.json({ ok: true, completed: !!state.completed[key] });
    });

    return router;
}

module.exports = { createWorkThroughRouter };
