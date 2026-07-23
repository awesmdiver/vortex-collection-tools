'use strict';
// Small interactive-terminal helpers for rebuild-collection.js's menu mode -- ports of the
// equivalent private helpers in vortex-collection-sync/menu.js (ask, selectFromList, confirm,
// requireVortexClosed), since that project's lib.js doesn't export them. Kept intentionally
// undecorated (no ANSI color) since this project doesn't otherwise use terminal color.

const readline = require('readline/promises');

let rl = null;
function getRl() {
    if (!rl) rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return rl;
}

async function ask(prompt) {
    return (await getRl().question(prompt)).trim();
}

async function selectFromList(items, labelFn, promptText) {
    console.log(`\n${promptText}`);
    items.forEach((it, i) => console.log(`  ${i + 1}) ${labelFn(it)}`));
    console.log('  0) Cancel');
    for (;;) {
        const ans = await ask('> ');
        const n = parseInt(ans, 10);
        if (n === 0) return null;
        if (!Number.isNaN(n) && n >= 1 && n <= items.length) return items[n - 1];
        console.log('Invalid selection, try again.');
    }
}

async function confirm(promptText, defaultNo = true) {
    const suffix = defaultNo ? '[y/N]' : '[Y/n]';
    const ans = (await ask(`${promptText} ${suffix} `)).trim().toLowerCase();
    if (ans === '') return !defaultNo;
    return ans === 'y' || ans === 'yes';
}

// interactive=false (e.g. --yes / scripted use): check once, no retry loop -- caller is
// responsible for aborting on a false return. interactive=true: retry until closed or the user
// quits, matching vortex-collection-sync/menu.js's own requireVortexClosed exactly.
async function requireVortexClosed(syncLib, { interactive = true } = {}) {
    if (!syncLib.isVortexRunning()) return true;
    if (!interactive) return false;

    console.log('\nVortex is currently running. This tool moves/replaces real staging folders,');
    console.log('which Vortex actively manages -- it must be fully closed first.');
    console.log('Close Vortex, then press Enter to continue (or type "q" to quit).');
    const ans = await ask('> ');
    if (ans.toLowerCase() === 'q') return false;
    if (syncLib.isVortexRunning()) {
        console.log('Still running -- try again once it\'s closed.');
        return requireVortexClosed(syncLib, { interactive });
    }
    return true;
}

function closeInteractive() {
    if (rl) { rl.close(); rl = null; }
}

module.exports = { ask, selectFromList, confirm, requireVortexClosed, closeInteractive };
