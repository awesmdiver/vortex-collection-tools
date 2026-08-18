'use strict';
// Shared byte-count formatter for backend diagnostic/log text. Same rounding convention as the
// frontend's own web/public/cleanup-app.js formatBytes() -- kept as a separate copy since that one
// runs in the browser (no require()) and this one needs to be requirable from lib/.
function formatBytes(n) {
    if (n == null) return null;
    if (n < 1024) return `${n} B`;
    const units = ['KB', 'MB', 'GB'];
    let v = n / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(1)} ${units[i]}`;
}

module.exports = { formatBytes };
