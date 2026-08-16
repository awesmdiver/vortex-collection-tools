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

let rgLastResult = null;
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
          `<label class="checkbox"><input type="radio" name="${groupName}" data-mod-key="${escHtmlRg(item.modKey)}" value="${idx}"${String(idx) === selected ? ' checked' : ''}> ${escHtmlRg(rgLastResult.nameByKey[c.targetKey] || c.targetKey)} <span class="muted">(${rgRuleLabel(c.type)})</span></label>`,
      )
      .join('');
    bodyHtml = `
      <div class="rg-anomaly-card__body">
        <p class="muted">More than one mod in the original collection could be the match. Which one is right?</p>
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
  const mapping = rgLastResult?.mapping || [];
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
function rgRenderNoLinkBody(noLinkFound, nameByKey) {
  const body = $rg('rgNoLinkBody');
  if (!noLinkFound.length) {
    body.innerHTML = '<p class="muted">Everything in the new collection was matched or needs review above.</p>';
    return;
  }
  const chips = noLinkFound.map((n) => `<span class="chip">${escHtmlRg(nameByKey[n.modKey] || n.modKey)}</span>`).join('');
  body.innerHTML = `
    <details class="chip-list-details">
      <summary><span class="chip-list-details__caret">▸</span> <span class="chip-list-details__count">${noLinkFound.length}</span> mod${noLinkFound.length === 1 ? '' : 's'} added with nothing needed &mdash; show them</summary>
      <div class="chip-list-details__body">
        <p class="muted">Added to the new collection with no relationship to anything in the original one &mdash; nothing needed here.</p>
        <div class="chip-row">${chips}</div>
      </div>
    </details>`;
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
  $rg('rgSummaryBadges').innerHTML = [
    badgeHtml('ready', 'badge--success', result.mapping.length, 'Ready to copy'),
    badgeHtml('review', 'badge--warning', result.anomalies.length, 'Needs your input'),
    badgeHtml('nolink', 'badge--neutral', result.noLinkFound.length, 'Nothing to do'),
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

  rgSectionFilter.clear(); // fresh analysis -- always start showing all three sections
  rgRenderSummaryBadges();

  // Disabled, not just relying on the existing click-time preview check (which already catches
  // this safely -- see rgOpenApplyConfirm's totalRulesWritten===0 message) -- confirmed 2026-07-27:
  // a clearly-disabled button is a better signal than letting someone click it and read a message
  // explaining nothing happened. 0 ready + 0 needing input means there is nothing this button could
  // possibly do right now.
  $rg('rgApplyBtn').disabled = result.mapping.length === 0 && result.anomalies.length === 0;

  rgRenderReadyList();
  rgRenderReviewList();

  rgRenderNoLinkBody(result.noLinkFound, nameByKey);

  $rg('rgResults').classList.remove('hidden');
}

async function rgAnalyze() {
  rgHideCriticalError();
  $rg('rgResults').classList.add('hidden');
  $rg('rgLoading').classList.remove('hidden');
  $rg('rgAnalyzeBtn').disabled = true;
  try {
    const result = await rgApi('POST', '/api/rules-generator/analyze', {
      oldCollectionKey: $rg('rgOldCollectionSelect').value,
      newCollectionKey: $rg('rgNewCollectionSelect').value,
    });
    rgRender(result);
  } catch (e) {
    rgHandleError(e, rgAnalyze);
  } finally {
    $rg('rgLoading').classList.add('hidden');
    rgUpdateAnalyzeButton();
  }
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
  };
}

async function rgOpenApplyConfirm() {
  rgHideCriticalError();
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

async function rgConfirmApply() {
  $rg('rgApplyConfirmModal').classList.add('hidden');
  const statusEl = $rg('rgApplyStatus');
  statusEl.textContent = "Writing to Vortex's database…";
  try {
    const result = await rgApi('POST', '/api/rules-generator/apply', rgApplyRequestBody());
    statusEl.textContent = '';
    $rg('rgApplyDoneText').textContent =
      `${result.totalRulesWritten} rule(s) written across ${result.totalModsChanged} mod(s).`;
    $rg('rgApplyDoneInfo').classList.remove('hidden');
    // The overrides that were just applied no longer describe anything meaningful -- a fresh
    // Analyze below re-derives current state from scratch (rules just written now show up as
    // already-resolved, so those mods naturally drop out of Ready to copy / Needs your input).
    Object.keys(rgRuleOverrides).forEach((k) => delete rgRuleOverrides[k]);
    Object.keys(rgAnomalyOverrides).forEach((k) => delete rgAnomalyOverrides[k]);
    await rgAnalyze();
  } catch (e) {
    rgHandleError(e, rgConfirmApply);
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

document.addEventListener('DOMContentLoaded', () => {
  $rg('rgOldCollectionSelect').addEventListener('change', rgUpdateAnalyzeButton);
  $rg('rgNewCollectionSelect').addEventListener('change', rgUpdateAnalyzeButton);
  $rg('rgAnalyzeBtn').addEventListener('click', rgAnalyze);
  $rg('rgApplyBtn').addEventListener('click', rgOpenApplyConfirm);
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
    const keys = (rgLastResult?.mapping || []).map((m) => m.newModKey);
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
});
