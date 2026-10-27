'use strict';
// Shared "Deploy your mods to Vortex" endpoint (2026-09-14, "Rebuild Collection, Rebuild Missing
// Files, and Update Collection: the same Deploy step on every Done screen"). The real fire-and-poll
// deployAllMods()/getDeployAllProgress() pair (lib/vortex-bridge-client.js) used to be copy-pasted
// per tool -- update-collection-v2-routes.js and rebuild-missing-routes.js both had their own
// identical /deploy-all + /deploy-all/progress; Rebuild Collection had none at all. Mounted once at
// /api/deploy and shared by all three now. missing-masters-routes.js, duplicate-version-cleanup-
// routes.js, and pgpatcher-routes.js each still have their own copy -- left alone (out of this
// task's scope; pgpatcher-routes.js in particular also has a SECOND, differently-shaped internal
// deploy usage during /build, so it isn't a straight swap) -- see TECHNICAL.md for the follow-up
// note.
//
// Single module-scoped in-flight flag, not one per tool -- a real, out-of-band, whole-install Vortex
// operation, so only one deploy can ever run at a time across the WHOLE app now. The old per-tool
// copies each had their OWN flag, meaning two different tools' Deploy buttons could fire
// deployAllMods() at once; that's fixed by construction here, not by an added check.
const express = require('express');
const bridgeClient = require('../lib/vortex-bridge-client');
const syncLib = require('../lib/vortex-sync/lib');

// Generic, tool-agnostic version of what used to be Update Collection v2's own
// DEPLOY_BLOCKED_BY_CYCLES_MESSAGE (lib/update-collection-v2-runner.js, removed -- this was its only
// caller). That copy opened with "Update finished, but deployment failed", which only made sense
// from Update Collection's own Done screen; this message now shows identically from all three tools'
// Deploy result, so the phase-specific lead-in is dropped -- the tool's own success/failure banner
// right above the Deploy panel already establishes what just happened.
const DEPLOY_BLOCKED_BY_CYCLES_MESSAGE = "Deployment failed. Vortex couldn't deploy your mods because "
    + 'a rule cycle was detected. Resolve the cycle using Cycle Helper or within Vortex, then deploy '
    + 'again.';
const DEPLOY_BLOCKED_BY_CYCLES_CODE = 'deploy-blocked-by-cycles';

function createDeployRouter() {
    const router = express.Router();
    let deployAllInProgress = false;

    router.post('/all', async (req, res) => {
        if (deployAllInProgress) {
            return res.status(409).json({ error: 'A deploy is already in progress.' });
        }
        const bridgeAvailable = await bridgeClient.checkBridgeAvailable(syncLib.GAME_ID);
        if (!bridgeAvailable) {
            return res.status(409).json({
                error: 'bridge-unavailable',
                message: 'The Vortex Bridge extension must be reachable (Vortex genuinely open) to deploy from here.',
            });
        }
        deployAllInProgress = true;
        res.status(202).json({});
        (async () => {
            try {
                await bridgeClient.deployAllMods();
            } catch {
                // deployAllMods never throws by contract; the progress endpoint below is what
                // actually reports a real failure, so there is nothing useful to do here.
            }
        })().finally(() => { deployAllInProgress = false; });
    });

    router.get('/all/progress', async (req, res) => {
        const progress = await bridgeClient.getDeployAllProgress();
        // A null here means "no fresh update right now", NOT that the deploy failed -- the same
        // event-loop congestion that makes a deploy slow can also time out this poll. Falls back to
        // this route's own in-flight flag rather than reporting a false "not active".
        const result = progress || { active: deployAllInProgress, done: !deployAllInProgress };
        // deployBlockedByCycles (Vortex Bridge v0.18.0+, a real boolean fact read off Vortex's own live
        // notification state, not guessed): the Vortex Bridge's own deployAllMods() call can return/resolve
        // normally even when Vortex actually aborted the deploy because of a rule cycle, so
        // result.error staying empty is NOT proof the deploy succeeded. Only overrides a genuinely
        // empty error, never a real one this route already reported another way.
        if (result.done && result.deployBlockedByCycles && !result.error) {
            result.error = DEPLOY_BLOCKED_BY_CYCLES_MESSAGE;
            result.code = DEPLOY_BLOCKED_BY_CYCLES_CODE;
        }
        res.json(result);
    });

    return router;
}

module.exports = { createDeployRouter };
