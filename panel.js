'use strict';

/* =====================================================================
 * Calculator tool: safe expression evaluator (no eval).
 * Supports: + - * / % ^ parentheses, unary minus, constants
 * (pi, e, tau) and functions sqrt abs round floor ceil sin cos tan
 * asin acos atan log ln exp min max sign.
 * ===================================================================== */
function makeEvaluator() {
  var tokens, pos;

  function tokenize(s) {
    var out = [], i = 0;
    var numRe = /\d*\.?\d+(?:[eE][+-]?\d+)?/y;
    var idRe  = /[A-Za-z_][A-Za-z0-9_]*/y;
    while (i < s.length) {
      var c = s[i];
      if (/\s/.test(c)) { i++; continue; }
      numRe.lastIndex = i;
      var m = numRe.exec(s);
      if (m) { out.push({ t: 'num', v: parseFloat(m[0]) }); i += m[0].length; continue; }
      idRe.lastIndex = i;
      var mi = idRe.exec(s);
      if (mi) { out.push({ t: 'ident', v: mi[0] }); i += mi[0].length; continue; }
      if ('+-*/%^(),'.indexOf(c) !== -1) { out.push({ t: c, v: c }); i++; continue; }
      throw new Error('unexpected character "' + c + '"');
    }
    out.push({ t: 'eof' });
    return out;
  }

  function peek() { return tokens[pos]; }
  function next() { return tokens[pos++]; }
  function expect(t) {
    var x = next();
    if (x.t !== t) throw new Error('expected "' + t + '"');
    return x;
  }

  var FUNCS = {
    sqrt: Math.sqrt, abs: Math.abs, round: Math.round, floor: Math.floor,
    ceil: Math.ceil, sin: Math.sin, cos: Math.cos, tan: Math.tan,
    asin: Math.asin, acos: Math.acos, atan: Math.atan,
    log: Math.log10, ln: Math.log, exp: Math.exp,
    min: Math.min, max: Math.max, sign: Math.sign
  };
  var CONSTS = { pi: Math.PI, e: Math.E, tau: 2 * Math.PI };

  function parseExpr() {
    var v = parseTerm();
    while (peek().t === '+' || peek().t === '-') {
      var op = next().t;
      var r = parseTerm();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  }
  function parseTerm() {
    var v = parsePower();
    while (peek().t === '*' || peek().t === '/' || peek().t === '%') {
      var op = next().t;
      var r = parsePower();
      if (op === '*') v = v * r;
      else if (op === '/') {
        if (r === 0) throw new Error('division by zero');
        v = v / r;
      } else {
        if (r === 0) throw new Error('modulo by zero');
        v = v % r;
      }
    }
    return v;
  }
  function parsePower() { // right-associative: 2^3^2 = 2^(3^2)
    var base = parseUnary();
    if (peek().t === '^') {
      next();
      return Math.pow(base, parsePower());
    }
    return base;
  }
  function parseUnary() {
    var t = peek().t;
    if (t === '-' || t === '+') { next(); var v = parseUnary(); return t === '-' ? -v : v; }
    return parsePrimary();
  }
  function parsePrimary() {
    var tok = next();
    if (tok.t === 'num') return tok.v;
    if (tok.t === '(') {
      var v = parseExpr();
      expect(')');
      return v;
    }
    if (tok.t === 'ident') {
      if (peek().t === '(') {
        next();
        var args = [];
        if (peek().t !== ')') {
          args.push(parseExpr());
          while (peek().t === ',') { next(); args.push(parseExpr()); }
        }
        expect(')');
        var fn = FUNCS[tok.v];
        if (!fn) throw new Error('unknown function "' + tok.v + '"');
        return fn.apply(null, args);
      }
      if (tok.v in CONSTS) return CONSTS[tok.v];
      throw new Error('unknown identifier "' + tok.v + '"');
    }
    throw new Error('unexpected token "' + (tok.v === undefined ? tok.t : tok.v) + '"');
  }

  return function (expr) {
    tokens = tokenize(String(expr));
    pos = 0;
    var v = parseExpr();
    if (peek().t !== 'eof') throw new Error('unexpected trailing input');
    if (!isFinite(v)) throw new Error('result is not finite');
    // trim float noise, e.g. 0.1+0.2 -> 0.3
    return Number(v.toPrecision(12));
  };
}
var evaluate = makeEvaluator();

/* =====================================================================
 * Tool definitions (OpenAI-style "tools" sent to OpenRouter)
 * ===================================================================== */
var TOOLS = [{
  type: 'function',
  function: {
    name: 'calculator',
    description: 'Evaluate a mathematical expression and return the numeric result. Supports + - * / % ^, parentheses, constants (pi, e) and functions such as sqrt, abs, round, floor, ceil, sin, cos, tan, log, ln, exp, min, max. Prefer this tool for simple arithmetic only.',
    parameters: {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          description: 'The mathematical expression to evaluate, e.g. "3 * (4 + 5) / 7"'
        }
      },
      required: ['expression']
    }
  }
}, {
  type: 'function',
  function: {
    name: 'execute_javascript',
    description: 'Run JavaScript (ECMAScript) code in a fresh, isolated sandbox and return its output. The sandbox has NO access to the inspected page, no DOM, no localStorage/cookies and no network (fetch, XMLHttpRequest, WebSocket, importScripts are removed); a running instance is terminated after a timeout. Prefer this over calculator for anything needing loops, arrays, objects, sorting, JSON, strings, statistics, etc. Use execute_in_page instead if the task concerns the inspected page. console.log output is captured and included in the result. The returned value is the value of the last expression evaluated; if that value is a Promise it is awaited (up to the timeout). Example code: "[3,1,2].sort()" returns [1,2,3].',
    parameters: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'JavaScript source code to execute, e.g. "var xs=[5,3,8]; xs.sort(function(a,b){return a-b;}); xs"'
        }
      },
      required: ['code']
    }
  }
}, {
  type: 'function',
  function: {
    name: 'execute_in_page',
    description: 'Run JavaScript code in the INSPECTED PAGE (the web page open in the browser this DevTools session is attached to), with full access to its DOM, window, document, localStorage and page variables. Use this for anything page-related: counting elements, reading content or attributes, checking scripts, cookies, localStorage, page state, etc. The value of the last expression is returned and must be JSON-serializable (DOM nodes are not — stringify them yourself, e.g. el.textContent, el.outerHTML, or JSON.stringify(...)). The code must complete synchronously; Promises and async operations are not awaited. Note: pages with a strict Content-Security-Policy may block eval, in which case an error is returned.',
    parameters: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'JavaScript source code to run in the inspected page. The value of the last expression is returned, e.g. "document.querySelectorAll(\'a\').length" or "JSON.stringify(Array.from(document.images).map(i => i.src))"'
        }
      },
      required: ['code']
    }
  }
}];

function fmtNum(n) {
  if (typeof n !== 'number' || !isFinite(n)) return String(n);
  return String(Number(n.toPrecision(12)));
}

var MAX_RESULT = 8000;

function truncate(text) {
  if (text.length > MAX_RESULT) return text.slice(0, MAX_RESULT) + '\n...[truncated]';
  return text;
}

/* =====================================================================
 * execute_javascript: run code in the sandboxed runner page
 * (sandbox.html), embedded as a hidden iframe. MV3 CSP forbids
 * eval and blob: workers on extension pages, so the manifest
 * "sandbox" mechanism is used instead.
 * ===================================================================== */
var SANDBOX_TIMEOUT_MS = 8000;
var SANDBOX_HIDDEN_CSS = 'position:fixed;left:-99999px;top:-99999px;width:1px;height:1px;visibility:hidden;';

/* Firefox does not support the manifest "sandbox" key (Chrome-only). There,
 * the runner is embedded in an iframe with sandbox="allow-scripts" pointing
 * at a data: URL: it gets an opaque origin (eval allowed) and, being a
 * non-local scheme, does not inherit the extension page CSP that forbids
 * inline scripts. Chrome uses the manifest-sandboxed sandbox.html. */
var IS_FIREFOX = /Firefox\//.test(navigator.userAgent);

var sandboxFrame = null;
var sandboxReady = false;
var sandboxPending = [];   // callbacks waiting for the frame to finish loading
var sandboxHandlers = new Map(); // nonce -> { resolve, timer }

var sandboxRunnerPromise = null;
function getSandboxRunnerSource() {
  if (!sandboxRunnerPromise) {
    /* Relative URL: avoids chrome.runtime, which is partially exposed
     * in Firefox devtools pages. Same-origin extension resource. */
    sandboxRunnerPromise = fetch('sandbox.html')
      .then(function (r) { return r.text(); })
      .then(function (text) {
        var m = text.match(/<script>([\s\S]*)<\/script>/);
        if (!m) throw new Error('could not extract runner source');
        return m[1];
      });
  }
  return sandboxRunnerPromise;
}

function resetSandbox() {
  if (sandboxFrame && sandboxFrame.parentNode) sandboxFrame.parentNode.removeChild(sandboxFrame);
  sandboxFrame = null;
  sandboxReady = false;
  sandboxPending = [];
}

function flushSandboxQueue() {
  sandboxReady = true;
  var q = sandboxPending;
  sandboxPending = [];
  q.forEach(function (cb) { cb(); });
}

function failPendingSandbox(msg) {
  var q = sandboxPending;
  sandboxPending = [];
  q.forEach(function (cb) { cb(msg); });
}

/* Ensures the sandbox iframe exists and has loaded, then calls cb(). */
function ensureSandbox(cb) {
  if (!sandboxFrame || !sandboxFrame.isConnected) {
    resetSandbox();
    if (IS_FIREFOX) {
      getSandboxRunnerSource().then(function (runnerSrc) {
        if (sandboxFrame) return; // another request already created one
        var iframe = document.createElement('iframe');
        iframe.setAttribute('sandbox', 'allow-scripts');
        iframe.style.cssText = SANDBOX_HIDDEN_CSS;
        var html = '<!doctype html><html><body><script>' + runnerSrc + '\x3c/script></body></html>';
        iframe.src = 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
        iframe.addEventListener('load', flushSandboxQueue);
        document.body.appendChild(iframe);
        sandboxFrame = iframe;
      }).catch(function (err) {
        failPendingSandbox('Error: could not start sandbox: ' + (err && err.message ? err.message : err));
      });
    } else {
      var iframe = document.createElement('iframe');
      iframe.src = 'sandbox.html';
      iframe.style.cssText = SANDBOX_HIDDEN_CSS;
      iframe.addEventListener('load', flushSandboxQueue);
      document.body.appendChild(iframe);
      sandboxFrame = iframe;
    }
  }
  if (sandboxReady) cb();
  else sandboxPending.push(cb);
}

window.addEventListener('message', function (e) {
  if (!sandboxFrame || e.source !== sandboxFrame.contentWindow) return;
  var d = e.data || {};
  if (d.type !== 'result') return;
  var h = sandboxHandlers.get(d.id);
  if (!h) return;
  sandboxHandlers.delete(d.id);
  if (h.timer) clearTimeout(h.timer);
  var text = '';
  if (d.logs && d.logs.length) text += 'console output:\n' + d.logs.join('\n') + '\n';
  if (d.error) text += 'Error: ' + d.error;
  else if (d.value !== undefined) text += 'Return value: ' + d.value;
  else text += 'Return value: undefined';
  h.resolve(truncate(text));
});

/* Resolves to the tool-result string for the given code. */
function execSandboxedJs(code) {
  return new Promise(function (resolve) {
    var nonce = 's' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    var timer = setTimeout(function () {
      sandboxHandlers.delete(nonce);
      resetSandbox(); // a runaway sync loop poisons this iframe; recreate it
      resolve('Error: execution timed out after ' + (SANDBOX_TIMEOUT_MS / 1000) +
        's; the sandbox was terminated (possible infinite loop or never-settling Promise).');
    }, SANDBOX_TIMEOUT_MS);
    sandboxHandlers.set(nonce, { resolve: resolve, timer: timer });

    ensureSandbox(function (errMsg) {
      if (!sandboxHandlers.has(nonce)) return; // already timed out
      if (errMsg) {
        clearTimeout(timer);
        sandboxHandlers.delete(nonce);
        resolve(errMsg);
        return;
      }
      try {
        sandboxFrame.contentWindow.postMessage({ type: 'run', id: nonce, code: code }, '*');
      } catch (err) {
        clearTimeout(timer);
        sandboxHandlers.delete(nonce);
        resolve('Error: could not start sandbox: ' + err.message);
      }
    });
  });
}

/* =====================================================================
 * execute_in_page: run code in the inspected page via
 * chrome.devtools.inspectedWindow.eval.
 *
 * The supplied code is evaluated inside a wrapper in the page that:
 *   - evaluates the model's code with an indirect eval,
 *   - refuses Promise results (eval does not await them),
 *   - serializes the value to JSON so DOM nodes cannot crash the call,
 * and always returns a JSON string. The outer callback then parses it.
 * ===================================================================== */
function runInPage(code) {
  return new Promise(function (resolve) {
    var wrapped =
      '(function(){' +
      'var r;' +
      'try{r=(0,eval)(' + JSON.stringify(code) + ');}' +
      'catch(e){return JSON.stringify({error:String((e&&(e.stack||e.message))||e)});}' +
      'if(r&&typeof r.then==="function"){' +
      'return JSON.stringify({error:"code returned a Promise; execute_in_page only supports synchronous code. Rewrite the code to compute the result synchronously."});' +
      '}' +
      'try{return JSON.stringify({value:r===undefined?null:r});}' +
      'catch(e){return JSON.stringify({error:"result is not JSON-serializable ("+e.message+"). Convert it to a plain value first, e.g. el.textContent, el.outerHTML, or JSON.stringify(...)."});}' +
      '})()';

    try {
      chrome.devtools.inspectedWindow.eval(wrapped, function (result, exception) {
        if (exception) {
          var msg = (exception.description || exception.value || exception.code || 'evaluation failed');
          resolve(truncate('Error: ' + msg));
          return;
        }
        var parsed;
        try { parsed = JSON.parse(result); }
        catch (e) { resolve(truncate('Error: could not parse evaluation result: ' + e.message)); return; }
        if (parsed.error !== undefined) {
          resolve(truncate('Error: ' + parsed.error));
        } else {
          resolve(truncate('Return value: ' + JSON.stringify(parsed.value)));
        }
      });
    } catch (err) {
      resolve('Error: inspectedWindow.eval failed: ' + (err && err.message ? err.message : err));
    }
  });
}

function runCalculator(args) {
  var expr = args && args.expression;
  if (typeof expr !== 'string' || !expr.trim())
    return 'Error: missing required string argument "expression"';
  try {
    return 'result = ' + fmtNum(evaluate(expr));
  } catch (e) {
    return 'Error: ' + e.message;
  }
}

/* Execute a tool call; resolves to the string result shown to the model. */
async function runTool(tc) {
  var name = tc && tc.function && tc.function.name;
  var rawArgs = tc && tc.function && tc.function.arguments;
  var args;
  try {
    args = typeof rawArgs === 'string' ? JSON.parse(rawArgs || '{}') : (rawArgs || {});
  } catch (e) {
    return 'Error: could not parse tool arguments: ' + e.message;
  }

  if (name === 'calculator') return runCalculator(args);

  if (name === 'execute_javascript') {
    var code = args.code;
    if (typeof code !== 'string' || !code.trim())
      return 'Error: missing required string argument "code"';
    try {
      return await execSandboxedJs(code);
    } catch (err) {
      return 'Error: ' + (err && err.message ? err.message : err);
    }
  }

  if (name === 'execute_in_page') {
    var pageCode = args.code;
    if (typeof pageCode !== 'string' || !pageCode.trim())
      return 'Error: missing required string argument "code"';
    try {
      return await runInPage(pageCode);
    } catch (err) {
      return 'Error: ' + (err && err.message ? err.message : err);
    }
  }

  return 'Error: unknown tool "' + name + '"';
}

/* =====================================================================
 * State
 * ===================================================================== */
var state = { history: [], rendered: 0, busy: false };
var API_URL = 'https://openrouter.ai/api/v1/chat/completions';
var OPENROUTER_ORIGIN = 'https://openrouter.ai/*';
/* Firefox MV3 treats host_permissions as optional: fetch to openrouter.ai
 * needs an explicit grant (null = unknown yet, checked on first send). */
var originGranted = null;

var $ = function (id) { return document.getElementById(id); };
var chat = $('chat'), input = $('input'), sendBtn = $('sendBtn'),
    keyInput = $('keyInput'), modelInput = $('modelInput'), sysInput = $('sysInput');

var SETTINGS_KEY = 'page_chat_settings';

/* Send a message to the background page. In Firefox devtools pages this
 * (runtime messaging) is the only way to reach extension APIs. */
function bgSend(msg) {
  return new Promise(function (resolve, reject) {
    try {
      if (typeof chrome === 'undefined' || !chrome.runtime ||
          typeof chrome.runtime.sendMessage !== 'function') {
        return reject(new Error('runtime messaging unavailable'));
      }
      chrome.runtime.sendMessage(msg, function (resp) {
        if (chrome.runtime.lastError) {
          return reject(new Error(chrome.runtime.lastError.message));
        }
        resolve(resp);
      });
    } catch (e) { reject(e); }
  });
}

function localStorageUsable() {
  try {
    localStorage.setItem('page_chat_test', '1');
    localStorage.removeItem('page_chat_test');
    return true;
  } catch (e) { return false; }
}

function applySettings(s) {
  if (!s) return;
  keyInput.value = s.key || '';
  modelInput.value = s.model || '';
  if (typeof s.sys === 'string' && s.sys) sysInput.value = s.sys;
}

/* Persistence order: chrome.storage (always on Chrome; sometimes on Firefox),
 * then localStorage, then the background relay. Firefox devtools pages may
 * lack all extension APIs and the background may be unreachable, hence the
 * chain. */
async function saveSettings() {
  var s = {
    key: keyInput.value.trim(),
    model: modelInput.value.trim(),
    sys: sysInput.value
  };
  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      await new Promise(function (resolve, reject) {
        chrome.storage.local.set({ [SETTINGS_KEY]: s }, function () {
          if (chrome.runtime && chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else resolve();
        });
      });
      return;
    }
  } catch (e) { /* fall through */ }
  if (localStorageUsable()) {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); return; } catch (e) {}
  }
  try { await bgSend({ type: 'settings_set', settings: s }); } catch (e) { /* nowhere to persist */ }
}

async function loadSettings() {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      var s = await new Promise(function (resolve) {
        chrome.storage.local.get(SETTINGS_KEY, function (data) {
          resolve(data && data[SETTINGS_KEY]);
        });
      });
      if (s) { applySettings(s); return; }
    }
  } catch (e) { /* fall through */ }
  if (localStorageUsable()) {
    try {
      var s2 = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
      if (s2) { applySettings(s2); return; }
    } catch (e) { /* fall through */ }
  }
  try {
    var resp = await bgSend({ type: 'settings_get' });
    if (resp && resp.settings) applySettings(resp.settings);
  } catch (e) { /* ignore */ }
}

/* ---------- rendering ---------- */
function el(tag, cls, text) {
  var n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function scrollBottom() { chat.scrollTop = chat.scrollHeight; }

/* One-line preview for a summary label. */
function oneLine(s, max) {
  s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + ' …' : s;
}

/* Pretty-printed tool-call arguments (if valid JSON). */
function prettyArgs(args) {
  if (!args) return '(no arguments)';
  try { return JSON.stringify(JSON.parse(args), null, 2); }
  catch (e) { return args; }
}

/* Name of the tool that produced the result with the given id. */
function toolNameFor(id) {
  for (var i = state.history.length - 1; i >= 0; i--) {
    var m = state.history[i];
    if (m && m.tool_calls) {
      for (var j = 0; j < m.tool_calls.length; j++) {
        if (m.tool_calls[j].id === id) {
          return ((m.tool_calls[j].function || {}).name) || 'tool';
        }
      }
    }
  }
  return 'tool';
}

/* Collapsible block: collapsed summary line, click to reveal full content. */
function detailBlock(cls, summaryText, fullText) {
  var d = el('details', cls);
  d.appendChild(el('summary', null, summaryText));
  var pre = el('pre', 'raw');
  pre.textContent = fullText;
  d.appendChild(pre);
  return d;
}

function renderMsg(m) {
  var row = el('div', 'mrow ' + m.role);
  if (m.role === 'user') {
    row.appendChild(el('div', 'bubble', m.content || ''));
  } else if (m.role === 'assistant') {
    var hasContent = !!(m.content && m.content.trim());
    var hasTools = !!(m.tool_calls && m.tool_calls.length);
    if (hasContent || hasTools) {
      var inner = el('div', 'inner');
      if (hasContent) inner.appendChild(el('div', 'bubble', m.content));
      if (hasTools) {
        for (var i = 0; i < m.tool_calls.length; i++) {
          var tc = m.tool_calls[i];
          var f = tc.function || {};
          inner.appendChild(detailBlock(
            'toolcall',
            '⚙ ' + (f.name || 'tool') + '(' + oneLine(f.arguments, 120) + ')',
            prettyArgs(f.arguments)
          ));
        }
      }
      row.appendChild(inner);
    }
  } else if (m.role === 'tool') {
    row.appendChild(detailBlock(
      'toolresult',
      '↩ ' + toolNameFor(m.tool_call_id) + ' → ' + oneLine(m.content, 90),
      m.content || ''
    ));
  }
  chat.appendChild(row);
}

/* Render any history entries not yet shown. */
function flushHistory() {
  while (state.rendered < state.history.length) {
    renderMsg(state.history[state.rendered]);
    state.rendered++;
  }
  scrollBottom();
}

function showTyping(on) {
  var existing = $('typingRow');
  if (existing) existing.remove();
  if (on) {
    var row = el('div', 'mrow typing');
    row.id = 'typingRow';
    var b = el('div', 'bubble');
    b.innerHTML = '<span class="dot">●</span><span class="dot">●</span><span class="dot">●</span>';
    row.appendChild(b);
    chat.appendChild(row);
    scrollBottom();
  }
}

function showError(msg) {
  var row = el('div', 'mrow error');
  row.appendChild(el('div', 'bubble', '⚠ ' + msg));
  chat.appendChild(row);
  scrollBottom();
}

/* Direct OpenRouter fetch from the panel page. Works on Chrome (host
 * permission auto-granted) and on Firefox once the openrouter.ai host
 * permission has been granted. Returns the parsed JSON response. */
async function directOrFetch(body) {
  var resp = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + keyInput.value.trim(),
      'X-Title': 'Page Chat DevTools'
    },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    var detail = 'HTTP ' + resp.status;
    try {
      var j = await resp.json();
      if (j && j.error) detail = j.error.message || detail;
    } catch (e) { /* not json */ }
    var err = new Error(detail);
    err.http = true; // server responded; falling back to the relay won't help
    throw err;
  }
  return resp.json();
}

/* Firefox: the openrouter.ai host permission may not be granted yet, and the
 * background page used for the relay may be unreachable ("Receiving end does
 * not exist") — so try a direct fetch first, then the relay (which can request
 * the permission itself), and surface clear guidance otherwise. */
async function callAPI(messages) {
  var body = {
    model: modelInput.value.trim() || 'openrouter/auto',
    messages: messages,
    tools: TOOLS,
    tool_choice: 'auto',
    max_tokens: 4096
  };

  if (IS_FIREFOX) {
    try {
      return await directOrFetch(body);
    } catch (directErr) {
      if (directErr.http) throw directErr; // real API error, not a permission issue
      var r = null;
      try {
        r = await bgSend({ type: 'or_fetch', apiKey: keyInput.value.trim(), body: body });
      } catch (e) { /* relay unavailable */ }
      if (r && r.ok === true) return r.data;
      throw new Error(
        'openrouter.ai request failed: ' +
        (directErr && directErr.message ? directErr.message : directErr) +
        '. Grant the "Access your data for openrouter.ai" permission in ' +
        'about:addons → Extensions → Page Chat DevTools → Permissions' +
        (r && r.error ? ' (relay: ' + r.error + ')' :
         ', and make sure the extension is loaded from manifest.json (no background page found)')
      );
    }
  }

  return await directOrFetch(body);
}

/* Run the user/AI loop, following tool calls until a plain text reply. */
async function runTurn() {
  var steps = 0;
  while (steps++ < 15) {
    var messages = [];
    var sys = sysInput.value.trim();
    if (sys) messages.push({ role: 'system', content: sys });
    messages = messages.concat(state.history);

    var data = await callAPI(messages);
    var msg = data.choices && data.choices[0] && data.choices[0].message;
    if (!msg) throw new Error('unexpected API response: ' + JSON.stringify(data).slice(0, 300));

    // Keep only fields the API round-trip expects.
    var contentStr = typeof msg.content === 'string' ? msg.content
      : (msg.content ? JSON.stringify(msg.content) : '');
    var clean = { role: 'assistant', content: contentStr };
    if (msg.tool_calls && msg.tool_calls.length) {
      clean.tool_calls = msg.tool_calls.map(function (tc) {
        return {
          id: tc.id,
          type: tc.type || 'function',
          function: { name: tc.function.name, arguments: tc.function.arguments || '{}' }
        };
      });
    }
    state.history.push(clean);
    flushHistory();

    var tcs = clean.tool_calls || [];
    if (tcs.length) {
      for (var i = 0; i < tcs.length; i++) {
        state.history.push({ role: 'tool', tool_call_id: tcs[i].id, content: await runTool(tcs[i]) });
        flushHistory();
      }
      continue; // ask the model for the next step / final answer
    }
    return; // final text answer is rendered
  }
  throw new Error('stopped after 15 tool-call rounds (possible loop)');
}

/* ---------- actions ---------- */

/* Split into a sync permission gate + async worker so that in Firefox the
 * permissions.request() call happens inside the click/Enter event handler
 * (user gesture), before any await. */
function send() {
  if (state.busy) return;
  var text = input.value.trim();
  if (!text) return;
  if (!keyInput.value.trim()) {
    showError('Enter your OpenRouter API key in Settings first.');
    return;
  }

  /* Firefox: devtools pages have no permissions API; the background page
   * requests the openrouter.ai host permission (if needed) during fetch. */
  if (IS_FIREFOX) { doSend(text); return; }

  if (originGranted === true) { doSend(text); return; }

  if (originGranted === false) {
    chrome.permissions.request({ origins: [OPENROUTER_ORIGIN] }, function (granted) {
      if (granted) { originGranted = true; doSend(text); }
      else showError('Permission to contact openrouter.ai was denied. Grant it in the extension\'s permission settings and try again.');
    });
    return;
  }

  /* unknown: check whether the origin is already granted */
  chrome.permissions.contains({ origins: [OPENROUTER_ORIGIN] }, function (ok) {
    originGranted = !!ok;
    if (ok) doSend(text);
    else showError('Click Send again to grant network access to openrouter.ai.');
  });
}

async function doSend(text) {
  input.value = '';
  autoGrow();
  state.history.push({ role: 'user', content: text });
  flushHistory();

  state.busy = true;
  sendBtn.disabled = true;
  input.disabled = true;
  showTyping(true);
  try {
    await runTurn();
  } catch (err) {
    console.error(err);
    showError('Request failed: ' + (err && err.message ? err.message : err));
  } finally {
    state.busy = false;
    sendBtn.disabled = false;
    input.disabled = false;
    showTyping(false);
    input.focus();
  }
}

function clearChat() {
  state.history = [];
  state.rendered = 0;
  chat.innerHTML = '';
}

function autoGrow() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 140) + 'px';
}

/* ---------- inspected page info ---------- */
function loadPageInfo() {
  try {
    chrome.devtools.inspectedWindow.eval(
      '(function(){var u=location.href,t=document.title||"";return u+(t?" — "+t:"");})()',
      function (result) {
        if (result) {
          var pi = $('pageInfo');
          pi.textContent = result;
          pi.title = result;
        }
      }
    );
  } catch (e) { /* ignore */ }
}

/* ---------- wiring ---------- */
function init() {
  loadSettings();
  loadPageInfo();
  scrollBottom();

  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  input.addEventListener('input', autoGrow);
  $('clearBtn').addEventListener('click', function () { clearChat(); input.focus(); });
  $('toggleSettings').addEventListener('click', function () {
    var s = $('settings');
    var open = s.classList.toggle('open');
    $('toggleSettings').textContent = open ? 'Settings ▴' : 'Settings ▾';
  });
  $('toggleKey').addEventListener('click', function () {
    keyInput.type = keyInput.type === 'password' ? 'text' : 'password';
    $('toggleKey').textContent = keyInput.type === 'password' ? 'Show' : 'Hide';
  });
  [keyInput, modelInput, sysInput].forEach(function (elInput) {
    elInput.addEventListener('change', saveSettings);
  });
}

init();
