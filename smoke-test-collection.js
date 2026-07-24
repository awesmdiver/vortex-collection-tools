#!/usr/bin/env node
// Smoke-tests extract-mod.js against EVERY mod in a collection.json: extracts each real mod from
// its real archive (FOMOD or simple, whichever it recorded), then compares byte-for-byte against
// Vortex's own already-extracted staging folder (E:\Vortex Mods\skyrimse\<archive-name>\).
//
// A mod with no matching staging folder is reported SKIPPED, not FAILED -- expected for any mod
// the user has marked "ignored" in Vortex (an ignored mod is never deployed, so it never gets a
// staging folder), not a sign the extractor is broken.
//
// Usage: node smoke-test-collection.js [--collection <path>] [--downloads <path>]
//   [--output <dir>] [--staging <dir>]

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { loadCollection } = require('./lib/collection-parser');
const { locateArchive } = require('./lib/archive-locator');
const { buildManifest } = require('./lib/hash-manifest');
const { diffManifests } = require('./lib/diff-manifests');
const appConfig = require('./lib/app-config');

const fileConfig = appConfig.loadConfig();

function parseArgs(argv) {
    const args = {
        // collection/output are dev-fixture convenience defaults for this internal smoke-test
        // script, not real user-facing settings -- unlike downloads/staging, left as-is.
        collection: 'F:/Mod Extraction/Daughter-of-Coldharbour-SDA-in-GTS-735477-30-1783874181/collection.json',
        downloads: fileConfig.downloads || null,
        output: 'F:/Mod Extraction/prototype-output',
        staging: fileConfig.staging || null,
    };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--collection') args.collection = argv[++i];
        else if (argv[i] === '--downloads') args.downloads = argv[++i];
        else if (argv[i] === '--output') args.output = argv[++i];
        else if (argv[i] === '--staging') args.staging = argv[++i];
    }
    return args;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const collection = loadCollection(args.collection);
    console.log(`Collection: ${args.collection}`);
    console.log(`${collection.mods.length} mod(s) total.\n`);

    const results = [];

    for (const mod of collection.mods) {
        const kind = mod.choices && mod.choices.type === 'fomod' ? 'fomod' : 'simple';

        // modId alone does NOT uniquely identify a mod: a single Nexus mod page can host several
        // files (main file + optional patches), each becoming a SEPARATE collection.json mod
        // entry with the SAME modId but a different fileId/md5/fileSize -- confirmed this session
        // (modId 141199 alone matched 5 unrelated staging folders). locateArchive()'s exact
        // md5+fileSize match is the only reliable disambiguator, so the archive must be found
        // FIRST; the staging folder name is then derived from ITS filename (proven identical to
        // the staging folder name all session), not guessed from modId.
        let archivePath;
        try {
            archivePath = await locateArchive(args.downloads, mod.source);
        } catch (e) {
            results.push({ name: mod.name, kind, status: 'SKIPPED', detail: `archive not downloaded (likely ignored in Vortex): ${e.message}` });
            console.log(`[SKIP]  ${mod.name} -- archive not downloaded`);
            continue;
        }

        const archiveBaseName = path.basename(archivePath, path.extname(archivePath));
        const stagingDir = path.join(args.staging, archiveBaseName);
        const outputDir = path.join(args.output, archiveBaseName);

        if (!fs.existsSync(stagingDir)) {
            results.push({ name: mod.name, kind, status: 'SKIPPED', detail: 'archive downloaded but no staging folder (likely ignored in Vortex)' });
            console.log(`[SKIP]  ${mod.name} -- no staging folder`);
            continue;
        }

        try {
            fs.rmSync(outputDir, { recursive: true, force: true });
            execFileSync(
                process.execPath,
                ['extract-mod.js', mod.name, '--collection', args.collection, '--downloads', args.downloads, '--output', args.output],
                { cwd: __dirname, stdio: 'pipe' }
            );

            const ours = buildManifest(outputDir);
            const theirs = buildManifest(stagingDir);
            const { missing, added, changed } = diffManifests(theirs, ours);

            if (missing.length === 0 && added.length === 0 && changed.length === 0) {
                results.push({ name: mod.name, kind, status: 'MATCH', detail: `${Object.keys(ours).length} files` });
                console.log(`[MATCH] ${mod.name} (${kind}, ${Object.keys(ours).length} files)`);
            } else {
                results.push({
                    name: mod.name, kind, status: 'MISMATCH',
                    detail: `missing=${missing.length} extra=${added.length} changed=${changed.length}`,
                    missing, added, changed,
                });
                console.log(`[FAIL]  ${mod.name} -- missing=${missing.length} extra=${added.length} changed=${changed.length}`);
            }
        } catch (e) {
            // execFileSync's own Error.message is just "Command failed: ..." -- the actual reason
            // is in stdout/stderr, which are on the error object but easy to lose if not surfaced.
            const stderr = e.stderr ? e.stderr.toString().trim() : '';
            const stdout = e.stdout ? e.stdout.toString().trim() : '';
            const detail = stderr || stdout || e.message.split('\n')[0];
            results.push({ name: mod.name, kind, status: 'ERROR', detail });
            console.log(`[ERROR] ${mod.name} -- ${detail}`);
        }
    }

    console.log('\n===== Summary =====');
    const byStatus = { MATCH: [], MISMATCH: [], ERROR: [], SKIPPED: [] };
    for (const r of results) byStatus[r.status].push(r);
    console.log(`MATCH:    ${byStatus.MATCH.length}`);
    console.log(`MISMATCH: ${byStatus.MISMATCH.length}`);
    console.log(`ERROR:    ${byStatus.ERROR.length}`);
    console.log(`SKIPPED:  ${byStatus.SKIPPED.length}`);
    console.log(`TOTAL:    ${results.length}`);

    if (byStatus.MISMATCH.length > 0 || byStatus.ERROR.length > 0) {
        console.log('\n--- Non-MATCH details ---');
        for (const r of [...byStatus.MISMATCH, ...byStatus.ERROR]) {
            console.log(`${r.status} [${r.kind}] ${r.name}: ${r.detail}`);
        }
    }

    fs.writeFileSync(
        path.join(args.output, 'smoke-test-results.json'),
        JSON.stringify(results, null, 2)
    );
    console.log(`\nFull results written to ${path.join(args.output, 'smoke-test-results.json')}`);

    process.exit(byStatus.MISMATCH.length > 0 || byStatus.ERROR.length > 0 ? 1 : 0);
}

main();
