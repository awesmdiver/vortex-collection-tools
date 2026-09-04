'use strict';
// Pure "is this a raw network error, and what should we say instead" logic for Update Collection v2's
// critical-error callout (2026-08-28, director's own real report: a raw "read ECONNRESET" -- a
// forcibly-closed TCP connection to Nexus mid-request -- reached the UI verbatim, on the widest
// revision range tested, 38 revisions aliased into one richness query). No DOM dependency, so it can
// be a plain require()-able Node module for a real regression test AND a plain classic <script>
// global for update-collection-v2-app.js's own rendering -- same dual-context pattern
// update-collection-v2-problem-grouping.js already established (see that file's own header comment).
//
// Deliberately narrow: only swaps in friendly copy for the handful of raw Node.js network-error
// strings a dropped/refused/timed-out connection actually produces. Every OTHER error (a real app
// error, a Nexus GraphQL error, a Helper error, etc.) passes through completely unchanged -- this
// must never mask a genuine, actionable error message behind vague network-hiccup text.
const UCV2_RAW_NETWORK_ERROR_PATTERN = /ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up/i;

// Gemini-passed (queue: network-hiccup-error-copy-gemini-pass) -- trimmed the earlier draft's
// redundant "or try Review update again" now that a real Retry button sits right next to this text.
const UCV2_NETWORK_HICCUP_MESSAGE =
  "Couldn't reach Nexus. The connection dropped partway through, which is usually a brief network hiccup. Click Retry to try again.";

function ucv2FriendlyErrorMessage(message) {
  if (typeof message === 'string' && UCV2_RAW_NETWORK_ERROR_PATTERN.test(message)) return UCV2_NETWORK_HICCUP_MESSAGE;
  return message;
}

// Dual-context: a plain classic <script> in the browser (declares these as page globals, `module` is
// undefined there) AND a plain require()-able CommonJS module in Node (used by
// scripts/test-ucv2-friendly-error-message.js) -- same pattern status-labels.js already established.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ucv2FriendlyErrorMessage, UCV2_NETWORK_HICCUP_MESSAGE, UCV2_RAW_NETWORK_ERROR_PATTERN };
}
