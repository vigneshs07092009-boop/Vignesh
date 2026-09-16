# Roadmap — how Aevion grows

Each item is independent; ship them in any order. All keep the zero-dependency core unless noted.

## Phase 1 — polish the PWA (no new tools needed)
- [ ] **In-browser LLM (WebLLM / WebGPU)** — run a small model (Llama-3.2-1B, Qwen-2.5-0.5B) fully in the browser, no Ollama install. Cached by the service worker → smart chat, zero cost, fully offline.
- [ ] **IndexedDB storage engine** — swap `Aevion.store` internals (interface stays); removes the 5 MB localStorage cap, enables the 2 MB→100 MB+ file vault.
- [ ] **Encrypted vault** — WebCrypto AES-GCM layer over files/memory, unlocked by the PIN.
- [ ] **Rich chat rendering** — markdown + syntax-highlighted code blocks with copy buttons.
- [ ] **Widgets** — dashboard view: next task, current pomodoro, quick memory.

## Phase 2 — native shells
- [ ] **Android APK via Capacitor** — see docs/ANDROID-APK.md; adds real notifications, share-target (share text into Aevion), file-system vault.
- [ ] **Windows/macOS/Linux shell (Tauri)** — tiny binary (~5 MB), system tray, global hotkey, real file access under OS permissions.
- [ ] **Wake word** — Porcupine (free tier) or openWakeWord in the native shells; tap-to-talk stays the privacy default in browser.

## Phase 3 — intelligence
- [ ] **OS automation service** (opt-in companion app): open apps, set volumes, run scripts — each action permission-gated and logged locally.
- [ ] **RAG over your files** — local embeddings + vector search in IndexedDB; ask questions about your notes/files offline.
- [ ] **Multilingual voice** — per-language TTS voice selection, auto language detection for translation mode.
- [ ] **Proactive briefing** — "Good morning: 3 tasks today, 2 flashcard decks due, streak 5 days."

## Phase 4 — ecosystem
- [ ] **Plugin marketplace (local folder import)** — drop a .js file, Aevion shows a permission prompt and sandbox review before enabling.
- [ ] **End-to-end encrypted device sync** — replace file-bundle sync with direct encrypted channels; still no server (or user-hosted only).
- [ ] **Theme/plugin gallery repo** — community contributions via GitHub PRs.
