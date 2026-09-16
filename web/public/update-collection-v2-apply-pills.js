'use strict';
// Real Apply status-pill vocabulary/colors for Update Collection v2's Apply Progress screen
// (2026-08-28, director's own explicit build spec -- design/vortex-update-collection-v2-mockup.html's
// own APPLY_PILLS object is the real word-of-truth reference here, ported directly). Pure lookup +
// string-building, no DOM dependency, so it's a plain require()-able Node module for a real
// regression test AND a plain classic <script> global for update-collection-v2-app.js's own
// rendering -- same dual-context pattern update-collection-v2-problem-grouping.js already
// established. ONE shared table, deliberately -- the mockup's own history is a cautionary tale here:
// it originally had two separate pill-styling functions for its two demo entry points, which visibly
// diverged and had to be consolidated. Every apply-progress pill in the real app (the main update
// pass and an optional-mods pass alike) renders through this SAME function.
//
// Deliberate override of real Vortex's own convention, confirmed against its source
// (CollectionItemStatus.tsx + collections.scss): Vortex shows Downloading and Installing in the
// identical brand color, and "Enabled" as plain checkmark+text with no pill background at all. This
// app's own word-of-truth spec does neither -- Downloading/Installing get distinct colors so which
// stage a mod is in reads at a glance, and Enabled is a real green FILLED pill (same pill family as
// every other state here), not a one-off plain-text treatment. Don't "fix" either of these back
// toward Vortex parity -- this mismatch is deliberate, confirmed live after an earlier literal-
// Vortex-parity attempt was explicitly rejected.
//
// Downloading/Installing were originally spec'd as "distinct colors (blue vs. amber)" -- REVISED
// 2026-09-14 (director's own catch): amber is this app's real "warning" color, and a live in-
// progress pill (Extracting…/Installing…) sharing it with FINISHED amber statuses (Rebuild
// Collection's own Folder locked/No archive/Open FOMOD, rendered through this same shared vocabulary
// -- see app.js's updateProgressRow) meant only the spinner told a live state apart from a finished
// one. The two LIVE working stages below get their own dedicated --working (violet) instead, so
// --warning/status-pill--warning stays reserved for real finished-state warnings only.
//
// Downloading moved off status-pill--info/--accent too -- REVISED again 2026-09-14 (design-side
// follow-up catch): --accent is exactly the variable each brand theme JSON overrides
// (web/public/themes/*.json), and Fallout 4's own accent is #00D400, a green close enough to
// --success that a downloading row read as already finished under that skin. Downloading now renders
// status-pill--downloading (its own fixed --downloading token, styles.css), immune to any brand's
// accent choice the same way --working already is.
const UCV2_APPLY_PILL_STYLES = {
  // Any key not in this table (a genuinely unexpected value) falls back to this same muted look
  // rather than an unstyled pill -- see ucv2ApplyPillHtml's own fallback below.
  pending: { cls: 'status-pill--pending' },
  removing: { cls: 'status-pill--removing' },
  downloading: { cls: 'status-pill--downloading status-pill--spin', spinner: true },
  // Per-row real extraction (2026-08-28, director's own refined Added-mod sequence: Download
  // pending -> Downloading... -> Extracting... -> Pending install -> Installing... [batch] ->
  // Enabled). Same live/spinner look 'installing' always had -- only the label changed, since this
  // key now means specifically "this mod's own extraction is happening right now," distinct from
  // the batch-registration 'installing' state below. Violet (--working), not amber, since 2026-09-14
  // -- see this file's own header comment.
  extracting: { cls: 'status-pill--working status-pill--spin', spinner: true },
  // A mod that finished its own extraction and is waiting for the batch registration call below --
  // muted, same look as 'pending', since nothing is actively happening for this specific row yet.
  'pending-install': { cls: 'status-pill--pending' },
  // Repurposed (2026-08-28): now specifically the WHOLE-BATCH registration moment (createModsBatch),
  // fired for every pending row together, not per-row extraction (see 'extracting' above for that).
  // Violet (--working), not amber, since 2026-09-14 -- see this file's own header comment.
  installing: { cls: 'status-pill--working status-pill--spin', spinner: true },
  enabled: { cls: 'status-pill--success' },
  failed: { cls: 'status-pill--critical' },
  skipped: { cls: 'status-pill--neutral' },
};

// label must already be caller-escaped (HTML-safe) -- this module has no DOM access in its Node
// context, so it can't call the browser-only escHtmlUcv2 itself. Every real call site in
// update-collection-v2-app.js passes escHtmlUcv2(label).
function ucv2ApplyPillHtml(key, label) {
  const style = UCV2_APPLY_PILL_STYLES[key] || UCV2_APPLY_PILL_STYLES.pending;
  const spinnerHtml = style.spinner ? '<span class="status-pill__spinner"></span>' : '';
  return `<span class="status-pill ${style.cls}">${spinnerHtml}${label}</span>`;
}

// Dual-context: a plain classic <script> in the browser (declares these as page globals, `module` is
// undefined there) AND a plain require()-able CommonJS module in Node (used by
// scripts/test-ucv2-apply-pills.js) -- same pattern status-labels.js already established.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ucv2ApplyPillHtml, UCV2_APPLY_PILL_STYLES };
}
