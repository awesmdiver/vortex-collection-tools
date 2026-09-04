'use strict';
// Rules Generator UI -- talks only to /api/rules-generator/*. See TECHNICAL.md's "Rules Generator"
// section for the full design rationale (bidirectional rules, auto-remap, the Vortex-source-verified
// write mechanism "Apply to Vortex" uses). Own tiny api()/$ helpers, same reasoning as sync-app.js's
// own (independent of app.js, safe to work on without touching already-validated code).

function $rg(id) { return document.getElementById(id); }

function escHtmlRg(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function rgApi(method, path, body) {
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

function rgShowCriticalError(message) {
  const el = $rg('rgCriticalError');
  el.innerHTML = `<div class="callout__title">🛑 Couldn't do that</div><p>${escHtmlRg(message)}</p>`;
  el.classList.remove('hidden');
}
function rgHideCriticalError() {
  $rg('rgCriticalError').classList.add('hidden');
  $rg('rgCriticalError').innerHTML = '';
}

// retryFn (queue: vortex-retry-noop-sweep): the real action to re-run when Try Again is clicked on
// the shared "Vortex is running" modal -- same fix already applied to rebuild-missing-app.js's own
// rmfHandleError (b3eb0c7). Every call site below now passes the action that actually hit the gate.
function rgHandleError(e, retryFn) {
  if (window.isServerUnreachableError && window.isServerUnreachableError(e)) {
    window.showServerUnreachableError(retryFn || (() => {}));
    return;
  }
  if (e.status === 409 && e.body?.error === 'vortex-running') {
    window.showVortexRunningModal(retryFn || (() => {}));
    return;
  }
  rgShowCriticalError(e.message);
}

// ---- Step 1 / Step 2 mini-stepper -- reuses the SAME real .merge-stepper/.merge-step component
// Update Collection's own syncStepper (sync-app.js) already established, not a new one invented for
// this. Fully navigable (click any pill to jump), matching that same precedent -- both screens are
// already populated by the time either one is reachable. ----

// Sentence case, not Title Case -- these are step/status labels (like this same screen's own
// "Ready to copy"/"Needs your input"/"Nothing to do" badges below), not action buttons. See
// DESIGN.md's Title-Case-for-buttons section for the distinction.
//
// 3 steps (2026-08-17, was 2) -- Step 3: Exceptions, see design/vortex-rules-generator-relationship-
// check-mockup.html's own #screenExceptions (approved) and rgConfirmApply's own comment for when it
// auto-navigates there. The pill always renders here regardless of whether Step 3 has any content,
// same "always show every step, only the LANDING step is conditional" precedent Step 1's own
// auto-skip already establishes.
const RG_STEPS = ['Relationship check', 'Report', 'Exceptions'];
let rgStep = 0;

function rgRenderStepper() {
  $rg('rgStepper').innerHTML = RG_STEPS.map((label, i) => {
    const cls = i === rgStep ? 'active' : i < rgStep ? 'done' : '';
    const num = i < rgStep ? '✓' : String(i + 1);
    return `<div class="merge-step ${cls}" data-step="${i}"><b>${num}</b>${label}</div>`;
  }).join('');
}

function rgGoToStep(n) {
  if (n < 0 || n > 2) return;
  rgStep = n;
  rgRenderStepper();
  $rg('rgScreenRelCheck').classList.toggle('hidden', n !== 0);
  $rg('rgResults').classList.toggle('hidden', n !== 1);
  $rg('rgScreenExceptions').classList.toggle('hidden', n !== 2);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

let rgLastResult = null;
// Step 3 (Exceptions)'s own data -- {leftoverOldInstalls, skippedAlreadySet, skippedDisabled,
// skippedNoConflict}, refreshed from result.exceptions (a fresh scan) or result.freshExceptions
// (right after a real Apply/Save-my-picks/Switch-all write) -- see rgRenderExceptionsStep's own
// comment. null before the first analysis.
let rgLastExceptions = null;
// Per-mod pick for Step 3's "Need a decision" cards -- modKey -> 'keep' | 'switch'. Unset (missing
// key) means 'keep', matching the mockup's own pre-checked "Keep what's set now" default -- same
// "confident default, opt IN to the destructive one" polarity as everywhere else in this app that
// defaults to the safe choice. Cleared on every fresh Step 3 render (a new analysis/write result) so
// a stale pick from a previous mod list never silently carries over.
const rgExceptionPicks = {};
// True right after a real Apply completes (the "Complete" callout is showing), reset back to false
// only by a genuine fresh analysis (the "Find matching rules" click) -- NOT by rgRender itself, since
// rgRender also runs right after Apply (using its own freshAnalysis) and needs to KEEP the Complete
// state visible at that exact moment. Confirmed real 2026-08-16: once rules are applied, the "Apply
// to Vortex" button and the "Ready to copy" badge both go stale (nothing left to apply, nothing left
// to copy that isn't already copied) -- re-clicking Apply at that point is a confusing no-op (safe,
// since applyRules is already idempotent -- see its own skippedAlreadyResolved handling -- but reads
// wrong regardless). Needs your input / Nothing to do / Show all are untouched -- those stay
// accurate after Apply (anomalies don't get resolved by copying rules; "nothing to do" mods still
// have nothing to do), so hiding them would be wrong, not just unnecessary.
let rgApplyCompleted = false;
// Which summary section is currently isolated -- null shows all three (Ready to copy/Needs your
// input/Nothing to do), matching this app's established "click a badge to filter, click again (or
// Show all) to clear" convention elsewhere (Stats Report, Work Through Report, etc.). Unlike those
// reports (one shared table, rows carry data-status), this page has three separate sections with
// no shared row structure -- so filtering here means showing only the matching SECTION(s), not rows.
// A Set, not a single value -- multi-select, each badge toggles independently (workspace
// UX-PRINCIPLES.md rule 7, applied app-wide 2026-08-15); empty shows all three sections.
let rgSectionFilter = new Set();
const RG_SECTION_IDS = { ready: 'rgReadySection', review: 'rgReviewSection', nolink: 'rgNoLinkSection' };

async function rgLoadPickers() {
  try {
    // Reset both selects back to just their placeholder option first -- rgLoadPickers is now a
    // real Vortex-running RETRY target (see below), not just a one-shot page-load call, so a second
    // run must not append a duplicate set of options onto whatever the first run already added.
    $rg('rgOldCollectionSelect').innerHTML = '<option value="">-- Original collection --</option>';
    $rg('rgNewCollectionSelect').innerHTML = '<option value="">-- New collection --</option>';
    $rg('rgEmpty').classList.add('hidden');

    let vortexBlockedNew = false;
    const [oldRes, workshopRes] = await Promise.all([
      rgApi('GET', '/api/rules-generator/collections'),
      rgApi('GET', '/api/rules-generator/workshop-collections').catch((e) => {
        // Vortex running only blocks the (live-state-derived) new-collection half -- the
        // Vortex-closed-independent old-collection list still loads fine in parallel. Surfaced via
        // the real shared modal now (queue: vortex-modal-consistency-sweep, director-confirmed live
        // 2026-08-15: the plain muted inline line this used to fall back to read as a quiet,
        // easy-to-miss exception to how every other "Vortex must be closed" moment in this app
        // looks), with a working retry -- not swallowed into a silent, unlabeled empty list.
        if (e.status === 409 && e.body?.error === 'vortex-running') {
          vortexBlockedNew = true;
          window.showVortexRunningModal(rgLoadPickers);
          return { collections: [] };
        }
        throw e;
      }),
    ]);

    const oldSelect = $rg('rgOldCollectionSelect');
    oldRes.collections
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((c) => {
        const opt = document.createElement('option');
        opt.value = c.modId; // this API's own field name for what this project calls a modKey elsewhere
        opt.textContent = c.name;
        oldSelect.appendChild(opt);
      });

    const newSelect = $rg('rgNewCollectionSelect');
    workshopRes.collections.forEach((c) => {
      const opt = document.createElement('option');
      opt.value = c.modKey;
      opt.textContent = c.name;
      newSelect.appendChild(opt);
    });
    // Genuinely zero new (Workshop) collections -- Vortex WAS closed, there just aren't any right
    // now. Distinct from the vortex-running case above, which is the modal's job to say, not this
    // line's -- showing this same text there would now be misleadingly claiming Vortex is still the
    // blocker even after the modal already covered it.
    if (workshopRes.collections.length === 0 && !vortexBlockedNew) {
      $rg('rgEmpty').textContent = 'No new (Workshop) collections found yet.';
      $rg('rgEmpty').classList.remove('hidden');
    }
  } catch (e) {
    rgHandleError(e, rgLoadPickers);
  }
}

function rgUpdateAnalyzeButton() {
  const ready = $rg('rgOldCollectionSelect').value && $rg('rgNewCollectionSelect').value;
  $rg('rgAnalyzeBtn').disabled = !ready;
}

function rgFindByKey(list, key) {
  return list.find((x) => x.modKey === key);
}

// A rule row's plain-language description. "loads" is dropped everywhere (assumed, same as the
// main work list's dropdown already does) -- this must always match the dropdown's own wording
// exactly (see rgRuleTypeOptions), since both describe the same four states.
function rgRuleLabel(type) {
  if (type === 'before') return 'before';
  if (type === 'after') return 'after';
  if (type === 'conflicts') return 'never together with';
  return '???';
}

// Which mod cards are currently expanded (by newModKey) -- same Set-based expand-state pattern as
// Work Through Report's own collection cards (work-through-app.js's wtExpandedCollections):
// rebuild the affected markup on toggle rather than hide/show pre-rendered nodes.
const rgExpandedItems = new Set();

// Same expand-state pattern, for the anomaly review cards (Needs your input) -- added 2026-07-26
// alongside "Expand all" so this list has real collapsed state too, not just Ready to copy.
const rgExpandedAnomalies = new Set();

// Per-row overrides from the rule-type dropdown, keyed by `${newModKey}::${ruleIdx}` -> the
// user-picked value ('', 'before', 'after', 'conflicts'). Survives a re-render (expanding a
// different card) since it's read back out when rebuilding each row's <select>. Not sent
// anywhere yet -- Phase 2 is still preview-only; this is where a later "Apply" step would read
// its final decisions from.
const rgRuleOverrides = {};

function rgRuleOverrideKey(newModKey, ruleIdx) {
  return `${newModKey}::${ruleIdx}`;
}

// Same idea for the anomaly cards' radio pick, keyed by modKey -> the chosen candidate index (as a
// string). Needed now that anomaly cards collapse/expand (added 2026-07-26) -- without this, a
// collapse/expand cycle would silently reset the user's pick back to the first candidate every
// time, since re-rendering rebuilds the radio inputs from scratch.
const rgAnomalyOverrides = {};

// Step 1: Relationship Check's own picks, keyed by modKey -> {targetKey, type} ('before'/'after'),
// or simply absent (never set, or explicitly cleared) for "???"/unresolved -- same semantics as
// rgAnomalyOverrides above, just a richer value shape since a relationship pick names BOTH which
// mod and which direction, not just an index into a fixed candidate list.
const rgRelationshipOverrides = {};

// Same expand-state pattern as rgExpandedAnomalies, for the relationship-check cards.
const rgExpandedRelationships = new Set();

// Same expand-state pattern, for Step 3 (Exceptions)'s own "Need a decision" cards.
const rgExpandedExceptions = new Set();

// Same four options Vortex's own "Manage rules" dialog offers, in the same order -- "???" (no
// rule at all, Vortex's own literal wording confirmed against its real source this session),
// before, after, "never together with" (Vortex's own label for the conflicts type).
function rgRuleTypeOptions(selectedValue) {
  const options = [
    ['', '???'],
    ['before', 'before'],
    ['after', 'after'],
    // Trailing spaces are deliberate -- the last option in a native <select> dropdown otherwise
    // sits flush against the list's right edge (confirmed live, looked right-justified/cramped).
    ['conflicts', 'never together with  '],
  ];
  return options
    .map(([value, label]) => `<option value="${value}"${value === selectedValue ? ' selected' : ''}>${label}</option>`)
    .join('');
}

function rgRenderReadyCard(item) {
  const newName = escHtmlRg(rgFindByKey(rgLastResult.newMembersLookup, item.newModKey)?.name || item.newModKey);
  const oldName = escHtmlRg(rgFindByKey(rgLastResult.oldMembersLookup, item.oldModKey)?.name || item.oldModKey);
  const resolvable = item.rulesToConsider.filter((r) => r.status !== 'unresolved');
  const unresolvedCount = item.rulesToConsider.length - resolvable.length;
  const afterCount = resolvable.filter((r) => r.type === 'after').length;
  const beforeCount = resolvable.filter((r) => r.type === 'before').length;
  const conflictsCount = resolvable.filter((r) => r.type === 'conflicts').length;

  const summaryParts = [`${resolvable.length} rule${resolvable.length === 1 ? '' : 's'}`];
  if (afterCount) summaryParts.push(`${afterCount} after`);
  if (beforeCount) summaryParts.push(`${beforeCount} before`);
  if (conflictsCount) summaryParts.push(`${conflictsCount} never-together-with`);
  if (unresolvedCount) summaryParts.push(`${unresolvedCount} couldn't be matched`);

  const isExpanded = rgExpandedItems.has(item.newModKey);
  let bodyHtml = '';
  if (isExpanded) {
    const rowsHtml = resolvable.length
      ? resolvable
          .map((r, ruleIdx) => {
            const overrideKey = rgRuleOverrideKey(item.newModKey, ruleIdx);
            const selectedValue = Object.prototype.hasOwnProperty.call(rgRuleOverrides, overrideKey)
              ? rgRuleOverrides[overrideKey]
              : r.type;
            const targetName = escHtmlRg(rgLastResult.nameByKey[r.targetKey] || '(unknown)');
            const remapNote = r.status === 'remapped'
              ? ` <span class="muted">(updated from ${escHtmlRg(rgLastResult.nameByKey[r.originalTargetKey] || '(unknown)')})</span>`
              : '';
            return `<tr>
              <td>
                <select class="select rg-rule-type-select" data-new-mod-key="${escHtmlRg(item.newModKey)}" data-rule-idx="${ruleIdx}">
                  ${rgRuleTypeOptions(selectedValue)}
                </select>
              </td>
              <td>${targetName}${remapNote}</td>
              <td>
                <span class="rg-conflict-count rg-conflict-count--muted"
                      data-a-key="${escHtmlRg(item.newModKey)}"
                      data-b-key="${escHtmlRg(r.targetKey)}">&hellip;</span>
              </td>
            </tr>`;
          })
          .join('')
      : `<tr><td colspan="3" class="muted">Nothing to copy for this mod.</td></tr>`;
    bodyHtml = `<div class="plan-table-wrap"><table class="plan-table"><tbody>${rowsHtml}</tbody></table></div>`;
  }

  return `
    <div class="path-row rg-ready-card" style="flex-direction: column; align-items: stretch; gap: 8px;">
      <div class="rg-ready-card__header muted" data-new-mod-key="${escHtmlRg(item.newModKey)}" style="display:flex; align-items:center; gap:10px; cursor:pointer;">
        <span>${isExpanded ? '&#9660;' : '&#9654;'}</span>
        <strong style="color: var(--text);">${newName}</strong>
        <span class="muted">copying from
          <span class="rg-mod-link" data-old-mod-key="${escHtmlRg(item.oldModKey)}">${oldName}</span>
          &mdash; ${summaryParts.join(', ')}
        </span>
      </div>
      ${bodyHtml}
    </div>`;
}

// ---- "N conflicting file(s)" -- mirrors Vortex's own per-row indicator on its Manage Rules page.
// Computed lazily per visible row (not eagerly for the whole collection up front) and cached by
// modKey pair so re-expanding a card, or two rows that happen to reference the same pair, don't
// refetch. installationPaths comes straight from the already-completed analyze() call -- no extra
// DB round-trip, just a filesystem comparison on the server. ----

const rgConflictCache = new Map(); // "aKey::bKey" -> Promise<string[]|null> (null = can't compare)

function rgFetchConflicts(aKey, bKey) {
  const cacheKey = `${aKey}::${bKey}`;
  if (!rgConflictCache.has(cacheKey)) {
    const aPath = rgLastResult.installationPaths?.[aKey];
    const bPath = rgLastResult.installationPaths?.[bKey];
    const promise = !aPath || !bPath
      ? Promise.resolve(null) // one side has no local staging folder -- nothing to compare, not an error
      : rgApi('GET', `/api/rules-generator/conflicts?a=${encodeURIComponent(aPath)}&b=${encodeURIComponent(bPath)}`)
          .then((data) => data.files)
          .catch(() => null);
    rgConflictCache.set(cacheKey, promise);
  }
  return rgConflictCache.get(cacheKey);
}

// Kicks off (cached) lookups for every conflict-count placeholder currently in the DOM and fills
// each one in once its own fetch resolves -- called after every ready-list render.
function rgLoadConflictCounts() {
  $rg('rgReadyList').querySelectorAll('.rg-conflict-count[data-a-key]').forEach((el) => {
    const { aKey, bKey } = el.dataset;
    if (!aKey || !bKey) return;
    rgFetchConflicts(aKey, bKey).then((files) => {
      if (files === null) {
        el.textContent = 'not installed locally';
        return;
      }
      if (files.length === 0) {
        el.textContent = 'no conflicting files';
        return;
      }
      el.textContent = `${files.length} conflicting file${files.length === 1 ? '' : 's'}`;
      el.classList.remove('rg-conflict-count--muted');
      el.classList.add('rg-conflict-count--clickable');
      el.dataset.fileList = JSON.stringify(files);
    });
  });
}

let rgOpenConflictPopover = null;

function rgConflictPopoverOutsideClick(e) {
  if (rgOpenConflictPopover && !rgOpenConflictPopover.contains(e.target)) rgCloseConflictPopover();
}
function rgConflictPopoverEscape(e) {
  if (e.key === 'Escape') rgCloseConflictPopover();
}

function rgCloseConflictPopover() {
  if (!rgOpenConflictPopover) return;
  rgOpenConflictPopover.remove();
  rgOpenConflictPopover = null;
  document.removeEventListener('click', rgConflictPopoverOutsideClick, true);
  document.removeEventListener('keydown', rgConflictPopoverEscape, true);
}

// "A simple popup" per the user's own wording (and Vortex's own screenshot) -- a small box
// anchored under the clicked count, not a full modal or separate window.
function rgShowConflictPopover(anchorEl) {
  rgCloseConflictPopover();
  let files = [];
  try { files = JSON.parse(anchorEl.dataset.fileList || '[]'); } catch { files = []; }

  const popover = document.createElement('div');
  popover.className = 'rg-conflict-popover';
  popover.innerHTML = `
    <p class="rg-conflict-popover__title">${files.length} conflicting file${files.length === 1 ? '' : 's'}</p>
    <ul class="rg-conflict-popover__list">${files.map((f) => `<li>${escHtmlRg(f)}</li>`).join('')}</ul>`;
  document.body.appendChild(popover);

  const rect = anchorEl.getBoundingClientRect();
  const top = Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - popover.offsetHeight - 8));
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - popover.offsetWidth - 8));
  popover.style.position = 'fixed';
  popover.style.top = `${top}px`;
  popover.style.left = `${left}px`;

  rgOpenConflictPopover = popover;
  // Deferred one tick so the same click that opened this popover doesn't immediately bubble up
  // to document and close it again.
  setTimeout(() => {
    document.addEventListener('click', rgConflictPopoverOutsideClick, true);
    document.addEventListener('keydown', rgConflictPopoverEscape, true);
  }, 0);
}

// The reference popup: the old mod's rules AS THEY ACTUALLY ARE right now (oldModRules, never
// remapped/deduped-after-remap) -- a "warm and fuzzy" sanity check the user can compare the
// pre-selected work list against, not a second editable copy of anything.
//
// A genuine separate OS-level window, not an in-page overlay and not a browser tab -- same
// "force a real window via explicit width/height" mechanism lib/vortex-sync/report.js uses for
// its Nexus mod-name links (window.open with width/height beats a target="_blank" anchor, which
// every modern browser treats as a tab regardless of site preference). There's no static URL to
// point at here since the content is derived from data already sitting in rgLastResult, so this
// opens a blank window and writes the document directly instead of navigating to a server route.
//
// Deliberately NO "noopener" here, unlike the Nexus links -- confirmed live this session that
// noopener makes Chrome still open the window but hand script back a null reference (it did pop
// open, just permanently blank, since document.write() never ran). report.js's links get away
// with noopener because they only ever set href and never need the reference again; this one
// needs to keep writing into the window it just opened, so it can't sever that reference.
function rgOpenOldRulesWindow(oldModKey) {
  const item = rgLastResult.mapping.find((m) => m.oldModKey === oldModKey);
  const oldName = rgFindByKey(rgLastResult.oldMembersLookup, oldModKey)?.name || oldModKey;
  const rows = (item?.oldModRules || [])
    .map((r) => `<tr><td>${escHtmlRg(rgRuleLabel(r.type))}</td><td>${escHtmlRg(rgLastResult.nameByKey[r.targetKey] || '(unknown)')}</td></tr>`)
    .join('') || '<tr><td colspan="2" class="muted">No rules found for this mod.</td></tr>';

  const win = window.open('', '_blank', 'width=700,height=800');
  if (!win) return; // popup blocked -- nothing more we can do from here
  const safeName = escHtmlRg(oldName);
  win.document.open();
  win.document.write(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Vortex Collection Tools &mdash; Current rules for ${safeName}</title>
<script>
  var t = localStorage.getItem('theme');
  if (t === 'dark' || t === 'light') document.documentElement.setAttribute('data-theme', t);
</script>
<link rel="stylesheet" href="/styles.css">
</head>
<body style="padding: 20px;">
<h2 style="margin-top: 0;">Current rules for ${safeName}</h2>
<div class="plan-table-wrap">
<table class="plan-table">
<thead><tr><th>Rule</th><th>With</th></tr></thead>
<tbody>${rows}</tbody>
</table>
</div>
</body>
</html>`);
  win.document.close();
}

// Anomaly review row: more than one mod in the original collection could be the real link for
// this new mod -- genuinely ambiguous (unlike a remap, there's no deterministic rule to apply
// here), so this is the one case that still needs a manual pick. Collapsed/expanded exactly like
// a Ready to copy card (added 2026-07-26, so "Expand all" has real state to act on here too).
function rgRenderAnomalyItem(item) {
  const name = escHtmlRg(rgLastResult.nameByKey[item.modKey] || item.modKey);
  const groupName = `rg-anomaly-${item.modKey}`;
  const isExpanded = rgExpandedAnomalies.has(item.modKey);
  // Defaults to "???" (no pick made), NOT the first candidate -- confirmed with the user
  // 2026-07-26: unlike Ready to copy (which has a good computed default you can override), an
  // anomaly is genuinely ambiguous. Silently pre-selecting candidate 0 would be guessing on the
  // user's behalf, directly contradicting this section's own "Nothing here is guessed
  // automatically" copy. A real pick is required before this card resolves to anything but ???.
  const selected = Object.prototype.hasOwnProperty.call(rgAnomalyOverrides, item.modKey)
    ? rgAnomalyOverrides[item.modKey]
    : '';

  let bodyHtml = '';
  if (isExpanded) {
    const unsetOption = `<label class="checkbox"><input type="radio" name="${groupName}" data-mod-key="${escHtmlRg(item.modKey)}" value=""${selected === '' ? ' checked' : ''}> ???</label>`;
    const candidateOptions = item.candidates
      .map(
        (c, idx) =>
          // c.targetLabel (analyzeCollections' own disambiguateCandidateNames) wins over the plain
          // global nameByKey lookup when set -- only ever differs from the plain name when two+
          // candidates in THIS mod's own list collide on display name (confirmed real, live: two
          // genuinely different mod installs sharing one name, with no way to tell them apart in
          // this exact radio picker -- a wrong blind pick here writes a rule to the wrong mod).
          `<label class="checkbox"><input type="radio" name="${groupName}" data-mod-key="${escHtmlRg(item.modKey)}" value="${idx}"${String(idx) === selected ? ' checked' : ''}> ${escHtmlRg(c.targetLabel || rgLastResult.nameByKey[c.targetKey] || c.targetKey)} <span class="muted">(${rgRuleLabel(c.type)})</span></label>`,
      )
      .join('');
    // previousChoice (2026-08-16): you picked this before (persisted via rules-generator-anomaly-
    // memory.js), but the old collection's own rule for it has since changed type -- a normal
    // still-matching pick never reaches here at all (analyzeCollections promotes it straight to
    // mapping, no anomaly card at all), so this note only ever appears when something genuinely
    // changed since the last decision.
    const previousChoiceNote = item.previousChoice
      ? `<p class="muted">You previously picked ${escHtmlRg(rgLastResult.nameByKey[item.previousChoice.targetKey] || item.previousChoice.targetKey)} (${rgRuleLabel(item.previousChoice.type)}), but that's changed since then -- pick again below.</p>`
      : '';
    bodyHtml = `
      <div class="rg-anomaly-card__body">
        <p class="muted">More than one mod in the original collection could be the match. Which one is right?</p>
        ${previousChoiceNote}
        ${unsetOption}
        ${candidateOptions}
      </div>`;
  }

  return `
    <div class="path-row rg-ready-card" style="flex-direction: column; align-items: stretch; gap: 8px;">
      <div class="rg-ready-card__header rg-anomaly-card__header muted" data-mod-key="${escHtmlRg(item.modKey)}" style="display:flex; align-items:center; gap:10px; cursor:pointer;">
        <span>${isExpanded ? '&#9660;' : '&#9654;'}</span>
        <strong style="color: var(--text);">${name}</strong>
        <span class="muted">${item.candidateCount} possible match${item.candidateCount === 1 ? '' : 'es'}</span>
      </div>
      ${bodyHtml}
    </div>`;
}

// ---- Step 1: Relationship Check -- catches a newly-added mod that conflicts with something
// already in the collection but has never had ANY Vortex rule between them (see TECHNICAL.md's
// "Rules Generator" section and the approved mockup, design/vortex-rules-generator-relationship-
// check-mockup.html, for the full rationale). Same collapsed/expanded card shape as the anomaly
// cards above -- this is the identical "nothing guessed automatically, pick or leave ???" pattern,
// just with a richer radio value (which mod AND which direction) instead of a plain candidate
// index. ----

function rgRelationshipOptionValue(targetKey, type) {
  return `${targetKey}::${type}`;
}

// 1000+ conflicting files reads as "danger" (almost certainly the exact same asset at two
// resolutions/variants, actively fighting each other); anything smaller still matters but isn't as
// visually urgent -- matches the approved mockup's own two examples (8,089 shown as .big/danger,
// 212 shown as the plain warning color) without needing an exact cutoff from the mockup itself.
const RG_RELATIONSHIP_BIG_THRESHOLD = 1000;

// item.kind: 'missing' -- never had ANY rule (the original, filesystem-conflict-detected case);
// 'incomplete' -- a rule already exists in Vortex, but only on ONE mod's own side (found via
// analysis.incompleteLinks, no filesystem work); 'ambiguous' -- a cross-family pattern exists but its
// known sibling-pairs DISAGREE on direction (see computeFamilyInference's own safety-rule comment),
// so this is genuinely undecided, same as 'missing'. Rendered as one visual pattern (collapsed
// header + expandable radio picker) with kind-specific copy/defaults -- 'incomplete' has a single,
// already-KNOWN correct fix (not a guess); 'missing'/'ambiguous' are genuinely ambiguous and default
// to "???". ('inferred' -- a confidently auto-applied cross-family fix -- is rendered separately by
// rgRenderInferredItem below, not here; see its own header comment for why.)
function rgRenderRelationshipItem(item) {
  const name = escHtmlRg(item.name);
  const groupName = `rg-relationship-${item.modKey}`;
  const isExpanded = rgExpandedRelationships.has(item.modKey);
  const isIncomplete = item.kind === 'incomplete';
  const isAmbiguous = item.kind === 'ambiguous';
  const topCandidate = item.candidates[0];
  const isBig = !isIncomplete && (topCandidate.conflictCount || 0) >= RG_RELATIONSHIP_BIG_THRESHOLD;
  const override = rgRelationshipOverrides[item.modKey];
  const selectedValue = override ? rgRelationshipOptionValue(override.targetKey, override.type) : '';

  let bodyHtml = '';
  if (isExpanded) {
    const unsetLabel = isIncomplete ? '??? (skip this fix, leave it half-set)' : '??? (leave unresolved, decide in Vortex)';
    const unsetOption = `<label class="checkbox"><input type="radio" name="${groupName}" data-mod-key="${escHtmlRg(item.modKey)}" value=""${selectedValue === '' ? ' checked' : ''}> ${unsetLabel}</label>`;
    let candidateOptions;
    let explainer;
    if (isIncomplete) {
      // Exactly one real option -- already known with certainty, not a guess (see
      // computeIncompleteLinks' own comment) -- so only the ONE correct direction is offered, no
      // "both directions" spread like the missing/ambiguous case below.
      const c = topCandidate;
      const value = rgRelationshipOptionValue(c.targetKey, c.knownType);
      candidateOptions = `<label class="checkbox"><input type="radio" name="${groupName}" data-mod-key="${escHtmlRg(item.modKey)}" value="${escHtmlRg(value)}"${value === selectedValue ? ' checked' : ''}> ${name} <span class="muted">loads ${rgRuleLabel(c.knownType)}</span> ${escHtmlRg(c.targetName)}</label>`;
      explainer = `Vortex already has half of this relationship set (${escHtmlRg(c.targetName)} &rarr; ${rgRuleLabel(invertRgRuleType(c.knownType))} &rarr; ${name}), just not the other mod's own side. Fixing this so Vortex shows it resolved no matter which mod's rules you open.`;
    } else {
      // Both directions offered for every conflicting mod found, not just the top one -- a mod can
      // genuinely conflict with more than one other new-collection member.
      candidateOptions = item.candidates
        .flatMap((c) => {
          const targetName = escHtmlRg(c.targetName);
          return ['after', 'before'].map((type) => {
            const value = rgRelationshipOptionValue(c.targetKey, type);
            return `<label class="checkbox"><input type="radio" name="${groupName}" data-mod-key="${escHtmlRg(item.modKey)}" value="${escHtmlRg(value)}"${value === selectedValue ? ' checked' : ''}> ${name} <span class="muted">loads ${type}</span> ${targetName}</label>`;
          });
        })
        .join('');
      explainer = isAmbiguous
        ? `A pattern exists between these two mods' families, but what's already known about them disagrees on direction -- nothing here is guessed automatically, so this needs your call. ${rgRenderEvidenceList(item.evidence)}`
        : "Newly added, and it conflicts with a mod that's already in this collection.";
    }
    bodyHtml = `
      <div class="rg-anomaly-card__body">
        <p class="muted">${explainer}</p>
        ${unsetOption}
        ${candidateOptions}
      </div>`;
  }

  let headerBadge;
  if (isIncomplete) {
    headerBadge = `<span class="rg-relationship-count rg-relationship-count--fix">half-set in Vortex &mdash; fixing the other side</span>`;
  } else if (isAmbiguous) {
    headerBadge = `<span class="rg-relationship-count">pattern conflict &mdash; needs your call</span>`;
  } else {
    headerBadge = `<span class="rg-relationship-count${isBig ? ' rg-relationship-count--big' : ''}">${topCandidate.conflictCount.toLocaleString()} conflicting file${topCandidate.conflictCount === 1 ? '' : 's'} with ${escHtmlRg(topCandidate.targetName)}</span>`;
  }

  return `
    <div class="path-row rg-ready-card" style="flex-direction: column; align-items: stretch; gap: 8px;">
      <div class="rg-ready-card__header rg-anomaly-card__header muted" data-mod-key="${escHtmlRg(item.modKey)}" style="display:flex; align-items:center; gap:10px; cursor:pointer;">
        <span>${isExpanded ? '&#9660;' : '&#9654;'}</span>
        <strong style="color: var(--text);">${name}</strong>
        ${headerBadge}
      </div>
      ${bodyHtml}
    </div>`;
}

function rgRenderEvidenceList(evidence) {
  if (!evidence || !evidence.length) return '';
  const rows = evidence
    .map((e) => `${escHtmlRg(e.sourceName)} <span class="muted">${rgRuleLabel(e.type)}</span> ${escHtmlRg(e.targetName)}`)
    .join('; ');
  return `<br><span class="muted">Known pairs: ${rows}</span>`;
}

// A compound key unique per (source, target) PAIR, not just per source mod -- required for
// 'inferred' items specifically (confirmed real 2026-08-16): a single "hub" mod can have several
// DISTINCT inferred fixes against different, unrelated targets (e.g. one mod conflicting with
// several other products), which a plain modKey-keyed map can't represent -- later entries sharing
// that key silently clobbered earlier ones (only 4 of 9 real inferred fixes actually got applied
// before this fix). Used for BOTH the override-map key and the expand/collapse-state key for
// 'inferred' cards, since the SAME multi-entries-per-modKey issue applies to expand state too (two
// different inferred cards for the same source mod would otherwise expand/collapse together).
function rgPairOverrideKey(modKey, targetKey) {
  return `${modKey}::${targetKey}`;
}

// ---- 'inferred' (family-pattern inference, 2026-08-16) -- a confidently auto-applied cross-family
// fix: every known same-family pair between these two mods' families agrees on direction (see
// computeFamilyInference's own safety-rule comment for the full rationale), so this is pre-filled by
// default and written alongside the direct fixes above, NOT deferred to a manual pick. Rendered in
// its OWN section ("Inferred from patterns"), separate from the direct-fix cards -- director's own
// framing: transparent and reviewable, not a silent black-box write. Still reuses the SAME
// rgRelationshipOverrides mechanism (a checkbox to opt out, same "??? means explicitly no rule"
// semantics as every other Step 1 pick) rather than a totally separate, non-reviewable write path.
function rgRenderInferredItem(item) {
  const name = escHtmlRg(item.name);
  const c = item.candidates[0];
  const pairKey = rgPairOverrideKey(item.modKey, c.targetKey);
  const isExpanded = rgExpandedRelationships.has(pairKey);
  const override = rgRelationshipOverrides[pairKey];
  const isOptedOut = override === null;
  const value = rgRelationshipOptionValue(c.targetKey, c.knownType);

  let bodyHtml = '';
  if (isExpanded) {
    bodyHtml = `
      <div class="rg-anomaly-card__body">
        <p class="muted">Inferred from what's already known about these two mods' families -- every known same-family pair agrees ${name} loads ${rgRuleLabel(c.knownType)} ${escHtmlRg(c.targetName)}, so this fills in the missing pair the same way.${rgRenderEvidenceList(item.evidence)}</p>
        <label class="checkbox"><input type="checkbox" data-pair-key="${escHtmlRg(pairKey)}" data-mod-key="${escHtmlRg(item.modKey)}" data-target-key="${escHtmlRg(c.targetKey)}" data-inferred-value="${escHtmlRg(value)}"${isOptedOut ? '' : ' checked'}> Apply this fix (${name} <span class="muted">loads ${rgRuleLabel(c.knownType)}</span> ${escHtmlRg(c.targetName)})</label>
      </div>`;
  }

  return `
    <div class="path-row rg-ready-card" style="flex-direction: column; align-items: stretch; gap: 8px;">
      <div class="rg-ready-card__header rg-anomaly-card__header muted" data-pair-key="${escHtmlRg(pairKey)}" style="display:flex; align-items:center; gap:10px; cursor:pointer;">
        <span>${isExpanded ? '&#9660;' : '&#9654;'}</span>
        <strong style="color: var(--text);">${name}</strong>
        <span class="rg-relationship-count rg-relationship-count--fix">${isOptedOut ? 'skipped' : `loads ${rgRuleLabel(c.knownType)}`} ${escHtmlRg(c.targetName)} &mdash; inferred from pattern</span>
      </div>
      ${bodyHtml}
    </div>`;
}

function invertRgRuleType(type) {
  if (type === 'before') return 'after';
  if (type === 'after') return 'before';
  return type;
}

function rgRenderRelStatRow(result) {
  const candidates = result?.relationshipCandidates || [];
  const missingCount = candidates.filter((c) => c.kind === 'missing' || c.kind === 'ambiguous').length;
  const incompleteCount = candidates.filter((c) => c.kind === 'incomplete').length;
  const inferredCount = candidates.filter((c) => c.kind === 'inferred').length;
  const nothingNeededCount = (result?.noLinkFound.length || 0) - candidates.filter((c) => c.kind === 'missing').length;
  $rg('rgRelStatRow').innerHTML = `
    <div class="rg-rel-stat rg-rel-stat--warn"><div class="rg-rel-stat__num">${missingCount}</div><div class="rg-rel-stat__lbl">Mod${missingCount === 1 ? '' : 's'} flagged for a decision</div></div>
    <div class="rg-rel-stat rg-rel-stat--fix"><div class="rg-rel-stat__num">${incompleteCount}</div><div class="rg-rel-stat__lbl">Half-set relationship${incompleteCount === 1 ? '' : 's'} &mdash; fixing automatically</div></div>
    <div class="rg-rel-stat rg-rel-stat--fix"><div class="rg-rel-stat__num">${inferredCount}</div><div class="rg-rel-stat__lbl">Inferred from pattern${inferredCount === 1 ? '' : 's'} &mdash; fixing automatically</div></div>
    <div class="rg-rel-stat"><div class="rg-rel-stat__num">${nothingNeededCount}</div><div class="rg-rel-stat__lbl">Added with no conflict &mdash; nothing needed</div></div>`;
}

// Re-renders the relationship-check lists -- called on first analysis AND every expand/collapse
// toggle, same "rebuild this one region" approach the ready/review lists already use. Split into two
// containers: #rgRelList (missing/incomplete/ambiguous -- direct fixes, some pickable, some already
// known) and #rgRelInferredList (family-pattern inference -- its own section per the director's own
// "distinct from the direct-fix cards" spec, see rgRenderInferredItem's own header comment).
function rgRenderRelList() {
  const candidates = rgLastResult?.relationshipCandidates || [];
  const directCandidates = candidates.filter((c) => c.kind !== 'inferred');
  const inferredCandidates = candidates.filter((c) => c.kind === 'inferred');

  // 'incomplete'/'inferred' items have exactly one already-KNOWN correct fix (not a guess -- see
  // computeIncompleteLinks/computeFamilyInference) -- pre-filled here by default, same "confident
  // default, opt out via ??? instead of opt in" precedent Ready to copy already establishes elsewhere
  // on this page. Only fills a key that's genuinely never been touched (hasOwnProperty false); an
  // explicit opt-out is stored as `null` (see the change listeners below), which IS an own property,
  // so it's never silently overwritten back to the default on a later re-render (e.g. expanding
  // another card). 'incomplete' is keyed by modKey (exactly one fix per card, matches its own single-
  // radio-group UI); 'inferred' is keyed by rgPairOverrideKey (modKey::targetKey) instead -- a single
  // source mod can have SEVERAL distinct inferred fixes against different targets (confirmed real
  // 2026-08-16), which a plain modKey key can't represent without later entries clobbering earlier
  // ones. Every override value carries its own `modKey` explicitly (computeRulesToApply reads it from
  // there, not from the object's own key -- see that function's own comment).
  candidates.forEach((item) => {
    if (item.kind === 'incomplete') {
      if (Object.prototype.hasOwnProperty.call(rgRelationshipOverrides, item.modKey)) return;
      const c = item.candidates[0];
      rgRelationshipOverrides[item.modKey] = { modKey: item.modKey, targetKey: c.targetKey, type: c.knownType };
    } else if (item.kind === 'inferred') {
      const c = item.candidates[0];
      const key = rgPairOverrideKey(item.modKey, c.targetKey);
      if (Object.prototype.hasOwnProperty.call(rgRelationshipOverrides, key)) return;
      rgRelationshipOverrides[key] = { modKey: item.modKey, targetKey: c.targetKey, type: c.knownType };
    }
  });

  rgRenderRelStatRow(rgLastResult);
  $rg('rgRelWarningBanner').classList.toggle('hidden', directCandidates.length === 0);
  $rg('rgRelList').innerHTML = directCandidates.length
    ? directCandidates.map(rgRenderRelationshipItem).join('')
    : '<p class="muted">Nothing flagged here &mdash; every newly added mod either already has a rule (on both sides) or doesn\'t conflict with anything in your collection.</p>';

  $rg('rgRelInferredSection').classList.toggle('hidden', inferredCandidates.length === 0);
  $rg('rgRelInferredList').innerHTML = inferredCandidates.map(rgRenderInferredItem).join('');
}

// Flips an "Expand all" button's own label to "Collapse all" once every item it controls is
// already expanded (and back once any collapse) -- shared by both Ready to copy and Needs your
// input's buttons, called at the end of each list's own render function so it stays in sync
// whether the change came from the button itself or from toggling one card at a time.
function rgSyncExpandAllButtonLabel(buttonId, keys, expandedSet) {
  const btn = $rg(buttonId);
  if (!btn) return;
  btn.classList.toggle('hidden', keys.length === 0);
  const allExpanded = keys.length > 0 && keys.every((k) => expandedSet.has(k));
  btn.textContent = allExpanded ? 'Collapse all' : 'Expand all';
}

// Re-renders just the ready-cards list -- called on first analysis AND on every expand/collapse
// toggle, same "rebuild this one region" approach as Work Through Report's renderWtList.
function rgRenderReadyList() {
  rgCloseConflictPopover(); // its anchor element is about to be destroyed by the rebuild below
  const mapping = rgLastResult?.pendingMapping || [];
  $rg('rgReadyList').innerHTML = mapping.length
    ? mapping.map(rgRenderReadyCard).join('')
    : '<p class="muted">Nothing matched with high confidence yet.</p>';
  rgLoadConflictCounts();
  rgSyncExpandAllButtonLabel('rgExpandAllReadyBtn', mapping.map((m) => m.newModKey), rgExpandedItems);
}

// Re-renders just the anomaly cards -- mirrors rgRenderReadyList above.
function rgRenderReviewList() {
  const anomalies = rgLastResult?.anomalies || [];
  $rg('rgReviewList').innerHTML = anomalies.length
    ? anomalies.map(rgRenderAnomalyItem).join('')
    : '<p class="muted">Nothing needs your input right now.</p>';
  rgSyncExpandAllButtonLabel('rgExpandAllReviewBtn', anomalies.map((a) => a.modKey), rgExpandedAnomalies);
}

// "Nothing to do" -- lowest-priority content on the page, so it's tucked behind a collapsed
// disclosure that expands to a row of neutral, non-interactive chips instead of a full-width list
// (see DESIGN.md's "Informational name lists -- collapsed neutral chips" section). Collapsed by
// default every fresh render (a plain <details> with no `open` attribute) -- there's no saved
// expand/collapse state to restore here, unlike Ready to copy/Needs your input's own per-item
// expand tracking, since this bucket has no per-item detail to toggle into, just the one disclosure.
// resolvedMapping (2026-08-16 follow-up to 3b65986): mods that DID have a relationship to the old
// collection, but every one of their rules was already applied in an earlier Apply run -- a
// genuinely different reason to land in "nothing to do" than noLinkFound's own "no relationship at
// all". Folded into the same disclosure (director's own call -- not worth a whole separate bucket)
// but each entry keeps its own qualifying phrase ("already fully set up (copied from X)", matching
// the Report tab's own wording for the identical case) so the two reasons stay distinguishable.
function rgRenderNoLinkBody(noLinkFound, resolvedMapping, nameByKey) {
  const body = $rg('rgNoLinkBody');
  const totalCount = noLinkFound.length + resolvedMapping.length;
  if (!totalCount) {
    body.innerHTML = '<p class="muted">Everything in the new collection was matched or needs review above.</p>';
    return;
  }
  // A mod with a pending Step 1 (Relationship Check) pick is still sitting in this same noLinkFound
  // bucket (nothing server-side moves it out until a real Apply+re-analyze happens), so it needs its
  // own visual note here -- otherwise it's indistinguishable from a mod with genuinely nothing
  // needed, which is exactly what made a real pick read as "did this even do anything?" (confirmed
  // live 2026-08-16). Re-rendered live on every Step 1 pick change (see the rgRelList change
  // listener below), not just on a fresh analysis, so this stays accurate as the user picks/un-picks
  // without needing to leave and come back to this step.
  const noLinkChips = noLinkFound
    .map((n) => {
      const pick = rgRelationshipOverrides[n.modKey];
      if (!pick) return `<span class="chip">${escHtmlRg(nameByKey[n.modKey] || n.modKey)}</span>`;
      const targetName = escHtmlRg(nameByKey[pick.targetKey] || pick.targetKey);
      return `<span class="chip chip--pending" title="Will be set once you click Continue to Report, then Apply to Vortex">${escHtmlRg(nameByKey[n.modKey] || n.modKey)} &mdash; will set: ${rgRuleLabel(pick.type)} ${targetName}</span>`;
    })
    .join('');
  const resolvedChips = resolvedMapping
    .map((m) => {
      const newName = escHtmlRg(nameByKey[m.newModKey] || m.newModKey);
      const oldName = escHtmlRg(nameByKey[m.oldModKey] || m.oldModKey);
      return `<span class="chip" title="Every rule from ${oldName} is already set on ${newName} in Vortex">${newName} &mdash; already fully set up</span>`;
    })
    .join('');
  body.innerHTML = `
    <details class="chip-list-details">
      <summary><span class="chip-list-details__caret">▸</span> <span class="chip-list-details__count">${totalCount}</span> mod${totalCount === 1 ? '' : 's'} with nothing left to do &mdash; show them</summary>
      <div class="chip-list-details__body">
        <p class="muted">Either added with no relationship to anything in the original collection, or already have every rule copied over &mdash; nothing left to do for either.</p>
        <div class="chip-row">${noLinkChips}${resolvedChips}</div>
      </div>
    </details>`;
}

// ---- Step 3: Exceptions (2026-08-17) -- see design/vortex-rules-generator-relationship-check-
// mockup.html's own #screenExceptions (approved) for the full visual spec, and computeSkipExceptions
// (lib/rules-generator.js) for where this data comes from. Wording for the 3 informational sections
// matches the separate Report tab's own established copy (reports-rulesgen-app.js), per the task's
// own explicit instruction -- not the mockup's own placeholder demo text.
//
// The 3 informational sections render as collapsed <details> chip disclosures (rgRenderNoLinkBody's
// own established pattern, just above) rather than the mockup's own always-visible dimmed rows -- a
// deliberate deviation, flagged in the handoff: a real collection can carry 8-10+ items per category
// here, which would be a lot of un-collapsed visual noise for content with zero action attached. ----

function rgRenderExceptionChipDetails(bodyId, count, chipsHtml, noun) {
  const body = $rg(bodyId);
  if (!count) {
    body.innerHTML = '<p class="muted">Nothing here right now.</p>';
    return;
  }
  body.innerHTML = `
    <details class="chip-list-details">
      <summary><span class="chip-list-details__caret">▸</span> <span class="chip-list-details__count">${count}</span> ${noun}${count === 1 ? '' : 's'} &mdash; show them</summary>
      <div class="chip-list-details__body"><div class="chip-row">${chipsHtml}</div></div>
    </details>`;
}

function rgRenderExceptionCard(m) {
  const isExpanded = rgExpandedExceptions.has(m.modKey);
  const pick = Object.prototype.hasOwnProperty.call(rgExceptionPicks, m.modKey) ? rgExceptionPicks[m.modKey] : 'keep';
  const groupName = `rg-exc-${m.modKey}`;
  const targetsSummary = m.skips.map((s) => s.targetName).join(', ');

  let bodyHtml = '';
  if (isExpanded) {
    const detailRows = m.skips
      .map((s) => `<p class="muted">The old collection had this set to <strong>${rgRuleLabel(s.intendedType)}</strong> ${escHtmlRg(s.targetName)} &mdash; but this mod already has its own rule saying <strong>${rgRuleLabel(s.currentType)}</strong>. Nothing was changed for you automatically.</p>`)
      .join('');
    bodyHtml = `
      <div class="rg-anomaly-card__body">
        ${detailRows}
        <label class="checkbox"><input type="radio" name="${groupName}" data-mod-key="${escHtmlRg(m.modKey)}" value="keep"${pick === 'keep' ? ' checked' : ''}> Keep what's set now</label>
        <label class="checkbox"><input type="radio" name="${groupName}" data-mod-key="${escHtmlRg(m.modKey)}" value="switch"${pick === 'switch' ? ' checked' : ''}> Switch to match the old collection</label>
      </div>`;
  }

  return `
    <div class="path-row rg-ready-card" style="flex-direction: column; align-items: stretch; gap: 8px;">
      <div class="rg-ready-card__header rg-anomaly-card__header muted" data-mod-key="${escHtmlRg(m.modKey)}" style="display:flex; align-items:center; gap:10px; cursor:pointer;">
        <span>${isExpanded ? '&#9660;' : '&#9654;'}</span>
        <strong style="color: var(--text);">${escHtmlRg(m.modName)}</strong>
        <span class="muted">vs. ${escHtmlRg(targetsSummary)}</span>
      </div>
      ${bodyHtml}
    </div>`;
}

// Returns true if Step 3 has ANY content at all -- used by rgConfirmApply to decide whether to
// auto-navigate here after a real Apply (see its own comment; a genuinely empty Step 3 is never
// auto-landed on, same "don't show an empty step" instinct Step 1's own auto-skip already follows).
function rgRenderExceptionsStep(exceptions) {
  rgLastExceptions = exceptions;
  Object.keys(rgExceptionPicks).forEach((k) => delete rgExceptionPicks[k]); // fresh data -- no stale picks from a previous mod list
  rgExpandedExceptions.clear();

  const needsDecisionCount = exceptions.skippedAlreadySet.reduce((sum, m) => sum + m.skips.length, 0);
  const oldVersionCount = exceptions.leftoverOldInstalls.length;
  const disabledCount = exceptions.skippedDisabled.reduce((sum, m) => sum + m.skips.length, 0);
  const noConflictCount = exceptions.skippedNoConflict.reduce((sum, m) => sum + m.skips.length, 0);
  const totalCount = needsDecisionCount + oldVersionCount + disabledCount + noConflictCount;

  $rg('rgExcCalloutTitle').textContent = `⚠️ ${needsDecisionCount} rule${needsDecisionCount === 1 ? "" : "s"} didn't carry over cleanly`;

  $rg('rgExcStatRow').innerHTML = `
    <div class="rg-rel-stat rg-rel-stat--warn"><div class="rg-rel-stat__num">${needsDecisionCount}</div><div class="rg-rel-stat__lbl">Need a decision</div></div>
    <div class="rg-rel-stat"><div class="rg-rel-stat__num">${oldVersionCount}</div><div class="rg-rel-stat__lbl">Old version still installed &mdash; no action needed</div></div>`;

  $rg('rgExcDecisionLabel').classList.toggle('hidden', exceptions.skippedAlreadySet.length === 0);
  $rg('rgExcDecisionList').innerHTML = exceptions.skippedAlreadySet.length
    ? exceptions.skippedAlreadySet.map(rgRenderExceptionCard).join('')
    : '<p class="muted">Nothing here &mdash; everything carried over cleanly.</p>';

  // Old version still installed -- same wording reports-rulesgen-app.js's own leftoverOldInstalls
  // row already uses.
  $rg('rgExcOldVersionSection').classList.toggle('hidden', oldVersionCount === 0);
  rgRenderExceptionChipDetails(
    'rgExcOldVersionBody',
    oldVersionCount,
    exceptions.leftoverOldInstalls
      .map((l) => `<span class="chip" title="the older version (${escHtmlRg(l.oldModName)}) is still installed">${escHtmlRg(l.newCounterpartName)} &mdash; the older version (${escHtmlRg(l.oldModName)}) is still installed</span>`)
      .join(''),
    'mod',
  );

  // Disabled mods -- same wording reports-rulesgen-app.js's own skippedDisabled row already uses.
  $rg('rgExcDisabledSection').classList.toggle('hidden', disabledCount === 0);
  rgRenderExceptionChipDetails(
    'rgExcDisabledBody',
    disabledCount,
    exceptions.skippedDisabled
      .flatMap((m) => m.skips.map((s) => `<span class="chip">${escHtmlRg(m.modName)} &mdash; should be ${rgRuleLabel(s.type)} ${escHtmlRg(s.targetName)}, but that mod is disabled in Vortex</span>`))
      .join(''),
    'rule',
  );

  // No current conflict -- same wording reports-rulesgen-app.js's own skippedNoConflict row already uses.
  $rg('rgExcNoConflictSection').classList.toggle('hidden', noConflictCount === 0);
  rgRenderExceptionChipDetails(
    'rgExcNoConflictBody',
    noConflictCount,
    exceptions.skippedNoConflict
      .flatMap((m) => m.skips.map((s) => `<span class="chip">${escHtmlRg(m.modName)} &mdash; should be ${rgRuleLabel(s.type)} ${escHtmlRg(s.targetName)}, but they don't currently share any files</span>`))
      .join(''),
    'rule',
  );

  return totalCount > 0;
}

// Rebuilds the 3 summary badges + "Show all", reflecting rgSectionFilter's current value, then
// shows/hides the 3 section containers to match -- called on every fresh analysis AND every filter
// toggle (the badges' own active/inactive styling needs to update either way). Wording/case here
// must match each section's own header exactly (Ready to copy / Needs your input / Nothing to do)
// -- confirmed live 2026-07-26 these had silently drifted (lowercase, and "need" instead of "Needs").
function rgRenderSummaryBadges() {
  const result = rgLastResult;
  const badgeHtml = (section, cls, count, label) => {
    const active = rgSectionFilter.has(section);
    return `<span class="badge ${cls} badge--clickable${active ? ' badge--filter-active' : ''}" data-section="${section}"><span class="badge__count">${count}</span> ${label}</span>`;
  };
  // "Ready to copy" is omitted entirely once rgApplyCompleted -- its count is stale the moment
  // Apply finishes (everything it lists is already copied, so "N Ready to copy" reads as "N things
  // still waiting" when really nothing is). The other two badges stay -- see rgApplyCompleted's own
  // comment for why they're still accurate post-Apply.
  // "Nothing to do" now counts noLinkFound (no relationship at all) PLUS resolvedMapping (had a
  // relationship, every rule already applied) -- both bucket lands land the mod in the same
  // "nothing left to do" section below, see rgRenderNoLinkBody.
  const nothingToDoCount = result.noLinkFound.length + (result.resolvedMapping?.length || 0);
  $rg('rgSummaryBadges').innerHTML = [
    rgApplyCompleted ? '' : badgeHtml('ready', 'badge--success', (result.pendingMapping || result.mapping).length, 'Ready to copy'),
    badgeHtml('review', 'badge--warning', result.anomalies.length, 'Needs your input'),
    badgeHtml('nolink', 'badge--neutral', nothingToDoCount, 'Nothing to do'),
    `<span class="badge badge--show-all${rgSectionFilter.size === 0 ? ' badge--filter-active' : ''}">Show all</span>`,
  ].join('');
  for (const [section, id] of Object.entries(RG_SECTION_IDS)) {
    $rg(id).classList.toggle('hidden', rgSectionFilter.size > 0 && !rgSectionFilter.has(section));
  }
}

function rgRender(result) {
  rgLastResult = result;
  // Flat name lookup by modKey across everything the analysis touched, so every render helper
  // above can just look a name up instead of threading full entries around.
  const nameByKey = {};
  result.oldMembers.forEach((m) => { nameByKey[m.modKey] = m.name; });
  result.newMembers.forEach((m) => { nameByKey[m.modKey] = m.name; });
  result.mapping.forEach((m) => {
    m.rulesToConsider.forEach((r) => {
      if (r.targetKey && !nameByKey[r.targetKey]) nameByKey[r.targetKey] = r.targetKey;
      if (r.originalTargetKey && !nameByKey[r.originalTargetKey]) nameByKey[r.originalTargetKey] = r.originalTargetKey;
    });
  });
  rgLastResult.nameByKey = nameByKey;
  rgLastResult.oldMembersLookup = result.oldMembers;
  rgLastResult.newMembersLookup = result.newMembers;

  // 2026-08-16 follow-up to 3b65986: the analyze worker already filters each mapping entry's own
  // rulesToConsider down to genuinely-still-pending rules (lib/rules-generator-worker.js's 'analyze'
  // mode, via filterMappingToPending) -- but this screen was still bucketing/counting the raw,
  // already-filtered mapping array as if every entry still had work to do. A mod whose
  // rulesToConsider comes back EMPTY had every one of its rules already applied in an earlier Apply
  // run (confirmed live: 9 of 10 "Ready to copy" rows read "0 rules" for a pair the director had
  // already fully applied) -- split those out here so "Ready to copy" only ever shows mods with
  // real remaining work. A mod whose rulesToConsider is non-empty but entirely 'unresolved' status
  // (no counterpart could be found at all) is intentionally NOT included in resolvedMapping -- that's
  // a different, pre-existing "couldn't be matched" state, unrelated to this fix, and keeps showing
  // under Ready to copy exactly as it always has.
  const pendingMapping = result.mapping.filter((m) => m.rulesToConsider.length > 0);
  const resolvedMapping = result.mapping.filter((m) => m.rulesToConsider.length === 0);
  rgLastResult.pendingMapping = pendingMapping;
  rgLastResult.resolvedMapping = resolvedMapping;

  rgSectionFilter.clear(); // fresh analysis -- always start showing all three sections
  rgRenderSummaryBadges();

  // Hidden entirely once rgApplyCompleted (see its own comment) -- re-clicking right after a real
  // Apply reads as a confusing no-op even though it's technically harmless. Disabled (not just
  // relying on the existing click-time preview check, which already catches this safely -- see
  // rgOpenApplyConfirm's totalRulesWritten===0 message) confirmed 2026-07-27: a clearly-disabled
  // button is a better signal than letting someone click it and read a message explaining nothing
  // happened. 0 ready + 0 needing input means there is nothing this button could possibly do right
  // now. Uses pendingMapping (not the raw result.mapping) for the same reason the badge below does.
  $rg('rgApplyBtn').classList.toggle('hidden', rgApplyCompleted);
  $rg('rgApplyBtn').disabled = pendingMapping.length === 0 && result.anomalies.length === 0;

  rgRenderReadyList();
  rgRenderReviewList();

  rgRenderNoLinkBody(result.noLinkFound, resolvedMapping, nameByKey);

  // Step 1's own content -- rgResults' (Step 2) visibility is now controlled by rgGoToStep below,
  // not directly here, since the two screens share one stepper.
  rgRenderRelList();
}

// landStep: which step to land on once the fresh analysis renders -- 0 (Relationship Check, the
// default) for a genuinely fresh "Find matching rules" click, 1 (straight to Report) for the
// re-analyze rgConfirmApply runs after a successful Apply -- being bounced back to Step 1 every
// time after iterating on more fixes would be annoying, and there's nothing new to re-check there
// that a fresh Scan-equivalent already didn't just resolve.
// Real SSE-streamed progress (2026-08-25) -- POST /analyze now only starts the real comparison, then
// returns as soon as it's genuinely running server-side; GET /analyze/events streams a live tick
// every second while it's in flight (rules-generator-routes.js's own tickingPhase) plus the final
// 'done' event carrying the exact same result shape this function used to get back directly. No real
// per-item count exists here (a single opaque helperClient/isolated-worker call, see that file's own
// comment), so rgLoading's text ticks with real elapsed time instead of a percentage -- still a real,
// live signal, not a frozen spinner.
let rgAnalyzeEventSource = null;

function rgFinishAnalyzeStream() {
  if (rgAnalyzeEventSource) { rgAnalyzeEventSource.close(); rgAnalyzeEventSource = null; }
  $rg('rgLoading').classList.add('hidden');
  rgUpdateAnalyzeButton();
}

function rgRenderAnalyzeResult(result, landStep) {
  rgApplyCompleted = false; // a genuine fresh analysis -- clears any stale Complete state from a previous Apply
  $rg('rgApplyDoneInfo').classList.add('hidden');
  $rg('rgExcSaveDoneInfo').classList.add('hidden');
  rgRender(result);
  // Step 3's own content, populated so it's reachable via the stepper pill even on a plain scan
  // (e.g. mismatches that already existed in Vortex from an earlier manual edit, independent of
  // whether Apply gets clicked again this session) -- but landing there automatically only ever
  // happens right after a real Apply (see rgConfirmApply's own comment), never here.
  if (result.exceptions) rgRenderExceptionsStep(result.exceptions);
  $rg('rgStepper').classList.remove('hidden');

  // Auto-skip Step 1 if IT has nothing actionable -- gated ONLY on Step 1's own "flagged for a
  // decision" stat (relationshipCandidates missing/ambiguous, the same count rgRenderRelStatRow
  // shows as its first box), NOT on result.anomalies/result.mapping -- those are Step 2's (the
  // Report's) own "Needs your input"/"Ready to copy" badges and can be non-zero for reasons that
  // have nothing to do with Step 1's screen (confirmed live 2026-08-16: a real repro landed on
  // Step 1 with all four of ITS OWN stats reading 0/0/0/6, but was blocked from skipping because
  // the Report tab had unrelated ready-to-copy/anomaly content). incomplete/inferred candidates
  // don't block the skip either -- they're auto-fixed, not a user decision (see rgRenderRelStatRow).
  let stepToShow = landStep;
  // All-clear banner (2026-08-17): a genuinely clean FIRST scan -- Step 1 has nothing flagged
  // (the same missingCount the auto-skip above already computes) AND Step 2 has nothing pending
  // to copy (pendingMapping, from the zero-rule-bucketing fix -- rgRender already computed this
  // onto result) and nothing needing a pick (anomalies). Scoped to landStep === 0 alongside the
  // auto-skip itself, for the same reason: a post-Apply re-analyze (landStep === 1) isn't a "first
  // scan" and gets rgApplyDoneInfo's own completion banner instead, never this one. Also never
  // shown if the user had to actually resolve anything on Step 1 first -- this is a property of
  // the FRESH, unedited result, not "everything's fine now that you fixed it".
  let isFullyClean = false;
  if (landStep === 0) { // only auto-skip for a fresh analysis, not when re-analyzing after Apply
    const relationshipCandidates = result.relationshipCandidates || [];
    const missingCount = relationshipCandidates.filter((c) => c.kind === 'missing' || c.kind === 'ambiguous').length;

    if (missingCount === 0) {
      stepToShow = 1; // nothing requires a user decision on Step 1 -- skip to Report
    }
    isFullyClean = missingCount === 0 && result.pendingMapping.length === 0 && result.anomalies.length === 0;
  }
  $rg('rgAllClearBanner').classList.toggle('hidden', !isFullyClean);
  rgGoToStep(stepToShow);
}

function rgHandleAnalyzeEvent(frame, landStep) {
  if (frame.type === 'phase') {
    $rg('rgLoading').lastChild.textContent = ` ${frame.message}${frame.seconds ? ` (${frame.seconds}s)` : ''}`;
  } else if (frame.type === 'done') {
    rgFinishAnalyzeStream();
    rgRenderAnalyzeResult(frame, landStep);
  } else if (frame.type === 'error') {
    rgFinishAnalyzeStream();
    if (frame.errorCode === 'vortex-running') {
      window.showVortexRunningModal(() => rgAnalyze(landStep));
    } else {
      rgHandleError(new Error(frame.message || 'The analysis failed.'), () => rgAnalyze(landStep));
    }
  }
}

async function rgAnalyze(landStep = 0) {
  rgHideCriticalError();
  $rg('rgStepper').classList.add('hidden');
  $rg('rgScreenRelCheck').classList.add('hidden');
  $rg('rgResults').classList.add('hidden');
  $rg('rgScreenExceptions').classList.add('hidden');
  $rg('rgLoading').lastChild.textContent = " Reading Vortex's database…";
  $rg('rgLoading').classList.remove('hidden');
  $rg('rgAnalyzeBtn').disabled = true;
  try {
    await rgApi('POST', '/api/rules-generator/analyze', {
      oldCollectionKey: $rg('rgOldCollectionSelect').value,
      newCollectionKey: $rg('rgNewCollectionSelect').value,
    });
  } catch (e) {
    $rg('rgLoading').classList.add('hidden');
    rgUpdateAnalyzeButton();
    rgHandleError(e, () => rgAnalyze(landStep));
    return;
  }
  if (rgAnalyzeEventSource) rgAnalyzeEventSource.close();
  const es = new EventSource('/api/rules-generator/analyze/events');
  rgAnalyzeEventSource = es;
  es.onmessage = (msg) => rgHandleAnalyzeEvent(JSON.parse(msg.data), landStep);
}

// ---- Apply to Vortex -- writes the currently-reviewed rules (Ready to copy + any resolved
// anomaly) directly onto the new collection's mods in Vortex's live database. See TECHNICAL.md's
// "Vortex's real rule-write mechanism" section for exactly what gets written and why. Always
// re-derives everything fresh server-side from rgRuleOverrides/rgAnomalyOverrides -- this page's
// own computed rulesToConsider is never trusted for anything that touches the filesystem. ----

function rgApplyRequestBody() {
  return {
    oldCollectionKey: $rg('rgOldCollectionSelect').value,
    newCollectionKey: $rg('rgNewCollectionSelect').value,
    ruleOverrides: rgRuleOverrides,
    anomalyOverrides: rgAnomalyOverrides,
    relationshipOverrides: rgRelationshipOverrides,
  };
}

// Which flow is currently showing the SHARED confirm modal -- 'apply' (Step 2's real "Apply to
// Vortex", the only one that should mark rgApplyCompleted) or 'step1' (Continue to Report's own
// scoped write). rgConfirmApply is reused verbatim by both (see its own header comment), so this is
// the only way it can tell them apart -- without it, Step 1's own write would incorrectly hide Step
// 2's "Apply to Vortex" button and "Ready to copy" badge even though the real Ready-to-copy/Needs-
// your-input work hasn't been touched yet.
let rgApplyConfirmSource = 'apply';

async function rgOpenApplyConfirm() {
  rgHideCriticalError();
  rgApplyConfirmSource = 'apply';
  $rg('rgApplyDoneInfo').classList.add('hidden');
  const btn = $rg('rgApplyBtn');
  const statusEl = $rg('rgApplyStatus');
  btn.disabled = true;
  statusEl.textContent = 'Checking what would change…';
  try {
    const preview = await rgApi('POST', '/api/rules-generator/apply-preview', rgApplyRequestBody());
    statusEl.textContent = '';
    if (preview.totalRulesWritten === 0) {
      statusEl.textContent = 'Nothing to apply right now -- everything is already resolved in Vortex, or still needs your input above.';
      return;
    }
    // Serious register (TECHNICAL-FRIENDLY-VOICE-GUIDELINES.md), not the casual default -- this
    // writes directly to Vortex's database, the exact case that register exists for.
    $rg('rgApplyConfirmModalText').textContent =
      `This writes ${preview.totalRulesWritten} rule(s) across ${preview.totalModsChanged} mod(s) directly to Vortex's database. A full backup is taken first.`;
    $rg('rgApplyConfirmModal').classList.remove('hidden');
  } catch (e) {
    rgHandleError(e, rgOpenApplyConfirm);
  } finally {
    btn.disabled = false;
  }
}

// ---- Step 1's own "Continue to Report" -- writes whatever's currently picked (both genuinely-new
// relationships AND incomplete-link auto-fixes) BEFORE showing Step 2, then re-analyzes fresh, so
// Step 2 reflects reality rather than a stale pre-pick snapshot. Director's own framing, confirmed
// live 2026-08-16: "the same as if they went into Vortex first, did this, and then came back to the
// tool to copy the rules between the two collections" -- i.e. Step 1 is a REAL, immediate write, not
// a staged pick deferred to the final Apply (unlike ruleOverrides/anomalyOverrides, which only exist
// once Step 2 is visible and are still deferred to the final "Apply to Vortex" button as before).
// Reuses rgConfirmApply as-is for the actual write+clear+re-analyze -- at this point rgRuleOverrides/
// rgAnomalyOverrides are always still empty (Step 2 hasn't been seen yet), so applying "everything
// currently staged" is exactly "just the relationship picks", no separate write path needed. ----
async function rgContinueToReport() {
  rgHideCriticalError();
  rgApplyConfirmSource = 'step1';
  const hasAnyPick = Object.values(rgRelationshipOverrides).some((v) => v);
  if (!hasAnyPick) {
    rgGoToStep(1); // nothing picked (or everything left at ??? / skipped) -- just move on, same as Skip
    return;
  }
  const btn = $rg('rgRelContinueBtn');
  btn.disabled = true;
  try {
    const preview = await rgApi('POST', '/api/rules-generator/apply-preview', rgApplyRequestBody());
    if (preview.totalRulesWritten === 0) {
      // Every pick turned out to already be resolved (idempotent no-op, e.g. re-visiting Step 1
      // after an earlier write) -- nothing to confirm, just move on rather than showing a "nothing
      // to apply" message that would make sense on Step 2 but reads as a dead end here.
      rgGoToStep(1);
      return;
    }
    $rg('rgApplyConfirmModalText').textContent =
      `This writes ${preview.totalRulesWritten} rule(s) across ${preview.totalModsChanged} mod(s) directly to Vortex's database, fixing the relationship(s) above. A full backup is taken first.`;
    $rg('rgApplyConfirmModal').classList.remove('hidden');
  } catch (e) {
    rgHandleError(e, rgContinueToReport);
  } finally {
    btn.disabled = false;
  }
}

// Real SSE-streamed progress (2026-08-25) -- same ticking-phase shape as rgAnalyze above (POST
// /apply now only starts the real write, GET /apply/events streams a live elapsed-time tick plus the
// final 'done' event carrying exactly the same result shape this function used to get back
// directly). Shared verbatim by both rgApplyConfirmSource cases (Step 1's own scoped write and Step
// 2's real "Apply to Vortex"), same as before this task.
let rgApplyEventSource = null;

function rgFinishApplyStream() {
  if (rgApplyEventSource) { rgApplyEventSource.close(); rgApplyEventSource = null; }
}

async function rgHandleApplyDone(result) {
  const statusEl = $rg('rgApplyStatus');
  statusEl.textContent = '';
  $rg('rgApplyDoneText').textContent =
    `${result.totalRulesWritten} rule(s) written across ${result.totalModsChanged} mod(s).`;
  $rg('rgApplyDoneInfo').classList.remove('hidden');
  // The overrides that were just applied no longer describe anything meaningful -- rendering
  // result.freshAnalysis below re-derives current state from scratch (rules just written now show
  // up as already-resolved, so those mods naturally drop out of Ready to copy / Needs your input).
  Object.keys(rgRuleOverrides).forEach((k) => delete rgRuleOverrides[k]);
  Object.keys(rgAnomalyOverrides).forEach((k) => delete rgAnomalyOverrides[k]);
  Object.keys(rgRelationshipOverrides).forEach((k) => delete rgRelationshipOverrides[k]);
  // Only the real Step 2 Apply marks the "Ready to copy"/Apply-button-stale Complete state --
  // Step 1's own scoped write (rgApplyConfirmSource === 'step1') still has real Ready-to-copy/
  // Needs-your-input work pending that this write never touched. See rgApplyConfirmSource's own
  // comment.
  if (rgApplyConfirmSource === 'apply') rgApplyCompleted = true;
  if (result.freshAnalysis) {
    // Use the server's own just-written, in-memory-patched analysis directly -- NOT a fresh
    // /analyze call. Confirmed real 2026-08-16: a separate /analyze right after a real write reads
    // through withStateDb, which can legitimately show stale, pre-write data for an unbounded time
    // (LevelDB doesn't flush the WAL to compacted SST files on close -- see vortex-sync/lib.js's
    // own "Staleness" comment). result.freshAnalysis carries zero staleness risk by construction.
    rgRender(result.freshAnalysis);
    $rg('rgStepper').classList.remove('hidden');
    // Step 3 (Exceptions) -- refreshed regardless of source (harmless, keeps it accurate if the
    // user navigates there manually either way), but auto-NAVIGATION only ever happens for the
    // real Step 2 "Apply to Vortex" write (rgApplyConfirmSource === 'apply'), never Step 1's own
    // scoped relationship-pick write -- that write only ever touches brand-new relationships, never
    // the already-set-differently/disabled/no-conflict cases Step 3 covers, so there's no reason a
    // Step 1 write would newly reveal Step 3 content. Same "this only makes sense to check AFTER
    // the real Apply has run" reasoning the task itself specifies, mirroring Step 1's own auto-skip
    // gate shape (rgAnalyze's landStep === 0 check) just applied to a different trigger moment.
    const hasExceptions = result.freshExceptions ? rgRenderExceptionsStep(result.freshExceptions) : false;
    if (rgApplyConfirmSource === 'apply' && hasExceptions) {
      rgGoToStep(2); // something needs a second look -- straight to Exceptions
    } else {
      rgGoToStep(1); // straight back to Report -- see rgAnalyze's own comment on why
    }
  } else {
    await rgAnalyze(1); // defensive fallback -- should never trigger against a current server
  }
}

function rgHandleApplyEvent(frame) {
  if (frame.type === 'phase') {
    $rg('rgApplyStatus').textContent = `${frame.message}${frame.seconds ? ` (${frame.seconds}s)` : ''}`;
  } else if (frame.type === 'done') {
    rgFinishApplyStream();
    rgHandleApplyDone(frame);
  } else if (frame.type === 'error') {
    rgFinishApplyStream();
    $rg('rgApplyStatus').textContent = '';
    if (frame.errorCode === 'vortex-running') {
      window.showVortexRunningModal(rgConfirmApply);
    } else {
      rgHandleError(new Error(frame.message || 'The write failed.'), rgConfirmApply);
    }
  }
}

async function rgConfirmApply() {
  $rg('rgApplyConfirmModal').classList.add('hidden');
  const statusEl = $rg('rgApplyStatus');
  statusEl.textContent = "Writing to Vortex's database…";
  try {
    await rgApi('POST', '/api/rules-generator/apply', rgApplyRequestBody());
  } catch (e) {
    statusEl.textContent = '';
    rgHandleError(e, rgConfirmApply);
    return;
  }
  if (rgApplyEventSource) rgApplyEventSource.close();
  const es = new EventSource('/api/rules-generator/apply/events');
  rgApplyEventSource = es;
  es.onmessage = (msg) => rgHandleApplyEvent(JSON.parse(msg.data));
}

// ---- Step 3 (Exceptions)'s own writes -- "Save my picks" (per-mod, only the mods actually flipped
// to "Switch") and "Switch all to match the old collection" (bulk, every current skippedAlreadySet
// mod). Both share the same preview -> serious-register confirm -> write flow every other real write
// in this app already follows (rgOpenApplyConfirm/rgConfirmApply above), and the SAME confirm modal
// shape (#rgExcConfirmModal mirrors #rgApplyConfirmModal exactly). switchModKeys is the only
// client-supplied input -- the server always re-derives the actual skip details fresh (see
// switchSkippedRules' own header comment), matching this app's own established principle. ----

// Which action the shared confirm modal is currently gating -- 'save' (rgExcSaveBtn) or 'switchAll'
// (rgExcSwitchAllBtn) -- so rgExcConfirmSwitch knows which modKeys to actually send once confirmed.
let rgExcPendingSwitchModKeys = [];

function rgExcSwitchModKeysFor(mode) {
  if (mode === 'switchAll') return (rgLastExceptions?.skippedAlreadySet || []).map((m) => m.modKey);
  return Object.keys(rgExceptionPicks).filter((k) => rgExceptionPicks[k] === 'switch');
}

async function rgExcOpenConfirm(mode) {
  rgHideCriticalError();
  const switchModKeys = rgExcSwitchModKeysFor(mode);
  const statusEl = $rg('rgExcSaveStatus');
  if (switchModKeys.length === 0) {
    // "Save" with nothing picked to switch is a genuine no-op -- everything stayed at "Keep what's
    // set now", so there's nothing to write. Skip the round-trip entirely, same "nothing to do here"
    // short-circuit rgOpenApplyConfirm's own totalRulesWritten===0 check establishes, just caught
    // client-side since there's no need to even ask the server.
    statusEl.textContent = mode === 'switchAll'
      ? 'Nothing to switch right now.'
      : "Nothing to save -- everything's still set to \"Keep what's set now.\"";
    return;
  }
  const btn = mode === 'switchAll' ? $rg('rgExcSwitchAllBtn') : $rg('rgExcSaveBtn');
  btn.disabled = true;
  statusEl.textContent = 'Checking what would change…';
  try {
    const preview = await rgApi('POST', '/api/rules-generator/switch-skipped-preview', {
      oldCollectionKey: $rg('rgOldCollectionSelect').value,
      newCollectionKey: $rg('rgNewCollectionSelect').value,
      anomalyOverrides: rgAnomalyOverrides,
      switchModKeys,
    });
    statusEl.textContent = '';
    if (preview.totalRulesToSwitch === 0) {
      statusEl.textContent = 'Nothing to switch right now -- it may have already changed since this page loaded.';
      return;
    }
    rgExcPendingSwitchModKeys = switchModKeys;
    // Serious register (TECHNICAL-FRIENDLY-VOICE-GUIDELINES.md), not the casual default -- this
    // writes directly to Vortex's database, the exact case that register exists for, same as
    // rgOpenApplyConfirm's own confirm text.
    $rg('rgExcConfirmModalText').textContent =
      `This writes ${preview.totalRulesToSwitch} rule(s) across ${preview.totalModsAffected} mod(s) directly to Vortex's database, matching the old collection. A full backup is taken first.`;
    $rg('rgExcConfirmModal').classList.remove('hidden');
  } catch (e) {
    rgHandleError(e, () => rgExcOpenConfirm(mode));
  } finally {
    btn.disabled = false;
  }
}

async function rgExcConfirmSwitch() {
  $rg('rgExcConfirmModal').classList.add('hidden');
  const statusEl = $rg('rgExcSaveStatus');
  statusEl.textContent = "Writing to Vortex's database…";
  try {
    const result = await rgApi('POST', '/api/rules-generator/switch-skipped', {
      oldCollectionKey: $rg('rgOldCollectionSelect').value,
      newCollectionKey: $rg('rgNewCollectionSelect').value,
      anomalyOverrides: rgAnomalyOverrides,
      switchModKeys: rgExcPendingSwitchModKeys,
    });
    statusEl.textContent = '';
    $rg('rgExcSaveDoneText').textContent =
      `${result.totalRulesChanged} rule(s) changed across ${result.totalModsChanged} mod(s).`;
    $rg('rgExcSaveDoneInfo').classList.remove('hidden');
    if (result.freshExceptions) rgRenderExceptionsStep(result.freshExceptions);
  } catch (e) {
    rgHandleError(e, rgExcConfirmSwitch);
  }
}

// Exposed for shell.js's navigateToArea/jumpArea handling -- same "deliberate seam, function
// defined by a later-loaded script" technique sync-app.js's own window.loadSyncProfiles already
// uses for the identical reason (see that file's own boot() comment, 2026-07-27): rgLoadPickers
// touches Vortex's live state (workshop-collections needs Vortex closed), so it must NEVER run
// unconditionally on page load regardless of which area is actually visible -- confirmed real
// 2026-08-15 (queue: rules-generator-eager-load-collision) that it was doing exactly that, and the
// shared "Vortex is running" modal has only ONE retry slot: whichever page's own vortex-gated call
// happened to register last silently stole every OTHER page's own Try Again click, retrying the
// wrong thing with no visible error. Called fresh every time this area is actually visited (no
// once-guard), same "re-check every visit" precedent as Missing Masters/Mod Scrub/Update
// Collection's own profile dropdown -- rgLoadPickers is already safe to call more than once (see
// its own header comment on resetting both selects first).
window.rgLoadPickers = rgLoadPickers;

// Same "fires once each time arriving from a DIFFERENT area" reset pattern (2026-08-27,
// merge-entry-reset) -- resets rgStep/rgLastResult/rgLastExceptions/rgExceptionPicks/
// rgApplyCompleted/rgSectionFilter back to their defaults, then re-fetches the collections
// pickers fresh via rgLoadPickers (same as shell.js's existing navigation call, just with the
// state reset added in first).
function rgResetOnEntry() {
  rgGoToStep(0);
  rgLastResult = null;
  rgLastExceptions = null;
  Object.keys(rgExceptionPicks).forEach(k => delete rgExceptionPicks[k]);
  rgApplyCompleted = false;
  rgSectionFilter.clear();
  rgLoadPickers();
}
window.rgResetOnEntry = rgResetOnEntry;

document.addEventListener('DOMContentLoaded', () => {
  $rg('rgOldCollectionSelect').addEventListener('change', rgUpdateAnalyzeButton);
  $rg('rgNewCollectionSelect').addEventListener('change', rgUpdateAnalyzeButton);
  // Wrapped, not passed directly -- addEventListener hands the click's Event object as the first
  // arg, which would otherwise land in rgAnalyze's own landStep parameter instead of letting its
  // default (0) apply.
  $rg('rgAnalyzeBtn').addEventListener('click', () => rgAnalyze());
  $rg('rgApplyBtn').addEventListener('click', rgOpenApplyConfirm);

  $rg('rgStepper').addEventListener('click', (e) => {
    const pill = e.target.closest('.merge-step');
    if (!pill) return;
    rgGoToStep(Number(pill.dataset.step));
  });
  $rg('rgRelSkipBtn').addEventListener('click', () => {
    // "Skip" discards any in-progress picks -- equivalent to never having touched this step at all
    // (everything defaults to ???/no rule either way). "Continue" below, by contrast, keeps them.
    Object.keys(rgRelationshipOverrides).forEach((k) => delete rgRelationshipOverrides[k]);
    rgRenderNoLinkBody(rgLastResult.noLinkFound, rgLastResult.resolvedMapping, rgLastResult.nameByKey); // clear any "will set" notes Skip just discarded
    rgGoToStep(1);
  });
  $rg('rgRelContinueBtn').addEventListener('click', rgContinueToReport);

  // Back/Next footer (2026-08-25) -- plain rgGoToStep jumps, identical to what clicking the
  // corresponding pill already does; this is just the same universal Back/Next control every other
  // full-stepper tool has, alongside the pills, not a replacement for them.
  $rg('rgResultsBackBtn').addEventListener('click', () => rgGoToStep(0));
  $rg('rgResultsNextBtn').addEventListener('click', () => rgGoToStep(2));
  $rg('rgExcBackBtn').addEventListener('click', () => rgGoToStep(1));

  // Same delegation pattern as rgReviewList below, for the relationship-check cards.
  $rg('rgRelList').addEventListener('click', (e) => {
    const header = e.target.closest('.rg-anomaly-card__header');
    if (!header) return;
    const key = header.dataset.modKey;
    if (rgExpandedRelationships.has(key)) rgExpandedRelationships.delete(key);
    else rgExpandedRelationships.add(key);
    rgRenderRelList();
  });
  $rg('rgRelList').addEventListener('change', (e) => {
    const radio = e.target.closest('input[type="radio"][data-mod-key]');
    if (!radio) return;
    const modKey = radio.dataset.modKey;
    if (!radio.value) {
      // Explicit "???" opt-out -- stored as `null`, NOT deleted. An 'incomplete' item's default
      // fix is pre-filled by rgRenderRelList on every render (see its own comment); if this used
      // `delete`, the very next re-render (e.g. expanding a different card) would silently re-fill
      // the default right back in, undoing the user's own explicit choice. `null` is still an own
      // property, so the pre-fill guard (hasOwnProperty) correctly leaves it alone.
      rgRelationshipOverrides[modKey] = null;
    } else {
      const [targetKey, type] = radio.value.split('::');
      rgRelationshipOverrides[modKey] = { modKey, targetKey, type };
    }
    rgRenderNoLinkBody(rgLastResult.noLinkFound, rgLastResult.resolvedMapping, rgLastResult.nameByKey); // keep Step 2's "will set" note live as picks change
  });

  // Same expand/collapse + pick-change delegation pattern as #rgRelList above, for the "Inferred
  // from patterns" section -- a checkbox (checked = apply, unchecked = opt out), not a radio group,
  // since there's exactly one already-known direction here (see rgRenderInferredItem's own comment).
  // Keyed by data-pair-key (modKey::targetKey), NOT data-mod-key -- see rgPairOverrideKey's own
  // comment for why a plain modKey key can't represent this correctly.
  $rg('rgRelInferredList').addEventListener('click', (e) => {
    const header = e.target.closest('.rg-anomaly-card__header');
    if (!header) return;
    const key = header.dataset.pairKey;
    if (rgExpandedRelationships.has(key)) rgExpandedRelationships.delete(key);
    else rgExpandedRelationships.add(key);
    rgRenderRelList();
  });
  $rg('rgRelInferredList').addEventListener('change', (e) => {
    const checkbox = e.target.closest('input[type="checkbox"][data-pair-key]');
    if (!checkbox) return;
    const pairKey = checkbox.dataset.pairKey;
    const modKey = checkbox.dataset.modKey;
    if (checkbox.checked) {
      const [targetKey, type] = checkbox.dataset.inferredValue.split('::');
      rgRelationshipOverrides[pairKey] = { modKey, targetKey, type };
    } else {
      rgRelationshipOverrides[pairKey] = null; // explicit opt-out -- see the #rgRelList change listener's own comment on why null, not delete
    }
    rgRenderNoLinkBody(rgLastResult.noLinkFound, rgLastResult.resolvedMapping, rgLastResult.nameByKey);
  });

  $rg('rgApplyConfirmModalCancel').addEventListener('click', () => {
    $rg('rgApplyConfirmModal').classList.add('hidden');
  });
  $rg('rgApplyConfirmModalOk').addEventListener('click', rgConfirmApply);

  // Same "click a badge, filter to just that" convention as Stats Report's Issues badges
  // (stats-app.js) -- converted 2026-07-27 from a "scroll to that heading" jump (the three sections
  // stayed visible either way) to an actual filter (isolates one section, click again or Show all
  // to clear), for consistency with every other report in this app.
  $rg('rgSummaryBadges').addEventListener('click', (e) => {
    if (e.target.closest('.badge--show-all')) {
      rgSectionFilter.clear();
      rgRenderSummaryBadges();
      return;
    }
    const badge = e.target.closest('.badge--clickable[data-section]');
    if (!badge) return;
    const section = badge.dataset.section;
    if (rgSectionFilter.has(section)) rgSectionFilter.delete(section); else rgSectionFilter.add(section);
    rgRenderSummaryBadges();
  });

  // Event delegation on the stable container -- the ready list is fully rebuilt on every
  // expand/collapse (see rgRenderReadyList), so listeners attached directly to its children would
  // need re-attaching every time anyway; one listener on the parent handles all of them.
  $rg('rgReadyList').addEventListener('click', (e) => {
    // Checked first, and returns without falling through to the header-toggle check below --
    // the link sits INSIDE the clickable header, so without this a click on the mod name would
    // both open the popup AND expand/collapse the card underneath it.
    const link = e.target.closest('.rg-mod-link');
    if (link) {
      rgOpenOldRulesWindow(link.dataset.oldModKey);
      return;
    }
    const conflictEl = e.target.closest('.rg-conflict-count--clickable');
    if (conflictEl) {
      rgShowConflictPopover(conflictEl);
      return;
    }
    const header = e.target.closest('.rg-ready-card__header');
    if (!header) return;
    const key = header.dataset.newModKey;
    if (rgExpandedItems.has(key)) rgExpandedItems.delete(key);
    else rgExpandedItems.add(key);
    rgRenderReadyList();
  });
  $rg('rgReadyList').addEventListener('change', (e) => {
    const select = e.target.closest('.rg-rule-type-select');
    if (!select) return;
    rgRuleOverrides[rgRuleOverrideKey(select.dataset.newModKey, select.dataset.ruleIdx)] = select.value;
  });

  // Same delegation pattern as rgReadyList above, for the anomaly cards (Needs your input).
  $rg('rgReviewList').addEventListener('click', (e) => {
    const header = e.target.closest('.rg-anomaly-card__header');
    if (!header) return;
    const key = header.dataset.modKey;
    if (rgExpandedAnomalies.has(key)) rgExpandedAnomalies.delete(key);
    else rgExpandedAnomalies.add(key);
    rgRenderReviewList();
  });
  $rg('rgReviewList').addEventListener('change', (e) => {
    const radio = e.target.closest('input[type="radio"][data-mod-key]');
    if (!radio) return;
    rgAnomalyOverrides[radio.dataset.modKey] = radio.value;
  });

  // "Expand all" toggles to "Collapse all" once everything it controls is already open (see
  // rgSyncExpandAllButtonLabel) -- clicking either state just flips every item in that one list.
  $rg('rgExpandAllReadyBtn').addEventListener('click', () => {
    const keys = (rgLastResult?.pendingMapping || []).map((m) => m.newModKey);
    const allExpanded = keys.length > 0 && keys.every((k) => rgExpandedItems.has(k));
    keys.forEach((k) => (allExpanded ? rgExpandedItems.delete(k) : rgExpandedItems.add(k)));
    rgRenderReadyList();
  });
  $rg('rgExpandAllReviewBtn').addEventListener('click', () => {
    const keys = (rgLastResult?.anomalies || []).map((a) => a.modKey);
    const allExpanded = keys.length > 0 && keys.every((k) => rgExpandedAnomalies.has(k));
    keys.forEach((k) => (allExpanded ? rgExpandedAnomalies.delete(k) : rgExpandedAnomalies.add(k)));
    rgRenderReviewList();
  });

  // Step 3 (Exceptions) -- same delegation pattern as rgReviewList above, for the "Need a decision"
  // cards.
  $rg('rgExcDecisionList').addEventListener('click', (e) => {
    const header = e.target.closest('.rg-anomaly-card__header');
    if (!header) return;
    const key = header.dataset.modKey;
    if (rgExpandedExceptions.has(key)) rgExpandedExceptions.delete(key);
    else rgExpandedExceptions.add(key);
    $rg('rgExcDecisionList').innerHTML = (rgLastExceptions?.skippedAlreadySet || []).map(rgRenderExceptionCard).join('');
  });
  $rg('rgExcDecisionList').addEventListener('change', (e) => {
    const radio = e.target.closest('input[type="radio"][data-mod-key]');
    if (!radio) return;
    rgExceptionPicks[radio.dataset.modKey] = radio.value;
  });
  $rg('rgExcSaveBtn').addEventListener('click', () => rgExcOpenConfirm('save'));
  $rg('rgExcSwitchAllBtn').addEventListener('click', () => rgExcOpenConfirm('switchAll'));
  $rg('rgExcConfirmModalCancel').addEventListener('click', () => {
    $rg('rgExcConfirmModal').classList.add('hidden');
  });
  $rg('rgExcConfirmModalOk').addEventListener('click', rgExcConfirmSwitch);
});
