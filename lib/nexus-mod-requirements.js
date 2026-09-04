'use strict';
// Real Nexus GraphQL research (2026-08-31, diagnostics/2026-08-30-added-mod-prerequisite-check-
// scoping.md) -- that scoping doc guessed at the API shape ("a `requirements` array? IDs only, or
// resolved names/file info too?"); this is what a real, live schema introspection + live query
// against the actual Nexus incident (Pandora XPMSE Behavior Patch, modId 133232) confirmed:
//
// 1. There IS a real, structured cross-MOD requirements field: `Mod.modRequirements.
//    nexusRequirements(offset,count) -> { nodes: [ModRequirement{id,modId,modName,gameId,url,notes,
//    externalRequirement}] }`, fetched via `Query.mod(modId, gameId)`. Requirements are declared at
//    the MOD level, not per-file -- there's no fileId on ModRequirement at all, matching Nexus's own
//    real UI (a mod's "Requirements" tab lists other MOD pages, never a pinned specific file/version
//    of them). `externalRequirement: true` means it's an off-site requirement with no real Nexus
//    modId to resolve/install -- those are surfaced as unresolvable, never offered an install action.
//
// 2. That field alone does NOT cover the real incident that motivated this whole feature. The
//    ACTUAL Pandora relationship ("Pandora XPMSE Behavior Patch" needs "Pandora Behaviour Engine
//    v4.4.0-beta") is a SAME-MOD-PAGE relationship -- both are FILES under the exact same modId
//    (133232), confirmed live via `Query.modFiles(modId, gameId) -> [ModFile{fileId,name,version,
//    primary,category,categoryId}]`: "Pandora XPMSE Behavior Patch" is `primary:0, category:
//    OPTIONAL`, "Pandora Behaviour Engine v4.4.0-beta" is `primary:1, category:MAIN`. A mod
//    literally cannot "require" itself in `modRequirements` (that's cross-mod by definition), so
//    this relationship is invisible to check #1 entirely -- confirmed by directly querying
//    modRequirements for modId 133232, which returned two REAL but unrelated cross-mod requirements
//    ("A-Pose Bug Fix", "Auto Skeleton Patch"), neither of which is Pandora Behaviour Engine itself.
//    `ModFile.requirementsAlert: Int` exists as a per-file flag/count, but there's no queryable
//    per-file requirements LIST field anywhere in the schema (confirmed via full introspection of
//    every `ModFile` field) -- it's a heuristic alert, not structured data. The only structured
//    signal for "this optional file needs its own mod's main file" is the primary-file check below.
//
// So this file exposes BOTH real signals in one combined query (one HTTP request per Added mod, not
// two) -- see checkModPrerequisites' own header comment for how the runner combines them.
//
// NEXUS_SE_GAME_ID: Nexus's own numeric game id for Skyrim Special Edition (distinct from the domain
// slug "skyrimspecialedition" this project's own GAME_ID constant already uses elsewhere) -- required
// by this GraphQL API's own `gameId: ID!` arguments. Confirmed live: every real GraphQL response this
// research session got back for a Skyrim SE mod carried `"gameId":"1704"` (also visible in the REST
// v1 API's own file-details response, `"id":[fileId,1704]`). Hardcoded, matching this whole project's
// own existing single-game hardcoding (GAME_ID = 'skyrimse' throughout) -- not worth making
// configurable for a project that only ever targets one game today.
const NEXUS_SE_GAME_ID = '1704';

const { resolveApiKey, graphqlRequest } = require('./nexus-collection-download');

// One combined query per mod -- both real signals (#1 cross-mod, #2 same-page primary file) in a
// single HTTP round trip, keeping the real call count bounded to exactly this apply's own Added-mod
// count (the scoping doc's own real concern: a collection can run to ~1900 mods, so this must never
// scale with collection size). count:50 on nexusRequirements is generous headroom -- a real mod
// declaring more than 50 Nexus requirements would be a genuine outlier, and this is a soft cap, not a
// silent truncation risk (totalCount is still read, so a truncation would be detectable if it ever
// mattered -- not surfaced further since no real mod this project has touched has come close).
async function fetchModPrerequisiteData(apiKey, modId) {
    const query = `
        query ModPrereqCheck($modId: ID!, $gameId: ID!) {
            mod(modId: $modId, gameId: $gameId) {
                modRequirements {
                    nexusRequirements(offset: 0, count: 50) {
                        totalCount
                        nodes { modId modName externalRequirement url }
                    }
                }
            }
            modFiles(modId: $modId, gameId: $gameId) {
                fileId
                name
                version
                primary
                sizeInBytes
            }
        }
    `;
    return graphqlRequest(apiKey, query, { modId: String(modId), gameId: NEXUS_SE_GAME_ID });
}

// Resolves ONE Added mod's own real prerequisites (both signals) into a flat, uniform shape the
// runner's own findMissingAddedPrerequisites can check against live/this-apply state without caring
// which of the two real mechanisms produced each entry.
//   - crossMod: [{modId, modName, resolvable}] -- resolvable=false means externalRequirement:true
//     (no real Nexus modId to check/install against, matches the doc's own decision #3: "if it
//     doesn't resolve to a real, installable Nexus file... just skip", never offered an install
//     action).
//   - ownPrimaryFile: null if `fileId` IS this mod's own primary file (nothing to check -- the
//     overwhelming majority of real mods, since most mods have exactly one relevant file), otherwise
//     {fileId, name, version, sizeInBytes} for the mod's own real primary/main file.
// Returns null (not a thrown error) on any Nexus API failure -- a missing-prerequisite check is a
// best-effort convenience gate, not a hard requirement Apply should ever refuse to proceed without;
// the caller treats null as "couldn't check this one, don't block on it."
async function resolveModPrerequisites(apiKey, modId, fileId) {
    let data;
    try {
        data = await fetchModPrerequisiteData(apiKey, modId);
    } catch {
        return null;
    }
    const mod = data && data.mod;
    const files = (data && data.modFiles) || [];
    const nodes = (mod && mod.modRequirements && mod.modRequirements.nexusRequirements
        && mod.modRequirements.nexusRequirements.nodes) || [];
    const crossMod = nodes.map((n) => ({
        modId: n.modId, modName: n.modName, resolvable: n.externalRequirement !== true,
    }));
    const ownFile = files.find((f) => String(f.fileId) === String(fileId));
    const primaryFile = files.find((f) => !!f.primary);
    const ownPrimaryFile = (ownFile && !ownFile.primary && primaryFile && String(primaryFile.fileId) !== String(fileId))
        ? { fileId: primaryFile.fileId, name: primaryFile.name, version: primaryFile.version, sizeInBytes: primaryFile.sizeInBytes }
        : null;
    return { crossMod, ownPrimaryFile };
}

// For a cross-mod requirement that turned out to actually be missing (see findMissingAddedPrerequisites),
// resolves the OTHER mod's own primary file so "also install the missing prerequisite" has a real,
// concrete fileId to install -- deliberately a SEPARATE, follow-up call, not fetched for every
// requirement of every Added mod (which would multiply the real call count unpredictably; typically
// 0-1 mods have any genuinely missing requirement at all, so this stays proportional to real
// problems found, not to enumeration). Returns null if the mod has no real primary file (extremely
// rare -- would mean the mod page has zero MAIN-category files, e.g. a fully archived/abandoned page).
async function resolvePrimaryFileFor(apiKey, modId) {
    let data;
    try {
        data = await fetchModPrerequisiteData(apiKey, modId);
    } catch {
        return null;
    }
    const files = (data && data.modFiles) || [];
    const primaryFile = files.find((f) => !!f.primary);
    if (!primaryFile) return null;
    return { fileId: primaryFile.fileId, name: primaryFile.name, version: primaryFile.version, sizeInBytes: primaryFile.sizeInBytes };
}

const { downloadModArchive } = require('./nexus-mod-download');

// Real, ONE-TIME download + hash for "also install the missing prerequisite" (2026-08-31) -- done
// exactly once, here, BEFORE the resulting mod entry ever enters review.added/runApply's own
// pipeline, specifically so that pipeline never needs to know this mod is "different" from any other
// collection-curated Added mod. Once this returns, the archive is already sitting in `downloads`
// under Nexus's own real file_name; runApply's existing classifyMod()/locateArchive() will find it
// there and skip re-downloading entirely -- ONE real network download total, not two.
//
// source.md5 deliberately omitted from the call into downloadModArchive (see that function's own
// updated header comment) -- there is no pre-known value to pass; this IS how the real one gets
// established, from the actual downloaded bytes, not guessed or left blank.
async function downloadAndBuildAddedModEntry(apiKey, gameDomain, downloads, prereq) {
    const result = await downloadModArchive({
        apiKey, gameDomain, destDir: downloads,
        source: { modId: prereq.modId, fileId: prereq.fileId, logicalFilename: prereq.name, fileSize: prereq.sizeInBytes ? Number(prereq.sizeInBytes) : undefined, md5: null },
    });
    // Shaped exactly like a real collection.json mod entry (the same shape review.added/runApply
    // already treats generically, per prepareApplyOptional's own header comment on that same
    // contract) -- `optional: false` (this is a real requirement, not an offer), `updatePolicy:
    // 'exact'` (matches every other Nexus-sourced entry in this project), `tag` deliberately omitted
    // -- collection.json's own `tag` field is Vortex's own per-packaging-run opaque string (confirmed
    // real, earlier this same investigation night: it carries zero cross-revision identity meaning on
    // its own), meaningless for a mod that was never packaged into any collection at all. Identity
    // still resolves correctly without it -- modIdentityKeys' own priority order already falls
    // through to `nexus:${modId}` when no logicalFilename match applies, and md5 (now real and
    // correct) is available as the strongest signal regardless.
    return {
        name: prereq.name,
        optional: false,
        version: prereq.version,
        // viaPrerequisite (2026-08-31, director's own real correction): this mod is being installed
        // because SOME installed collection genuinely declares it (see
        // buildInstalledModDeclarationIndex) -- NOT because THIS collection's own curator does. It
        // must still install/deploy for real, but must NEVER get folded into THIS collection's own
        // local collection.json tracking as if it were a declared member (mergeSucceededResultsIntoMods
        // checks this flag and excludes it) -- doing so would make a future review of THIS collection
        // treat an unrelated mod as "unchanged" forever, drifting from Rev N's own true authored
        // content, and would make this exact wrong-install self-reinforcing (a later run's own
        // declaration-index check would then see it as "declared" here too, regardless of whether the
        // OTHER collection that actually owns it still does).
        viaPrerequisite: true,
        source: {
            type: 'nexus', modId: prereq.modId, fileId: prereq.fileId, md5: result.md5,
            fileSize: result.fileSize, logicalFilename: prereq.name, updatePolicy: 'exact',
        },
    };
}

module.exports = {
    resolveApiKey, resolveModPrerequisites, resolvePrimaryFileFor, downloadAndBuildAddedModEntry,
    NEXUS_SE_GAME_ID,
};
