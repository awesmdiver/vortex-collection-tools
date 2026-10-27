// Rebuild Missing Files: chunking for the Extract request body.
//
// A big "Select All" extract's own {items} JSON can trivially blow past the server's request-body
// limit (web/server.js's own express.json({limit:'10mb'}), already raised once for this exact
// reason -- see that limit's own comment) -- confirmed live: 413 on a 399-mod/134,503-file batch,
// each 'missing' item carrying its own full {source,destination} list for every missing file.
// Chunked here, client-side, by actual encoded size (one mod's own missing-file list can be huge
// while another's is empty, so item COUNT alone doesn't bound the request), rather than raising the
// server limit again -- that would only move the same failure to a bigger number, not fix it.
//
// This does NOT try to have the server reuse its own last scan report to avoid resending file
// lists -- a row's own missing-file list can already diverge from that original scan by the time
// Extract runs (rebuild-missing-app.js's own rmfDownloadArchive rescans a single row after Download
// Archive and rewrites `rmfState.rows[idx]` with fresh data the original scan never saw). The
// payload rmfDoExtract builds is already the one current, authoritative copy; a server-side cache
// keyed off the old scan would risk silently restoring a stale file list for exactly that row.
// Chunking the CURRENT data is the sound fix, not caching an older copy of it.
//
// A single item can ALSO be bigger than the cap on its own (a large texture/asset mod effectively
// "not installed" can have tens of thousands of missing files) -- rmfSplitOversizedItems below runs
// first, splitting that one item's own `files` array into several smaller items, so
// rmfChunkExtractItems' own bin-packing never has to send an oversized item alone. See its own
// header comment for why a mod's `name` can't be used to merge a split item's results back together.
//
// Own file (not defined inside rebuild-missing-app.js), same convention as
// update-collection-v2-apply-pills.js -- that file can't be require()'d directly, since it runs
// DOM-touching code at load time; this one has none, so scripts/test-rmf-extract-chunking.js can
// exercise the real logic headlessly.

const RMF_EXTRACT_MAX_CHUNK_BYTES = 5 * 1024 * 1024; // half the server's 10mb cap -- plenty of headroom

function rmfChunkExtractItems(items, maxBytes = RMF_EXTRACT_MAX_CHUNK_BYTES) {
  const chunks = [];
  let current = [];
  let currentSize = 0;
  for (const item of items) {
    const size = JSON.stringify(item).length;
    // Never emit an empty chunk just because a single item alone exceeds the threshold -- send it
    // on its own rather than looping forever.
    if (current.length > 0 && currentSize + size > maxBytes) {
      chunks.push(current);
      current = [];
      currentSize = 0;
    }
    current.push(item);
    currentSize += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

// "Extract can still 413 on a single oversized mod" (2026-09-17, director's own repro: a 99-mod/
// 216,377-file batch) -- rmfChunkExtractItems above only ever splits BETWEEN items, so a single
// mod whose own missing-file list is already bigger than maxBytes always got sent alone, still over
// the server's real 10mb cap (a large texture/asset mod effectively "not installed" can easily have
// tens of thousands of files on its own). Splits THAT item's `files` array into several smaller
// items -- same identifying fields, each carrying a slice small enough to fit -- so
// rmfChunkExtractItems' own bin-packing never has to see an oversized item at all. `files.length<=1`
// items are never split -- can't be sliced any smaller. `archive-missing` items have no `files`
// array (a couple hundred bytes at most) and are never split either.
function rmfSplitOneItem(item, maxBytes = RMF_EXTRACT_MAX_CHUNK_BYTES) {
  if (item.kind !== 'missing' || !Array.isArray(item.files) || item.files.length <= 1) return [item];
  if (JSON.stringify(item).length <= maxBytes) return [item];
  const { files, ...rest } = item;
  // Every sub-item repeats `rest` (name/targetFolderName/archivePath/collectionModId) -- computed
  // once so the per-file budget below accounts for it, rather than discovering the overshoot only
  // after building an oversized sub-item.
  const overhead = JSON.stringify({ ...rest, files: [] }).length;
  const budget = Math.max(maxBytes - overhead, 1024); // always leave room for at least a few files
  const subItems = [];
  let slice = [];
  let sliceSize = 0;
  for (const file of files) {
    const size = JSON.stringify(file).length + 1; // +1 for the array's own joining comma
    // Same "never emit an empty slice" rule as rmfChunkExtractItems' own chunk boundary -- a single
    // file entry bigger than the whole budget still goes out alone rather than looping forever.
    if (slice.length > 0 && sliceSize + size > budget) {
      subItems.push({ ...rest, files: slice });
      slice = [];
      sliceSize = 0;
    }
    slice.push(file);
    sliceSize += size;
  }
  if (slice.length > 0) subItems.push({ ...rest, files: slice });
  return subItems;
}

// Runs rmfSplitOneItem over a whole `items` array (the same flat list rmfDoExtract builds, one item
// per selected row) BEFORE it reaches rmfChunkExtractItems. Order is preserved and unsplit items
// pass through unchanged, so `items` and the returned `items` stay index-aligned in spirit -- but a
// split item expands to several entries, so this also returns a same-length `rowIndices` array
// naming which ORIGINAL `items[]` position (== row index, since every caller builds one item per
// selected row) each resulting entry came from. Callers need this to merge a split mod's several
// partial results back into one final per-row outcome (see rmfMergeSubItemResults below) -- a mod's
// own `name` is NOT a safe merge key here, since names aren't guaranteed unique across collections
// in the same batch (see this project's own existing rule on that, rebuild-missing-app.js's own
// rmfBuildExtractProgressTable header comment).
function rmfSplitOversizedItems(items, maxBytes = RMF_EXTRACT_MAX_CHUNK_BYTES) {
  const outItems = [];
  const rowIndices = [];
  items.forEach((item, rowIndex) => {
    for (const subItem of rmfSplitOneItem(item, maxBytes)) {
      outItems.push(subItem);
      rowIndices.push(rowIndex);
    }
  });
  return { items: outItems, rowIndices };
}

// Merges a row's own sub-item results (one per rmfSplitOversizedItems-produced piece, in the order
// they were sent -- each shaped like extractOneMod's own return value, {name, ok, extracted,
// stillMissing, error?, note?}, see web/rebuild-missing-routes.js) into the single final outcome
// rebuild-missing-app.js's own rmfApplyExtractResults expects. The common case -- a row that was
// never split -- has exactly one sub-result and is returned completely unchanged, so this
// introduces zero behavior change for the overwhelming majority of rows.
function rmfMergeSubItemResults(subResults) {
  if (subResults.length === 1) return subResults[0];
  const name = subResults[0]?.name;
  const extracted = [];
  const stillMissing = [];
  let ok = true;
  // A HARD failure (extractOneMod's own "archive is no longer on disk"/"Incomplete request"
  // branches, or its catch-all on a real extraction exception) carries NO `stillMissing` array at
  // all -- confirmed live, 2026-09-17: without this distinction, a real repro (the archive genuinely
  // missing) merged into a nonsense "0 file(s) were not found inside the archive:" message, silently
  // discarding the real, useful error text. Every sub-item shares the same archivePath, so a hard
  // failure like this is realistically the SAME failure across every one of them, not a per-file
  // problem `stillMissing` could ever describe.
  let hardFailure;
  const firstNote = subResults.find((r) => r.note)?.note;
  for (const r of subResults) {
    extracted.push(...(r.extracted || []));
    if (!r.ok) {
      ok = false;
      if (Array.isArray(r.stillMissing)) stillMissing.push(...r.stillMissing);
      else if (!hardFailure) hardFailure = r;
    }
  }
  if (ok && extracted.length === 0 && stillMissing.length === 0) {
    return { name, ok: true, extracted: [], stillMissing: [], note: firstNote || 'Already fixed -- nothing was actually missing anymore.' };
  }
  if (ok) return { name, ok: true, extracted, stillMissing: [] };
  if (stillMissing.length === 0) {
    // No real stillMissing data anywhere -- every failure was a hard one, so surface the actual
    // error text a sub-item came back with instead of fabricating one.
    return { name, ok: false, extracted, stillMissing: [], error: hardFailure?.error || 'Something went wrong.' };
  }
  // Same message shape extractOneMod itself uses for a single (unsplit) partial failure -- capped
  // here, since concatenating stillMissing across many sub-items of one huge mod can genuinely be
  // long enough to be unreadable in a way a normal single-item failure never would be.
  const shown = stillMissing.slice(0, 20);
  const more = stillMissing.length > shown.length ? `, +${stillMissing.length - shown.length} more` : '';
  return {
    name, ok: false, extracted, stillMissing,
    error: `${stillMissing.length} file(s) were not found inside the archive: ${shown.join(', ')}${more}`,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { rmfChunkExtractItems, rmfSplitOversizedItems, rmfMergeSubItemResults, RMF_EXTRACT_MAX_CHUNK_BYTES };
}
