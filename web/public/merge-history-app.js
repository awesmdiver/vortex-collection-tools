'use strict';
// Merge History (Reports sub-tab) -- talks only to /api/merge-history. Own tiny helpers, no shared
// state, same "self-contained per file" convention as this project's other *-app.js files (see
// stats-app.js's own header comment for the real cross-file collision this convention exists to
// prevent). Renders the canonical read-only browse/expand pattern (DESIGN.md's "The read-only
// browse/expand pattern" section) at three levels -- merge -> mod -> plugin (grouped by MOD, not
// collection -- corrected 2026-08-25, see web/merge-history-routes.js's own /rows comment) --
// matching design/mockup-merge-plugins-new-features.html section 6's original shape: a header row
// (caret + merged plugin name + count/date + right-aligned state-or-button), expanding to one
// independently-toggleable sub-heading per mod, each expanding to plain muted plugin lines.
//
// Every header row also carries Rename/Delete (2026-08-25) -- these act on the saved-merge RECORD's
// own identity/existence (its merge.json + folder), a completely separate axis from the
// state-or-button's own Revert/Restore/Undo, which act on the merge's ORIGINAL SOURCE plugins. See
// mhOpenRenameModal/mhOpenDeleteModal below and web/merge-history-routes.js's own header comment.

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
  box.innerHTML = '';
  box.appendChild(el('div', { class: 'callout__title' }, '🛑 Couldn\'t load merge history'));
  box.appendChild(el('p', {}, e.message));
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
// Which merge/mod sub-headings are currently expanded -- mods keyed by `${mergeId}::${modName}` so
// the SAME mod name under two different merges toggles independently (each level is its own
// independent toggle, per DESIGN.md's own rule). Grouped by MOD, not collection (corrected
// 2026-08-25 -- see web/merge-history-routes.js's own /rows comment for why).
const mhExpandedMerges = new Set();
const mhExpandedMods = new Set();
// The one pending action result, if any -- { mergeId, mergedPluginName, verb, lines, kind, manual }
// | null. Only one at a time (matches the old single-result-box behavior, just relocated into that
// merge's own panel instead of a separate box atop the page).
let mhActionResult = null;

async function mhLoadRows(retryFn) {
  $g('mhNotConfigured').classList.add('hidden');
  $g('mhCriticalError').classList.add('hidden');
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

// ---------- Rename / Delete (act on the saved-merge RECORD's own identity/existence -- a completely
// separate axis from Revert/Restore above, which act on the merge's ORIGINAL SOURCE plugins) ----------

function mhOpenRenameModal(m) {
  const modal = $g('mhRenameModal');
  const input = $g('mhRenameInput');
  const errorEl = $g('mhRenameError');
  errorEl.classList.add('hidden');
  errorEl.textContent = '';
  $g('mhRenameModalText').textContent = `This renames the merge's files on disk—the output folder, the merged plugin (${m.filename}), and its build record—not just its display label.`;
  $g('mhRenameModalText2').textContent = `If this merge is already deployed in Vortex, you will need to redeploy afterward so Vortex recognizes the new name.`;
  input.value = m.mergedPluginName;
  modal.classList.remove('hidden');
  input.focus();
  input.select();

  const cleanup = () => {
    modal.classList.add('hidden');
    $g('mhRenameSaveBtn').onclick = null;
    $g('mhRenameCancelBtn').onclick = null;
  };
  $g('mhRenameCancelBtn').onclick = () => cleanup();
  $g('mhRenameSaveBtn').onclick = async () => {
    const newName = input.value.trim();
    try {
      const result = await mhApi('POST', '/api/merge-history/rename', { id: m.id, newName });
      cleanup();
      // A stale copy under the OLD filename is still sitting in mergeStagingCopyDir -- the one real
      // Vortex-relevant loose end a rename can leave behind. Only ever set when that setting is
      // configured AND the old file is really there; most renames get null here and skip straight to
      // the reload below. Reuses the app's own shared yes/no modal (shell.js) rather than a new one.
      if (result.staleStagingPath) {
        const proceed = await showConfirmModal(
          `This merge was already copied into your staging folder under its old name. Copy the renamed file there too, and remove the old one?`
        );
        if (proceed) {
          try {
            await mhApi('POST', '/api/merge-history/apply-staging-copy', { id: result.id, staleStagingPath: result.staleStagingPath });
          } catch (e) {
            mhHandleError(e, () => {});
          }
        }
      }
      await mhLoadRows();
    } catch (e) {
      errorEl.innerHTML = '';
      errorEl.appendChild(el('div', { class: 'callout__title' }, '🛑 Couldn\'t rename this merge'));
      errorEl.appendChild(el('p', {}, e.message));
      errorEl.classList.remove('hidden');
    }
  };
}

// "If we delete, we delete everything" (director's own explicit call, 2026-08-25) -- a flat,
// unconditional list of everything a delete actually removes, matching web/merge-history-routes.js's
// own /delete route exactly: the record, the merged plugin, the whole output folder (which already
// covers a 'backup-remove' merge's own Backup/ subfolder -- no separate bullet needed for that), and
// the deployed copy in the Vortex staging folder if mergeStagingCopyDir is set up and this merge's
// file is actually there (a harmless no-op otherwise, so the bullet is still shown -- it describes
// what delete DOES, not a per-merge conditional).
function mhOpenDeleteModal(m) {
  const modal = $g('mhDeleteConfirmModal');
  $g('mhDeleteConfirmModalIntro').textContent = '';
  $g('mhDeleteConfirmModalIntro').append(
    'This cannot be undone. Deleting ', el('strong', {}, `"${m.mergedPluginName}"`), ' will permanently remove:',
  );
  const list = $g('mhDeleteConfirmModalList');
  list.innerHTML = '';
  list.append(
    el('li', {}, 'The saved merge record and build logs'),
    el('li', {}, ['The merged plugin (', el('code', {}, m.filename), ')']),
    el('li', {}, 'The output folder and all its contents'),
    el('li', {}, 'The deployed files in your Vortex staging folder'),
  );
  modal.classList.remove('hidden');
  const cleanup = () => {
    modal.classList.add('hidden');
    $g('mhDeleteConfirmOkBtn').onclick = null;
    $g('mhDeleteConfirmCancelBtn').onclick = null;
  };
  $g('mhDeleteConfirmCancelBtn').onclick = () => cleanup();
  $g('mhDeleteConfirmOkBtn').onclick = async () => {
    cleanup();
    try {
      await mhApi('POST', '/api/merge-history/delete', { id: m.id });
      mhExpandedMerges.delete(m.id);
      if (mhActionResult && mhActionResult.mergeId === m.id) mhActionResult = null;
      await mhLoadRows();
    } catch (e) {
      mhHandleError(e, () => mhOpenDeleteModal(m));
    }
  };
}

// Small, icon-only (title-only tooltip, no label) -- these used to be full "✏️ Rename"/"🗑️ Delete"
// buttons sitting to the LEFT of the state button, which staggered the whole action group's start
// position row to row (2 buttons here + a variable-width state area vs. just the state area) --
// confirmed real 2026-08-25, director's own "staggered looking lists ... hard on the eyes" call.
// Icon buttons are fixed-width (.btn--icon in styles.css) and sit to the RIGHT of the state button
// now, so the group's total width -- and therefore its start x -- is identical on every row.
// Plain glyph (✎) + mono trash (🗑, no color variation selector) rather than the colorful ✏️/🗑️ emoji
// -- director's own pick (2026-08-25): these are secondary, out-of-the-way actions, so deliberately
// quieter than this app's usual colored-emoji convention, not a departure from it as a rule.
function mhRecordActionButtons(m) {
  const renameBtn = el('button', { class: 'btn btn--ghost btn--icon', title: 'Rename' }, '✎');
  renameBtn.addEventListener('click', (e) => { e.stopPropagation(); mhOpenRenameModal(m); });
  const deleteBtn = el('button', { class: 'btn btn--ghost btn--icon', title: 'Delete' }, '🗑');
  deleteBtn.addEventListener('click', (e) => { e.stopPropagation(); mhOpenDeleteModal(m); });
  return [renameBtn, deleteBtn];
}

// Always exactly ONE element now (the "In sync" label moved into the header's own meta text below,
// next to the timestamp) -- also fixed-width (.btn--state in styles.css) so this column lines up
// across rows regardless of which real state is showing. Undo Merge is plain-glyph-only (no text
// label), matching Rename/Delete's own quiet icon treatment (director's own pick, 2026-08-25) --
// still rendered inside the SAME fixed-width slot as Restore/Revert, not shrunk to an icon-sized
// button, or the alignment fix above regresses (a narrower control here would stagger the group's
// start x again on an "In sync" row vs. a Restore/Revert row).
function mhStateTrailing(m) {
  if (m.state === 'nothing') {
    const undoBtn = el('button', { class: 'btn btn--ghost btn--small btn--state', title: 'Undo Merge' }, '↩');
    undoBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      mhRunAction(m, 'restore', true);
    });
    return [undoBtn];
  }
  const btn = el('button', { class: 'btn btn--primary btn--small btn--state' }, m.state === 'revert' ? 'Revert' : 'Restore');
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
    const hasResult = mhActionResult && mhActionResult.mergeId === m.id;
    // A pending action result forces its own merge's panel open -- combined into ONE panel per the
    // director's own explicit ask (2026-08-24): this used to be a separate floating result box atop
    // the whole page, disconnected from which merge it was even about. Collapsing the header now
    // doubles as "I'm done, dismiss this" -- clears the result so reopening later (or moving to
    // another merge) shows the plain file browse again, not a stale result.
    const isExpanded = mhExpandedMerges.has(m.id) || hasResult;
    const header = el('div', { class: 'muted', style: 'display:flex; align-items:center; gap:10px; cursor:pointer;' }, [
      el('span', {}, isExpanded ? '▼' : '▶'),
      el('strong', { style: 'color: var(--text);' }, m.mergedPluginName),
      // "In sync" sits right next to the timestamp it's describing, not off in the trailing action
      // area (moved 2026-08-25, director's own call) -- it's a status of the merge's current state,
      // same category of fact as "built <date>", not an action.
      el('span', {}, `${m.pluginCount} plugin${m.pluginCount === 1 ? '' : 's'}, built ${fmtDate(m.dateBuilt)}${m.state === 'nothing' ? ' · In sync' : ''}`),
      // Bare `.spacer` has no generic CSS rule in this app (only scoped variants like
      // .merge-cart-bar .spacer exist) -- inline flex:1 achieves the actual right-alignment the task
      // asks for and the canonical reference mockup's own .p-header .spacer defines, without adding a
      // new CSS class this report is the only user of.
      el('div', { style: 'flex:1' }),
      ...mhStateTrailing(m),
      ...mhRecordActionButtons(m),
    ]);
    header.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      if (isExpanded) {
        mhExpandedMerges.delete(m.id);
        if (hasResult) mhActionResult = null;
      } else {
        mhExpandedMerges.add(m.id);
      }
      mhRenderList();
    });

    const card = el('div', { class: 'path-row', style: 'flex-direction: column; align-items: stretch; gap: 8px; margin-bottom: 10px;' }, [header]);
    if (isExpanded) {
      const body = el('div', { style: 'padding-left: 20px; margin-top: 6px;' });
      if (hasResult) {
        mhRenderActionResult(body, mhActionResult);
      } else {
        for (const mod of m.mods) {
          const modKey = `${m.id}::${mod.name}`;
          const modExpanded = mhExpandedMods.has(modKey);
          const modHeader = el('div', {
            class: 'muted',
            style: 'display:flex; align-items:center; gap:7px; font-size:12px; font-weight:600; text-transform:uppercase; letter-spacing:.04em; margin:10px 0 4px; cursor:pointer;',
          }, [el('span', { style: 'font-size:10px;' }, modExpanded ? '▼' : '▶'), mod.name]);
          modHeader.addEventListener('click', (e) => {
            e.stopPropagation();
            if (mhExpandedMods.has(modKey)) mhExpandedMods.delete(modKey); else mhExpandedMods.add(modKey);
            mhRenderList();
          });
          body.appendChild(modHeader);
          if (modExpanded) {
            for (const fileName of mod.plugins) {
              body.appendChild(el('div', { class: 'muted', style: 'font-size:13.5px; padding-left:14px; line-height:1.7;' }, fileName));
            }
          }
        }
      }
      card.appendChild(body);
    }
    listEl.appendChild(card);
  }
}

// ---------- Revert / Restore ----------

async function mhRunAction(m, kind, manual) {
  const verb = kind === 'revert' ? 'Revert' : 'Restore';
  const plural = m.pluginCount === 1 ? '' : 's';
  const msg = manual
    ? `Undo the merge for "${m.mergedPluginName}"? This brings back all ${m.pluginCount} original plugin${plural} the merge replaced. It does not touch the merged plugin file itself -- disable or delete that yourself once you've confirmed the originals are back.`
    : kind === 'revert'
    ? `Re-apply the merged state for "${m.mergedPluginName}"? This will disable or remove all ${m.pluginCount} original plugin${plural} the merge originally replaced.`
    : `Restore all ${m.pluginCount} original plugin${plural} from "${m.mergedPluginName}"? The merged plugin file is missing, so this will re-enable or re-extract the original plugins to ensure your game retains their content.`;
  const ok = await window.showConfirmModal(msg);
  if (!ok) return;
  try {
    const { lines } = await mhApi('POST', `/api/merge-history/${kind === 'revert' ? 'revert' : 'restore'}`, { id: m.id });
    // Set the result BEFORE mhLoadRows -- mhLoadRows calls mhRenderList, which reads mhActionResult
    // to decide whether this merge's own panel shows the result or the plain file browse. One combined
    // panel per merge (2026-08-24, director's own ask) instead of a separate floating result box.
    mhResultExpanded = new Set();
    mhActionResult = { mergeId: m.id, mergedPluginName: m.mergedPluginName, filename: m.filename, verb, lines: lines || [], kind, manual };
    mhExpandedMerges.add(m.id);
    await mhLoadRows(); // re-derive fresh state after a real action, never trust the pre-action snapshot
  } catch (e) {
    mhHandleError(e, () => mhRunAction(m, kind));
  }
}

// Three distinct real cases (never the same tip) -- none of the three actions below EVER touch the
// merged plugin file itself (confirmed reading web/merge-history-routes.js: /revert and /restore
// only ever write to json.plugins, the ORIGINAL source files), so every tip only ever asks the
// director to handle the merged file by hand, never claims this app did:
// - Revert: a collection update reactivated an original while the merge is otherwise intact --
//   re-disables/removes the reappeared originals. Merged plugin was never touched and should
//   already be the active file -- just needs enabling/restoring + a deploy.
// - Restore (auto): the merged plugin file itself is ALREADY missing on disk (that's the very
//   reason this state exists at all, per computeMergeState's own fs.existsSync check) -- brings the
//   originals back. Nothing to do with the merged file here since it's already gone.
// - Undo Merge (manual): everything was in sync; the director deliberately backed out. Brings the
//   originals back exactly like Restore, but the merged file is still sitting there, untouched and
//   still enabled -- that's the one case where the director actually needs to go disable/remove it.
function mhNextStepsTip(kind, manual) {
  if (manual) {
    return 'Disable or remove the merged plugin from your staging folder, then click Deploy Mods to bring back your original files.';
  }
  if (kind === 'revert') {
    return 'Enable or restore the merged plugin from your staging folder and click Deploy Mods to restore your merged plugin.';
  }
  return "Confirm your original source plugins show enabled in Vortex, then click Deploy Mods to bring their content back into your game. Your merged plugin is missing -- rebuild it if you still want the merge.";
}

// Groups the backend's flat per-plugin result lines into the same shape the merge report itself
// uses (a named group with a nested, muted, alphabetical plugin list) -- one line per plugin was
// unreadable for anything beyond a handful of files (confirmed live, 2026-08-24: a real 30-plugin
// restore rendered as 30 near-identical lines). Regexes match this file's OWN backend line formats
// (merge-history-routes.js's /revert and /restore) -- if those message strings ever change, these
// need to change with them; there's no shared format contract between the two today.
const MH_RESULT_LINE_PATTERNS = [
  { key: 'archive', re: /^Restored (.+) by re-extracting "(.+)" from archive\.$/, archive: true },
  { key: 'backup', re: /^Restored (.+) from backup\.$/, label: 'From backup' },
  { key: 'enabled', re: /^Re-enabled (.+) in Vortex\. (.+)$/, note: true, label: 'Re-enabled in Vortex' },
  { key: 'removed', re: /^Removed (.+) from staging\.$/, label: 'Removed from staging' },
  // revert's disable branch (web/merge-routes.js's runPostMergeCleanup, shared with the ORIGINAL
  // merge's own post-cleanup step) emits one AGGREGATE comma-joined line, unlike every other action
  // here which is per-plugin -- splitNames expands it back into individual plugin entries so this
  // renders identically to every other case (2026-08-24, director's own "make them all look the
  // same" ask) instead of needing special-case rendering.
  { key: 'disabled-vortex', re: /^Disabled (\d+) plugins? in Vortex: (.+)\. Deploy mods in Vortex to apply these changes to your game\.$/, splitNames: true, label: 'Disabled in Vortex', note: 'Deploy mods in Vortex to apply these changes to your game.' },
  { key: 'disabled-pluginstxt', re: /^Disabled (\d+) plugins? in Plugins\.txt: (.+)$/, splitNames: true, label: 'Disabled in Plugins.txt' },
  { key: 'already-gone', re: /^(.+) was not present; skipped removal\.$/, label: 'Already removed' },
];

// Flattened to two real tiers, not three (2026-08-24, director's own correction): a separate
// "Restored"/"Removed from staging"/etc. wrapper group per method was confusing once a real result
// had several different SOURCE MODS each contributing exactly one file -- it read as "Restored (1)"
// repeated N times, when there's only ever one plugin per mod in practice. The method-level count now
// folds into the overall title (mhRenderActionResult), and archive-restored plugins group directly by
// their source mod name -- mod name -> plugin list, nothing in between. Lines with no natural "mod"
// dimension (backup-restored, re-enabled-in-Vortex, removed-from-staging) still get a short method
// label so a mixed result stays legible, but that label is no longer a collapsible wrapper tier.
function mhGroupResultLines(lines) {
  const archiveGroups = new Map(); // archiveName -> plugins[]
  const flatGroups = new Map(); // key -> { label, note, plugins: [] }
  const other = [];
  let totalRestored = 0;
  for (const line of lines) {
    let matched = false;
    for (const p of MH_RESULT_LINE_PATTERNS) {
      const m = line.match(p.re);
      if (!m) continue;
      matched = true;
      if (p.archive) {
        totalRestored++;
        if (!archiveGroups.has(m[2])) archiveGroups.set(m[2], []);
        archiveGroups.get(m[2]).push(m[1]);
      } else {
        if (!flatGroups.has(p.key)) flatGroups.set(p.key, { label: p.label, note: p.note === true ? m[2] : (p.note || null), plugins: [] });
        const names = p.splitNames ? m[2].split(',').map((s) => s.trim()) : [m[1]];
        totalRestored += names.length;
        flatGroups.get(p.key).plugins.push(...names);
      }
      break;
    }
    if (!matched) other.push(line);
  }
  const archives = Array.from(archiveGroups.entries())
    .map(([archiveName, plugins]) => ({ archiveName, plugins: plugins.slice().sort((a, b) => a.localeCompare(b)) }))
    .sort((a, b) => a.archiveName.localeCompare(b.archiveName));
  const flats = Array.from(flatGroups.values())
    .map((g) => ({ ...g, plugins: g.plugins.slice().sort((a, b) => a.localeCompare(b)) }));
  return { archives, flats, other, totalRestored };
}

let mhResultExpanded = new Set();

// Renders a pending action result INTO a merge's own expanded panel body (2026-08-24, combined into
// one panel per the director's own ask -- this used to be a separate floating callout atop the whole
// page, disconnected from which merge it was even about). `container` is a fresh element each call
// (mhRenderList rebuilds the whole list), so this never needs to clear/hide anything itself -- just
// append. Toggle clicks re-render via the normal mhRenderList() path, same as every other
// expand/collapse in this file, rather than re-invoking this function directly.
function mhRenderActionResult(container, result) {
  const { filename, mergedPluginName, verb, lines, kind, manual } = result;
  const displayName = filename || mergedPluginName;
  const { archives, flats, other, totalRestored } = mhGroupResultLines(lines);
  const hasFailures = other.length > 0;
  const box = el('div', { class: `callout ${hasFailures ? 'callout--warning' : 'callout--success'}`, style: 'margin-top: 6px;' });
  if (!hasFailures) {
    const tip = el('div', { class: 'callout callout--info', style: 'margin-bottom:12px;' }, [
      el('div', { class: 'callout__title' }, 'ℹ️ Important Next Steps in Vortex:'),
      el('p', { style: 'margin:6px 0 0;' }, mhNextStepsTip(kind, manual)),
    ]);
    box.appendChild(tip);
  }
  const modCount = archives.length + flats.length;
  const title = hasFailures
    ? `⚠️ Could not restore ${other.length === 1 ? 'the plugin' : `${other.length} plugins`} -- "${displayName}"`
    : `🎉 ${verb} complete -- "${displayName}" (${modCount} mod${modCount === 1 ? '' : 's'}, ${totalRestored} plugin${totalRestored === 1 ? '' : 's'})`;
  box.appendChild(el('div', { class: 'callout__title' }, title));
  // Two real tiers: mod name -> plugin name, indented directly under the title -- no separate
  // "Restored"/method wrapper tier (2026-08-24, director's own correction: that read as noise when
  // every mod only ever contributes exactly one file).
  const modBody = el('div', { style: 'padding-left: 20px; margin-top: 6px;' });
  archives.forEach((g, idx) => {
    const subKey = `archive::${idx}`;
    const subExpanded = mhResultExpanded.has(subKey);
    const subHeader = el('div', {
      class: 'muted',
      style: 'display:flex; align-items:center; gap:7px; font-size:12px; font-weight:600; text-transform:uppercase; letter-spacing:.04em; margin:8px 0 4px; cursor:pointer;',
    }, [el('span', { style: 'font-size:10px;' }, subExpanded ? '▼' : '▶'), g.archiveName]);
    subHeader.addEventListener('click', (e) => {
      e.stopPropagation();
      if (subExpanded) mhResultExpanded.delete(subKey); else mhResultExpanded.add(subKey);
      mhRenderList();
    });
    modBody.appendChild(subHeader);
    if (subExpanded) {
      const pluginList = el('div', { style: 'padding-left: 14px;' });
      for (const name of g.plugins) pluginList.appendChild(el('div', { class: 'muted', style: 'font-size:13px; line-height:1.7;' }, name));
      modBody.appendChild(pluginList);
    }
  });
  flats.forEach((g, idx) => {
    const subKey = `flat::${idx}`;
    const subExpanded = mhResultExpanded.has(subKey);
    const subHeader = el('div', {
      class: 'muted',
      style: 'display:flex; align-items:center; gap:7px; font-size:12px; font-weight:600; text-transform:uppercase; letter-spacing:.04em; margin:8px 0 4px; cursor:pointer;',
    }, [el('span', { style: 'font-size:10px;' }, subExpanded ? '▼' : '▶'), g.label]);
    subHeader.addEventListener('click', (e) => {
      e.stopPropagation();
      if (subExpanded) mhResultExpanded.delete(subKey); else mhResultExpanded.add(subKey);
      mhRenderList();
    });
    modBody.appendChild(subHeader);
    if (subExpanded) {
      const pluginList = el('div', { style: 'padding-left: 14px;' });
      for (const name of g.plugins) pluginList.appendChild(el('div', { class: 'muted', style: 'font-size:13px; line-height:1.7;' }, name));
      modBody.appendChild(pluginList);
      if (g.note) modBody.appendChild(el('div', { class: 'muted', style: 'font-size:12px; margin-top:2px;' }, g.note));
    }
  });
  if (archives.length || flats.length) box.appendChild(modBody);
  if (other.length) {
    const list = el('ul', { style: 'margin:6px 0 0; padding-left:18px;' });
    for (const line of other) {
      // Backend failure-line format is "<plugin> - <staging folder> - <error>" (merge-history-
      // routes.js) -- split into styled parts so the plugin name reads as the primary text and the
      // folder/error trail off muted, instead of one flat wall of same-weight white text (confirmed
      // real 2026-08-24: hard to read at a glance with several failures stacked). Falls back to the
      // raw line untouched if it doesn't match this exact shape (e.g. a future/unexpected message).
      const m = line.match(/^(.+?) - (.+?) - (.+)$/);
      if (m) {
        list.appendChild(el('li', {}, [
          el('span', {}, m[1]),
          el('span', { class: 'muted' }, ` - ${m[2]} - `),
          el('span', { class: 'muted', style: 'font-size:12.5px;' }, m[3]),
        ]));
      } else {
        list.appendChild(el('li', {}, line));
      }
    }
    box.appendChild(list);
  }
  container.appendChild(box);
}
