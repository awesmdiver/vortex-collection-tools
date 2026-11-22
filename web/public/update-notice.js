'use strict';
// "New version x" link in the header (and the same line in Settings). Asks /api/update-state once on
// load, then at most once a minute while the page is open. Shows nothing when up to date, unknown or
// on any failure. Only an https://github.com/ address is ever put in the link.
(function () {
  var POLL_MS = 60 * 1000;

  function safeUrl(u) {
    try {
      var p = new URL(String(u));
      return p.protocol === 'https:' && p.hostname === 'github.com' ? p.href : null;
    } catch (e) { return null; }
  }

  function render(state) {
    var link = document.getElementById('newVersionLink');
    var row = document.getElementById('settingsNewVersionRow');
    var url = state && state.newer === true ? safeUrl(state.url) : null;
    var ver = state && typeof state.version === 'string' ? state.version.slice(0, 40) : '';
    var show = !!(url && ver);
    if (link) {
      link.hidden = !show;
      if (show) { link.href = url; link.textContent = 'New version ' + ver; }
    }
    if (row) {
      row.hidden = !show;
      var a = row.querySelector('a');
      if (a && show) { a.href = url; a.textContent = 'New version available ' + ver; }
    }
  }

  function ask() {
    fetch('/api/update-state').then(function (r) { return r.ok ? r.json() : null; })
      .then(function (s) { render(s); }).catch(function () { /* silent */ });
  }

  window.vctUpdateNotice = { render: render, safeUrl: safeUrl };
  ask();
  setInterval(function () { if (!document.hidden) ask(); }, POLL_MS);
})();
