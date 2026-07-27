#!/usr/bin/env node
// Smoke-tests a REAL rebuild run (real archives, real 7-Zip child processes, real concurrency)
// against a THROWAWAY sandbox staging folder, so it never touches the real Vortex-managed staging
// directory. Built during this session's concurrent-extraction work (see README's "Concurrent
// extraction" section) specifically to A/B-test concurrency levels against a real, large collection
// without any risk to the user's actual staged mods.
//
// How the sandboxing works: the target collection's OWN collection.json is copied into
// <sandbox>/<collectionModId>/collection.json, but no per-mod folders are created -- every mod then
// takes rebuildMod()'s "staging folder does not exist at all" path (see lib/rebuild-mod.js), which
// still does a full real extraction via extract-mod.js's real child-process spawn, just skips the
// unrelated diff-against-existing-content code path (a separate, independently-tested piece of
// logic, untouched by concurrency). A completely separate server instance is spawned on its own
// port with --staging pointed at the sandbox; --downloads/--state stay pointed at the real ones
// (read-only in this flow, safe to share) via the same config.json this project already uses.
//
// IMPORTANT -- drive choice measurably changes the result: this session's own real A/B testing
// (against "Body Swap updated", 309 mods) found near-identical extraction-time numbers are NOT
// guaranteed across drives. A same-drive sandbox (staging AND downloads on the same physical disk)
// measured a DIFFERENT speedup than a sandbox matching the user's real drive split (staging on a
// different drive than downloads) -- always point --sandbox at the SAME drive your real staging
// folder lives on if you want a representative number, not just whatever's convenient.
//
// Usage:
//   node sandbox-test-rebuild.js --collection-mod-id <id> --sandbox <dir> [--port 4322]
//     [--concurrency <n>] [--keep-server]
//
// --sandbox is required (no default) -- deliberately forces a conscious choice of drive/location
// every time, rather than silently reusing wherever the last person who ran this happened to point
// it. Refuses outright if --sandbox resolves to the real configured staging directory.
//
// --concurrency, if given, TEMPORARILY overwrites config.json's shared `concurrentExtractions`
// setting for the duration of this one run, then restores whatever value was there before --
// this setting is shared with the real server (if it's also running), so this script always
// restores it afterward, even on error/Ctrl-C.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const appConfig = require('./lib/app-config');

function parseArgs(argv) {
    const args = { collectionModId: null, sandbox: null, port: 4322, concurrency: null, keepServer: false };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--collection-mod-id') args.collectionModId = argv[++i];
        else if (argv[i] === '--sandbox') args.sandbox = argv[++i];
        else if (argv[i] === '--port') args.port = Number(argv[++i]);
        else if (argv[i] === '--concurrency') args.concurrency = Number(argv[++i]);
        else if (argv[i] === '--keep-server') args.keepServer = true;
        else { console.error(`Unknown argument: ${argv[i]}`); process.exit(2); }
    }
    return args;
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

async function waitForServer(port, maxWaitMs) {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
        try {
            const res = await fetch(`http://127.0.0.1:${port}/api/rebuild/collections`);
            if (res.ok) return true;
        } catch { /* not up yet */ }
        await sleep(500);
    }
    return false;
}

async function waitForRunDone(port, maxWaitMs) {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
        const res = await fetch(`http://127.0.0.1:${port}/api/rebuild/runs/current`);
        const data = await res.json();
        if (!data.active) return true;
        await sleep(3000);
    }
    return false;
}

function findLatestLog(logsDir, collectionModId) {
    const files = fs.readdirSync(logsDir)
        .filter((f) => f.startsWith(`rebuild-${collectionModId}-`) && f.endsWith('.json'))
        .map((f) => ({ f, mtime: fs.statSync(path.join(logsDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
    return files.length > 0 ? path.join(logsDir, files[0].f) : null;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!args.collectionModId) { console.error('--collection-mod-id is required.'); process.exit(2); }
    if (!args.sandbox) { console.error('--sandbox <dir> is required -- pick a real drive/folder consciously, no default.'); process.exit(2); }

    const fileConfig = appConfig.loadConfig();
    if (!fileConfig.staging) { console.error('No real staging path configured (Settings page, or config.json).'); process.exit(2); }

    const sandboxResolved = path.resolve(args.sandbox);
    const realStagingResolved = path.resolve(fileConfig.staging);
    if (sandboxResolved === realStagingResolved) {
        console.error('--sandbox resolves to your REAL staging directory. Refusing -- pick a different, throwaway location.');
        process.exit(2);
    }

    const realCollectionJson = path.join(fileConfig.staging, args.collectionModId, 'collection.json');
    if (!fs.existsSync(realCollectionJson)) {
        console.error(`No real collection.json found at "${realCollectionJson}" -- is --collection-mod-id correct?`);
        process.exit(2);
    }

    const sandboxModDir = path.join(sandboxResolved, args.collectionModId);
    console.log(`Preparing sandbox at "${sandboxModDir}" (wiping any existing content except collection.json)...`);
    if (fs.existsSync(sandboxModDir)) {
        for (const entry of fs.readdirSync(sandboxModDir)) {
            if (entry !== 'collection.json') fs.rmSync(path.join(sandboxModDir, entry), { recursive: true, force: true });
        }
    } else {
        fs.mkdirSync(sandboxModDir, { recursive: true });
    }
    fs.copyFileSync(realCollectionJson, path.join(sandboxModDir, 'collection.json'));

    // concurrentExtractions is a shared setting (same config.json the real server reads) -- always
    // restore it afterward, even if something below throws, so a real server left running never
    // silently keeps a value this script chose for its own test.
    const originalConcurrency = fileConfig.concurrentExtractions;
    let restoreConcurrency = false;
    if (args.concurrency != null) {
        appConfig.saveConfig({ concurrentExtractions: args.concurrency });
        restoreConcurrency = true;
        console.log(`Temporarily set concurrentExtractions to ${args.concurrency} (will restore to ${originalConcurrency} afterward).`);
    }

    let serverProcess = null;
    try {
        console.log(`Starting sandbox server on port ${args.port}, staging="${sandboxResolved}"...`);
        serverProcess = spawn(process.execPath, [path.join(__dirname, 'web', 'server.js'), '--port', String(args.port), '--staging', sandboxResolved, '--no-open'], {
            cwd: __dirname, stdio: 'ignore',
        });

        const up = await waitForServer(args.port, 15000);
        if (!up) throw new Error(`Sandbox server on port ${args.port} never came up.`);

        console.log(`Triggering rebuild of "${args.collectionModId}"...`);
        const startRes = await fetch(`http://127.0.0.1:${args.port}/api/rebuild/runs`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ collectionModId: args.collectionModId }),
        });
        const startData = await startRes.json();
        if (!startRes.ok) throw new Error(startData.message || startData.error || `HTTP ${startRes.status}`);

        console.log('Running... (polling every 3s)');
        const finished = await waitForRunDone(args.port, 30 * 60 * 1000); // 30 min ceiling
        if (!finished) throw new Error('Run did not finish within 30 minutes.');

        const logPath = findLatestLog(path.join(__dirname, 'logs'), args.collectionModId);
        if (!logPath) throw new Error('Run finished but no matching log file was found.');
        const log = JSON.parse(fs.readFileSync(logPath, 'utf8'));
        console.log('\n===== Result =====');
        console.log(`Status:   ${log.runStatus}`);
        console.log(`Duration: ${(log.durationMs / 1000).toFixed(1)}s`);
        console.log(`Summary:  ${JSON.stringify(log.summary)}`);
        console.log(`Log:      ${logPath}`);
    } finally {
        if (restoreConcurrency) {
            appConfig.saveConfig({ concurrentExtractions: originalConcurrency });
            console.log(`Restored concurrentExtractions to ${originalConcurrency}.`);
        }
        if (serverProcess && !args.keepServer) {
            serverProcess.kill();
            console.log('Sandbox server stopped.');
        } else if (serverProcess) {
            console.log(`Sandbox server left running on port ${args.port} (--keep-server) -- stop it yourself when done.`);
        }
    }
}

main().catch((e) => {
    console.error(`ERROR: ${e.message}`);
    process.exit(1);
});
