'use strict';
// Shared drift-check logic used by check-vortex-source-drift.js (standalone CLI) AND by
// extract-mod.js/smoke-test-collection.js (run automatically at the start of every extraction, so
// the user doesn't have to remember to run it separately -- if Vortex's upstream logic this
// project hardcoded has changed, the extraction refuses to run instead of silently producing
// output based on a stale copy of Vortex's behavior).

const { execFile } = require('child_process');
const refs = require('../vortex-source-refs.json').refs;

function latestCommitFor(repo, filePath) {
    return new Promise((resolve, reject) => {
        execFile(
            'gh',
            ['api', `repos/${repo}/commits?path=${filePath}&per_page=1`, '--jq', '.[0].sha,.[0].commit.committer.date'],
            { encoding: 'utf8' },
            (err, stdout) => {
                if (err) return reject(err);
                const [sha, date] = stdout.trim().split('\n');
                resolve({ sha, date });
            }
        );
    });
}

// Returns { ok, results }. ok is true only if every tracked file's current last-touching commit
// matches what we last verified AND every check succeeded (a network/gh failure counts as NOT ok
// -- inability to verify is treated the same as drift, since either way we can't vouch for the
// hardcoded logic still matching Vortex).
async function checkVortexDrift() {
    const results = [];
    let ok = true;
    for (const ref of refs) {
        try {
            const current = await latestCommitFor(ref.repo, ref.path);
            const drifted = current.sha !== ref.lastVerifiedCommit;
            if (drifted) ok = false;
            results.push({ ref, current, drifted, error: null });
        } catch (e) {
            ok = false;
            results.push({ ref, current: null, drifted: null, error: e.message.split('\n')[0] });
        }
    }
    return { ok, results };
}

module.exports = { checkVortexDrift };
