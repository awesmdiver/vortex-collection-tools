'use strict';
// Application-level log (2026-08-26) -- ONE plain-text file per server session, separate from every
// other log this project writes. Don't confuse this with:
//   - collection-runner.js's own per-run JSON logs (one structured file per Rebuild/Update run,
//     already scoped correctly -- untouched by this).
//   - merge-v2-runner.js's own per-crash diagnostic file (commit dcf40f9, captures worker stderr +
//     the xelib_log.txt tail on a Merge Plugins crash -- untouched by this; this file's tee just
//     means that same crash's own console.error/console.log calls now ALSO land here, in addition
//     to that dedicated file, which is fine -- two logs covering the same event from two angles).
//
// Motivated by two real incidents already written up in this repo:
//   - GitHub issue #4 -- working out what actually happened took reading the code and guessing, and
//     part of it is STILL guesswork (whose archive.db that was). A line recording that
//     archiveFinderDbDir resolved to the downloads root, or that the launcher's supervisor
//     respawned the server after a deliberate stop, would have answered it in seconds.
//   - diagnostics/dangling-formid-merge-crash/root-cause-findings-2026-08-26.md -- only possible at
//     all because Merge Plugins v2's own crash-diagnostic file captured the xelib_log.txt tail.
//     That proved the "capture real diagnostic output to a real file" pattern is worth having
//     everywhere console.log/console.error already gets used, not just on one tool's crash path.
//
// Why a file at all, not just console output: launcher/src-tauri/src/main.rs's spawn_node() starts
// node.exe with CREATE_NO_WINDOW and no stdio capture of its own -- anything written with a plain
// console.log simply goes nowhere when the server is started via the tray launcher (confirmed real,
// same root cause as merge-v2-runner.js's own diagnosability gap before commit dcf40f9). Writing
// straight to a file from inside the node process sidesteps that entirely and works identically
// whether the server was started from a terminal or the launcher.

const fs = require('fs');
const path = require('path');
const util = require('util');
const appConfig = require('./app-config');

// Local time, filesystem-safe (no colons) -- e.g. "2026-08-26_21-45-00". One file per server
// session (timestamped at the moment the server actually starts), not rotating/daily -- this is a
// low-volume debug log for a locally-run single-user tool, not a high-throughput service; no
// rotation/size-limit logic is worth the complexity here.
function timestampForFilename(date) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_`
        + `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

// Exported separately from initAppLogger so scripts/test-app-logger.js (if this ever gets one) can
// cover the formatting logic without touching the filesystem or wrapping console.* for real.
function buildLogFilename(date = new Date()) {
    return `app-${timestampForFilename(date)}.log`;
}

// initAppLogger(): call ONCE, at server startup, only when config.appLogEnabled is true (the caller
// -- web/server.js -- decides that; this module doesn't re-read config itself, so it stays a plain,
// unconditional "do the thing" function with no hidden on/off state of its own). Returns the real
// path of the file just created, so the caller can log/confirm it.
//
// Wraps console.log/info/warn/error exactly once, project-wide -- every existing and future
// console.* call anywhere in this codebase is captured automatically, zero changes needed at any
// call site (the same reasoning merge-v2-runner.js's own diagnostic logging already established:
// meaningful console.log/console.error calls at the moments that matter are enough, no bespoke
// per-tool logger needed -- see TECHNICAL.md). Still calls the REAL console method first, so the
// terminal-launched case (which already worked) is completely unaffected.
function initAppLogger() {
    const dir = appConfig.getLogsDir('app');
    fs.mkdirSync(dir, { recursive: true });
    const logPath = path.join(dir, buildLogFilename());

    const real = {
        log: console.log.bind(console),
        info: console.info.bind(console),
        warn: console.warn.bind(console),
        error: console.error.bind(console),
    };

    // Best-effort, always: a log write must never be why a real operation fails. fs.appendFileSync
    // is fine here -- see the header comment on why this doesn't need a stream/rotation/buffering.
    function appendLine(level, args) {
        try {
            const line = `[${new Date().toISOString()}] [${level}] ${util.format(...args)}\n`;
            fs.appendFileSync(logPath, line);
        } catch { /* never let a broken log write break the app itself */ }
    }

    console.log = (...args) => { real.log(...args); appendLine('LOG', args); };
    console.info = (...args) => { real.info(...args); appendLine('INFO', args); };
    console.warn = (...args) => { real.warn(...args); appendLine('WARN', args); };
    console.error = (...args) => { real.error(...args); appendLine('ERROR', args); };

    // Unhandled errors at the process level -- today these either vanish (launcher case) or only
    // show up if a terminal window happens to be open. Only registered when this whole feature is
    // on (never changes default app behavior for anyone who hasn't opted in): logs via the wrapped
    // console.error above (so it lands in the file, not just stderr), then exits the same way
    // Node's own built-in default handling would have -- this adds VISIBILITY into why the process
    // is going down, it does not change whether it goes down. Registering a handler at all
    // suppresses Node's own default crash-and-report behavior, so both branches replicate it
    // explicitly (uncaughtException: print + exit(1); unhandledRejection, default 'throw' mode since
    // Node 15: effectively the same).
    process.on('uncaughtException', (err) => {
        console.error('[uncaughtException]', err && err.stack ? err.stack : String(err));
        process.exit(1);
    });
    process.on('unhandledRejection', (reason) => {
        console.error('[unhandledRejection]', reason && reason.stack ? reason.stack : String(reason));
        process.exit(1);
    });

    return logPath;
}

module.exports = { initAppLogger, buildLogFilename };
