'use strict';
// Reshapes cd.analyzeCycles' modKey-based result into something the frontend can render directly --
// display names resolved here (where modIndex is available), never left for the browser to guess at,
// same "always render displayName(), never a raw modKey" rule the rest of this app follows. Also
// collects an installationPaths map (same shape/purpose as rules-generator.js's own
// analyzeCollections) so the frontend's Fix modal can lazily check for conflicting files via the
// EXISTING /api/rules-generator/conflicts route -- no need for a second, duplicate conflicts route
// here.
//
// Extracted out of lib/cycle-helper-worker.js (2026-08-18) so BOTH the isolated worker (state.v2
// path) and lib/cycle-helper-runner.js's live-helper path (Vortex Collection Helper extension, no
// state.v2 involved at all) share this exact same shaping logic -- a scan result must render
// identically to the frontend regardless of which data source produced the modIndex it came from.
function shapeCycleResult(rg, modIndex, analysis) {
    if (!analysis.hasCycles) return { hasCycles: false };

    const installationPaths = {};
    const noteInstallPath = (modKey) => {
        if (modKey == null || installationPaths[modKey] !== undefined) return;
        installationPaths[modKey] = modIndex.get(modKey)?.installationPath || null;
    };
    const nameOf = (modKey) => rg.displayName(modIndex.get(modKey));

    const cycles = analysis.cycles.map((cycle) => {
        cycle.modsInvolved.forEach(noteInstallPath);

        const candidates = cycle.candidates.map((c) => {
            const ownerModKey = c.edge.ownerModKey;
            const ruleType = c.edge.rule.type; // 'before'/'after' AS CURRENTLY STORED on the owner's own rule
            const targetModKey = rg.resolveRefToModKey(modIndex, c.edge.rule.reference);
            noteInstallPath(ownerModKey);
            noteInstallPath(targetModKey);
            return {
                ownerModKey,
                ownerName: nameOf(ownerModKey),
                targetModKey,
                targetName: nameOf(targetModKey),
                ruleType,
                breaksFully: c.breaksFully,
                remainingTangleSize: c.remainingTangleSize,
                inShortestCycle: c.inShortestCycle,
                changedSinceSnapshot: c.changedSinceSnapshot,
            };
        });

        return {
            modCount: cycle.modCount,
            modsInvolved: cycle.modsInvolved.map((modKey) => ({ modKey, name: nameOf(modKey) })),
            shortestCycle: (cycle.shortestCycle || []).map((modKey) => ({ modKey, name: nameOf(modKey) })),
            candidates,
        };
    });

    return { hasCycles: true, cycles, installationPaths };
}

module.exports = { shapeCycleResult };
