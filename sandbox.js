'use strict';
/*
 * Sandbox runner for the execute_javascript tool.
 *
 * This page is declared as a manifest "sandbox" page, so it runs in an
 * opaque origin with its own CSP (see content_security_policy.sandbox in
 * manifest.json) that permits eval even though the MV3 extension CSP
 * forbids it. The script is external (sandbox.html) because a sandboxed
 * page's default CSP does not allow inline scripts. The devtools panel
 * embeds it in a hidden iframe and postMessages run requests to it.
 *
 * Contract:
 *   receive  { type: 'run', id: <nonce>, code: <string> }
 *   evaluate the code in the GLOBAL scope via an indirect eval, so the
 *   code cannot reach any variable inside this closure.
 *   capture console.log output.
 *   reply    { type: 'result', id: <nonce>, logs: [...], value | error }
 *
 * Unlike the original chatbot runner this handles many sequential runs
 * (it does not remove its listener after the first message).
 */
(function () {
  'use strict';

  /* Best-effort removal of network / storage / process entry points. */
  var blocked = [
    'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'sendBeacon',
    'Worker', 'SharedWorker', 'ServiceWorker', 'importScripts',
    'indexedDB', 'openDatabase', 'caches', 'BroadcastChannel',
    'RTCPeerConnection', 'requestFileSystem', 'webkitRequestFileSystem',
    'Notification'
  ];
  for (var b = 0; b < blocked.length; b++) {
    try { delete window[blocked[b]]; } catch (e) {}
    try { window[blocked[b]] = undefined; } catch (e) {}
  }

  /* console capture (reset per run) */
  var logs = [];
  function logger() {
    var parts = [];
    for (var i = 0; i < arguments.length; i++) parts.push(logFmt(arguments[i]));
    logs.push(parts.join(' '));
  }
  function logFmt(x) {
    var t = typeof x;
    if (t === 'string') return x;
    if (x === null) return 'null';
    if (t === 'undefined') return 'undefined';
    if (t === 'number') return String(x);
    if (t === 'boolean' || t === 'bigint') return String(x);
    if (t === 'function') return '[Function: ' + (x.name || 'anonymous') + ']';
    if (t === 'symbol') return x.toString();
    if (t !== 'object') return String(x);
    try { return describe(x, 0, []); } catch (e) { return String(x); }
  }
  try {
    Object.defineProperty(window, 'console', {
      value: { log: logger, info: logger, warn: logger, error: logger, debug: logger },
      writable: true, configurable: true
    });
  } catch (e) {
    try { window.console = { log: logger, info: logger, warn: logger, error: logger, debug: logger }; } catch (e2) {}
  }

  var MAX_DEPTH = 4, MAX_ITEMS = 100, MAX_STR = 2000;

  /* Render any value as a short, JSON-ish, single-line string. */
  function describe(v, depth, anc) {
    if (v === null) return 'null';
    var t = typeof v;
    if (t === 'undefined') return 'undefined';
    if (t === 'number') return String(v);
    if (t === 'boolean') return String(v);
    if (t === 'bigint') return String(v) + 'n';
    if (t === 'string') {
      if (v.length > MAX_STR) {
        return JSON.stringify(v.slice(0, MAX_STR)) + '(+' + (v.length - MAX_STR) + ' more chars)';
      }
      return JSON.stringify(v);
    }
    if (t === 'symbol') return v.toString();
    if (t === 'function') return '[Function: ' + (v.name || 'anonymous') + ']';
    if (t !== 'object') return String(v);
    if (depth >= MAX_DEPTH) return '[Object]';
    if (anc.indexOf(v) !== -1) return '[Circular]';
    var nextAnc = anc.concat([v]);
    var tag = Object.prototype.toString.call(v);
    if (tag === '[object Date]') return 'Date(' + JSON.stringify(v.toISOString()) + ')';
    if (tag === '[object RegExp]') return String(v);
    if (tag === '[object Error]') return (v.name || 'Error') + ': ' + (v.message || String(v));
    if (tag === '[object Map]') {
      var es = [], k = 0, it = v.entries(), step;
      while (k < MAX_ITEMS) {
        step = it.next();
        if (step.done) break;
        es.push(describe(step.value[0], depth + 1, nextAnc) + ' => ' + describe(step.value[1], depth + 1, nextAnc));
        k++;
      }
      return 'Map(' + v.size + ') {' + es.join(', ') + '}';
    }
    if (tag === '[object Set]') {
      var ss = [], k2 = 0, it2 = v.values(), step2;
      while (k2 < MAX_ITEMS) {
        step2 = it2.next();
        if (step2.done) break;
        ss.push(describe(step2.value, depth + 1, nextAnc));
        k2++;
      }
      return 'Set(' + v.size + ') {' + ss.join(', ') + '}';
    }
    if (Array.isArray(v)) {
      if (!v.length) return '[]';
      var pa = [], na = Math.min(v.length, MAX_ITEMS);
      for (var i = 0; i < na; i++) pa.push(safeGet(v, i, depth, nextAnc));
      if (v.length > MAX_ITEMS) pa.push('...[+' + (v.length - MAX_ITEMS) + ' more]');
      return '[' + pa.join(', ') + ']';
    }
    var keys = Object.keys(v);
    if (!keys.length) return '{}';
    var po = [], j, key, nl = Math.min(keys.length, MAX_ITEMS);
    for (j = 0; j < nl; j++) {
      key = keys[j];
      po.push(JSON.stringify(key.length > 200 ? key.slice(0, 200) : key) + ': ' + safeGet(v, key, depth, nextAnc));
    }
    if (keys.length > MAX_ITEMS) po.push('...[+' + (keys.length - MAX_ITEMS) + ' more keys]');
    return '{' + po.join(', ') + '}';
  }
  function safeGet(obj, key, depth, anc) {
    try { return describe(obj[key], depth + 1, anc); }
    catch (e) { return '<error: ' + e.message + '>'; }
  }

  window.addEventListener('message', function (ev) {
    var d = ev.data || {};
    if (!d || d.type !== 'run') return;
    var nonce = String(d.id);
    var code = String(d.code || '');

    logs.length = 0;

    var responded = false;
    function respond(payload) {
      if (responded) return;
      responded = true;
      var m = { type: 'result', id: nonce, logs: logs.slice() };
      if (payload.error !== undefined) m.error = payload.error;
      else m.value = payload.value;
      window.parent.postMessage(m, '*');
    }
    function ok(val) {
      try { respond({ value: describe(val, 0, []) }); }
      catch (e) { respond({ error: 'failed to serialize result: ' + e.message }); }
    }

    var result, err = null;
    try {
      /* Indirect eval: runs in the global scope, cannot see this closure. */
      result = (0, eval)(code);
    } catch (e) {
      err = String((e && (e.stack || e.message)) || e).slice(0, 4000);
    }
    if (err) return respond({ error: err });

    if (result && typeof result.then === 'function') {
      result.then(ok, function (r) {
        respond({ error: String((r && (r.stack || r.message)) || r) });
      });
    } else {
      ok(result);
    }
  });
})();
