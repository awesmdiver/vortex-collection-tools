// The one shared place that marks this page's own changing requests (POST/PUT/PATCH/DELETE) with
// `X-VCT: 1`, which web/request-guard.js requires. Loaded first in index.html's <head>, so every
// page script's plain fetch() goes through it -- no per-call edits. Same-origin requests only; the
// header is never sent to another site.
(function () {
  var nativeFetch = window.fetch.bind(window);
  // Path only (no query string) of what was being fetched, kept on a network failure so the page can
  // say what failed (shell.js reports it).
  function tag(err, input) {
    try {
      var u = new URL(typeof input === 'string' ? input : (input && input.url) || String(input), window.location.href);
      if (err && typeof err === 'object' && !err.vctUrl) err.vctUrl = u.pathname;
    } catch (e) { /* leave untagged */ }
    return err;
  }
  // A failed first GET (for example the first call right after the server starts, racing the server's own
  // start-up work) is tried once more, silently, after 1.5 s. init.vctNoRetry turns that off (the ping).
  function getWithRetry(input, init) {
    return nativeFetch(input, init).catch(function (err) {
      var aborted = init && init.signal && init.signal.aborted;
      if (aborted || (init && init.vctNoRetry)) throw tag(err, input);
      return new Promise(function (resolve) { setTimeout(resolve, 1500); })
        .then(function () { return nativeFetch(input, init); })
        .catch(function (err2) { throw tag(err2, input); });
    });
  }
  window.fetch = function (input, init) {
    var isRequest = typeof Request !== 'undefined' && input instanceof Request;
    var method = String((init && init.method) || (isRequest && input.method) || 'GET').toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return getWithRetry(input, init);
    try {
      var url = new URL(isRequest ? input.url : String(input), window.location.href);
      if (url.origin !== window.location.origin) return nativeFetch(input, init);
    } catch (e) {
      return nativeFetch(input, init);
    }
    var headers = new Headers((init && init.headers) || (isRequest ? input.headers : undefined));
    headers.set('X-VCT', '1');
    return nativeFetch(input, Object.assign({}, init, { headers: headers })).catch(function (err) { throw tag(err, input); });
  };
})();
