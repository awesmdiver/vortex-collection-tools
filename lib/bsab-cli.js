'use strict';
// BSA Browser CLI (bsab.exe, github.com/AlexxEG/BSA_Browser, GPL-3.0) -- the one real, tested reader
// for Skyrim SE's actual BSA/BA2 format (v105, often compressed). Needed for Relink Scripts' own
// full-coverage script scan (loose .pex files AND scripts packed inside BSAs, matching zEdit-Revised's
// own scriptsCache.js exactly -- see lib/relink-scripts.js). There is no maintained npm package for
// this: the only one on the registry ("bsa") explicitly only supports the old, uncompressed Skyrim LE
// format (v0x68), not SSE's real one. A hand-rolled binary parser was considered and rejected -- a
// subtly wrong implementation would silently extract corrupted script data rather than fail loudly,
// and BSA_Browser is a real, actively-used, GPL-3.0 tool already solving this correctly. Shelled out
// to via its own CLI (bsab.exe), matching this project's own established pattern for xelib -- never
// embedded/linked into this project's own code (keeps the GPL boundary clean, same reasoning
// documented for DevBench in the Skyrim toolkit's own CLAUDE.md).
//
// Auto-downloaded on first use into tools/bsa-browser-cli/ (gitignored, same "downloaded binary, not
// source" convention as tools/oxipng/ and tools/7-Zip/) from the upstream project's own GitHub
// Releases -- its "Portable" release bundles both the GUI and the CLI together; only bsab.exe is kept.
// Our own fork (github.com/awesmdiver/BSA_Browser, for future reference/possible contribution) is NOT
// used as the download source here -- forks don't carry release assets forward automatically, and the
// upstream's own releases are the real, current ones.

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');
const sevenzip = require('./sevenzip');

const BSAB_DIR = path.join(__dirname, '..', 'tools', 'bsa-browser-cli');
const BSAB_EXE = path.join(BSAB_DIR, 'bsab.exe');
// Not /releases/latest -- confirmed real: every release in this repo is marked prerelease (dev-build
// style tags like "v1.13.1-17-gcfbdd47"), and GitHub's "latest" endpoint only ever considers
// non-prerelease releases, so it 404s here. The full list's own first entry is the real most-recent
// release regardless of its prerelease flag.
const RELEASES_API = 'https://api.github.com/repos/AlexxEG/BSA_Browser/releases';

function fetchJson(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'vortex-collection-tools' } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return resolve(fetchJson(res.headers.location));
            }
            let data = '';
            res.on('data', (d) => { data += d; });
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}

function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'vortex-collection-tools' } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return resolve(downloadFile(res.headers.location, dest));
            }
            const file = fs.createWriteStream(dest);
            res.pipe(file);
            file.on('finish', () => file.close(resolve));
            file.on('error', reject);
        }).on('error', reject);
    });
}

// Extracts the WHOLE .7z (not a specific member) into destDir -- lib/sevenzip.js's own
// extractFile/extractMany are built for pulling specific members out of a mod archive, not a plain
// "unpack everything" full extract, so this spawns 7z directly the same way those functions do
// internally (findSevenZip() for the exe path, matching that file's own bundled-copy-first lookup).
function extractSevenZipArchive(archivePath, destDir) {
    return new Promise((resolve, reject) => {
        const exePath = sevenzip.findSevenZip();
        const child = spawn(exePath, ['x', archivePath, `-o${destDir}`, '-y'], { windowsHide: true });
        let stderr = '';
        child.stderr.on('data', (d) => { stderr += d; });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0) resolve(); else reject(new Error(`7z extract failed (exit ${code}): ${stderr}`));
        });
    });
}

let ensurePromise = null;

// Idempotent -- safe to call before every use; only actually downloads once per machine. Returns the
// bsab.exe path once ready.
async function ensureBsabCli() {
    if (fs.existsSync(BSAB_EXE)) return BSAB_EXE;
    if (ensurePromise) return ensurePromise;
    ensurePromise = (async () => {
        const releases = await fetchJson(RELEASES_API);
        const release = Array.isArray(releases) ? releases[0] : null;
        if (!release) throw new Error('Could not fetch BSA_Browser releases from GitHub.');
        const asset = (release.assets || []).find((a) => /Portable\.7z$/i.test(a.name));
        if (!asset) throw new Error('Could not find a "Portable" release asset for BSA_Browser -- check https://github.com/AlexxEG/BSA_Browser/releases manually.');
        fs.mkdirSync(BSAB_DIR, { recursive: true });
        const archivePath = path.join(BSAB_DIR, asset.name);
        await downloadFile(asset.browser_download_url, archivePath);
        const extractRoot = path.join(BSAB_DIR, 'extracted');
        await extractSevenZipArchive(archivePath, extractRoot);
        // The portable archive nests its own "BSA Browser Portable\" folder -- find bsab.exe
        // wherever it landed rather than assuming a fixed depth, in case that folder name changes
        // in a future release.
        const found = findFileRecursive(extractRoot, 'bsab.exe');
        if (!found) throw new Error('bsab.exe not found inside the downloaded BSA_Browser release -- its layout may have changed.');
        fs.copyFileSync(found, BSAB_EXE);
        fs.rmSync(extractRoot, { recursive: true, force: true });
        fs.rmSync(archivePath, { force: true });
        return BSAB_EXE;
    })();
    try {
        return await ensurePromise;
    } finally {
        ensurePromise = null;
    }
}

function findFileRecursive(dir, fileName) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return null;
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            const found = findFileRecursive(full, fileName);
            if (found) return found;
        } else if (entry.name.toLowerCase() === fileName.toLowerCase()) {
            return full;
        }
    }
    return null;
}

function runBsab(args) {
    return new Promise((resolve, reject) => {
        const child = spawn(BSAB_EXE, args, { windowsHide: true });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
}

// Lists every script (scripts\*.pex) inside a BSA/BA2 -- returns bare filenames. Despite "-l:N"
// ("Display filename only" per --help), confirmed empirically the listing still includes the
// "scripts\" prefix, so that's stripped here to match zEdit-Revised's own scriptsCache.js entry
// shape (bare filename, no path). Empty archives, or archives with no scripts at all, return an
// empty array rather than erroring.
async function listScriptsInArchive(archivePath) {
    await ensureBsabCli();
    const { stdout } = await runBsab(['-l:N', '-f', 'scripts\\*.pex', archivePath]);
    return stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.toLowerCase().endsWith('.pex')).map((l) => path.basename(l));
}

// Extracts every script (scripts\*.pex) from a BSA/BA2 into destDir -- despite "-e:N" ("Extract
// files directly into destination, without directories" per bsab.exe's own --help), confirmed
// empirically that the archive's own internal "scripts\" folder is still preserved underneath
// destDir (files land at destDir\scripts\*.pex, not directly in destDir) -- "-e:N" evidently only
// affects some OTHER nesting case (e.g. multiple input archives), not this one. destDir must already
// exist -- bsab.exe returns "Destination directory not found" otherwise (confirmed real), so this
// creates it first. Returns full paths to the extracted .pex files.
async function extractScriptsFromArchive(archivePath, destDir) {
    await ensureBsabCli();
    fs.mkdirSync(destDir, { recursive: true });
    const { code, stderr } = await runBsab(['-e:N', '-o', '-f', 'scripts\\*.pex', archivePath, destDir]);
    if (code !== 0) throw new Error(`bsab.exe extract failed (exit ${code}): ${stderr}`);
    const scriptsDir = path.join(destDir, 'scripts');
    if (!fs.existsSync(scriptsDir)) return [];
    return fs.readdirSync(scriptsDir).filter((f) => f.toLowerCase().endsWith('.pex')).map((f) => path.join(scriptsDir, f));
}

module.exports = { ensureBsabCli, listScriptsInArchive, extractScriptsFromArchive, BSAB_EXE };
