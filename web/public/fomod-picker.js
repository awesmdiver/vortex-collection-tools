'use strict';
// Shared FOMOD choice picker -- moved 2026-09-17 ("Open FOMOD mods get an Install button") out of
// update-collection-v2-app.js, which built this deliberately reusable in the first place (its own
// original header comment: "Phase 3's own Added-mod FOMOD needs can drive this same component
// later"). Rebuild Missing Files and Rebuild Collection now drive the SAME component for their own
// new Install action against a real Open FOMOD row -- one picker, one bug, matching Update
// Collection's own unchanged look/behavior/step logic exactly. Loaded before app.js/
// rebuild-missing-app.js/update-collection-v2-app.js in index.html, since all three call into it.
//
// The modal's own markup/CSS moved again on 2026-09-17 ("Install opens an invisible picker") -- it
// was actually still nested inside <section id="area-update-collection-v2">, one level up from
// Update Collection's own screen containers, so opening it from Rebuild Missing Files or Rebuild
// Collection (Update Collection not the active tool, so its whole area is `display:none`) added the
// `open` class to a modal nobody could see or click. See index.html's shared-modals-zone comment on
// this markup for the full story. The markup keeps its historical `ucv2FomodPicker*`/
// `.ucv2-fomod-*` ids/classes verbatim (a plain getElementById lookup doesn't care what a caller's
// own naming convention was) rather than a cosmetic-only rename that would touch a dozen HTML ids
// for zero functional benefit -- flagged in this task's own handoff as a disclosed naming-debt item,
// not silently glossed over.
//
// Public API: `showFomodPicker(needs, { onDone, onCancel, reinstallWarning, onIgnoreValidation })`.
//   needs: [{ modId, name, reason: 'open'|'mismatch'|'invalid', parsedFomod, warnings?,
//     existingChoices?, installedFileState, validation?, validationBypassed? }] (the exact shape
//     lib/fomod-picker-data.js's detectFomodChoiceNeed already produces -- server data is never
//     reshaped for this module). installedFileState (2026-09-15, "pre-select options the way Vortex
//     does, based on what's actually installed") is `{ available: true, present, active }` (plain
//     arrays of lowercased plugin filenames) or `{ available: false }` -- showFomodPicker() converts
//     present/active to Sets in place the first time it sees each need
//     (fomodPrepareInstalledFileState), so fomodEvalCondition's own fileDependency checks are an
//     O(1) lookup.
//   onDone(picksByModId): called once every mod in `needs` has a real answer, with
//     `{ [modId]: {[stepIdx]: {[groupIdx]: number[]}} }` -- the caller's own job to turn each mod's
//     answers into real `{type:'fomod', options}` choices via buildFomodChoicesFromPicks and do
//     whatever it needs to with them (Update Collection merges into its own cross-retry
//     accumulator and re-POSTs Apply; Rebuild Missing Files/Rebuild Collection use it immediately
//     for that one mod's own Install action). This module holds NO opinion on what happens next.
//   onCancel(): called if the user closes/cancels before finishing every mod. Optional -- a caller
//     with nothing to do on cancel (Rebuild Missing Files/Rebuild Collection: "Cancel changes
//     nothing") can simply omit it.
//   reinstallWarning: true when this session was opened from an Install action (a clean reinstall
//     from the archive) rather than Update Collection's own Apply flow -- shows an extra sentence
//     under the intro on step 1 saying so, since Update Collection's own Apply never touches an
//     already-installed mod's existing files the way Install now does.
//   onIgnoreValidation(need) (2026-09-15, "validate the installer against the real schema" -- real
//     Vortex's own "Invalid fomod" dialog/Ignore retry, item 2a): called when the director clicks
//     "Install Anyway" on a `reason: 'invalid'` need's own blocking screen. Optional, but a `reason:
//     'invalid'` need with no caller-supplied handler shows the blocking screen with no way past it
//     (Cancel only) rather than silently guessing. Its own contract: return (a Promise resolving to)
//     a FRESH need object (same shape as a normal 'open'/'mismatch' need) to continue THIS SAME
//     picker session in place with that mod now resolved -- fomod-picker.js substitutes it into
//     `fomodPickerNeeds` and re-renders from step 0. Return/resolve to a falsy value instead when the
//     caller is handling its OWN next step entirely (e.g. Update Collection v2 re-runs its whole
//     Apply request with the override recorded, which will reopen the picker fresh later if still
//     needed) -- fomod-picker.js then does nothing further, leaving the modal exactly as the caller
//     left it. A thrown/rejected error surfaces in the modal's own error callout, same as a step
//     validation error.
let fomodPickerNeeds = [];
let fomodPickerIndex = 0;
let fomodPickerOnDone = null;
let fomodPickerOnCancel = null;
let fomodPickerOnIgnoreValidation = null;
let fomodPickerReinstallWarning = false;
let fomodPickerStepIdx = 0;
let fomodPickerAnswers = {}; // {[stepIdx]: {[groupIdx]: number[]}} -- this mod's own picks so far
let fomodPickerPicks = {}; // modId -> that mod's own finished fomodPickerAnswers, accumulated across this ONE show() session
let fomodPickerInitedSteps = new Set(); // `${modIndex}:${stepIdx}` -- Required/preset auto-pick runs once per step, not every render
// `${modIndex}:${stepIdx}` of the step fomodRenderStep last drew -- lets it tell "genuinely entered
// a new step" apart from "just toggled an option and re-rendered the same one" (see that function's
// own comment on why it re-renders in place on every selection change).
let fomodPickerLastRenderedStepKey = null;
let fomodPickerPrevStepIdx = -1;
let fomodPickerNextStepIdx = -1;

// Same one-line getElementById wrapper this project already defines redundantly in several other
// *-app.js files (cleanup-app.js, settings-app.js, stats-app.js, ...) -- defined again here, not
// imported, so this module has NO dependency on script LOAD ORDER relative to any of them (it
// registers real event listeners at module-load time below, before any tool-specific app.js has
// necessarily run yet).
function $g(id) { return document.getElementById(id); }

function escHtmlFomodPicker(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Converts each need's own installedFileState.present/active (plain arrays -- JSON-safe over HTTP)
// into real Sets, once, so fomodFileDependencyMatches does an O(1) lookup per fileDependency instead
// of rebuilding a Set on every single evaluation (a step can re-evaluate every plugin's type on every
// render). A need with no installedFileState at all (an older cached response, or a reason this
// gate never attaches it to) is left alone -- fomodFileDependencyMatches already treats a missing/
// unavailable fileState as "not matched", the same honest fallback as an explicit `available: false`.
function fomodPrepareInstalledFileState(needs) {
  needs.forEach((need) => {
    const fs = need.installedFileState;
    if (fs && fs.available && !fs.presentSet) {
      fs.presentSet = new Set(fs.present || []);
      fs.activeSet = new Set(fs.active || []);
    }
  });
}

function showFomodPicker(needs, { onDone, onCancel, reinstallWarning, onIgnoreValidation } = {}) {
  fomodPrepareInstalledFileState(needs);
  // Real fixSteps() runs ONCE per real install, before any UI/pre-selection -- see
  // fomodFixGroupTypes' own header comment. A `reason: 'invalid'` need has no parsedFomod yet (its
  // own blocking screen doesn't need one), so it's skipped here and fixed up later if "Install
  // Anyway" ever resolves it.
  needs.forEach((need) => { if (need.parsedFomod) fomodFixGroupTypes(need); });
  fomodPickerNeeds = needs;
  fomodPickerIndex = 0;
  fomodPickerStepIdx = 0;
  fomodPickerAnswers = {};
  fomodPickerPicks = {};
  fomodPickerInitedSteps = new Set();
  fomodPickerLastRenderedStepKey = null;
  fomodPickerOnDone = onDone || null;
  fomodPickerOnCancel = onCancel || null;
  fomodPickerOnIgnoreValidation = onIgnoreValidation || null;
  fomodPickerReinstallWarning = !!reinstallWarning;
  $g('ucv2FomodPickerModal').classList.add('open');
  fomodRenderStep();
}

function fomodGroupInputName(stepIdx, groupIdx) {
  return `fomodpicker-s${stepIdx}-g${groupIdx}`;
}

// fileDependency ("state" is Active/Inactive/Missing) resolved against the player's REAL install.
// `fileState` is lib/fomod-picker-data.js's own resolveInstalledFileState() result, round-tripped
// on `need.installedFileState` -- `{ available: true, presentSet, activeSet }` (Sets built once in
// showFomodPicker() from the server's plain arrays) or `{ available: false }` when
// skyrimDataDir/pluginsListDir aren't configured or couldn't be read.
//
// Confirmed against the real engine (PluginCondition.cs's own GetIsFulfilled, via
// CallbackPluginDelegates.cs -> Vortex's own SharedDelegates.ts getAllPlugins()): a fileDependency
// can ONLY ever resolve Active/Inactive for a real PLUGIN file (.esp/.esm/.esl) -- Vortex's own
// delegate answers strictly from its tracked plugin list, which by construction never contains a
// loose file or a BSA. A fileDependency naming anything else always resolves Missing in real Vortex
// too, not a limitation unique to this project.
//
// "Keep it honest when we can't tell" (2026-09-15, this task's own explicit instruction): when
// fileState isn't available, a fileDependency is treated as NOT matched (false) rather than
// vacuously true. Reproducing the OLD bug (silently dropping fileDependency, which behaved as
// vacuously true) would keep over-selecting exactly the boxes this whole fix exists to stop
// over-selecting; under-selecting to Optional/plain-default is the honest failure mode, paired with
// the picker's own one-line disclosure (see fomodRenderStep's ucv2FomodPickerNoDataNote).
const FOMOD_PLUGIN_EXT_RE = /\.(esp|esm|esl)(\.ghost)?$/i;
function fomodFileDependencyMatches(dep, fileState) {
  if (!fileState || !fileState.available) return false;
  const key = (dep.file || '').trim().toLowerCase();
  if (!FOMOD_PLUGIN_EXT_RE.test(key)) return dep.state === 'Missing';
  const present = fileState.presentSet.has(key);
  const active = fileState.activeSet.has(key);
  if (dep.state === 'Active') return present && active;
  if (dep.state === 'Inactive') return present && !active;
  if (dep.state === 'Missing') return !present;
  return false;
}

// A composite condition (an installStep's <visible>, or a typeDescriptor pattern's <dependencies>)
// -- {operator: 'And'|'Or', flagDependencies, fileDependencies, gameDependencies,
// extenderDependencies, nested}. Confirmed against the real engine (CompositeCondition.cs's own
// GetIsFulfilled): an EMPTY condition list is vacuously true for And (the loop's own accumulator
// starts true) but vacuously FALSE for Or (starts false) -- native Array.prototype.every()/some()
// already give exactly this per-operator behavior with no length-check needed, which is why this no
// longer special-cases an empty list to true regardless of operator the way it used to.
//
// FIXED 2026-09-15 -- the old blanket "no dependencies -> true" rule was only ever confirmed against
// a real empty AND ("Window Shadows Ultimate - Patch Hub"'s own <visible operator="And"></visible>)
// and wrongly generalized to Or too. Concrete real bug this caused: Atlas Map Markers Overhaul's own
// "The Great City of the North - Winterhold" plugin gates its Recommended pattern on a literal empty
// `<dependencies operator="Or"></dependencies>` -- the old code resolved that to true (Recommended,
// pre-selected); the real engine resolves an empty Or to false (falls through to defaultType,
// Optional, NOT pre-selected), which is what this plugin's sibling ("The Great City of Winterhold")
// is supposed to be picked instead of.
//
// gameDependency/extenderDependencies are evaluated as always-satisfied -- see fomod-parser.js's own
// parseCondition header for why (no live game-version-extender data source in this project; a
// disclosed, narrow limitation, not encountered in either real mod this task verified against).
function fomodEvalCondition(cond, flags, fileState) {
  if (!cond) return true;
  const flagTest = (d) => (flags.get(d.flag) ?? '') === d.value;
  const fileTest = (d) => fomodFileDependencyMatches(d, fileState);
  const nestedTest = (c) => fomodEvalCondition(c, flags, fileState);
  const results = [
    ...(cond.flagDependencies || []).map(flagTest),
    ...(cond.fileDependencies || []).map(fileTest),
    ...(cond.gameDependencies || []).map(() => true),
    ...(cond.extenderDependencies || []).map(() => true),
    ...(cond.nested || []).map(nestedTest),
  ];
  return cond.operator === 'Or' ? results.some(Boolean) : results.every(Boolean);
}

// First matching pattern wins; falls back to the default type if none match -- exact real engine
// order (ConditionalOptionTypeResolver.ResolveOptionType).
//
// isPresetMatch (item 4f, 2026-09-15, diagnostics/fomod-parity/findings-log.md): real Vortex's own
// preselectOptions force-promotes a preset-recorded option's type resolver to a static
// `CouldBeUsable` when its own real resolution is `NotUsable` -- "otherwise the user might not be
// able to deselect it even if it is actually invalid." Without this, a collection's recorded choice
// that no longer cleanly matches the player's current setup renders permanently disabled, with no
// way to uncheck it, re-check it, or replace it -- exactly the `reason: 'mismatch'` replay case
// where the player most needs to fix their own pick by hand. `CouldBeUsable` is a real, distinct
// FOMOD type (the schema's own `pluginTypeEnum` has five values: Required/Optional/Recommended/
// NotUsable/CouldBeUsable) that already renders as a perfectly normal, non-disabled option
// everywhere this file checks `type` (`disabled={... || plugin.type === "NotUsable"}` in real
// Vortex never includes it either) -- so promoting to it, rather than inventing a new state, is both
// the real engine's own literal mechanism and requires no new render-path special-casing. Does NOT
// become `Required` (never force-selected by this promotion alone) and does NOT skip normal group
// validation -- callers that don't know about a preset match (`fomodFixGroupTypes`'s own item 5e
// reclassification, which the real engine's own `fixSteps()` runs BEFORE `preselectOptions` ever
// promotes anything) simply omit the 4th argument and get the untouched, real resolution.
function fomodResolveType(typeDescriptor, flags, fileState, isPresetMatch) {
  let type = 'Optional';
  if (typeDescriptor) {
    type = typeDescriptor.default || 'Optional';
    for (const p of typeDescriptor.patterns || []) {
      if (fomodEvalCondition(p.condition, flags, fileState)) { type = p.type; break; }
    }
  }
  return (isPresetMatch && type === 'NotUsable') ? 'CouldBeUsable' : type;
}

// Real fixSteps() (XmlScriptExecutor.cs) -- runs ONCE, at the very start of the real install, before
// any UI is built and before any pre-selection happens: `SelectAtMostOne` with 2+ options resolving
// Required -> `SelectAny`; `SelectExactlyOne` with 2+ Required -> `SelectAtLeastOne`. Required-ness
// can be condition-gated (a dynamic <typeDescriptor>), so a nominally-exclusive group can legally end
// up with two mandatory options -- and an exclusive group physically can't hold both. Without this,
// a SelectExactlyOne/SelectAtMostOne group with 2+ dynamically-Required options would (via
// fomodInitStepAnswersOnce's own last-wins radio-collapse logic below) silently drop every Required
// option but one from the actual install -- a real, if unconfirmed-in-the-wild, silent data-loss bug
// (item 5e, diagnostics/fomod-parity/findings-log.md -- the audit's own worst failure mode).
//
// Evaluated with NO flags (an empty Map, not fomodFlagsUpTo -- the real fixSteps genuinely runs
// before ANY step has been processed, not just before the CURRENT one) but WITH real
// installedFileState -- fileDependency/gameDependency conditions are independent of any flag and the
// real engine's own coreDelegates already carry real installed-plugin state at this point, only the
// FLAG side of a condition is genuinely unset yet.
//
// Mutates `group.type` in place -- every downstream reader (rendering, isRadio, pre-selection,
// Next/Finish validation) already reads `group.type` fresh on every call, so one mutation here is all
// that's needed. Idempotent to call again (re-derives the same promoted type from the same static
// data every time), so it's safe to re-run whenever a need's parsedFomod is freshly (re)established --
// showFomodPicker() runs it once per need up front, and the "Install Anyway" retry (which substitutes
// a brand-new parsedFomod mid-session) runs it again for that one need.
function fomodFixGroupTypes(need) {
  const emptyFlags = new Map();
  need.parsedFomod.installSteps.forEach((step) => {
    step.groups.forEach((group) => {
      if (group.type !== 'SelectAtMostOne' && group.type !== 'SelectExactlyOne') return;
      const requiredCount = group.plugins.filter(
        (p) => fomodResolveType(p.typeDescriptor, emptyFlags, need.installedFileState) === 'Required'
      ).length;
      if (requiredCount <= 1) return;
      group.type = group.type === 'SelectAtMostOne' ? 'SelectAny' : 'SelectAtLeastOne';
    });
  });
}

function fomodAddGroupFlags(flags, group, selectedIndices) {
  const selected = group.type === 'SelectAll'
    ? group.plugins.map((_, idx) => idx)
    : (selectedIndices || []);
  selected.forEach((idx) => {
    const plugin = group.plugins[idx];
    if (!plugin) return;
    (plugin.conditionFlags || []).forEach((f) => flags.set(f.name, f.value));
  });
}

// Condition flags contributed by every group answered so far, STRICTLY BEFORE (stepIdx, groupIdx)
// in document order -- every group of every earlier step, plus (when groupIdx is given) the
// earlier groups of stepIdx itself. Rebuilt from scratch on every call (not cached) so going back
// and changing an earlier answer correctly un-sets whatever flags that old pick had contributed --
// mirrors choice-resolver.js's own flags-building, just done incrementally at pick-time instead of
// after the fact. Pass groupIdx=undefined to get flags for the WHOLE of stepIdx (step-visibility
// checks, which only care about steps strictly before stepIdx).
function fomodFlagsUpTo(need, answers, stepIdx, groupIdx) {
  const flags = new Map();
  const steps = need.parsedFomod.installSteps;
  for (let s = 0; s < stepIdx && s < steps.length; s++) {
    const stepAnswers = answers[s] || {};
    steps[s].groups.forEach((group, gi) => fomodAddGroupFlags(flags, group, stepAnswers[gi]));
  }
  if (groupIdx !== undefined && steps[stepIdx]) {
    const stepAnswers = answers[stepIdx] || {};
    for (let g = 0; g < groupIdx; g++) fomodAddGroupFlags(flags, steps[stepIdx].groups[g], stepAnswers[g]);
  }
  return flags;
}

// Visibility for every step, index-aligned -- each entry evaluated against flags from every step
// strictly before it (a step's own answers can't affect its own visibility).
function fomodComputeStepVisibility(need, answers) {
  const steps = need.parsedFomod.installSteps;
  return steps.map((step, i) => fomodEvalCondition(step.visible, fomodFlagsUpTo(need, answers, i), need.installedFileState));
}

// The "mismatch" case's own existingChoices (the collection's own recorded-but-stale picks) --
// matched by GROUP NAME (trimmed), same convention choice-resolver.js's resolveChoices() already
// uses for its own recorded-choices matching. Returns the set of plugin NAMES (trimmed) that were
// previously chosen for this exact step+group -- empty for "open" (need.existingChoices absent) or
// any step/group with no corresponding recorded entry.
function fomodPresetNames(need, stepIdx, groupIdx) {
  if (!need.existingChoices || !need.existingChoices.options) return new Set();
  const recordedStep = need.existingChoices.options[stepIdx];
  if (!recordedStep) return new Set();
  const step = need.parsedFomod.installSteps[stepIdx];
  const groupNameTrimmed = (step.groups[groupIdx].name || '').trim();
  const recordedGroup = (recordedStep.groups || []).find((g) => (g.name || '').trim() === groupNameTrimmed);
  if (!recordedGroup) return new Set();
  return new Set((recordedGroup.choices || []).map((c) => (c.name || '').trim()));
}

// Auto-picks Required-type plugins (can't be deselected, matches the real engine's own
// `readOnly = plugin.type === 'Required'`), a Recommended-type plugin when there's no recorded
// preset to replay, and (for the "mismatch" case) whatever matches a recorded preset choice by
// name -- runs exactly ONCE per (mod, step) so revisiting a step via Back/Next never clobbers the
// user's own subsequent edits.
//
// REWRITTEN 2026-09-15 ("FaceGens (required) group has neither option selected and Finish is
// enabled") -- matched against the real engine's own preselectOptions() (Nexus-Mods/fomod-installer,
// src/InstallScripting/XmlScript/XmlScriptExecutor.cs):
//   - 'Recommended' auto-selects itself too, but ONLY `!m_Preset.HasValue` -- i.e. need.reason ===
//     'open' (no recorded choice anywhere to replay). A "mismatch" pick (existingChoices present)
//     still only auto-selects Required/preset-name matches, unchanged from before.
//   - For a radio group (SelectExactlyOne/SelectAtMostOne) with more than one option qualifying at
//     once (e.g. two Recommended options -- confirmed real, "Immersive College NPCs"' own FaceGens
//     group: neither plugin's <typeDescriptor> pattern condition is a <flagDependency> this
//     project's own fomod-parser.js evaluates -- see its header's documented <fileDependency> gap
//     -- so both plugins resolve Recommended here), the real engine repeatedly clears the WHOLE
//     group then selects just the option it's currently processing, so the LAST qualifying option
//     in document order is what actually ends up selected, not the first.
//   - A SelectExactlyOne group that still has nothing selected after all of the above (no Required,
//     no Recommended, no preset) always defaults to its own FIRST option (`setFirst` in the real
//     source) -- a SelectExactlyOne group can never legitimately render with nothing picked.
//     Deliberately NOT applied to SelectAtMostOne, which never gets this fallback in the real
//     source either -- this picker's own "(None)" radio already lets that group genuinely stay
//     empty, matching real Vortex.
function fomodInitStepAnswersOnce(need, stepIdx) {
  const key = `${fomodPickerIndex}:${stepIdx}`;
  if (fomodPickerInitedSteps.has(key)) return;
  fomodPickerInitedSteps.add(key);
  const step = need.parsedFomod.installSteps[stepIdx];
  fomodPickerAnswers[stepIdx] = fomodPickerAnswers[stepIdx] || {};
  step.groups.forEach((group, groupIdx) => {
    if (group.type === 'SelectAll') return; // nothing to init -- server auto-includes these regardless
    const flags = fomodFlagsUpTo(need, fomodPickerAnswers, stepIdx, groupIdx);
    const presetNames = fomodPresetNames(need, stepIdx, groupIdx);
    const isRadio = group.type === 'SelectExactlyOne' || group.type === 'SelectAtMostOne';
    const forced = [];
    group.plugins.forEach((plugin, idx) => {
      const isPreset = presetNames.has((plugin.name || '').trim());
      const type = fomodResolveType(plugin.typeDescriptor, flags, need.installedFileState, isPreset);
      const autoSelects = type === 'Required' || isPreset || (need.reason === 'open' && type === 'Recommended');
      if (autoSelects) forced.push(idx);
    });
    if (!isRadio) {
      fomodPickerAnswers[stepIdx][groupIdx] = forced;
    } else if (forced.length > 0) {
      fomodPickerAnswers[stepIdx][groupIdx] = [forced[forced.length - 1]];
    } else if (group.type === 'SelectExactlyOne' && group.plugins.length > 0) {
      fomodPickerAnswers[stepIdx][groupIdx] = [0];
    } else {
      fomodPickerAnswers[stepIdx][groupIdx] = [];
    }
  });
}

// readOnly (item 5g, 2026-09-15): real Vortex's own treatment for a Required option
// (InstallerDialog.tsx: `readOnly = type === "Required"`, deliberately NOT `disabled` --
// `disabled={disabled || plugin.type === "NotUsable"}` never includes Required at all). A Required
// checkbox looks like a perfectly normal, checked checkbox in real Vortex -- just doesn't respond --
// rather than the browser's own disabled/greyed chrome. A native checkbox/radio has no real
// "readonly" attribute (that's text-input-only), so this intercepts the click itself: calling
// `preventDefault()` on 'click' stops the browser from ever flipping the input's own internal
// checked state in the first place, before a 'change' event would even fire -- no visible flicker,
// no dependency on a re-render to snap it back. Distinct from `disabled` (still used for NotUsable,
// and for a SelectAll row below -- Vortex's own SelectAll rendering really is `disabled=true`, a
// genuinely different, dimmed treatment from Required's own normal-but-inert one; the two must never
// be unified into the same visual state).
function fomodBuildOptionRow({
  id, inputType, name, value, checked, disabled, readOnly, label, preset, title, onChange,
}) {
  const row = document.createElement('label');
  row.className = `ucv2-fomod-option${disabled ? ' is-disabled' : ''}`;
  row.htmlFor = id;
  if (title) row.title = title;
  const input = document.createElement('input');
  input.type = inputType;
  input.id = id;
  input.name = name;
  input.value = value;
  input.checked = checked;
  input.disabled = disabled;
  if (readOnly) {
    input.addEventListener('click', (e) => e.preventDefault());
  } else {
    input.addEventListener('change', onChange);
  }
  row.appendChild(input);
  const span = document.createElement('span');
  span.textContent = label;
  if (preset) {
    const presetSpan = document.createElement('span');
    presetSpan.className = 'ucv2-fomod-option__preset';
    presetSpan.textContent = ' (Preset)';
    span.appendChild(presetSpan);
  }
  row.appendChild(span);
  return row;
}

// Real DOM nodes with real event listeners (closures over the plugin object), NOT innerHTML with
// inline attribute strings -- a real option name like "JK's Castle Dour" contains an apostrophe,
// which breaks out of a single-quoted inline attribute string (confirmed live while building the
// approved mockup).
function fomodBuildGroupEl(need, stepIdx, group, groupIdx) {
  const groupEl = document.createElement('div');
  groupEl.className = 'ucv2-fomod-group';
  const nameEl = document.createElement('div');
  nameEl.className = 'ucv2-fomod-group__name';
  nameEl.textContent = group.name;
  // (required) (2026-08-28, director's own live catch: hit fomodValidateStep's own "needs exactly
  // one pick" refusal with no advance warning this group even had that requirement) -- same two
  // group types that refusal already gates on, so the label and the real validation can never
  // drift out of sync.
  if (group.type === 'SelectExactlyOne' || group.type === 'SelectAtLeastOne') {
    const reqSpan = document.createElement('span');
    reqSpan.className = 'muted';
    reqSpan.style.fontWeight = '400';
    reqSpan.style.textTransform = 'none';
    reqSpan.style.letterSpacing = 'normal';
    reqSpan.textContent = ' (required)';
    nameEl.appendChild(reqSpan);
  }
  groupEl.appendChild(nameEl);

// Real per-plugin rows (item 5f, 2026-09-15) -- real Vortex's own `InstallerDialog.tsx::
  // Group.renderPlugin` renders a REAL, individually-named, checked, `disabled=true` checkbox per
  // plugin in a SelectAll group, each wired to the same hover-preview as every other group type, so
  // the user can see exactly what's being force-installed (including its own image/description).
  // The old one-line summary ("Everything in this group installs automatically — nothing to
  // choose.") is gone -- the real rows now carry that information themselves. `disabled: true`
  // (not `readOnly`) deliberately -- this is Vortex's own genuinely-disabled/dimmed treatment, the
  // same one NotUsable already gets, NOT the Required "looks normal" treatment (see
  // fomodBuildOptionRow's own header comment for why the two must stay visually distinct).
  if (group.type === 'SelectAll') {
    const inputName = fomodGroupInputName(stepIdx, groupIdx);
    group.plugins.forEach((plugin, idx) => {
      const row = fomodBuildOptionRow({
        id: `${inputName}-${idx}`, inputType: 'checkbox', name: inputName, value: String(idx),
        checked: true, disabled: true, label: plugin.name, preset: false,
        title: 'Always installed', onChange: () => {},
      });
      row.addEventListener('mouseenter', () => fomodShowPreview(plugin, row));
      groupEl.appendChild(row);
    });
    return groupEl;
  }

  const isRadio = group.type === 'SelectExactlyOne' || group.type === 'SelectAtMostOne';
  const inputName = fomodGroupInputName(stepIdx, groupIdx);
  const flags = fomodFlagsUpTo(need, fomodPickerAnswers, stepIdx, groupIdx);
  const presetNames = fomodPresetNames(need, stepIdx, groupIdx);
  const selected = new Set((fomodPickerAnswers[stepIdx] && fomodPickerAnswers[stepIdx][groupIdx]) || []);

  // A real "(None)" radio, so a genuine zero-selection SelectAtMostOne choice is representable
  // without needing custom radio-deselect behavior no browser supports natively.
  if (group.type === 'SelectAtMostOne') {
    groupEl.appendChild(fomodBuildOptionRow({
      id: `${inputName}-none`, inputType: 'radio', name: inputName, value: '-1',
      checked: selected.size === 0, disabled: false, label: '(None)', preset: false,
      onChange: () => fomodOnSelect(stepIdx, groupIdx, []),
    }));
  }

  group.plugins.forEach((plugin, idx) => {
    const isPreset = presetNames.has((plugin.name || '').trim());
    // Raw (un-promoted) resolution first -- needed both to feed fomodResolveType's own promotion
    // (item 4f) and, separately, to know WHETHER a promotion actually happened (vs. an option whose
    // pattern literally declares `<type name="CouldBeUsable"/>` on its own, unrelated to any preset
    // match), so the right explanatory tooltip can be chosen below without a second, redundant
    // condition-evaluation pass.
    const rawType = fomodResolveType(plugin.typeDescriptor, flags, need.installedFileState);
    const wasPromotedFromNotUsable = isPreset && rawType === 'NotUsable';
    const type = wasPromotedFromNotUsable ? 'CouldBeUsable' : rawType;
    const isRequired = type === 'Required';
    const isNotUsable = type === 'NotUsable';
    const row = fomodBuildOptionRow({
      id: `${inputName}-${idx}`,
      inputType: isRadio ? 'radio' : 'checkbox',
      // Forced true regardless of `selected` (item 5g) -- matches real Vortex's own always-checked
      // Required treatment exactly, rather than relying on pre-selection state alone having already
      // put it there.
      checked: isRequired || selected.has(idx),
      name: inputName,
      value: String(idx),
      disabled: isNotUsable,
      readOnly: isRequired,
      label: plugin.name,
      preset: isPreset,
      title: isNotUsable
        ? 'Not available with your other current picks'
        : isRequired
          ? 'Required -- always installed'
          // New string (item 4f) -- shown only for a preset-recorded option that would otherwise
          // have rendered disabled, so the player understands why a "(Preset)" option looks
          // ordinary/selectable despite not fitting their current setup.
          : wasPromotedFromNotUsable
            ? 'Your original pick — it may not fit your current setup, but you can keep it or choose something else.'
            : undefined,
      onChange: () => {
        let next;
        if (isRadio) {
          next = [idx];
        } else {
          const cur = new Set((fomodPickerAnswers[stepIdx] && fomodPickerAnswers[stepIdx][groupIdx]) || []);
          if (cur.has(idx)) cur.delete(idx); else cur.add(idx);
          next = [...cur];
        }
        fomodOnSelect(stepIdx, groupIdx, next);
      },
    });
    row.addEventListener('mouseenter', () => fomodShowPreview(plugin, row));
    groupEl.appendChild(row);
  });

  return groupEl;
}

// Selecting an option can change OTHER options' real type (a dynamic typeDescriptor pattern keyed
// on this group's own conditionFlags) or a later step's own visibility -- re-rendering the whole
// step on every change is simple and correct (matches the real engine's own re-evaluate-on-select
// behavior) and the DOM here is small enough that this is never a real performance concern.
function fomodOnSelect(stepIdx, groupIdx, next) {
  fomodPickerAnswers[stepIdx] = fomodPickerAnswers[stepIdx] || {};
  fomodPickerAnswers[stepIdx][groupIdx] = next;
  fomodRenderStep();
}

// Hover-driven, not click/selection-driven -- confirmed against real Vortex (InstallerDialog.tsx's
// own `onMouseOver={this.showDescription}`). Real image bytes (2026-08-28, director's own build-out
// -- checked against Vortex's own real FOMOD wizard first, InstallerDialog.tsx's renderImage(): it
// points a plain <img> at an already-fully-extracted file, no per-hover extraction or data URI) --
// lib/fomod-picker-data.js's own detectFomodChoiceNeed already extracted every plugin image up
// front, served here via the one shared GET /api/fomod-image route (mounted once in web/server.js,
// not per-tool -- any of the three tools' own detectFomodChoiceNeed calls populate the SAME
// server-side image cache, keyed by the mod's own Nexus modId).
//
// No onerror handler (2026-09-15, "preview images don't show unless they sit in a top-level Images
// folder") -- checked Vortex's own real ZoomableImage (src/renderer/src/controls/ZoomableImage.tsx,
// this project's own vortex clone): it renders a plain `<Image src={url}>` with no onError at all
// when `image` is truthy, even when the referenced file genuinely doesn't exist (a real author
// mistake, e.g. "Immersive College NPCs"' own "Change Log v1.0" plugin references "fomod\
// cya_logo.png", which isn't in the archive). Real Vortex just lets that `<img>` fail natively --
// the browser's own default broken-image glyph, no text, no custom fallback -- so this drops the
// custom `🖼️ <filename>` fallback entirely rather than inventing a nicer-looking failure state
// Vortex itself doesn't have. `imgSrc` stays unset (no image area at all, matching
// `renderImage()` returning `null`) only when the plugin has no `<image>` reference in the first
// place.
//
// The muted "Hover over an option..." placeholder (item 10a, 2026-09-15) is ONLY for the genuine
// nothing-hovered-yet state (`plugin` itself is null/undefined) -- real Vortex's own pane is empty
// there too, and an empty pane on open teaches nobody anything, so this stays a deliberate,
// disclosed divergence, not a gap. Once something IS hovered, real Vortex's own `renderImage()` (`if
// (!dataPath || !image) return null`) renders literally nothing for a missing image -- no
// placeholder -- so a hovered plugin with neither image nor description now falls through to the
// same imgHtml/descHtml construction as any other plugin, which naturally produces an empty string
// for each missing piece (`el.innerHTML = '' + '' === ''`), matching Vortex's own "nothing" exactly
// instead of reusing the opening hint's text for a case that isn't the opening state at all.
function fomodShowPreview(plugin, rowEl) {
  document.querySelectorAll('#ucv2FomodPickerOptions .ucv2-fomod-option.is-active').forEach((r) => r.classList.remove('is-active'));
  if (rowEl) rowEl.classList.add('is-active');
  const el = $g('ucv2FomodPickerPreview');
  if (!plugin) {
    el.innerHTML = '<div class="ucv2-fomod-preview__empty">Hover over an option to see its image and description.</div>';
    return;
  }
  const need = fomodPickerNeeds[fomodPickerIndex];
  const imgSrc = plugin.image && need && need.modId
    ? `/api/fomod-image?modId=${encodeURIComponent(need.modId)}&imagePath=${encodeURIComponent(plugin.image)}`
    : null;
  const imgHtml = imgSrc
    ? `<div class="ucv2-fomod-preview__image"><img src="${escHtmlFomodPicker(imgSrc)}" alt=""></div>`
    : '';
  // white-space: pre-wrap on .ucv2-fomod-preview__desc (styles.css, item 11b) now does ALL of the
  // whitespace preservation -- indentation, runs of spaces, blank lines, AND real newlines --
  // matching real Vortex's own dialog-fomod.scss exactly, so the old selective `\r?\n` -> `<br>`
  // substitution is gone; the escaped text's own real newlines render as real line breaks on their
  // own. Escaping itself is unchanged (author-supplied text is untrusted input either way).
  const descHtml = plugin.description
    ? `<div class="ucv2-fomod-preview__desc">${escHtmlFomodPicker(plugin.description)}</div>`
    : '';
  el.innerHTML = imgHtml + descHtml;
  // Click-to-zoom (item 10d, 2026-09-15) -- real Vortex's own ZoomableImage opens an enlarged
  // overlay on click. `el.innerHTML` was just rebuilt from a raw string above (not real DOM nodes
  // with listeners -- this file's own header comment on avoiding inline attribute strings for
  // apostrophe-safety applies here too), so the just-inserted <img> is found and wired up
  // afterward, same pattern as the option rows' own `mouseenter` wiring elsewhere in this file.
  if (imgSrc) {
    const imgEl = el.querySelector('.ucv2-fomod-preview__image img');
    if (imgEl) imgEl.addEventListener('click', () => fomodOpenImageZoom(imgSrc));
  }
}

// item 10d -- opens/closes the full-size image overlay (ucv2FomodZoomOverlay, index.html). Escape
// and a click on the backdrop (never the image itself) both close it, the same two ways every other
// overlay in this app closes (Escape: same add-on-open/remove-on-close document-listener pattern as
// Rules Generator's own conflict popover, `rgConflictPopoverEscape` -- the one existing precedent
// for Escape-closing an overlay in this codebase; outside-click: checking `e.target` is the backdrop
// itself, not a delegated document listener, since the overlay's own backdrop IS the full-screen
// click target here -- no "same click that opened it" timing issue to work around).
function fomodZoomOverlayEscape(e) {
  if (e.key === 'Escape') fomodCloseImageZoom();
}
function fomodOpenImageZoom(src) {
  $g('ucv2FomodZoomImage').src = src;
  $g('ucv2FomodZoomOverlay').classList.add('open');
  document.addEventListener('keydown', fomodZoomOverlayEscape, true);
}
function fomodCloseImageZoom() {
  $g('ucv2FomodZoomOverlay').classList.remove('open');
  document.removeEventListener('keydown', fomodZoomOverlayEscape, true);
}
$g('ucv2FomodZoomOverlay').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) fomodCloseImageZoom();
});

// The real Vortex "Invalid fomod" blocking screen (2026-09-15, "validate the installer against the
// real schema" -- item 2a). No `parsedFomod` exists yet for a `reason: 'invalid'` need -- validation
// blocks BEFORE any parsing happens (lib/fomod-picker-data.js's own detectFomodChoiceNeed) -- so this
// reuses the SAME modal chrome (title/foot buttons) but renders a plain warning + Cancel/"Install
// Anyway" instead of any step content. Reuses `ucv2FomodPickerOptions` (normally the scrollable
// options list) as the message area rather than adding new dedicated markup to index.html for a
// single screen state.
function fomodRenderInvalidScreen(need, total) {
  $g('ucv2FomodPickerTitle').textContent = need.name;
  $g('ucv2FomodPickerStepName').textContent = '';
  $g('ucv2FomodPickerCounter').textContent = total > 1 ? `Mod ${fomodPickerIndex + 1} of ${total}` : '';
  $g('ucv2FomodPickerIntro').style.display = 'none';
  $g('ucv2FomodPickerReinstallNote').classList.add('hidden');
  $g('ucv2FomodPickerNoDataNote').classList.add('hidden');
  $g('ucv2FomodPickerValidationBypassNote').classList.add('hidden');
  $g('ucv2FomodPickerError').classList.add('hidden');
  $g('ucv2FomodPickerPreview').style.display = 'none';
  $g('ucv2FomodPickerBack').style.visibility = 'hidden';
  $g('ucv2FomodPickerProgressFill').style.width = '0%';

  const validation = need.validation || {};
  const optionsEl = $g('ucv2FomodPickerOptions');
  const nextBtn = $g('ucv2FomodPickerNext');
  // Unlike real Vortex (whose per-version parser dispatch genuinely can't run at all outside
  // versions 1.0-5.0, independent of its own validate flag), this tool's own parser is
  // version-agnostic -- it reads whatever elements it recognizes regardless of the declared
  // version, so "Install Anyway" can genuinely still work for an unrecognized version too, unlike
  // real Vortex. Both cases get the same override; only the explanation differs.
  if (validation.unsupportedVersion) {
    optionsEl.innerHTML = `<div class="callout callout--warning">
      <div class="callout__title">🛑 Installer version not recognized</div>
      <p>This mod's installer uses a version (${escHtmlFomodPicker(validation.unsupportedVersion)}) this tool doesn't recognize, so we can't be sure it will work correctly. You can install it anyway, but we recommend testing it afterward and letting the mod's author know.</p>
    </div>`;
  } else {
    const errorItems = (validation.errors || []).map((e) => `<li>${escHtmlFomodPicker(e)}</li>`).join('');
    optionsEl.innerHTML = `<div class="callout callout--warning">
      <div class="callout__title">🛑 This installer didn't pass standard checks</div>
      <p>This mod's installer didn't pass standard checks, so we can't be sure it will work correctly. You can install it anyway, but we recommend testing it afterward and letting the mod's author know so they can fix it.</p>
      ${errorItems ? `<ul>${errorItems}</ul>` : ''}
    </div>`;
  }
  nextBtn.textContent = 'Install Anyway';
  fomodShowPreview(null);
}

function fomodRenderStep() {
  const need = fomodPickerNeeds[fomodPickerIndex];
  const total = fomodPickerNeeds.length;
  if (need.reason === 'invalid') {
    fomodRenderInvalidScreen(need, total);
    return;
  }
  const steps = need.parsedFomod.installSteps;
  const stepIdx = fomodPickerStepIdx;
  const step = steps[stepIdx];

  $g('ucv2FomodPickerPreview').style.display = '';
  $g('ucv2FomodPickerTitle').textContent = need.parsedFomod.moduleName || need.name;
  $g('ucv2FomodPickerStepName').textContent = step.name;
  $g('ucv2FomodPickerCounter').textContent = total > 1 ? `Mod ${fomodPickerIndex + 1} of ${total}` : '';
  const introEl = $g('ucv2FomodPickerIntro');
  // The framing sentence only makes sense once -- real Vortex's own wizard drops it after page 1
  // too (just the title + step name from then on).
  introEl.style.display = stepIdx === 0 ? '' : 'none';
  introEl.textContent = need.reason === 'open'
    ? "This mod's FOMOD has no saved choices — pick what you want installed, just like you would in Vortex."
    : "This mod's real install options changed since the collection recorded its choice, so it can't be replayed automatically -- make a fresh pick. Anything marked (Preset) matches what the collection originally recorded.";
  // Same "only on step 1" gating as the intro sentence above -- shown only when this session came
  // from an Install action (a real clean reinstall), never from Update Collection's own Apply flow.
  const reinstallNoteEl = $g('ucv2FomodPickerReinstallNote');
  reinstallNoteEl.classList.toggle('hidden', !(stepIdx === 0 && fomodPickerReinstallWarning));
  // Copy by Gemini (2026-09).
  reinstallNoteEl.textContent = "Finishing will replace this mod's current files with a fresh install from its archive.";
  // "Keep it honest when we can't tell" (2026-09-15) -- shown once, on step 1 only, whenever this
  // mod's own installedFileState couldn't be resolved (skyrimDataDir/pluginsListDir not set in
  // Settings, or the real read failed), so pre-selection fell back to NOT matching any fileDependency
  // instead of silently guessing. Exact string, for a copy pass.
  const noDataNoteEl = $g('ucv2FomodPickerNoDataNote');
  const fileStateUnavailable = !need.installedFileState || need.installedFileState.available === false;
  noDataNoteEl.classList.toggle('hidden', !(stepIdx === 0 && fileStateUnavailable));
  noDataNoteEl.textContent = "We couldn't check what you have installed, so nothing here is pre-picked based on your setup — review each option yourself.";
  // Standing reminder (not a one-time toast) that this specific mod's installer already failed a
  // real schema check and this session already confirmed "Install Anyway" for it (2026-09-15,
  // "validate the installer against the real schema") -- shown for every step, not just step 1,
  // since it's a fact about the mod itself that stays true for the whole session, not a one-time
  // setup note like the two above.
  const validationBypassNoteEl = $g('ucv2FomodPickerValidationBypassNote');
  validationBypassNoteEl.classList.toggle('hidden', !need.validationBypassed);
  validationBypassNoteEl.textContent = "This mod's installer didn't pass standard checks earlier. It is still worth letting the mod's author know so they can fix it.";
  $g('ucv2FomodPickerError').classList.add('hidden');

  fomodInitStepAnswersOnce(need, stepIdx);

  const optionsEl = $g('ucv2FomodPickerOptions');
  // Only a genuine step change (Next/Back, or advancing to the next mod) resets the scroll position
  // -- a re-render triggered by just toggling one option within THIS SAME step (see fomodOnSelect's
  // own comment on why it re-renders the whole step) preserves wherever you were scrolled to,
  // instead of jumping back to the top of a long options list (2026-08-28, director's own live
  // catch).
  const stepKey = `${fomodPickerIndex}:${stepIdx}`;
  const preservedScrollTop = optionsEl.scrollTop;
  const isSameStep = fomodPickerLastRenderedStepKey === stepKey;
  optionsEl.innerHTML = '';
  step.groups.forEach((group, groupIdx) => optionsEl.appendChild(fomodBuildGroupEl(need, stepIdx, group, groupIdx)));
  optionsEl.scrollTop = isSameStep ? preservedScrollTop : 0;
  fomodPickerLastRenderedStepKey = stepKey;
  fomodShowPreview(null); // empty until hover, matches real Vortex

  const visibility = fomodComputeStepVisibility(need, fomodPickerAnswers);
  let lastVisibleIdx = -1;
  for (let i = 0; i < stepIdx; i++) if (visibility[i]) lastVisibleIdx = i;
  let nextVisibleIdx = -1;
  for (let i = stepIdx + 1; i < steps.length; i++) { if (visibility[i]) { nextVisibleIdx = i; break; } }
  fomodPickerPrevStepIdx = lastVisibleIdx;
  fomodPickerNextStepIdx = nextVisibleIdx;

  const backBtn = $g('ucv2FomodPickerBack');
  if (lastVisibleIdx === -1) {
    backBtn.style.visibility = 'hidden';
  } else {
    backBtn.style.visibility = 'visible';
    backBtn.textContent = steps[lastVisibleIdx].name;
  }

  const nextBtn = $g('ucv2FomodPickerNext');
  const isLastMod = fomodPickerIndex === total - 1;
  nextBtn.textContent = nextVisibleIdx === -1
    ? (isLastMod ? 'Finish' : 'Finish & Next Mod →')
    : steps[nextVisibleIdx].name;

  // Real formula, confirmed from source: ProgressBar now={idx} max={steps.length-1}.
  $g('ucv2FomodPickerProgressFill').style.width = `${Math.round((stepIdx / Math.max(steps.length - 1, 1)) * 100)}%`;
}

// Validates the CURRENT step's own answers before advancing -- SelectExactlyOne/SelectAtLeastOne
// actually got a real selection, matching the real FOMOD spec's own requirement rather than
// leaving it for the server to reject after the fact.
//
// SelectAtMostOne (item 12a, 2026-09-15) -- real Vortex's own Group.validateFunc (InstallerDialog.tsx)
// marks this invalid too when more than one option is selected, a defensive check backing up its own
// radio UI. Normal clicking can't reach it on either side (native radio exclusivity already makes >1
// unreachable) -- what can is this project's own `reason: 'mismatch'` preset-replay path, which
// pre-selects by NAME against a possibly-stale collection.json: a malformed/stale record could in
// principle mark more than one option "preset" in the same SelectAtMostOne group, and nothing caught
// it before Finish.
function fomodValidateStep(need, stepIdx) {
  const step = need.parsedFomod.installSteps[stepIdx];
  const stepAnswers = fomodPickerAnswers[stepIdx] || {};
  for (let groupIdx = 0; groupIdx < step.groups.length; groupIdx++) {
    const group = step.groups[groupIdx];
    if (group.type === 'SelectAll') continue;
    const indices = stepAnswers[groupIdx] || [];
    if (group.type === 'SelectExactlyOne' && indices.length !== 1) {
      return `"${step.name}" / "${group.name}" needs exactly one pick.`;
    }
    if (group.type === 'SelectAtLeastOne' && indices.length < 1) {
      return `"${step.name}" / "${group.name}" needs at least one pick.`;
    }
    if (group.type === 'SelectAtMostOne' && indices.length > 1) {
      return `"${step.name}" / "${group.name}" allows at most one pick.`;
    }
  }
  return null;
}

function fomodGoBack() {
  if (fomodPickerPrevStepIdx === -1) return;
  fomodPickerStepIdx = fomodPickerPrevStepIdx;
  fomodRenderStep();
}
$g('ucv2FomodPickerBack').addEventListener('click', fomodGoBack);

// The blocking screen's own "Install Anyway" behavior -- asks the caller-supplied
// onIgnoreValidation(need) to re-resolve this mod with validation bypassed. Disables the modal's own
// buttons for the duration (a real network round-trip), and surfaces a thrown/rejected error in the
// existing error callout rather than leaving the screen looking like nothing happened.
async function fomodPickerIgnoreValidation(need) {
  if (!fomodPickerOnIgnoreValidation) return;
  const nextBtn = $g('ucv2FomodPickerNext');
  const cancelBtn = $g('ucv2FomodPickerCancel');
  const closeBtn = $g('ucv2FomodPickerClose');
  const originalLabel = nextBtn.textContent;
  nextBtn.disabled = true;
  cancelBtn.disabled = true;
  closeBtn.disabled = true;
  nextBtn.textContent = 'Checking…';
  try {
    const newNeed = await fomodPickerOnIgnoreValidation(need);
    nextBtn.disabled = false;
    cancelBtn.disabled = false;
    closeBtn.disabled = false;
    nextBtn.textContent = originalLabel;
    if (newNeed) {
      // Stray gap noticed while adding fomodFixGroupTypes below (2026-09-15): a need substituted
      // here never went through fomodPrepareInstalledFileState, unlike every need showFomodPicker()
      // itself hands out -- so its own installedFileState.present/active stayed plain arrays,
      // meaning fomodFileDependencyMatches's own `fileState.presentSet.has(...)` would throw for any
      // fileDependency-gated pattern reached through this retry path. Fixed here since
      // fomodFixGroupTypes (right below) is the first thing to actually exercise that path for a
      // freshly-substituted need.
      fomodPrepareInstalledFileState([newNeed]);
      if (newNeed.parsedFomod) fomodFixGroupTypes(newNeed);
      fomodPickerNeeds[fomodPickerIndex] = newNeed;
      fomodPickerStepIdx = 0;
      fomodPickerAnswers = {};
      fomodRenderStep();
    }
    // A falsy return means the caller is handling its own next step entirely (e.g. Update Collection
    // v2 re-running its whole Apply request) -- nothing more for this modal to do.
  } catch (e) {
    nextBtn.disabled = false;
    cancelBtn.disabled = false;
    closeBtn.disabled = false;
    nextBtn.textContent = originalLabel;
    const err = $g('ucv2FomodPickerError');
    err.innerHTML = `<div class="callout__title">⚠️ Couldn't continue</div><p>${escHtmlFomodPicker(e.message || 'Something went wrong.')}</p>`;
    err.classList.remove('hidden');
  }
}

function fomodPickerAdvance() {
  const need = fomodPickerNeeds[fomodPickerIndex];
  if (need.reason === 'invalid') {
    fomodPickerIgnoreValidation(need);
    return;
  }
  const error = fomodValidateStep(need, fomodPickerStepIdx);
  if (error) {
    const err = $g('ucv2FomodPickerError');
    err.innerHTML = `<div class="callout__title">⚠️ Can't advance this step</div><p>${escHtmlFomodPicker(error)}</p>`;
    err.classList.remove('hidden');
    return;
  }
  if (fomodPickerNextStepIdx !== -1) {
    fomodPickerStepIdx = fomodPickerNextStepIdx;
    fomodRenderStep();
    return;
  }
  // Done with every visible step for this mod -- commit its picks (the same {[stepIdx]:
  // {[groupIdx]: number[]}} shape lib/fomod-picker-data.js's buildFomodChoicesFromPicks already
  // expects, unchanged), then move to the next mod in the queue, or finish entirely.
  fomodPickerPicks = { ...fomodPickerPicks, [need.modId]: fomodPickerAnswers };
  if (fomodPickerIndex < fomodPickerNeeds.length - 1) {
    fomodPickerIndex += 1;
    fomodPickerStepIdx = 0;
    fomodPickerAnswers = {};
    fomodRenderStep();
  } else {
    $g('ucv2FomodPickerModal').classList.remove('open');
    const onDone = fomodPickerOnDone;
    const picks = fomodPickerPicks;
    fomodPickerOnDone = null;
    fomodPickerOnCancel = null;
    if (onDone) onDone(picks);
  }
}
$g('ucv2FomodPickerNext').addEventListener('click', fomodPickerAdvance);

// Best-effort cleanup for the whole abandoned session (2026-09-17, item 12b, diagnostics/
// fomod-parity/findings-log.md -- "clean up after a cancelled FOMOD picker"). Every mod in
// `fomodPickerNeeds` already had its own preview images registered server-side before this picker
// ever opened (not just the one currently on screen -- a multi-mod queue registers all of them up
// front), so Cancel releases every one of them, not only fomodPickerIndex's. Fire-and-forget: never
// awaited, and any failure is silently swallowed -- a director who just pressed Cancel should never
// see an error over a scratch-folder cleanup, and the modal must close immediately either way.
function fomodReleaseSessionImages() {
  for (const need of fomodPickerNeeds) {
    if (!need || !need.modId || !need.imageCacheToken) continue;
    fetch('/api/fomod-image-cleanup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modId: need.modId, imageCacheToken: need.imageCacheToken }),
    }).catch(() => {});
  }
}

function closeFomodPicker() {
  $g('ucv2FomodPickerModal').classList.remove('open');
  fomodReleaseSessionImages();
  const onCancel = fomodPickerOnCancel;
  fomodPickerOnDone = null;
  fomodPickerOnCancel = null;
  if (onCancel) onCancel();
}
$g('ucv2FomodPickerClose').addEventListener('click', closeFomodPicker);
$g('ucv2FomodPickerCancel').addEventListener('click', closeFomodPicker);

// For a caller whose own onIgnoreValidation() handles its own next step entirely (2026-09-15,
// "validate the installer against the real schema" -- e.g. Update Collection v2 re-running its
// whole Apply request rather than continuing this same picker session in place) -- hides the modal
// with NO callback firing, unlike closeFomodPicker(), whose onCancel means "the director backed
// out," not "the caller is proceeding on its own."
function hideFomodPickerModal() {
  $g('ucv2FomodPickerModal').classList.remove('open');
  fomodPickerOnDone = null;
  fomodPickerOnCancel = null;
}
