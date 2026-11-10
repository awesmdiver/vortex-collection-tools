'use strict';
// Where the PGPatcher Load Order tool looks for pgtools.exe. Kept free of other requires so the
// lookup can be tested with fake files alone.
//
// Order: (1) the bundled copy (tools/pgtools/pgtools.exe, filled by build-release.ps1), (2) the
// VCT_PGTOOLS_EXE override, (3) developer fallback: the sibling PGPatcher fork's build output
// (skyrim-modding/pgpatcher-fork/build/bin/pgtools.exe, the folder build-release.ps1 bundles from),
// found by walking up from this project to the workspace root. A released copy has no such sibling,
// so (3) is simply absent there. The bundled folder is untracked in git, so anything that cleans
// untracked files empties it in a dev copy; (3) keeps the tool working then.

const fs = require('fs');
const path = require('path');

const FORK_REL = path.join('skyrim-modding', 'pgpatcher-fork', 'build', 'bin', 'pgtools.exe');

// Walk up from startDir to the first folder that contains `skyrim-modding` (the workspace root).
function findSiblingForkExe(startDir) {
    let dir = path.resolve(startDir);
    for (;;) {
        if (fs.existsSync(path.join(dir, 'skyrim-modding'))) return path.join(dir, FORK_REL);
        const parent = path.dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
}

// The walk-up runs only in a developer checkout: a `.git` (folder, or file in a worktree) sits next
// to this project's web/ folder. The installed and portable builds never ship `.git`.
function isDeveloperCheckout(baseDir) {
    return fs.existsSync(path.join(baseDir, '..', '.git'));
}

// Every path to look at, in order. `baseDir` is this project's web/ folder (or any folder inside
// the project); the env var is read now, not at load.
function pgtoolsCandidates(baseDir, env = process.env) {
    return [
        path.join(baseDir, '..', 'tools', 'pgtools', 'pgtools.exe'),
        env.VCT_PGTOOLS_EXE,
        isDeveloperCheckout(baseDir) ? findSiblingForkExe(baseDir) : null,
    ].filter(Boolean);
}

// First candidate that exists, or the first candidate (the bundled path) when none do.
function resolvePgtoolsExe(baseDir, env = process.env) {
    const list = pgtoolsCandidates(baseDir, env);
    for (const p of list) {
        if (fs.existsSync(p)) return p;
    }
    return list[0];
}

module.exports = { isDeveloperCheckout, pgtoolsCandidates, resolvePgtoolsExe, findSiblingForkExe };
