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
// The scan's own active-plugin count, kept for the all-clear banner's "Checked N active plugins".
let mmLastTotal = 0;
let mmPendingDummyName = null;
let mmPendingRebuild = null;
// Current value of the global "Download missing archives automatically" Settings toggle, as of the
// last scan -- lets the Rebuild This Mod confirm dialog state plainly what WILL happen rather than
// hedging with "if turned on in Settings" (the answer's already known by the time it matters).
let mmDownloadMissingArchivesEnabled = false;
// ESLifier awareness -- current persisted "Recognize ESLifier output" toggle value, and whether an
// output folder is even configured for it to match against (see Settings' own eslifierOutputDir
// field). Both set fresh from every /scan response, same convention as
// mmDownloadMissingArchivesEnabled above.
let mmRecognizeEslifierEnabled = true;
let mmEslifierOutputDirConfigured = false;
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

// retryFn (queue: vortex-retry-noop-sweep): same fix as rebuild-missing-app.js's own rmfHandleError
// (b3eb0c7) -- Try Again used to always call a hardcoded no-op here too.
function mmHandleError(e, retryFn) {
  $g('mmLoading').classList.add('hidden');
  // Same convention as cleanup-app.js's cleanupHandleError -- Vortex running is a normal
  // precondition (only the /rebuild-mod action actually gates on it today -- confirmed via
  // missing-masters-routes.js, none of this file's other actions call vortexRunningGate -- but
  // every call site below still passes a real retry regardless, for correctness if that ever
  // changes), not an error, so it always gets the shared warning-styled popup instead of the plain
  // critical-error box.
  if (e.status === 409 && e.body?.error === 'vortex-running') {
    window.showVortexRunningModal(retryFn || (() => {}));
    return;
  }
  const box = $g('mmCriticalError');
  box.textContent = '';
  // fetch() itself throws a bare TypeError when it can't even reach the server (the process isn't
  // listening) -- distinct from mmApi's own Error for a real HTTP error response from a server
  // that IS running. The raw TypeError message ("Failed to fetch") is a developer-facing browser
  // exception string, not something a user can act on -- swap in a real explanation instead.
  if (e instanceof TypeError) {
    box.appendChild(el('div', { class: 'callout__title' }, '🛑 Can’t Reach Local Server'));
    box.appendChild(el('p', {}, [
      'The app’s local server isn’t responding. If the server window was closed or crashed, restart it to continue. Clicking ',
      el('strong', {}, 'Refresh'),
      ' won’t work until the server is running again.',
    ]));
  } else {
    box.innerHTML = '';
    box.appendChild(el('div', { class: 'callout__title' }, '🛑 Couldn\'t load missing masters'));
    box.appendChild(el('p', {}, e.message));
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
  // Recognized ESLifier swap -- a calmer, muted tier BELOW warning (see mmDisplayStatus below for
  // when this applies). White circle, not a colored one -- confirmed real-world precedent above
  // (ready-to-deploy's own comment): same dot SHAPE as the other three keeps the visual family
  // consistent, while white/muted (not red/amber/green) signals "acknowledged, not a severity."
  'eslifier-swap': { icon: '\u{26AA}', label: 'ESLifier', badgeClass: 'badge--neutral', cardClass: 'mm-row--soft' },
};

function mmCopyNameBtn(name) {
  const btn = el('button', { class: 'btn btn--ghost btn--small' }, 'Copy Name');
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
function mmIsEslifierSwap(master) {
  return mmRecognizeEslifierEnabled && !!(master.activeAlternate && master.activeAlternate.eslifierSwap);
}

function mmDisplayStatus(master) {
  if (master.readyToDeploy) return 'ready-to-deploy';
  if (mmIsEslifierSwap(master)) return 'eslifier-swap';
  return master.status;
}

// Whenever the ESLifier soft tier applies, there's genuinely nothing left to fix (same reasoning as
// readyToDeploy suppressing these same actions below) -- offering "Create Dummy Master" or "Open
// Staging Folder" right next to a callout that says "nothing to fix" would read as a contradiction.
function mmActionsSuppressed(master) {
  return master.readyToDeploy || mmIsEslifierSwap(master);
}

// Turns the plugin back on in Vortex, then moves the row into the state that already means exactly
// this: ready-to-deploy. Deliberately does NOT re-run the scan -- /scan reads plugins.txt, which
// Vortex only rewrites during a real deploy, so a re-scan would still report Disabled and look
// broken. The route's own response is the truth (setPluginEnabled self-verifies against Vortex's own
// before/after readback), so the row is updated from that.
//
// Only the BUTTON changes while in flight. An earlier draft also swapped the mod name for a status
// line; the director cut it -- on a single-row action it says the same thing twice and costs you the
// mod name while you're reading it.
async function mmEnablePlugin(master, btn) {
    btn.disabled = true;
    btn.textContent = 'Enabling\u2026';
    try {
        await mmApi('POST', '/api/missing-masters/set-plugin-enabled', { name: master.name });
        master.readyToDeploy = true;
        mmLocallyFixed.set(master.name, 'enabled');
        // Marks HOW this row reached ready-to-deploy, purely so its callout can open with an accurate
        // sentence -- see the callout below. Nothing else branches on it.
        master.enabledViaHelper = true;
        mmRenderSummaryBadges(); // its counts are per display-status, which just changed for this row
        mmRenderMasterList();
        mmRenderDeployBanners(); // this row is now ready-to-deploy, so there's a deploy worth offering
    } catch (e) {
        btn.disabled = false;
        btn.textContent = 'Enable';
        mmShowRowEnableError(btn);
    }
}

// On the row, where the user is already looking -- not a modal. Replaces any previous attempt's note
// rather than stacking them up on repeated clicks.
function mmShowRowEnableError(btn) {
    // Same closest('.mm-row') idiom this file already uses elsewhere to get from a button back to its
    // own row -- no data attribute needed. The button is still in the DOM here: the failure path
    // deliberately doesn't re-render, so the row (and the user's place on the page) is untouched.
    const row = btn.closest('.mm-row');
    if (!row) return;
    const existing = row.querySelector('.mm-row__enable-error');
    if (existing) existing.remove();
    row.appendChild(el('div', { class: 'callout callout--warning mm-row__enable-error' }, [
        el('div', { class: 'callout__title' }, '\u26a0\ufe0f Couldn\u2019t enable plugin'),
        el('p', {}, 'Vortex does not have this plugin in your load order yet. Make sure its parent mod is installed and deployed in Vortex, then try again.'),
    ]));
}

// ---------- Deploy (2026-08-23) ----------
// Fixing anything here updates staging and Vortex's own settings, but the GAME sees none of it until
// a deploy runs. So this is the step that makes Enable (and, later, Restore) actually take effect --
// not a convenience.
//
// "Pending fixes" is detected from the rows themselves: any master currently displaying as
// ready-to-deploy. Nothing new is tracked -- that state already exists and already means precisely
// "fixed, but Vortex hasn't deployed it yet", whether it got there from this session's own Enable or
// from the scan finding a rebuilt-but-undeployed mod. Reuses mmDisplayStatus so it can never disagree
// with what the badge on the row says.
function mmPendingDeployCount() {
  return mmLastProblemMasters.filter((m) => mmDisplayStatus(m) === 'ready-to-deploy').length;
}

// The three result-level banners are decided together, in one place, because they're mutually
// exclusive and deciding them separately is how two of them end up on screen at once.
function mmRenderDeployBanners() {
  const allClear = $g('mmAllClear');
  const pending = $g('mmPendingDeploy');
  const tip = $g('mmDeployTip');
  const helperUp = mmHelperStatus === MM_HELPER_AVAILABLE;
  const pendingCount = mmPendingDeployCount();

  // The fallback instruction, and ONLY when we genuinely know the Helper is missing -- not while the
  // probe is still in flight ('unknown'), which would flash it and then pull it away.
  tip.classList.toggle('hidden', mmHelperStatus !== MM_HELPER_UNAVAILABLE);

  // Nothing wrong at all AND nothing waiting on a deploy.
  const showAllClear = mmLastProblemMasters.length === 0 && pendingCount === 0;
  allClear.classList.toggle('hidden', !showAllClear);
  if (showAllClear) {
    allClear.innerHTML = '';
    allClear.appendChild(el('div', { class: 'callout__title' }, '\u2705 No more missing masters \u2014 happy gaming!'));
    allClear.appendChild(el('p', {}, [
      'Checked ',
      el('strong', {}, mmLastTotal === 1 ? '1 active plugin' : `${mmLastTotal} active plugins`),
      ' and found no missing or disabled masters. Everything is in place.',
    ]));
  }

  // Only offered when the Helper can actually run it -- without it the tip above already says the
  // same thing in the form the user can act on.
  const showPending = pendingCount > 0 && helperUp && !mmDeployInFlight;
  pending.classList.toggle('hidden', !showPending);
  if (showPending) {
    pending.innerHTML = '';
    pending.appendChild(el('div', { class: 'callout__title' }, '\ud83d\ude80 Fixes applied \u2014 one step left'));
    pending.appendChild(el('p', {}, 'Your missing masters are resolved and enabled in Vortex, but your game cannot see them yet. Deploy your mods to finish setup.'));
    const btn = el('button', { class: 'btn btn--primary btn--small' }, 'Deploy Mods');
    btn.addEventListener('click', () => mmDeployAll());
    pending.appendChild(el('div', { class: 'row-actions' }, btn));
  }
}

let mmDeployInFlight = false;
let mmDeployPollInterval = null;

function mmStopDeployPolling() {
  if (mmDeployPollInterval) {
    clearInterval(mmDeployPollInterval);
    mmDeployPollInterval = null;
  }
}

function mmShowDeployResult(kind) {
  const box = $g('mmDeployResult');
  box.classList.remove('hidden');
  box.className = `callout callout--${kind === 'success' ? 'success' : 'warning'}`;
  box.innerHTML = '';
  if (kind === 'success') {
    box.appendChild(el('div', { class: 'callout__title' }, '\u2705 Deploy complete \u2014 your game is ready to launch.'));
    return;
  }
  box.appendChild(el('div', { class: 'callout__title' }, '\u26a0\ufe0f Deploy failed'));
  box.appendChild(el('p', {}, 'Vortex could not complete the deployment. You can try again from here, or open Vortex and click Deploy Mods directly.'));
  const retry = el('button', { class: 'btn btn--primary btn--small' }, 'Retry Deploy');
  retry.addEventListener('click', () => mmDeployAll());
  box.appendChild(el('div', { class: 'row-actions' }, retry));
}

// Real progress, polled from Vortex's own deploy status -- not a fake animation. A deploy on a large
// setup is genuinely slow (minutes), which is exactly why this project's standing rule is that a real
// action shows itself happening rather than freezing behind a static label.
async function mmDeployAll() {
  mmDeployInFlight = true;
  $g('mmDeployResult').classList.add('hidden');
  mmRenderDeployBanners(); // hides the "one step left" banner while its own action is running
  $g('mmDeployProgress').classList.remove('hidden');
  $g('mmDeployPhase').textContent = 'Starting\u2026';
  $g('mmDeployBar').style.width = '0%';

  try {
    await mmApi('POST', '/api/missing-masters/deploy-all', {});
  } catch (e) {
    mmDeployInFlight = false;
    $g('mmDeployProgress').classList.add('hidden');
    mmShowDeployResult('error');
    mmRenderDeployBanners();
    return;
  }

  mmStopDeployPolling();
  mmDeployPollInterval = setInterval(async () => {
    let progress;
    try {
      progress = await mmApi('GET', '/api/missing-masters/deploy-all/progress');
    } catch {
      return; // one failed poll is not evidence the deploy failed -- try again next tick
    }
    if (progress && typeof progress.percent === 'number') {
      $g('mmDeployBar').style.width = `${Math.round(progress.percent)}%`;
    }
    if (progress && progress.text) $g('mmDeployPhase').textContent = progress.text;
    if (!progress || !progress.done) return;

    mmStopDeployPolling();
    mmDeployInFlight = false;
    $g('mmDeployProgress').classList.add('hidden');
    if (progress.error) {
      mmShowDeployResult('error');
      mmRenderDeployBanners();
      return;
    }
    mmShowDeployResult('success');
    mmLocallyFixed.clear(); // the deploy ran -- the scan is the authority again
    // Unlike the Enable path (which deliberately doesn't re-scan), a re-scan here is both correct and
    // necessary: a real deploy genuinely reconciles Data and plugins.txt, so the scan is now the
    // authority, and rows that were only Pending are done. Without this the page would keep claiming
    // a step remains after the step was taken.
    runMissingMastersScan();
  }, 1000);
}

// ---------- Restore a mod whose files are gone entirely (2026-08-23) ----------
// The precise row this applies to. Everything else with status 'missing' has a more specific, better
// fix already on the row: readyToDeploy is done, activeAlternate/deployedMisplaced are manual swaps,
// and possibleHollowInstall is Rebuild This Mod's job (staging still exists there, and Vortex still
// has the record to resolve an archive from). Restore is for the case where all of that is gone.
function mmCanRestore(master) {
  return master.status === 'missing'
    && !master.readyToDeploy
    && !master.activeAlternate
    && !master.deployedMisplaced
    && !master.possibleHollowInstall;
}

let mmRestorePending = null; // { master, match, btn }

// Masters this SESSION fixed itself, by name -> how. Re-applied after every render, because the
// 5s background poll replaces mmLastProblemMasters wholesale with fresh scan data and would
// otherwise wipe the Pending state right back to a red "Missing" a few seconds after a successful
// fix. That is not a cosmetic race: for a restore the scan genuinely still reports 'missing' until a
// deploy runs (it reads Data, and the files are in staging), and it cannot set readyToDeploy itself
// either -- the staging index only looks at a mod folder's root and a Data/ subfolder, so a plugin
// restored into a FOMOD option folder like "00 Core\" is invisible to it. Confirmed live against a
// real restore. Cleared only by a real deploy, which is when the scan finally agrees.
const mmLocallyFixed = new Map();

function mmApplyLocalFixes() {
  for (const m of mmLastProblemMasters) {
    const how = mmLocallyFixed.get(m.name);
    if (!how) continue;
    m.readyToDeploy = true;
    if (how === 'restored') m.restoredViaHelper = true;
    else m.enabledViaHelper = true;
  }
}

function mmBytes(n) {
  if (!n && n !== 0) return '—';
  const mb = n / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}
function mmDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// Replaces any previous note on this row rather than stacking them across repeated attempts.
function mmRowNote(btn, kind, title, bodyChildren, buttons) {
  const row = btn.closest('.mm-row');
  if (!row) return;
  const existing = row.querySelector('.mm-row__restore-note');
  if (existing) existing.remove();
  const note = el('div', { class: `callout callout--${kind} mm-row__restore-note` }, [
    el('div', { class: 'callout__title' }, title),
    el('p', {}, bodyChildren),
  ]);
  if (buttons && buttons.length) note.appendChild(el('div', { class: 'row-actions' }, buttons));
  row.appendChild(note);
}

// The four empty-index outcomes. Three of them are NOT "not found", and saying "not found" for any
// of them would be a lie the user acts on -- the third especially: the index only covers file types
// the user chose and defaults to .esp only, so a perfectly healthy index genuinely finds nothing for
// a .esm master.
function mmRenderRestoreSearchState(master, btn, data) {
  if (data.state === 'not-configured') {
    const open = el('button', { class: 'btn btn--primary btn--small' }, 'Open Settings');
    open.addEventListener('click', () => window.navigateToArea && window.navigateToArea('settings'));
    mmRowNote(btn, 'info', '\u2139\ufe0f Archive Finder isn\u2019t set up yet',
      ['To search inside your downloaded archives, Archive Finder needs a folder to keep its index in. Set one in ', el('strong', {}, 'Settings'), ' and come back.'],
      [open]);
    return;
  }
  if (data.state === 'not-scanned') {
    const scan = el('button', { class: 'btn btn--primary btn--small' }, 'Scan Downloads Now');
    scan.addEventListener('click', () => mmStartArchiveScan(null));
    mmRowNote(btn, 'info', '\u2139\ufe0f Archive index is empty',
      ['The Archive Finder has not indexed your downloads folder yet. Run a scan so Missing Masters can search your archive contents. On larger download folders, this takes a few minutes.'],
      [scan]);
    return;
  }
  if (data.state === 'ext-not-indexed') {
    const add = el('button', { class: 'btn btn--primary btn--small' }, 'Add File Type and Re-scan');
    add.addEventListener('click', () => mmStartArchiveScan(data.ext));
    const dismiss = el('button', { class: 'btn btn--ghost btn--small' }, 'Dismiss');
    dismiss.addEventListener('click', () => {
      const row = btn.closest('.mm-row');
      const note = row && row.querySelector('.mm-row__restore-note');
      if (note) note.remove();
    });
    mmRowNote(btn, 'info', '\u2139\ufe0f File type not included in archive index',
      ['Your archive index only searches specific file types (like ', el('code', {}, '.esp'), '). This missing master is a ',
        el('code', {}, data.ext), ' file, so it was skipped during your last scan. You can add this file type and re-scan your downloads folder now. On larger folders, this takes a few minutes.'],
      [add, dismiss]);
    return;
  }
  mmRowNote(btn, 'warning', '\u26a0\ufe0f Mod not found in downloaded archives',
    ['We checked your archive index, but this file is not in any of your downloaded mods. You will need to download it again from Nexus Mods and install it through Vortex.'],
    []);
}

// Adds the extension to Archive Finder's own configured list (when asked) and kicks off ITS scan,
// then hands the user over to that tool to watch it. Deliberately not a second scan implementation --
// Archive Finder owns indexing, and duplicating it here is how the two drift apart.
async function mmStartArchiveScan(extToAdd) {
  try {
    if (extToAdd) {
      const cfg = await mmApi('GET', '/api/archive-finder/config');
      const extensions = [...new Set([...(cfg.extensions || []), extToAdd])];
      await mmApi('POST', '/api/archive-finder/config', { outputFolder: cfg.outputFolder, extensions });
    }
    await mmApi('POST', '/api/archive-finder/scan', {});
  } catch (e) {
    mmHandleError(e);
    return;
  }
  // Archive Finder is a Utilities SUB-area, not a top-level one -- navigateToArea(area, sub).
  if (window.navigateToArea) window.navigateToArea('utilities', 'archivefinder');
}

async function mmStartRestore(master, btn) {
  btn.disabled = true;
  btn.textContent = 'Searching your downloaded archives\u2026';
  let data;
  try {
    data = await mmApi('GET', `/api/missing-masters/restore/search?name=${encodeURIComponent(master.name)}`);
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Restore';
    mmHandleError(e, () => mmStartRestore(master, btn));
    return;
  }
  btn.disabled = false;
  btn.textContent = 'Restore';
  if (data.state !== 'matches') {
    mmRenderRestoreSearchState(master, btn, data);
    return;
  }
  if (data.matches.length === 1) {
    mmShowRestoreConfirm(master, data.matches[0], btn); // one match -- no chooser to show
    return;
  }
  mmShowRestoreChooser(master, data.matches, btn);
}

function mmShowRestoreChooser(master, matches, btn) {
  const list = $g('mmRestoreChooserList');
  list.innerHTML = '';
  matches.forEach((m, i) => {
    const radio = el('input', { type: 'radio', name: 'mmRestoreChoice' });
    radio.checked = i === 0; // newest first, per the sort server-side
    radio._match = m;
    const meta = [
      m.version ? `v${m.version}` : null,
      mmDate(m.downloadedAt),
      mmBytes(m.size),
      `${m.fileCount} file${m.fileCount === 1 ? '' : 's'}`,
      m.onDisk ? null : 'no longer on disk',
    ].filter(Boolean).join(' \u00b7 ');
    list.appendChild(el('label', { class: 'mm-restore-choice' }, [
      radio,
      el('div', {}, [
        el('div', { class: 'mm-restore-choice__name' }, [m.archiveName, i === 0 ? el('span', { class: 'badge badge--success' }, ' Newest') : null]),
        el('div', { class: 'mm-restore-choice__meta' }, meta),
      ]),
    ]));
  });
  mmRestorePending = { master, match: matches[0], btn };
  $g('mmRestoreChooserModal').classList.remove('hidden');
}

function mmShowRestoreConfirm(master, match, btn) {
  mmRestorePending = { master, match, btn };
  // The staging folder name a restored mod gets. Derived from the archive's own filename, matching
  // how Vortex names a staging folder from the download it came from.
  const targetFolderName = match.archiveName.replace(/\.(zip|7z|rar)$/i, '');
  mmRestorePending.targetFolderName = targetFolderName;
  const summary = $g('mmRestoreConfirmSummary');
  summary.innerHTML = '';
  summary.appendChild(el('dt', {}, 'From archive'));
  summary.appendChild(el('dd', {}, match.archiveName));
  summary.appendChild(el('dt', {}, 'Extract to'));
  summary.appendChild(el('dd', {}, [targetFolderName, ' ', el('span', { class: 'badge badge--success' }, 'New folder')]));
  summary.appendChild(el('dt', {}, 'Then'));
  summary.appendChild(el('dd', {}, 'Added to Vortex and enabled'));
  $g('mmRestoreConfirmModal').classList.remove('hidden');
}

async function mmDoRestore() {
  $g('mmRestoreConfirmModal').classList.add('hidden');
  const { master, match, targetFolderName } = mmRestorePending || {};
  if (!master) return;
  $g('mmRestoreResult').classList.add('hidden');
  $g('mmRestoreProgress').classList.remove('hidden');
  $g('mmRestoreProgressTitle').textContent = 'Extracting mod files from archive\u2026';
  $g('mmRestorePhase').textContent = 'Starting\u2026';
  $g('mmRestoreBar').style.width = '0%';
  try {
    await mmApi('POST', '/api/missing-masters/restore', { name: master.name, archivePath: match.archivePath, targetFolderName });
  } catch (e) {
    $g('mmRestoreProgress').classList.add('hidden');
    mmHandleError(e, mmDoRestore);
    return;
  }
  const poll = setInterval(async () => {
    let p;
    try {
      p = await mmApi('GET', '/api/missing-masters/restore/progress');
    } catch {
      return; // one failed poll is not evidence the restore failed
    }
    if (typeof p.percent === 'number') $g('mmRestoreBar').style.width = `${p.percent}%`;
    if (p.text) {
      $g('mmRestoreProgressTitle').textContent = p.text;
      $g('mmRestorePhase').textContent = p.text;
    }
    if (!p.done) return;
    clearInterval(poll);
    $g('mmRestoreProgress').classList.add('hidden');
    mmShowRestoreResult(master, p.result || { ok: false, error: 'The restore ended without reporting a result.' });
  }, 800);
}

function mmShowRestoreResult(master, result) {
  const box = $g('mmRestoreResult');
  box.classList.remove('hidden');
  box.innerHTML = '';
  if (!result.ok) {
    box.className = 'callout callout--warning';
    box.appendChild(el('div', { class: 'callout__title' }, '\u26a0\ufe0f Restore failed'));
    // A rebuild-engine result gets this app's OWN existing wording for these cases -- in
    // particular SKIP_OPEN_FOMOD ("this mod's installer requires choices that weren't saved"),
    // which is exactly the situation Restore now refuses to guess at. Reused rather than
    // reworded, so the same problem never gets two different explanations depending on which
    // button you happened to press.
    box.appendChild(el('p', {}, result.rebuild
      ? mmDescribeRebuildFailure(result.rebuild)
      : (result.error || 'The restore could not be completed.')));
    return;
  }
  box.className = 'callout callout--success';
  box.appendChild(el('div', { class: 'callout__title' }, '\ud83d\ude80 Mod restored and enabled in Vortex'));
  box.appendChild(el('p', {}, 'All files were extracted to your staging folder and the mod has been switched on in Vortex. Run a deploy to apply these changes to your game.'));
  // A ".ghost" sibling means the user deliberately turned that plugin off inside Vortex. Those files
  // were left alone rather than silently re-enabled -- and saying so matters, because otherwise the
  // restore looks like it quietly skipped part of the mod.
  if (result.usedRecordedChoices) {
    box.appendChild(el('p', { class: 'muted' }, [
      'Installer choices were replayed from ',
      el('strong', {}, result.collectionName || 'an installed collection'),
      ', so only the options you originally picked were restored.',
    ]));
  }
  if (result.ghostPreserved && result.ghostPreserved.length) {
    box.appendChild(el('div', { class: 'callout callout--info' }, [
      el('div', { class: 'callout__title' }, '\u2139\ufe0f Some optional files were left disabled'),
      el('p', {}, 'The mod was restored, but plugins you previously turned off inside Vortex were kept disabled.'),
    ]));
  }
  // Same landing state as Enable -- fixed, but Vortex hasn't deployed it yet. No new state invented.
  master.readyToDeploy = true;
  master.restoredViaHelper = true;
  mmLocallyFixed.set(master.name, 'restored');
  mmRenderSummaryBadges();
  mmRenderMasterList();
  mmRenderDeployBanners();
}

$g('mmRestoreChooserCancelBtn').addEventListener('click', () => $g('mmRestoreChooserModal').classList.add('hidden'));
$g('mmRestoreChooserContinueBtn').addEventListener('click', () => {
  const picked = [...document.querySelectorAll('#mmRestoreChooserList input[type=radio]')].find((r) => r.checked);
  $g('mmRestoreChooserModal').classList.add('hidden');
  if (!picked || !mmRestorePending) return;
  mmShowRestoreConfirm(mmRestorePending.master, picked._match, mmRestorePending.btn);
});
$g('mmRestoreConfirmCancelBtn').addEventListener('click', () => $g('mmRestoreConfirmModal').classList.add('hidden'));
$g('mmRestoreConfirmOkBtn').addEventListener('click', () => mmDoRestore());

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
  // Create Dummy Master goes BEFORE Copy Name (not after) -- with the actions column right-aligned,
  // this keeps Copy Name as the LAST/rightmost element on every row regardless of status, so its
  // position lines up across "missing" rows (2 buttons) and "present-but-inactive" rows (1 button)
  // alike (reported 2026-07-27: previously Copy Name came first, so it visibly jumped position
  // between the two). Neither button applies once readyToDeploy is true -- the real fix (rebuild)
  // already happened; a dummy master would be actively unhelpful at that point (it would satisfy
  // Vortex's own missing-master check with a STUB instead of the real, already-restored file the
  // instant it's deployed), and Rebuild This Mod has nothing left to do either.
  const actions = [];
  if (!mmActionsSuppressed(master) && master.possibleHollowInstall) {
    const rebuildBtn = el('button', { class: 'btn btn--primary btn--small' }, 'Rebuild This Mod');
    rebuildBtn.addEventListener('click', () => mmShowRebuildConfirm(master.possibleHollowInstall, rebuildBtn));
    actions.push(rebuildBtn);
  }
  // Left of Create Dummy Master, per explicit request -- lets the user go look at (and manually fix,
  // e.g. the active-alternate .esp-vs-.esl case below) the real folder themselves, whenever we
  // actually know where it is. Not shown once readyToDeploy, same reasoning as the other two buttons.
  if (!mmActionsSuppressed(master) && master.stagingFolderPath) {
    const openBtn = el('button', { class: 'btn btn--primary btn--small' }, 'Open Staging Folder');
    openBtn.addEventListener('click', async () => {
      try {
        await mmApi('POST', '/api/missing-masters/open-staging-folder', { folderPath: master.stagingFolderPath });
      } catch (e) {
        // Re-clicking this same button re-runs this exact handler -- it's never left disabled, so
        // there's nothing extra to reset first.
        mmHandleError(e, () => openBtn.click());
      }
    });
    actions.push(openBtn);
  }
  // Points at the folder INSIDE Data itself the misplaced file was actually found in (not staging) --
  // see missing-masters-scan.js's deployedMisplaced. Shown alongside Open Staging Folder, not instead
  // of it, since the user may want to compare both.
  if (!mmActionsSuppressed(master) && master.deployedMisplaced) {
    const openDeployedBtn = el('button', { class: 'btn btn--primary btn--small' }, 'Open Deployed Folder');
    openDeployedBtn.addEventListener('click', async () => {
      try {
        await mmApi('POST', '/api/missing-masters/open-deployed-folder', { folderPath: master.deployedMisplaced.containingFolder });
      } catch (e) {
        mmHandleError(e, () => openDeployedBtn.click());
      }
    });
    actions.push(openDeployedBtn);
  }
  // Restore -- ONLY the "files are gone entirely" row: 'missing' with no readyToDeploy, no
  // activeAlternate, no deployedMisplaced and no possibleHollowInstall. A hollow install is Rebuild
  // This Mod's territory (its staging folder still exists and Vortex still has the record); Restore
  // exists precisely because that record is gone, which is why it goes searching instead.
  // Helper-gated on AVAILABLE, same reasoning as Enable: registering the restored mod needs it.
  if (mmCanRestore(master) && mmHelperStatus === MM_HELPER_AVAILABLE) {
    const restoreBtn = el('button', { class: 'btn btn--primary btn--small' }, 'Restore');
    restoreBtn.addEventListener('click', () => mmStartRestore(master, restoreBtn));
    actions.push(restoreBtn);
  }
  if (!mmActionsSuppressed(master) && master.status === 'missing') {
    // Secondary, not primary, whenever Restore is also on this row: putting the real mod back is
    // strictly the better fix, and two primary buttons side by side says neither is.
    const dummyClass = mmCanRestore(master) && mmHelperStatus === MM_HELPER_AVAILABLE
      ? 'btn btn--secondary btn--small'
      : 'btn btn--primary btn--small';
    const btn = el('button', { class: dummyClass }, 'Create Dummy Master');
    btn.addEventListener('click', () => mmShowCreateDummyConfirm(master.name));
    actions.push(btn);
  }
  // Enable (2026-08-23) -- the master's file is right there, Vortex just has it switched off. One
  // click instead of going to Vortex to flip it by hand.
  //
  // Only when the Helper is genuinely AVAILABLE, not merely "not known to be unavailable": while the
  // probe is still in flight mmHelperStatus is 'unknown', and rendering the button then would make it
  // appear and vanish. That's the flicker the three-way state exists to prevent.
  //
  // Inserted BEFORE mmCopyNameBtn below, deliberately -- with the actions column right-aligned, Copy
  // Name must stay last/rightmost on every row or it visibly jumps position between rows with
  // different button counts (a real report, 2026-07-27; see the ordering comment above).
  if (!mmActionsSuppressed(master) && master.status === 'present-but-inactive'
      && mmHelperStatus === MM_HELPER_AVAILABLE) {
    const enableBtn = el('button', { class: 'btn btn--primary btn--small' }, 'Enable');
    enableBtn.addEventListener('click', () => mmEnablePlugin(master, enableBtn));
    actions.push(enableBtn);
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
        ' is inside your Data folder, but it’s one level too deep at ',
        el('strong', {}, misplacedDisplayPath),
        '. Skyrim only loads plugins sitting directly in Data, so this file never made it into the game. Click ',
        el('strong', {}, 'Open Deployed Folder'),
        ' to view it, then move everything in that folder directly into Data.',
      ]),
    ]);
    children.push(callout);
  }
  if (master.activeAlternate && master.activeAlternate.sameModAsMaster) {
    const callout = el('div', { class: 'callout callout--critical' }, [
      el('div', { class: 'callout__title' }, '🛑 Wrong File Format Installed'),
      el('p', {}, [
        el('strong', {}, master.activeAlternate.name),
        ' is active right now, but this mod needs ',
        el('strong', {}, master.name),
        ' instead. The mod author packaged both formats together, and the wrong one was deployed. Click ',
        el('strong', {}, 'Open Staging Folder'),
        ', remove ',
        el('strong', {}, master.activeAlternate.name),
        ', and enable ',
        el('strong', {}, master.name),
        ' instead.',
      ]),
    ]);
    children.push(callout);
  } else if (master.activeAlternate && !master.activeAlternate.sameModAsMaster) {
    // ESLifier awareness -- confirmed real 2026-08-14 (live vortex.deployment.json case): what LOOKS
    // like a name collision with an unrelated mod is actually the user's own deliberate ESLifier
    // swap whenever the active file's true source resolves back to their configured ESLifier output
    // folder (mmIsEslifierSwap). Replaces the red hedging callout below with a calm, reassuring one
    // — same row, soft tier (see mmDisplayStatus/MM_STATUS), nothing left for the user to decide.
    if (mmIsEslifierSwap(master)) {
      const callout = el('div', { class: 'callout callout--info' }, [
        el('div', { class: 'callout__title' }, 'ℹ️ You swapped this plugin on purpose — nothing to fix.'),
        el('p', {}, [
          'A lighter, compressed copy of ',
          el('strong', {}, master.name),
          ' from your ',
          el('strong', {}, 'ESLifier output folder'),
          ' is active instead of the original, exactly the way you set it up in Vortex. It looks like a name collision, but it’s working just as you meant it to.',
        ]),
      ]);
      children.push(callout);
    } else {
      const callout = el('div', { class: 'callout callout--critical' }, [
        el('div', { class: 'callout__title' }, '🛑 Filename Shared by Another Mod'),
        el('p', {}, [
          el('strong', {}, master.activeAlternate.name),
          ' is active right now, but it came from ',
          el('strong', {}, master.activeAlternate.modName),
          ', which uses the exact same filename. The version this mod needs (',
          el('strong', {}, master.name),
          ') is sitting in ',
          el('strong', {}, master.modName),
          '’s staging folder. Click ',
          el('strong', {}, 'Open Staging Folder'),
          ' to inspect it and decide which version you want to keep.',
        ]),
      ]);
      children.push(callout);
    }
  }
  // Best-effort name match against a staging folder found completely empty on disk (see
  // missing-masters-scan.js's findPossibleHollowInstall) -- shown plainly as a GUESS, not asserted
  // as fact, since it's a token-overlap heuristic rather than a confirmed match against Vortex's
  // own records. Rebuild This Mod (the button above) does the real confirming when clicked. Same
  // critical/🛑 treatment as the callout above, for the same reason: unresolved, this crashes the
  // game -- a hard blocker, not just something to tread lightly around.
  if (master.possibleHollowInstall) {
    const callout = el('div', { class: 'callout callout--critical' }, [
      el('div', { class: 'callout__title' }, '🛑 Staging Folder Missing Files'),
      el('p', {}, [
        'The staging folder for ',
        el('strong', {}, master.possibleHollowInstall.folderName),
        ' is missing some or all of its files. Click ',
        el('strong', {}, 'Rebuild This Mod'),
        ' to restore them from your saved archive.',
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
      el('div', { class: 'callout__title' }, '🛑 Mod Files Missing'),
      el('p', {}, [
        'We can’t find ',
        el('strong', {}, master.name),
        ' anywhere in Data, staging, or downloads. This usually means the mod was removed from Vortex entirely. If it belongs to a collection, updating that collection should detect it and offer to reinstall it. Otherwise, download it again from Nexus Mods and install it through Vortex.',
      ]),
    ]);
    children.push(callout);
  }
  // A rebuild already succeeded (the file is back in staging) -- the only remaining step is Vortex
  // itself deploying it, not a real problem this app can fix any further. Green/success, matching
  // the badge override above.
  if (master.readyToDeploy) {
    const callout = el('div', { class: 'callout callout--success' }, [
      el('div', { class: 'callout__title' }, '🚀 Ready to Deploy'),
      // Same state, same badge, same title -- but the opening sentence has to match how the row
      // actually got here. "This mod's files are back in staging" is true after a rebuild and simply
      // false after an Enable, where the file was never missing and nothing was restored; only
      // Vortex's own plugin flag changed. The deploy half is identical either way, which is the part
      // that matters. NEW COPY, flagged for a pass -- see the handoff.
      el('p', {}, master.restoredViaHelper
        ? 'This mod is restored and switched on in Vortex. Deploy your mods in Vortex to finish applying it — this will clear automatically once deployment finishes.'
        : master.enabledViaHelper
        ? 'This plugin is switched back on in Vortex — nothing else to do. This row clears itself in a moment.'
        : 'This mod’s files are back in staging. Deploy your mods in Vortex to finish moving them into the game — this will clear automatically once deployment finishes.'),
    ]);
    children.push(callout);
  }

  const neededByLabel = el('div', { class: 'mm-row__neededby-label' }, `Needed by ${master.neededBy.length} plugin${master.neededBy.length === 1 ? '' : 's'}`);
  children.push(neededByLabel, mmRenderNeededByList(master.neededBy));

  return el('div', { class: `mm-row ${status.cardClass}` }, children);
}

// A Set of active statuses -- empty shows everything. Multi-select: each badge toggles
// independently and the shown list is the UNION of every active status, not "isolate to just one"
// (workspace UX-PRINCIPLES.md rule 7 -- confirmed real 2026-08-15, this was single-select-only
// until this pass, same as every other clickable filter-badge in the app). Never auto-reset by
// mmRender itself (including the silent background poll) so an active filter survives both a manual
// Refresh and a live data change -- only clearing it (clicking an active pill again, or "Show all")
// changes it.
let mmStatusFilter = new Set();

function mmRenderSummaryBadges() {
  const badgesEl = $g('mmSummaryBadges');
  badgesEl.innerHTML = '';
  if (mmLastProblemMasters.length === 0) return; // nothing to filter when the list itself is empty
  const counts = {};
  for (const m of mmLastProblemMasters) {
    const key = mmDisplayStatus(m);
    counts[key] = (counts[key] || 0) + 1;
  }
  // Fixed severity order (critical, warning, soft/acknowledged, success) rather than
  // Object.entries' insertion order, so pills don't reshuffle position as counts change from one
  // scan to the next.
  for (const key of ['missing', 'present-but-inactive', 'eslifier-swap', 'ready-to-deploy']) {
    if (!counts[key]) continue;
    const status = MM_STATUS[key];
    const active = mmStatusFilter.has(key);
    const badge = el('span', {
      class: `badge ${status.badgeClass} badge--clickable${active ? ' badge--filter-active' : ''}`,
      'data-status': key,
    }, [el('span', { class: 'badge__count' }, String(counts[key])), ' ' + status.label]);
    badge.addEventListener('click', () => {
      if (active) mmStatusFilter.delete(key); else mmStatusFilter.add(key);
      mmRenderSummaryBadges();
      mmRenderMasterList();
    });
    badgesEl.appendChild(badge);
  }
  const showAll = el('span', { class: `badge badge--show-all${mmStatusFilter.size === 0 ? ' badge--filter-active' : ''}` }, 'Show all');
  showAll.addEventListener('click', () => {
    mmStatusFilter.clear();
    mmRenderSummaryBadges();
    mmRenderMasterList();
  });
  badgesEl.appendChild(showAll);
}

function mmRenderMasterList() {
  const container = $g('mmGroupsList');
  container.innerHTML = '';
  const visible = mmStatusFilter.size === 0
    ? mmLastProblemMasters
    : mmLastProblemMasters.filter((m) => mmStatusFilter.has(mmDisplayStatus(m)));
  if (visible.length === 0) {
    const activeLabels = [...mmStatusFilter].map((k) => `"${MM_STATUS[k].label}"`).join(' or ');
    container.appendChild(el('p', { class: 'muted' }, `No ${activeLabels} masters right now.`));
    return;
  }
  for (const master of visible) container.appendChild(mmRenderMasterRow(master));
}

function mmRender(data) {
  $g('mmLoading').classList.add('hidden');
  $g('mmCriticalError').classList.add('hidden');
  $g('mmNotConfigured').classList.add('hidden');
  $g('mmResults').classList.add('hidden');

  // Independent of skyrimDataDir/pluginsListDir configuration below -- this reflects the ESLifier
  // output folder specifically, so it's synced in both the configured and not-configured branches.
  mmRecognizeEslifierEnabled = data.recognizeEslifierEnabled !== false;
  mmEslifierOutputDirConfigured = !!data.eslifierOutputDirConfigured;
  $g('mmRecognizeEslifierInput').checked = mmRecognizeEslifierEnabled;
  $g('mmRecognizeEslifierEmptyHint').classList.toggle('hidden', mmEslifierOutputDirConfigured);

  if (!data.configured) {
    $g('mmHeaderRow').classList.add('hidden');
    $g('mmSummaryBadges').innerHTML = '';
    $g('mmNotConfigured').textContent = 'Set your Skyrim Data folder and Plugins.txt paths in Settings to get started.';
    $g('mmNotConfigured').classList.remove('hidden');
    return;
  }
  $g('mmHeaderRow').classList.remove('hidden');

  mmDownloadMissingArchivesEnabled = !!data.downloadMissingArchivesEnabled;
  // Rendered BEFORE the all-clear early return below on purpose -- a plugin we couldn't read matters
  // MOST when nothing else is wrong, since that's when the summary line would otherwise say
  // "all clear" about a scan that never looked at it.
  mmRenderUnreadable(data.unreadable || []);
  mmLastProblemMasters = data.problemMasters || [];
  mmApplyLocalFixes(); // before anything reads the list -- see mmLocallyFixed for why
  // After mmLastProblemMasters is set (the note's own "is this worth showing" test reads it) and
  // before the all-clear early return below, which would otherwise leave a stale note on screen.
  mmRenderHelperNote();
  mmLastTotal = data.total || 0;
  mmRenderDeployBanners();
  if (mmLastProblemMasters.length === 0) {
    // Blank, not the old grey sentence -- #mmAllClear now says this properly, and having both
    // would state the same thing twice on the same screen. Refresh still sits on this row.
    $g('mmResultsMeta').textContent = '';
    $g('mmSummaryBadges').innerHTML = '';
    return;
  }

  const affectedPlugins = new Set();
  for (const m of mmLastProblemMasters) for (const p of m.neededBy) affectedPlugins.add(p);
  const masterCount = mmLastProblemMasters.length;
  const pluginCount = affectedPlugins.size;
  $g('mmResultsMeta').innerHTML = '';
  $g('mmResultsMeta').appendChild(el('span', { class: 'accent-count' }, String(masterCount)));
  $g('mmResultsMeta').appendChild(document.createTextNode(masterCount === 1
    ? ' missing or disabled master is affecting '
    : ' missing or disabled masters are affecting '));
  $g('mmResultsMeta').appendChild(el('span', { class: 'accent-count' }, String(pluginCount)));
  $g('mmResultsMeta').appendChild(document.createTextNode(pluginCount === 1 ? ' plugin.' : ' plugins.'));

  mmRenderSummaryBadges();
  mmRenderMasterList();
  $g('mmResults').classList.remove('hidden');
}

// ---------- Vortex Collection Helper availability (2026-08-23) ----------
// Groundwork for Enable and Restore (items 2 and 3), neither of which exists yet. Missing Masters had
// zero Helper awareness: /rebuild-mod checks server-side and falls back to requiring Vortex closed,
// but the frontend never knew either way.
//
// THREE-WAY, not a boolean. "Haven't found out yet" is genuinely different from "not there": the
// probe is deliberately not awaited (see runMissingMastersScan), so a boolean defaulting to false
// would render the note -- and later, hide the two buttons -- for the moment before the answer lands,
// then flip. That flicker is the whole reason for the third state.
const MM_HELPER_UNKNOWN = 'unknown';
const MM_HELPER_AVAILABLE = 'available';
const MM_HELPER_UNAVAILABLE = 'unavailable';
let mmHelperStatus = MM_HELPER_UNKNOWN;

// Reuses Settings' own GET /api/settings/helper-info rather than adding a second endpoint answering
// the same question. Only `connected` matters here -- `outdated` is Settings' concern (it owns the
// "your Helper is too old" warning); a connected-but-old Helper still answers these calls.
//
// A probe that fails outright resolves to UNAVAILABLE, not back to unknown: if we can't even ask,
// Enable and Restore could not work either, so that's the honest answer. In practice the only way
// this fails is our own server being unreachable, in which case the scan itself already failed and
// mmHandleError has surfaced the real problem.
async function mmProbeHelper() {
  try {
    const info = await mmApi('GET', '/api/settings/helper-info');
    mmHelperStatus = info && info.connected ? MM_HELPER_AVAILABLE : MM_HELPER_UNAVAILABLE;
  } catch {
    mmHelperStatus = MM_HELPER_UNAVAILABLE;
  }
  mmRenderHelperNote();
  // The tip and the Deploy button both key off Helper availability, so they re-decide here too.
  mmRenderDeployBanners();
}

// Only worth saying when there's something to gain from it. Scoped by reusing this file's own
// existing mmActionsSuppressed() rather than inventing a second notion of "can this row be acted
// on": a row whose actions are already suppressed (readyToDeploy, or a deliberate ESLifier swap)
// would never grow an Enable or Restore button either. Deliberately NOT modelled per-button --
// neither button exists yet, and guessing their exact conditions now would just be wrong later.
// Consequence worth knowing: an all-clear scan never shows this note, which is correct.
function mmHelperNoteWorthShowing() {
  return mmLastProblemMasters.some((m) => !mmActionsSuppressed(m));
}

function mmRenderHelperNote() {
  const box = $g('mmHelperNote');
  const show = mmHelperStatus === MM_HELPER_UNAVAILABLE && mmHelperNoteWorthShowing();
  box.classList.toggle('hidden', !show);
  if (!show) return;
  box.innerHTML = '';
  box.appendChild(el('div', { class: 'callout__title' }, '\u2139\ufe0f Enable and Restore need the Vortex Helper'));
  box.appendChild(el('p', {}, [
    'You can still inspect plugins and build dummy masters without it. To turn plugins back on or extract missing mods directly from this page, install the ',
    el('strong', {}, 'Vortex Collection Helper'),
    ' extension and keep Vortex open.',
  ]));
  // Its own right-justified row rather than inline after the prose -- an action button trailing a
  // paragraph gets lost, which this project has hit before. .row-actions is the existing class for
  // exactly this, so no new CSS.
  const retry = el('button', { class: 'btn btn--ghost btn--small' }, 'Retry Connection');
  retry.addEventListener('click', async () => {
    retry.disabled = true;
    retry.textContent = 'Checking\u2026';
    await mmProbeHelper(); // a real re-probe -- never just hides the callout
    retry.disabled = false;
    retry.textContent = 'Retry Connection';
  });
  box.appendChild(el('div', { class: 'row-actions' }, retry));
}

// Plugins the scan couldn't parse (2026-08-23). Skipping them is correct -- we can't read them and
// guessing would be worse -- but skipping them silently meant the user could be told "no missing or
// disabled masters found" about a scan that never opened one of their plugins. Its own callout, not
// a row in the problem list: none of the row actions (create a dummy, rebuild the mod, open staging)
// can act on a plugin we never parsed.
const MM_UNREADABLE_REASONS = {
  'read-error': "couldn't be opened",
  'invalid-header': "isn't a readable plugin file — it may be truncated or damaged",
  'compressed-header': 'uses a compressed header, which this tool cannot read',
};

function mmRenderUnreadable(list) {
  const box = $g('mmUnreadable');
  box.classList.toggle('hidden', list.length === 0);
  if (list.length === 0) return;
  box.innerHTML = '';
  box.appendChild(el('div', { class: 'callout__title' }, list.length === 1
    ? "⚠️ 1 plugin couldn't be checked"
    : `⚠️ ${list.length} plugins couldn't be checked`));
  box.appendChild(el('p', {}, list.length === 1
    ? "We couldn't read this plugin, so it wasn't included in the scan. If it has a missing master, we won't have caught it:"
    : "We couldn't read these plugins, so they weren't included in the scan. If any of them has a missing master, we won't have caught it:"));
  box.appendChild(el('ul', {}, list.map((u) => el('li', {}, [
    el('strong', {}, u.name),
    ` — ${MM_UNREADABLE_REASONS[u.reason] || 'could not be read'}.`,
  ]))));
  box.appendChild(el('p', {}, 'This usually means a damaged file. Reinstalling the mod through Vortex normally fixes it.'));
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
    // Deliberately NOT awaited -- the Helper probe is a real network round-trip that needs Vortex
    // open, and the scan results must render (and stay fully usable) without waiting on it. It
    // re-renders just the note when it lands; mmHelperStatus stays 'unknown' until then.
    mmProbeHelper();
  } catch (e) {
    mmHandleError(e, runMissingMastersScan);
  }
}

$g('mmRefreshBtn').addEventListener('click', () => runMissingMastersScan());

// Saves immediately on toggle (its own small route, not the Settings page's Save button -- see
// missing-masters-routes.js's /set-recognize-eslifier) and re-renders right away from the scan
// results already on screen -- the underlying eslifierSwap detection never changes, only whether
// this toggle honors it, so there's no need to re-scan the filesystem just to reflect it.
$g('mmRecognizeEslifierInput').addEventListener('change', async (e) => {
  const enabled = e.target.checked;
  e.target.disabled = true;
  try {
    await mmApi('POST', '/api/missing-masters/set-recognize-eslifier', { enabled });
    mmRecognizeEslifierEnabled = enabled;
    mmRenderSummaryBadges();
    mmRenderMasterList();
    // This toggle flips whether ESLifier-swap rows count as actionable, which is exactly the test
    // mmHelperNoteWorthShowing() uses -- so the note can become relevant (or stop being) without a
    // re-scan.
    mmRenderHelperNote();
  } catch (err) {
    e.target.checked = !enabled; // revert -- the save didn't actually take
    // Re-clicking the (just-reverted-to-!enabled) checkbox flips it back to `enabled` and re-fires
    // this same change handler with the originally-intended value -- not a fresh, disconnected retry.
    mmHandleError(err, () => e.target.click());
  } finally {
    e.target.disabled = false;
  }
});

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
  // Appended straight into the container (no <p> wrapper) -- same DOM shape this line has always
  // had; the bolded plugin name is the only structural addition.
  container.appendChild(document.createTextNode('This creates an empty placeholder plugin named '));
  container.appendChild(el('strong', {}, name));
  container.appendChild(document.createTextNode(' so Skyrim won’t crash on startup. To finish setting it up:'));
  container.appendChild(el('ol', {}, [
    el('li', {}, 'Install it as a mod in Vortex.'),
    el('li', {}, 'Make sure it’s enabled.'),
  ]));
  $g('mmCreateDummyConfirmModal').classList.remove('hidden');
}
$g('mmCreateDummyConfirmCancelBtn').addEventListener('click', () => {
  $g('mmCreateDummyConfirmModal').classList.add('hidden');
});
// Named (not just an inline listener body) so a Vortex-running retry can re-run the exact same
// action -- reads mmPendingDummyName itself (set by mmShowCreateDummyConfirm and never cleared
// after use), same reasoning as mmDoRebuild below reading mmPendingRebuild.
async function mmDoCreateDummyMaster() {
  $g('mmCreateDummyConfirmModal').classList.add('hidden');
  const name = mmPendingDummyName;
  try {
    await mmApi('POST', '/api/missing-masters/create-dummy-master', { name });
    await runMissingMastersScan();
  } catch (e) {
    mmHandleError(e, mmDoCreateDummyMaster);
  }
}
$g('mmCreateDummyConfirmOkBtn').addEventListener('click', mmDoCreateDummyMaster);

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
    p.appendChild(document.createTextNode('’s archive and restores it to your staging folder.'));
  } else {
    p.appendChild(document.createTextNode('This restores '));
    p.appendChild(el('strong', {}, modName));
    p.appendChild(document.createTextNode('’s files to your staging folder from your saved archive.'));
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
// Returns either a plain string or an el()-children array (when the copy needs a bolded button
// name) -- both call sites pass the result straight to el('p', {}, ...), which accepts either.
function mmDescribeRebuildFailure(result) {
  if (result.downloadSkipped === 'not-premium') {
    return 'This mod’s archive is missing, and automatic downloads require a Nexus Mods Premium account. Download the archive manually from Nexus Mods or through Vortex, then try again.';
  }
  if (result.downloadError) {
    return `We tried downloading this mod’s archive from Nexus automatically, but it failed: ${result.downloadError}. This may just be a network hiccup — try Rebuild This Mod again, or download the archive yourself from Nexus and reinstall it through Vortex.`;
  }
  if ((result.kind === 'SKIP_NO_ARCHIVE' || result.status === 'SKIP_NO_ARCHIVE') && result.canAutoDownload && !result.autoDownloadEnabled) {
    return 'This mod’s archive is missing, and automatic downloading is turned off, so we couldn’t download it for you. Turn on Download missing archives automatically under Settings and try again, or download the archive yourself from Nexus and reinstall it through Vortex.';
  }
  if (result.kind === 'SKIP_NO_ARCHIVE' || result.status === 'SKIP_NO_ARCHIVE') {
    return [
      'Couldn’t find this mod’s archive in your Downloads folder. Reinstall the mod in Vortex to restore the archive, then click ',
      el('strong', {}, 'Rebuild This Mod'),
      ' again.',
    ];
  }
  if (result.kind === 'SKIP_OPEN_FOMOD') {
    return 'This mod’s installer requires choices that weren’t saved. Reinstall it directly through Vortex.';
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
// already sitting there ("Staging Folder Missing Files") -- confirmed real 2026-07-28: a
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
// Named (not just an inline listener body) so a Vortex-running retry can re-run the exact same
// rebuild -- this is the one action in this file that actually gates on Vortex today (confirmed via
// missing-masters-routes.js's own vortexRunningGate), so this is the real-world repro case. Reads
// mmPendingRebuild/mmPendingRebuildBtn, both set by mmShowRebuildConfirm and never cleared after use.
async function mmDoRebuild() {
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
      const shown = mmShowRebuildFailureOnRow(mmPendingRebuildBtn, '🛑 Rebuild Failed', mmDescribeRebuildFailure(result));
      if (!shown) {
        // Fallback -- shouldn't normally happen, but never fail silently if the row's own callout
        // can't be found for some reason.
        const box = $g('mmCriticalError');
        box.textContent = '';
        box.appendChild(el('div', { class: 'callout__title' }, '🛑 Rebuild Failed'));
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
    mmHandleError(e, mmDoRebuild);
  }
}
$g('mmRebuildConfirmOkBtn').addEventListener('click', mmDoRebuild);

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
