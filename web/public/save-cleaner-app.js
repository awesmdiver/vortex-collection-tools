'use strict';
// Save Cleaner UI -- talks only to /api/save-cleaner/*. Mirrors design/mockup-save-cleaner.html's
// Phase 1 flow exactly (Browse view / Compare Saves / Fallout 4 / Batch Clean are Phase 2, out of
// scope here -- see that mockup's own "Decisions locked" callout). Own tiny $sc()/scApi() helpers,
// same reasoning as rules-generator-app.js/update-collection-v2-app.js's own (independent of app.js).
//
// Two real, deliberate departures from the mockup's own screenshots -- both driven by what the real
// CLI (fallrimtools-resaver-renewed, prompts/handoff-latest.md commit 02e8065) actually returns, not
// guessed:
// 1. "Show all N" only appears on the Orphaned scripts row. `report`'s own JSON only ever includes a
//    per-script breakdown (byScriptName) for unattachedInstances -- undefinedElements/
//    scriptsWithMissingParent/scriptsWithNoParent are bare {count} with no drill-down data to show.
// 2. Step 3's plan table has no "estimated size after cleaning" row (the mockup's own screenshot
//    shows one). There is no honest formula for that: size saved depends on which specific data gets
//    removed, not just item counts, and only `clean` itself (Step 4) can report the real number.
//    Replaced with a plain note that the exact size change appears right after cleaning.

function $sc(id) { return document.getElementById(id); }

function escHtmlSc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function scApi(method, path, body) {
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

function scShowCriticalError(message) {
  const el = $sc('scError');
  el.innerHTML = `<div class="callout__title">🛑 Couldn't do that</div><p>${escHtmlSc(message)}</p>`;
  el.classList.remove('hidden');
}
function scHideCriticalError() {
  $sc('scError').classList.add('hidden');
  $sc('scError').innerHTML = '';
}
function scHandleError(e) {
  if (window.isServerUnreachableError && window.isServerUnreachableError(e)) {
    window.showServerUnreachableError(() => {});
    return;
  }
  scShowCriticalError(e.message);
}

// ---- Stepper -- same .merge-step component every other multi-step tool here already uses
// (update-collection-v2-app.js's own header comment explains the shared component in full). Four
// steps, matching the mockup's own "Step N of 4" stepnote exactly. ----
const SC_STEPS = ['Pick a save', 'Review', 'Clean', 'Save'];
function scRenderStepper(activeIdx) {
  $sc('scStepper').innerHTML = SC_STEPS.map((label, i) => {
    const cls = i < activeIdx ? 'done' : i === activeIdx ? 'active' : '';
    const num = i < activeIdx ? '✓' : String(i + 1);
    return `<div class="merge-step ${cls}"><b>${num}</b>${label}</div>`;
  }).join('');
}
const SC_SCREEN_IDS = ['scStep1', 'scScanning', 'scStep2', 'scStep3', 'scCleaning', 'scStep4', 'scSaving', 'scStep6'];
// scStep6 maps one PAST the last real step (4) so "Save" itself shows done/checked once the after-
// save summary is showing, same trick UCV2_SCREEN_STEP's own comment documents for the same reason.
const SC_SCREEN_STEP = { scStep1: 0, scScanning: 0, scStep2: 1, scStep3: 2, scCleaning: 2, scStep4: 3, scSaving: 3, scStep6: 4 };
function scGoScreen(id) {
  SC_SCREEN_IDS.forEach((s) => $sc(s).classList.toggle('hidden', s !== id));
  scRenderStepper(SC_SCREEN_STEP[id]);
  window.scrollTo(0, 0);
}
scRenderStepper(0);

// ---- Category metadata -- titles/descriptions lifted verbatim from the approved mockup's own Step 2
// problem rows (and from CleanOperations.java's own javadoc, which documents these same four labels
// as the mockup's "own four checkboxes"). Order matches CATEGORY_KEYS in lib/save-cleaner-runner.js. ----
const SC_CATEGORY_META = {
  unattached: {
    title: 'Orphaned scripts',
    desc: "Scripts still running for mods that are no longer installed or weren't safe to update mid-playthrough. These unattached scripts are the primary cause of save bloat, lag, and crashes&mdash;cleaning them out is the most critical step to restoring save stability.",
    reportKey: 'unattachedInstances',
    cleanedKey: 'unattachedRemoved',
    defaultChecked: true,
    hasDetail: true,
  },
  undefined: {
    title: 'Missing definitions',
    desc: 'Elements in your save pointing to scripts that no longer exist on disk. Usually left behind when a mod is uninstalled or updated mid-playthrough, cleaning these broken references prevents script errors and helps stabilize your save.',
    reportKey: 'undefinedElements',
    cleanedKey: 'undefinedRemoved',
    defaultChecked: true,
    hasDetail: false,
  },
  'missing-parent': {
    title: 'Scripts with a missing parent',
    desc: 'Scripts in your save that point to a base script hierarchy that was changed or removed&mdash;typically caused by updating a mod with major internal script rewrites mid-playthrough. While often harmless, cleaning them prevents script lag and resolves broken inheritance chains.',
    reportKey: 'scriptsWithMissingParent',
    cleanedKey: 'missingParentRemoved',
    defaultChecked: false,
    hasDetail: false,
  },
  'no-parent': {
    title: 'Scripts with no parent at all',
    desc: 'Scripts in your save completely detached from any parent hierarchy&mdash;typically caused by updating a mod with major script restructuring mid-playthrough. These often overlap with missing parent errors, and clearing them safely removes dead script branches.',
    reportKey: 'scriptsWithNoParent',
    cleanedKey: 'noParentRemoved',
    defaultChecked: false,
    hasDetail: false,
  },
};
const SC_CATEGORY_ORDER = ['unattached', 'undefined', 'missing-parent', 'no-parent'];
// The category-key -> title-suffix map for the "⚠️ {count} {suffix}" heading shape (see
// scRenderStep2's own titleLine below) -- only the two categories the director asked for this
// treatment on (2026-08-26); the other two keep the generic title-plus-badge shape.
const SC_TITLE_OVERRIDE = {
  unattached: 'Orphaned Script Instances Detected',
  undefined: 'Missing Script Definitions Detected',
  'missing-parent': 'Scripts with Missing Parents Detected',
  'no-parent': 'Scripts with No Parent Detected',
};

function scFormatMb(n) { return `${Number(n).toFixed(1)} MB`; }
function scFormatBytes(bytes) { return scFormatMb(bytes / 1048576); }
function scFormatDate(iso) {
  if (!iso) return '';
  // Explicit hour/minute options (not timeStyle: 'short') so the hour is always zero-padded --
  // "02:59 AM" not "2:59 AM". Without that, a single-digit hour makes its whole date/time string
  // narrower, which shifts the right-aligned View button next to it out of column with every other
  // row (confirmed real, director-reported 2026-08-25).
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}
// The header's own LOCATION field is a broad current-area name ("Skyrim", "Whiterun") -- when the
// "Regional Save Names" mod is detected installed, the server also attaches the filename's own more
// specific region tag ("Tamriel") as `save.region` (see save-cleaner-routes.js's own /saves handler).
// "Skyrim" becomes "Skyrim: Tamriel" -- skip the ": Tamriel" suffix if it would just repeat the same
// word the header already shows.
function scLocationLabel(save) {
  const location = save.header?.location || '';
  if (!save.region || save.region.toLowerCase() === location.toLowerCase()) return location;
  return `${location}: ${save.region}`;
}

// The save's own real, current save number -- from the FILENAME, not header.saveNumber. Confirmed
// real 2026-08-26: "Save As" copies the cleaned save data byte-for-byte, so a save's internal binary
// header keeps whatever saveNumber the game originally wrote (e.g. still 20) even after it's saved
// out as "Save25_...", "Save26_...", etc. -- only the filename's own leading number actually reflects
// what the file is really called on disk. Falls back to the header's own number only if the filename
// itself doesn't match the expected "SaveNN_..." shape (shouldn't happen for a real Bethesda save,
// but safer than showing nothing).
function scParseSaveNumberFromFilename(filename, header) {
  const m = /^Save(\d+)_/i.exec(filename);
  return m ? parseInt(m[1], 10) : header?.saveNumber;
}

// Mirrors lib/save-cleaner-scan.js's own suggestNextSaveName regexes -- Autosave/Quicksave get their
// own plain-language label instead of "Save 0" (a save with no real number component).
function scSaveKindLabel(filename, header) {
  if (/^Autosave/i.test(filename)) return 'Autosave';
  if (/^Quicksave/i.test(filename)) return 'Quicksave';
  return header ? `Save ${scParseSaveNumberFromFilename(filename, header)}` : null;
}

// A real Skyrim save filename's own second underscore-delimited segment is a stable per-character/
// playthrough hex ID Bethesda assigns -- e.g. "Save6_F341709A_0_526F77616E_APStartCell_..." ->
// F341709A (the "526F77616E" segment right after it is just the character NAME, hex-encoded --
// "Rowan" byte-for-byte -- already available in plain text from the save's own header, so this only
// needs the ID). Confirmed against this app's own real saves folder: the SAME id recurs across every
// save belonging to one character/playthrough, and -- critically -- two genuinely different
// playthroughs can reuse the exact same in-game character NAME with two DIFFERENT ids (a real "Rowan"
// showed up under both F341709A and C9ED35AC in this app's own test data). Grouping by name alone
// would silently merge those into one fake "character" -- this id is the real, stable identity to
// group by; the name is only ever a display label alongside it.
function scParsePlayerFileId(filename) {
  const m = /^[^_]+_([0-9A-Fa-f]+)_/.exec(filename);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------------------------
// Step 1 -- pick a save
// ---------------------------------------------------------------------------------------------
let scCurrentGame = 'skyrim';
const SC_COSAVE_NAME = { skyrim: 'SKSE', fallout4: 'F4SE', starfield: 'SFSE' };
function scCosaveName() { return SC_COSAVE_NAME[scCurrentGame] || 'SKSE'; }
let scSavesDir = null;
let scSaves = [];
let scSelectedIdx = null;

async function scLoadSaves() {
  scHideCriticalError();
  $sc('scNotConfigured').classList.add('hidden');
  try {
    const { savesDir, saves, profileNamesError } = await scApi('GET', `/api/save-cleaner/saves?game=${encodeURIComponent(scCurrentGame)}`);
    scSavesDir = savesDir;
    scSaves = saves;
    scSelectedIdx = null;
    $sc('scSavesDirLabel').textContent = savesDir;
    scRenderSavesList();
    scUpdateStep1Actions();
    // profileNamesError (2026-09-05, director's own direct ask): the saves list ITSELF already
    // loaded successfully (a 200, not a thrown error) -- this only means some saves' own profile
    // NAME didn't resolve because Vortex was genuinely busy a moment ago (see
    // save-cleaner-routes.js's own attachProfileNames for the real 3-way distinction: this flag
    // only ever fires for that one transient case, never for a permanently-missing Helper or a
    // genuinely-unknown profile). Offer the same shared busy modal with a real retry; if the user
    // cancels instead, the list stays exactly as already rendered above ("Unknown profile" showing
    // for whatever didn't resolve) -- that's the director's own explicitly stated fallback, not a bug.
    if (profileNamesError && profileNamesError.code === 'vortex-running' && window.showVortexRunningModal) {
      window.showVortexRunningModal(scLoadSaves, { title: '⚠️ Vortex is currently busy', body: profileNamesError.message });
    }
  } catch (e) {
    if (e.status === 400 && e.body?.error === 'not-configured') {
      $sc('scNotConfiguredText').textContent = e.message;
      $sc('scNotConfigured').classList.remove('hidden');
      $sc('scSavesList').innerHTML = '';
      $sc('scSavesEmpty').classList.add('hidden');
      return;
    }
    scHandleError(e);
  }
}
window.scLoadSaves = scLoadSaves;

// Same "fires once each time arriving from a DIFFERENT area" reset pattern (2026-08-27,
// merge-entry-reset) -- resets scSelectedIdx/scReportResult/scSelectedCategories/scCleanResult back
// to their defaults, goes back to Step 1 via scGoScreen, then reloads the saves list fresh.
function scResetOnEntry() {
  scSelectedIdx = null;
  scReportResult = null;
  scSelectedCategories.clear();
  scCleanResult = null;
  scGoScreen('scStep1');
  scLoadSaves();
}
window.scResetOnEntry = scResetOnEntry;

// Three levels, deepest-nested version of the same ".path-row" caret pattern DESIGN.md standardizes
// on for any nested browse/select list (same shape murGroupByMod/murRenderModGroups use in
// merge-update-report-app.js, generalized one tier deeper -- DESIGN.md's own "Body, sub-nested (2+
// levels)" section explicitly covers this: each level gets its own independent toggle):
// Profile > Player (character) > individual saves. A profile-specific-saves layout is a real Vortex
// feature (per-profile save separation, folder named after the real profile ID) -- listSaves()
// already scans those subfolders, this just surfaces which one each save actually came from instead
// of showing one mile-long mixed list. A save with no readable header (can't tell whose it is) falls
// into its own "Unrecognized saves" player-group at the end of its profile rather than being dropped
// or guessed at; a save with no profile-specific folder (flat layout, or the feature isn't in use)
// groups under "Not profile-specific".
const SC_UNKNOWN_PLAYER = 'Unrecognized saves';
const SC_NO_PROFILE = 'Not profile-specific';
const scExpandedProfiles = new Set();
const scExpandedPlayers = new Set();
let scDefaultExpandDone = false;

// route already resolved profileFolderId -> profileName via Vortex's own real profile list
// (best-effort; null when Vortex isn't reachable or the folder doesn't match any known profile) --
// label always shows the raw ID too so it's still identifiable even when the name lookup missed.
function scProfileLabel(s) {
  if (!s.profileFolderId) return SC_NO_PROFILE;
  return s.profileName ? `${s.profileName} (${s.profileFolderId})` : `Unknown profile (${s.profileFolderId})`;
}

function scGroupByPlayer(entries) {
  const byId = new Map();
  for (const e of entries) {
    // Group by the save's real per-character file ID (scParsePlayerFileId), not the display name --
    // two different playthroughs can share a name (confirmed real, see that function's own header
    // comment), and this id is what tells them apart. A save with no header at all (unreadable) has
    // no filename ID either in practice for this app's own naming, so it still falls into the shared
    // SC_UNKNOWN_PLAYER bucket.
    const id = e.s.header ? (scParsePlayerFileId(e.s.filename) || `name:${e.s.header.name}`) : SC_UNKNOWN_PLAYER;
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(e);
  }
  const players = [...byId.entries()].map(([id, playerEntries]) => {
    // Numerically by the save's own real filename number (scParseSaveNumberFromFilename -- NOT
    // header.saveNumber, which stays frozen at whatever the original save had even after a Save As
    // clones it under a new number) -- highest/most-recent first. Entries with no header
    // (SC_UNKNOWN_PLAYER) have nothing to sort by, so they keep the order the API returned them in.
    playerEntries.sort((a, b) =>
      (scParseSaveNumberFromFilename(b.s.filename, b.s.header) ?? 0) - (scParseSaveNumberFromFilename(a.s.filename, a.s.header) ?? 0));
    const newestMtime = Math.max(...playerEntries.map((e) => new Date(e.s.mtime).getTime()));
    // The character's own in-game name is cosmetic/display-only -- take it from whichever save is
    // actually newest, in case it was ever renamed mid-playthrough.
    const name = id === SC_UNKNOWN_PLAYER ? SC_UNKNOWN_PLAYER : playerEntries[0].s.header.name;
    return { id, name, entries: playerEntries, newestMtime };
  });
  players.sort((a, b) => b.newestMtime - a.newestMtime);
  return players;
}

function scGroupSaves() {
  const byProfile = new Map();
  scSaves.forEach((s, idx) => {
    const key = scProfileLabel(s);
    if (!byProfile.has(key)) byProfile.set(key, []);
    byProfile.get(key).push({ s, idx });
  });
  const profiles = [...byProfile.entries()].map(([name, entries]) => {
    const players = scGroupByPlayer(entries);
    const newestMtime = Math.max(...players.map((p) => p.newestMtime));
    const count = entries.length;
    return { name, players, newestMtime, count };
  });
  profiles.sort((a, b) => b.newestMtime - a.newestMtime);
  return profiles;
}

function scRenderSaveRow(s, idx) {
  const h = s.header;
  const kind = scSaveKindLabel(s.filename, h);
  let line;
  if (h) {
    const parts = [escHtmlSc(scLocationLabel(s)), escHtmlSc(h.gameDate)];
    if (kind === null) parts.push(`${Math.round(h.currentXp)}/${Math.round(h.neededXp)} xp`);
    parts.push(kind || `Save ${scParseSaveNumberFromFilename(s.filename, h)}`);
    line = `Level ${h.level} ${escHtmlSc(h.race)} - ${parts.join(' &middot; ')}`;
  } else {
    line = escHtmlSc(s.filename) + " &mdash; couldn't read this save's own details.";
  }
  // .badge is `display:flex` in styles.css (a block-level flex container everywhere it isn't
  // ALREADY inside its own flex row, e.g. .summary-badges) -- every ad-hoc badge placed inline next
  // to plain text in this file needs `display:inline-flex` here to stop it from stretching to its
  // parent's full width and dropping to its own line (confirmed live: "Newest" rendered as a
  // full-width bar under the save name before this fix).
  const newest = idx === scNewestIdx ? '<span class="badge badge--info" style="display:inline-flex">Newest</span>' : '';
  // Every real save has an SKSE co-save -- that badge would just be green noise on every single row.
  // Flag the exception instead: a save that's MISSING its co-save is the thing worth a glance.
  const noCosave = !s.cosavePath ? ` <span class="badge badge--warning" style="display:inline-flex">No ${scCosaveName()} co-save</span>` : '';
  // One line: main text on the left, Newest + the date/time right-justified in their own group
  // (director's own call 2026-08-25) -- no file size.
  return `<div class="name-row${idx === scSelectedIdx ? ' on' : ''}" data-idx="${idx}" style="cursor:pointer;display:flex;align-items:center;gap:14px;overflow:hidden">
    <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${line}${noCosave}</span>
    <span style="flex-shrink:0;display:flex;align-items:center;gap:10px">${newest}<button class="btn btn--ghost btn--small sc-view-btn" data-idx="${idx}" type="button">View</button><span class="muted" style="font-size:12.5px;width:150px;text-align:right;flex-shrink:0">${scFormatDate(s.mtime)}</span></span>
  </div>`;
}

let scNewestIdx = null;

function scRenderPlayerGroup(profileName, player) {
  const key = `${profileName}::${player.id}`;
  const expanded = scExpandedPlayers.has(key);
  const rows = expanded ? player.entries.map(({ s, idx }) => scRenderSaveRow(s, idx)).join('') : '';
  // Real per-character id (scParsePlayerFileId) shown muted right after the name -- two different
  // playthroughs can share a display name (see scGroupByPlayer's own comment), so this is what
  // actually tells them apart when it matters.
  const idLabel = player.id !== SC_UNKNOWN_PLAYER
    ? ` <span class="muted" style="font-size:12px;font-weight:400">(${escHtmlSc(player.id)})</span>` : '';
  // Sub-heading tier, its own independent toggle -- same shape/indent/caret as
  // murRenderModGroups' own modHeader (merge-update-report-app.js), but the character's own name is
  // deliberately NOT muted here: the director's own call (2026-08-25) -- unlike a mod-name
  // sub-heading, the player name is the primary thing being picked in this list, so it gets the
  // accent color + a larger size to stand out, while the caret, id, and save count around it stay muted.
  return `<div data-player-id="${escHtmlSc(player.id)}">
    <div class="sc-player-header" style="display:flex;align-items:center;gap:8px;cursor:pointer;padding:4px 0">
      <span class="muted" style="font-size:9px">${expanded ? '▼' : '▶'}</span>
      <span style="color:var(--accent);font-size:15px;font-weight:700">${escHtmlSc(player.name)}${idLabel}</span>
      <span class="muted" style="font-size:12px">${player.entries.length} save${player.entries.length === 1 ? '' : 's'}</span>
    </div>
    ${expanded ? `<div style="padding-left:14px;display:flex;flex-direction:column;gap:6px">${rows}</div>` : ''}
  </div>`;
}

function scRenderSavesList() {
  const list = $sc('scSavesList');
  $sc('scSavesEmpty').classList.toggle('hidden', scSaves.length > 0);
  if (scSaves.length === 0) { list.innerHTML = ''; return; }
  scNewestIdx = scSaves.reduce((best, s, idx) =>
    (best === null || new Date(s.mtime) > new Date(scSaves[best].mtime)) ? idx : best, null);
  const profiles = scGroupSaves();
  // First load only -- open the profile AND player holding the overall newest save so the common
  // case (one character, pick the latest save) needs no extra clicks; leftover test/old profiles and
  // characters stay collapsed until asked for. A ONE-TIME flag, not "re-run whenever nothing's
  // expanded" -- the latter re-opened the only/last profile the instant you collapsed it, since
  // collapsing it is exactly what makes the set empty again (confirmed real 2026-08-25).
  if (!scDefaultExpandDone && profiles.length) {
    scExpandedProfiles.add(profiles[0].name);
    if (profiles[0].players.length) scExpandedPlayers.add(`${profiles[0].name}::${profiles[0].players[0].id}`);
    scDefaultExpandDone = true;
  }

  list.innerHTML = profiles.map((p) => {
    const expanded = scExpandedProfiles.has(p.name);
    const body = expanded ? p.players.map((pl) => scRenderPlayerGroup(p.name, pl)).join('') : '';
    return `<div class="path-row" style="flex-direction:column;align-items:stretch;gap:8px;margin-bottom:10px" data-profile="${escHtmlSc(p.name)}">
      <div style="display:flex;align-items:center;gap:10px;cursor:pointer" class="sc-profile-header">
        <span class="muted" style="font-size:10px">${expanded ? '▼' : '▶'}</span>
        <strong style="color:var(--text)">${escHtmlSc(p.name)}</strong>
        <span class="muted" style="margin:0">${p.count} save${p.count === 1 ? '' : 's'}</span>
      </div>
      <div style="padding-left:20px;display:flex;flex-direction:column;gap:4px" class="sc-profile-body">${body}</div>
    </div>`;
  }).join('');

  list.querySelectorAll('.sc-profile-header').forEach((header) => {
    header.addEventListener('click', () => {
      const name = header.closest('.path-row').dataset.profile;
      if (scExpandedProfiles.has(name)) scExpandedProfiles.delete(name); else scExpandedProfiles.add(name);
      scRenderSavesList();
    });
  });
  list.querySelectorAll('.sc-player-header').forEach((header) => {
    header.addEventListener('click', () => {
      const profileName = header.closest('.path-row').dataset.profile;
      const playerId = header.closest('[data-player-id]').dataset.playerId;
      const key = `${profileName}::${playerId}`;
      if (scExpandedPlayers.has(key)) scExpandedPlayers.delete(key); else scExpandedPlayers.add(key);
      scRenderSavesList();
    });
  });
  list.querySelectorAll('.name-row').forEach((row) => {
    row.addEventListener('click', () => scSelectSave(Number(row.dataset.idx)));
  });
  list.querySelectorAll('.sc-view-btn').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation(); // don't also select the row underneath
      scOpenViewModal(Number(btn.dataset.idx));
    });
  });
}

function scSelectSave(idx) {
  scSelectedIdx = idx;
  $sc('scSavesList').querySelectorAll('.name-row').forEach((row) => {
    row.classList.toggle('on', Number(row.dataset.idx) === idx);
  });
  scUpdateStep1Actions();
}

function scUpdateStep1Actions() {
  const has = scSelectedIdx !== null;
  $sc('scScanBtn').disabled = !has;
  $sc('scStep1Status').textContent = has ? 'Save file selected — ready to scan.' : 'Pick a save to continue.';
}

// ---------------------------------------------------------------------------------------------
// Step 1's own "View" button/modal -- ReSaver's own "successfully loaded" info panel (path,
// character summary, version/size stats, embedded screenshot), NOT the problem-count diagnostics
// (those are Step 2's own job right after this -- director's own scoping, 2026-08-25).
// ---------------------------------------------------------------------------------------------
function scOpenViewModal(idx) {
  const save = scSaves[idx];
  if (!save) return;
  $sc('scViewModal').classList.remove('hidden');
  $sc('scViewTitle').classList.add('hidden');
  $sc('scViewLoading').classList.remove('hidden');
  $sc('scViewError').classList.add('hidden');
  $sc('scViewBody').classList.add('hidden');
  $sc('scViewPhase').textContent = 'Reading file…';
  scApi('POST', '/api/save-cleaner/view', { essPath: save.essPath }).then(() => {
    const es = new EventSource('/api/save-cleaner/view/events');
    es.onmessage = (msg) => {
      const frame = JSON.parse(msg.data);
      if (frame.type === 'phase') {
        $sc('scViewPhase').textContent = frame.message;
      } else if (frame.type === 'result') {
        es.close();
        scRenderViewResult(frame.result.save);
      } else if (frame.type === 'error') {
        es.close();
        $sc('scViewLoading').classList.add('hidden');
        $sc('scViewError').innerHTML = `<p>🛑 ${escHtmlSc(frame.message)}</p>`;
        $sc('scViewError').classList.remove('hidden');
      }
    };
  }).catch((e) => {
    $sc('scViewLoading').classList.add('hidden');
    $sc('scViewError').innerHTML = `<p>🛑 ${escHtmlSc(e.message)}</p>`;
    $sc('scViewError').classList.remove('hidden');
  });
}

function scRenderViewResult(info) {
  $sc('scViewLoading').classList.add('hidden');
  $sc('scViewTitle').classList.remove('hidden');
  if (info.screenshotPng) {
    $sc('scViewScreenshot').src = `data:image/png;base64,${info.screenshotPng}`;
    $sc('scViewScreenshot').classList.remove('hidden');
  } else {
    $sc('scViewScreenshot').classList.add('hidden');
  }
  $sc('scViewPath').textContent = info.path;
  const save = scSaves[scSelectedIdx] || scSaves.find((s) => s.essPath === info.path);
  const h = save?.header;
  $sc('scViewSummary').textContent = h
    ? `${h.name} the level ${h.level} ${h.race}, in ${scLocationLabel(save)} on ${h.gameDate} (${Math.round(h.currentXp)}/${Math.round(h.currentXp + h.neededXp)} xp).`
    : info.path.split(/[\\/]/).pop();
  const stats = [
    `Version string: ${info.versionString || '(none)'}`,
    `Form version: ${info.formVersion}`,
    `Time: ${scFormatDate(info.saveTimeIso)}`,
    info.compressed && info.onDiskSizeMb != null
      ? `Total size: ${info.totalSizeMb} mb (${info.onDiskSizeMb} mb with ${info.compressionType})`
      : `Total size: ${info.totalSizeMb} mb`,
    `Papyrus size: ${info.papyrusSizeMb} mb`,
    `ChangeForms size: ${info.changeFormsSizeMb} mb`,
  ];
  $sc('scViewStats').innerHTML = stats.map((s) => `<li>${escHtmlSc(s)}</li>`).join('');
  const loadParts = [`Read ${info.totalSizeMb} mb in ${info.readSeconds}s.`];
  loadParts.push(info.hasCosave ? `${scCosaveName()} co-save was loaded.` : `No ${scCosaveName()} co-save found.`);
  $sc('scViewLoadResult').innerHTML = `The savefile was successfully loaded.<br>${loadParts.join(' ')}`;
  $sc('scViewBody').classList.remove('hidden');
}
$sc('scViewCloseBtn').addEventListener('click', () => $sc('scViewModal').classList.add('hidden'));

$sc('scRefreshSavesBtn').addEventListener('click', scLoadSaves);

// Persists straight to Settings -- the only other place this path lives, and every other Browse...
// button in this app persists to config the same way (settings-app.js's generic .settings-browse-btn
// wiring). The generic POST /api/settings this hits also flags restartRequired for any PATH_FIELDS
// change, but that flag doesn't actually apply here -- web/save-cleaner-routes.js reads
// saveCleanerSavesDir fresh via appConfig.loadConfig() on every request, no server restart needed --
// so it's deliberately ignored below rather than wiring up a restart-prompt modal this page has no
// other use for.
$sc('scBrowseSavesDirBtn').addEventListener('click', async () => {
  try {
    const { path } = await scApi('POST', '/api/settings/browse-folder', { initialDir: scSavesDir || undefined, title: 'Select your Skyrim saves folder' });
    if (!path) return;
    await scApi('POST', '/api/settings', { saveCleanerSavesDir: path });
    await scLoadSaves();
  } catch (e) {
    scHandleError(e);
  }
});

// ---------------------------------------------------------------------------------------------
// Step 1b -- scanning (SSE)
// ---------------------------------------------------------------------------------------------
let scElapsedTimer = null;
function scStartElapsedTimer(labelId) {
  const start = Date.now();
  clearInterval(scElapsedTimer);
  const tick = () => {
    const s = Math.floor((Date.now() - start) / 1000);
    $sc(labelId).textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  tick();
  scElapsedTimer = setInterval(tick, 1000);
}
function scStopElapsedTimer() { clearInterval(scElapsedTimer); }

// The same "indeterminate-looking, mostly-full bar" convention remove-collection-app.js's own
// rcSetApplyProgress uses -- report/clean/save each print exactly ONE result at the end (no
// incremental progress to show a real percentage for, see save-cleaner-routes.js's own header
// comment), so a literal 0-100% bar would be dishonest. Reset to 0% first so the fill-in to 90% (via
// .progress-bar's own CSS transition) actually plays every run, not just the first -- the bar element
// stays in the DOM between runs (scGoScreen only toggles visibility), so without this reset a second
// run would start already at 90% with no visible animation.
function scStartIndeterminateBar(barId) {
  const bar = $sc(barId);
  bar.style.width = '0%';
  requestAnimationFrame(() => requestAnimationFrame(() => { bar.style.width = '90%'; }));
}

let scReportResult = null;

$sc('scScanBtn').addEventListener('click', async () => {
  const save = scSaves[scSelectedIdx];
  if (!save) return;
  scHideCriticalError();
  $sc('scNotInstalled').classList.add('hidden');
  scGoScreen('scScanning');
  scStartElapsedTimer('scScanningElapsed');
  scStartIndeterminateBar('scScanningBar');
  try {
    await scApi('POST', '/api/save-cleaner/scan', { essPath: save.essPath, game: scCurrentGame });
  } catch (e) {
    scStopElapsedTimer();
    scGoScreen('scStep1');
    if (e.status === 400 && e.body?.error === 'resaver-not-installed') {
      $sc('scNotInstalledText').textContent = e.message;
      $sc('scNotInstalled').classList.remove('hidden');
      return;
    }
    if (e.status === 400 && e.body?.error === 'not-found') {
      scShowCriticalError(e.message);
      scLoadSaves();
      return;
    }
    scHandleError(e);
    return;
  }
  const es = new EventSource('/api/save-cleaner/scan/events');
  es.onmessage = (msg) => {
    const frame = JSON.parse(msg.data);
    if (frame.type === 'phase') {
      // No separate phase line anymore -- the callout's own static title already says "Reading
      // save file…", and the CLI only ever emits this one phase message anyway (no incremental
      // progress -- see save-cleaner-routes.js's own header comment), so a second element showing
      // the identical text was pure duplication, not real progress detail.
    } else if (frame.type === 'result') {
      es.close();
      scStopElapsedTimer();
      scReportResult = frame.result;
      scRenderStep2();
      scGoScreen('scStep2');
    } else if (frame.type === 'error') {
      es.close();
      scStopElapsedTimer();
      scGoScreen('scStep1');
      scShowCriticalError(frame.message);
    }
  };
});

// ---------------------------------------------------------------------------------------------
// Step 2 -- health report
// ---------------------------------------------------------------------------------------------
let scSelectedCategories = new Set();

function scCurrentSave() { return scSaves[scSelectedIdx]; }

function scRenderStep2() {
  const save = scCurrentSave();
  const h = save.header;
  const r = scReportResult;

  $sc('scStep2Title').textContent = h
    ? `${h.name} — Level ${h.level} ${h.race}, ${scLocationLabel(save)} (day ${h.gameDate})`
    : save.filename;
  const subParts = [`Saved ${scFormatDate(save.mtime)}`, `read in ${r.save.readSeconds}s`];
  subParts.push(r.save.hasCosave ? `${scCosaveName()} co-save loaded` : `no ${scCosaveName()} co-save found`);
  $sc('scStep2Sub').innerHTML = subParts.join(' &middot; ');

  const problemCounts = {};
  let problemCategoryCount = 0;
  for (const key of SC_CATEGORY_ORDER) {
    const count = Number(r.problems[SC_CATEGORY_META[key].reportKey].count) || 0;
    problemCounts[key] = count;
    if (count > 0) problemCategoryCount++;
  }

  $sc('scStatStrip').innerHTML = [
    [scFormatMb(r.save.totalSizeMb), 'Total size'],
    [scFormatMb(r.save.papyrusSizeMb), 'Papyrus'],
    [scFormatMb(r.save.changeFormsSizeMb), 'ChangeForms'],
    [r.save.pluginCount.toLocaleString(), 'Plugins'],
    [problemCategoryCount, 'Problems'],
  ].map(([n, label]) => `<div class="merge-stat"><div class="merge-stat__n">${n}</div><div class="merge-stat__l">${label}</div></div>`).join('');

  $sc('scProblemsSummary').classList.toggle('hidden', problemCategoryCount === 0);
  $sc('scProblemsClean').classList.toggle('hidden', problemCategoryCount > 0);
  if (problemCategoryCount > 0) {
    $sc('scProblemsCount').textContent = problemCategoryCount;
  }

  scSelectedCategories = new Set(SC_CATEGORY_ORDER.filter((key) => problemCounts[key] > 0 && SC_CATEGORY_META[key].defaultChecked));

  $sc('scProblemRows').innerHTML = SC_CATEGORY_ORDER.map((key) => {
    const meta = SC_CATEGORY_META[key];
    const count = problemCounts[key];
    const checked = scSelectedCategories.has(key);
    const disabled = count === 0;
    const detailBtn = meta.hasDetail && count > 0
      ? `<button class="btn btn--ghost btn--small" data-show-detail="${key}">Show</button>`
      : '';
    // Orphaned scripts and Missing definitions bake the count straight into the title itself
    // (director's own call, 2026-08-25) -- SC_TITLE_OVERRIDE covers just those two; every other
    // category keeps the generic title-plus-separate-count-badge shape.
    // No per-row ⚠️ icon -- the Step 2 warning banner above already carries that severity signal
    // for the whole list (director's own call, 2026-08-26); repeating it on every row was noise.
    const titleLine = SC_TITLE_OVERRIDE[key] && count > 0
      ? `${count} ${SC_TITLE_OVERRIDE[key]}`
      : `${meta.title} <span class="badge ${count > 0 ? 'badge--warning' : 'badge--neutral'}" style="display:inline-flex">${count}</span>`;
    return `<label class="merge-chk-row${checked ? ' on' : ''}" style="align-items:flex-start;${disabled ? 'opacity:.55' : ''}">
      <input type="checkbox" data-cat="${key}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
      <div style="flex:1;min-width:0">
        <div class="merge-chk-row__name">${titleLine}</div>
        <div class="muted" style="font-size:12.5px;margin-top:4px">${meta.desc}</div>
      </div>
      <div class="merge-chk-row__meta">${detailBtn}</div>
    </label>`;
  }).join('');
  // "Everything else looks fine" (zeroed canaries/nullref formlists/suspended stacks/empty refs/
  // stuck animations) was a placeholder row for checks this build never actually runs -- the real
  // inspection is the Browse view, a later addition. Hidden until that's wired up rather than
  // shown as a permanently-disabled, always-0 row that implies a check that isn't happening
  // (director's own call, 2026-08-26).

  $sc('scProblemRows').querySelectorAll('input[data-cat]').forEach((input) => {
    input.addEventListener('change', () => {
      const key = input.dataset.cat;
      if (input.checked) scSelectedCategories.add(key); else scSelectedCategories.delete(key);
      input.closest('.merge-chk-row').classList.toggle('on', input.checked);
      scUpdateStep2Selection(problemCounts);
    });
  });
  $sc('scProblemRows').querySelectorAll('button[data-show-detail]').forEach((btn) => {
    btn.addEventListener('click', (e) => { e.preventDefault(); scOpenOrphanDetail(btn.dataset.showDetail); });
  });

  scUpdateStep2Selection(problemCounts);
}

function scUpdateStep2Selection(problemCounts) {
  const checkedKeys = SC_CATEGORY_ORDER.filter((k) => scSelectedCategories.has(k));
  const totalItems = checkedKeys.reduce((sum, k) => sum + (problemCounts[k] || 0), 0);
  $sc('scSelectedSummary').textContent = checkedKeys.length > 0
    ? `${totalItems.toLocaleString()} item${totalItems === 1 ? '' : 's'} selected across ${checkedKeys.length} issue${checkedKeys.length === 1 ? '' : 's'}`
    : 'Nothing selected yet.';
  $sc('scGoStep3Btn').disabled = checkedKeys.length === 0;
}

$sc('scSelectAllBtn').addEventListener('click', () => {
  $sc('scProblemRows').querySelectorAll('input[data-cat]:not(:disabled)').forEach((input) => {
    input.checked = true;
    input.dispatchEvent(new Event('change'));
  });
});
$sc('scClearSelectionBtn').addEventListener('click', () => {
  $sc('scProblemRows').querySelectorAll('input[data-cat]').forEach((input) => {
    input.checked = false;
    input.dispatchEvent(new Event('change'));
  });
});
$sc('scBackToStep1Btn').addEventListener('click', () => scGoScreen('scStep1'));

// ---- Step 2b -- orphan detail modal (Orphaned scripts row only -- see file header comment) ----
function scOpenOrphanDetail(key) {
  const groups = scReportResult.problems.unattachedInstances.byScriptName || [];
  $sc('scOrphanDetailTitle').textContent = `${SC_CATEGORY_META[key].title} — by script`;
  $sc('scOrphanDetailRows').innerHTML = groups.map((g) => `<tr>
    <td><code>${escHtmlSc(g.scriptName)}</code></td>
    <td>${g.modName ? escHtmlSc(g.modName) : (g.currentlyProvided ? 'Still shipped by something installed' : '<span class="muted">Not currently installed</span>')}</td>
    <td>${g.collectionName ? escHtmlSc(g.collectionName) : '&mdash;'}</td>
    <td>${g.count.toLocaleString()}</td>
  </tr>`).join('');
  $sc('scOrphanDetailModal').classList.remove('hidden');
}
$sc('scOrphanDetailCloseBtn').addEventListener('click', () => $sc('scOrphanDetailModal').classList.add('hidden'));

// ---------------------------------------------------------------------------------------------
// Step 3 -- choose what to clean
// ---------------------------------------------------------------------------------------------
$sc('scGoStep3Btn').addEventListener('click', async () => {
  scRenderStep3();
  scGoScreen('scStep3');
  try {
    const { running } = await scApi('GET', `/api/save-cleaner/skyrim-running?game=${encodeURIComponent(scCurrentGame)}`);
    $sc('scSkyrimRunningGate').classList.toggle('hidden', !running);
    $sc('scCleanBtn').disabled = running;
  } catch { /* best-effort -- the real gate is re-checked server-side on the actual Clean click anyway */ }
});

function scRenderStep3() {
  const problemCounts = {};
  for (const key of SC_CATEGORY_ORDER) problemCounts[key] = Number(scReportResult.problems[SC_CATEGORY_META[key].reportKey].count) || 0;
  const rows = SC_CATEGORY_ORDER.filter((k) => scSelectedCategories.has(k))
    .map((k) => `<tr><td style="width:60%">${SC_CATEGORY_META[k].title} to remove</td><td><b>${problemCounts[k].toLocaleString()}</b></td></tr>`)
    .join('');
  $sc('scPlanRows').innerHTML = rows;
  $sc('scResetHavokInput').checked = false;
  $sc('scPurifyFormListsInput').checked = false;
}
$sc('scBackToStep2Btn').addEventListener('click', () => scGoScreen('scStep2'));

// ---------------------------------------------------------------------------------------------
// Step 3b/4 -- clean (in-memory preview, never writes -- see lib/save-cleaner-runner.js's own
// header comment on why `save` re-runs this same pass rather than reusing it across processes)
// ---------------------------------------------------------------------------------------------
let scCleanResult = null;
function scCleanOptions() {
  return {
    categories: Array.from(scSelectedCategories),
    resetHavok: $sc('scResetHavokInput').checked,
    purifyFormLists: $sc('scPurifyFormListsInput').checked,
  };
}

$sc('scCleanBtn').addEventListener('click', async () => {
  const save = scCurrentSave();
  scHideCriticalError();
  scGoScreen('scCleaning');
  scStartElapsedTimer('scCleaningElapsed');
  scStartIndeterminateBar('scCleaningBar');
  try {
    await scApi('POST', '/api/save-cleaner/clean', { essPath: save.essPath, game: scCurrentGame, ...scCleanOptions() });
  } catch (e) {
    scStopElapsedTimer();
    scGoScreen('scStep3');
    if (e.status === 409 && e.body?.error === 'skyrim-running') {
      $sc('scSkyrimRunningGate').classList.remove('hidden');
      $sc('scCleanBtn').disabled = true;
      return;
    }
    scHandleError(e);
    return;
  }
  const es = new EventSource('/api/save-cleaner/clean/events');
  es.onmessage = (msg) => {
    const frame = JSON.parse(msg.data);
    if (frame.type === 'phase') {
      // No separate phase line -- same dedup fix as the Step 1b scScanning screen: the callout's
      // own static title already says "Cleaning save file…", and there's only ever one phase
      // message anyway.
    } else if (frame.type === 'result') {
      es.close();
      scStopElapsedTimer();
      scCleanResult = frame.result;
      scRenderStep4();
      scGoScreen('scStep4');
    } else if (frame.type === 'error') {
      es.close();
      scStopElapsedTimer();
      scGoScreen('scStep3');
      scShowCriticalError(frame.message);
    }
  };
});

// Every *Removed field the CLI actually returned -- only categories genuinely requested are present
// (CleanOperations.clean's own contract), so this never implies work that wasn't asked for.
const SC_CLEANED_LABELS = {
  unattachedRemoved: 'Orphans removed',
  undefinedRemoved: 'Definitions cleared',
  missingParentRemoved: 'Missing-parent scripts removed',
  noParentRemoved: 'No-parent scripts removed',
};
// Maps a *Removed result key back to its SC_CATEGORY_META category key, for the display-count
// fallback below.
const SC_REMOVED_TO_CATEGORY = {
  unattachedRemoved: 'unattached',
  undefinedRemoved: 'undefined',
  missingParentRemoved: 'missing-parent',
  noParentRemoved: 'no-parent',
};
function scRenderStep4() {
  const c = scCleanResult;
  const totalRemoved = Object.keys(SC_CLEANED_LABELS).reduce((sum, k) => sum + (c.cleaned[k] || 0), 0);
  $sc('scCleanedCount').textContent = totalRemoved.toLocaleString();

  const tiles = [];
  for (const [key, label] of Object.entries(SC_CLEANED_LABELS)) {
    if (c.cleaned[key] == null) continue;
    // The 4 categories aren't disjoint -- the same broken script can be unattached, undefined, AND
    // missing/no-parent all at once, and CleanOperations.clean runs categories in a fixed order,
    // mutating the save as it goes (see that Java file's own header comment). So a category picked
    // this run can genuinely show 0 removed here even though its own report count (Step 2) was real
    // -- an earlier category already removed those same scripts. That's correct, not a failure, so
    // display the original report count in that case rather than a confusing "0" for something the
    // user explicitly selected and that DID get cleaned (director's own call, 2026-08-26).
    let displayCount = c.cleaned[key];
    if (displayCount === 0) {
      const catKey = SC_REMOVED_TO_CATEGORY[key];
      const reportKey = SC_CATEGORY_META[catKey]?.reportKey;
      const originalCount = reportKey ? Number(scReportResult?.problems?.[reportKey]?.count) : 0;
      if (originalCount > 0) displayCount = originalCount;
    }
    tiles.push([`<span style="color:var(--success)">${displayCount.toLocaleString()}</span>`, label]);
  }
  if (c.cleaned.havok) tiles.push([c.cleaned.havok.success.toLocaleString(), 'Havok objects reset']);
  if (c.cleaned.formLists) tiles.push([c.cleaned.formLists.entriesRemoved.toLocaleString(), 'FormList entries cleared']);
  const delta = c.sizeBeforeMb - c.sizeAfterMb;
  tiles.push([scFormatMb(c.sizeAfterMb), 'New size']);
  tiles.push([`<span style="color:${delta >= 0 ? 'var(--success)' : 'var(--danger)'}">${delta >= 0 ? '−' : '+'}${scFormatMb(Math.abs(delta))}</span>`, delta >= 0 ? 'Smaller' : 'Larger']);
  $sc('scCleanedStatStrip').innerHTML = tiles.map(([n, label]) => `<div class="merge-stat"><div class="merge-stat__n">${n}</div><div class="merge-stat__l">${label}</div></div>`).join('');

  // Whether a backup folder is configured decides both this inline note (below) and whether
  // clicking Save needs a confirm at all (see scSaveBtn's own click handler) -- fetched once here
  // and cached so the Save click doesn't have to make the same call again.
  scApi('GET', '/api/settings').then((cfg) => {
    scBackupRootConfigured = !!cfg.saveCleanerBackupRoot;
    $sc('scOverwriteBackupNote').textContent = scBackupRootConfigured
      ? " (we'll still create an automatic .bak backup first)"
      : '';
  }).catch(() => { scBackupRootConfigured = false; });
}
let scBackupRootConfigured = false;
$sc('scCleanAnotherBtn').addEventListener('click', () => { scGoScreen('scStep1'); scLoadSaves(); });
$sc('scDoneBtn').addEventListener('click', () => { scGoScreen('scStep1'); scLoadSaves(); });

// ---------------------------------------------------------------------------------------------
// Step 5/5b -- Save / Save As
// ---------------------------------------------------------------------------------------------
$sc('scSaveAsBtn').addEventListener('click', async () => {
  const save = scCurrentSave();
  try {
    const { path } = await scApi('POST', '/api/save-cleaner/pick-save-target', { essPath: save.essPath, game: scCurrentGame });
    if (!path) return; // cancelled -- stay on Step 4 exactly as-is
    scRunSave(path);
  } catch (e) {
    scHandleError(e);
  }
});

$sc('scSaveBtn').addEventListener('click', async () => {
  const save = scCurrentSave();
  // A configured backup folder means the overwrite is genuinely recoverable -- the inline note
  // under "Overwrite Save" already said so, no need to interrupt with a confirm too. No backup
  // configured is the real risk (the original is gone for good if something goes wrong), so THAT's
  // the one case that gets a real "are you sure" -- re-checked fresh here rather than trusting the
  // Step 4 render's own cached value, in case Settings changed since.
  let backupConfigured = scBackupRootConfigured;
  try {
    const cfg = await scApi('GET', '/api/settings');
    backupConfigured = !!cfg.saveCleanerBackupRoot;
  } catch { /* fall back to the cached value from Step 4's own render */ }

  if (backupConfigured) {
    scRunSave(save.essPath);
    return;
  }
  $sc('scReplaceConfirmText').innerHTML = `This permanently replaces <code>${escHtmlSc(save.filename)}</code>${save.cosavePath ? ' and its companion <code>.skse</code> file' : ''} on disk with the cleaned data.`;
  $sc('scReplaceConfirmBackupNote').innerHTML = 'No automatic backup will be created because a backup directory is not configured (Settings → Save Cleaner). You will not be able to restore the original file if something goes wrong.<br><br>To keep your original save safe, choose <strong>Save As</strong> instead or configure a backup folder before proceeding.';
  $sc('scReplaceConfirmModal').classList.remove('hidden');
});
$sc('scReplaceCancelBtn').addEventListener('click', () => $sc('scReplaceConfirmModal').classList.add('hidden'));
$sc('scReplaceSaveAsInsteadBtn').addEventListener('click', () => { $sc('scReplaceConfirmModal').classList.add('hidden'); $sc('scSaveAsBtn').click(); });
$sc('scReplaceConfirmBtn').addEventListener('click', () => {
  $sc('scReplaceConfirmModal').classList.add('hidden');
  scRunSave(scCurrentSave().essPath);
});

let scLastSaveResult = null;
function scRunSave(outPath) {
  const save = scCurrentSave();
  scHideCriticalError();
  scGoScreen('scSaving');
  scStartElapsedTimer('scSavingElapsed');
  scStartIndeterminateBar('scSavingBar');
  (async () => {
    try {
      await scApi('POST', '/api/save-cleaner/save', { essPath: save.essPath, outPath, game: scCurrentGame, ...scCleanOptions() });
    } catch (e) {
      scStopElapsedTimer();
      scGoScreen('scStep4');
      if (e.status === 409 && e.body?.error === 'skyrim-running') {
        scShowCriticalError(e.message);
        return;
      }
      scHandleError(e);
      return;
    }
    const es = new EventSource('/api/save-cleaner/save/events');
    es.onmessage = (msg) => {
      const frame = JSON.parse(msg.data);
      if (frame.type === 'phase') {
        // No separate phase line -- same dedup fix as scScanning/scCleaning above.
      } else if (frame.type === 'result') {
        es.close();
        scStopElapsedTimer();
        scLastSaveResult = frame.result;
        scRenderStep6();
        scGoScreen('scStep6');
      } else if (frame.type === 'error') {
        es.close();
        scStopElapsedTimer();
        scGoScreen('scStep4');
        scShowCriticalError(frame.message);
      }
    };
  })();
}

function scRenderStep6() {
  const w = scLastSaveResult.written;
  const savedNumber = w.essPath.match(/Save(\d+)_/i)?.[1];
  const savedFilename = w.essPath.split(/[\\/]/).pop();
  $sc('scSavedTitle').textContent = savedNumber ? `🎉 Successfully Saved as Save ${savedNumber}` : '🎉 Successfully Saved';
  $sc('scSavedBody').innerHTML = `<code>${escHtmlSc(savedFilename)}</code> is ready.<br><br>Load it up in Skyrim and play for a few minutes to confirm everything runs smoothly. If anything feels off, your original save file is untouched.`;

  $sc('scOpenSaveFolderBtn').onclick = () => scApi('POST', '/api/rebuild/reveal', { targetPath: w.essPath }).catch(() => {});
}

// Game picker -- change saves list and directory when game selection changes
$sc('scGamePicker').addEventListener('change', (e) => {
  scCurrentGame = e.target.value;
  scResetOnEntry();
});
