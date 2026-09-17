<h1 align="center">⚡ AEVION</h1>
<p align="center"><b>Your private, local-first AI assistant. JARVIS-style. No login. No tracking. Free forever.</b></p>

---

Aevion is a personal AI assistant that runs **entirely on your device** — in any modern browser on PC or Android. It works fully offline, keeps every byte of data on your machine, and only touches the internet when **you** explicitly allow it (online AI, translation, weather, web search).

## 🚀 Quick Start

### PC / Laptop (Windows)
1. Open the `aevion` folder
2. Double-click **`serve.bat`**
3. Your browser opens at `http://localhost:8787` — done.

*(Any other static server works too, e.g. `python -m http.server` — Aevion is pure HTML/JS with zero dependencies.)*

### Android phone
1. Host the `aevion` folder anywhere (GitHub Pages, or your PC's `serve.bat` reached over Wi-Fi)
2. Open it in Chrome → menu → **"Add to Home screen / Install app"**
3. Aevion now launches fullscreen like a native app and works offline (service worker caches everything).

### 📦 Building a real APK (optional)
See **[docs/ANDROID-APK.md](docs/ANDROID-APK.md)** — wrap this exact same code with Capacitor when you're ready.

The native shell is versioned in this repo at **[`android-wrapper/`](android-wrapper/)**: the Capacitor Android project, the build scripts, and `SpeechPlugin.java` (Android's speech recognition + TTS, which WebView does not provide). `android-wrapper/README.md` covers rebuilding it.

## ✨ What's inside

| Module | What it does |
|---|---|
| 💬 Assistant | Local intent brain (math, time, memory, jokes…), **in-browser AI model** (WebLLM on your GPU — fully offline, no API keys), optional online AI (Ollama or any OpenAI-compatible endpoint), **markdown replies with syntax-highlighted code + Copy buttons** |
| 🎤 Voice | Speech-to-text + text-to-speech using your device's built-in engines — Web Speech API in the browser, and a native Android plugin (`SpeechPlugin.java`) inside the APK, since WebView has no Web Speech API. No cloud wake-word. Tap-to-talk (privacy-first). |
| 🌐 Translation | Multilingual chat + "translate X to Tamil/Hindi/…" via browser service (opt-in) |
| 🎓 Studio | Quiz generator, offline summarizer, flashcard decks, pomodoro focus timer, code language notes, code profiler |
| 🗂️ Organizer | Tasks with due dates, timestamped notes |
| 📁 Files | Private in-browser file vault — nothing is uploaded |
| ⚡ Automations | Launch-time and manual routines |
| 🔗 Devices | Optional pairing with your own password + explicit export/import sync bundles. Per-device data by default. |
| 🧩 Plugins | Add skills with one JS file — see `js/plugins/hello-world.js` |
| 🔒 Security | Permission manager, PIN lock (SHA-256), full data export, factory reset |
| 🎨 Theming | 6 themes + custom accent color + assistant name + 4 personalities + voice picker |

## 🛡️ Privacy model

- **No account. No telemetry. No analytics. No network calls** unless you flip a switch.
- Every setting, memory, chat and file lives in your device's local storage.
- Online AI/search are **off by default** and revocable any time.
- Full details: **[docs/PRIVACY.md](docs/PRIVACY.md)**

## 🧠 Architecture (60-second version)

```
index.html ── UI shell (views: chat, studio, organizer, files, …)
    │
js/core.js     storage • event bus • permissions • memory • crypto
js/brain.js    intent routing → local handlers / skills / online AI
js/skills.js   math • translation • summarize • quiz • code knowledge
js/voice.js    speech recognition • TTS (native on Android, Web API elsewhere)
js/markdown.js markdown renderer • syntax highlighting (no deps)
js/online.js   opt-in OpenAI-compatible connector (Ollama etc.)
js/app.js      all UI wiring, views, settings, boot sequence
js/plugins/    drop-in skill files
sw.js          offline caching · manifest.json · PWA install
```

```
android-wrapper/   native APK shell (Capacitor + SpeechPlugin.java)
docs/              architecture, privacy, plugins, roadmap, APK guide
```

Deep dive: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**

## 🧩 Add your own skill in 5 minutes

Create `js/plugins/my-skill.js`:

```js
Aevion.plugins.register({
  name: 'My Skill',
  desc: 'What it does',
  commands: {
    '/mood': async () => 'Feeling electric ⚡'
  }
});
```

Add `<script src="js/plugins/my-skill.js"></script>` to `index.html` (after `app.js`). That's it — guide: **[docs/PLUGINS.md](docs/PLUGINS.md)**.

## 🗺️ Roadmap

Wake-word, SQLite/IndexedDB storage engine, Node.js companion with real OS automation, end-to-end encrypted sync. Full list: **[docs/ROADMAP.md](docs/ROADMAP.md)**

## 📄 License

MIT — this code is yours. Read it, change it, ship it.
