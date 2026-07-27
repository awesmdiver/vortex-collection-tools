#!/usr/bin/env node
// Compares this tool's extraction output against what Vortex itself actually produced for the
// same mod (its real staging folder) -- the concrete pass/fail signal for this prototype.
//
// Usage: node compare-output.js <output-mod-dir> <real-staging-mod-dir>

const { buildManifest } = require('../lib/hash-manifest');
const { diffManifests } = require('../lib/diff-manifests');

const [, , outputDir, stagingDir] = process.argv;
if (!outputDir || !stagingDir) {
    console.error('Usage: node compare-output.js <output-mod-dir> <real-staging-mod-dir>');
    process.exit(2);
}

const ours = buildManifest(outputDir);
const theirs = buildManifest(stagingDir);
const { missing, added, changed } = diffManifests(theirs, ours); // "theirs" = before/expected, "ours" = after/actual

console.log(`Ours:   ${Object.keys(ours).length} files (${outputDir})`);
console.log(`Theirs: ${Object.keys(theirs).length} files (${stagingDir})`);
console.log('');
console.log(`Missing from our output (Vortex has these, we don't): ${missing.length}`);
for (const p of missing) console.log('  -', p);
console.log('');
console.log(`Extra in our output (we produced these, Vortex didn't): ${added.length}`);
for (const p of added) console.log('  +', p);
console.log('');
console.log(`Content differs (same path, different hash): ${changed.length}`);
for (const p of changed) console.log('  *', p);

const allGood = missing.length === 0 && added.length === 0 && changed.length === 0;
console.log('');
console.log(allGood ? 'MATCH: byte-for-byte identical to what Vortex produced.' : 'MISMATCH -- see above.');
process.exit(allGood ? 0 : 1);
