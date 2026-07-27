#!/usr/bin/env node
// Verifies the real Nexus auto-download mechanism (lib/nexus-mod-download.js) against REAL archives
// from a real, already-installed collection, downloaded into a THROWAWAY sandbox folder -- never
// the real downloads directory -- so the "download missing archives" feature can be trusted before
// ever being wired into a real rebuild. Built to establish confidence before enabling
// downloadMissingArchives against real staging/downloads directories.
//
// How the verification works: downloadModArchive() already verifies actual size+md5 against
// collection.json's own recorded source.fileSize/source.md5 before accepting a download as real
// (see lib/nexus-mod-download.js) -- so a clean run here (no thrown error) IS the correctness proof,
// the same way collection.json is the ground truth everywhere else in this project.
//
// Usage:
//   node sandbox-test-download.js --collection-mod-id <id> --sandbox-downloads <dir>
//     (--mod-name "<name or substring>" | --all-missing) [--clean]
//
// --sandbox-downloads is required (no default) -- deliberately forces a conscious choice of
// drive/location every time. Refuses outright if it resolves to the real configured downloads dir.
//
// --mod-name does a case-insensitive substring match against the collection's mod names; errors on
// 0 or 2+ matches (ambiguous). --all-missing scans every Nexus-hosted (source.type === 'nexus') mod
// in the collection via a READ-ONLY locateArchive() check against the REAL downloads dir (stat/hash
// only, never writes there) and downloads only the ones that come back NOT_FOUND.
//
// No automatic cleanup by default (unlike sandbox-test-rebuild.js) -- the whole point is letting you
// inspect the real downloaded file afterward. Pass --clean to remove the sandbox folder when done.

const fs = require('fs');
const path = require('path');

const runner = require('../lib/collection-runner');
const { locateArchive } = require('../lib/archive-locator');
const nexusModDownload = require('../lib/nexus-mod-download');
const appConfig = require('../lib/app-config');

function parseArgs(argv) {
    const args = { collectionModId: null, sandboxDownloads: null, modName: null, allMissing: false, clean: false };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--collection-mod-id') args.collectionModId = argv[++i];
        else if (argv[i] === '--sandbox-downloads') args.sandboxDownloads = argv[++i];
        else if (argv[i] === '--mod-name') args.modName = argv[++i];
        else if (argv[i] === '--all-missing') args.allMissing = true;
        else if (argv[i] === '--clean') args.clean = true;
        else { console.error(`Unknown argument: ${argv[i]}`); process.exit(2); }
    }
    return args;
}

async function findTargetMods(collectionInfo, args, downloadsDir) {
    const nexusMods = collectionInfo.collection.mods.filter((m) => m.source?.type === 'nexus');
    if (args.modName) {
        const needle = args.modName.toLowerCase();
        const matches = nexusMods.filter((m) => m.name.toLowerCase().includes(needle));
        if (matches.length === 0) throw new Error(`No Nexus-hosted mod name contains "${args.modName}".`);
        if (matches.length > 1) {
            throw new Error(`Ambiguous -- ${matches.length} mods match "${args.modName}": ${matches.map((m) => m.name).join(', ')}`);
        }
        return matches;
    }
    // --all-missing: read-only check against the REAL downloads dir (stat/hash only, never writes).
    const missing = [];
    for (const mod of nexusMods) {
        try {
            await locateArchive(downloadsDir, mod.source);
        } catch (e) {
            // NOT_FOUND and HASH_MISMATCH both mean "no usable archive present" -- a HASH_MISMATCH
            // candidate is a same-size coincidence, not the real file (confirmed real-world). AMBIGUOUS
            // (multiple candidates that ARE byte-identical correct matches) is a real duplicate-file
            // situation needing a human, not something a download can resolve -- excluded, same rule
            // as the live feature itself.
            if (e.code === 'NOT_FOUND' || e.code === 'HASH_MISMATCH') missing.push(mod);
        }
    }
    return missing;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!args.collectionModId) { console.error('--collection-mod-id is required.'); process.exit(2); }
    if (!args.sandboxDownloads) { console.error('--sandbox-downloads <dir> is required -- pick a real drive/folder consciously, no default.'); process.exit(2); }
    if (!args.modName && !args.allMissing) { console.error('Pass exactly one of --mod-name "<name>" or --all-missing.'); process.exit(2); }
    if (args.modName && args.allMissing) { console.error('--mod-name and --all-missing are mutually exclusive.'); process.exit(2); }

    const fileConfig = appConfig.loadConfig();
    if (!fileConfig.staging || !fileConfig.downloads) {
        console.error('No real staging/downloads path configured (Settings page, or config.json).');
        process.exit(2);
    }

    const sandboxResolved = path.resolve(args.sandboxDownloads);
    const realDownloadsResolved = path.resolve(fileConfig.downloads);
    if (sandboxResolved === realDownloadsResolved) {
        console.error('--sandbox-downloads resolves to your REAL downloads directory. Refusing -- pick a different, throwaway location.');
        process.exit(2);
    }

    const collectionInfo = runner.resolveCollectionInfo(fileConfig.staging, args.collectionModId);
    const gameDomain = collectionInfo.collection.info?.domainName;
    console.log(`Collection: ${collectionInfo.name} [${collectionInfo.modId}] (domain: ${gameDomain})`);

    console.log('Finding target mod(s)...');
    const targets = await findTargetMods(collectionInfo, args, fileConfig.downloads);
    if (targets.length === 0) {
        console.log('Nothing to do -- no missing Nexus-hosted archives found for this collection.');
        process.exit(0);
    }
    console.log(`\nTarget(s) (${targets.length}):`);
    for (const m of targets) {
        console.log(`  - ${m.name} (modId ${m.source.modId}, fileId ${m.source.fileId}, md5 ${m.source.md5}, size ${m.source.fileSize})`);
    }

    const apiKey = nexusModDownload.resolveApiKey();
    const premium = await nexusModDownload.checkPremiumStatus(apiKey);
    console.log(`\nNexus account: ${premium.name} (Premium: ${premium.isPremium})`);
    if (!premium.isPremium) {
        console.error('This account is not Premium -- automated downloads require Premium (see lib/nexus-mod-download.js). Aborting.');
        process.exit(1);
    }

    fs.mkdirSync(sandboxResolved, { recursive: true });
    console.log(`\nDownloading into sandbox: "${sandboxResolved}" (real downloads directory is never touched)...\n`);

    const results = [];
    for (const mod of targets) {
        try {
            const { archivePath, fileName } = await nexusModDownload.downloadModArchive({
                apiKey, gameDomain, source: mod.source, destDir: sandboxResolved,
            });
            console.log(`  [PASS] ${mod.name} -> ${fileName}`);
            results.push({ name: mod.name, status: 'PASS', archivePath });
        } catch (e) {
            console.log(`  [FAIL] ${mod.name} -- ${e.code || 'UNKNOWN'}: ${e.message}`);
            results.push({ name: mod.name, status: 'FAIL', error: e.message, errorCode: e.code });
        }
    }

    console.log('\n===== Result =====');
    const failed = results.filter((r) => r.status === 'FAIL');
    console.log(`PASS: ${results.length - failed.length} / ${results.length}`);
    if (failed.length > 0) {
        console.log('FAILED:');
        for (const r of failed) console.log(`  - ${r.name}: [${r.errorCode}] ${r.error}`);
    }

    if (args.clean) {
        fs.rmSync(sandboxResolved, { recursive: true, force: true });
        console.log(`\nSandbox folder removed (--clean): "${sandboxResolved}"`);
    } else {
        console.log(`\nSandbox folder left in place for inspection: "${sandboxResolved}"`);
    }

    process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((e) => {
    console.error(`ERROR: ${e.message}`);
    process.exit(1);
});
