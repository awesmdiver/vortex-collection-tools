'use strict';
// Parses a FOMOD fomod/ModuleConfig.xml into a plain structure mirroring exactly what
// collection.json's "choices" block references by name/index -- see README for the full mapping,
// validated against real mods' ModuleConfig.xml + collection.json + actual Vortex-extracted
// output this session.
//
// Handles: <installSteps>/<group>/<plugin> with <file> AND <folder> entries, <conditionFlags> set
// by a plugin's own selection, <conditionalFileInstalls><patterns> gated on those flags
// (validated against a real mod, "Smoking Torches and Candles", whose correct plugin .esp file
// lives in one of six mutually-exclusive folders depending on choices made in two OTHER,
// unrelated install steps -- exactly what conditionalFileInstalls exists to express), and
// <requiredInstallFiles> (files/folders installed unconditionally regardless of any choice --
// validated against "Lawbringer Installer", whose entire framework -- ESP, scripts, MLQ data,
// textures -- ships this way; distinct from a top-level <files> block, see below).
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
// (Nexus-Mods/fomod-installer, XmlScript5.0.xsd + Parsers/Parser20.cs & Parser40.cs).

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
        if (destAttr == null) destination = f['@_source'];
        else {
            const normalizedDest = normalizeFomodPath(destAttr);
            // Empty on either side (destAttr="" directly, or normalized down to "" from "."/"./"/
            // ".\") means the same "root, basename only" intent.
            destination = normalizedDest ? normalizedDest : path.basename(f['@_source']);
        }
        return { kind: 'file', source: normalizeFomodPath(f['@_source']), destination };
    });
    const folders = asArray(filesBlock.folder).map((f) => ({
        kind: 'folder',
        source: normalizeFomodPath(f['@_source']),
        destination: normalizeFomodPath(f['@_destination']) || '',
    }));
    return [...files, ...folders];
}

function parseConditionFlags(el) {
    const block = el.conditionFlags;
    if (!block) return [];
    return asArray(block.flag).map((f) => ({ name: f['@_name'], value: f['#text'] ?? '' }));
}

// A `<visible>` (on installStep) or `<dependencies>` (on a typeDescriptor pattern / a
// conditionalFileInstalls pattern) block -- both are the real FOMOD schema's `compositeDependency`
// type: an `operator` attribute ("And"/"Or", default "And") plus a flat list of `<flagDependency>`
// children. Confirmed against the real engine (Nexus-Mods/fomod-installer,
// src/InstallScripting/XmlScript/Schemas/XmlScript5.0.xsd + Parsers/Parser40.cs::ParseInstallStep,
// which calls `LoadCondition(p_xelStep.Element("visible"))` directly -- `<visible>` IS the
// compositeDependency node itself, no extra wrapper). Same deliberate scope limit as this project's
// existing conditionalFileInstalls handling (choice-resolver.js): only `flagDependency` conditions
// are evaluated, matching every real mod validated so far -- a `fileDependency`/`moduleDependency`
// condition here is a known, undetected gap (the real schema allows them; not encountered yet).
function parseCondition(el) {
    if (!el) return null;
    return {
        operator: el['@_operator'] || 'And',
        flagDependencies: asArray(el.flagDependency).map((f) => ({ flag: f['@_flag'], value: f['@_value'] })),
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
        plugins: asArray(pluginsBlock.plugin).map(parsePlugin),
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
        groups: asArray(groupsBlock.group).map(parseGroup),
    };
}

function parseFlagDependency(depEl) {
    return { flag: depEl['@_flag'], value: depEl['@_value'] };
}

function parsePattern(patternEl) {
    const depsBlock = patternEl.dependencies || {};
    return {
        operator: depsBlock['@_operator'] || 'And',
        flagDependencies: asArray(depsBlock.flagDependency).map(parseFlagDependency),
        files: parseFilesBlock(patternEl.files),
    };
}

function parseModuleConfig(xmlContent) {
    const doc = parser.parse(xmlContent);
    const config = doc.config;
    if (!config) throw new Error('Not a valid FOMOD ModuleConfig.xml (no <config> root element)');

    const stepsBlock = config.installSteps || {};
    const installSteps = asArray(stepsBlock.installStep).map(parseInstallStep);

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

module.exports = { parseModuleConfig, parseModuleConfigFile, hasUnhandledFeatures };
