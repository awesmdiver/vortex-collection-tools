'use strict';
// Port of zedit-revised's own src/javascripts/Services/merge/bsaHelpers.js -- BSA/BA2 archive
// reading, used by the bsaHandler asset handler (Runners/assetHandlers/bsaHandler.js) to enumerate
// and extract an archive's own contents.
//
// GetContainerFiles gap: XEditLib.dll genuinely exports this function (confirmed against
// zedit-revised's OWN xelib binding, vendor/xelib/src/js/resources.js -- `GetContainerFiles(name,
// folder, len)`, same GetResultString/length-buffer protocol as every other string-array getter),
// and our own node_modules/xeditlib's *raw* FFI table also declares it
// (`raw.GetContainerFiles: lib.func('uint16 GetContainerFiles(void*, void*, void*)')`) -- it's just
// never wrapped with a public convenience method on the exported `xelib` object (grep confirms:
// present in the private raw table, absent from the public API surface). Patching
// node_modules/xeditlib directly isn't safe here -- that's not this project's own fork, it's
// installed straight from GitHub (see the game folder's own CLAUDE.md), so any edit is silently
// lost on the next `npm install`. Loading XEditLib.dll a second time via koffi, right alongside the
// xeditlib package's own already-initialised load of the SAME dll, is safe: the exported functions
// operate on ONE shared native xEdit session inside the process regardless of which JS binding
// object issued the call (that's the whole reason xelib.init() only needs to run once at all) --
// this just adds a second, minimal set of bindings against that same already-loaded library for the
// one export xeditlib's own wrapper doesn't surface.
const fs = require('fs');
const path = require('path');
const koffi = require('koffi');
const { Minimatch } = require('minimatch');
const xelib = require('xeditlib');

const dllPath = path.join(path.dirname(require.resolve('xeditlib')), 'XEditLib.dll');
const lib = koffi.load(dllPath);
const rawGetContainerFiles = lib.func('uint16 GetContainerFiles(void*, void*, void*)');
const rawGetResultString = lib.func('uint16 GetResultString(void*, int)');

// Same UCS-2/GetResultString protocol as every other xeditlib string getter (node_modules/xeditlib/
// xelib.js's own wcb/getString/getStringArray) -- duplicated here in miniature rather than reaching
// into that package's private helpers, which (like `raw`) aren't exported either.
function wcb(str) {
    const buf = Buffer.alloc((str.length + 1) * 2, 0);
    buf.write(str, 0, 'ucs2');
    return buf;
}
function readWide(buf, len) {
    return buf.toString('utf16le', 0, len * 2);
}
function fail(msg) {
    throw new Error(msg);
}

// bsaHelpers.js's own `this.getFiles`/`this.find`, minus the module-level cache (bsaHelpers.js:3
// `bsaCache`) -- ours is scoped to ONE merge's own asset-discovery pass (a fresh Map per merge run,
// threaded through from lib/merge/assets.js) rather than a process-lifetime global, since a headless
// worker process only ever runs one merge before exiting.
function getContainerFiles(bsaPath) {
    const nameBuf = wcb(bsaPath);
    const folderBuf = wcb('');
    const lenBuf = Buffer.alloc(4, 0);
    if (!rawGetContainerFiles(nameBuf, folderBuf, lenBuf)) fail(`Failed to get files in container ${bsaPath}`);
    const len = lenBuf.readInt32LE(0);
    if (len < 1) return [];
    const strBuf = Buffer.alloc(len * 2, 0);
    if (!rawGetResultString(strBuf, len)) fail('GetResultString failed');
    const str = readWide(strBuf, len);
    return str ? str.split('\r\n').filter(Boolean) : [];
}

function makeBsaHelpers() {
    const bsaCache = new Map();

    function loadedContainers() {
        return xelib.getLoadedContainers();
    }

    function loadBsaFiles(bsaPath) {
        if (!loadedContainers().includes(bsaPath)) xelib.loadContainer(bsaPath);
        return getContainerFiles(bsaPath);
    }

    function getFiles(bsaPath) {
        if (!bsaCache.has(bsaPath)) bsaCache.set(bsaPath, loadBsaFiles(bsaPath));
        return bsaCache.get(bsaPath);
    }

    return {
        getFiles,
        // bsaHelpers.js:27-30 -- filter a container's own file list by a real minimatch pattern.
        find(bsaPath, pattern) {
            const expr = new Minimatch(pattern, { nocase: true });
            return getFiles(bsaPath).filter((p) => expr.match(p));
        },
        // bsaHelpers.js:36-43/45-50/52-59 -- extractFile/extractAsset/extractArchive. `tempDir` is
        // this project's own throwaway extraction cache (bsaHelpers.js used Electron's own `temp`
        // jetpack alias; we're handed a real directory by the caller instead, since a headless
        // worker has no equivalent app-scoped temp folder convention of its own).
        extractFile(tempDir, bsaFileName, filePath, log) {
            const outputPath = path.join(tempDir, bsaFileName, filePath);
            if (!fs.existsSync(outputPath)) {
                if (log) log(`Extracting ${filePath} from ${bsaFileName}`);
                xelib.extractFile(bsaFileName, filePath, outputPath);
            }
            return outputPath;
        },
        extractAsset(tempDir, asset, log) {
            const match = asset.filePath.match(/([^\\]+\.(?:bsa|ba2))\\(.+)/i);
            if (!match) return undefined;
            const [, bsaFileName, filePath] = match;
            return this.extractFile(tempDir, bsaFileName, filePath, log);
        },
        extractArchive(tempDir, archive, log) {
            const outputPath = path.join(tempDir, archive.filename) + path.sep;
            if (!fs.existsSync(outputPath)) {
                if (log) log(`Extracting ${archive.filename}`);
                xelib.extractContainer(archive.filePath, outputPath, true);
            }
            return outputPath;
        },
    };
}

module.exports = { makeBsaHelpers };
