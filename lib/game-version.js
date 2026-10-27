'use strict';
// Real installed Skyrim SE version, moved here 2026-09-15 ("conditionalFileInstalls has to evaluate
// real conditions, not just flags") out of lib/update-collection-v2-runner.js, since
// lib/choice-resolver.js also needs this now (to fulfill a FOMOD gameDependency) and can't require
// update-collection-v2-runner.js: that file already requires lib/fomod-picker-data.js, which
// requires lib/choice-resolver.js -- a reverse require would be circular. This function has no
// dependency on anything in that chain (only fs/path/child_process/./app-config), so it gets its own
// small file. checkGameVersionMismatch() stays behind in update-collection-v2-runner.js -- it's
// unrelated (pure string comparison, no I/O) and separately tested by
// scripts/test-check-game-version-mismatch.js.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const appConfig = require('./app-config');

// Skyrim SE's own executable name -- matches GAME_ID='skyrimse' used throughout this project. This
// project is SE-only (VR would be SkyrimVR.exe, a genuinely different game as far as this app is
// concerned, and not something this constant needs to cover).
const SKYRIM_EXE_NAME = 'SkyrimSE.exe';

// Real installed Skyrim SE version, read straight off the .exe's own embedded Windows file-version
// resource -- matches Vortex's OWN default getInstalledVersion() behavior for gamebryo games exactly
// (confirmed via real source, awesmdiver/vortex extensions/test-gameversion/src/gamesupport.ts's own
// header comment: "allow games to have specific functions to get at the version, otherwise take the
// version stored in the executable"). Does NOT need the Vortex Bridge -- the exe's own file version is a
// static Windows PE resource, unrelated to Vortex's live state, so this works even with Vortex fully
// closed (matches this project's own "without the Vortex Bridge" degraded-path convention -- see README's
// compatibility table -- rather than making the whole game-version-mismatch feature Vortex Bridge-only).
// Derives the exe's path from skyrimDataDir (already a real, user-configured Settings field --
// Data/'s own parent folder is the game root SkyrimSE.exe lives in), no new Settings field needed.
// Returns null (never throws) on ANY failure -- no skyrimDataDir configured, the exe genuinely
// missing, PowerShell unavailable -- matching this project's own "gracefully degrade, never block
// the feature" convention for optional data throughout. lib/choice-resolver.js's own
// gameDependencyMatches() treats a null result as "can't check" (honest fallback: not matched), the
// same convention as an unresolvable fileDependency.
function getInstalledGameVersion() {
    return new Promise((resolve) => {
        const { skyrimDataDir } = appConfig.loadConfig();
        if (!skyrimDataDir) { resolve(null); return; }
        const exePath = path.join(path.dirname(skyrimDataDir), SKYRIM_EXE_NAME);
        if (!fs.existsSync(exePath)) { resolve(null); return; }
        execFile('powershell.exe', [
            '-NoProfile', '-NonInteractive', '-Command',
            '(Get-Item -LiteralPath $env:VCT_EXE_PATH).VersionInfo.FileVersion',
        ], { timeout: 5000, env: { ...process.env, VCT_EXE_PATH: exePath } }, (err, stdout) => {
            resolve(err ? null : (stdout.trim() || null));
        });
    });
}

module.exports = { getInstalledGameVersion };
