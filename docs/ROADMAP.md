# Roadmap — how Aevion grows

Each item is independent; ship them in any order. All keep the zero-dependency core unless noted.

**Shipped in 0.6.0:** multi-provider AI adapters, permission-tiered tools with a confirmation gate, layered memory with an approval queue, encrypted credential storage, and a real test suite (`npm run verify`).

**Shipped since:** the opt-in wake word (`js/wake.js`) with nickname support, the speech-language tag expansion and the translate skill from one source, plus `tests/voice.test.mjs` + `tests/wake.test.mjs`.

**Shipped in 0.6.1:** `js/nlu.js` — 28 intents and real word tables for 49 of the 84 languages in `Aevion.languages`, so commands work offline in Kannada, Tamil, Telugu, Hindi, Urdu and 44 more; 15 selectable voice presets (`js/voices.js`), honoured by the Android engine too; 33 tools, including a reload-proof timer engine, a 38-entry on-device site directory (`web.best`) and an **Automation report** that prints exactly what may run; the attachment paperclip (`js/attach.js`, memory-only); permission-gated self-upgrade and once-a-day learning (`js/evolve.js`); no-code plugins (`js/plugins.js`); theme following the device; and the quick-action chip row.

## Phase 1 — polish the PWA (no new tools needed)
- [x] **In-browser LLM (WebLLM / WebGPU)** — done in 0.4.0; 0.6.0 removed it from the install-time precache so it is only fetched when a model is actually used.
- [ ] **IndexedDB storage engine** — swap `Aevion.store` internals (interface stays); removes the 5 MB localStorage cap, enables the 2 MB→100 MB+ file vault, and would let memory hold far more than 500 facts.
- [x] **Encrypted vault** — done for credentials in 0.6.0 (AES-GCM under a PBKDF2 key derived from the PIN). Still to do: encrypt the file vault and memory bodies.
- [x] **Rich chat rendering** — done in 0.4.1.
- [ ] **Widgets** — dashboard view: next task, current pomodoro, quick memory.
- [ ] **Streaming everywhere** — Anthropic and Gemini SSE are parsed per-event; verify against a live endpoint and add token-level repaint for them (only OpenAI-compatible streaming has been exercised end to end).

## Phase 2 — native shells
- [ ] **Android APK via Capacitor** — see docs/ANDROID-APK.md; adds real notifications, share-target (share text into Aevion), file-system vault.
- [ ] **Windows/macOS/Linux shell (Tauri)** — tiny binary (~5 MB), system tray, global hotkey, real file access under OS permissions.
- [x] **Wake word (browser/PWA)** — done: `js/wake.js`, opt-in, any nickname, greeting-tolerant, follow-up window, barge-in. Browser-side though, so it needs a continuous recognizer: battery cost and (on Android) audio to the OS speech service.
- [ ] **Low-power native wake word** — Porcupine (free tier) or openWakeWord inside the native shells, so the always-on part runs on-device without a continuous recognizer. Tap-to-talk and the browser wake word stay the defaults everywhere else.

## Phase 3 — intelligence
- [ ] **OS automation service** (opt-in companion app): open apps, set volumes, run scripts — each action permission-gated and logged locally.
- [ ] **RAG over your files** — local embeddings + vector search in IndexedDB; ask questions about your notes/files offline.
- [x] **Multilingual voice** — 84 languages in one table (`Aevion.languages`), each handed to recognition and TTS as a real region tag; 49 of them route offline commands through `js/nlu.js`, 15 presets ship in `js/voices.js`, and live speak-and-translate detects the source language itself. Still open: picking a *native* voice per language on every platform, since browser engines vary wildly in what they offer.
- [ ] **Word tables for the remaining 35 languages** — the ones without a table fall back to English rules plus the configured provider, and `#nluCoverage` says so instead of pretending.
- [ ] **Proactive briefing** — "Good morning: 3 tasks today, 2 flashcard decks due, streak 5 days."

## Phase 4 — ecosystem
- [ ] **Plugin marketplace (local folder import)** — drop a .js file, Aevion shows a permission prompt and sandbox review before enabling.
- [ ] **End-to-end encrypted device sync** — replace file-bundle sync with direct encrypted channels; still no server (or user-hosted only).
- [ ] **Theme/plugin gallery repo** — community contributions via GitHub PRs.
