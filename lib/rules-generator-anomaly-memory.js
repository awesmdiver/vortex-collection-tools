'use strict';
// Persisted memory of ambiguous-candidate picks Rules Generator's anomaly picker has already
// resolved -- director's own real find, 2026-08-16: every one of an anomaly's candidates already
// has a real, current rule against the new mod (that's the only way it becomes a candidate at all),
// so "does a rule already exist against one of them" can never distinguish "already decided" from
// "still genuinely ambiguous" -- it's true for every multi-candidate anomaly, always. The only
// reliable signal is remembering the human's OWN choice, made once via the picker (or Apply), and
// replaying it on future scans instead of asking again.
//
// Same simple load/save JSON-file pattern as lib/work-through-state.js -- gitignored, single source
// of truth, no database (this project's own established minimal-dependency ethos).

const fs = require('fs');
const path = require('path');

const STATE_PATH = path.join(__dirname, '..', 'config', 'rules-generator-anomaly-choices.json');
const DEFAULT_STATE = { choices: {} };

function loadAnomalyChoices() {
  let onDisk = {};
  try {
    onDisk = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    // No file yet (fresh install, or nothing resolved yet) or unreadable/corrupt -- defaults cover
    // it, not an error worth surfacing, same convention as work-through-state.js's loadState().
  }
  return { ...DEFAULT_STATE, ...onDisk, choices: { ...DEFAULT_STATE.choices, ...(onDisk.choices || {}) } };
}

function saveAnomalyChoices(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  return state;
}

// Scoped per collection PAIR, not just newModKey -- the same mod could in principle appear in an
// analysis against a different old collection later, and its candidate set is inherently tied to
// THIS pair's own old-collection membership.
function makeChoiceKey(oldCollectionKey, newCollectionKey, newModKey) {
  return `${oldCollectionKey}::${newCollectionKey}::${newModKey}`;
}

// choices: the {choices: {...}} object from loadAnomalyChoices() -- passed in, not re-loaded here,
// so a single load can serve every lookup during one analysis (same "load once, read many" shape
// analyzeCollections' own modIndex parameter already follows).
function getAnomalyChoice(choices, oldCollectionKey, newCollectionKey, newModKey) {
  return choices.choices[makeChoiceKey(oldCollectionKey, newCollectionKey, newModKey)];
}

// type is recorded alongside targetKey specifically so a LATER change to the old collection's own
// rule (e.g. before -> after) can be detected rather than silently trusted forever -- director's own
// explicit ask: "we should log what the original choice was... so we can compare if needed."
function saveAnomalyChoice(oldCollectionKey, newCollectionKey, newModKey, targetKey, type) {
  const state = loadAnomalyChoices();
  state.choices[makeChoiceKey(oldCollectionKey, newCollectionKey, newModKey)] = {
    targetKey,
    type,
    recordedAt: new Date().toISOString(),
  };
  return saveAnomalyChoices(state);
}

module.exports = {
  loadAnomalyChoices,
  getAnomalyChoice,
  saveAnomalyChoice,
  makeChoiceKey,
};
