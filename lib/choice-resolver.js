'use strict';
// Cross-references a parsed FOMOD structure (fomod-parser.js) against a collection.json mod's
// recorded "choices" block, producing the final flat list of {source, destination} file pairs to
// extract -- the exact reproduction of what Vortex's own FOMOD installer wizard would have
// written out, with zero UI interaction. See the plan/README for the full validated mapping.
//
// Handles conditionFlags + conditionalFileInstalls (validated against "Smoking Torches and
// Candles", whose correct plugin .esp file lives in one of six mutually-exclusive folders
// depending on choices made in two OTHER, unrelated install steps) and <folder> entries (whole
// directory copies, expanded here against the archive's actual listing since the parser alone
// has no visibility into what's really inside the archive).
//
// EXTENDED 2026-09-15 ("conditionalFileInstalls has to evaluate real conditions, not just flags"):
// a conditionalFileInstalls pattern's own condition is now evaluated as a REAL composite --
// fileDependency/gameDependency/nested And-Or, not just flags -- via conditionIsFulfilled/
// patternMatches below. Confirmed real, concrete bug this fixes: "Armory Extended - Bonemold Weapon
// Pack" gates each of its 6 patterns on a flag AND a fileDependency (the "with WACCF"/"without
// WACCF" variant of the same patch); the old flags-only check made both variants match at once. Also
// added: alwaysInstall/installIfUsable support for unselected group options (resolvePluginType, the
// second pass inside resolveChoices below) -- real but not confirmed in any archive this project has
// seen. See diagnostics/fomod-parity/findings-log.md items 9a/9c for the full audit trail and real
// archive counts, and fomod-parser.js's own parsePattern/parseCondition header comments for why
// script-extender-version dependencies (fommDependency etc.) are a deliberate non-fix, not a gap.
//
// Destination-collision tie-break verified against Vortex's real open-source engine
// (Nexus-Mods/fomod-installer, XmlScriptInstaller.cs::InstallFiles/ShouldUpdate), NOT guessed:
// installation runs in phases, each with a hardcoded priority offset --
//   required/always-install files: -10^9 (lowest)
//   normal selected-option files:    0
//   conditionalFileInstalls files:  +10^9 (highest -- always beats a plain option file)
// Within the same phase (ties), the file whose SOURCE path is lexicographically greater wins
// (`fromPath.CompareTo(oldInstruction.source) > 0`) -- this is a pure string comparison, NOT
// "first wins" or "last wins" by processing order. Confirmed against the real mismatch: pattern
// "candles+ESPFE" (source ".../candles/ESPFE/...") beat pattern "torches+candles+ESPFE" (source
// ".../both/ESPFE/...") in real Vortex output purely because "candles" > "both" as a string --
// order of the two <pattern> elements in ModuleConfig.xml is irrelevant.

const PHASE_REQUIRED = -1000000000;
const PHASE_SELECTED_OPTION = 0;
const PHASE_CONDITIONAL_PATTERN = 1000000000;

function matchesFlagDependency(flags, dep) {
    return (flags.get(dep.flag) ?? '') === dep.value;
}

// fileDependency ("state" is Active/Inactive/Missing), resolved against the player's REAL install --
// the exact same rule (and the exact same non-plugin-file caveat) as web/public/fomod-picker.js's own
// `fomodFileDependencyMatches`, ported here since that file is browser-only (no bundler to share one
// implementation across runtimes -- this project's own established convention, e.g. this file's
// header comment on ShouldUpdate/expandFolder already being independently-verified twins of the real
// engine, not literal shared code). `fileState` is `{available, presentSet, activeSet}` -- Sets built
// ONCE per resolveChoices() call from resolveInstalledFileState()'s own plain arrays (see that
// function's header, lib/missing-masters-scan.js), never re-fetched per pattern.
//
// Confirmed against the real engine (PluginCondition.cs's own GetIsFulfilled, via
// CallbackPluginDelegates.cs -> Vortex's own SharedDelegates.ts getAllPlugins()): a fileDependency
// can ONLY ever resolve Active/Inactive for a real PLUGIN file (.esp/.esm/.esl) -- Vortex's own
// delegate answers strictly from its tracked plugin list, which by construction never contains a
// loose file or a BSA. A fileDependency naming anything else always resolves Missing in real Vortex
// too, not a limitation unique to this project.
//
// "Keep it honest when we can't tell" -- when fileState isn't available (skyrimDataDir/pluginsListDir
// not configured, or the real read failed), a fileDependency is treated as NOT matched (false) rather
// than vacuously true, matching the same disclosed-fallback decision the FOMOD pre-selection fix
// already made for the picker: under-selecting (leaving a conditional file OUT) is the honest failure
// mode here, paired with a disclosed warning (see resolveChoices' own conditionWarnings) -- silently
// guessing "satisfied" would just reproduce the exact over-inclusive bug this whole fix exists to
// close (see fomod-parser.js's own parsePattern header comment for the real Armory Extended case).
const PLUGIN_EXT_RE = /\.(esp|esm|esl)(\.ghost)?$/i;
function fileDependencyMatches(dep, fileState) {
    if (!fileState || !fileState.available) return false;
    const key = (dep.file || '').trim().toLowerCase();
    if (!PLUGIN_EXT_RE.test(key)) return dep.state === 'Missing';
    const present = fileState.presentSet.has(key);
    const active = fileState.activeSet.has(key);
    if (dep.state === 'Active') return present && active;
    if (dep.state === 'Inactive') return present && !active;
    if (dep.state === 'Missing') return !present;
    return false;
}

// gameDependency's own `version` is the real engine's MINIMUM required version
// (GameVersionCondition.GetIsFulfilled: `installedVersion >= MinimumVersion`) -- a real 4-segment
// numeric comparison, NOT a lexicographic string compare (Skyrim SE versions like "1.6.1170.0" would
// sort wrong lexicographically against e.g. "1.6.640.0" -- "1170" < "640" as strings). Missing
// segments on either side compare as 0 (a real version string is always fully dotted in practice, but
// this stays correct even for a malformed one). Same honest-fallback rule as fileDependencyMatches
// above: an unresolvable installed version treats the dependency as NOT met.
function compareVersionStrings(a, b) {
    const partsA = String(a).split('.').map((n) => parseInt(n, 10) || 0);
    const partsB = String(b).split('.').map((n) => parseInt(n, 10) || 0);
    const len = Math.max(partsA.length, partsB.length);
    for (let i = 0; i < len; i++) {
        const diff = (partsA[i] || 0) - (partsB[i] || 0);
        if (diff !== 0) return diff > 0 ? 1 : -1;
    }
    return 0;
}
function gameDependencyMatches(dep, installedGameVersion) {
    if (!installedGameVersion || !dep.version) return false;
    return compareVersionStrings(installedGameVersion, dep.version) >= 0;
}

// The real composite-condition evaluator -- shared by conditionalFileInstalls patterns (via
// patternMatches below) AND the new installIfUsable plugin-type check (resolvePluginType below).
// Mirrors web/public/fomod-picker.js's own fomodEvalCondition exactly (same empty-composite fix:
// native Array.prototype.every()/some() already give the correct real per-operator semantics --
// vacuously true for an empty And, vacuously false for an empty Or -- with no length check needed;
// see that file's own header comment for the real CompositeCondition.cs citation and the concrete
// Atlas Map Markers Overhaul bug this fixed there). `extenderDependencies`
// (fomm/fose/skse/nvse/f4se) are deliberately always-satisfied -- see fomod-parser.js's own
// parseCondition header for why this is a decision, not a gap. `unresolved` is a plain mutable
// `{fileState, gameVersion}` object this function sets flags on (never reads) when a dependency of
// that kind is actually present in the condition but the real state needed to answer it wasn't
// available -- resolveChoices() turns those flags into a real, disclosed warning afterward.
function conditionIsFulfilled(cond, flags, fileState, installedGameVersion, unresolved) {
    if (!cond) return true;
    const results = [];
    for (const d of cond.flagDependencies || []) results.push(matchesFlagDependency(flags, d));
    for (const d of cond.fileDependencies || []) {
        if (!fileState || !fileState.available) unresolved.fileState = true;
        results.push(fileDependencyMatches(d, fileState));
    }
    for (const d of cond.gameDependencies || []) {
        if (!installedGameVersion) unresolved.gameVersion = true;
        results.push(gameDependencyMatches(d, installedGameVersion));
    }
    for (const _d of cond.extenderDependencies || []) results.push(true);
    for (const nested of cond.nested || []) results.push(conditionIsFulfilled(nested, flags, fileState, installedGameVersion, unresolved));
    return cond.operator === 'Or' ? results.some(Boolean) : results.every(Boolean);
}

function patternMatches(flags, pattern, fileState, installedGameVersion, unresolved) {
    return conditionIsFulfilled(pattern.condition, flags, fileState, installedGameVersion, unresolved);
}

// The real engine's own installIfUsable check (see resolveChoices' own second pass, below) needs a
// plugin's resolved type -- mirrors web/public/fomod-picker.js's fomodResolveType exactly (first
// matching pattern wins, else the type descriptor's own default).
function resolvePluginType(typeDescriptor, flags, fileState, installedGameVersion, unresolved) {
    if (!typeDescriptor) return 'Optional';
    for (const p of typeDescriptor.patterns || []) {
        if (conditionIsFulfilled(p.condition, flags, fileState, installedGameVersion, unresolved)) return p.type;
    }
    return typeDescriptor.default || 'Optional';
}

// Expands a <folder source=".." destination=".."/> entry into individual {source, destination}
// file pairs by matching every archive entry whose path falls under the folder's source prefix --
// the parser can't do this itself since it has no visibility into what's actually in the archive.
function expandFolder(folderEntry, archiveEntries) {
    const srcPrefix = folderEntry.source.replace(/\/+$|\\+$/, ''); // strip trailing separator
    const srcPrefixLower = srcPrefix.toLowerCase();
    const files = [];
    for (const entry of archiveEntries) {
        if (entry.isDir) continue;
        const entryPath = entry.path;
        const entryLower = entryPath.toLowerCase();
        // Match "srcPrefix\..." or "srcPrefix/..." (archive paths can use either separator),
        // case-insensitively (Windows filesystem semantics -- confirmed relevant this session,
        // e.g. "ImprovedCompanionsBoogaloo.esp" vs a differently-cased sibling entry elsewhere).
        if (!entryLower.startsWith(srcPrefixLower + '\\') && !entryLower.startsWith(srcPrefixLower + '/')) {
            continue;
        }
        const relative = entryPath.slice(srcPrefix.length + 1);
        const destination = folderEntry.destination
            ? `${folderEntry.destination.replace(/\/+$|\\+$/, '')}\\${relative}`
            : relative;
        files.push({ source: entryPath, destination, phase: folderEntry.phase });
    }
    return files;
}

function expandEntries(entries, archiveEntries, warnings) {
    const out = [];
    for (const entry of entries) {
        if (entry.kind === 'folder') {
            out.push(...expandFolder(entry, archiveEntries));
        } else if (entry.mkdirOnly) {
            // Matches Vortex's own real installer -- see fomod-parser.js's own comment on this
            // flag. No file is ever installed here, only an (empty) destination folder, so there's
            // nothing to add to the extraction list. A manifest-based rebuild comparison never
            // notices an empty folder's absence either way, so there's no need to fabricate one.
            warnings.push(`"${entry.source}" has a destination ending in a separator ("${entry.destination}") -- matching Vortex's own installer, this file is NOT installed (only an empty destination folder would be created); excluded here.`);
        } else {
            out.push({ source: entry.source, destination: entry.destination, phase: entry.phase });
        }
    }
    return out;
}

// archiveEntries: the target archive's full listing (sevenzip.listArchive() output) -- required
// to expand <folder> entries. Pass [] if the FOMOD is known to use only <file> entries.
//
// installedFileState (2026-09-15, "conditionalFileInstalls has to evaluate real conditions, not just
// flags"): the SAME shape lib/missing-masters-scan.js's resolveInstalledFileState() returns
// (`{available, present, active}`, plain arrays) -- resolveChoices() converts to Sets once, here, for
// every pattern's own fileDependency checks. installedGameVersion: a plain version string (e.g.
// "1.6.1170.0"), typically lib/game-version.js's getInstalledGameVersion() result. Both optional --
// resolveChoices() itself stays a pure, synchronous function with no I/O of its own (matching its
// existing design: it doesn't fetch archiveEntries itself either, every caller resolves its own
// inputs first) -- when either is omitted or unavailable, a fileDependency/gameDependency-gated
// conditionalFileInstalls pattern is honestly treated as NOT matching (see fileDependencyMatches'/
// gameDependencyMatches' own header comments for why under-selecting is the disclosed, deliberate
// choice here), and `conditionWarnings` (a SEPARATE array from `warnings` -- see its own note below)
// reports exactly which piece of state couldn't be checked.
function resolveChoices(parsedFomod, choices, archiveEntries, installedFileState, installedGameVersion) {
    if (!choices || choices.type !== 'fomod') {
        throw new Error(`Expected a "fomod" choices block, got: ${JSON.stringify(choices)}`);
    }
    const fileState = installedFileState && installedFileState.available
        ? { available: true, presentSet: new Set(installedFileState.present || []), activeSet: new Set(installedFileState.active || []) }
        : { available: false };
    const unresolved = { fileState: false, gameVersion: false };

    const rawEntries = [];
    const warnings = [];
    const flags = new Map(); // later steps' selections overwrite earlier ones for the same flag name
    // {group, selectedNames} per group actually processed above -- reused by the second,
    // alwaysInstall/installIfUsable pass below instead of re-deriving recordedStep/recordedGroup a
    // second time for the exact same steps/groups.
    const groupSelections = [];

    // Installed unconditionally, regardless of any choice -- lowest priority phase, so a
    // colliding selected-option or conditional-pattern file always wins over one of these.
    for (const f of parsedFomod.requiredInstallFiles || []) rawEntries.push({ ...f, phase: PHASE_REQUIRED });

    // Recorded choices.options is a FLAT list with exactly one entry per RAW install step, in
    // document order, recorded UNCONDITIONALLY -- confirmed against real data ("Dragon Priests
    // Retexture SE - Half Res": 11 raw installSteps, 11 recorded options, matching 1:1 in order).
    // That FOMOD has two installSteps both literally named "Mesh Patches - Masks", gated on
    // MUTUALLY EXCLUSIVE visibility conditions (Morokei Gold vs. Morokei Blue) -- only one is ever
    // actually shown to the user, yet BOTH get a recorded entry (the unshown one simply has
    // empty/default selections, contributing zero files either way). This proves Vortex records
    // per RAW step unconditionally, not per step actually displayed -- an initial attempt at this
    // fix that skipped recording-cursor advancement for "invisible" steps immediately misaligned
    // the whole list (confirmed live: introduced a NEW set of missing-group warnings that didn't
    // exist before). Position is still the right key (name-based `.find()` breaks the instant two
    // steps share a name -- confirmed this was exactly why "Belt Worn Masks", recorded on the
    // SECOND "Mesh Patches - Masks" step, never got applied: both steps resolved to the FIRST,
    // empty entry) -- just a PLAIN 1:1 zip, no visibility filtering.
    parsedFomod.installSteps.forEach((step, stepIdx) => {
        const recordedStep = choices.options[stepIdx];
        if (!recordedStep) {
            warnings.push(`No recorded choices for installStep "${step.name}" (position ${stepIdx}) -- skipping its files entirely.`);
            return;
        }
        // fast-xml-parser trims attribute values by default, but Vortex's own recorded
        // choices.options preserves whatever whitespace the mod author actually put in the
        // ModuleConfig.xml `name` attribute verbatim -- confirmed against a real archive ("Nordic
        // Faces - Textures and Body Meshes") whose own XML literally has `name="High Poly Vanilla
        // Male Body "` (trailing space). An exact-string comparison against our own (trimmed) parsed
        // name silently failed to find the recorded group, dropping its real selection entirely.
        // Compare trimmed on both sides everywhere a name is matched against a recorded name.
        const stepNameTrimmed = step.name.trim();
        if (recordedStep.name.trim() !== stepNameTrimmed) {
            warnings.push(`Recorded choices at position ${stepIdx} are for "${recordedStep.name}", not "${step.name}" as expected -- using them anyway (position-matched), but this FOMOD's structure may not be fully understood.`);
        }

        for (const group of step.groups) {
            const groupNameTrimmed = group.name.trim();
            const recordedGroup = recordedStep.groups.find((g) => g.name.trim() === groupNameTrimmed);
            if (!recordedGroup) {
                warnings.push(`No recorded choices for group "${step.name}" / "${group.name}" -- skipping.`);
                continue;
            }

            // By NAME only, trimmed both sides -- NOT `idx`, even though a recorded choice carries
            // one. Confirmed against the real engine's own source (Nexus-Mods/fomod-installer,
            // XmlScriptExecutor.cs's `convertPreset`/`ConvertChoices` parses `idx` off each recorded
            // choice into `OptionsPresetChoice.idx`, but the ONLY place a preset choice is actually
            // matched against a real Option is `groupPreset.choices.Any(preChoice => preChoice.name
            // == option.Name)` -- `idx` is parsed and then never read again anywhere in that file).
            // So position-matching (this project's own old `${idx}:${name}` composite key) is
            // actually STRICTER than the real engine -- it would wrongly reject a real match if a
            // re-released archive ever reordered a group's plugins without renaming them, something
            // the real engine tolerates fine. Trimmed for the same reason step/group names are just
            // above: fast-xml-parser's default trims an ATTRIBUTE value it parses (so `plugin.name`
            // here is already trimmed), while collection.json's own recorded `c.name` preserves
            // whatever whitespace Vortex's real (untrimmed, `XElement.Attribute(...).Value`) engine
            // saw in the archive's XML verbatim -- confirmed real (2026-09-14, "Aetherius - A Race
            // Overhaul": both plugin names in the archive's own ModuleConfig.xml have a trailing
            // space) -- an exact-string match here silently failed to select the plugin at all.
            const selectedNames = new Set(recordedGroup.choices.map((c) => c.name.trim()));
            groupSelections.push({ group, selectedNames });
            group.plugins.forEach((plugin) => {
                if (selectedNames.has(plugin.name.trim())) {
                    for (const f of plugin.files) rawEntries.push({ ...f, phase: PHASE_SELECTED_OPTION });
                    for (const flag of plugin.conditionFlags) flags.set(flag.name, flag.value);
                }
            });
        }
    });

    // Second pass, AFTER every step's own selections are folded into `flags` -- matches the real
    // engine's own collectInstructions, which only runs its alwaysInstall/installIfUsable union once
    // the FULL flag state from every step is known (2026-09-15, "conditionalFileInstalls has to
    // evaluate real conditions, not just flags", item 9a): for every UNSELECTED option, its own
    // <file>/<folder> entries where alwaysInstall=true, or installIfUsable=true AND that option's own
    // resolved type isn't NotUsable, get installed anyway -- confirmed against the real engine
    // (XmlScriptExecutor.cs::collectInstructions, L226-248). Same phase as a normal selected-option
    // file (the real source doesn't give these their own priority tier). Not confirmed in any real
    // archive this project has seen (0 of 1,400 sampled use either attribute -- see
    // diagnostics/fomod-parity/findings-log.md, item 9a), so this is correctness-against-the-real-
    // source, not something with a regression test against real data.
    for (const { group, selectedNames } of groupSelections) {
        for (const plugin of group.plugins) {
            if (selectedNames.has(plugin.name.trim())) continue; // already installed via the pass above
            for (const f of plugin.files) {
                if (f.alwaysInstall) {
                    rawEntries.push({ ...f, phase: PHASE_SELECTED_OPTION });
                } else if (f.installIfUsable) {
                    const type = resolvePluginType(plugin.typeDescriptor, flags, fileState, installedGameVersion, unresolved);
                    if (type !== 'NotUsable') rawEntries.push({ ...f, phase: PHASE_SELECTED_OPTION });
                }
            }
        }
    }

    for (const pattern of parsedFomod.conditionalPatterns) {
        if (patternMatches(flags, pattern, fileState, installedGameVersion, unresolved)) {
            for (const f of pattern.files) rawEntries.push({ ...f, phase: PHASE_CONDITIONAL_PATTERN });
        }
    }

    // A SEPARATE array from `warnings` (not merged into it) -- deliberately, so a caller that only
    // uses `warnings` to detect "this collection's recorded choices no longer structurally match this
    // archive" (lib/fomod-picker-data.js's own mismatch-check call) never gets a false positive just
    // because skyrimDataDir/pluginsListDir aren't configured on THIS machine -- an environment/config
    // gap is a completely different kind of problem from a stale recorded choice, and conflating the
    // two would wrongly send the user back into the picker to "fix" something re-picking can't fix.
    // Callers that DO want this surfaced (lib/mod-install-plan.js, for the real rebuild/extraction
    // path) fold it into their own returned `warnings` themselves -- see that file's own comment.
    const conditionWarnings = [];
    if (unresolved.fileState || unresolved.gameVersion) {
        const parts = [];
        if (unresolved.fileState) parts.push('installed files');
        if (unresolved.gameVersion) parts.push('the installed game version');
        conditionWarnings.push(`Couldn't check ${parts.join(' or ')} -- any conditionalFileInstalls pattern depending on that was treated as not matching, which may leave some conditional files out of this install.`);
    }

    const expanded = expandEntries(rawEntries, archiveEntries || [], warnings);

    // Two DIFFERENT source files can legitimately resolve to the SAME destination -- confirmed
    // this session ("Smoking Torches and Candles": a pattern that only checks candles+ESPFE, and
    // a more specific one that also checks torches, both matched when all three flags were
    // active, and both target the same final .esp path). Verified against Vortex's real engine
    // (see module header): higher phase wins; within the same phase, the entry whose source path
    // is lexicographically greater wins. This is commutative -- independent of which entry was
    // encountered first -- unlike the "last processed wins" rule this replaced, which happened to
    // pick the wrong file for this exact mod.
    const byDestination = new Map();
    for (const entry of expanded) {
        const key = entry.destination.toLowerCase();
        const existing = byDestination.get(key);
        if (!existing) {
            byDestination.set(key, entry);
            continue;
        }
        if (entry.phase !== existing.phase) {
            if (entry.phase > existing.phase) byDestination.set(key, entry);
        } else if (entry.source > existing.source) {
            byDestination.set(key, entry);
        }
    }
    const files = [...byDestination.values()].map(({ source, destination }) => ({ source, destination }));

    return { files, warnings, flags: Object.fromEntries(flags), conditionWarnings };
}

module.exports = { resolveChoices };
