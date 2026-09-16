'use strict';
// Parses a FOMOD fomod/ModuleConfig.xml into a plain structure mirroring exactly what
// collection.json's "choices" block references by name/index -- see README for the full mapping,
// validated against real mods' ModuleConfig.xml + collection.json + actual Vortex-extracted
// output this session.
//
// Handles: <installSteps>/<group>/<plugin> with <file> AND <folder> entries, <conditionFlags> set
// by a plugin's own selection, <conditionalFileInstalls><patterns> gated on a full composite
// condition -- flags (validated against a real mod, "Smoking Torches and Candles", whose correct
// plugin .esp file lives in one of six mutually-exclusive folders depending on choices made in two
// OTHER, unrelated install steps), AND, since 2026-09-15, fileDependency/gameDependency/nested
// composites too (validated against "Armory Extended - Bonemold Weapon Pack" -- see parsePattern's
// own header comment for the real bug this closed) -- and <requiredInstallFiles> (files/folders
// installed unconditionally regardless of any choice -- validated against "Lawbringer Installer",
// whose entire framework -- ESP, scripts, MLQ data, textures -- ships this way; distinct from a
// top-level <files> block, see below).
//
// Known gap (not present in any mod validated so far, a real FOMOD spec feature): a top-level
// always-installed <files> block outside <installSteps> (NOT the same thing as
// <requiredInstallFiles>, which IS handled). Callers should check hasUnhandledFeatures() and treat
// such a mod as unsupported rather than silently producing an incomplete file list.
//
// Also captured (2026-08-18, for the interactive FOMOD picker -- resolveChoices() itself doesn't
// need any of this, it's replay-only): each installStep's <visible> condition, and each plugin's
// <description>, <image path=".."/>, and <typeDescriptor> (static or condition-pattern-based real
// PluginType) -- confirmed against the real engine's own XSD + parser
// (Nexus-Mods/fomod-installer, XmlScript5.0.xsd + Parsers/Parser20.cs & Parser40.cs). A
// <visible>/<dependencies> condition's own fileDependency/gameDependency/nested-composite children
// are fully parsed too (2026-09-15) -- see parseCondition's own header comment.

const fs = require('fs');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');

// FOMOD Creation Tool commonly writes ModuleConfig.xml as UTF-16LE (with BOM) -- confirmed this
// session (reading it as UTF-8 produced null-byte-interleaved garbage that fast-xml-parser failed
// on with a confusing "Maximum nested tags exceeded" error, not an encoding error). Sniff the BOM
// rather than assuming either encoding.
function readXmlFile(filePath) {
    const buf = fs.readFileSync(filePath);
    if (buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le', 2);
    if (buf[0] === 0xfe && buf[1] === 0xff) {
        // UTF-16BE: Node has no built-in decoder -- swap byte pairs, then decode as LE.
        const swapped = Buffer.alloc(buf.length - 2);
        for (let i = 2; i + 1 < buf.length; i += 2) {
            swapped[i - 2] = buf[i + 1];
            swapped[i - 1] = buf[i];
        }
        return swapped.toString('utf16le');
    }
    if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.toString('utf8', 3);
    return buf.toString('utf8');
}

const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    // fast-xml-parser's default (`htmlEntities: false`) only decodes the 5 predefined XML entities
    // (&amp; &lt; &gt; &quot; &apos;), NOT numeric character references -- confirmed against a real
    // mod ("Window Shadows Ultimate - Patch Hub") whose own plugin <description> text literally
    // contains `&#13;&#10;` for a line break; without this, that text comes through as the literal
    // 10-character string "&#13;&#10;" instead of a real CRLF. `htmlEntities: true` decodes numeric
    // refs correctly (confirmed: `hello&#13;&#10;world` -> `"hello\r\nworld"`) -- a real latent
    // correctness fix, not just cosmetic: any `name`/`value` attribute containing an entity would
    // previously have come through un-decoded too, a silent mismatch against what Vortex's own real
    // (entity-decoding) engine would have recorded.
    htmlEntities: true,
    // Force these repeatable elements to always parse as arrays, even when there's only one --
    // fast-xml-parser otherwise gives a bare object for a single occurrence, a classic gotcha
    // that would silently break any code assuming .map()/.forEach() always works.
    isArray: (name) => [
        'installStep', 'group', 'plugin', 'file', 'folder', 'flag', 'pattern', 'flagDependency',
        'fileDependency',
    ].includes(name),
});

function asArray(x) {
    if (x === undefined || x === null) return [];
    return Array.isArray(x) ? x : [x];
}

// A mod author's own ModuleConfig.xml can write a "no subfolder, install at mod root" destination
// as a literal ".\filename" instead of an empty string -- confirmed against a real archive ("Faster
// HDT-SMP FSMP 3.5.0"): `<file source="FSMPM\FSMPM - The FSMP MCM.esp" destination=".\FSMPM - The
// FSMP MCM.esp" />`. Taking that destination verbatim produced a path Vortex's own installer never
// actually creates (it normalizes the leading ".\" away, landing the file at the plain mod root) --
// a real, silent mismatch this project's own resolver introduced, not a genuine cross-collection
// difference. path.win32.normalize collapses a leading "./"/".\" (and any other redundant "."
// segments) the same way; harmless no-op on an already-clean relative path.
function normalizeFomodPath(p) {
    if (!p) return p;
    const normalized = path.win32.normalize(p);
    // A lone "." (path.win32.normalize's result for ".", "./", ".\", etc.) means the exact same
    // "no subfolder, root" intent as an explicitly empty destination -- confirmed against a real
    // archive ("Dwemer Armor SE - CBBE 3BA", 20 <folder> entries with destination="." verbatim in
    // its own ModuleConfig.xml). Node's own normalize doesn't collapse a bare "." further (it's
    // already the shortest valid relative-path token), so this call site has to do it explicitly.
    return normalized === '.' ? '' : normalized;
}

// A <files> (or pattern <files>) block can mix <file> and <folder> entries in any order. Tagged
// with `kind` so choice-resolver.js knows a folder entry needs expanding against the archive's
// actual listing (a file entry is already a complete, exact source/destination pair).
//
// `alwaysInstall`/`installIfUsable` (2026-09-15, "conditionalFileInstalls has to evaluate real
// conditions" -- item 9a): real `InstallableFile` properties on either a <file> or a <folder> entry,
// confirmed via the real engine (InstallableFile.cs declares both; XmlScriptExecutor.cs::
// collectInstructions unions in a file from an UNSELECTED option when alwaysInstall is true, or when
// installIfUsable is true AND that option's own resolved type isn't NotUsable -- see
// lib/choice-resolver.js's own second pass in resolveChoices). fast-xml-parser's own
// parseAttributeValue never auto-coerces an attribute to a real boolean (same reason
// htmlEntities:true was needed above -- confirmed nothing in this codebase relies on that coercion),
// so these compare against the literal string `"true"` rather than trusting a truthy check on the
// raw attribute value. Not confirmed in any real archive this project has seen (0 of 1,400 sampled --
// diagnostics/fomod-parity/findings-log.md, item 9a), so this is correctness-against-the-real-source,
// not a regression-tested real-world fix.
function parseFilesBlock(filesBlock) {
    if (!filesBlock) return [];
    const files = asArray(filesBlock.file).map((f) => {
        // Two genuinely different meanings, both real, confirmed against actual Vortex-installed
        // output: destination ABSENT entirely -> preserve the full source-relative path; destination
        // explicitly "" (present but empty) -> install at the destination ROOT using just the
        // source's own basename, discarding any subfolder structure. A real mod ("Children of the
        // North Wind") uses the empty-string form for its Base Object Swapper .ini files
        // (source="SWAP\COTNWNordicTotems_SWAP.ini" destination=""), and Vortex's own installed
        // copy confirms the file lands at the mod root as "COTNWNordicTotems_SWAP.ini", not under
        // "SWAP\" and not as a literally-empty path. The old code used `?? f['@_source']`, which
        // only catches null/undefined -- an explicitly empty string isn't null/undefined, so it
        // passed straight through as destination="", collapsing to no filename at all on join() and
        // crashing extraction with EPERM (copying INTO a directory, not a file).
        const destAttr = f['@_destination'];
        let destination;
        let mkdirOnly = false;
        if (destAttr == null) destination = f['@_source'];
        else {
            const normalizedDest = normalizeFomodPath(destAttr);
            if (normalizedDest && /[\\/]$/.test(normalizedDest)) {
                // A <file> (not <folder>) destination ending in a separator -- e.g.
                // destination="textures\terrain\blackreach\" -- is NOT "put the file inside this
                // folder using its own name". Verified against Vortex's real engine, both halves:
                // the C# fomod-installer that builds the instruction (XmlScriptInstaller.cs::
                // InstallFileFromMod -- `if (toPath.EndsWith(separator)) modInstallInstructions.Add
                // (Instruction.CreateMKDir(toPath))`, an EARLY RETURN that never reaches the
                // CreateCopy branch below it) and Vortex's own TS side that applies instructions
                // (InstallManager.ts::processMKDir -- a bare `fs.ensureDirAsync(...)`, no
                // accompanying copy anywhere in the codebase). The source file is simply never
                // installed; only an empty destination folder is created. Confirmed real: three
                // "Paper Maps for FWMF" FOMODs (Blackreach/Soul Cairn/Flat World Map Framework
                // Lite) use exactly this pattern for their optional background .dds files --
                // real Vortex installs of these have always silently produced an empty
                // "textures\terrain\blackreach\" with no texture inside, not a missing/broken mod.
                // This project's own resolver used to take a destination like this VERBATIM as a
                // literal file path, which made rebuild-mod.js's real fs.copyFileSync try to copy
                // a file ONTO a directory -- a genuine EPERM, then mislabeled as a transient lock
                // by extract-mod.js's catch (see that file's own fix for the SAME real incident).
                mkdirOnly = true;
                destination = normalizedDest;
            } else {
                // Empty on either side (destAttr="" directly, or normalized down to "" from "."/
                // "./"/".\") means the "root, basename only" intent covered above.
                destination = normalizedDest ? normalizedDest : path.basename(f['@_source']);
            }
        }
        return {
            kind: 'file', source: normalizeFomodPath(f['@_source']), destination, mkdirOnly: mkdirOnly || undefined,
            alwaysInstall: f['@_alwaysInstall'] === 'true' || undefined,
            installIfUsable: f['@_installIfUsable'] === 'true' || undefined,
        };
    });
    // Deliberately NO mkdir-only/trailing-separator check here, unlike <file> above -- confirmed
    // against the real engine (XmlScriptInstaller.cs::InstallFolderFromMod, L160-185): every real
    // archive file matched under a <folder>'s own source prefix gets its destination built via
    // Path.Combine(strTo, <relative path>), which ALWAYS ends in a real filename, never a bare
    // separator -- the mkdir-only branch can structurally never fire through folder expansion, only
    // through a literal <file> destination. A <folder> matching zero real archive files correctly
    // produces zero instructions (not even an empty mkdir) on both the real engine and
    // lib/choice-resolver.js's own expandFolder(). This was an open question in an earlier task's own
    // build spec; confirmed resolved (diagnostics/fomod-parity/findings-log.md, item 9b) -- don't
    // "fix" this into a regression by adding a folder-side mkdir-only check later.
    const folders = asArray(filesBlock.folder).map((f) => ({
        kind: 'folder',
        source: normalizeFomodPath(f['@_source']),
        destination: normalizeFomodPath(f['@_destination']) || '',
        alwaysInstall: f['@_alwaysInstall'] === 'true' || undefined,
        installIfUsable: f['@_installIfUsable'] === 'true' || undefined,
    }));
    return [...files, ...folders];
}

function parseConditionFlags(el) {
    const block = el.conditionFlags;
    if (!block) return [];
    // fast-xml-parser's default parseTagValue coerces purely-numeric TEXT content into a real JS
    // number (confirmed: `<flag name="Campfire">1</flag>` parses as `{'@_name':'Campfire','#text':1}`
    // -- a NUMBER, not the string "1"). A <flagDependency value="1"/> ATTRIBUTE, by contrast, is
    // never coerced (parseAttributeValue defaults to false), so it stays the string "1". Confirmed
    // against the real engine's own source (Nexus-Mods/fomod-installer, ConditionStateManager.cs's
    // `FlagValue.Value` is a plain C# `string`, and both Parser20.cs's `xelFlag.Value` (the flag's
    // set-side text) and FlagCondition.cs's `Value.Equals(strValue)` (the check-side comparison) are
    // string-typed throughout -- there is no numeric type anywhere in this comparison in the real
    // engine) -- `1 === "1"` is false in JS, so every FOMOD using a numeric-looking flag value (e.g.
    // "Campfire"/"Hearthfire" toggles) silently matched NO conditionalFileInstalls pattern at all.
    // Real report (2026-09-14, "Go to bed - Patches"): resolved 0 files for exactly this reason.
    // String(...), not textOf() -- the real engine's own `xelFlag.Value` does NOT trim, so trimming
    // here would diverge from it for a flag value with real leading/trailing whitespace (unconfirmed
    // in practice, but no reason to add a divergence that isn't in the source of truth).
    return asArray(block.flag).map((f) => ({ name: f['@_name'], value: f['#text'] != null ? String(f['#text']) : '' }));
}

// A `<visible>` (on installStep) or `<dependencies>` (on a typeDescriptor pattern / a
// conditionalFileInstalls pattern) block -- both are the real FOMOD schema's `compositeDependency`
// type: an `operator` attribute ("And"/"Or", default "And") plus any mix of `<flagDependency>`,
// `<fileDependency>`, `<gameDependency>` and its per-extender siblings (`<fommDependency>`/
// `<foseDependency>`/`<skseDependency>`/`<nvseDependency>`/`<f4seDependency>`), and nested
// `<dependencies>` composites. Confirmed against the real engine (Nexus-Mods/fomod-installer,
// src/InstallScripting/XmlScript/Schemas/XmlScript5.0.xsd + Parsers/Parser40.cs::ParseInstallStep,
// which calls `LoadCondition(p_xelStep.Element("visible"))` directly -- `<visible>` IS the
// compositeDependency node itself, no extra wrapper). The XSD's own `dependencyTypesGroup` lists
// `dependencies` as a `maxOccurs="unbounded"` sibling of fileDependency/flagDependency/etc -- a
// composite can genuinely contain another composite, so `nested` is recursive.
//
// REWRITTEN 2026-09-15 ("pre-select options the way Vortex does, based on what's actually
// installed") -- this used to only ever look at `flagDependency`, which is why a plugin gated on a
// real `fileDependency` (by far the most common real-world pattern -- "select this if the player
// already has X installed") could never resolve anything but its `defaultType`, and every FOMOD
// with dependency-gated Recommended options came back fully checked. `fileDependency` resolution
// against the player's REAL install (Active/Inactive/Missing) happens client-side in
// web/public/fomod-picker.js for the picker's own type resolution, fed by
// lib/fomod-picker-data.js's resolveInstalledFileState() -- this parser only captures the raw
// `{file, state}` pairs.
//
// EXTENDED 2026-09-15 ("conditionalFileInstalls has to evaluate real conditions, not just flags") --
// this same `{file, state}`/`{version}` shape is now ALSO evaluated server-side, in
// lib/choice-resolver.js's own composite evaluator, for a `conditionalFileInstalls` pattern's own
// condition (parsePattern() shares this exact function -- see its own header comment for the real
// bug this closed). `gameDependency` is evaluated there too, against the real installed Skyrim
// version (lib/game-version.js's getInstalledGameVersion(), a real Windows PE file-version read) with
// a real 4-segment numeric comparator -- not always-satisfied, not a lexicographic string compare.
//
// `fommDependency`/`foseDependency`/`skseDependency`/`nvseDependency`/`f4seDependency` are captured
// structurally for completeness (a real, schema-legal mod feature -- confirmed via XmlScript5.0.xsd)
// but DELIBERATELY left always-evaluated-as-satisfied everywhere in this project (picker AND
// resolver) -- NOT a gap to close. Confirmed via real Vortex source
// (installer_fomod_shared/delegates/SharedDelegates.ts): Vortex's own `getExtenderVersion(extender)`
// delegate ignores its own `extender` argument entirely and always returns the GAME's version
// instead, so real Vortex's own SKSE/FOSE/NVSE/F4SE/FOMM dependency checks are already comparing the
// wrong numbers against each other in production today. Matching that "for parity" would mean
// deliberately reproducing a live Vortex bug rather than doing the sane thing (see
// diagnostics/fomod-parity/findings-log.md, item 3e, and its own "what I'd fix first" list, which
// explicitly recommends NOT closing this one). Not encountered in any real mod checked across this
// project's own FOMOD work, so this is a narrow, disclosed, deliberate limitation.
function parseCondition(el) {
    if (!el) return null;
    return {
        operator: el['@_operator'] || 'And',
        flagDependencies: asArray(el.flagDependency).map((f) => ({ flag: f['@_flag'], value: f['@_value'] })),
        fileDependencies: asArray(el.fileDependency).map((f) => ({ file: f['@_file'], state: f['@_state'] })),
        gameDependencies: asArray(el.gameDependency).map((f) => ({ version: f['@_version'] })),
        extenderDependencies: [
            ...asArray(el.fommDependency), ...asArray(el.foseDependency), ...asArray(el.skseDependency),
            ...asArray(el.nvseDependency), ...asArray(el.f4seDependency),
        ].map((f) => ({ version: f['@_version'] })),
        nested: asArray(el.dependencies).map(parseCondition),
    };
}

// A plugin's real `<typeDescriptor>` is EITHER a static `<type name="Optional"/>` OR a dynamic
// `<dependencyType><defaultType name="Optional"/><patterns><pattern><dependencies>...</dependencies>
// <type name="Recommended"/></pattern></patterns></dependencyType>` -- confirmed against the real
// engine (XmlScriptExecutor.cs's ConditionalOptionTypeResolver.ResolveOptionType: the FIRST pattern
// whose condition is satisfied wins; falls back to the default type if none match). Always returned
// in the same shape (`{default, patterns}`, `patterns` empty for the static form) so a caller has a
// single evaluation code path regardless of which form the mod author used.
function parseTypeDescriptor(tdEl) {
    if (!tdEl) return { default: 'Optional', patterns: [] };
    if (tdEl.type) {
        return { default: tdEl.type['@_name'] || 'Optional', patterns: [] };
    }
    if (tdEl.dependencyType) {
        const dt = tdEl.dependencyType;
        const patternsBlock = dt.patterns;
        const patterns = patternsBlock
            ? asArray(patternsBlock.pattern).map((p) => ({
                type: (p.type && p.type['@_name']) || 'Optional',
                condition: parseCondition(p.dependencies),
            }))
            : [];
        return { default: (dt.defaultType && dt.defaultType['@_name']) || 'Optional', patterns };
    }
    return { default: 'Optional', patterns: [] };
}

// fast-xml-parser returns a plain-text-only element (no attributes/children) as a bare string
// (or a number, if parseTagValue's default numeric coercion kicks in on purely-numeric text) --
// never an object. Coerced to String() defensively so a description that happens to be just
// digits doesn't come out as a JS number.
function textOf(x) {
    return x == null ? '' : String(x).trim();
}

// Item 8, diagnostics/fomod-parity/findings-log.md, 2026-09-15 -- real Vortex fully implements the
// `order=` attribute at all three levels (`<installSteps>`, `<optionalFileGroups>`, `<plugins>`):
// `XmlScript.cs`/`InstallStep.cs`/`OptionGroup.cs`, "Explicit" keeps document order, "Ascending"/
// "Descending" swap the live collection for one sorted by `.Name`. We used to never parse or apply
// it at any level, always document order. Confirmed real but rare: 45 real archives sampled by the
// audit, `order="Explicit"` 100% of the time -- the dominant authoring tool (FOMOD Creation Tool)
// essentially always emits Explicit -- so no visible change is expected on real archives; this is
// correctness-against-the-real-source, not something with a real-archive regression case.
//
// Ordinal, NOT locale-aware -- `Parser.cs`'s own sort uses plain .NET `string.CompareTo`, which for
// ASCII (and, close enough for FOMOD option names in practice, most real text) is equivalent to a
// raw JS `<`/`>` comparison, never `.localeCompare()` (which reorders non-ASCII names differently,
// e.g. treating accented letters as sorting near their unaccented counterpart -- ordinal comparison
// sorts by raw UTF-16 code unit instead).
function ordinalCompare(a, b) {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
}

// Case-SENSITIVE and silently permissive, mirroring `Parser.cs::ParseSortOrder()` exactly: anything
// that isn't the exact string "Ascending" or "Descending" -- a missing attribute, a typo, wrong
// case ("ascending"), any other value -- falls back to "Explicit" (document order) with no error,
// never a thrown exception or a normalized/lowercased comparison.
function applyOrder(items, orderAttr) {
    if (orderAttr === 'Ascending') return [...items].sort((a, b) => ordinalCompare(a.name || '', b.name || ''));
    if (orderAttr === 'Descending') return [...items].sort((a, b) => ordinalCompare(b.name || '', a.name || ''));
    return items;
}

function parsePlugin(pluginEl) {
    return {
        name: pluginEl['@_name'],
        description: textOf(pluginEl.description),
        image: pluginEl.image ? (pluginEl.image['@_path'] || null) : null,
        typeDescriptor: parseTypeDescriptor(pluginEl.typeDescriptor),
        files: parseFilesBlock(pluginEl.files),
        conditionFlags: parseConditionFlags(pluginEl),
    };
}

function parseGroup(groupEl) {
    const pluginsBlock = groupEl.plugins || {};
    return {
        name: groupEl['@_name'],
        type: groupEl['@_type'],
        plugins: applyOrder(asArray(pluginsBlock.plugin).map(parsePlugin), pluginsBlock['@_order']),
    };
}

// A real archive ("Dragon Priests Retexture SE - Half Res") has installSteps gated behind a
// <visible> condition (e.g. two steps both named "Mesh Patches - Masks", shown/hidden based on
// mutually exclusive earlier choices) -- investigated as a possible factor in matching recorded
// choices.options to install steps, but confirmed NOT relevant to EXTRACTION: Vortex records one
// choices.options entry per RAW step unconditionally (visible or not -- an unshown step's entry
// just has empty/default selections), so resolveChoices() (choice-resolver.js) never needs
// <visible> for REPLAYING a recorded choice, and still doesn't use it.
//
// It IS needed for the interactive FOMOD picker (a FRESH pick, no recorded choices to replay) --
// added 2026-08-18 so the picker's own Back/Next navigation can skip a conditionally-hidden step
// the same way Vortex's real wizard does (confirmed against the real engine,
// installer_fomod_shared/views/InstallerDialog.tsx: `nextVisible = steps.find(i>idx &&
// step.visible)`). See web/public/update-collection-v2-app.js's own ucv2Fomod* evaluation code --
// this project has no live native engine to ask, so it re-derives visibility client-side from the
// flags set by whatever the user has already picked in earlier steps.
function parseInstallStep(stepEl) {
    const groupsBlock = stepEl.optionalFileGroups || {};
    return {
        name: stepEl['@_name'],
        visible: parseCondition(stepEl.visible),
        groups: applyOrder(asArray(groupsBlock.group).map(parseGroup), groupsBlock['@_order']),
    };
}

// A `<conditionalFileInstalls>` pattern's own `<dependencies>` block is the EXACT SAME real
// `compositeDependency` grammar as a `<visible>`/`<typeDescriptor>` condition -- confirmed against
// the real engine: `ConditionallyInstalledFileSet.cs`'s `Condition` is a plain `ICondition`, the SAME
// `CompositeCondition`/`PluginCondition`/`FlagCondition`/`GameVersionCondition` hierarchy used
// everywhere else, and `XmlScriptInstaller.cs::InstallFiles` calls the identical
// `Condition.GetIsFulfilled(csmState, coreDelegates)` method signature a `<visible>` condition uses.
// Nothing in the schema or engine restricts a pattern to flagDependency only.
//
// REWRITTEN 2026-09-15 ("conditionalFileInstalls has to evaluate real conditions, not just flags") to
// share `parseCondition()` instead of keeping a second, weaker, flags-only parser alive -- this used
// to only ever extract `flagDependency`, silently dropping `fileDependency`/`gameDependency`/nested
// composites entirely (not even carried through unevaluated). Confirmed real, concrete gap this
// fixes (`diagnostics/fomod-parity/findings-log.md`, item 9c): **Armory Extended - Bonemold Weapon
// Pack**'s own 6 `conditionalFileInstalls` patterns each gate on a flagDependency (the player's
// picked style) AND a fileDependency on "Weapons Armor Clothing & Clutter Fixes.esp" (Active in 3
// patterns, Missing in the other 3 -- the "with WACCF"/"without WACCF" variants of the same patch).
// The old parser silently dropped the fileDependency half, so BOTH variants of whichever style the
// player picked matched and installed simultaneously, every rebuild, regardless of his real WACCF
// state -- confirmed in 3 of ~85 real `conditionalFileInstalls` archives sampled, not a one-off. The
// real fileDependency/gameDependency EVALUATION (Active/Inactive/Missing, installed game version)
// happens in `lib/choice-resolver.js`'s own composite evaluator -- this parser only captures the
// structure, same "parse here, evaluate at the resolver" split `parseCondition` already establishes
// for the picker side.
function parsePattern(patternEl) {
    return {
        condition: parseCondition(patternEl.dependencies) || {
            operator: 'And', flagDependencies: [], fileDependencies: [], gameDependencies: [], extenderDependencies: [], nested: [],
        },
        files: parseFilesBlock(patternEl.files),
    };
}

function parseModuleConfig(xmlContent) {
    const doc = parser.parse(xmlContent);
    const config = doc.config;
    if (!config) throw new Error('Not a valid FOMOD ModuleConfig.xml (no <config> root element)');

    const stepsBlock = config.installSteps || {};
    const installSteps = applyOrder(asArray(stepsBlock.installStep).map(parseInstallStep), stepsBlock['@_order']);

    const cfiBlock = config.conditionalFileInstalls;
    const patternsBlock = cfiBlock && cfiBlock.patterns;
    const conditionalPatterns = patternsBlock ? asArray(patternsBlock.pattern).map(parsePattern) : [];

    // <requiredInstallFiles> directly contains <file>/<folder> entries (no inner <files> wrapper,
    // unlike a plugin's own <files> block) -- same shape parseFilesBlock already expects.
    const requiredInstallFiles = parseFilesBlock(config.requiredInstallFiles);

    return {
        moduleName: config.moduleName || null,
        installSteps,
        conditionalPatterns,
        requiredInstallFiles,
        // Surfaced raw so callers can detect + refuse to handle it, rather than silently
        // producing an incomplete extraction. See module header -- this is the one remaining gap.
        hasTopLevelFiles: !!config.files,
    };
}

function hasUnhandledFeatures(parsedConfig) {
    return parsedConfig.hasTopLevelFiles;
}

function parseModuleConfigFile(filePath) {
    return parseModuleConfig(readXmlFile(filePath));
}

module.exports = {
    parseModuleConfig, parseModuleConfigFile, hasUnhandledFeatures,
    // Exported 2026-09-15 ("validate the installer against the real schema") so
    // lib/fomod-schema-validator.js's real callers (fomod-picker-data.js, mod-install-plan.js) can
    // get the SAME correctly-decoded raw XML text schema validation needs, without a second,
    // independent file read/decode -- this file's own BOM-sniffing stays the one place that logic
    // lives.
    readXmlFile,
};
