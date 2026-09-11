# Page Chat DevTools

A browser web extension that adds a **"Page Chat" panel to DevTools** containing an
OpenRouter-powered chatbot. The assistant can answer questions, run sandboxed
JavaScript — and **execute script inside the inspected page**, so you can ask it
things like *"how many `<img>` tags does this page have?"* or *"what's in this
page's localStorage?"*

Inspired by `~/tools/chatbot` (single-file OpenRouter chatbot with a sandboxed
JS executor).

## Files

| File | Purpose |
|---|---|
| `manifest.json` | MV3 manifest for both browsers: `background.service_worker` (Chrome) + `background.scripts` (Firefox). Chrome 121+ ignores the `scripts` key (older Chrome would refuse it, hence `minimum_chrome_version: 121`); Firefox ignores `service_worker` and runs the event page |
| `devtools.html` / `devtools.js` | DevTools entry point; creates the "Page Chat" panel |
| `panel.html` / `panel.js` | The chat UI and chat loop (OpenRouter API, tool dispatch, rendering) |
| `background.js` | Relay for settings storage (used on Firefox; also available on Chrome) |
| `sandbox.html` / `sandbox.js` | Manifest-**sandboxed** page (and its external runner script) that safely evaluates untrusted JS for the `execute_javascript` tool |

## Tools available to the chatbot

1. **`execute_javascript`** — runs JS in an isolated sandbox (no DOM, no network,
   no page access); console output is captured, Promises are awaited, runaway
   code is killed after a timeout.
2. **`execute_in_page`** — runs JS **in the inspected page** via
   `chrome.devtools.inspectedWindow.eval`, with full access to the page's DOM,
   `window`, `document` and `localStorage`. The value of the last expression is
   returned and must be JSON-serializable (DOM nodes should be stringified, e.g.
   `el.textContent` or `JSON.stringify(...)`), and the code must complete
   synchronously. Pages with a strict Content-Security-Policy may block eval, in
   which case an error is returned to the model.

## Setup

1. Get an OpenRouter API key at [openrouter.ai/keys](https://openrouter.ai/keys).
2. Load the extension:
   - **Chrome/Edge 121+:** `chrome://extensions` → enable *Developer mode* → *Load unpacked* → select this folder.
   - **Firefox:** `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on…* → pick **`manifest.json`**. A console warning that `background.service_worker` is disabled is expected — Firefox ignores it and uses `background.scripts` instead.
3. Open any page, open DevTools, and select the **"Page Chat"** panel.
4. Open **Settings ▾**, paste your API key (and optionally pick a model / edit the
   system prompt), and start chatting.

Settings are stored in the extension's local storage (`chrome.storage.local`) and
are sent only to `openrouter.ai`.

## Cross-browser notes

Works in both Chrome and Firefox, with two Firefox-specific adaptations
(handled automatically at runtime):

- **Settings storage:** Firefox devtools pages only expose the `devtools` API
  namespace plus runtime messaging — no `storage`. Settings therefore use a
  fallback chain on Firefox: `chrome.storage.local` when available, then
  `localStorage`, then relayed through `background.js`. Chrome uses
  `chrome.storage.local` directly.
- **OpenRouter access:** The panel calls OpenRouter directly with `fetch` on
  both browsers — there is no request relay. OpenRouter sends permissive CORS
  headers, so the call does not need the `openrouter.ai` host permission. If
  the request fails, the panel surfaces a clear network error.
- **JS sandbox:** The `execute_javascript` runner lives in the
  manifest-sandboxed pages `sandbox.html` / `sandbox.js` on both browsers.
  Firefox gained support for the manifest `sandbox` key (and
  `content_security_policy.sandbox`) in Firefox 154; the manifest grants the
  sandboxed page a CSP that allows `eval`. On older Firefox versions the page
  is treated as a normal extension page, so `eval` is blocked and the tool
  returns an error instead of running.
- **Background page:** one `manifest.json` serves both browsers — Chrome runs
  `background.js` as a service worker, Firefox as an event page (see the
  manifest row in the file table above).

## Security notes

- `execute_javascript` runs untrusted code in a manifest-sandboxed page with a
  unique origin. Network/storage APIs are removed before user code runs. It is
  best-effort isolation, not a hardened sandbox.
- `execute_in_page` runs code in the real inspected page with full page
  privileges. It is the same trust level as typing into the DevTools console.
  Only let the model run code there when you trust the page and the request.
