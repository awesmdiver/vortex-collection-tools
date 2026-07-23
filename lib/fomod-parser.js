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
        else if (destAttr === '') destination = path.basename(f['@_source']);
        else destination = destAttr;
        return { kind: 'file', source: f['@_source'], destination };
    });
    const folders = asArray(filesBlock.folder).map((f) => ({
        kind: 'folder',
        source: f['@_source'],
        destination: f['@_destination'] ?? '',
    }));
    return [...files, ...folders];
}

function parseConditionFlags(el) {
    const block = el.conditionFlags;
    if (!block) return [];
    return asArray(block.flag).map((f) => ({ name: f['@_name'], value: f['#text'] ?? '' }));
}

function parsePlugin(pluginEl) {
    return {
        name: pluginEl['@_name'],
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

function parseInstallStep(stepEl) {
    const groupsBlock = stepEl.optionalFileGroups || {};
    return {
        name: stepEl['@_name'],
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
