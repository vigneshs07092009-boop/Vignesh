# Aevion — Technical Changelog

## 0.4.1 — rich chat rendering
- **New module `js/markdown.js`** (zero dependencies, ~350 lines): headings, paragraphs, **bold**/*italic*/~~strike~~, inline code, links + autolinks, bullet/numbered lists with nesting, blockquotes, tables (with `:---:` alignment), horizontal rules and fenced code blocks.
- **Syntax highlighting** for 20+ languages — JavaScript/TypeScript, Python, Java, C/C++/C#, Go, Rust, PHP, Ruby, Kotlin, Swift, HTML/XML, CSS, JSON, YAML, Bash, SQL, Markdown — via one combined regex per language (ordered comment → string → number → keyword → function → type → operator rules).
- **Code block chrome**: language label, per-block **Copy** button with `navigator.clipboard` + `execCommand` fallback and “Copied ✓” feedback (event delegation, so restored history blocks work too).
- **XSS-safe by construction**: every source character is HTML-escaped *before* markup is generated; only Aevion's own tags are emitted; link targets are restricted to `http(s)://`, `mailto:` and `#`.
- **Streaming-aware**: replies repaint as markdown while the in-browser model streams tokens, but never mid-code-fence (avoids thrashing); the final pass always fully renders.
- **Speech cleanup**: `md.toPlain()` strips markdown before TTS, so Aevion says “(code block)” instead of reading backticks and asterisks.
- Chat replies and restored history render markdown; your own messages stay literal so what you typed is what you see.
- New code/syntax colour palette in `themes.css` with a dedicated light-theme variant; assets bumped to `?v=042`, cache `aevion-v0.4.1`.

## 0.4.0 — in-browser AI
- **WebLLM integration**: run Llama 3.2 / Qwen 2.5 / Gemma 2 (1–3B) fully in the browser on your GPU via WebGPU. No server, no API keys, works offline after the one-time model download (~1–3 GB, cached by the browser).
- **GPU capability detection**: probes `shader-f16`; q4f32 models (run on every WebGPU GPU) are default, q4f16 variants offered only on capable GPUs — avoids WGSL `enable f16` compile failures on older drivers.
- Engine vendored at `vendor/webllm.esm.js` (Apache-2.0, @mlc-ai/web-llm 0.2.85) — zero CDN dependency.
- New Settings card: capability check, model picker, download progress, load/unload, per-model cache tracking.
- Chat pipeline now: **in-browser model → online AI (opt-in) → local brain**, with graceful fallback and error notices at each hop.
- Streaming token rendering in the chat view (throttled to 60 ms).
- Service worker caches the engine + module; versioned assets bumped to `?v=040`.

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
