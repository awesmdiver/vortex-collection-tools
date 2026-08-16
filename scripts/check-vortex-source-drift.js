#!/usr/bin/env node
// Checks whether any Vortex/fomod-installer source file this project ported or derived logic
// from (see vortex-source-refs.json) has changed upstream since we last read it. We don't call
// Vortex's code at runtime -- its behavior (stopPatterns list, destination-collision tie-break,
// mod-root-prefix algorithm, etc.) is hardcoded into lib/*.js -- so a future Vortex update could
// silently desync our replicated logic with no error, no warning, just quietly-wrong output.
//
// For each tracked file, queries GitHub for the SHA of the most recent commit that touched that
// exact path. If it matches vortex-source-refs.json's `lastVerifiedCommit`, the file is
// byte-identical to what we read -- nothing to do. If it differs, the file has changed since we
// last looked and needs a manual re-review (diff it, decide whether the change affects the
// specific logic we derived, update our code + this manifest's lastVerifiedCommit accordingly).
//
// Requires: `gh` CLI, authenticated (uses `gh api`, not a raw token).
//
// Usage: node check-vortex-source-drift.js

const { execFileSync } = require('child_process');
const path = require('path');

const refs = require('../config/vortex-source-refs.json').refs;

function latestCommitFor(repo, filePath) {
    const out = execFileSync(
        'gh',
        ['api', `repos/${repo}/commits?path=${filePath}&per_page=1`, '--jq', '.[0].sha,.[0].commit.committer.date'],
        { encoding: 'utf8' }
    );
    const [sha, date] = out.trim().split('\n');
    return { sha, date };
}

function main() {
    console.log(`Checking ${refs.length} tracked Vortex/fomod-installer source file(s) for drift...\n`);
    let anyDrift = false;

    for (const ref of refs) {
        let current;
        try {
            current = latestCommitFor(ref.repo, ref.path);
        } catch (e) {
            console.log(`[ERROR] ${ref.repo}/${ref.path} -- couldn't check: ${e.message.split('\n')[0]}`);
            anyDrift = true;
            continue;
        }

        if (current.sha === ref.lastVerifiedCommit) {
            console.log(`[OK]    ${ref.repo}/${ref.path}`);
        } else {
            anyDrift = true;
            console.log(`[DRIFT] ${ref.repo}/${ref.path}`);
            console.log(`        last verified: ${ref.lastVerifiedCommit} (${ref.lastVerifiedDate})`);
            console.log(`        now:            ${current.sha} (${current.date})`);
            console.log(`        derived into:   ${ref.derivedInto}`);
            console.log(`        what we derived: ${ref.whatWeDerived}`);
            console.log(`        review: gh api repos/${ref.repo}/commits/${current.sha} --jq '.files[] | select(.filename==\"${ref.path}\") | .patch'`);
        }
    }

    console.log('');
    if (anyDrift) {
        console.log('DRIFT DETECTED -- review the file(s) above, update the affected lib/*.js if behavior');
        console.log('actually changed, and bump lastVerifiedCommit in vortex-source-refs.json once reviewed.');
        process.exit(1);
    } else {
        console.log('No drift. All tracked source files match what this project last verified against.');
        process.exit(0);
    }
}

main();
