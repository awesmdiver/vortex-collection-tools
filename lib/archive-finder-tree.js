'use strict';
// Ported verbatim from the standalone Archive File Finder project (folded into this project
// 2026-07-28 -- see TECHNICAL.md's "Archive Finder" section).

const { isAbsoluteJunkEntry } = require('./archive-finder-junk-paths');

// Converts the flat entry list from `7z l -slt` (paths like "Folder\Sub\file.esp") into a nested
// tree the UI can render as collapsible <details> elements. Directories sort before files, both
// alphabetically.
function buildTree(entries) {
    const root = { name: '', type: 'dir', children: new Map() };
    for (const e of entries) {
        if (isAbsoluteJunkEntry(e.path)) continue;
        const parts = e.path.split(/[\\/]/).filter(Boolean);
        let node = root;
        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            const isLast = i === parts.length - 1;
            if (!node.children.has(part)) {
                if (isLast && !e.isDir) {
                    node.children.set(part, { name: part, type: 'file', size: e.size, internalPath: e.path });
                } else {
                    node.children.set(part, { name: part, type: 'dir', children: new Map() });
                }
            }
            node = node.children.get(part);
            // A path can be listed as a directory entry AND be an ancestor of deeper files; if we
            // first created it as a dir via traversal and later see it's not last-segment-file,
            // that's already handled above.
            if (node.type === 'file' && !isLast) {
                // Shouldn't happen (a file can't have children), but guard anyway.
                break;
            }
        }
    }
    return serialize(root);
}

function serialize(node) {
    if (node.type === 'file') {
        return { name: node.name, type: 'file', size: node.size, internalPath: node.internalPath };
    }
    const children = Array.from(node.children.values())
        .map(serialize)
        .sort((a, b) => {
            if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
            return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
        });
    return { name: node.name, type: 'dir', children };
}

module.exports = { buildTree };
