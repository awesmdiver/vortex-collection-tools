'use strict';
// Cycle Helper's Change History log -- see docs/plans/2026-08-17-cycle-helper-change-history-revert-
// plan.md for the full design. Unlike lib/cycle-helper-snapshot.js's single overwritten record, this
// is a GROWING set of timestamped session files (one JSON file per session), matching Merge Plugins'
// own per-output-folder convention more than the single-snapshot one -- same plain-JSON-file,
// no-database convention either way (gitignored, this project's own established minimal-dependency
// ethos).
//
// A "session" is everything between one Scan and the next (confirmed with the director 2026-08-17) --
// a session can span several individual fix attempts, back and forth, not just one. Every fix
// attempt is logged AS IT HAPPENS (this module is called once per successful apply-fix, never
// batched at the end), including ones that don't resolve the cycle -- a fix that didn't help stays
// applied AND stays logged, never silently dropped. web/cycle-helper-routes.js owns the actual
// "when does a session start vs. continue" decision (it's the caller that knows whether the current
// request carries a session id already) -- this module just persists whatever it's handed.

const fs = require('fs');
const path = require('path');
const appConfig = require('./app-config');

const DEFAULT_HISTORY_DIR = path.join(__dirname, '..', 'config', 'cycle-helper-history');

// Same fallback shape as lib/app-config.js's own getLogsDir: a configurable Settings field that
// falls back to a built-in project-relative default when unset, rather than a REQUIRED field with
// no default (unlike e.g. skyrimDataDir/archiveFinderDbDir, this one has a perfectly good default
// that works out of the box).
function getHistoryDir() {
    const { cycleHelperHistoryDir } = appConfig.loadConfig();
    return cycleHelperHistoryDir || DEFAULT_HISTORY_DIR;
}

// sessionId IS an ISO timestamp (see logFix below) -- sanitized the same way vortex-sync/lib.js's
// backupLiveState stamps its own backup folder names, since ':'/'.' aren't safe in Windows filenames.
function sessionFilePath(sessionId) {
    const safe = String(sessionId).replace(/[:.]/g, '-');
    return path.join(getHistoryDir(), `${safe}.json`);
}

// Appends one fix to a session's own file, creating a NEW session (a fresh timestamp-based id) when
// sessionId is falsy or its file can't be read (missing/corrupt -- never let a bad prior file block
// logging a brand-new fix). Returns the full, now-updated session object, including its id, so the
// caller can hand that id back to the client for the NEXT fix in the same session.
function logFix(sessionId, fix) {
    let id = sessionId;
    let session = null;
    if (id) {
        try {
            session = JSON.parse(fs.readFileSync(sessionFilePath(id), 'utf8'));
        } catch {
            id = null; // fall through and start a fresh session below
        }
    }
    if (!session) {
        id = new Date().toISOString();
        session = { sessionId: id, appliedAt: id, fixes: [] };
    }
    session.fixes.push(fix);
    fs.mkdirSync(getHistoryDir(), { recursive: true });
    fs.writeFileSync(sessionFilePath(id), JSON.stringify(session, null, 2));
    return session;
}

// Every saved session, newest first, full fixes array included -- the Change History list and its
// per-session Revert review both render straight from this, no second per-session fetch needed (the
// real session count here is a handful of small files, not worth a separate detail route).
function listSessions() {
    const dir = getHistoryDir();
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => {
            try {
                return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
            } catch {
                return null; // corrupt/partial file -- skip rather than fail the whole list
            }
        })
        .filter(Boolean)
        .sort((a, b) => String(b.sessionId).localeCompare(String(a.sessionId)));
}

module.exports = { getHistoryDir, logFix, listSessions };
