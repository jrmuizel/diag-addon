# Page Chat DevTools

A browser web extension that adds a **"Page Chat" panel to DevTools** containing an
OpenRouter-powered chatbot. The assistant can answer questions, do math, run
sandboxed JavaScript — and **execute script inside the inspected page**, so you
can ask it things like *"how many `<img>` tags does this page have?"* or *"what's
in this page's localStorage?"*

Inspired by `~/tools/chatbot` (single-file OpenRouter chatbot with a calculator
tool and a sandboxed JS executor).

## Files

| File | Purpose |
|---|---|
| `manifest.json` | MV3 manifest for both browsers: `background.service_worker` (Chrome) + `background.scripts` (Firefox). Chrome 121+ ignores the `scripts` key (older Chrome would refuse it, hence `minimum_chrome_version: 121`); Firefox ignores `service_worker` and runs the event page |
| `devtools.html` / `devtools.js` | DevTools entry point; creates the "Page Chat" panel |
| `panel.html` / `panel.js` | The chat UI and chat loop (OpenRouter API, tool dispatch, rendering) |
| `background.js` | Relay for extension APIs: settings storage and the OpenRouter request (used on Firefox; also available on Chrome) |
| `sandbox.html` | Manifest-**sandboxed** page that safely evaluates untrusted JS for the `execute_javascript` tool (Chrome) |

## Tools available to the chatbot

1. **`calculator`** — safe arithmetic expression evaluator (no eval).
2. **`execute_javascript`** — runs JS in an isolated sandbox (no DOM, no network,
   no page access); console output is captured, Promises are awaited, runaway
   code is killed after a timeout.
3. **`execute_in_page`** — runs JS **in the inspected page** via
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

Works in both Chrome and Firefox, with three Firefox-specific adaptations
(handled automatically at runtime):

- **API access:** Firefox devtools pages only expose the `devtools` API
  namespace plus runtime messaging — no `storage` or `permissions`. Settings
  and the OpenRouter request therefore use a fallback chain on Firefox:
  direct `fetch`/`localStorage` when possible, otherwise relayed through
  `background.js`. Chrome keeps using direct `chrome.*` calls.
- **Host permission grant:** Firefox MV3 treats `host_permissions` as
  optional. The panel first tries the OpenRouter fetch directly — once the
  `openrouter.ai` permission is granted (Firefox prompts at install for
  temporary add-ons, or enable it under about:addons → Extensions →
  **Page Chat DevTools** → *Permissions*), that just works. If the direct
  fetch fails (permission missing), it falls back to the background page,
  which requests the permission itself and retries. Chrome grants the
  permission silently at install time.
- **JS sandbox:** Firefox doesn't support the manifest `sandbox` key, so on
  Firefox the `execute_javascript` runner is embedded in an iframe with
  `sandbox="allow-scripts"` pointing at a `data:` URL (opaque origin, does not
  inherit the extension CSP). Chrome uses the manifest-sandboxed
  `sandbox.html`.
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
