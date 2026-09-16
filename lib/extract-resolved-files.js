'use strict';
// Extracts a resolved {source, destination}[] file list out of an archive and into a destination
// folder -- ONE real 7z call into a scratch dir (preserving archive-relative paths), then a copy
// into each real destination. Copy, not move/rename, deliberately -- if a FOMOD ever maps the same
// archive source to two different destinations (two <file> entries sharing a source), a move would
// make the second one fail with the file already gone; a copy handles that safely at negligible
// extra cost (same-drive local copy, not a fresh process spawn).
//
// Extracted out of lib/extract-mod.js's own installResolvedFiles (2026-09-14, "Rebuild Collection,
// Update Collection, and Rebuild Missing Files share one install and extraction engine") -- Rebuild
// Collection (via extract-mod.js, and so Update Collection v2 too, which already funnels through
// extract-mod.js via lib/rebuild-single-mod.js) and Rebuild Missing Files (web/rebuild-missing-
// routes.js's own extractOneMod, which used to run its own separate scratch-extract-then-copy) both
// call this one function now.
//
// scratchRoot convention (2026-09-14): pass a folder on the SAME DRIVE as destDir, so the final copy
// stays a fast same-drive operation and a large restore never fills a small C: drive. Rebuild
// Collection already scratched next to its own output folder; Rebuild Missing Files used to scratch
// under os.tmpdir() (typically C:) regardless of which drive staging actually lives on -- both real
// callers now pass a scratch root derived from the real staging folder's own drive.
//
// Returns the archive members that never made it into destDir -- either extractMany() itself
// already knew it couldn't extract them (see that function's own header comment -- a partial
// failure no longer throws, it reports), OR the bulk 7z listfile call exited 0 while silently
// skipping one bad member anyway (confirmed real, 2026-09-14, via this file's own
// scripts/test-extract-resolved-files.js: a listfile mixing one real member with one that doesn't
// exist in the archive extracts the real one and exits 0 with NOTHING reported skipped -- trusting
// extractMany()'s own list alone crashed the very next copyFileSync on the member that was never
// actually written to the scratch dir). A real `fs.existsSync` check on the scratch path is the only
// way to know for sure, so every resolvedFiles entry is verified against disk here, not just against
// extractMany()'s own report -- this was already how web/rebuild-missing-routes.js's own pre-
// extraction extractOneMod worked before this function replaced its copy; folded in here so every
// caller gets the same real safety net.
const fs = require('fs');
const path = require('path');
const { extractMany } = require('./sevenzip');

async function extractResolvedFiles(sevenZipExe, archivePath, resolvedFiles, destDir, scratchRoot) {
    if (resolvedFiles.length === 0) return [];
    fs.mkdirSync(scratchRoot, { recursive: true });
    const scratchDir = fs.mkdtempSync(path.join(scratchRoot, '.sevenzip-scratch-'));
    try {
        const reportedSkipped = await extractMany(sevenZipExe, archivePath, resolvedFiles.map((f) => f.source), scratchDir);
        const reportedSkippedSources = new Set(reportedSkipped.map((s) => s.path));
        const skipped = [...reportedSkipped];
        for (const f of resolvedFiles) {
            if (reportedSkippedSources.has(f.source)) continue;
            const srcPath = path.join(scratchDir, f.source);
            if (!fs.existsSync(srcPath)) {
                skipped.push({ path: f.source, error: 'extraction reported success, but this member was never written to disk' });
                continue;
            }
            const destFullPath = path.join(destDir, f.destination);
            fs.mkdirSync(path.dirname(destFullPath), { recursive: true });
            fs.copyFileSync(srcPath, destFullPath);
        }
        return skipped;
    } finally {
        fs.rmSync(scratchDir, { recursive: true, force: true });
    }
}

module.exports = { extractResolvedFiles };
