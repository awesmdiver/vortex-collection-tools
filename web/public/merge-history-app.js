'use strict';
// Merge History (Reports sub-tab) -- talks only to /api/merge-history. Own tiny helpers, no shared
// state, same "self-contained per file" convention as this project's other *-app.js files (see
// stats-app.js's own header comment for the real cross-file collision this convention exists to
// prevent). Renders the canonical read-only browse/expand pattern (DESIGN.md's "The read-only
// browse/expand pattern" section) at three levels -- merge -> collection -> plugin -- matching
// design/mockup-merge-plugins-new-features.html section 6 exactly: a header row (caret + merged
// plugin name + count/date + right-aligned state-or-button), expanding to one independently-
// toggleable sub-heading per collection, each expanding to plain muted plugin lines.

function $g(id) { return document.getElementById(id); }

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function fmtDate(iso) {
  return iso ? new Date(iso).toLocaleString() : '--';
}

async function mhApi(method, urlPath, body) {
  const res = await fetch(urlPath, {
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

function mhHandleError(e, retryFn) {
  const box = $g('mhCriticalError');
  if (e.status === 400 && e.body?.error === 'not-configured') {
    box.classList.add('hidden');
    $g('mhNotConfigured').textContent = e.message;
    $g('mhNotConfigured').classList.remove('hidden');
    $g('mhList').innerHTML = '';
    return;
  }
  if (window.isServerUnreachableError && window.isServerUnreachableError(e)) {
    window.showServerUnreachableError();
    return;
  }
  box.textContent = e.message;
  box.classList.remove('hidden');
}

// ---------- Load ----------

let mhPageLoaded = false;
async function loadMergeHistoryPageOnce() {
  if (mhPageLoaded) return;
  mhPageLoaded = true;
  await mhLoadRows();
}

let mhMerges = [];
// Which merge/collection sub-headings are currently expanded -- collections keyed by
// `${mergeId}::${collectionName}` so the SAME collection name under two different merges toggles
// independently (each level is its own independent toggle, per DESIGN.md's own rule).
const mhExpandedMerges = new Set();
const mhExpandedCollections = new Set();

async function mhLoadRows(retryFn) {
  $g('mhNotConfigured').classList.add('hidden');
  $g('mhCriticalError').classList.add('hidden');
  $g('mhResultBox').classList.add('hidden');
  try {
    const { merges } = await mhApi('GET', '/api/merge-history/rows');
    mhMerges = merges || [];
    mhRenderList();
  } catch (e) {
    mhHandleError(e, retryFn || mhLoadRows);
  }
}
$g('mhRefreshBtn').addEventListener('click', () => mhLoadRows());

// ---------- Render (the canonical browse/expand pattern, extended to 3 levels) ----------

function mhStateTrailing(m) {
  if (m.state === 'nothing') return [el('span', {}, 'In sync')];
  const btn = el('button', { class: 'btn btn--primary btn--small' }, m.state === 'revert' ? 'Revert' : 'Restore');
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    mhRunAction(m, m.state);
  });
  return [btn];
}

function mhRenderList() {
  const listEl = $g('mhList');
  listEl.innerHTML = '';
  $g('mhCount').textContent = mhMerges.length
    ? `Reads every merge's saved JSON in your output folder. ${mhMerges.length} merge${mhMerges.length === 1 ? '' : 's'} found.`
    : '';
  if (mhMerges.length === 0) {
    $g('mhEmpty').classList.remove('hidden');
    return;
  }
  $g('mhEmpty').classList.add('hidden');

  for (const m of mhMerges) {
    const isExpanded = mhExpandedMerges.has(m.id);
    const header = el('div', { class: 'muted', style: 'display:flex; align-items:center; gap:10px; cursor:pointer;' }, [
      el('span', {}, isExpanded ? '▼' : '▶'),
      el('strong', { style: 'color: var(--text);' }, m.mergedPluginName),
      el('span', {}, `${m.pluginCount} plugin${m.pluginCount === 1 ? '' : 's'}, built ${fmtDate(m.dateBuilt)}`),
      // Bare `.spacer` has no generic CSS rule in this app (only scoped variants like
      // .merge-cart-bar .spacer exist) -- inline flex:1 achieves the actual right-alignment the task
      // asks for and the canonical reference mockup's own .p-header .spacer defines, without adding a
      // new CSS class this report is the only user of.
      el('div', { style: 'flex:1' }),
      ...mhStateTrailing(m),
    ]);
    header.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      if (mhExpandedMerges.has(m.id)) mhExpandedMerges.delete(m.id); else mhExpandedMerges.add(m.id);
      mhRenderList();
    });

    const card = el('div', { class: 'path-row', style: 'flex-direction: column; align-items: stretch; gap: 8px; margin-bottom: 10px;' }, [header]);
    if (isExpanded) {
      const body = el('div', { style: 'padding-left: 20px; margin-top: 6px;' });
      for (const c of m.collections) {
        const collKey = `${m.id}::${c.name}`;
        const collExpanded = mhExpandedCollections.has(collKey);
        const collHeader = el('div', {
          class: 'muted',
          style: 'display:flex; align-items:center; gap:7px; font-size:12px; font-weight:600; text-transform:uppercase; letter-spacing:.04em; margin:10px 0 4px; cursor:pointer;',
        }, [el('span', { style: 'font-size:10px;' }, collExpanded ? '▼' : '▶'), c.name]);
        collHeader.addEventListener('click', (e) => {
          e.stopPropagation();
          if (mhExpandedCollections.has(collKey)) mhExpandedCollections.delete(collKey); else mhExpandedCollections.add(collKey);
          mhRenderList();
        });
        body.appendChild(collHeader);
        if (collExpanded) {
          for (const fileName of c.plugins) {
            body.appendChild(el('div', { class: 'muted', style: 'font-size:13.5px; padding-left:14px; line-height:1.7;' }, fileName));
          }
        }
      }
      card.appendChild(body);
    }
    listEl.appendChild(card);
  }
}

// ---------- Revert / Restore ----------

async function mhRunAction(m, kind) {
  const verb = kind === 'revert' ? 'Revert' : 'Restore';
  const plural = m.pluginCount === 1 ? '' : 's';
  const msg = kind === 'revert'
    ? `Re-apply the merged state for "${m.mergedPluginName}"? This will disable or remove all ${m.pluginCount} original plugin${plural} the merge originally replaced.`
    : `Restore all ${m.pluginCount} original plugin${plural} from "${m.mergedPluginName}"? The merged plugin file is missing, so this will re-enable or re-extract the original plugins to ensure your game retains their content.`;
  const ok = await window.showConfirmModal(msg);
  if (!ok) return;
  try {
    const { lines } = await mhApi('POST', `/api/merge-history/${kind === 'revert' ? 'revert' : 'restore'}`, { id: m.id });
    // mhLoadRows FIRST, mhShowResult LAST -- mhLoadRows unconditionally hides mhResultBox at its own
    // start (same "clear every status box before a fresh load" convention wrLoadRows/every other
    // report's loader already follows), so calling it after mhShowResult would immediately wipe the
    // just-shown success message back out before it was ever visibly seen. Confirmed live, 2026-08-24.
    await mhLoadRows(); // re-derive fresh state after a real action, never trust the pre-action snapshot
    mhShowResult(m.mergedPluginName, verb, lines || []);
  } catch (e) {
    mhHandleError(e, () => mhRunAction(m, kind));
  }
}

function mhShowResult(mergedPluginName, verb, lines) {
  const box = $g('mhResultBox');
  box.innerHTML = '';
  box.appendChild(el('div', { class: 'callout__title' }, `✅ ${verb} complete -- "${mergedPluginName}"`));
  if (lines.length) {
    const list = el('ul', { style: 'margin:6px 0 0; padding-left:18px;' });
    for (const line of lines) list.appendChild(el('li', {}, line));
    box.appendChild(list);
  }
  box.classList.remove('hidden');
}
