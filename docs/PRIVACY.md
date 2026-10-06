# Aevion Privacy Model

**Short version:** Aevion is a local program on your device. It sends nothing anywhere unless you flip a switch, and you can audit every line that could ever touch the network.

## What leaves your device

| Feature | Needs internet? | Off by default? | What is sent |
|---|---|---|---|
| Chat with local brain | ❌ never | — | nothing |
| Math, memory, notes, tasks, files, flashcards | ❌ never | — | nothing |
| Voice input / TTS (incl. the 15 voice presets) | ❌ engine is on-device | — | nothing by Aevion |
| Attachments (📎 photo/video/document/PDF) | ❌ never | — | nothing at all — the bytes stay in memory and vanish on reload |
| Timers, quick actions, teach-a-command | ❌ never | — | nothing |
| Automation report | ❌ never | — | nothing; it reads the local audit log |
| Self-upgrade & daily learning | ❌ never | ✅ off until you consent | nothing; packs are words, facts or plugins composed on-device |
| PIN / pairing passwords | ❌ never | — | only SHA-256 hashes stored locally |
| Translation | ✅ | ✅ yes | only the exact text you ask to translate |
| Weather | ✅ | ✅ yes | coordinates (open-meteo.com, no account) |
| Web search | ✅ | ✅ yes | opens your query in a search engine tab |
| Online AI | ✅ | ✅ yes | your prompt + the last 10 turns + **only the memories relevant to that message**, to the endpoint **you** configure |
| In-browser model (WebLLM) | ⚠️ once | — | a one-time model download from a public file host; after that nothing, ever |

Every online feature requires: (1) the toggle in Settings → Privacy, and (2) where relevant, an OS/browser permission granted through the real permission dialog. Revoke either at any time and the feature stops instantly.

**Prompts are never silently rerouted.** If the AI you chose fails, Aevion may only fall back to another provider in the *same trust class*: a cloud provider can hand over to another cloud provider you configured or to the on-device model, never to a different company you did not choose. You can switch fallback off entirely.

**Tools respect the same switches.** Nothing in the Tools view runs silently: `read` and `safe` tools stay local, `sensitive` tools need their permission *and* the online switch, and `confirm` tools (web search, opening a link, forgetting a memory, exporting data) ask you every single time. Every attempt — including the refused ones — is written to a local audit log you can read in the Tools view.

## Where data lives

Everything is in your device's local storage under keys prefixed `aevion:` — visible in DevTools → Application → Local Storage. Nothing is in cookies, nothing syncs in the background.

- **Phone and PC keep separate data by default.** Sharing is manual: Settings → export backup, or Devices → export/import sync bundle (password-gated, explicit).
- Voice: Aevion uses the browser/OS speech engine; mic permission is requested up-front and revocable in Settings → Privacy and in your OS settings.
- **Memory is layered and inspectable.** Session notes live in RAM and vanish on reload; temporary context expires on its own; conversation history is capped; saved facts are capped at 500. The Memory view shows every layer, lets you clear any of them, and has a **Preview recall** button that runs the exact same retrieval the assistant uses — so you can see what would be offered as context before it ever is.
- **Attachments are not stored.** What you clip to a message is held in memory for that page session only: nothing is written to `localStorage`, nothing is uploaded, and a reload forgets it. Only a text-ish file is ever read, by the browser, on this device — and the chips row states it in the UI.
- **Inferred preferences are not memory.** If you say "I prefer…", Aevion may *notice* it, but it is stored unapproved, excluded from retrieval, and does not exist as far as the model is concerned until you tap Approve. Rejecting deletes it.
- **Installed apps (Android only) are read from the launcher list, never from your data.** The APK's `AppsPlugin` asks the PackageManager which apps have a launcher icon — name and package name, the same public information your home screen shows — and nothing else: no contacts, no files, no messages, no usage statistics. The list is read only when you press *📱 Look for apps on this device*, it is stored nowhere, and starting an app happens only when you name a plugin you created from it (through the same confirm-tier path as every other link). In a browser tab there is no such API and the app says so instead of pretending.
- **The browser's history is never read — it cannot be.** No browser exposes it, so Aevion instead remembers the places *it* opened for you (`open.url`, a web search, a “best site” pick) in one small local list of eight, address + name + the query you used. That list is what the 🔌 **Plug in** buttons turn into plugins. Clearing it is `Aevion.apps.clear()` and the Plugins view shows exactly what is in it.

## Verify it yourself

- Search the codebase for `fetch(` — you will find exactly six places: **`js/webllm.js` (a same-origin `GET vendor/tvmjs_runtime.wasm` before a model starts, so a build missing that file says so instead of hanging — it never leaves the device),** `js/providers.js` (the AI endpoint you configure, plus the model-file download), **`js/setup.js` (the brain check: a `GET …/models` to a provider *you already configured* — no prompt, no text, no identifier, no query string, nothing at all while Online AI is off, and only a loopback address for a server on your own machine)**, the weather lookup in `js/brain.js` *and* `js/tools.js` (open-meteo, no account or key), and translation in `js/skills.js`. That is the complete list. Web search and the “best site for a topic” lookup do not use `fetch` at all: they open a URL in your own browser through `window.open`. The 0.6.1 modules (`nlu.js`, `attach.js`, `voices.js`, `evolve.js`, `plugins.js`) contain no network call whatsoever — and `npm run check` fails the build if a credential ever appears in a tracked file.
- **The brain log records attempts, not content.** Tools → 🧠 Brain log keeps the last 60 AI attempts — provider id, duration, whether it answered, a character count, and the error the provider returned. Your prompt text, the reply text and any API key are never written to it, and the whole log is one **Clear** button away. Read it without trusting the app's word: the entries are written at the moment of the request, by the code that made it.
- **The brain check never phones home.** It asks a provider *you* entered whether it is awake, and it is the only way the app can honestly tell you “Ollama is set but nothing is listening on its port”. With Online AI off, no probe is made at all: the card is filled in from what is already stored on the device.
- The service worker (`sw.js`) never proxies network calls; it only caches app files for offline use. The 6.6 MB in-browser model engine is not downloaded until you actually load a model.
- No analytics, no fonts/CDNs, no error reporting. `index.html` loads zero external resources.
- Run `npm run verify` to execute the test suite and the static checks yourself.

## Security measures

- PIN and pairing passwords are stored only as SHA-256 hashes (WebCrypto, in `core.js`).
- **API keys are encrypted at rest** as soon as you set a PIN: AES-GCM with a per-vault salt, a fresh IV on every write, and a key derived from your PIN with PBKDF2-SHA256 (150,000 iterations). Until you unlock with the PIN, a locked vault returns nothing at all — the Settings screen tells you when your keys are stored unencrypted instead of pretending otherwise.
- **Keys never travel.** They live outside `settings` and outside the per-provider config, and every export and sync bundle uses `dumpSafe()`, which strips the vault. A backup you email to yourself contains no credentials.
- Tools are permission-tiered and irreversible actions ask every time (no blanket "always allow"), with a local audit log of every attempt.
- Aevion never asks for a `javascript:`/`data:`/`file:` URL to be opened: the `open.url` tool refuses anything that is not `https:`.
- **A PIN can be required outside the app** (Settings → Security, off by default): with a PIN saved, opening Aevion in a plain browser tab asks for it before anything is shown. It is a lock screen, not encryption of the whole store — it keeps a passer-by out of the UI, and it is the same PIN that decrypts your saved API keys.
- **Aevion cannot grant itself the ability to upgrade itself.** Turn the switch on and your consent is stored as a hash bound to that moment; a record edited behind the UI's back reads as off. Turning it off never asks for anything, because removing capability must not be hard. What an upgrade can apply is limited to words, facts and plugins — never code, and every pack is logged and reversible.
- Data export/sync is always a manual file you carry — there is no hidden channel.
- Factory reset wipes every `aevion:*` key in one click, vault included.

## Honest limits

- **Without a PIN, API keys are stored unencrypted** in your device's local storage. The UI says so on the AI settings card. Set a PIN to change that.
- Everything else (notes, tasks, files, memory) is plaintext localStorage. Encrypting those bodies is still on the roadmap.
- The web platform cannot hide data from someone with full OS access, and neither can any app without an OS-level keystore. Nothing here defends against a compromised device or a malicious browser extension — it defends against silent collection, silent uploads and silent actions.
- Speech recognition on Android is usually **online** (Google's service) unless the device has an offline language pack. That is the OS engine, not Aevion; Aevion only hands it audio when you tap the mic.
