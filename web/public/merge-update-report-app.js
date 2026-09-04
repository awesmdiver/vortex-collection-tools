'use strict';
// Merge Update Status Report (Reports sub-tab) -- talks only to /api/merge-update-report. Own tiny
// helpers, no shared state, same "self-contained per file" convention as merge-history-app.js's own
// header comment describes. See design/mockup-merge-plugins-new-features.html section 7 for the
// original design this implements: reuses the real .path-row card shape Merge History already ships
// with, one card per saved merge, a badge for its overall status (Up to date / N of M updated /
// Can't check -- rebuild to enable). Click-to-expand per card (2026-08-25, director's own ask, same
// ▶/▼ caret pattern as merge-history-app.js's own mhExpandedMerges) reveals every plugin this merge
// is made of, not just the mockup's original "only show the list when something's flagged" -- a
// Can't-check or Up-to-date merge's own plugin list is still real, useful data. "Create a new
// version →" (only shown, inside the expanded body, for a merge with at least one real update) hands
// off to Merge Plugins' own Step 1, pre-selected (see merge-app.js's own ?sourceMergeId= handling
// for the receiving side).

function $g(id) { return document.getElementById(id); }

function murEl(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'style') node.setAttribute('style', v);
    else node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function murFmtDate(iso) {
  return iso ? new Date(iso).toLocaleDateString() : '--';
}

async function murApi(method, urlPath) {
  const res = await fetch(urlPath, { method });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || data.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

function murHandleError(e) {
  const box = $g('murCriticalError');
  if (e.status === 400 && e.body?.error === 'not-configured') {
    box.classList.add('hidden');
    $g('murNotConfigured').textContent = e.message;
    $g('murNotConfigured').classList.remove('hidden');
    $g('murList').innerHTML = '';
    return;
  }
  if (window.isServerUnreachableError && window.isServerUnreachableError(e)) {
    window.showServerUnreachableError();
    return;
  }
  box.textContent = e.message;
  box.classList.remove('hidden');
}

let murPageLoaded = false;
async function loadMergeUpdateReportPageOnce() {
  if (murPageLoaded) return;
  murPageLoaded = true;
  await murLoadRows();
}

let murMerges = [];
// Click-to-expand per merge (2026-08-25, director's own ask: "drop-down the data like the merge
// history report") -- same pattern as mhExpandedMerges in merge-history-app.js. Every merge can
// expand now, not just ones with a real update: a Can't-check or Up-to-date merge's own plugin list
// is still real, useful data (which plugins/mods this merge is even made of), it just never carries
// an update badge.
const murExpandedMerges = new Set();
// Mod-level sub-headings, independently expandable per merge (2026-08-25, director's own ask: "make
// it exactly behave the same as Merge History") -- same `${mergeId}::${modName}` keying as
// merge-history-app.js's own mhExpandedMods, so the same mod name under two different merges toggles
// independently.
const murExpandedMods = new Set();

async function murLoadRows() {
  $g('murNotConfigured').classList.add('hidden');
  $g('murCriticalError').classList.add('hidden');
  try {
    const { merges } = await murApi('GET', '/api/merge-update-report/rows');
    murMerges = merges || [];
    murRenderList();
  } catch (e) {
    murHandleError(e);
  }
}
$g('murRefreshBtn').addEventListener('click', () => murLoadRows());

function murStatusBadge(m) {
  if (!m.checkable) return murEl('span', { class: 'badge badge--neutral' }, "Can't check — rebuild to enable tracking");
  if (m.updatedCount > 0) return murEl('span', { class: 'badge badge--warning' }, `⚠️ ${m.updatedCount} of ${m.pluginCount} updated`);
  return murEl('span', { class: 'badge badge--success' }, 'Up to date');
}

// Inline flex:1, not a bare `.spacer` class -- confirmed real 2026-08-25: this app has no generic
// `.spacer` CSS rule (only scoped variants like `.merge-cart-bar .spacer` exist), so a bare
// `class: 'spacer'` collapses to zero width and the badge sits flush against the meta text instead
// of right-justified. Same fix merge-history-app.js's own header row already uses.
function murPluginRow(p) {
  const row = murEl('div', { style: 'display:flex;align-items:center;gap:10px' }, [
    murEl('span', { class: 'muted', style: 'font-size:13.5px' }, p.filename),
    murEl('div', { style: 'flex:1' }),
  ]);
  if (p.updated) {
    const arrowText = p.oldVersion && p.newVersion
      ? `Updated: v${p.oldVersion} → v${p.newVersion}`
      : 'Updated';
    row.appendChild(murEl('span', { class: 'badge badge--warning badge--sm' }, arrowText));
  }
  return row;
}

// Groups a merge's own flat plugin list by mod (modName, threaded through from
// web/merge-update-report-routes.js's own computePluginStatus) -- same grouping key Merge History's
// own backend already uses (p.dataFolder || p.stagingFolderName || 'Unknown mod'), just done
// client-side here since this report's own /rows response is flat per-plugin, not pre-grouped.
function murGroupByMod(plugins) {
  const byMod = new Map();
  for (const p of plugins) {
    if (!byMod.has(p.modName)) byMod.set(p.modName, []);
    byMod.get(p.modName).push(p);
  }
  return [...byMod.entries()]
    .map(([name, mods]) => ({ name, plugins: mods }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Same mod sub-heading shape as merge-history-app.js's own mhRenderList (▶/▼ caret, uppercase muted
// label, independently toggleable via murExpandedMods) -- director's own explicit ask to make this
// report behave exactly the same. Each plugin row underneath still carries its own update badge
// (murPluginRow), unlike Merge History's plain filename-only leaves, since that's real data this
// report specifically needs to show.
function murRenderModGroups(body, mergeId, plugins) {
  for (const mod of murGroupByMod(plugins)) {
    const modKey = `${mergeId}::${mod.name}`;
    const modExpanded = murExpandedMods.has(modKey);
    const modHeader = murEl('div', {
      class: 'muted',
      style: 'display:flex; align-items:center; gap:7px; font-size:12px; font-weight:600; text-transform:uppercase; letter-spacing:.04em; margin:10px 0 4px; cursor:pointer;',
    }, [murEl('span', { style: 'font-size:10px;' }, modExpanded ? '▼' : '▶'), mod.name]);
    modHeader.addEventListener('click', (e) => {
      e.stopPropagation();
      if (murExpandedMods.has(modKey)) murExpandedMods.delete(modKey); else murExpandedMods.add(modKey);
      murRenderList();
    });
    body.appendChild(modHeader);
    if (modExpanded) {
      const pluginList = murEl('div', { style: 'padding-left:14px;display:flex;flex-direction:column;gap:6px' },
        mod.plugins.map((p) => murPluginRow(p)));
      body.appendChild(pluginList);
    }
  }
}

function murRenderCard(m) {
  const isExpanded = murExpandedMerges.has(m.id);
  const header = murEl('div', { style: 'display:flex;align-items:center;gap:10px;cursor:pointer' }, [
    murEl('span', { class: 'muted' }, isExpanded ? '▼' : '▶'),
    murEl('strong', { style: 'color:var(--text)' }, m.mergedPluginName || m.filename),
    murEl('span', { class: 'muted', style: 'margin:0' }, `${m.pluginCount} plugin${m.pluginCount === 1 ? '' : 's'}, built ${murFmtDate(m.dateBuilt)}`),
    murEl('div', { style: 'flex:1' }),
    murStatusBadge(m),
  ]);
  header.addEventListener('click', () => {
    if (isExpanded) murExpandedMerges.delete(m.id); else murExpandedMerges.add(m.id);
    murRenderList();
  });
  const card = murEl('div', { class: 'path-row', style: 'flex-direction:column;align-items:stretch;gap:8px;margin-bottom:10px' }, [header]);
  if (!m.checkable) card.style.opacity = '.6';

  if (isExpanded) {
    const body = murEl('div', { style: 'padding-left: 20px; margin-top: 6px;' });
    murRenderModGroups(body, m.id, m.plugins);
    card.appendChild(body);

    if (m.checkable && m.updatedCount > 0) {
      const actionsRow = murEl('div', { style: 'display:flex;justify-content:flex-end;margin-top:4px' });
      const rebuildBtn = murEl('button', { class: 'btn btn--primary btn--sm' }, 'Create a new version →');
      rebuildBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        window.navigateToArea('merge');
        // mergeStartWithSourceMerge (merge-app.js) reads ?sourceMergeId= itself on Step 0's own load,
        // but navigateToArea doesn't refresh the URL for an already-loaded page -- call it directly so
        // clicking this from an already-open session works the same as a fresh ?area=merge&... link.
        if (window.mergeStartWithSourceMerge) window.mergeStartWithSourceMerge(m.id);
      });
      actionsRow.appendChild(rebuildBtn);
      card.appendChild(actionsRow);
    }
  }
  return card;
}

function murRenderList() {
  $g('murCount').textContent = murMerges.length ? `${murMerges.length} merge${murMerges.length === 1 ? '' : 's'} checked` : '';
  $g('murEmpty').classList.toggle('hidden', murMerges.length > 0);
  const list = $g('murList');
  list.innerHTML = '';
  for (const m of murMerges) list.appendChild(murRenderCard(m));
}
