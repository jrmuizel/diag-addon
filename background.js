'use strict';
/*
 * Background page / service worker.
 *
 * Firefox devtools pages only receive the `devtools` API namespace plus
 * runtime messaging — no `storage`, etc. So the panel relays everything that
 * needs extension APIs to this script:
 *
 *   settings_get / settings_set  — chrome.storage.local wrapper
 *
 * The background page has full API access in both Chrome and Firefox.
 */

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
});
