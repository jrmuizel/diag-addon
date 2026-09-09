'use strict';

/* Note: Firefox types the icon argument as a string (no null allowed),
 * so pass a real icon path. Fall back to undefined if the icon is missing. */
function createPanel() {
  try {
    chrome.devtools.panels.create('Page Chat', 'icons/page-chat.png', 'panel.html');
  } catch (e) {
    chrome.devtools.panels.create('Page Chat', undefined, 'panel.html');
  }
}
createPanel();
