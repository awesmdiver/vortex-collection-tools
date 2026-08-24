# Merge Plugin Verifier

A single, self-contained page for testers of **Vortex Collection Tools**' Merge Plugins feature (aka
"The Forge"). Compares a plugin merged in The Forge against the same merge built by
[zMerge](https://www.nexusmods.com/skyrimspecialedition/mods/23440) — the trusted reference this
app's own merge engine is built to match byte-for-byte.

## Using it

Open `index.html` directly — no server, no install, no dependencies. Works in any modern browser
(Chrome, Edge, Firefox). Everything runs locally in your browser; nothing you pick is ever uploaded
automatically.

Pick the merge's output folder from both tools, click **Compare Plugins**. A byte-identical match
gets a clear pass. A mismatch shows exactly what differs and helps you file a useful bug report —
with a downloadable diagnostic bundle (the merged plugin's own log/JSON files, never any other mod's
own assets) you attach yourself to a GitHub issue.

## Development notes

Pure vanilla HTML/CSS/JS, zero external dependencies (including a hand-rolled, dependency-free ZIP
writer — see the script's own `buildZip`). The byte-level comparison logic is a browser port of
`scripts/compare-merge-output.js` (this repo's own Node-side acceptance test for the merge engine) —
keep the two in sync if the comparison logic itself ever changes; they're independently verified to
produce identical numbers against the same real files, not derived from each other at runtime.
