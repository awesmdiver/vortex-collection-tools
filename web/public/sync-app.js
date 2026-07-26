'use strict';
// Update Collection UI -- talks only to /api/sync/*. Fully independent of app.js/rebuild-routes.js
// (its own vortex-running banner, its own tiny api() helper) so this area can be worked on without
// touching the already-validated Rebuild Collection code at all.

function $s(id) { return document.getElementById(id); }

function elS(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Pulled from the SELECTED collection's own collection.json (info.domainName -- Vortex/Nexus's own
// domain slug, not something this tool invents), not a hardcoded GAME_ID -- this project only
// targets Skyrim SE today, but this is per-collection so it stays correct if that ever changes.
// Falls back to the raw domain (or a generic phrase if nothing is known yet) rather than guessing.
const NEXUS_DOMAIN_TO_GAME_NAME = {
  skyrimspecialedition: 'Skyrim Special Edition',
  skyrim: 'Skyrim',
  skyrimvr: 'Skyrim VR',
};
// Returns the FULL phrase that replaces the <span> in "On the "___ added" screen" -- e.g.
// "Skyrim Special Edition collection" -- so the word "collection" is included here, not just the
// bare game name, and a missing domainName degrades to the original "collection" text unchanged.
function gameCollectionPhrase(domainName) {
  if (!domainName) return 'collection';
  return `${NEXUS_DOMAIN_TO_GAME_NAME[domainName] || domainName} collection`;
}

// Replaces the native browser confirm() for the Apply Ignores/Apply Disables writes -- named
// distinctly (not showConfirmModal) since plain-script globals collide across files loaded on the
// same page (see work-through-app.js's own showConfirmModal, which is a DIFFERENT modal and would
// silently win the name if this file used the same one -- last-loaded script wins on the shared
// global scope).
function showSyncApplyConfirmModal(message) {
  const overlay = $s('syncApplyConfirmModal');
  $s('syncApplyConfirmModalText').textContent = message;
  overlay.classList.remove('hidden');
  return new Promise((resolve) => {
    const cleanup = (result) => { overlay.classList.add('hidden'); resolve(result); };
    $s('syncApplyConfirmModalOk').onclick = () => cleanup(true);
    $s('syncApplyConfirmModalCancel').onclick = () => cleanup(false);
  });
}

// Turns a plain-text message (the same string CRASH_HELP_TEXT/TIMEOUT_HELP_TEXT in
// lib/sync-runner.js already use for CLI output) into real HTML for a critical callout, WITHOUT
// needing a second, separately-maintained structured copy of the same text -- \n\n-separated
// blocks become <p>s, and a block whose trailing lines all look like "1. ...", "2. ..." becomes an
// <ol> instead (any leading non-numbered lines in that same block become an intro <p> first).
// Generic on purpose so any FUTURE similarly-shaped message gets the same list rendering for free.
// Promotes **word** into a real <strong> for the web UI -- applied AFTER escHtml (asterisks aren't
// HTML-special, so this is safe) so a UI element name (Refresh, Abort) can be called out the same
// way every other button/label reference already is in this app. The same source string is also
// used verbatim for CLI/console output, where the unrendered ** markers are a reasonable plain-text
// degradation (a common, recognizable convention on their own).
function mdBold(escaped) {
  return escaped.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}
function renderCriticalMessage(text) {
  return text.split('\n\n').map((block) => {
    const lines = block.split('\n');
    const listStart = lines.findIndex((l) => /^\d+\.\s/.test(l));
    if (listStart === -1) return `<p>${mdBold(escHtml(block))}</p>`;
    const intro = lines.slice(0, listStart).join(' ').trim();
    const items = lines.slice(listStart).map((l) => `<li>${mdBold(escHtml(l.replace(/^\d+\.\s*/, '')))}</li>`).join('');
    return (intro ? `<p>${mdBold(escHtml(intro))}</p>` : '') + `<ol>${items}</ol>`;
  }).join('');
}

// Shared by every "Failed: ..." catch block below -- a real failure gets the same critical-callout
// treatment everywhere on this page (icon + title + structured message), not just plain red status
// text, matching TECHNICAL.md's documented callout severity conventions.
function showCriticalCallout(el, message) {
  el.innerHTML = `<div class="callout__title">&#9888; Critical Error</div>${renderCriticalMessage(message)}`;
  el.classList.remove('hidden');
}
function hideCriticalCallout(el) {
  el.classList.add('hidden');
  el.innerHTML = '';
}

async function syncApi(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || data.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

// targetEl: the calling step's own critical-error callout div, if it has one. Shown there instead of
// shell.js's shared showVortexRunningModal (a page-wide "Vortex is running" modal) when a local spot
// exists, matching every other error in this file ("everything that happens in a section stays in a
// section") -- falls back to the shared modal only when no targetEl is given (the collection/profile
// picker loads above the numbered steps, which have no per-step callout of their own).
function handleSyncApiError(e, targetEl, retryFn) {
  if (isServerUnreachableError(e)) {
    showServerUnreachableError(retryFn);
    return true;
  }
  if (e.status === 409 && e.body && e.body.error === 'vortex-running') {
    if (targetEl) {
      showCriticalCallout(targetEl, 'Vortex is currently running. Close it completely, then retry.');
    } else {
      showVortexRunningModal(retryFn);
    }
    return true;
  }
  return false;
}

let syncCollections = [];
let syncBackups = [];
// The one collection this whole page currently operates on -- selecting a DIFFERENT collection
// resets every step below back to defaults (see resetSyncStepsForNewCollection). This mirrors how
// the real workflow always works: one collection, start to finish, never several at once (unlike
// the old terminal tool, which asked you to re-select things at every step).
let currentCollection = null;
// The backup steps 2-4 operate on for the current collection -- auto-picked (most recent backup
// for this collection, if one already exists) rather than a manual "choose a backup" dropdown,
// since picking an old backup from weeks ago was never a real workflow -- you always want the one
// that matches what you're doing right now.
let currentBackup = null;
// Whether #syncNewModIdInput's current value was written by OUR OWN auto-fill code (Apply Ignores'
// Preview handler, when the field was blank) rather than typed by the user -- confirmed live this
// distinction was missing: a blank field correctly auto-fetches the current collection id on
// Preview, but that only happened ONCE, since the field is non-blank on every later click
// regardless of who put the value there. Set true right after auto-filling; reset false by the
// field's own 'input' listener below, which only fires on a REAL keystroke -- our own `.value = `
// assignment never fires 'input', so this cleanly tells "auto-filled, still untouched by the user"
// apart from "the user has since typed something (even if it's the exact same string)".
let modIdIsAutoFilled = false;
// The last Preview's own real "will be set to ignored" count -- NOT the same as
// #syncIgnoresList's DOM child count, which now also includes "(removed)" rows (and, for a list
// over 3 items, its own "+N more" toggle row) -- neither of those belongs in the confirm modal's
// "Setting N mod(s) to ignored" text.
let lastIgnoresChangedCount = 0;
// Whether Update Collection's own backups folder is configured yet -- distinct from
// staging/downloads, which are gated app-wide (redirect to Settings on a truly fresh install, see
// shell.js). This one only matters to THIS page, so a user who never touches Update Collection at
// all is never forced through a Settings screen for a setting they'll never need.
let syncBackupRootConfigured = false;

// ---------- Picker ----------

// Resets steps 2-3's own preview state (list + Apply button + status text) -- shared by
// resetSyncStepsForNewCollection (a different COLLECTION) and restoring a different BACKUP for the
// same collection. Either way, a preview shown for the OLD backup/collection would otherwise keep
// showing stale results until Preview is clicked again, which could be mistaken for still being
// accurate for whatever's now selected.
// Kept in sync with index.html's own initial text for these two spans -- Apply is deliberately
// disabled until a Preview has actually run (so you always see what would change before writing to
// Vortex's live state), but that requirement wasn't explained anywhere on the page. Confirmed live
// this read as "the button is just broken" with a mod id already filled in and nothing else to go
// on -- restoring this same hint (not blank) every time the preview state resets keeps it visible
// until Preview is actually clicked.
const PREVIEW_REQUIRED_HINT = 'Run Preview first to see what would change and enable Apply.';

function resetIgnoresDisablesPreviewState() {
  $s('syncIgnoresApplyBtn').disabled = true;
  setSyncStatus($s('syncIgnoresStatus'), PREVIEW_REQUIRED_HINT);
  renderSyncList('syncIgnoresList', [], () => '');
  hideCriticalCallout($s('syncIgnoresCriticalError'));
  $s('syncResumeNextSteps').classList.add('hidden');
  $s('syncDisablesApplyBtn').disabled = true;
  setSyncStatus($s('syncDisablesStatus'), PREVIEW_REQUIRED_HINT);
  renderSyncList('syncDisablesList', [], () => '');
  hideCriticalCallout($s('syncDisablesCriticalError'));
  $s('syncAllDoneInfo').classList.add('hidden');
}

// Shows the right "what to do next" guidance depending on whether this backup actually captured
// anything to preserve. If both counts are 0, Apply Ignores/Apply Disables (steps 2-3) have nothing
// to do regardless of how the user handles Vortex's own update dialog -- Later vs. Install Now stops
// mattering once there's nothing this tool needs to intercept -- so steering them through that whole
// choreography anyway would be wasted effort for no benefit.
function showBackupNextSteps(ignoredCount, disabledCount) {
  const nothingToPreserve = ignoredCount === 0 && disabledCount === 0;
  $s('syncBackupNextSteps').classList.toggle('hidden', nothingToPreserve);
  $s('syncBackupNothingToDoInfo').classList.toggle('hidden', !nothingToPreserve);
}

// Resets steps 1-4 back to their defaults -- called whenever the selected collection changes, so
// a leftover backup/preview from a DIFFERENT collection never lingers on screen.
function resetSyncStepsForNewCollection() {
  currentBackup = null;
  setSyncStatus($s('syncBackupStatus'), '');
  $s('syncBackupNextSteps').classList.add('hidden');
  $s('syncBackupNothingToDoInfo').classList.add('hidden');
  hideCriticalCallout($s('syncBackupCriticalError'));
  $s('syncCollectionStaleError').classList.add('hidden');
  // Deliberately NOT touched here -- this field is never pre-populated from currentCollection.modId
  // (that id is exactly what Vortex reassigns the moment the collection is updated to a newer
  // revision, so pre-filling it would show a stale id as if it were still correct). The ONLY place
  // that ever writes into this field is the Preview handler below, and only when it's blank.
  resetIgnoresDisablesPreviewState();
}

// Re-pulls the collections list fresh and returns the CURRENT collection id for whatever's
// selected, matched by name+author rather than modId (modId is exactly the thing that changes
// across a collection update -- confirmed live: a page left open across a real update kept
// showing the OLD, now-nonexistent id indefinitely, since the web UI only ever fetches this list
// once, unlike the old terminal tool, which re-scans staging fresh before every single phase).
// Returns null only if no collection is selected at all, or none matches -- otherwise always
// returns the current id, with `changed` telling the caller whether it actually differs from
// currentCollection's last-known one (used for a UI note; a blank input field just wants
// whatever's valid right now, changed or not).
async function refreshCurrentCollectionModId() {
  if (!currentCollection) return null;
  const { collections } = await syncApi('GET', '/api/sync/collections');
  syncCollections = collections;
  const match = collections.find((c) => c.name === currentCollection.name && c.author === currentCollection.author);
  if (!match) return null;
  const oldModId = currentCollection.modId;
  const changed = match.modId !== oldModId;
  currentCollection = match;
  return { oldModId, newModId: match.modId, changed };
}

async function loadSyncCollections() {
  try {
    const { collections } = await syncApi('GET', '/api/sync/collections');
    syncCollections = collections;
    const select = $s('syncCollectionSelect');
    select.innerHTML = '';
    select.appendChild(elS('option', { value: '' }, '-- Select Collection --'));
    if (collections.length === 0) {
      $s('syncCollectionEmpty').textContent = 'No installed collections found.';
      $s('syncCollectionEmpty').classList.remove('hidden');
      return;
    }
    $s('syncCollectionEmpty').classList.add('hidden');
    for (const c of collections) {
      select.appendChild(elS('option', { value: c.modId }, `${c.name} (${c.modCount} mods)`));
    }
  } catch (e) {
    if (!handleSyncApiError(e, null, loadSyncCollections)) {
      $s('syncCollectionEmpty').textContent = `Error: ${e.message}`;
      $s('syncCollectionEmpty').classList.remove('hidden');
    }
  }
}

async function loadSyncProfiles() {
  try {
    const { profiles, lastActiveProfileId } = await syncApi('GET', '/api/sync/profiles');
    const select = $s('syncProfileSelect');
    select.innerHTML = '';
    if (profiles.length === 0) {
      select.appendChild(elS('option', { value: '', disabled: 'disabled' }, '(no Skyrim SE profile found)'));
      return;
    }
    for (const p of profiles) {
      // "(enabled)" marks whichever profile is CURRENTLY enabled in Vortex, regardless of which
      // one ends up selected below -- so if this dropdown ever gets flipped by accident, it's
      // still obvious at a glance which profile Vortex itself is actually using.
      const label = p.profileId === lastActiveProfileId ? `${p.name} (${p.profileId}) (enabled)` : `${p.name} (${p.profileId})`;
      select.appendChild(elS('option', { value: p.profileId, 'data-profile': '1' }, label));
    }
    // Pre-select the enabled profile by default -- writing to the wrong profile's modState would
    // disable/enable the wrong mods entirely, so getting this right by default matters more than
    // most defaults on this page. No "skip profile" option any more: every real use case needs one.
    if (lastActiveProfileId && select.querySelector(`option[value="${lastActiveProfileId}"]`)) {
      select.value = lastActiveProfileId;
    }
  } catch (e) {
    // Non-fatal here -- a vortex-running 409 shouldn't block viewing the rest of the picker.
    handleSyncApiError(e, null, loadSyncProfiles);
  }
}

async function loadSyncBackups() {
  const { backups, configured } = await syncApi('GET', '/api/sync/backups');
  syncBackups = backups;
  syncBackupRootConfigured = configured === true;
  $s('syncBackupRootMissingBanner').classList.toggle('hidden', syncBackupRootConfigured);
  updateSyncBackupBtnState();
}

// Most recent backup for the given collection (matched by NAME, not modId -- see backupsFor's own
// comment below for why), if any -- listBackups() already sorts newest-first, and backupsFor()
// preserves that order. Used right after "Create Backup" succeeds, to pick the just-created one back
// up as currentBackup without a second round-trip.
function mostRecentBackupFor(collectionName) {
  return backupsFor(collectionName)[0] || null;
}

// Shown in full up front, collapsed beyond this -- confirmed live a real collection can have 30
// affected mods, way more than fits comfortably before Apply. Same "+N more / Show less" pattern
// already used for Rebuild Collection's own long file lists (see rebuild-routes.js's
// FILE_LIST_TRUNCATE_AT), just a lower threshold here since this list starts right in the flow of
// clicking through Steps 2-3, not tucked into a Detail column.
const SYNC_RESULT_LIST_TRUNCATE_AT = 3;

// Shared by both Apply Ignores' Preview and Apply result lists -- "(removed)" gets the same grey
// .muted styling as everywhere else in this app, instead of reading as equally-important plain text
// next to the mod name.
function ignoresListItem(item) {
  return item.removed ? [item.name, ' ', elS('span', { class: 'muted' }, '(removed)')] : item.name;
}

function renderSyncList(elId, items, textFn) {
  const list = $s(elId);
  list.innerHTML = '';
  items.forEach((item, i) => {
    const attrs = i >= SYNC_RESULT_LIST_TRUNCATE_AT ? { class: 'sync-list-extra hidden' } : {};
    list.appendChild(elS('li', attrs, textFn(item)));
  });
  if (items.length > SYNC_RESULT_LIST_TRUNCATE_AT) {
    const extraCount = items.length - SYNC_RESULT_LIST_TRUNCATE_AT;
    const toggle = elS('a', { class: 'sync-list-toggle', 'data-more': `+${extraCount} more`, 'data-less': 'Show less' }, `+${extraCount} more`);
    list.appendChild(elS('li', { class: 'sync-list-toggle-row' }, toggle));
  }
}

// One delegated handler per list, attached once (not re-attached on every render, since
// renderSyncList replaces the list's contents via innerHTML each time) -- shared by both
// Apply Ignores' and Apply Disables' result lists.
function handleSyncListToggleClick(e) {
  const toggle = e.target.closest('.sync-list-toggle');
  if (!toggle) return;
  const list = toggle.closest('ul');
  const extras = list.querySelectorAll('.sync-list-extra');
  const collapsed = extras.length > 0 && extras[0].classList.contains('hidden');
  extras.forEach((li) => li.classList.toggle('hidden', !collapsed));
  toggle.textContent = collapsed ? toggle.dataset.less : toggle.dataset.more;
}
$s('syncIgnoresList').addEventListener('click', handleSyncListToggleClick);
$s('syncDisablesList').addEventListener('click', handleSyncListToggleClick);

// Sets one of this page's plain status spans (syncBackupStatus/syncIgnoresStatus/
// syncDisablesStatus) -- routine progress ("Checking…") or a gentle client-side reminder ("Choose
// a collection first"). A REAL failure never uses this -- see showCriticalCallout below, which
// gets its own dedicated box instead of red inline text (that was this function's first draft,
// replaced once "normalize this to a critical error, like a red box" came in).
function setSyncStatus(el, text) {
  el.textContent = text;
}

// ---------- Collection picker (selecting a collection is step 0 -- everything below operates on
// whichever one is currently selected, until you change it) ----------

// Create Backup needs BOTH a collection selected AND a real backups folder configured -- called
// from both selectCollection() and loadSyncBackups() (whichever one changes state last on load
// shouldn't leave the other's check stale). Restore Backup only needs a collection selected AND at
// least one existing backup for it -- it's a read of whatever's already on disk, so it doesn't
// depend on syncBackupRootConfigured the same way (if a backup somehow exists from before the
// folder setting was cleared, restoring it should still work).
function updateSyncBackupBtnState() {
  $s('syncBackupBtn').disabled = !currentCollection || !syncBackupRootConfigured;
  $s('syncRestoreBackupBtn').disabled = !currentCollection || backupsFor(currentCollection?.name).length === 0;
}

// Every backup for the given collection, newest-first (syncBackups is already sorted that way).
// Matched by NAME (case-insensitive), not modId -- confirmed live this was a real bug: modId is
// exactly the thing that changes across an update (the whole reason this tool exists), so filtering
// by exact modId equality made a real, valid backup taken BEFORE an update permanently invisible
// here the instant the collection updated, even though it's still exactly the backup you'd want to
// restore to continue to step 2. Backup snapshots don't store an author field, so name is the best
// available match -- the same approach the old terminal menu's own pickInstalledCollection already
// used for this identical "modId isn't stable across revisions" problem.
function backupsFor(collectionName) {
  if (!collectionName) return [];
  return syncBackups.filter((b) => b.collectionName.toLowerCase() === collectionName.toLowerCase());
}

// Revision number embedded in a collection's own modId (Vortex's own archive-derived folder-naming
// convention: <name>-<nexusModId>-<revision>-<timestamp>) -- parsed from the END of the string via
// regex rather than splitting on '-' throughout, since the NAME portion can itself contain dashes
// (even a double dash, e.g. a name with a trailing space) that would otherwise throw off a
// left-to-right split.
function revisionFromModId(modId) {
  const m = /-(\d+)-(\d+)$/.exec(modId || '');
  return m ? m[1] : null;
}

function backupLabel(b) {
  const revision = revisionFromModId(b.collectionModId);
  const revisionPart = revision ? `Rev ${revision} — ` : '';
  return `${revisionPart}${new Date(b.createdAt).toLocaleString()} (${b.ignored.length} ignored, ${b.disabled.length} disabled)`;
}

// Shared by the dropdown's own change handler AND boot-time restoration (see "boot" below).
// Deliberately does NOT auto-pick an existing backup for currentBackup, even if one exists for
// this collection -- confirmed live this was actively misleading (silently landed on a backup as
// old as "0 ignored, 0 disabled" from a much earlier, incomplete test with no clear signal that had
// happened). Selecting a collection is just selecting a collection now -- Steps 2-4 stay blocked
// until you explicitly either Create Backup (a fresh one) or Restore Backup (an existing one).
function selectCollection(modId) {
  currentCollection = syncCollections.find((c) => c.modId === modId) || null;
  resetSyncStepsForNewCollection();
  updateSyncBackupBtnState();
  $s('syncListModsBtn').disabled = !currentCollection;
  $s('syncGameNameSpan').textContent = gameCollectionPhrase(currentCollection?.domainName);
  // Same name shown in the collection dropdown, without the "(N mods)" suffix -- so this step stays
  // clear about which collection even if the picker above has scrolled off screen.
  $s('syncCollectionNameSpan').textContent = currentCollection?.name || 'this collection';
}

$s('syncCollectionSelect').addEventListener('change', () => {
  selectCollection($s('syncCollectionSelect').value);
});

// ---------- Read-only report (callable any time once a collection is selected) ----------

// A real page navigation (location.href), not window.open in a new tab -- the report's own Back
// button wouldn't make sense/would break the flow in a separate tab, per direct feedback. Same
// convention Rebuild Collection's own log-view report already uses.
$s('syncListModsBtn').addEventListener('click', () => {
  if (!currentCollection) return;
  const profileSelect = $s('syncProfileSelect');
  const profileId = profileSelect.value;
  const profileName = profileSelect.selectedOptions[0]?.textContent || profileId;
  const url = `/api/sync/list-mods/report?modId=${encodeURIComponent(currentCollection.modId)}` +
    `&profileId=${encodeURIComponent(profileId)}` +
    `&collectionName=${encodeURIComponent(currentCollection.name)}` +
    `&profileName=${encodeURIComponent(profileName)}`;
  location.href = url;
});

// ---------- Phase 1: Backup (run BEFORE clicking Update in Vortex) ----------

$s('syncBackupBtn').addEventListener('click', async () => {
  const statusEl = $s('syncBackupStatus');
  $s('syncCollectionStaleError').classList.add('hidden');
  hideCriticalCallout($s('syncBackupCriticalError'));
  if (!currentCollection) { setSyncStatus(statusEl, 'Choose a collection first.'); return; }
  const collectionModId = currentCollection.modId;
  const profileId = $s('syncProfileSelect').value || undefined;
  if (!profileId) { setSyncStatus(statusEl, 'No Skyrim SE profile found -- open Vortex and make sure a profile exists for this game.'); return; }
  const btn = $s('syncBackupBtn');
  btn.disabled = true;
  setSyncStatus(statusEl, 'Backing up…');
  try {
    const result = await syncApi('POST', '/api/sync/backup', { collectionModId, profileId });
    setSyncStatus(statusEl, result.ignoredCount === 0 && result.disabledCount === 0
      ? 'Backup created — no ignored or disabled mods for this collection, nothing to preserve.'
      : `Backup created — ${result.ignoredCount} ignored mod(s), ${result.disabledCount} disabled mod(s) captured. Continue to step 2, 'Apply Ignores' below.`);
    showBackupNextSteps(result.ignoredCount, result.disabledCount);
    await loadSyncBackups();
    currentBackup = mostRecentBackupFor(currentCollection.name);
  } catch (e) {
    // Rare, real case: the collection moved on to a newer revision since this page loaded --
    // reloading is the only real fix (everything on this page needs to be re-read fresh, not just
    // this one id), so this gets its own critical callout + Retry button instead of the generic
    // inline "Failed: ..." status text.
    if (e.body && e.body.error === 'collection-stale') {
      setSyncStatus(statusEl, '');
      $s('syncCollectionStaleError').classList.remove('hidden');
    } else if (!handleSyncApiError(e, $s('syncBackupCriticalError'))) {
      setSyncStatus(statusEl, '');
      showCriticalCallout($s('syncBackupCriticalError'), e.message);
    }
  } finally {
    btn.disabled = false;
  }
});
$s('syncCollectionStaleRetryBtn').addEventListener('click', () => {
  location.reload();
});

// Restore Backup -- for the rare case someone wants steps 2-4 to use an OLDER backup than the most
// recent one auto-picked above. Deliberately a popup you have to explicitly open and confirm, not
// an always-visible dropdown next to Create Backup -- that was the ORIGINAL design here, removed
// after direct feedback that it was too easy to accidentally bump it to an earlier backup without
// noticing, silently changing what steps 2-4 would act on.
$s('syncRestoreBackupBtn').addEventListener('click', () => {
  if (!currentCollection) return;
  const select = $s('syncRestoreBackupSelect');
  select.innerHTML = '';
  for (const b of backupsFor(currentCollection.name)) {
    select.appendChild(elS('option', { value: b.filePath }, backupLabel(b)));
  }
  if (currentBackup) select.value = currentBackup.filePath;
  $s('syncRestoreBackupModal').classList.remove('hidden');
});
$s('syncRestoreBackupCancelBtn').addEventListener('click', () => {
  $s('syncRestoreBackupModal').classList.add('hidden');
});
$s('syncRestoreBackupConfirmBtn').addEventListener('click', () => {
  const filePath = $s('syncRestoreBackupSelect').value;
  const chosen = syncBackups.find((b) => b.filePath === filePath);
  $s('syncRestoreBackupModal').classList.add('hidden');
  if (!chosen) return;
  currentBackup = chosen;
  // A stale preview from whatever was previously current (the auto-picked most-recent backup, or a
  // different restored one) would otherwise keep showing results that no longer match what's
  // actually selected, until Preview is clicked again.
  resetIgnoresDisablesPreviewState();
  const nothingToPreserve = chosen.ignored.length === 0 && chosen.disabled.length === 0;
  setSyncStatus($s('syncBackupStatus'), nothingToPreserve
    ? `Restored backup from ${backupLabel(chosen)} — no ignored or disabled mods for this collection, nothing to preserve.`
    : `Restored backup from ${backupLabel(chosen)}. This will be used for steps 2-4.`);
  // Confirmed live: Create Backup showed this, Restore Backup didn't -- but the next real-world
  // step is identical either way (a currentBackup is now ready, so go click Update in Vortex),
  // regardless of whether it just got created fresh or was picked from an existing one.
  showBackupNextSteps(chosen.ignored.length, chosen.disabled.length);
});

// ---------- Phase 2: Apply Ignores (run AFTER Vortex Update -> Later, Vortex closed) ----------

// Only fires on a real keystroke -- programmatically setting .value (our own auto-fill below) never
// triggers 'input'. This is what lets the Preview handler tell "still holding our own auto-fill,
// untouched since" apart from "the user has typed something (even the exact same string back)".
$s('syncNewModIdInput').addEventListener('input', () => { modIdIsAutoFilled = false; });

$s('syncIgnoresPreviewBtn').addEventListener('click', async () => {
  const modIdInput = $s('syncNewModIdInput');
  let modId = modIdInput.value.trim();
  const backup = currentBackup;
  const statusEl = $s('syncIgnoresStatus');
  hideCriticalCallout($s('syncIgnoresCriticalError'));
  if (!backup) { setSyncStatus(statusEl, 'Create a backup in Step 1 first, or restore a backup to use an existing one.'); return; }
  setSyncStatus(statusEl, 'Checking…');
  $s('syncIgnoresApplyBtn').disabled = true;
  let refreshNote = '';
  try {
    // A BLANK field, OR one still holding OUR OWN previous auto-fill (never edited by the user
    // since), means "figure out the current collection id for me" -- pulled fresh every time,
    // not just the first time. Confirmed live this was the actual gap: a blank field auto-filled
    // correctly on the FIRST Preview click, but every click after that saw a non-blank field and
    // silently reused that same now-possibly-stale id instead of refreshing. Anything the user
    // actually TYPED themselves (real keystrokes, tracked by the field's own 'input' listener
    // below) is used exactly as-is with no correction -- auto-refresh only ever applies when
    // nothing the user typed is there to respect.
    if (!modId || modIdIsAutoFilled) {
      const resolved = await refreshCurrentCollectionModId();
      if (!resolved) {
        setSyncStatus(statusEl, 'Could not determine the collection id automatically -- select a collection above, or enter it yourself.');
        $s('syncIgnoresApplyBtn').disabled = true;
        return;
      }
      modId = resolved.newModId;
      modIdInput.value = modId;
      modIdIsAutoFilled = true;
      refreshNote = ' (collection id detected automatically)';
    }
    const result = await syncApi('POST', '/api/sync/apply-ignores/preview', { modId, backupPath: backup.filePath });
    // Combined into one list, newly-ignored first then any removed-by-the-author ones -- so the
    // count shown here always adds back up to what the backup itself captured (e.g. "4 ignored" in
    // the backup = 3 here + 1 marked "(removed)", never a silent gap the user has to go hunt for).
    const changedItems = result.changed.map((c) => ({ name: c.name, removed: false }));
    const unmatchedItems = (result.unmatched || []).map((u) => ({ name: u.name, removed: true }));
    renderSyncList('syncIgnoresList', [...changedItems, ...unmatchedItems], ignoresListItem);
    lastIgnoresChangedCount = result.changed.length;
    let text = `Preview — ${result.changed.length} mod(s) will be set to ignored.`;
    if (result.unmatched?.length > 0) {
      text += ` ${result.unmatched.length} mod(s) removed by the update.`;
    }
    text += refreshNote;
    setSyncStatus(statusEl, text);
    // Distinct from the normal "removed by the update" explanation above -- see lib.js's
    // identityDriftWarning: this means the "removed"/"unmatched" counts above may not reflect real
    // removal at all, but a tool/Vortex compatibility problem, so it gets its own alarming callout
    // rather than blending into the routine status text.
    if (result.identityWarning) showCriticalCallout($s('syncIgnoresCriticalError'), result.identityWarning);
    $s('syncIgnoresApplyBtn').disabled = false;
  } catch (e) {
    setSyncStatus(statusEl, '');
    if (!handleSyncApiError(e, $s('syncIgnoresCriticalError'))) {
      showCriticalCallout($s('syncIgnoresCriticalError'), e.message);
    }
  }
});

$s('syncIgnoresApplyBtn').addEventListener('click', async () => {
  const modId = $s('syncNewModIdInput').value.trim();
  const backup = currentBackup;
  const statusEl = $s('syncIgnoresStatus');
  hideCriticalCallout($s('syncIgnoresCriticalError'));
  if (!modId || !backup) return;
  const count = lastIgnoresChangedCount;
  const collectionName = currentCollection?.name || modId;
  const confirmed = await showSyncApplyConfirmModal(
    `This sets ${count} mod(s) to ignored for the collection "${collectionName}". A full backup is taken first, then this writes directly to Vortex's database.`
  );
  if (!confirmed) return;
  const btn = $s('syncIgnoresApplyBtn');
  btn.disabled = true;
  setSyncStatus(statusEl, "Writing to Vortex's live state…");
  try {
    const result = await syncApi('POST', '/api/sync/apply-ignores/apply', { modId, backupPath: backup.filePath });
    const changedItems = result.changed.map((c) => ({ name: c.name, removed: false }));
    const unmatchedItems = (result.unmatched || []).map((u) => ({ name: u.name, removed: true }));
    renderSyncList('syncIgnoresList', [...changedItems, ...unmatchedItems], ignoresListItem);
    let doneText = `Done — ${result.changed.length} rule(s) set to ignored.`;
    if (result.unmatched?.length > 0) doneText += ` ${result.unmatched.length} mod(s) removed by the update.`;
    doneText += ' Vortex database was updated and backed up.';
    setSyncStatus(statusEl, doneText);
    if (result.identityWarning) showCriticalCallout($s('syncIgnoresCriticalError'), result.identityWarning);
    $s('syncResumeNextSteps').classList.remove('hidden');
  } catch (e) {
    setSyncStatus(statusEl, '');
    if (!handleSyncApiError(e, $s('syncIgnoresCriticalError'))) {
      showCriticalCallout($s('syncIgnoresCriticalError'), e.message);
    }
    btn.disabled = false;
  }
});

// ---------- Phase 3: Apply Disables (run AFTER Resume finishes, Vortex closed) ----------

$s('syncDisablesPreviewBtn').addEventListener('click', async () => {
  const backup = currentBackup;
  const statusEl = $s('syncDisablesStatus');
  hideCriticalCallout($s('syncDisablesCriticalError'));
  if (!backup) { setSyncStatus(statusEl, 'Create a backup in Step 1 first, or restore a backup to use an existing one.'); return; }
  setSyncStatus(statusEl, 'Checking…');
  $s('syncDisablesApplyBtn').disabled = true;
  try {
    const result = await syncApi('POST', '/api/sync/apply-disables/preview', { backupPath: backup.filePath });
    if (result.nothingToDo) {
      renderSyncList('syncDisablesList', [], () => '');
      setSyncStatus(statusEl, 'This backup captured no disabled mods — nothing to do.');
      return;
    }
    renderSyncList('syncDisablesList', result.matches, (m) => m.matchedRef.name);
    let text = `Preview — ${result.matches.length} mod(s) will be set to disabled.`;
    if (result.missing.length > 0) text += ` ${result.missing.length} not found yet (Resume may still be running, or they weren't part of this revision).`;
    setSyncStatus(statusEl, text);
    if (result.identityWarning) showCriticalCallout($s('syncDisablesCriticalError'), result.identityWarning);
    $s('syncDisablesApplyBtn').disabled = result.matches.length === 0;
  } catch (e) {
    setSyncStatus(statusEl, '');
    if (!handleSyncApiError(e, $s('syncDisablesCriticalError'))) {
      showCriticalCallout($s('syncDisablesCriticalError'), e.message);
    }
  }
});

$s('syncDisablesApplyBtn').addEventListener('click', async () => {
  const backup = currentBackup;
  const statusEl = $s('syncDisablesStatus');
  hideCriticalCallout($s('syncDisablesCriticalError'));
  if (!backup) return;
  if (!backup.profileId) { setSyncStatus(statusEl, 'This backup has no profile recorded -- cannot apply disables.'); return; }
  const disablesCount = $s('syncDisablesList').children.length;
  const disablesCollectionName = currentCollection?.name || backup.collectionName || '';
  const disablesConfirmed = await showSyncApplyConfirmModal(
    `This sets ${disablesCount} mod(s) to disabled for the collection "${disablesCollectionName}". A full backup is taken first, then this writes directly to Vortex's database.`
  );
  if (!disablesConfirmed) return;
  const btn = $s('syncDisablesApplyBtn');
  btn.disabled = true;
  setSyncStatus(statusEl, "Writing to Vortex's live state…");
  try {
    const result = await syncApi('POST', '/api/sync/apply-disables/apply', { profileId: backup.profileId, backupPath: backup.filePath });
    renderSyncList('syncDisablesList', result.changed, (c) => c.name);
    setSyncStatus(statusEl, `Done — ${result.changed.length} mod(s) set to disabled. Vortex database was updated and backed up.`);
    if (result.identityWarning) showCriticalCallout($s('syncDisablesCriticalError'), result.identityWarning);
    $s('syncAllDoneInfo').classList.remove('hidden');
  } catch (e) {
    setSyncStatus(statusEl, '');
    if (!handleSyncApiError(e, $s('syncDisablesCriticalError'))) {
      showCriticalCallout($s('syncDisablesCriticalError'), e.message);
    }
    btn.disabled = false;
  }
});

// ---------- Optional: Compare (pure computation, never touches Vortex's state DB) ----------

$s('syncCompareBtn').addEventListener('click', () => {
  const errEl = $s('syncCompareCriticalError');
  hideCriticalCallout(errEl);
  // NOT showErrorModal -- that modal lives in the DOM inside <section id="area-rebuild">, which is
  // display:none while on this (Sync) tool area, so it would silently fail to actually appear.
  // This file's own established convention for errors (used by every other step above) is a
  // per-step callout--critical div instead.
  if (!currentCollection) { showCriticalCallout(errEl, 'Select a collection above first, then run this report.'); return; }
  const backup = currentBackup;
  if (!backup) { showCriticalCallout(errEl, 'Create a backup in Step 1 first (or restore a backup to use an existing one).'); return; }
  // collectionJsonPath comes straight from scanStagingCollections (see the /api/sync/collections
  // response) -- the staging folder's own collection.json, no separate lookup or user-entered path
  // needed.
  const collectionPath = currentCollection.collectionJsonPath;
  const url = `/api/sync/compare/report?backupPath=${encodeURIComponent(backup.filePath)}&collectionPath=${encodeURIComponent(collectionPath)}`;
  // NOT window.open() -- shown inline under Reports > Update Compare Report instead (stats-app.js's
  // showUpdateCompareReport, exposed on window since that file loads AFTER this one).
  if (typeof window.showUpdateCompareReport === 'function') {
    window.showUpdateCompareReport(url);
  } else {
    showCriticalCallout(errEl, 'Could not open the Reports view. Reload the page and try again.');
  }
});

// ---------- boot ----------

// The Ignored/Disabled report is a real page (not an SPA route) -- its own Back button round-trips
// ?collectionModId=&profileId= so navigating back here restores exactly what was selected before,
// instead of resetting to "-- Select Collection --" (confirmed live this was lost otherwise).
async function boot() {
  await Promise.all([loadSyncCollections(), loadSyncProfiles(), loadSyncBackups()]);
  const params = new URLSearchParams(location.search);
  const restoreProfileId = params.get('profileId');
  if (restoreProfileId && $s('syncProfileSelect').querySelector(`option[value="${restoreProfileId}"]`)) {
    $s('syncProfileSelect').value = restoreProfileId;
  }
  const restoreModId = params.get('collectionModId');
  if (restoreModId && $s('syncCollectionSelect').querySelector(`option[value="${restoreModId}"]`)) {
    $s('syncCollectionSelect').value = restoreModId;
    selectCollection(restoreModId);
  }
}
boot();
