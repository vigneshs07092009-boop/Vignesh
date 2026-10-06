<h1 align="center">⚡ AEVION</h1>
<p align="center"><b>Your private, local-first AI assistant. JARVIS-style. No login. No tracking. Free forever.</b></p>

---

Aevion is a personal AI assistant that runs **entirely on your device** — in any modern browser on PC or Android. It works fully offline, keeps every byte of data on your machine, and only touches the internet when **you** explicitly allow it (online AI, translation, weather, web search).

## 🚀 Quick Start

### PC / Laptop (Windows)
1. Open the `aevion` folder
2. Double-click **`serve.bat`**
3. Your browser opens at `http://localhost:8787` — done.

*(Any other static server works too — Aevion is pure HTML/JS with zero dependencies. Cross-platform alternative: `node tools/dev-server.mjs`.)*

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
| 💬 Assistant | **One-tap brain check** (“⚡ Use the best brain this device has”) that finds, names and fixes a dead provider, Local intent brain (math, time, memory, tasks, notes, jokes…), **in-browser AI model** (WebLLM on your GPU — fully offline, no API keys), **18 AI providers — 9 of them free to start** (Groq, OpenRouter — Nex-N2.5 Mini by default — Cerebras, Mistral, Hugging Face, GitHub Models, NVIDIA NIM, SambaNova, Google AI Studio (Gemini); plus OpenAI, Claude, Ollama, LM Studio, llama.cpp server, Cactus Needle 3 (on-device tool calling), any OpenAI-compatible endpoint, in-browser model, offline mock), **markdown replies with syntax-highlighted code + Copy buttons** |
| 🤖 Providers | One interface, many backends — each keeps its own endpoint/model, streams where supported, and may only fall back *within its own trust class*. A failing cloud provider can drop to the on-device model, never silently to a different company. `Test connection` does a real round trip. **Auto-switch (on by default)** moves between the online and the offline brain by itself: no internet, or a call that failed, and it answers locally for a minute before quietly retrying — the header pill always says which brain is answering (**LOCAL · OFFLINE AI · ONLINE AI · NO BRAIN**), and it never moves your own switches. |
| 🧠🧠 More than one brain | Every provider keeps its **own key**, so you can add several — and use them **together**: *compare* asks them all and shows every answer under its own heading, *critique* has one answer and the next correct it. A leg that fails is named in a toast while the others still answer, and every leg lands in the brain log as a chain. The honest boundary: two independent answers and a second reader are real; models merging into something smarter is not, so it is not sold as one. |
| 🧰 Tools | 33 built-in tools in four permission tiers — **read → safe → sensitive → confirm**. Tier-3 tools (web search, open a link, forget a memory) ask every single time; every attempt, refusals included, is written to a local audit log you can read. |
| 📱 Device access | One opt-in switch that asks for every permission this device can actually give (notifications, location, camera, microphone, clipboard, automation), reports exactly what was granted and what was refused, and takes it all back in one tap. It is a shortcut for the individual permissions, **never a bypass**: a tool still needs its own permission and anything irreversible still asks every single time. Capabilities only the Android app can offer are labelled as such instead of being claimed. |
| 🎨 Custom theme | Six built-in themes plus a knob for every part of them — 8 colours, corner radius, text size, panel blur and glow — applied instantly, stored on this device, resettable one knob at a time, and exportable as a single line you can paste back or share. |
| 🧠 Memory | Five separate layers — session, conversation history, saved facts, noticed preferences, temporary context — with scored local retrieval and a **Preview recall** button. Preferences Aevion *notices* stay inert until you approve them. |
| 🎤 Voice | Speech-to-text + text-to-speech using your device's built-in engines — Web Speech API in the browser, and a native Android plugin (`SpeechPlugin.java`) inside the APK, since WebView has no Web Speech API. **84 languages**, each handed to the engine as a real region tag. **15 voices** to speak in: fourteen named presets plus the system default, each one a named combination of speed, pitch and which of your device's own voices to use, with a ▶ preview that never changes what you had selected. Android's plugin honours speed and pitch too, so the same voices work in the APK. |
| 🗣️ Languages | The **offline brain understands 49 languages** for the basic commands — time, date, greetings, thanks, jokes, notes, tasks, timers and math — so none of that needs an AI provider. Digits and number words fold across scripts («ಎರಡು + ಎರಡು» → `= 4`, `१० / ४` → `= 2.5`), replies come back in the language you asked in, and a word that is missing can be **taught** from the Voice tab. English keeps exactly the path it always had. |
| 📎 Attachments | A paperclip in the composer for **photo, video, document and PDF**. The kind is worked out from the file itself; nothing is uploaded to classify it. Text-ish files (.txt, .md, .csv, code) are readable on-device, so “summarize this” is answered by the local summarizer. A photo or a PDF is described honestly as something Aevion cannot look inside. |
| ⏱ Timers | Set in any language (“ಟೈಮರ್ 5 ನಿಮಿಷ”, “set a timer for 10 minutes”). The deadline is stored, a hidden tab still fires it, and if the device slept through it Aevion says how late it was instead of swallowing it. |
| ⚙ Automation report | One button that answers “what is this thing allowed to do?” from the same tables the gate itself reads: tools per tier, what always asks first, what is switched off, what is waiting on a permission, the routines, the timers, and the real count of what ran and what was refused. |
| 🗣️ Hands-free | Optional **wake word** — say its name (or any nickname you set) with or without a greeting and it answers: «Hey Aevion, what is 2+2» runs immediately, the name on its own gets a spoken cue and then takes your next sentence, and after a reply you can keep talking without repeating the name. Talking over it stops it. Off by default, never reopens itself after a reload, self-stops when idle. All local — no cloud wake-word service. |
| 🌐 Translation | Multilingual chat + "translate X to Tamil/Hindi/…" via browser service (opt-in) |
| 🎓 Studio | Quiz generator, offline summarizer, flashcard decks, pomodoro focus timer, code language notes, code profiler |
| 🗂️ Organizer | Tasks with due dates, timestamped notes |
| 📁 Files | Private in-browser file vault — nothing is uploaded |
| ⚡ Automations | Launch-time and manual routines |
| 🔗 Devices | Optional pairing with your own password + explicit export/import sync bundles. Per-device data by default. |
| 🧩 Plugins | Two ways in: a **no-code plugin** (a trigger, a reply with `{query}`/`{name}`/`{time}`, saved on this device) or a single JS file — see `js/plugins/hello-world.js`. A plugin can also be an **app or a site you already use**: an `https` address (with `{query}` for a search) and an optional Android package, opened through the same confirm-tier tool as everything else — so it asks every time and can never open something Aevion would refuse. The Plugins view builds these for you from the places Aevion has taken you (🔌 **Plug in**) and, on Android, from the real list of installed apps (📱 **Look for apps on this device**). |
| 🔒 Security | Permission manager, PIN lock (SHA-256), **API keys encrypted at rest** (AES-GCM under a PBKDF2 key derived from your PIN) and excluded from every backup, full data export, factory reset |
| 🎨 Theming | 6 themes + a knob for every colour and shape + assistant name + 4 personalities + the voice picker. It can **follow the device's light/dark setting**, and your own theme is stored separately so turning that off brings it back exactly as it was. |
| 🔁 Self-upgrade | Off by default, and switching it on needs an explicit approval recorded as a hash — a hand-edited `{"on":true}` in storage does nothing. With it on Aevion can install a **knowledge pack** you approve (words, no-code plugins, candidate facts); **code packs are refused**, because a web app rewriting its own source is not a thing that can be done honestly. Turning it off never needs permission. |
| 🌱 Learning | Once a day Aevion reads the day's conversation for statements worth keeping and files them as **candidates** in the Memory approval queue. Noticing is all it does — nothing is remembered without your yes. |
| 🔊 Live translate | Speak in one language and hear it back in another, phrase by phrase, with the microphone open only while the mode is on. |

## 🛡️ Privacy model

- **No account. No telemetry. No analytics. No network calls** unless you flip a switch.
- Every setting, memory, chat and file lives in your device's local storage.
- Online AI/search are **off by default** and revocable any time.
- Full details: **[docs/PRIVACY.md](docs/PRIVACY.md)**

## 🧠 Architecture (60-second version)

```
index.html ── UI shell (views: chat, studio, organizer, memory, tools, …)
    │
js/core.js      storage • event bus • permissions • encrypted secrets • crypto
js/nlu.js       offline languages • script + digit folding • word tables • teachable
js/brain.js     intent routing → local handlers / tools / skills / providers
js/skills.js    math • translation • summarize • quiz • code knowledge • language detect
js/memory.js    five memory layers • scored retrieval • approval queue
js/tools.js     33 tools • permission tiers • confirmation gate • audit log • timers • report
js/attach.js    the paperclip: photo/video/document/PDF, described honestly
js/evolve.js    self-upgrade gate (consent-hashed) • day-by-day learning
js/plugins.js   plugin registry • no-code plugins stored as data • app & site plugins
js/setup.js     the brain check: who answers now, and the one tap that fixes it
js/apps.js      installed apps (Android) + the places Aevion opened, one tap from a plugin
js/theme.js     theme presets + per-knob custom overrides • following the device
js/voices.js    15 voice presets over the device's own speech engine
js/voice.js     speech recognition • TTS (native on Android, Web API elsewhere)
js/providers.js OpenAI / Groq / Anthropic / Gemini / Ollama / LM Studio / llama.cpp / Needle 3 / local / mock
js/online.js    persona prompt + compatibility shim over providers.js
js/markdown.js  markdown renderer • syntax highlighting (no deps)
js/webllm.js    in-browser model on WebGPU (loaded lazily, never precached)
js/app.js       all UI wiring, views, settings, boot sequence
js/plugins/     drop-in skill files
sw.js           offline caching · manifest.json · PWA install
tests/          headless browser harness + 419 tests   (npm test)
tools/check.mjs static integrity checks                (npm run check)
```

```
android-wrapper/   native APK shell (Capacitor + SpeechPlugin.java)
docs/              architecture, privacy, plugins, roadmap, APK guide
```

Deep dive: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**

## ✅ Verify it yourself (no dependencies)

Aevion ships with its own test and check suite. Node is used **only** to run them — the app itself stays plain HTML/JS with zero packages.

```bash
npm run check     # static: assets, selectors, events, versions, manifest, secrets
npm test          # 419 tests of the real shipped files, in a browser shim
npm run verify    # both
```

The tests do not re-implement anything: `tests/harness.mjs` reads the `<script>` tags straight out of `index.html` and evaluates those exact files in a Node VM with faked browser globals (localStorage with a real quota, a recording `fetch`, a recording `window.open`, WebCrypto). So a module that is added to the page is tested automatically, and one that is forgotten fails `npm run check`.

`npm run check` also fails the build if a version drifts between `index.html`, `sw.js`, `core.js`, `package.json`, the APK verifier and the CI workflow, or if a credential ever appears in a tracked file.

## 🧩 Add your own skill in 5 minutes

**No code at all:** open 🧩 Plugins, give it a name, a trigger word and a reply — `Standup`, trigger `standup`, reply `At 10:15. Yesterday: {query}` — and it is live in the chat from the next message on. `{query}` is whatever you typed after the trigger; `{name}`, `{time}`, `{date}` and `{lang}` also work. A reply template cannot read files or reach the network, which is what makes it safe to make this easy.

**A whole file:** create `js/plugins/my-skill.js`:

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

A true low-power native wake-word engine (Porcupine / openWakeWord), IndexedDB storage engine, Node.js companion with real OS automation, end-to-end encrypted sync. Full list: **[docs/ROADMAP.md](docs/ROADMAP.md)** · what changed lately: **[docs/CHANGELOG.md](docs/CHANGELOG.md)**

## 📄 License

MIT — this code is yours. Read it, change it, ship it.
