'use strict';
// Missing Masters (Utilities sub-tab) -- finds active plugins whose declared masters aren't
// actually available to the game right now, modeled on the user's real Wrye Bash workflow. See
// TECHNICAL.md's "Missing Masters" section for the full design writeup + the real Wrye Bash source
// findings this was grounded in. Reuses $g/el from cleanup-app.js (plain global functions, same
// "self-contained area, shared tiny helpers" convention already used across this project's other
// *-app.js files).
//
// Live refresh mirrors Wrye Bash's OWN real mechanism (confirmed by reading its source, NOT a
// filesystem watcher): Wrye Bash simply rescans whenever its window regains focus
// (`on_activate.subscribe(RefreshData)`). The browser equivalent is the Page Visibility API +
// window focus event -- both wired below for cross-browser reliability -- rather than a
// fs.watch/chokidar setup. No polling timer either, matching that same simplicity.

let mmLastProblemMasters = [];
let mmPendingDummyName = null;
let mmPendingRebuild = null;
// Current value of the global "Download missing archives automatically" Settings toggle, as of the
// last scan -- lets the Rebuild This Mod confirm dialog state plainly what WILL happen rather than
// hedging with "if turned on in Settings" (the answer's already known by the time it matters).
let mmDownloadMissingArchivesEnabled = false;
const MM_NEEDED_BY_TRUNCATE_AT = 3;

async function mmApi(method, path, body) {
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

function mmHandleError(e) {
  $g('mmLoading').classList.add('hidden');
  // Same convention as cleanup-app.js's cleanupHandleError -- Vortex running is a normal
  // precondition (only the new /rebuild-mod action ever hits this), not an error, so it always
  // gets the shared warning-styled popup instead of the plain critical-error box.
  if (e.status === 409 && e.body?.error === 'vortex-running') {
    window.showVortexRunningModal(() => {});
    return;
  }
  const box = $g('mmCriticalError');
  box.textContent = '';
  // fetch() itself throws a bare TypeError when it can't even reach the server (the process isn't
  // listening) -- distinct from mmApi's own Error for a real HTTP error response from a server
  // that IS running. The raw TypeError message ("Failed to fetch") is a developer-facing browser
  // exception string, not something a user can act on -- swap in a real explanation instead.
  if (e instanceof TypeError) {
    box.appendChild(el('div', { class: 'callout__title' }, '🛑 Can’t Reach the App’s Server'));
    box.appendChild(el('p', {}, 'The local server that runs this app isn’t responding right now. If you closed the window running it (or it crashed), you’ll need to start it back up—clicking Refresh alone won’t fix it until the server itself is running again.'));
  } else {
    box.textContent = e.message;
  }
  box.classList.remove('hidden');
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Master-first layout (UX-UI-DEPENDENCY-DESIGNER.md's "Badge & Highlight Table" pattern, applied
// 2026-07-27 -- see reference_ux_dependency_designer_skill memory / TECHNICAL.md for the full
// design writeup): grouping by the PROBLEM MASTER itself, not the requiring plugin, surfaces "fix
// this ONE thing, resolve N crashes" instead of repeating a widely-needed master's name once per
// dependent. Each row is color-coded by status (a tinted card, not a plain grey one) with a real
// colored icon, not just a text label -- confirmed explicitly: plain muted-grey text reads as
// visually flat/samey across a long list.
const MM_STATUS = {
  missing: { icon: '\u{1F534}', label: 'Missing', badgeClass: 'badge--critical', cardClass: 'mm-row--critical' },
  'present-but-inactive': { icon: '\u{1F7E0}', label: 'Disabled', badgeClass: 'badge--warning', cardClass: 'mm-row--warning' },
  // Not a real scan status (the master IS still absent from Data, honestly) -- an override for
  // display purposes only, used when master.readyToDeploy is true (its file was already restored
  // into a staging folder, just not deployed yet). Green/success, not red/critical: the actual fix
  // (rebuild) already succeeded -- confirmed with the user 2026-07-27 ("since this is completed,
  // turn it green") -- what's left is Vortex's own separate deploy step, not a real problem here.
  // Green circle, not the rocket -- confirmed 2026-07-27: 🔴/🟠 above are plain colored-dot emoji,
  // same shape/different color, and the badge should stay part of that same visual family (🚀 read
  // as a different shape breaking the consistency). The rocket still appears in the callout title
  // below, a different, larger context where it reads fine.
  'ready-to-deploy': { icon: '\u{1F7E2}', label: 'Pending', badgeClass: 'badge--success', cardClass: 'mm-row--success' },
};

function mmCopyNameBtn(name) {
  const btn = el('button', { class: 'btn btn--ghost btn--small' }, 'Copy name');
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(name);
      const original = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = original; }, 1500);
    } catch { /* clipboard permission denied -- silently ignore, not worth a whole error path */ }
  });
  return btn;
}

// A plugin's own MOD name (which download/mod it's actually part of) is often not obvious from its
// raw filename alone -- confirmed real-world 2026-07-27. Rendered as its own column (mm-neededby-row
// grid, mirroring mm-row__header's own name+modName columns) rather than inline text, specifically
// for readability at a glance across a long "Needed by" list. Normal weight here -- only the MASTER
// row's own mod name (mmRenderMasterRow below) is bold, matching how its filename is already bold.
function mmModNameCell(modName) {
  return el('span', { class: 'mm-modname' }, modName || '—');
}

function mmRenderNeededByRow(item) {
  return el('li', { class: 'mm-neededby-row' }, [
    el('span', {}, item.name),
    mmModNameCell(item.modName),
  ]);
}

function mmRenderNeededByList(neededBy) {
  const list = el('ul', { class: 'sync-result-list mm-neededby-list' });
  const showAll = () => {
    list.innerHTML = '';
    for (const item of neededBy) list.appendChild(mmRenderNeededByRow(item));
  };
  const showTruncated = () => {
    list.innerHTML = '';
    for (const item of neededBy.slice(0, MM_NEEDED_BY_TRUNCATE_AT)) list.appendChild(mmRenderNeededByRow(item));
    const remaining = neededBy.length - MM_NEEDED_BY_TRUNCATE_AT;
    const more = el('span', { class: 'sync-list-toggle' }, `+${remaining} more`);
    more.addEventListener('click', showAll);
    const less = el('span', { class: 'sync-list-toggle', style: 'margin-left: 10px;' }, 'Show less');
    less.addEventListener('click', showTruncated);
    list.appendChild(el('li', { class: 'sync-list-toggle-row' }, [more, ' ', less]));
  };
  if (neededBy.length > MM_NEEDED_BY_TRUNCATE_AT) showTruncated();
  else showAll();
  return list;
}

// The row's own effective status for display purposes -- readyToDeploy overrides the real
// (still-'missing') scan status, same override MM_STATUS's own comment above describes. Shared by
// the row renderer and the summary-badge filter below so both always agree on what a row "is."
function mmDisplayStatus(master) {
  return master.readyToDeploy ? 'ready-to-deploy' : master.status;
}

function mmRenderMasterRow(master) {
  const status = MM_STATUS[mmDisplayStatus(master)];
  const badge = el('span', { class: `badge ${status.badgeClass}` }, [status.icon + ' ', status.label]);
  const nameEl = el('strong', { class: 'mm-master-name' }, master.name);
  // Bold here (matching the filename right next to it) -- the master's OWN mod name is the one that
  // matters most at a glance; the needed-by list's mod names stay normal weight (mmModNameCell above).
  // No "—" placeholder for a genuinely 'missing' master specifically -- confirmed 2026-07-27: by
  // definition it has no staging folder to trace back to (that's WHY it's missing), so every single
  // 'missing' row would show the dash, every time -- pure visual noise, not information. A
  // 'present-but-inactive' master's file DOES exist on disk, so its mod name is almost always found;
  // "—" stays meaningful THERE for the rare case it genuinely isn't.
  const modNameText = master.modName || (master.status === 'missing' ? '' : '—');
  const modNameEl = el('strong', { class: 'mm-modname' }, modNameText);
  // Create Dummy Master goes BEFORE Copy name (not after) -- with the actions column right-aligned,
  // this keeps Copy name as the LAST/rightmost element on every row regardless of status, so its
  // position lines up across "missing" rows (2 buttons) and "present-but-inactive" rows (1 button)
  // alike (reported 2026-07-27: previously Copy name came first, so it visibly jumped position
  // between the two). Neither button applies once readyToDeploy is true -- the real fix (rebuild)
  // already happened; a dummy master would be actively unhelpful at that point (it would satisfy
  // Vortex's own missing-master check with a STUB instead of the real, already-restored file the
  // instant it's deployed), and Rebuild This Mod has nothing left to do either.
  const actions = [];
  if (!master.readyToDeploy && master.possibleHollowInstall) {
    const rebuildBtn = el('button', { class: 'btn btn--primary btn--small' }, 'Rebuild This Mod');
    rebuildBtn.addEventListener('click', () => mmShowRebuildConfirm(master.possibleHollowInstall, rebuildBtn));
    actions.push(rebuildBtn);
  }
  // Left of Create Dummy Master, per explicit request -- lets the user go look at (and manually fix,
  // e.g. the active-alternate .esp-vs-.esl case below) the real folder themselves, whenever we
  // actually know where it is. Not shown once readyToDeploy, same reasoning as the other two buttons.
  if (!master.readyToDeploy && master.stagingFolderPath) {
    const openBtn = el('button', { class: 'btn btn--primary btn--small' }, 'Open Staging Folder');
    openBtn.addEventListener('click', async () => {
      try {
        await mmApi('POST', '/api/missing-masters/open-staging-folder', { folderPath: master.stagingFolderPath });
      } catch (e) {
        mmHandleError(e);
      }
    });
    actions.push(openBtn);
  }
  // Points at the folder INSIDE Data itself the misplaced file was actually found in (not staging) --
  // see missing-masters-scan.js's deployedMisplaced. Shown alongside Open Staging Folder, not instead
  // of it, since the user may want to compare both.
  if (!master.readyToDeploy && master.deployedMisplaced) {
    const openDeployedBtn = el('button', { class: 'btn btn--primary btn--small' }, 'Open Deployed Folder');
    openDeployedBtn.addEventListener('click', async () => {
      try {
        await mmApi('POST', '/api/missing-masters/open-deployed-folder', { folderPath: master.deployedMisplaced.containingFolder });
      } catch (e) {
        mmHandleError(e);
      }
    });
    actions.push(openDeployedBtn);
  }
  if (!master.readyToDeploy && master.status === 'missing') {
    const btn = el('button', { class: 'btn btn--primary btn--small' }, 'Create Dummy Master');
    btn.addEventListener('click', () => mmShowCreateDummyConfirm(master.name));
    actions.push(btn);
  }
  actions.push(mmCopyNameBtn(master.name));
  const header = el('div', { class: 'mm-row__header' }, [badge, nameEl, modNameEl, el('div', { class: 'mm-row__actions' }, actions)]);

  const children = [header];
  // Confirmed genuinely useful real-world signal 2026-07-27: a "missing" master's own mod can be
  // installed and ACTIVE right now, just deployed under a different plugin filename from the same
  // mod package (an on/off pick-one-format choice some mod authors ship). This is a strong hint the
  // fix is a manual swap, not creating a dummy for something that isn't really a missing MOD at all.
  // Critical (red on red), not warning -- confirmed 2026-07-27: this sits inside a `mm-row--critical`
  // card, and per the icon-severity test ("can the user proceed at all right now?") this genuinely
  // is a hard blocker -- if left unresolved the game crashes, so 🛑 (stop sign), not ⚠️. Matches the
  // card's own red background instead of an inconsistent amber-on-red look.
  //
  // Copy corrected 2026-07-27 -- the ORIGINAL wording had this exactly backwards: it claimed
  // activeAlternate "isn't currently installed," when activeAlternate is precisely the file that
  // IS installed and active right now (that's the whole reason it's a viable "alternate" at all) --
  // master.name (this row's own title, already shown above) is the one that's actually missing.
  // Caught via a real case: 1DustAdeptArmor.esp (activeAlternate, genuinely deployed) vs.
  // 1DustAdeptArmor.esl (master.name, genuinely missing) -- the mod author shipped both formats in
  // the same staging folder, and the wrong one got deployed.
  // Deployed-but-misplaced is the most concrete, most certain diagnosis whenever it applies (the
  // file is already sitting on disk -- just one folder too deep) -- shown first, above the
  // activeAlternate/hollow-install callouts, since those are comparatively less direct fixes.
  if (master.deployedMisplaced) {
    // Prefix with "Data\" -- relPath alone (e.g. "data\1DustAdeptArmor.esl") doesn't make the
    // double-nesting obvious at a glance; showing the full "Data\data\..." makes the redundant
    // subfolder immediately visible.
    const misplacedDisplayPath = `Data\\${master.deployedMisplaced.relPath}`;
    const callout = el('div', { class: 'callout callout--critical' }, [
      el('div', { class: 'callout__title' }, '🛑 Deployed to the Wrong Folder'),
      el('p', {}, [
        el('strong', {}, master.name),
        ' already exists in your Data folder — just one level too deep, at ',
        el('strong', {}, misplacedDisplayPath),
        '. Skyrim only reads files sitting directly in Data, not inside Data’s own subfolders, so this file (and anything else in that same folder) never actually made it into the game. Click ',
        el('strong', {}, 'Open Deployed Folder'),
        ' to see it, then move everything there up into Data directly.',
      ]),
    ]);
    children.push(callout);
  }
  if (master.activeAlternate && master.activeAlternate.sameModAsMaster) {
    const callout = el('div', { class: 'callout callout--critical' }, [
      el('div', { class: 'callout__title' }, '🛑 Manual Action Needed: Wrong File Format Installed'),
      el('p', {}, [
        el('strong', {}, master.activeAlternate.name),
        ' is currently installed and active — but this mod actually needs ',
        el('strong', {}, master.name),
        ' instead. The mod author packaged both formats in the same staging folder, and the wrong one got deployed. Click ',
        el('strong', {}, 'Open Staging Folder'),
        ' to review it, then manually remove ',
        el('strong', {}, master.activeAlternate.name),
        ' and add ',
        el('strong', {}, master.name),
        ' in its place.',
      ]),
    ]);
    children.push(callout);
  } else if (master.activeAlternate && !master.activeAlternate.sameModAsMaster) {
    const callout = el('div', { class: 'callout callout--critical' }, [
      el('div', { class: 'callout__title' }, '🛑 Manual Action Needed: Name Collides With a Different Mod'),
      el('p', {}, [
        el('strong', {}, master.activeAlternate.name),
        ' is active right now, but it didn’t come from this mod — it was deployed by ',
        el('strong', {}, master.activeAlternate.modName),
        ', a separate mod that happens to share the same file name. The actual missing file, ',
        el('strong', {}, master.name),
        ', lives in ',
        el('strong', {}, master.modName),
        '’s own staging folder. Click ',
        el('strong', {}, 'Open Staging Folder'),
        ' to find and restore it — we can’t tell whether ',
        el('strong', {}, master.activeAlternate.modName),
        '’s version is meant to replace it, so that decision is yours.',
      ]),
    ]);
    children.push(callout);
  }
  // Best-effort name match against a staging folder found completely empty on disk (see
  // missing-masters-scan.js's findPossibleHollowInstall) -- shown plainly as a GUESS, not asserted
  // as fact, since it's a token-overlap heuristic rather than a confirmed match against Vortex's
  // own records. Rebuild This Mod (the button above) does the real confirming when clicked. Same
  // critical/🛑 treatment as the callout above, for the same reason: unresolved, this crashes the
  // game -- a hard blocker, not just something to tread lightly around.
  if (master.possibleHollowInstall) {
    const callout = el('div', { class: 'callout callout--critical' }, [
      el('div', { class: 'callout__title' }, '🛑 Missing Files in Staging Folder'),
      el('p', {}, [
        'The staging folder for ',
        el('strong', {}, master.possibleHollowInstall.folderName),
        ' is missing some or all of its files. You can restore it from your archive by clicking ',
        el('strong', {}, 'Rebuild This Mod'),
        '.',
      ]),
    ]);
    children.push(callout);
  }
  // Last-resort fallback for a 'missing' master with NO lead at all -- no active alternate, no
  // misplaced deploy, no hollow-install guess, nothing in staging under any name we could find.
  // Confirmed real 2026-07-28: this is exactly what happens once a mod has been removed completely
  // from Vortex (not just its files) -- the staging folder itself no longer exists (so there's no
  // hollow install to detect), and Vortex's own record of it is almost certainly gone too, so even
  // "Rebuild This Mod" would have nothing left to read a modId/fileId from. Without this callout, a
  // row like this showed nothing but a bare "Create Dummy Master" button -- that resolves the crash,
  // but says nothing about how to get the mod's real content back. Critical/🛑, same as every other
  // 'missing' callout: unresolved, this crashes the game.
  if (master.status === 'missing' && !master.readyToDeploy && !master.activeAlternate
    && !master.deployedMisplaced && !master.possibleHollowInstall) {
    const callout = el('div', { class: 'callout callout--critical' }, [
      el('div', { class: 'callout__title' }, '🛑 This Mod’s Files Are Gone'),
      el('p', {}, [
        'We can’t find ',
        el('strong', {}, master.name),
        ' anywhere — not in Data, staging, or download folders. This usually means the mod was removed completely from Vortex at some point, not just its files. If it’s part of a Vortex Collection, updating that collection should flag it as missing and offer to reinstall it for you. Otherwise, you’ll need to track it down and download it yourself from Nexus Mods, then install it through Vortex.',
      ]),
    ]);
    children.push(callout);
  }
  // A rebuild already succeeded (the file is back in staging) -- the only remaining step is Vortex
  // itself deploying it, not a real problem this app can fix any further. Green/success, matching
  // the badge override above.
  if (master.readyToDeploy) {
    const callout = el('div', { class: 'callout callout--success' }, [
      el('div', { class: 'callout__title' }, '🚀 Ready to Deploy in Vortex'),
      el('p', {}, [
        'This mod’s files are back in staging! Open Vortex and click ',
        el('strong', {}, 'Deploy Mods'),
        ' to finish moving them into your game — this will clear automatically once that’s done.',
      ]),
    ]);
    children.push(callout);
  }

  const neededByLabel = el('div', { class: 'mm-row__neededby-label' }, `Needed by ${master.neededBy.length} plugin${master.neededBy.length === 1 ? '' : 's'}`);
  children.push(neededByLabel, mmRenderNeededByList(master.neededBy));

  return el('div', { class: `mm-row ${status.cardClass}` }, children);
}

// Which status pill is currently isolated -- null shows everything. Never auto-reset by mmRender
// itself (including the silent background poll) so an active filter survives both a manual Refresh
// and a live data change -- only clearing it (clicking the active pill again, or "Show all") resets
// it, same as every other clickable-pill filter in this app.
let mmStatusFilter = null;

function mmRenderSummaryBadges() {
  const badgesEl = $g('mmSummaryBadges');
  badgesEl.innerHTML = '';
  if (mmLastProblemMasters.length === 0) return; // nothing to filter when the list itself is empty
  const counts = {};
  for (const m of mmLastProblemMasters) {
    const key = mmDisplayStatus(m);
    counts[key] = (counts[key] || 0) + 1;
  }
  // Fixed severity order (critical, warning, success) rather than Object.entries' insertion order,
  // so pills don't reshuffle position as counts change from one scan to the next.
  for (const key of ['missing', 'present-but-inactive', 'ready-to-deploy']) {
    if (!counts[key]) continue;
    const status = MM_STATUS[key];
    const active = mmStatusFilter === key;
    const badge = el('span', {
      class: `badge ${status.badgeClass} badge--clickable${active ? ' badge--filter-active' : ''}`,
      'data-status': key,
    }, [el('span', { class: 'badge__count' }, String(counts[key])), ' ' + status.label]);
    badge.addEventListener('click', () => {
      mmStatusFilter = active ? null : key;
      mmRenderSummaryBadges();
      mmRenderMasterList();
    });
    badgesEl.appendChild(badge);
  }
  const showAll = el('span', { class: `badge badge--show-all${mmStatusFilter === null ? ' badge--filter-active' : ''}` }, 'Show all');
  showAll.addEventListener('click', () => {
    mmStatusFilter = null;
    mmRenderSummaryBadges();
    mmRenderMasterList();
  });
  badgesEl.appendChild(showAll);
}

function mmRenderMasterList() {
  const container = $g('mmGroupsList');
  container.innerHTML = '';
  const visible = mmStatusFilter
    ? mmLastProblemMasters.filter((m) => mmDisplayStatus(m) === mmStatusFilter)
    : mmLastProblemMasters;
  if (visible.length === 0) {
    container.appendChild(el('p', { class: 'muted' }, `No "${MM_STATUS[mmStatusFilter].label}" masters right now.`));
    return;
  }
  for (const master of visible) container.appendChild(mmRenderMasterRow(master));
}

function mmRender(data) {
  $g('mmLoading').classList.add('hidden');
  $g('mmCriticalError').classList.add('hidden');
  $g('mmNotConfigured').classList.add('hidden');
  $g('mmResults').classList.add('hidden');

  if (!data.configured) {
    $g('mmHeaderRow').classList.add('hidden');
    $g('mmSummaryBadges').innerHTML = '';
    $g('mmNotConfigured').textContent = 'Set up your Skyrim Data folder and Plugins.txt location under Settings first.';
    $g('mmNotConfigured').classList.remove('hidden');
    return;
  }
  $g('mmHeaderRow').classList.remove('hidden');

  mmDownloadMissingArchivesEnabled = !!data.downloadMissingArchivesEnabled;
  mmLastProblemMasters = data.problemMasters || [];
  if (mmLastProblemMasters.length === 0) {
    $g('mmResultsMeta').textContent = `No missing or disabled masters found -- everything checked (${data.total} active plugin(s)) looks fine.`;
    $g('mmSummaryBadges').innerHTML = '';
    return;
  }

  const affectedPlugins = new Set();
  for (const m of mmLastProblemMasters) for (const p of m.neededBy) affectedPlugins.add(p);
  $g('mmResultsMeta').innerHTML = '';
  $g('mmResultsMeta').appendChild(el('span', { class: 'accent-count' }, String(mmLastProblemMasters.length)));
  $g('mmResultsMeta').appendChild(document.createTextNode(` problem master(s) are affecting `));
  $g('mmResultsMeta').appendChild(el('span', { class: 'accent-count' }, String(affectedPlugins.size)));
  $g('mmResultsMeta').appendChild(document.createTextNode(' plugin(s) total.'));

  mmRenderSummaryBadges();
  mmRenderMasterList();
  $g('mmResults').classList.remove('hidden');
}

// JSON snapshot of the last response actually rendered -- lets the silent background poll below
// tell "nothing changed" apart from "something changed" without a field-by-field diff. Safe as a
// straight string comparison since the backend's own ordering is already deterministic (sorted by
// neededBy.length desc then name, each neededBy array alphabetized) -- unchanged data always
// serializes identically, never a false mismatch from ordering alone.
let mmLastResponseJSON = null;

async function runMissingMastersScan() {
  $g('mmCriticalError').classList.add('hidden');
  $g('mmNotConfigured').classList.add('hidden');
  $g('mmResults').classList.add('hidden');
  $g('mmLoading').classList.remove('hidden');
  try {
    const data = await mmApi('GET', '/api/missing-masters/scan');
    mmLastResponseJSON = JSON.stringify(data);
    mmRender(data);
  } catch (e) {
    mmHandleError(e);
  }
}

$g('mmRefreshBtn').addEventListener('click', () => runMissingMastersScan());

// Silent counterpart used only by the background poll below -- confirmed real annoyance
// 2026-07-27: the visible version above always blanks the results and shows a loading spinner
// before redrawing, which on a 5s timer reads as constant screen-flashing even when nothing on
// disk actually changed. This fetches quietly (no loading state touched at all) and only calls
// mmRender -- the one thing that actually redraws the DOM -- when the response genuinely differs
// from what's already on screen. A fetch failure here is also silent (console-only): a background
// poll hiccup shouldn't interrupt whatever the user is looking at; the visible Refresh/focus paths
// above still surface a real error if something is actually wrong.
async function pollMissingMastersScanSilently() {
  let data;
  try {
    data = await mmApi('GET', '/api/missing-masters/scan');
  } catch (e) {
    console.error('Missing Masters background poll failed:', e.message);
    return;
  }
  const json = JSON.stringify(data);
  if (json === mmLastResponseJSON) return; // no change -- skip the render, zero visual disturbance
  mmLastResponseJSON = json;
  mmRender(data);
}

// ---------- Create Dummy Master ----------

function mmShowCreateDummyConfirm(name) {
  mmPendingDummyName = name;
  const container = $g('mmCreateDummyConfirmModalText');
  container.innerHTML = '';
  container.appendChild(document.createTextNode(`This creates a lightweight placeholder file named "${name}". To finish resolving this:`));
  container.appendChild(el('ol', {}, [
    el('li', {}, 'Install it as a mod in Vortex.'),
    el('li', {}, "Make sure it's active."),
  ]));
  $g('mmCreateDummyConfirmModal').classList.remove('hidden');
}
$g('mmCreateDummyConfirmCancelBtn').addEventListener('click', () => {
  $g('mmCreateDummyConfirmModal').classList.add('hidden');
});
$g('mmCreateDummyConfirmOkBtn').addEventListener('click', async () => {
  $g('mmCreateDummyConfirmModal').classList.add('hidden');
  const name = mmPendingDummyName;
  try {
    await mmApi('POST', '/api/missing-masters/create-dummy-master', { name });
    await runMissingMastersScan();
  } catch (e) {
    mmHandleError(e);
  }
});

// ---------- Rebuild This Mod (single-mod repair, shares Rebuild Collection's own engine) ----------

// The row's own "Rebuild This Mod" button that opened this modal -- kept disabled with a spinner
// for the whole operation (confirmed real 2026-07-28: a large archive download over a slow
// connection can take minutes, and with no feedback at all the button just looked frozen/dead).
// Reset back to normal on failure; on success the row gets fully rebuilt by the rescan anyway, so
// this stale reference is simply discarded rather than needing its own reset.
let mmPendingRebuildBtn = null;

function mmShowRebuildConfirm(hollowInstall, triggerBtn) {
  mmPendingRebuild = hollowInstall;
  mmPendingRebuildBtn = triggerBtn || null;
  const modName = hollowInstall.modName || hollowInstall.folderName;
  const p = $g('mmRebuildConfirmModalText');
  p.textContent = '';
  // Stated as plain fact, not hedged with "if turned on in Settings" -- confirmed real 2026-07-28:
  // by the time this dialog is shown, we already know the answer (mmDownloadMissingArchivesEnabled,
  // set from the scan response), so there's no reason to make the user hold two conditions in their
  // head. If the setting's off, this mod's own saved archive (already in Downloads) still restores
  // into staging just fine -- downloading is only ever needed when that archive is ALSO missing.
  if (mmDownloadMissingArchivesEnabled) {
    p.appendChild(document.createTextNode('This downloads '));
    p.appendChild(el('strong', {}, modName));
    p.appendChild(document.createTextNode('’s archive and reinstalls it into your staging folder.'));
  } else {
    p.appendChild(document.createTextNode('This restores '));
    p.appendChild(el('strong', {}, modName));
    p.appendChild(document.createTextNode('’s files into your staging folder from its saved archive.'));
  }
  $g('mmRebuildConfirmModal').classList.remove('hidden');
}
$g('mmRebuildConfirmCancelBtn').addEventListener('click', () => {
  $g('mmRebuildConfirmModal').classList.add('hidden');
});
// Several distinct explanations depending on why this stopped short, same convention Rebuild
// Collection's own UI already uses for this exact split (Retry Download/Import vs. a real
// extraction failure) -- a generic "Status: SKIP_NO_ARCHIVE" dump isn't actionable. Checked in order
// from most to least specific (see rebuild-single-mod.js for where each field comes from):
//   1. downloadSkipped/downloadError -- a download was actually ATTEMPTED and didn't work out.
//   2. canAutoDownload && !autoDownloadEnabled -- no download was attempted only because the
//      Settings toggle is off (confirmed real 2026-07-28: this needs its OWN message, distinct from
//      "not Premium," since the fix is different -- turn the setting on, not upgrade the account).
//   3. plain "archive wasn't found" -- covers an off-site (non-Nexus) mod, which can never be
//      auto-downloaded regardless of the setting.
function mmDescribeRebuildFailure(result) {
  if (result.downloadSkipped === 'not-premium') {
    return 'This mod’s archive is missing, and automatic downloading is turned on — but this Nexus account isn’t Premium, so automated downloads aren’t available (this respects Nexus’s ad-supported download model for free accounts). Download the archive yourself from either within Vortex or on Nexus’s website to reinstall it.';
  }
  if (result.downloadError) {
    return `We tried downloading this mod’s archive from Nexus automatically, but it failed: ${result.downloadError}. This may just be a network hiccup — try Rebuild This Mod again, or download the archive yourself from Nexus and reinstall it through Vortex.`;
  }
  if ((result.kind === 'SKIP_NO_ARCHIVE' || result.status === 'SKIP_NO_ARCHIVE') && result.canAutoDownload && !result.autoDownloadEnabled) {
    return 'This mod’s archive is missing, and automatic downloading is turned off, so we couldn’t download it for you. Turn on Download missing archives automatically under Settings and try again, or download the archive yourself from Nexus and reinstall it through Vortex.';
  }
  if (result.kind === 'SKIP_NO_ARCHIVE' || result.status === 'SKIP_NO_ARCHIVE') {
    return 'This mod’s archive wasn’t found in your Downloads folder. Reinstall the mod through Vortex to restore the archive, then try Rebuild This Mod again.';
  }
  if (result.kind === 'SKIP_OPEN_FOMOD') {
    return 'This mod’s installer needs choices that weren’t recorded. Reinstall it through Vortex instead.';
  }
  return result.detail || `We couldn’t finish this: ${result.status || result.kind}.`;
}
// Resets the triggering row button back to its normal, clickable state -- called on every failure
// path below (the success path never needs this, since a completed rebuild always triggers a
// rescan that rebuilds the row from scratch anyway).
function mmResetRebuildBtn() {
  if (!mmPendingRebuildBtn) return;
  mmPendingRebuildBtn.disabled = false;
  mmPendingRebuildBtn.textContent = 'Rebuild This Mod';
}

// Shows a rebuild failure right on the row itself, ABOVE the existing critical callout that's
// already sitting there ("Missing Files in Staging Folder") -- confirmed real 2026-07-28: a
// top-of-page box was reported as "nothing happened" three separate times, since "Rebuild This Mod"
// can sit far down a long problem-master list and the box rendered off-screen above the user's
// scroll position. This mod's own row is exactly where the user is already looking, so the message
// belongs there instead. Inserted as its OWN new callout rather than overwriting the existing one --
// confirmed real 2026-07-28: overwriting it lost the folder-name reference the original message
// gave, which is still useful context alongside the failure explanation, not a replacement for it.
function mmShowRebuildFailureOnRow(btn, title, message) {
  const row = btn && btn.closest('.mm-row');
  const existingCallout = row && row.querySelector('.callout--critical');
  if (!existingCallout) return false; // shouldn't happen -- Rebuild This Mod only shows alongside one
  // Remove any failure callout from a previous attempt first -- a retry shouldn't stack a second
  // copy on top of the first.
  const previous = row.querySelector('.mm-row__rebuild-failure');
  if (previous) previous.remove();
  const callout = el('div', { class: 'callout callout--critical mm-row__rebuild-failure' }, [
    el('div', { class: 'callout__title' }, title),
    el('p', {}, message),
  ]);
  existingCallout.insertAdjacentElement('beforebegin', callout);
  return true;
}
$g('mmRebuildConfirmOkBtn').addEventListener('click', async () => {
  $g('mmRebuildConfirmModal').classList.add('hidden');
  const hollowInstall = mmPendingRebuild;
  if (mmPendingRebuildBtn) {
    mmPendingRebuildBtn.disabled = true;
    mmPendingRebuildBtn.innerHTML = '';
    mmPendingRebuildBtn.appendChild(el('span', { class: 'spinner' }));
    mmPendingRebuildBtn.appendChild(document.createTextNode(mmDownloadMissingArchivesEnabled ? ' Downloading…' : ' Restoring…'));
  }
  try {
    const result = await mmApi('POST', '/api/missing-masters/rebuild-mod', { vortexModId: hollowInstall.vortexModId });
    if (result.status !== 'REBUILT') {
      // Nothing changed on disk when this failed -- runMissingMastersScan() would otherwise wipe
      // whatever we show here on its own very first line (confirmed real 2026-07-27: reported as
      // "clicked Rebuild This Mod, nothing happened, no error, no warning"). Return here instead of
      // falling through to that rescan -- there's nothing new to show anyway.
      const shown = mmShowRebuildFailureOnRow(mmPendingRebuildBtn, '🛑 Rebuild Didn’t Complete', mmDescribeRebuildFailure(result));
      if (!shown) {
        // Fallback -- shouldn't normally happen, but never fail silently if the row's own callout
        // can't be found for some reason.
        const box = $g('mmCriticalError');
        box.textContent = '';
        box.appendChild(el('div', { class: 'callout__title' }, '🛑 Rebuild Didn’t Complete'));
        box.appendChild(el('p', {}, mmDescribeRebuildFailure(result)));
        box.classList.remove('hidden');
        box.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
      mmResetRebuildBtn();
      return;
    }
    await runMissingMastersScan();
  } catch (e) {
    mmResetRebuildBtn();
    mmHandleError(e);
  }
});

// ---------- Background auto-refresh polling ----------
// Originally paired with a focus/visibilitychange-triggered refresh mirroring Wrye Bash's own
// "rescan when the window regains focus" mechanism -- REMOVED 2026-07-27 (real annoyance): that
// listener fired the full, visible runMissingMastersScan() (loading spinner + list teardown) every
// time the BROWSER TAB regained focus, including something as small as alt-tabbing away to copy
// text and back -- disruptive, and now genuinely redundant. This poll already keeps the view
// current continuously (Chrome's Page Visibility API tracks TAB visibility, not OS-level window
// focus -- switching to a different application while this tab stays open on screen doesn't set
// `document.hidden`, so the poll keeps running the whole time regardless), so there's no freshness
// gained by also forcing a visible reload on refocus. Switching sub-tabs WITHIN the app still gets a
// full visible scan on its own, via showUtilitiesSubTab's own call to runMissingMastersScan().
//
// Scanning is cheap (~150ms for ~3500 active plugins, already benchmarked live against the user's
// real install), so a 5s interval is safe. Only ticks while this sub-tab is actually visible AND the
// browser tab itself isn't backgrounded/minimized -- no point burning cycles rescanning a view
// nobody's looking at. Uses the SILENT poll (pollMissingMastersScanSilently), not
// runMissingMastersScan -- confirmed real annoyance the same day: the visible version blanks the
// list and shows a loading spinner on every call, which at a 5s cadence read as the screen
// constantly flashing even when nothing had actually changed. The silent version only touches the
// DOM when the response genuinely differs.
function mmIsSubTabVisible() {
  const area = $g('area-utilities');
  const subArea = $g('utilities-sub-area-missingmasters');
  return area && !area.classList.contains('hidden') && subArea && !subArea.classList.contains('hidden');
}
const MM_POLL_INTERVAL_MS = 5000;
setInterval(() => {
  if (!document.hidden && mmIsSubTabVisible()) pollMissingMastersScanSilently();
}, MM_POLL_INTERVAL_MS);
