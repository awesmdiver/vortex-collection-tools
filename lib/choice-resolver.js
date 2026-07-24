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

function patternMatches(flags, pattern) {
    if (pattern.flagDependencies.length === 0) return false;
    if (pattern.operator === 'Or') {
        return pattern.flagDependencies.some((d) => matchesFlagDependency(flags, d));
    }
    return pattern.flagDependencies.every((d) => matchesFlagDependency(flags, d)); // "And", the default
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

function expandEntries(entries, archiveEntries) {
    const out = [];
    for (const entry of entries) {
        if (entry.kind === 'folder') {
            out.push(...expandFolder(entry, archiveEntries));
        } else {
            out.push({ source: entry.source, destination: entry.destination, phase: entry.phase });
        }
    }
    return out;
}

// archiveEntries: the target archive's full listing (sevenzip.listArchive() output) -- required
// to expand <folder> entries. Pass [] if the FOMOD is known to use only <file> entries.
function resolveChoices(parsedFomod, choices, archiveEntries) {
    if (!choices || choices.type !== 'fomod') {
        throw new Error(`Expected a "fomod" choices block, got: ${JSON.stringify(choices)}`);
    }

    const rawEntries = [];
    const warnings = [];
    const flags = new Map(); // later steps' selections overwrite earlier ones for the same flag name

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
        if (recordedStep.name !== step.name) {
            warnings.push(`Recorded choices at position ${stepIdx} are for "${recordedStep.name}", not "${step.name}" as expected -- using them anyway (position-matched), but this FOMOD's structure may not be fully understood.`);
        }

        for (const group of step.groups) {
            const recordedGroup = recordedStep.groups.find((g) => g.name === group.name);
            if (!recordedGroup) {
                warnings.push(`No recorded choices for group "${step.name}" / "${group.name}" -- skipping.`);
                continue;
            }

            const selected = new Set(recordedGroup.choices.map((c) => `${c.idx}:${c.name}`));
            group.plugins.forEach((plugin, idx) => {
                if (selected.has(`${idx}:${plugin.name}`)) {
                    for (const f of plugin.files) rawEntries.push({ ...f, phase: PHASE_SELECTED_OPTION });
                    for (const flag of plugin.conditionFlags) flags.set(flag.name, flag.value);
                }
            });
        }
    });

    for (const pattern of parsedFomod.conditionalPatterns) {
        if (patternMatches(flags, pattern)) {
            for (const f of pattern.files) rawEntries.push({ ...f, phase: PHASE_CONDITIONAL_PATTERN });
        }
    }

    const expanded = expandEntries(rawEntries, archiveEntries || []);

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

    return { files, warnings, flags: Object.fromEntries(flags) };
}

module.exports = { resolveChoices };
