'use strict';
// Reads/writes the Clean Up report's exclude-list data file -- lives in a user-chosen folder
// (config.json's cleanupExcludeListDir, no built-in default; see lib/app-config.js's own comment
// on why this one has no fallback location). Only the FOLDER is baked in at server startup like
// every other path field; the file's contents are read fresh on every request since they change
// as the user adds/removes entries.

const fs = require('fs');
const path = require('path');

const FILE_NAME = 'exclude-list.json';

function filePath(dir) {
    return path.join(dir, FILE_NAME);
}

function load(dir) {
    if (!dir) return { staging: [], archives: [] };
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath(dir), 'utf8'));
        return { staging: parsed.staging || [], archives: parsed.archives || [] };
    } catch {
        // No file yet (nothing excluded so far) or it's unreadable/corrupt -- an empty list covers
        // both, same as this project's other "no config yet" read conventions.
        return { staging: [], archives: [] };
    }
}

function save(dir, data) {
    if (!dir) {
        throw new Error('No exclude-list folder is set. Choose one under Settings > Clean Up first.');
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath(dir), JSON.stringify(data, null, 2));
}

module.exports = { load, save, FILE_NAME };
