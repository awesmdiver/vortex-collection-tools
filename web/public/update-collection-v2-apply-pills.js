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
// app's own word-of-truth spec does neither -- Downloading/Installing get distinct colors (blue vs.
// amber) so which stage a mod is in reads at a glance, and Enabled is a real green FILLED pill (same
// pill family as every other state here), not a one-off plain-text treatment. Don't "fix" either of
// these back toward Vortex parity -- this mismatch is deliberate, confirmed live after an earlier
// literal-Vortex-parity attempt was explicitly rejected.
const UCV2_APPLY_PILL_STYLES = {
  // Any key not in this table (a genuinely unexpected value) falls back to this same muted look
  // rather than an unstyled pill -- see ucv2ApplyPillHtml's own fallback below.
  pending: { cls: 'status-pill--pending' },
  removing: { cls: 'status-pill--removing' },
  downloading: { cls: 'status-pill--info status-pill--spin', spinner: true },
  // Per-row real extraction (2026-08-28, director's own refined Added-mod sequence: Download
  // pending -> Downloading... -> Extracting... -> Pending install -> Installing... [batch] ->
  // Enabled). Same amber/spinner look 'installing' always had -- only the label changed, since this
  // key now means specifically "this mod's own extraction is happening right now," distinct from
  // the batch-registration 'installing' state below.
  extracting: { cls: 'status-pill--warning status-pill--spin', spinner: true },
  // A mod that finished its own extraction and is waiting for the batch registration call below --
  // muted, same look as 'pending', since nothing is actively happening for this specific row yet.
  'pending-install': { cls: 'status-pill--pending' },
  // Repurposed (2026-08-28): now specifically the WHOLE-BATCH registration moment (createModsBatch),
  // fired for every pending row together, not per-row extraction (see 'extracting' above for that).
  installing: { cls: 'status-pill--warning status-pill--spin', spinner: true },
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
