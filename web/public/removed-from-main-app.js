'use strict';
// Removed From Main (themed: The Unbinding / RobCo Redundancy Purge / Stage Jettison) -- front end. All real logic
// lives server-side in lib/removed-from-main.js; this file renders what the API returns and echoes back only the ids
// of the rows the player left ticked. Reference mockup: design/mockup-removed-from-main.html, Revision 3.
// Every word that changes with the theme (steps, column names, confirm line, empty states) comes from
// themes/*.json -> tools["removed-from-main"]; DEFAULT_TEXT below is the Standard theme's.

function $rfm(id) { return document.getElementById(id); }
function escHtmlRfm(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function rfmApi(method, path, body) {
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

function rfmShowCriticalError(message) {
  const el = $rfm('rfmCriticalError');
  el.innerHTML = `<div class="callout__title">🛑 Couldn't do that</div><p>${escHtmlRfm(message)}</p>`;
  el.classList.remove('hidden');
}
function rfmHideCriticalError() {
  $rfm('rfmCriticalError').classList.add('hidden');
  $rfm('rfmCriticalError').innerHTML = '';
}
// Same shared-modal error handling every other Vortex-gated tool uses (defined in shell.js).
function rfmHandleError(e, retryFn) {
  if (window.isServerUnreachableError && window.isServerUnreachableError(e)) {
    window.showServerUnreachableError(retryFn || (() => {}));
    return;
  }
  if (e.status === 409 && e.body?.error === 'bridge-unavailable') {
    window.showBridgeUnavailableModal(retryFn || (() => {}));
    return;
  }
  rfmShowCriticalError(e.message);
}

// ---- Words (theme data, with the Standard theme as the fallback) ----

const RFM_DEFAULT_TEXT = {
  howTo: ['Pick your main collection and your new collection.', 'Press Compare.', 'Untick anything you want to keep, then delete the rest.'],
  lead: 'These mods are gone from main. The mods you matched to them go too.',
  colGone: 'Gone from main',
  colMine: 'Your matching mod',
  confirm: 'They are uninstalled and deleted, and taken out of your new collection. A backup is made first.',
  empty: 'Nothing to delete. Your new collection matches main.',
  noLinks: '{rg} has not saved the matches for this pair. Open {rg}, press Save the links for this pair, then come back.',
};

function rfmThemeTool(id) {
  const t = window.activeTheme && window.activeTheme.tools && window.activeTheme.tools[id];
  return t || null;
}
function rfmText() {
  return { ...RFM_DEFAULT_TEXT, ...(rfmThemeTool('removed-from-main') || {}) };
}
function rfmRulesGeneratorName() {
  const t = rfmThemeTool('rules-generator');
  return (t && t.name) || 'Rules Generator';
}

function rfmApplyText() {
  const t = rfmText();
  $rfm('rfmHowTo').innerHTML = t.howTo.map((s) => `<li>${escHtmlRfm(s)}</li>`).join('');
  $rfm('rfmLead').textContent = t.lead;
  $rfm('rfmColGone').textContent = t.colGone;
  $rfm('rfmColMine').textContent = t.colMine;
  $rfm('rfmOpenRgBtn').textContent = `Open ${rfmRulesGeneratorName()}`;
}
window.addEventListener('themeready', rfmApplyText);
rfmApplyText();

// ---- State and stepper ----

let rfmPickers = null; // { main: [{modId, name}], mine: [{modId, name}] }
let rfmCompare = null; // the last Compare answer
let rfmTicked = new Set(); // ids of the rows left ticked
let rfmEventSource = null; // open while a real delete is running
let rfmStep = 0;

function rfmRenderStepper(activeIdx) {
  rfmStep = activeIdx;
  const steps = ['Collections', 'The list', 'Done'];
  $rfm('rfmStepper').innerHTML = steps.map((label, i) => {
    const cls = i < activeIdx ? 'done' : i === activeIdx ? 'active' : '';
    const num = i < activeIdx ? '✓' : String(i + 1);
    return `<div class="merge-step ${cls}"><b>${num}</b>${label}</div>`;
  }).join('');
}
rfmRenderStepper(0);

function rfmShowScreen(n) {
  $rfm('rfmScreen1').classList.toggle('hidden', n !== 1);
  $rfm('rfmScreen2').classList.toggle('hidden', n !== 2);
  window.scrollTo(0, 0);
}

// Which of Screen 2's pieces show: only the ones named stay visible.
function rfmShowParts({ notice = false, result = false, progress = false, list = false, buttons = [] }) {
  $rfm('rfmNotice').classList.toggle('hidden', !notice);
  $rfm('rfmResult').classList.toggle('hidden', !result);
  $rfm('rfmProgress').classList.toggle('hidden', !progress);
  $rfm('rfmListBlock').classList.toggle('hidden', !list);
  for (const id of ['rfmBackBtn', 'rfmRetryBtn', 'rfmDeleteBtn', 'rfmDoneBtn', 'rfmOpenRgBtn']) {
    $rfm(id).classList.toggle('hidden', !buttons.includes(id));
  }
}

// ---- Screen 1: the two collections ----

function rfmFillSelect(sel, items, placeholder, keep) {
  sel.innerHTML = `<option value="">${escHtmlRfm(placeholder)}</option>`
    + items.map((c) => `<option value="${escHtmlRfm(c.modId)}">${escHtmlRfm(c.name)}</option>`).join('');
  if (keep && items.some((c) => c.modId === keep)) sel.value = keep;
}

function rfmUpdateCompareEnabled() {
  const a = $rfm('rfmMainSelect').value;
  const b = $rfm('rfmNewSelect').value;
  $rfm('rfmCompareBtn').disabled = !a || !b || a === b || !!rfmEventSource;
}

async function rfmLoadPickers() {
  rfmHideCriticalError();
  $rfm('rfmLoadingText').textContent = ' Loading your collections…';
  $rfm('rfmLoading').classList.remove('hidden');
  try {
    rfmPickers = await rfmApi('GET', '/api/removed-from-main/collections');
    rfmFillSelect($rfm('rfmMainSelect'), rfmPickers.main, '-- Main collection --', $rfm('rfmMainSelect').value);
    rfmFillSelect($rfm('rfmNewSelect'), rfmPickers.mine, '-- Your new collection --', $rfm('rfmNewSelect').value);
    rfmUpdateCompareEnabled();
  } catch (e) {
    rfmHandleError(e, rfmLoadPickers);
  } finally {
    $rfm('rfmLoading').classList.add('hidden');
  }
}
window.rfmLoadPickers = rfmLoadPickers;

$rfm('rfmMainSelect').addEventListener('change', rfmUpdateCompareEnabled);
$rfm('rfmNewSelect').addEventListener('change', rfmUpdateCompareEnabled);

function rfmPickedNames() {
  const name = (sel) => sel.options[sel.selectedIndex]?.textContent || '';
  return { main: name($rfm('rfmMainSelect')), mine: name($rfm('rfmNewSelect')) };
}

async function rfmRunCompare() {
  rfmHideCriticalError();
  const mainCollectionKey = $rfm('rfmMainSelect').value;
  const newCollectionKey = $rfm('rfmNewSelect').value;
  $rfm('rfmCompareBtn').disabled = true;
  $rfm('rfmLoadingText').textContent = ' Comparing…';
  $rfm('rfmLoading').classList.remove('hidden');
  try {
    rfmCompare = await rfmApi('POST', '/api/removed-from-main/compare', { mainCollectionKey, newCollectionKey });
    rfmRenderCompare();
  } catch (e) {
    rfmHandleError(e, rfmRunCompare);
  } finally {
    $rfm('rfmLoading').classList.add('hidden');
    rfmUpdateCompareEnabled();
  }
}
$rfm('rfmCompareBtn').addEventListener('click', rfmRunCompare);

// ---- Screen 2: the list ----

function rfmRowHtml(r) {
  const note = r.alsoIn && r.alsoIn.length
    ? `<div class="muted" style="font-size:12.5px;margin-top:2px">Also in ${escHtmlRfm(r.alsoIn.map((n) => `"${n}"`).join(', '))}</div>`
    : '';
  return `<tr>
    <td><input type="checkbox" data-row="${escHtmlRfm(r.id)}" ${rfmTicked.has(r.id) ? 'checked' : ''}></td>
    <td style="color:var(--danger)">${escHtmlRfm(r.mainName)}</td>
    <td>${escHtmlRfm(r.newName)}${note}</td>
  </tr>`;
}

function rfmUpdateTickedUi() {
  const n = rfmTicked.size;
  const btn = $rfm('rfmDeleteBtn');
  btn.textContent = `Delete ${n} mod${n === 1 ? '' : 's'}`;
  btn.disabled = n === 0;
  const total = rfmCompare ? rfmCompare.rows.length : 0;
  const all = $rfm('rfmCheckAll');
  all.checked = total > 0 && n === total;
  all.indeterminate = n > 0 && n < total;
}

let rfmLastClicked = null;
function rfmWireRows() {
  const boxes = Array.from(document.querySelectorAll('#rfmRows input[data-row]'));
  boxes.forEach((cb) => {
    cb.addEventListener('click', (e) => {
      const set = (box, on) => { box.checked = on; if (on) rfmTicked.add(box.dataset.row); else rfmTicked.delete(box.dataset.row); };
      if (e.shiftKey && rfmLastClicked) {
        const from = boxes.indexOf(rfmLastClicked);
        const to = boxes.indexOf(cb);
        if (from !== -1 && to !== -1) {
          const [lo, hi] = from < to ? [from, to] : [to, from];
          for (let i = lo; i <= hi; i += 1) set(boxes[i], cb.checked);
        }
      } else {
        set(cb, cb.checked);
      }
      rfmLastClicked = cb;
      rfmUpdateTickedUi();
    });
  });
}
$rfm('rfmCheckAll').addEventListener('change', (e) => {
  rfmTicked = new Set(e.target.checked && rfmCompare ? rfmCompare.rows.map((r) => r.id) : []);
  document.querySelectorAll('#rfmRows input[data-row]').forEach((cb) => { cb.checked = rfmTicked.has(cb.dataset.row); });
  rfmUpdateTickedUi();
});

function rfmShowNotice(title, text) {
  $rfm('rfmNoticeTitle').textContent = title;
  $rfm('rfmNoticeText').textContent = text;
}

function rfmRenderCompare() {
  const c = rfmCompare;
  rfmRenderStepper(1);
  rfmShowScreen(2);
  $rfm('rfmNoticeTitle').classList.remove('hidden');
  if (c.state === 'no-links') {
    const rg = rfmRulesGeneratorName();
    rfmShowNotice('Nothing to compare yet', rfmText().noLinks.replace(/\{rg\}/g, rg));
    rfmShowParts({ notice: true, buttons: ['rfmBackBtn', 'rfmOpenRgBtn'] });
    return;
  }
  if (c.state === 'nothing') {
    rfmShowNotice('', rfmText().empty);
    $rfm('rfmNoticeTitle').classList.add('hidden');
    rfmShowParts({ notice: true, buttons: ['rfmBackBtn'] });
    return;
  }
  rfmTicked = new Set(c.rows.filter((r) => r.ticked).map((r) => r.id));
  $rfm('rfmRows').innerHTML = c.rows.map(rfmRowHtml).join('');
  rfmLastClicked = null;
  rfmWireRows();
  rfmUpdateTickedUi();
  rfmShowParts({ list: true, buttons: ['rfmBackBtn', 'rfmDeleteBtn'] });
}

function rfmBackToCollections() {
  if (rfmEventSource) return; // a real delete is still running: leave it in view
  rfmCompare = null;
  rfmTicked = new Set();
  rfmRenderStepper(0);
  rfmShowScreen(1);
  rfmUpdateCompareEnabled();
}
$rfm('rfmBackBtn').addEventListener('click', rfmBackToCollections);
$rfm('rfmDoneBtn').addEventListener('click', rfmBackToCollections);
$rfm('rfmRetryBtn').addEventListener('click', () => { rfmRenderStepper(1); rfmRunCompare(); });
$rfm('rfmOpenRgBtn').addEventListener('click', () => window.navigateToArea && window.navigateToArea('rules-generator'));

// Fires once each time the player arrives from another area (same pattern as the other tools): start clean.
function rfmResetOnEntry() {
  if (rfmEventSource) return;
  rfmHideCriticalError();
  rfmBackToCollections();
  rfmLoadPickers();
}
window.rfmResetOnEntry = rfmResetOnEntry;

// ---- Delete: confirm, then real streamed progress, then one line ----

$rfm('rfmDeleteBtn').addEventListener('click', () => {
  const n = rfmTicked.size;
  if (n === 0) return;
  $rfm('rfmConfirmTitle').textContent = `🛑 Delete ${n} mod${n === 1 ? '' : 's'} from Vortex?`;
  $rfm('rfmConfirmText').textContent = rfmText().confirm;
  $rfm('rfmConfirmModal').classList.remove('hidden');
});
$rfm('rfmConfirmCancelBtn').addEventListener('click', () => $rfm('rfmConfirmModal').classList.add('hidden'));
$rfm('rfmConfirmOkBtn').addEventListener('click', () => {
  $rfm('rfmConfirmModal').classList.add('hidden');
  rfmStartDelete();
});

function rfmSetProgress(frame) {
  const bar = $rfm('rfmProgressBar');
  const text = $rfm('rfmProgressText');
  if (frame.phase === 'deleting' && frame.total) {
    bar.style.width = `${Math.round(((frame.current - 1) / frame.total) * 100)}%`;
    text.textContent = frame.message || `Deleting ${frame.current} of ${frame.total}…`;
  } else {
    // The backup, the check and the final look have no count of their own: an honest, mostly-full bar plus the real step.
    bar.style.width = '90%';
    text.textContent = frame.message || 'Working…';
  }
}

function rfmFinishStream() {
  if (rfmEventSource) { rfmEventSource.close(); rfmEventSource = null; }
}

function rfmRenderResult(r) {
  rfmRenderStepper(2);
  const n = r.deleted || 0;
  const bad = r.failed || 0;
  const name = escHtmlRfm(r.newName || rfmPickedNames().mine);
  $rfm('rfmResult').innerHTML = `<div class="callout ${bad ? 'callout--warning' : 'callout--success'}">`
    + `<div class="callout__title">${n} mod${n === 1 ? '' : 's'} deleted from ${name}</div>`
    + (bad ? `<p>⚠️ ${bad} could not be deleted</p>` : '')
    + `</div>`;
  rfmShowParts({ result: true, buttons: bad ? ['rfmRetryBtn', 'rfmDoneBtn'] : ['rfmDoneBtn'] });
}

function rfmHandleEvent(frame) {
  if (frame.type === 'phase') {
    rfmSetProgress(frame);
  } else if (frame.type === 'done') {
    rfmFinishStream();
    rfmRenderResult(frame);
  } else if (frame.type === 'error') {
    rfmFinishStream();
    rfmShowParts({ list: true, buttons: ['rfmBackBtn', 'rfmDeleteBtn'] });
    rfmHandleError(new Error(frame.message || 'The delete failed.'), rfmStartDelete);
  }
}

async function rfmStartDelete() {
  rfmHideCriticalError();
  try {
    await rfmApi('POST', '/api/removed-from-main/delete', {
      mainCollectionKey: $rfm('rfmMainSelect').value,
      newCollectionKey: $rfm('rfmNewSelect').value,
      rowIds: [...rfmTicked],
    });
  } catch (e) {
    rfmHandleError(e, rfmStartDelete);
    return;
  }
  // The delete is now genuinely running: swap the list for the live progress.
  $rfm('rfmProgressBar').style.width = '0%';
  $rfm('rfmProgressText').textContent = 'Starting…';
  rfmShowParts({ progress: true });
  const es = new EventSource('/api/removed-from-main/delete/events');
  rfmEventSource = es;
  es.onmessage = (msg) => rfmHandleEvent(JSON.parse(msg.data));
}
