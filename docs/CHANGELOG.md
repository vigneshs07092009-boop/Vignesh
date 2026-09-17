# Aevion — Technical Changelog

## Tooling — the native wrapper is versioned (app version unchanged: 0.5.0)
- **`android-wrapper/` is now in git**: the Capacitor Android project (`android/`), `capacitor.config.json`, the npm manifests, `SpeechPlugin.java`, `MainActivity.java`, the manifest, icons, and all four helper scripts. Until now the voice code existed in exactly one place on one disk, outside any repo and outside OneDrive — one bad folder deletion from being gone.
- **Generated things stay out**: `node_modules/`, `www/`, `android/build/`, `android/app/build/`, `android/.gradle/` and `local.properties` are gitignored (Capacitor's own `android/.gitignore` handles the Android side). ~480 KB of actual source, 63 files.
- **Scripts are now location-independent**: `update-and-rebuild.bat` resolves the web app as its sibling `../aevion` (with an absolute fallback), `build-apk.ps1` derives `android/` from `$PSScriptRoot` and falls back to `JAVA_HOME`/`ANDROID_HOME`, and `verify-apk.ps1` locates both the APK and `aapt2` itself. The same files now work from the repo copy *or* the build folder — copy them into either and they behave.
- **`sync-wrapper.bat`**: two-way sync of the hand-written files between the repo copy and the build folder (robocopy `/XO`, newer file wins), so an edit made in either place can't drift or get lost. Never touches generated folders.
- **`verify-apk.ps1` grew up**: 12 checks now, including that the packaged `core.js` actually contains the event-payload fix — the kind of regression a passing build would happily hide.
- A fresh clone can rebuild the APK without `npx cap add android`, which would otherwise regenerate a default project and drop the plugin, manifest customisations and icons.

## 0.5.0 — voice that works in the Android app
- **Native speech plugin** (`android/app/src/main/java/com/aevion/app/SpeechPlugin.java`): a local Capacitor plugin exposing Android's own `SpeechRecognizer` + `TextToSpeech`. It exists because the Web Speech API is **not implemented in Android WebView**, so the mic button could never work inside the APK. Reachable from the web app as `window.Capacitor.Plugins.Speech`; registered in `MainActivity.onCreate` before the bridge is built.
- **`voice.js` picks its engine automatically**: native plugin when present, Web Speech API otherwise. Same public API either way (`start`, `stop`, `speak`, `voices`), so nothing above it changed.
- **Android 11+ package visibility**: added the `<queries>` entry for `android.speech.RecognitionService` — without it `SpeechRecognizer.isRecognitionAvailable()` reports *false* and voice silently looks "unsupported".
- **Permission flow reuses the Aevion permission manager**; the plugin falls back to Android's runtime dialog via `@PermissionCallback`, and Capacitor's `BridgeWebChromeClient` already routes WebView mic requests to the same OS dialog.
- **Live transcript + real error messages**: partial results now stream into the composer while you speak, and failure codes are translated to human text (`no-match` → "I didn't catch that — try again") instead of failing silently.
- **Fixed a latent event-bus bug**: `Aevion.on()` handed handlers the raw `CustomEvent`, but every payload handler treated the argument as the value — so voice input (in the browser too, not just the APK) sent the literal string `"[object CustomEvent]"`. Payloads are now unwrapped in `core.js`.
- **Crash guard**: `voices()` no longer assumes `speechSynthesis` exists — it is absent in Android WebView and threw when Settings rendered.
- Dev tooling: `verify-apk.ps1` (static APK checks: plugin classes in the dex, manifest queries, asset versions) and a fixed `update-and-rebuild.bat` that uses the portable Node/JDK/SDK paths instead of `PATH`.

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
