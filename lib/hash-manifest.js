// Hashes every file under a root and writes a JSON manifest keyed by path relative to that root.
// Adapted from skyrim-hang-watchdog's version (originally hardcoded to .esp/.esl/.dll only, for
// tracking plugin/DLL changes specifically) -- generalized here to an optional extension filter,
// defaulting to ALL files, since this project needs to compare arbitrary mod content (.bsa/.esp/
// .dds/.wav/etc), not just plugins. Found this the hard way: an early comparison silently reported
// "3 files, all match" when 7 files were actually extracted, because the original hardcoded filter
// dropped every .bsa without any warning.
//
// CLI usage: node hash-manifest.js <root> <output.json> [ext1,ext2,...]

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function hashFile(p) {
    const buf = fs.readFileSync(p);
    return crypto.createHash('sha256').update(buf).digest('hex');
}

function walk(dir, root, results, extensions) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
        return;
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walk(full, root, results, extensions);
        } else if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase();
            if (!extensions || extensions.has(ext)) {
                const rel = path.relative(root, full).replace(/\\/g, '/');
                let hash = null, size = null, err = null;
                try {
                    const st = fs.statSync(full);
                    size = st.size;
                    hash = hashFile(full);
                } catch (e) {
                    err = String(e.message || e);
                }
                results[rel] = { size, sha256: hash, error: err };
            }
        }
    }
}

// extensions: optional array of lowercase extensions (e.g. ['.esp','.bsa']) to restrict to;
// omit/null to hash every file, which is this project's default (see compare-output.js).
function buildManifest(root, extensions) {
    const resolvedRoot = path.resolve(root);
    const extSet = extensions ? new Set(extensions.map((e) => e.toLowerCase())) : null;
    const results = {};
    walk(resolvedRoot, resolvedRoot, results, extSet);
    return results;
}

module.exports = { buildManifest };

if (require.main === module) {
    const root = path.resolve(process.argv[2]);
    const outPath = process.argv[3];
    const extensions = process.argv[4] ? process.argv[4].split(',') : null;
    const start = Date.now();
    const results = buildManifest(root, extensions);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
    console.log(`Hashed ${Object.keys(results).length} file(s) in ${elapsed}s -> ${outPath}`);
}
