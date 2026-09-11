'use strict';

/* =====================================================================
 * Tool definitions (OpenAI-style "tools" sent to OpenRouter)
 * ===================================================================== */
var TOOLS = [{
  type: 'function',
  function: {
    name: 'execute_javascript',
    description: 'Run JavaScript (ECMAScript) code in a fresh, isolated sandbox and return its output. The sandbox has NO access to the inspected page, no DOM, no localStorage/cookies and no network (fetch, XMLHttpRequest, WebSocket, importScripts are removed); a running instance is terminated after a timeout. Use this for general computation: loops, arrays, objects, sorting, JSON, strings, statistics, etc. Use execute_in_page instead if the task concerns the inspected page. console.log output is captured and included in the result. The returned value is the value of the last expression evaluated; if that value is a Promise it is awaited (up to the timeout). Example code: "[3,1,2].sort()" returns [1,2,3].',
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

var MAX_RESULT = 8000;
var MAX_TOOL_ROUNDS = 50;

function truncate(text) {
  if (text.length > MAX_RESULT) return text.slice(0, MAX_RESULT) + '\n...[truncated]';
  return text;
}

/* =====================================================================
 * execute_javascript: run code in the manifest-sandboxed runner page
 * (sandbox.html), embedded as a hidden iframe. MV3 CSP forbids eval on
 * extension pages, so the manifest "sandbox" mechanism is used: the page
 * gets an opaque origin and its own CSP (content_security_policy.sandbox
 * in manifest.json) that permits eval. Firefox added the manifest
 * "sandbox" key in version 154; on older versions it is an unrecognized
 * property (warned about, no effect), so the page loads as a normal
 * extension page and eval is blocked.
 * ===================================================================== */
var SANDBOX_TIMEOUT_MS = 8000;
var SANDBOX_HIDDEN_CSS = 'position:fixed;left:-99999px;top:-99999px;width:1px;height:1px;visibility:hidden;';

var sandboxFrame = null;
var sandboxReady = false;
var sandboxPending = [];   // callbacks waiting for the frame to finish loading
var sandboxHandlers = new Map(); // nonce -> { resolve, timer }

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

/* Ensures the sandbox iframe exists and has loaded, then calls cb(). */
function ensureSandbox(cb) {
  if (!sandboxFrame || !sandboxFrame.isConnected) {
    resetSandbox();
    var iframe = document.createElement('iframe');
    iframe.src = 'sandbox.html';
    iframe.style.cssText = SANDBOX_HIDDEN_CSS;
    iframe.addEventListener('load', flushSandboxQueue);
    document.body.appendChild(iframe);
    sandboxFrame = iframe;
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

/* Append a row to the transcript, keeping the typing indicator last so it
 * stays pinned to the bottom while messages and tool results arrive. */
function appendToChat(node) {
  var typing = $('typingRow');
  if (typing) chat.insertBefore(node, typing);
  else chat.appendChild(node);
}

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

/* Tool-call arguments for display. The tools here take a single "code"
 * argument, so show the source verbatim: JSON-escaping turns its newlines
 * into literal "\n" sequences and makes the code hard to read. Falls back to
 * pretty-printed JSON for any other argument shape. */
function formatToolArgs(args) {
  if (!args) return '(no arguments)';
  var parsed;
  try { parsed = JSON.parse(args); }
  catch (e) { return args; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
      typeof parsed.code !== 'string') {
    return prettyArgs(args);
  }
  var keys = Object.keys(parsed);
  if (keys.length === 1) return parsed.code; // only "code": show the source
  var rest = {};
  for (var i = 0; i < keys.length; i++) {
    if (keys[i] !== 'code') rest[keys[i]] = parsed[keys[i]];
  }
  return JSON.stringify(rest, null, 2) + '\n\ncode:\n' + parsed.code;
}

/* One-line preview of a tool call's arguments (first line of code, if any). */
function toolArgsPreview(args, max) {
  var parsed;
  try { parsed = JSON.parse(args); } catch (e) { parsed = null; }
  if (parsed && typeof parsed === 'object' && typeof parsed.code === 'string') {
    var lines = parsed.code.split('\n');
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].trim()) return oneLine(lines[i], max);
    }
  }
  return oneLine(args, max);
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
            '⚙ ' + (f.name || 'tool') + '(' + toolArgsPreview(f.arguments, 120) + ')',
            formatToolArgs(f.arguments)
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
  appendToChat(row);
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
  appendToChat(row);
  scrollBottom();
}

/* POST to the OpenRouter chat-completions endpoint from the panel page and
 * return the parsed JSON response. */
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
    // HTTP error: the server responded, so surface its message as-is.
    err.http = true;
    throw err;
  }
  return resp.json();
}

async function callAPI(messages) {
  var body = {
    model: modelInput.value.trim() || 'openrouter/auto',
    messages: messages,
    tools: TOOLS,
    tool_choice: 'auto'
  };
  try {
    return await directOrFetch(body);
  } catch (err) {
    if (err.http) throw err; // server answered; surface its error as-is
    throw new Error(
      'Could not reach openrouter.ai (' + (err && err.message ? err.message : err) + '). ' +
      'Check your network connection and that the extension is allowed to access openrouter.ai.'
    );
  }
}

/* Run the user/AI loop, following tool calls until a plain text reply. */
async function runTurn() {
  var steps = 0;
  while (steps++ < MAX_TOOL_ROUNDS) {
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
  throw new Error('stopped after ' + MAX_TOOL_ROUNDS + ' tool-call rounds (possible loop)');
}

/* ---------- actions ---------- */

function send() {
  if (state.busy) return;
  var text = input.value.trim();
  if (!text) return;
  if (!keyInput.value.trim()) {
    showError('Enter your OpenRouter API key in Settings first.');
    return;
  }
  doSend(text);
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
