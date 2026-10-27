'use strict';
// Time stamps for every console line (2026-10-23, director: "should we add the time to the log?").
// Pure formatting, no I/O, so the wrapper in app-logger.js stays small and this can be tested alone.
//
// Console: a short local time, "HH:MM:SS.mmm ", in front of every line of the message.
// Log file: the full ISO time in UTC with a Z, the same shape Vortex's own vortex.log uses, so the two
// files line up: "[2026-10-23T18:46:27.305Z] [WARN] text".
// A message that already starts with its own ISO time (for example "[2026-10-23T18:58:50.683Z] ...") keeps
// that time and is not stamped a second time.
//
// Masking (user name, keys, paths) is not done anywhere in the console path today, so there is nothing
// to run before or after the stamp; if masking is ever added it belongs on `text` before stamping.

const util = require('util');

const OWN_ISO_TIME = /^\[?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\]?\s*/;

function localStamp(date) {
    const pad = (n, w = 2) => String(n).padStart(w, '0');
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

function messageText(args) {
    return util.format(...args);
}

// Console form: every line of the message starts with the local time, unless the line already starts
// with its own ISO time.
function stampForConsole(args, date = new Date()) {
    const stamp = localStamp(date);
    return messageText(args).split('\n').map((line) => (OWN_ISO_TIME.test(line) ? line : `${stamp} ${line}`)).join('\n');
}

// Log-file form, one entry per call (a multi-line message stays one entry, as before).
function stampForFile(level, args, date = new Date()) {
    const text = messageText(args);
    const own = OWN_ISO_TIME.exec(text);
    if (own) return `[${own[1]}] [${level}] ${text.slice(own[0].length)}`;
    return `[${date.toISOString()}] [${level}] ${text}`;
}

module.exports = { stampForConsole, stampForFile, localStamp, OWN_ISO_TIME };
