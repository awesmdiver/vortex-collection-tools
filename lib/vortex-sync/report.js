// Builds a self-contained HTML report comparing a source collection.json
// against the patched output: what got removed (ignored), what's kept but
// currently disabled in Vortex (split into "plugin auto-disabled" vs "no
// plugin — needs a manual disable in Vortex", since collection.json has no
// per-mod enable/disable field), and any ignored mods that couldn't be
// matched in the new revision.

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function nexusUrl(mod) {
  const modId = mod.source?.modId;
  const fileId = mod.source?.fileId;
  if (!modId) return null;
  return `https://www.nexusmods.com/skyrimspecialedition/mods/${modId}` +
    (fileId ? `?tab=files&file_id=${fileId}` : '');
}

function modRow(m) {
  const url = nexusUrl(m);
  const nameCell = url
    ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(m.name)}</a>`
    : esc(m.name);
  return `<tr>
    <td>${nameCell}</td>
    <td>${esc(m.author)}</td>
    <td>${esc(m.version)}</td>
    <td>${esc(m.details?.category)}</td>
  </tr>`;
}

function statCard(label, value) {
  return `<div class="stat"><div class="stat-value">${esc(value)}</div><div class="stat-label">${esc(label)}</div></div>`;
}

function section(title, count, rows, emptyText) {
  return `<section>
    <h2>${esc(title)} <span class="count">(${count})</span></h2>
    ${rows.length > 0
      ? `<table><thead><tr><th>Name</th><th>Author</th><th>Version</th><th>Category</th></tr></thead><tbody>${rows.join('')}</tbody></table>`
      : `<p class="empty">${esc(emptyText)}</p>`}
  </section>`;
}

function buildHtmlReport({ collectionInfo, collectionModId, sourcePath, outPath, applied, before, after, result }) {
  const removedRows = result.removedMods.map(modRow);
  const disabledRows = result.disabledKept.map(modRow);
  const unmatchedRows = result.unmatched.map((m) => `<tr>
    <td>${esc(m.name)}</td>
    <td>${esc(m.author || '')}</td>
    <td>${esc(m.version || '')}</td>
    <td>${esc(m.category || '')}</td>
  </tr>`);
  const pluginsDisabledRows = (result.pluginsDisabled || []).map((p) => `<tr>
    <td><code>${esc(p.name)}</code></td>
    <td>${esc(p.forMod)}</td>
  </tr>`);
  const needsManualRows = (result.disabledNeedsManual || []).map(modRow);

  const generatedAt = new Date().toLocaleString();

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Vortex Collection Sync Report — ${esc(collectionInfo?.name || collectionModId)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, Segoe UI, Roboto, sans-serif; max-width: 960px; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; }
  h1 { font-size: 1.5rem; margin-bottom: 0.25rem; }
  .meta { color: #767676; font-size: 0.9rem; margin-bottom: 1.5rem; }
  .meta div { margin: 0.15rem 0; }
  .stats { display: flex; gap: 1rem; flex-wrap: wrap; margin-bottom: 2rem; }
  .stat { border: 1px solid rgba(128,128,128,0.3); border-radius: 8px; padding: 0.75rem 1.25rem; min-width: 120px; }
  .stat-value { font-size: 1.6rem; font-weight: 600; }
  .stat-label { font-size: 0.8rem; color: #767676; }
  section { margin-bottom: 2.5rem; }
  h2 { font-size: 1.15rem; border-bottom: 1px solid rgba(128,128,128,0.3); padding-bottom: 0.4rem; }
  .count { font-weight: normal; color: #767676; }
  table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
  th, td { text-align: left; padding: 0.4rem 0.6rem; border-bottom: 1px solid rgba(128,128,128,0.2); }
  th { color: #767676; font-weight: 600; }
  tr:hover { background: rgba(128,128,128,0.08); }
  a { color: inherit; }
  .empty { color: #767676; font-style: italic; }
  .warn { border-left: 3px solid #d9822b; padding-left: 0.75rem; }
  .action { border: 2px solid #d1242f; border-radius: 8px; padding: 1rem 1.25rem; background: rgba(209,36,47,0.08); }
  .action h2 { border-bottom: none; color: #d1242f; margin-top: 0; }
  .action table { background: transparent; }
  .badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 999px; font-size: 0.75rem; font-weight: 600; }
  .badge.applied { background: #1a7f37; color: white; }
  .badge.dry { background: #767676; color: white; }
</style>
</head>
<body>
  <h1>Vortex Collection Sync — ${esc(collectionInfo?.name || collectionModId)}</h1>
  <div class="meta">
    <div>Installed collection mod id: <code>${esc(collectionModId)}</code></div>
    <div>Source collection.json: <code>${esc(sourcePath)}</code></div>
    ${outPath ? `<div>Output: <code>${esc(outPath)}</code> <span class="badge ${applied ? 'applied' : 'dry'}">${applied ? 'WRITTEN' : 'DRY RUN'}</span></div>` : ''}
    <div>Generated: ${esc(generatedAt)}</div>
  </div>

  <div class="stats">
    ${statCard('Mods before', before)}
    ${statCard('Mods after', after)}
    ${statCard('Removed (ignored)', result.removedMods.length)}
    ${statCard('modRules removed', result.removedModRules.length)}
    ${statCard('Disabled (kept)', result.disabledKept.length)}
    ${statCard('Plugins auto-disabled', (result.pluginsDisabled || []).length)}
    ${statCard('Manual disable needed', (result.disabledNeedsManual || []).length)}
  </div>

  ${(result.disabledNeedsManual || []).length > 0 ? `<section class="action">
    <h2>‼ Action needed after installing — disable these manually in Vortex <span class="count">(${result.disabledNeedsManual.length})</span></h2>
    <p>These mods are currently disabled but have no plugin file for us to switch off automatically —
    <code>collection.json</code> has no per-mod enabled/disabled field at all (confirmed against Vortex's own source),
    so a mod being listed always means Vortex installs it <em>enabled</em>. Right-click each of these in Vortex's mod
    list after the update and disable them by hand.</p>
    <table><thead><tr><th>Name</th><th>Author</th><th>Version</th><th>Category</th></tr></thead><tbody>${needsManualRows.join('')}</tbody></table>
  </section>` : ''}

  ${section('Removed — you had these marked "Ignore" in the installed collection', result.removedMods.length, removedRows, 'Nothing removed.')}

  <section class="warn">
    <p><strong>Note on removed mods' plugins:</strong> collection.json's <code>plugins</code> list has no field linking
    a plugin file back to the mod that provides it, and removed mods were never installed, so there's nothing on disk
    to inspect either — their plugin entries (if any) are left as-is in the output. Vortex/the game should simply
    treat them as missing files since they were never deployed, the same as any other load-order entry with no
    backing plugin.</p>
  </section>

  ${section('Kept but currently disabled in Vortex (full list)', result.disabledKept.length, disabledRows, 'No kept mods are currently disabled.')}

  <section>
    <h2>Plugins auto-disabled for you <span class="count">(${(result.pluginsDisabled || []).length})</span></h2>
    ${(result.pluginsDisabled || []).length > 0
      ? `<table><thead><tr><th>Plugin</th><th>From mod</th></tr></thead><tbody>${pluginsDisabledRows.join('')}</tbody></table>`
      : `<p class="empty">No plugin entries needed toggling (either no disabled mods have known plugins, or they were already disabled).</p>`}
  </section>

  ${result.unmatched.length > 0 ? `<section class="warn">
    <h2>⚠ Ignored mods not found in the new revision <span class="count">(${result.unmatched.length})</span></h2>
    <p>These were marked "Ignore" in your installed collection but have no matching entry in the new collection.json — likely already removed or replaced upstream. Nothing to do, just listed for awareness.</p>
    <table><thead><tr><th>Name</th><th>Author</th><th>Version</th><th>Category</th></tr></thead><tbody>${unmatchedRows.join('')}</tbody></table>
  </section>` : ''}
</body>
</html>`;
}

module.exports = { buildHtmlReport };
