'use strict';
// ONE function that resolves what a classified, non-bundle mod actually installs -- archive entries
// to destination staging paths -- extracted out of lib/extract-mod.js's own main() (2026-09-14,
// "Rebuild Collection, Update Collection, and Rebuild Missing Files share one install and extraction
// engine"). Used by extract-mod.js itself (Rebuild Collection's real extraction, and Update
// Collection v2's via lib/rebuild-single-mod.js -- both already funnel through extract-mod.js, see
// this file's own header note below) AND lib/missing-files-scan.js (Rebuild Missing Files' read-only
// scan, which used to carry its own second copy of this exact sequence) -- a FOMOD/simple-install
// fix only ever needs to land here now.
//
// Historical note, corrected during this task's own investigation: the design side's starting table
// listed Update Collection v2 as having a THIRD, separate "extractMany + copy in the runner" path.
// That's not accurate -- lib/update-collection-v2-runner.js's own Added/Updated-mod loops call
// lib/rebuild-single-mod.js's rebuildSingleMod(), which calls lib/rebuild-mod.js's classifyMod()/
// rebuildMod() (the exact same engine Rebuild Collection uses), which spawns this same
// lib/extract-mod.js as its real extraction child process -- confirmed by reading the call chain
// directly, not assumed. Update Collection v2 was already fully unified with Rebuild Collection
// before this task; only Rebuild Missing Files' own lib/missing-files-scan.js had a genuinely
// separate, re-implemented copy of the FOMOD/simple resolution sequence (and no bundle-mod handling
// at all -- see resolveBundleFiles below for that gap's own fix).
//
// A bundle-type mod (source.type === 'bundle') is NOT resolved by this function -- classifyMod()'s
// own classifyBundledMod (lib/rebuild-mod.js) already fully resolves its file list at classify time
// (action.bundledFiles), so a caller that already has the real `action` object (missing-files-
// scan.js) should just use action.bundledFiles directly -- see resolveBundleFiles() below, a two-
// line helper for exactly that, kept here so both real bundle-aware callers import from one place.
// extract-mod.js's own extractBundledMod() is the one exception: it's a standalone CLI script, spawned
// as a bare child process (Rebuild Collection's own runExtract) with no access to the parent's
// already-computed `action` object -- it re-derives the same result independently (listArchive +
// resolveBundledEntries), which is correct and unavoidable given that process boundary, not a gap.

const fs = require('fs');
const path = require('path');

const { extractFile } = require('./sevenzip');
const { parseModuleConfig, hasUnhandledFeatures, readXmlFile } = require('./fomod-parser');
const { resolveChoices } = require('./choice-resolver');
const { findModRoot, hasFomodInstaller } = require('./mod-root');
const { resolveSimpleInstall } = require('./simple-installer');
const { resolveScriptExtenderInstall } = require('./script-extender-installer');
const { resolveInstalledFileState } = require('./missing-masters-scan');
const { getInstalledGameVersion } = require('./game-version');
const { validateFomodXml } = require('./fomod-schema-validator');

// action.bundledFiles is already the real, fully-resolved {source, destination}[] list --
// classifyBundledMod (lib/rebuild-mod.js) computed it once, at classify time, via
// lib/bundle-resolver.js's resolveBundledEntries. No archive I/O needed here at all.
function resolveBundleFiles(action) {
    return { files: action.bundledFiles };
}

// mod: a real collection.json mod entry ({name, source, choices, domainName}).
// archiveEntries: sevenzip.listArchive() output for archivePath -- callers already have this in
// every real case (classifyMod's own SKIP_OPEN_FOMOD check already lists it, or the caller lists it
// for its own reasons), so it's a required param here, not re-fetched.
// scratchRoot: where a FOMOD's own tiny ModuleConfig.xml gets peeked to (a short-lived mkdtemp
// subfolder, removed before this returns) -- same drive as the caller's own real work, not a fixed
// system temp path (see this task's own scratch-folder convention note in TECHNICAL.md).
//
// Returns one of:
//   { files: {source, destination}[], warnings, flags, rootPrefix, fomodStepCount,
//     conditionalPatternCount } -- a real FOMOD, its recorded choices replayed. `warnings` here
//     already includes choice-resolver.js's own `conditionWarnings` (the "couldn't check installed
//     files/game version" disclosure for an unresolvable conditionalFileInstalls dependency,
//     2026-09-15) -- this is the real production extraction consumer, so the fold happens here,
//     not inside choice-resolver.js itself (see that file's own header comment for why the two stay
//     separate return fields there).
//   { files: {source, destination}[], fellBackFromStaleFomod } -- a simple (non-FOMOD) install;
//     fellBackFromStaleFomod is true only when collection.json recorded FOMOD choices but this
//     archive genuinely has none (a stale/wrong recorded installerChoicesType -- see
//     extract-mod.js's own original header note on the real Merge History incident this covers)
//   { unresolvable: reason } -- a FOMOD using a feature this tool can't parse yet (a top-level
//     always-installed <files> block outside <installSteps>) -- never guesses at a resolution.
// An "Open FOMOD" (the archive has a real FOMOD wizard but collection.json has no recorded choices
// for it) is NOT handled here -- classifyMod() itself already refuses that case before a mod ever
// reaches REBUILD kind (SKIP_OPEN_FOMOD), so every real caller of this function already knows it
// can't happen. Never throws for an "expected" FOMOD shape problem; only a genuine tool failure (a
// 7z error extracting the tiny ModuleConfig.xml, or a truly malformed one parseModuleConfigFile
// itself can't parse) propagates as a real thrown error, same as before this was extracted.
async function resolveFomodOrSimpleFiles(mod, archiveEntries, archivePath, { sevenZipExe, scratchRoot }) {
    const archiveHasFomod = hasFomodInstaller(archiveEntries);
    const recordedFomodChoices = !!(mod.choices && mod.choices.type === 'fomod');

    if (recordedFomodChoices && archiveHasFomod) {
        // Needed both to expand any <folder> entries (whole-directory copies) against what's
        // actually in the archive, AND to find the real "mod root" (the folder directly
        // containing fomod\ModuleConfig.xml) -- some archives nest the FOMOD inside one or more
        // extra containing folders instead of putting it at the archive root.
        const { configPath, rootPrefix } = findModRoot(archiveEntries);

        // Peek just the FOMOD config, not the whole archive.
        fs.mkdirSync(scratchRoot, { recursive: true });
        const scratchDir = fs.mkdtempSync(path.join(scratchRoot, '.fomod-peek-'));
        let parsedFomod;
        let validationBypassWarning;
        try {
            const extractedConfigPath = await extractFile(sevenZipExe, archivePath, configPath, scratchDir);
            const rawXml = readXmlFile(extractedConfigPath);
            // Real XSD schema validation (2026-09-15, "validate the installer against the real
            // schema" -- item 2a). This is the real, unattended, no-live-UI extraction path (a
            // background rebuild replaying already-recorded choices) -- there's no dialog to block
            // on here the way the interactive picker (lib/fomod-picker-data.js) can, so a genuine
            // validation failure fails THIS mod's rebuild with a clear, actionable message instead
            // (the existing `unresolvable` contract every caller already handles), pointing at the
            // interactive Install screen (Rebuild Missing Files/Rebuild Collection) as the real place
            // to review and confirm "install anyway." Once a director does that, the resulting
            // choices carry `ignoreFomodValidation: true` (buildFomodChoicesFromPicks) and this same
            // background path skips the block on every later rebuild of the same recorded choices --
            // never re-validating the exact same already-confirmed archive over and over.
            const ignoreFomodValidation = mod.choices.ignoreFomodValidation === true;
            const validation = await validateFomodXml(rawXml);
            if (!validation.valid && !ignoreFomodValidation) {
                return {
                    unresolvable: validation.unsupportedVersion
                        ? `This mod's installer uses a version (${validation.unsupportedVersion}) this tool doesn't recognize, so we can't be sure it will work correctly. Open this mod's install screen to review the issue and choose whether to install it anyway.`
                        : "This mod's installer didn't pass standard checks, so we can't be sure it will work correctly. Open this mod's install screen to review the issue and choose whether to install it anyway.",
                };
            }
            if (!validation.valid) {
                // Unlike the real engine (whose per-version parser dispatch genuinely can't run at
                // all for a version outside 1.0-5.0), this project's own parser is version-agnostic --
                // it reads whatever elements it recognizes regardless of the declared version, so an
                // override can genuinely still work here, unlike real Vortex. `validation.errors` is
                // only ever present for a real schema violation, never for `unsupportedVersion`.
                const why = validation.unsupportedVersion
                    ? `it uses a version (${validation.unsupportedVersion}) this tool doesn't recognize`
                    : `it didn't pass standard checks: ${validation.errors.join('; ')}`;
                validationBypassWarning = `This mod's installer didn't pass standard checks (already confirmed "install anyway" for this mod) -- proceeding, but the mod's author should be told: ${why}`;
            }
            parsedFomod = parseModuleConfig(rawXml);
        } finally {
            fs.rmSync(scratchDir, { recursive: true, force: true });
        }

        if (hasUnhandledFeatures(parsedFomod)) {
            return {
                unresolvable: "This mod's FOMOD installer uses a feature this tool can't check yet "
                    + '(a top-level always-installed <files> block outside <installSteps>).',
            };
        }

        // All FOMOD source paths are relative to rootPrefix, not the archive root -- make the
        // archive listing passed to resolveChoices() (used for <folder> expansion) relative the
        // same way, so its prefix-matching logic doesn't need to know about rootPrefix at all.
        const rootPrefixLower = rootPrefix.toLowerCase();
        const relativeEntries = rootPrefix
            ? archiveEntries
                .filter((e) => {
                    const lower = e.path.toLowerCase();
                    return lower.startsWith(`${rootPrefixLower}\\`) || lower.startsWith(`${rootPrefixLower}/`);
                })
                .map((e) => ({ ...e, path: e.path.slice(rootPrefix.length + 1) }))
            : archiveEntries;

        // Real installed-plugin state and real installed game version, for conditionalFileInstalls'
        // fileDependency/gameDependency evaluation (2026-09-15, "conditionalFileInstalls has to
        // evaluate real conditions, not just flags") -- resolved HERE, not inside resolveChoices()
        // itself, which stays a pure/synchronous function with no I/O of its own (matching its
        // existing principle: it doesn't fetch archiveEntries itself either).
        const installedFileState = resolveInstalledFileState();
        const installedGameVersion = await getInstalledGameVersion();
        const { files, warnings, flags, conditionWarnings } = resolveChoices(
            parsedFomod, mod.choices, relativeEntries, installedFileState, installedGameVersion
        );
        return {
            files: files.map((file) => ({
                source: rootPrefix ? `${rootPrefix}\\${file.source}` : file.source,
                destination: file.destination,
            })),
            // conditionWarnings folded straight into warnings -- extract-mod.js's existing
            // `for (const w of resolved.warnings) console.warn(...)` picks up the new "couldn't
            // check installed files/game version" disclosure with zero changes needed there. Kept
            // as a separate field on choice-resolver.js's OWN return (not merged there) only because
            // lib/fomod-picker-data.js's mismatch-detection call site treats any non-empty warnings
            // as "recorded choices are stale, re-pick needed" -- a config/environment gap is a
            // different class of problem and must never trigger that UI state. This call site is
            // the real production rebuild/extraction consumer, so folding here is correct.
            warnings: validationBypassWarning ? [...warnings, ...conditionWarnings, validationBypassWarning] : [...warnings, ...conditionWarnings],
            flags, rootPrefix,
            fomodStepCount: parsedFomod.installSteps.length,
            conditionalPatternCount: parsedFomod.conditionalPatterns.length,
        };
    }

    // A script extender (SKSE64 and friends) is checked BEFORE the generic simple-install resolver,
    // matching Vortex's own real installer priority: `script-extender-installer` registers at
    // priority 10, the SAME priority as the real-FOMOD installer above and well ahead of the generic
    // Basic-mode fallback at priority 100 (confirmed by reading both registerInstaller() calls
    // directly -- see config/vortex-source-refs.json's own "script-extender-installer" entry). Real,
    // confirmed case (2026-09-15, "Rebuild Missing Files says Skyrim Script Extender is missing 536
    // files that are all there"): SKSE64's own archive nests a literal "Data\" folder one level below
    // its own top wrapper folder, which simple-installer.js's stopPatterns-based FindPathPrefix
    // mistakes for an ordinary data-type mod's swallowable "Data\" wrapper (it recognizes "Scripts"
    // as a real Gamebryo folder name and treats the strip point as everything up to and including its
    // own containing "Data\") -- wrong for SKSE, which deploys relative to the GAME ROOT and needs
    // "Data\" preserved as a literal subfolder in the destination. No recorded FOMOD choices AND no
    // real fomod/ModuleConfig.xml ever coexist with a real script-extender loader exe in practice
    // (script extenders don't ship FOMODs), so checking only here -- rather than restructuring the
    // FOMOD-priority branch above -- covers every real case without added risk.
    const scriptExtenderFiles = resolveScriptExtenderInstall(archiveEntries);
    if (scriptExtenderFiles) {
        return { files: scriptExtenderFiles, fellBackFromStaleFomod: recordedFomodChoices || undefined };
    }

    // Either genuinely no FOMOD installer at all (the common "simple" case), or collection.json's
    // recorded choices say 'fomod' but this specific archive doesn't actually have one -- a stale/
    // wrong recorded installerChoicesType (confirmed real, 2026-08-24: Merge History's Undo Merge
    // restoring "mihailimpsandhomonculus.esp" from "Imps and Homonculus (se-ae)"), not a real FOMOD
    // this tool failed to find. Both fall back to the same simple-install resolution; the caller
    // decides whether/how to log the stale-choices case via fellBackFromStaleFomod.
    return { files: resolveSimpleInstall(archiveEntries), fellBackFromStaleFomod: recordedFomodChoices || undefined };
}

module.exports = { resolveFomodOrSimpleFiles, resolveBundleFiles };
