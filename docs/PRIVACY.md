# Aevion Privacy Model

**Short version:** Aevion is a local program on your device. It sends nothing anywhere unless you flip a switch, and you can audit every line that could ever touch the network.

## What leaves your device

| Feature | Needs internet? | Off by default? | What is sent |
|---|---|---|---|
| Chat with local brain | ❌ never | — | nothing |
| Math, memory, notes, tasks, files, flashcards | ❌ never | — | nothing |
| Voice input / TTS | ❌ engine is on-device | — | nothing by Aevion |
| PIN / pairing passwords | ❌ never | — | only SHA-256 hashes stored locally |
| Translation | ✅ | ✅ yes | only the exact text you ask to translate |
| Weather | ✅ | ✅ yes | coordinates (open-meteo.com, no account) |
| Web search | ✅ | ✅ yes | opens your query in a search engine tab |
| Online AI | ✅ | ✅ yes | your prompt + last 10 turns + memory facts to the endpoint **you** configure |

Every online feature requires: (1) the toggle in Settings → Privacy, and (2) where relevant, an OS/browser permission granted through the real permission dialog. Revoke either at any time and the feature stops instantly.

## Where data lives

Everything is in your device's local storage under keys prefixed `aevion:` — visible in DevTools → Application → Local Storage. Nothing is in cookies, nothing syncs in the background.

- **Phone and PC keep separate data by default.** Sharing is manual: Settings → export backup, or Devices → export/import sync bundle (password-gated, explicit).
- Voice: Aevion uses the browser/OS speech engine; mic permission is requested up-front and revocable in Settings → Privacy and in your OS settings.

## Verify it yourself

- Search the codebase for `fetch(` — you'll find exactly: `js/online.js` (AI endpoint you configure), weather in `js/brain.js`, translation in `js/skills.js`. That's all.
- The service worker (`sw.js`) never proxies network calls; it only caches app files for offline use.
- No analytics, no fonts/CDNs, no error reporting. `index.html` loads zero external resources.

## Security measures

- PIN and pairing passwords are stored only as SHA-256 hashes (WebCrypto, in `core.js`).
- Data export/sync is always a manual file you carry — there is no hidden channel.
- Factory reset wipes every `aevion:*` key in one click.

## Honest limits

Browser localStorage is convenient but not encrypted-at-rest; for threat-model-grade storage use the planned IndexedDB + WebCrypto encryption phase (see ROADMAP). The web platform cannot hide data from someone with full OS access — no app can without OS-level keystores (planned for the native shells).
