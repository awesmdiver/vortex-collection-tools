// Diffs two hash-manifest.js manifests, reporting missing, added, and content-changed
// .esp/.esl/.dll files between a "before" and "after" state. Also used as a library
// (diffManifests) by watch-launch.js to compare the running session against the last
// known-good baseline without a subprocess.
//
// CLI usage: node diff-manifests.js before.json after.json

const fs = require('fs');

function diffManifests(before, after) {
    const beforePaths = new Set(Object.keys(before));
    const afterPaths = new Set(Object.keys(after));

    const missing = [...beforePaths].filter(p => !afterPaths.has(p)).sort();
    const added = [...afterPaths].filter(p => !beforePaths.has(p)).sort();
    const common = [...beforePaths].filter(p => afterPaths.has(p));
    const changed = common.filter(p => before[p].sha256 !== after[p].sha256).sort();

    return { missing, added, changed };
}

function printDiff(before, after, { missing, added, changed }) {
    console.log(`Before: ${Object.keys(before).length} files, After: ${Object.keys(after).length} files`);
    console.log('');
    console.log(`=== MISSING (in before, not in after) : ${missing.length} ===`);
    for (const p of missing) console.log('  -', p, `(${before[p].size} bytes)`);

    console.log('');
    console.log(`=== ADDED (in after, not in before) : ${added.length} ===`);
    for (const p of added) console.log('  +', p, `(${after[p].size} bytes)`);

    console.log('');
    console.log(`=== CONTENT CHANGED (same path, different hash) : ${changed.length} ===`);
    for (const p of changed) {
        console.log('  *', p);
        console.log(`      before: ${before[p].size} bytes  sha256=${before[p].sha256}`);
        console.log(`      after:  ${after[p].size} bytes  sha256=${after[p].sha256}`);
    }
}

module.exports = { diffManifests };

if (require.main === module) {
    const before = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    const after = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
    printDiff(before, after, diffManifests(before, after));
}
