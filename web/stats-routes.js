'use strict';
// Stats Report backend -- read-only aggregation over every log file this project has ever written
// (currently 51 files across 12 collections, so a plain directory scan is plenty; no index/database
// needed). Two genuinely different views over the same log set, kept as two separate endpoints
// rather than one unified query:
//   - /overview: a time-period-scoped historical aggregate (totals, concurrency-vs-duration).
//   - /issues: a "what's wrong right now" snapshot -- the LATEST run per collection, regardless of
//     the period picker, since a stale problem from 3 months ago that's still the latest run for
//     that collection is still a real, current problem.
// Mixing these into one query would force awkward semantics (what if a collection's only run in the
// picked period isn't its overall latest?), so they stay as two independent reads.
//
// schemaVersion 3 (added this session) is the first version to carry `concurrentExtractions`/
// `phaseDurationsMs` -- every log written before that simply lacks these fields (`undefined`, not
// `null`). All aggregation here must tolerate that identically to `null` and never assume presence.

const express = require('express');
const path = require('path');
const { readAllLogs, getCurrentIssues } = require('../lib/log-aggregation');

const PERIOD_DAYS = { '7d': 7, '30d': 30 };

function createStatsRouter() {
    const router = express.Router();
    const logsDir = path.join(__dirname, '..', 'logs');

    router.get('/overview', (req, res) => {
        const period = req.query.period;
        const days = PERIOD_DAYS[period];
        const cutoff = days ? new Date(Date.now() - days * 24 * 60 * 60 * 1000) : null;

        const all = readAllLogs(logsDir);
        const realLogs = all.filter((l) => l.runStatus !== 'dry-run-complete');
        const logs = realLogs.filter((l) => !cutoff || new Date(l.startedAt) >= cutoff);

        // Distinct collectionModId/collectionName pairs across ALL real history (not period-limited
        // -- the "browse by collection" drill-down picker shouldn't disappear a collection just
        // because its only runs happened outside the currently-selected period). runCount lets the
        // picker show something meaningful (matching the main Rebuild Collection picker's own "(N
        // mods)" convention) instead of the raw internal collectionModId.
        //
        // Uses the CHRONOLOGICALLY LATEST log's collectionName, not just whichever one readdirSync
        // happens to return first -- confirmed real-world: some collections have old logs recorded
        // before a name-resolution fix landed (collectionName was the raw collectionModId back then),
        // with later runs correctly showing the real collection.json name. Always prefer the newest.
        const collectionsByKey = new Map(); // collectionModId -> { collectionName, runCount, latestStartedAt }
        for (const l of realLogs) {
            if (!collectionsByKey.has(l.collectionModId)) {
                collectionsByKey.set(l.collectionModId, { collectionName: l.collectionName, runCount: 0, latestStartedAt: l.startedAt });
            }
            const entry = collectionsByKey.get(l.collectionModId);
            entry.runCount += 1;
            if (new Date(l.startedAt) > new Date(entry.latestStartedAt)) {
                entry.latestStartedAt = l.startedAt;
                entry.collectionName = l.collectionName;
            }
        }
        const collections = [...collectionsByKey.entries()]
            .map(([collectionModId, v]) => ({ collectionModId, collectionName: v.collectionName, runCount: v.runCount }))
            .sort((a, b) => a.collectionName.localeCompare(b.collectionName));

        const totalRuns = logs.length;
        const totalCollections = new Set(logs.map((l) => l.collectionModId)).size;

        const summaryTotals = {};
        for (const l of logs) {
            for (const [status, count] of Object.entries(l.summary || {})) {
                summaryTotals[status] = (summaryTotals[status] || 0) + count;
            }
        }

        // Bucket by concurrency setting -- pre-v3 logs (no concurrentExtractions field at all) land
        // in an explicit "unknown (pre-v3 log)" bucket rather than being silently dropped or
        // coerced to some default value that would misrepresent what was actually used.
        const buckets = new Map(); // key -> { runCount, rebuildMsSamples: [] }
        for (const l of logs) {
            const key = l.concurrentExtractions == null ? 'unknown (pre-v3 log)' : String(l.concurrentExtractions);
            if (!buckets.has(key)) buckets.set(key, { runCount: 0, rebuildMsSamples: [] });
            const bucket = buckets.get(key);
            bucket.runCount += 1;
            const rebuildMs = l.phaseDurationsMs?.rebuildMs;
            if (rebuildMs != null) bucket.rebuildMsSamples.push(rebuildMs);
        }
        const concurrencyBreakdown = [...buckets.entries()].map(([concurrency, b]) => ({
            concurrency,
            runCount: b.runCount,
            samplesWithTiming: b.rebuildMsSamples.length,
            avgRebuildMs: b.rebuildMsSamples.length > 0
                ? Math.round(b.rebuildMsSamples.reduce((a, c) => a + c, 0) / b.rebuildMsSamples.length)
                : null,
        }));

        const logsWithTimingData = logs.filter((l) => l.phaseDurationsMs?.rebuildMs != null).length;

        // Rough per-mod rebuild cost, worst first -- a cheap, direct answer to "find bottlenecks"
        // without requiring a separate feature. Only counts runs with real timing data.
        const perCollection = new Map(); // collectionModId -> {collectionName, rebuildMsTotal, modsTotal, samples}
        for (const l of logs) {
            const rebuildMs = l.phaseDurationsMs?.rebuildMs;
            if (rebuildMs == null || !l.totalMods) continue;
            if (!perCollection.has(l.collectionModId)) {
                perCollection.set(l.collectionModId, { collectionName: l.collectionName, rebuildMsTotal: 0, modsTotal: 0, samples: 0 });
            }
            const c = perCollection.get(l.collectionModId);
            c.rebuildMsTotal += rebuildMs;
            c.modsTotal += l.totalMods;
            c.samples += 1;
        }
        const topBottlenecks = [...perCollection.entries()]
            .map(([collectionModId, c]) => ({
                collectionModId, collectionName: c.collectionName, samples: c.samples,
                avgMsPerMod: Math.round(c.rebuildMsTotal / c.modsTotal),
            }))
            .sort((a, b) => b.avgMsPerMod - a.avgMsPerMod)
            .slice(0, 10);

        res.json({
            period: period && days ? period : 'all',
            totalRuns, totalCollections, summaryTotals, concurrencyBreakdown,
            logsWithTimingData, logsTotal: totalRuns, topBottlenecks, collections,
        });
    });

    // "Current issues" -- shared with web/work-through-routes.js's own /list endpoint via
    // lib/log-aggregation.js's getCurrentIssues(), so the two reports can never show a different
    // population of current problem mods.
    router.get('/issues', (req, res) => {
        res.json(getCurrentIssues(logsDir));
    });

    return router;
}

module.exports = { createStatsRouter };
