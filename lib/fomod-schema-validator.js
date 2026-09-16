'use strict';
// Real XSD schema validation for a FOMOD's ModuleConfig.xml -- item 2a in
// diagnostics/fomod-parity/findings-log.md, the audit's second priority and its single biggest
// divergence from real Vortex. Real Vortex validates every FOMOD load against the real
// Nexus-Mods/fomod-installer schema: `installer_fomod_native/installer.ts::install()` calls
// `invokeInstall(true)` (validate=true) first, and separately, EVERY real `Parser10`-`Parser50`'s own
// base constructor (`Parser.cs` L39-45) unconditionally re-validates regardless of that flag --
// `p_xelScript.GetSchemaInfo()` is always null after a plain `XElement.Parse`, so the guard fires
// every single time -- via `XmlScriptType.cs::ValidateXmlScript`, which throws
// `XmlSchemaValidationException`/`XmlException` on the first violation. We had zero validation of any
// kind; a missing required attribute (item 2b) just read as `undefined` and silently propagated.
//
// The real XSDs (`XmlScript1.0.xsd` through `XmlScript5.0.xsd`) are vendored verbatim in
// config/fomod-schemas/, fetched fresh from the live Nexus-Mods/fomod-installer repo via `gh api`
// (2026-09-15) -- not hand-written approximations.
//
// ONE confirmed real upstream typo, fixed in our own vendored copies only (never touched upstream):
// all 5 real schema versions declare `<xs:attribute name="version" type=" xs:string" .../>` on the
// `versionDependency` complexType (backs gameDependency/fommDependency/etc.) with a stray LEADING
// SPACE inside the `type="..."` QName reference. .NET's `XmlSchema` class silently tolerates this
// (its own QName parsing collapses whitespace); libxml2 (which our validator, `xmllint-wasm`, wraps)
// does not, and refuses to even COMPILE the schema ("has no corresponding namespace declaration in
// scope"). Confirmed present in all 5 versions as fetched, not a transcription error on our side.
// Trimming the leading space changes nothing about the schema's actual grammar -- it only removes a
// spurious whitespace character a stricter processor won't skip past on its own.
//
// Schema-VERSION detection mirrors `XmlScriptType.cs::GetXmlScriptVersion(XElement)` exactly -- the
// overload every real Parser constructor actually calls (the one guaranteed to run unconditionally,
// per the "always fires" note above), not the separate case-sensitive regex-only overload the OPTIONAL
// pre-check calls. It reads the config root's own `xsi:noNamespaceSchemaLocation` attribute,
// lowercases it, finds the LAST occurrence of "xmlscript" or "modconfig", and takes the text between
// that and the trailing ".xsd" as the version -- defaulting to "1.0" (the real engine's own default)
// when the attribute is missing, neither keyword matches, or the extracted text is empty. Runs
// against the raw XML text via regex rather than a parsed DOM, since a malformed archive might not
// even be well-formed XML yet at this point.
//
// Why "Install Anyway" genuinely proceeds here, when real Vortex's own "Ignore" button can't
// (settled 2026-09-16, diagnostics/fomod-parity/findings-log.md's own "Couldn't determine" section,
// resolving item 2a's open question): tracing the chain above further -- `LoadScript(data, validate)`
// only gates its OWN separate string-based `Validate()` pass on the `validate` flag; the parser's own
// base constructor (the "always fires" `ValidateXmlScript` call, L6-9 above) re-validates
// UNCONDITIONALLY regardless of that flag, because `GetSchemaInfo()` is always null coming out of a
// plain `XElement.Parse` -- there's no code path where the constructor's own guard is ever false for
// a document that failed the first check. So a genuinely schema-invalid archive re-throws the exact
// same class of exception on Vortex's own "Ignore" retry, at every schema version 1.0-5.0 -- clicking
// Ignore just swaps which exception fires, never actually installs. Ours is different on purpose, not
// by accident: `fomod-parser.js`'s own composite-condition parser (`parseCondition()`) dispatches on
// raw XML tag names (`el.flagDependency`, `el.fileDependency`, ...), never on schema-derived type
// annotations the way every real `Parser10`-`Parser50::LoadCondition()` does -- so our parser has
// nothing structurally equivalent to crash on, and "Install Anyway" (the `ignoreFomodValidation`
// override threaded through `detectFomodChoiceNeed`/`buildFomodChoicesFromPicks` below and
// `lib/mod-install-plan.js::resolveFomodOrSimpleFiles`) can genuinely complete an install real
// Vortex's own equivalent button cannot. Do not "fix" this to match Vortex's own non-functional
// Ignore -- ours is the better, deliberate behavior here.
//
// Encoding normalization (item 2c) mirrors `XmlScriptType.cs::StringStream()`: strips any
// XML-declared `encoding="..."` before validating (Vortex's own comment: "removing encoding
// specification from header line because it's usually wrong anyway"). This only affects what's
// handed to the validator -- the caller's own already-decoded text (from `fomod-parser.js`'s own
// BOM-sniffing `readXmlFile()`) already resolved the real encoding correctly before this point, so a
// declared `encoding=` attribute surviving into validation is at best redundant, at worst actively
// wrong.
const fs = require('fs');
const path = require('path');
const { validateXML } = require('xmllint-wasm');

const SCHEMA_DIR = path.join(__dirname, '..', 'config', 'fomod-schemas');
const SUPPORTED_VERSIONS = ['1.0', '2.0', '3.0', '4.0', '5.0'];
const schemaCache = new Map();

function loadSchema(version) {
    if (!schemaCache.has(version)) {
        schemaCache.set(version, fs.readFileSync(path.join(SCHEMA_DIR, `XmlScript${version}.xsd`), 'utf8'));
    }
    return schemaCache.get(version);
}

function detectSchemaVersion(xmlText) {
    const match = /noNamespaceSchemaLocation\s*=\s*"([^"]*)"/i.exec(xmlText);
    if (!match) return '1.0';
    const lower = match[1].toLowerCase();
    let startPos = lower.lastIndexOf('xmlscript');
    if (startPos < 0) startPos = lower.lastIndexOf('modconfig');
    if (startPos < 0) return '1.0';
    const versionStart = startPos + 'xmlscript'.length; // 'modconfig' is also 9 characters
    const version = lower.slice(versionStart, lower.length - '.xsd'.length);
    return version || '1.0';
}

function stripDeclaredEncoding(xmlText) {
    return xmlText.replace(/^([^>]*)encoding="[^"]+"/, '$1');
}

// Validates a FOMOD's real ModuleConfig.xml text against the real schema for whichever version it
// declares (or "1.0" if undeclared, matching the real engine's own default). Returns:
//   { valid: true, version }
//   { valid: false, version, errors: string[] } -- schema validation failed; errors are real libxml2
//     messages, each already carrying its own line number where available.
//   { valid: false, version: null, unsupportedVersion: <raw string> } -- the archive declares a
//     schema version we don't have vendored. The real engine would refuse this identically --
//     `XmlScriptType.cs::GetParser()`'s own switch throws "Unrecognized XML Script version" for
//     anything outside 1.0-5.0.
async function validateFomodXml(xmlText) {
    const version = detectSchemaVersion(xmlText);
    if (!SUPPORTED_VERSIONS.includes(version)) {
        return { valid: false, version: null, unsupportedVersion: version };
    }
    const schema = loadSchema(version);
    const result = await validateXML({
        xml: [{ fileName: 'ModuleConfig.xml', contents: stripDeclaredEncoding(xmlText) }],
        schema: [{ fileName: `XmlScript${version}.xsd`, contents: schema }],
    });
    if (result.valid) return { valid: true, version };
    // Filter to entries that carry a real line/column (`loc`) -- xmllint's own output interleaves
    // genuine descriptive messages with raw source-line echoes and caret-pointer lines (both `loc:
    // null`), which read as noise rather than a real violation description.
    const errors = result.errors.filter((e) => e.loc).map((e) => e.message);
    return { valid: false, version, errors: errors.length ? errors : result.errors.map((e) => e.message) };
}

module.exports = { validateFomodXml, detectSchemaVersion, SUPPORTED_VERSIONS };
