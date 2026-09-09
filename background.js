'use strict';
/*
 * Background page / service worker.
 *
 * Firefox devtools pages only receive the `devtools` API namespace plus
 * runtime messaging — no `storage`, `permissions`, etc. So the panel
 * relays everything that needs extension APIs to this script:
 *
 *   settings_get / settings_set  — chrome.storage.local wrapper
 *   or_fetch                     — OpenRouter chat-completions request
 *
 * The background page has full API access in both Chrome and Firefox.
 */

const OPENROUTER_ORIGIN = 'https://openrouter.ai/*';
const API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const SETTINGS_KEY = 'page_chat_settings';

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || typeof msg.type !== 'string') return;
  if (msg.type === 'settings_get') {
    chrome.storage.local.get(SETTINGS_KEY, function (data) {
      sendResponse({ settings: (data && data[SETTINGS_KEY]) || null });
    });
    return true; // async response
  }
  if (msg.type === 'settings_set') {
    var s = msg.settings && typeof msg.settings === 'object' ? msg.settings : {};
    chrome.storage.local.set({ [SETTINGS_KEY]: s }, function () {
      sendResponse({ ok: true });
    });
    return true;
  }
  if (msg.type === 'or_fetch') {
    orFetch(msg).then(sendResponse);
    return true;
  }
});

/* ---------- host permission helpers ---------- */

function permsContains(origins) {
  return new Promise(function (resolve) {
    try {
      chrome.permissions.contains({ origins: origins }, function (ok) { resolve(!!ok); });
    } catch (e) { resolve(false); }
  });
}
function permsRequest(origins) {
  return new Promise(function (resolve) {
    try {
      chrome.permissions.request({ origins: origins }, function (ok) { resolve(!!ok); });
    } catch (e) { resolve(false); }
  });
}
async function ensureOriginPermission() {
  if (await permsContains([OPENROUTER_ORIGIN])) return true;
  return permsRequest([OPENROUTER_ORIGIN]);
}

/* ---------- OpenRouter relay ---------- */

function doOrFetch(apiKey, body) {
  return fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey,
      'X-Title': 'Page Chat DevTools'
    },
    body: JSON.stringify(body)
  });
}

async function orFetch(msg) {
  var apiKey = typeof msg.apiKey === 'string' ? msg.apiKey : '';
  var body = msg.body && typeof msg.body === 'object' ? msg.body : {};
  if (!apiKey) return { ok: false, error: 'missing API key' };

  for (var attempt = 0; attempt < 2; attempt++) {
    try {
      var resp = await doOrFetch(apiKey, body);
      var json = await resp.json().catch(function () { return null; });
      if (!resp.ok) {
        var detail = 'HTTP ' + resp.status;
        if (json && json.error) detail = json.error.message || detail;
        return { ok: false, error: detail };
      }
      return { ok: true, data: json };
    } catch (err) {
      // In Firefox a cross-origin fetch without the host permission fails
      // as a network error; try to get the permission granted and retry once.
      if (attempt === 0 && (await ensureOriginPermission())) continue;
      return {
        ok: false,
        error: 'Request to openrouter.ai failed: ' +
          (err && err.message ? err.message : err) +
          '. If this persists, grant the "Access your data for openrouter.ai" permission in about:addons.'
      };
    }
  }
}
