# Aevion — Technical Changelog

## 0.3.0 — first full build

- **Modular core**: `core.js` (store/bus/perms/memory/hash), `brain.js` (intent routing + local NLU), `skills.js` (math/translate/summarize/quiz/code), `voice.js` (STT/TTS), `online.js` (gated OpenAI-compatible connector), `app.js` (UI).
- **Assistant view**: local chat, commands, memory ("remember: …", recall), math, time/date, jokes, privacy Q&A.
- **Online AI (opt-in)**: Ollama or any OpenAI-compatible endpoint, persona system prompt, graceful local fallback on error.
- **Voice**: tap-to-talk STT (permission-gated) + TTS replies with voice picker.
- **Translation**: "translate X to Y" + 🌐 toggle mode (opt-in).
- **Studio**: quiz generator, offline extractive summarizer, flashcard decks with review, pomodoro, 15-language code notes, code profiler.
- **Organizer**: tasks with due dates + notes.
- **Files**: private in-browser vault (≤2 MB per file, upload/download/delete).
- **Automations**: on-launch & manual routines running through the brain.
- **Devices**: password-based pairing, .aevion sync bundles, device list.
- **Plugins**: registry + hello-world sample with /hello and /fortune.
- **Security**: permission manager (real browser APIs), SHA-256 PIN lock, full export, factory reset.
- **PWA**: manifest, service worker, offline install; PC launcher `serve.bat`/`serve.ps1` (zero dependencies).
- **Docs**: README, ARCHITECTURE, PRIVACY, PLUGINS, ROADMAP, ANDROID-APK, CHANGELOG.

## Upgrade notes

- Storage is localStorage (`aevion:*` keys); the IndexedDB engine will migrate these keys automatically when it lands.
- To bump the app for installed clients: change `CACHE_VERSION` in `sw.js`.
