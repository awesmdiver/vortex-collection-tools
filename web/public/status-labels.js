'use strict';
// Single source of truth for translating a mod's raw internal rebuild-status key (REBUILT,
// SKIP_NO_ARCHIVE, FAILED_MISMATCH_NOT_TOUCHED, etc.) into the plain-language label a user should
// actually see. Previously only app.js had this table (as its own local STATUS_TEXT), so every
// OTHER page that also renders a status badge/pill (stats-app.js, work-through-app.js, and
// rebuild-routes.js's standalone Log View report) fell back to printing the raw key -- confirmed
// live 2026-07-26 via a Stats Report screenshot showing "FAILED_MISMATCH_NOT_TOUCHED" verbatim.
// Extracted here so every one of those places shares exactly one table instead of four copies that
// could drift. Loaded as a plain classic <script> (same convention as every other file in
// web/public), so STATUS_TEXT/statusLabel are just ordinary script-scope globals on any page that
// includes this file BEFORE the page's own script -- see index.html (SPA) and rebuild-routes.js's
// standalone report template for the two places that do.
const STATUS_TEXT = {
  REBUILT: 'Rebuilt',
  REBUILD: 'Will rebuild',
  REBUILD_QUEUED: 'Queued',
  SKIP_IGNORED: 'Ignored',
  SKIP_NO_ARCHIVE: 'No archive',
  SKIP_OPTIONAL_NOT_INSTALLED: 'Optional, not installed',
  SKIP_OPEN_FOMOD: 'Open FOMOD',
  SKIP_EXCEPTED: 'Excepted (never auto-fixed)',
  FAILED_MISMATCH_NOT_TOUCHED: 'Mismatch (not touched)',
  FAILED_EXTRACTION_NOT_TOUCHED: 'Extraction failed (not touched)',
  FAILED_EXTRACTION_NO_PRIOR_DATA: 'Extraction failed (still missing)',
  CRITICAL_MANUAL_RESTORE_NEEDED: 'CRITICAL',
  pending: 'In progress…',
};

function statusLabel(status) {
  return STATUS_TEXT[status] || status;
}

// Dual-context: a plain classic <script> in the browser (declares STATUS_TEXT/statusLabel as page
// globals, `module` is undefined there) AND a plain require()-able CommonJS module in Node (used by
// rebuild-routes.js, which renders its standalone Log View report -- badges included -- server-side,
// where a browser <script src> tag can't help; Node wraps every required file in its own function
// scope, so this same file being require()'d elsewhere never collides with the browser-global
// declarations above).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { STATUS_TEXT, statusLabel };
}
