'use strict';
// Shared server-side data layer for the FOMOD choice picker -- extracted 2026-09-17 ("Open FOMOD
// mods get an Install button") out of lib/update-collection-v2-runner.js, which already had this
// working out exactly right for Update Collection v2's own "Updated mod needs a fresh choice" gate.
// Rebuild Missing Files and Rebuild Collection need the exact same three things for their own new
// Install action against a genuine Open FOMOD (no recorded choices anywhere): peek the archive's
// real ModuleConfig.xml (detectFomodChoiceNeed), turn the picker's own answers into the same
// {type:'fomod', options} shape collection.json's own `choices` field already uses
// (buildFomodChoicesFromPicks -- which resolveFomodOrSimpleFiles/choice-resolver.js already consume
// unchanged, no new resolution logic needed anywhere), and serve the FOMOD's own preview images the
// same way Vortex's real wizard does (registerFomodImages/serveFomodImage). Update Collection v2's
// own runner now imports all three from here instead of keeping its own copy.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { locateArchive } = require('./archive-locator');
const { listArchive, extractFile, extractMany } = require('./sevenzip');
const { findModRoot } = require('./mod-root');
const { parseModuleConfig, hasUnhandledFeatures, readXmlFile } = require('./fomod-parser');
const { resolveChoices } = require('./choice-resolver');
const { downloadModArchive, resolveApiKey: resolveModDownloadApiKey } = require('./nexus-mod-download');
const { resolveInstalledFileState } = require('./missing-masters-scan');
const { validateFomodXml } = require('./fomod-schema-validator');

// Same Skyrim-SE-only convention already established independently in rebuild-single-mod.js and
// update-collection-v2-runner.js -- this toolkit is Skyrim SE specific throughout.
const NEXUS_GAME_DOMAIN = 'skyrimspecialedition';

// Real FOMOD preview images (2026-08-28) -- server-side only, in-memory, keyed by the mod's own
// Nexus modId (source.modId -- the SAME identifier every real caller already has, never Vortex's own
// internal vortexModId). One entry per mod, overwritten (old scratch dir cleaned up) rather than
// accumulated -- a mod only ever has ONE live FOMOD gate/Install action open at a time in any of
// these tools' own single-operation-at-a-time model, so there's no real case where two different
// extractions for the SAME modId need to coexist. Entries are never actively expired on a timer --
// the scratch dirs are small (just the mod's own Images/ folder, not the whole archive) and get
// replaced on the next detection pass for that same mod, so worst case is a handful of stale-but-
// harmless temp folders from a session closed mid-picker, not an unbounded leak.
const fomodImageCache = new Map(); // modId -> { dir, rootPrefix }

// Every plugin's own <image path="..."/> across every step/group -- collected up front regardless
// of which steps are actually reachable from the current flag state (same "extract everything up
// front, dialog is a pure reader after that" shape the caller below already uses), so navigating
// anywhere in the picker never needs a second extraction pass. Deduped -- several plugins can
// legitimately reference the same image.
function collectFomodImagePaths(parsedFomod) {
    const paths = new Set();
    for (const step of parsedFomod.installSteps) {
        for (const group of step.groups) {
            for (const plugin of group.plugins) {
                if (plugin.image) paths.add(plugin.image);
            }
        }
    }
    return [...paths];
}

// Windows filesystem semantics (same convention choice-resolver.js's own <file source> matching
// already uses) -- an archive's real casing frequently doesn't match ModuleConfig.xml's own
// casing verbatim, and mixed '/'/'\\' has shown up in the wild too.
function normalizePathForMatch(p) {
    return p.replace(/\//g, '\\').toLowerCase();
}

// Returns a fresh, opaque per-registration token, stored alongside the cache entry -- the picker
// gets it back on its own `need` object (see detectFomodChoiceNeed's `imageCacheToken`) and hands
// it back on cancel-cleanup (releaseFomodImages, below). A plain modId isn't enough to identify
// THIS specific registration: cancel a picker, then immediately reopen the same mod, and a second
// registration for the SAME modId now points at a different scratch dir -- the token lets
// releaseFomodImages tell "the registration I was asked to clean up" apart from "whatever's
// registered for this modId right now" and refuse to delete a dir a live session may already be
// using.
function registerFomodImages(modId, dir, rootPrefix) {
    const prior = fomodImageCache.get(modId);
    if (prior && prior.dir !== dir) fs.rmSync(prior.dir, { recursive: true, force: true });
    const token = crypto.randomUUID();
    fomodImageCache.set(modId, { dir, rootPrefix: rootPrefix || '', token });
    return token;
}

// Best-effort cleanup for a cancelled FOMOD picker (2026-09-17, item 12b,
// diagnostics/fomod-parity/findings-log.md -- "clean up after a cancelled FOMOD picker"). Real
// Vortex's own cancel path is fully transactional (neither FOMOD engine variant writes files
// itself, and its own JS-side cleanup runs unconditionally); ours wasn't -- a cancelled-and-never-
// reopened mod's scratch preview-image dir used to sit under the OS temp folder until the process
// restarted. A no-op, not an error, whenever `token` doesn't match the CURRENTLY registered entry
// for this modId -- covers both "nothing was ever registered for this modId" and "a newer
// registration (the same mod reopened immediately after cancelling) has already replaced it," so
// this can never delete a dir a live session is about to use. Deleting the dir itself is wrapped in
// its own try/catch -- disk hygiene only; a failure here must never reach whoever just pressed
// Cancel (see web/server.js's own /api/fomod-image-cleanup route, which calls this and always
// responds ok regardless of outcome).
function releaseFomodImages(modId, token) {
    const key = String(modId);
    const entry = fomodImageCache.get(key);
    if (!entry || !token || entry.token !== token) return;
    fomodImageCache.delete(key);
    try {
        fs.rmSync(entry.dir, { recursive: true, force: true });
    } catch {
        // Best-effort -- see header comment above.
    }
}

// Resolves a picker-requested image (modId + the FOMOD's own <image path="..."/> value, relative to
// the mod's own root) to a real, already-extracted file on disk -- or null if nothing was ever
// registered for this modId, or the resolved path would escape the registered scratch dir (a
// defensive floor against a crafted imagePath in the request; this project's own real FOMOD archives
// have never needed anything beyond a plain relative path, per fomod-parser.js's own header comment).
function serveFomodImage(modId, imagePath) {
    const entry = fomodImageCache.get(String(modId));
    if (!entry || !imagePath) return null;
    const resolved = path.normalize(path.join(entry.dir, entry.rootPrefix, imagePath));
    const base = path.normalize(entry.dir + path.sep);
    if (!resolved.startsWith(base)) return null;
    return fs.existsSync(resolved) ? resolved : null;
}

// For ONE mod, returns `null` if no fresh choice is needed, or a real detail object (name, reason,
// the parsed FOMOD structure to render) if one is. Never throws -- a mod whose archive can't even be
// located, or isn't a FOMOD-installer archive at all, is a DIFFERENT, pre-existing problem the real
// caller already reports on its own terms; this gate only concerns itself with the specific "needs a
// human FOMOD choice" case.
//
// reason: 'open' (no recorded choices at all -- the case Rebuild Missing Files/Rebuild Collection's
// own new Install action targets) or 'mismatch' (recorded choices no longer cleanly map to the
// archive's own current ModuleConfig.xml -- Update Collection v2's own "revision changed" case; the
// other two tools never hit this branch since they only ever call this for a mod with NO recorded
// choices to begin with).
//
// allowAutoDownload: a brand-new mod (an Update Collection v2 Added/Optional install) has no archive
// on disk yet at gate-check time -- see this function's own original 2026-08-29 fix for the real
// incident this covers. Rebuild Missing Files/Rebuild Collection's own Install action always passes
// this false: their own archive-missing case already has its own separate Download Archive action,
// and conflating the two here would silently download outside that existing, already-understood flow.
//
// resolveInstalledFileState() moved 2026-09-15 ("conditionalFileInstalls has to evaluate real
// conditions, not just flags") to lib/missing-masters-scan.js, since lib/choice-resolver.js also
// needs it now and can't require this file (this file already requires choice-resolver.js --
// a reverse require would be circular). Imported above and re-exported below unchanged, so every
// existing importer of resolveInstalledFileState from this module keeps working.
//
// Real XSD schema validation (2026-09-15, "validate the installer against the real schema, and say
// so when it fails" -- item 2a, diagnostics/fomod-parity/findings-log.md): matches real Vortex,
// which validates every FOMOD load and hard-refuses with a real dialog on failure. `ignoreFomodValidation`
// (a fresh, explicit per-call override -- the picker's own "Install Anyway" retry, see
// web/public/fomod-picker.js) OR a PERSISTED override already recorded on `mod.choices` (set once by
// buildFomodChoicesFromPicks when a session went through that same override -- so a mod a director
// already confirmed "install anyway" for doesn't re-block on every later background rebuild) both
// skip the block. When skipped, the returned need still carries `validationBypassed` so the picker
// can show a small, non-blocking, persistent notice rather than silently hiding that this happened.
async function detectFomodChoiceNeed(mod, downloadsDir, sevenZipExe, allowAutoDownload, installedFileState, ignoreFomodValidation) {
    const fileState = installedFileState || resolveInstalledFileState();
    const persistedIgnore = !!(mod.choices && mod.choices.type === 'fomod' && mod.choices.ignoreFomodValidation === true);
    const shouldIgnoreValidation = !!ignoreFomodValidation || persistedIgnore;
    let archivePath;
    try {
        archivePath = await locateArchive(downloadsDir, mod.source);
    } catch {
        if (!allowAutoDownload || !mod.source || mod.source.type !== 'nexus') {
            return null; // no archive resolvable, and nothing this gate can do about it -- the real
                         // caller's own extraction/scan step already reports this properly
        }
        try {
            const apiKey = resolveModDownloadApiKey();
            await downloadModArchive({ apiKey, gameDomain: NEXUS_GAME_DOMAIN, source: mod.source, destDir: downloadsDir });
            archivePath = await locateArchive(downloadsDir, mod.source);
        } catch {
            return null; // the download itself failed -- a different, pre-existing problem the real
                         // extraction step (which retries this same download) already reports
        }
    }
    let entries;
    try {
        entries = await listArchive(sevenZipExe, archivePath);
    } catch {
        return null;
    }
    // findModRoot THROWS (not a falsy configPath) when the archive has no FOMOD installer at all --
    // a plain, non-FOMOD mod is a legitimate, common outcome here, not an error.
    let configPath;
    let rootPrefix;
    try {
        ({ configPath, rootPrefix } = findModRoot(entries));
    } catch {
        return null;
    }

    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fomod-picker-peek-'));
    let parsedFomod;
    let validationBypassed;
    let keepScratchDir = false;
    let imageCacheToken;
    try {
        const extractedConfigPath = await extractFile(sevenZipExe, archivePath, configPath, scratchDir);
        const rawXml = readXmlFile(extractedConfigPath);
        const validation = await validateFomodXml(rawXml);
        if (!validation.valid) {
            if (!shouldIgnoreValidation) {
                // Blocks BEFORE any parsing/image work -- matching real Vortex, which validates the
                // raw XML first and never even attempts to build a script model from something that
                // failed. `reason: 'invalid'` has no `parsedFomod` at all (the picker's own blocking
                // "Invalid fomod" screen doesn't need one); returning here (inside this try) still
                // runs the `finally` cleanup below correctly.
                return { name: mod.name, reason: 'invalid', validation };
            }
            validationBypassed = validation;
        }
        parsedFomod = parseModuleConfig(rawXml);
        // Real preview images (2026-08-28, director's own build-out -- checked against Vortex's own
        // real FOMOD wizard first, InstallerDialog.tsx's renderImage(): it points a plain <img> at an
        // already-fully-extracted file on disk, never a per-hover extraction or a data URI). This
        // project has no Electron file:// access (a browser tab, not a native window), so the picker
        // serves these over HTTP instead -- same "extract everything up front, dialog is a pure reader
        // after that" shape, just a fetch instead of a direct filesystem read.
        //
        // REWRITTEN 2026-09-15 ("preview images don't show unless they sit in a top-level Images
        // folder") -- this used to only extract archive entries under a literal `<rootPrefix>\images\`
        // prefix, which is a convention Vortex itself doesn't enforce at all: a plugin's <image path>
        // can point ANYWHERE under the mod root. Confirmed against two real archives (director's own
        // report): "Immersive College NPCs" (no wrapper folder, `<image path="fomod\icns_logo.png"/>`
        // -- would never have matched an "images\" prefix filter at all) and Zaki 8K-4K Textures
        // (wrapper folder "Bathing in Skyrim 8K-4K Patch", `<image path="fomod resources\images\
        // intro.jpg"/>` -- under a folder literally named "fomod resources", not "Images"). Confirmed
        // against Vortex's own real source (installer_fomod_shared/views/InstallerDialog.tsx's
        // renderImage(): `path.join(installerInfo.dataPath, image)`, where `dataPath` is the exact
        // same root a plugin's own <file source> paths resolve against -- installer_fomod_native/
        // utils/DialogManager.ts's `dataPath: this.mScriptPath`) -- there's no folder-name convention
        // on Vortex's side to match in the first place. Now extracts exactly the files each plugin's
        // own <image path> references (rootPrefix-relative, same as <file source>), matched
        // case-insensitively against the real archive listing rather than assumed to share the XML's
        // own casing verbatim.
        const imagePaths = collectFomodImagePaths(parsedFomod);
        const entryPathByNormalized = new Map(entries.filter((e) => !e.isDir).map((e) => [normalizePathForMatch(e.path), e.path]));
        const imageEntries = [];
        const seenImageEntries = new Set();
        for (const imagePath of imagePaths) {
            const fullPath = rootPrefix ? `${rootPrefix}\\${imagePath}` : imagePath;
            const realPath = entryPathByNormalized.get(normalizePathForMatch(fullPath));
            // A referenced image genuinely missing from the archive (an author mistake -- confirmed
            // real, "Immersive College NPCs"' own "Change Log v1.0" plugin references
            // "fomod\cya_logo.png", which isn't in the archive at all) is simply skipped -- nothing
            // this gate can extract for it, and the picker's own fallback (no image area, just the
            // description) already handles a plugin with no resolvable image correctly.
            if (realPath && !seenImageEntries.has(realPath)) {
                seenImageEntries.add(realPath);
                imageEntries.push(realPath);
            }
        }
        if (imageEntries.length > 0) {
            try {
                await extractMany(sevenZipExe, archivePath, imageEntries, scratchDir);
                imageCacheToken = registerFomodImages(String(mod.source && mod.source.modId), scratchDir, rootPrefix);
                keepScratchDir = true;
            } catch {
                // Best-effort -- a failure here never blocks the real FOMOD-choice gate this function
                // exists for. The picker's own <img> just falls back to its no-image state if no
                // image ever got registered.
            }
        }
    } catch {
        return null; // couldn't even parse the config -- a different, pre-existing problem
    } finally {
        if (!keepScratchDir) fs.rmSync(scratchDir, { recursive: true, force: true });
    }
    // A top-level always-installed <files> block is a different, already-known parser gap
    // (fomod-parser.js's own header comment) -- not this gate's problem to solve.
    if (hasUnhandledFeatures(parsedFomod)) return null;

    const hasRecordedChoices = mod.choices && mod.choices.type === 'fomod';
    if (!hasRecordedChoices) {
        return { name: mod.name, reason: 'open', parsedFomod, installedFileState: fileState, validationBypassed, imageCacheToken };
    }

    const rootPrefixLower = (rootPrefix || '').toLowerCase();
    const relativeEntries = rootPrefix
        ? entries
            .filter((e) => {
                const lower = e.path.toLowerCase();
                return lower.startsWith(`${rootPrefixLower}\\`) || lower.startsWith(`${rootPrefixLower}/`);
            })
            .map((e) => ({ ...e, path: e.path.slice(rootPrefix.length + 1) }))
        : entries;
    const { warnings } = resolveChoices(parsedFomod, mod.choices, relativeEntries);
    if (warnings.length > 0) {
        // existingChoices: the collection's own recorded (but no-longer-cleanly-replayable) picks --
        // passed through so the picker can pre-select + label whatever still matches by name as
        // "(Preset)", matching real Vortex's own real preset-driven dialog. Deliberately NOT set for
        // the "open" reason above -- there's nothing recorded to preset from, matching real Vortex
        // exactly (no supplied preset there either).
        return {
            name: mod.name, reason: 'mismatch', warnings, parsedFomod, existingChoices: mod.choices,
            installedFileState: fileState, validationBypassed, imageCacheToken,
        };
    }
    return null;
}

// Builds the FULL `choices.options` structure resolveChoices() expects from a user's fresh real
// picks -- one entry per RAW install step (in document order, matching resolveChoices' own
// positional-match contract), each with EVERY group (even one with zero real selections, as an
// empty `choices: []`) -- an entry must exist for every step/group or resolveChoices would log a
// spurious "no recorded choices" warning for a group that was correctly, deliberately left empty.
// `picks`: `{ [stepIdx]: { [groupIdx]: number[] } }` -- the frontend's own selected plugin indices
// per group, keyed positionally (matching how the picker renders parsedFomod.installSteps).
//
// `ignoreFomodValidation` (2026-09-15, "validate the installer against the real schema"): true only
// when this picker session went through the "Install Anyway" override on a schema-validation
// failure -- persisted onto the resulting choices themselves (not just used once) so a LATER
// background rebuild replaying these exact same recorded choices (lib/mod-install-plan.js) doesn't
// re-block on the same already-confirmed-okay archive.
function buildFomodChoicesFromPicks(parsedFomod, picks, ignoreFomodValidation) {
    const options = parsedFomod.installSteps.map((step, stepIdx) => ({
        name: step.name,
        groups: step.groups.map((group, groupIdx) => {
            // A SelectAll group has no real choice to make -- every plugin installs regardless of
            // any pick, matching the real FOMOD spec. Auto-including every index here (rather than
            // relying on the frontend to send them all) means a SelectAll group's own files can
            // never be silently dropped just because nothing was rendered as clickable for it.
            const selectedIndices = group.type === 'SelectAll'
                ? group.plugins.map((_, idx) => idx)
                : (picks && picks[stepIdx] && picks[stepIdx][groupIdx]) || [];
            return {
                name: group.name,
                choices: selectedIndices.map((idx) => ({ idx, name: group.plugins[idx] ? group.plugins[idx].name : '' })),
            };
        }),
    }));
    return { type: 'fomod', options, ignoreFomodValidation: ignoreFomodValidation || undefined };
}

module.exports = {
    NEXUS_GAME_DOMAIN, detectFomodChoiceNeed, buildFomodChoicesFromPicks, registerFomodImages, serveFomodImage,
    releaseFomodImages,
    // Exported 2026-09-15 for lib/update-collection-v2-runner.js's own detectFomodChoiceNeeds(), so a
    // batch of (up to ~41) mods resolves the Data folder/Plugins.txt ONCE and passes the same result
    // into every detectFomodChoiceNeed call, instead of re-scanning the whole Data folder per mod.
    resolveInstalledFileState,
};
