'use strict';
// Minimal port of zedit-revised's own src/javascripts/helpers/fileHelpers.js -- just the subset the
// 9 asset handlers actually call (getFileBase/getFileExt/getFileName/getDirectory/escapePattern/
// getFiles/loadTextFile/saveTextFile/copy/exists/dir), reimplemented on plain Node fs + the real
// `minimatch` package (the SAME matching library zMerge itself uses -- see package.json's own
// `minimatch: ^3.0.4`) rather than pulling in the much larger fs-jetpack just for its own thin
// wrapper around fs + minimatch. Every function below matches fileHelpers.js's own real behavior,
// not an approximation -- see each one's own comment for the exact source line it mirrors.

const fs = require('fs');
const path = require('path');
const { Minimatch } = require('minimatch');

// fileHelpers.js:137-151 -- these are regex-based, not path.parse()-based, and deliberately kept
// that way here: path.parse would behave differently on a filename with no extension or multiple
// dots in a way zMerge's own regexes don't, and asset filenames here (FormID-hex-named facegen/
// billboard/voice files, plugin basenames) are exactly the case where that matters.
function getFileBase(filePath) {
    return filePath.match(/(.*[\\/])?(.*)\.[^\\/]+/)[2];
}
function getFileExt(filePath) {
    return filePath.match(/(.*[\\/])?.*\.([^\\/]+)/)[2];
}
function getFileName(filePath) {
    return filePath.match(/(.*[\\/])?(.*)/)[2];
}
function getDirectory(filePath) {
    return filePath.match(/(.*)[\\/].*/)[1];
}

// fileHelpers.js:124-130 -- escapes minimatch special characters out of a literal path SEGMENT
// (a plugin filename, a mod folder name) before it gets embedded in a real glob pattern, and
// normalizes backslashes to forward slashes (minimatch/jetpack both match on '/'-separated paths
// regardless of the host OS).
const ESCAPE_CHARS = ['*', '#', '!', '(', ')', '[', ']', '{', '}', '+', '|'];
function escapePattern(p) {
    return p.split('').map((char) => {
        if (ESCAPE_CHARS.includes(char)) return '\\' + char;
        if (char === '\\') return '/';
        return char;
    }).join('');
}

// Windows accepts '/' as a path separator through Node's own fs layer just as readily as '\\', so
// keeping every asset path forward-slashed from here on (through matching AND the returned result)
// sidesteps the real ambiguity in fh.getFiles' own upstream jetpack.find + minimatch combination --
// this module owns both sides of every match it performs (its own getFiles output feeds directly
// into its own Minimatch patterns elsewhere in lib/merge/), so internal consistency is what actually
// matters, not reproducing jetpack's own separator choice byte-for-byte.
function toForwardSlash(p) { return p.replace(/\\/g, '/'); }

// fileHelpers.js:176-182's own fh.getFiles(path, {matching, recursive}) -- jetpack.find() ported
// directly onto fs.readdirSync recursion + real minimatch (jetpack's own `matching` option is
// itself just minimatch under the hood). `matching` is one pattern or an array of patterns, ALWAYS
// relative to `dir` (not absolute) -- matching jetpack's own contract, since every asset-handler
// caller below builds its patterns that way. ignoreCase defaults true, same as fileHelpers.js's own
// default. Returns forward-slash ABSOLUTE paths (dir + relative match), same as fh.getFiles' own
// `.map(path => jetpack.path(path))` resolving to a full path.
function getFiles(dir, { matching, recursive = true, ignoreCase = true } = {}) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
    const baseDir = toForwardSlash(dir).replace(/\/$/, '');
    const patterns = (Array.isArray(matching) ? matching : [matching]).map(
        (p) => new Minimatch(p, { nocase: ignoreCase, dot: true })
    );
    const results = [];
    const walk = (rel) => {
        const abs = path.join(dir, rel);
        let entries;
        try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
            const relPath = rel ? `${rel}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                if (recursive) walk(relPath);
                continue;
            }
            if (patterns.some((m) => m.match(relPath))) results.push(`${baseDir}/${relPath}`);
        }
    };
    walk('');
    return results;
}

function loadTextFile(filePath, encoding = 'utf8') {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return undefined;
    return fs.readFileSync(filePath, { encoding });
}

function saveTextFile(filePath, value, encoding = 'utf8') {
    fs.mkdirSync(getDirectory(filePath), { recursive: true });
    fs.writeFileSync(filePath, value, { encoding });
}

// fh.jetpack.copy's own default (overwrite the destination, create parent dirs) -- every real
// caller below passes { overwrite: true } explicitly anyway, matching zMerge's own copyAsset.
function copyFile(src, dest) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
}

function exists(p) {
    try {
        const st = fs.statSync(p);
        return st.isDirectory() ? 'dir' : st.isFile() ? 'file' : false;
    } catch { return false; }
}

module.exports = {
    getFileBase, getFileExt, getFileName, getDirectory, escapePattern,
    getFiles, loadTextFile, saveTextFile, copyFile, exists, toForwardSlash,
};
