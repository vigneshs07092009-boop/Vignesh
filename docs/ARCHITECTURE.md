# Aevion Architecture

## Design principles

1. **Local-first** — every feature must work with the network cable pulled.
2. **Opt-in networking** — any online call sits behind a user setting *and* a permission.
3. **Zero dependencies** — plain HTML/CSS/JS. Runs from a file, a USB stick, or any static host.
4. **Modular** — each `js/*.js` file is an isolated module hanging off one global `Aevion` object.
5. **Editable** — no build step, no transpiler. Change a file, refresh, done.

## Module map

```
                 ┌────────────────────────────┐
                 │          app.js            │  UI wiring, views, boot
                 └──────┬─────────────────────┘
                        │ uses
   ┌────────────┬───────┼────────────┬─────────────┐
   ▼            ▼       ▼            ▼             ▼
┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌──────────┐
│brain.js│ │tools.js│ │memory  │ │skills  │ │ voice.js │
│ router │─▶│ tiers  │ │5 layers│ │math/…  │ │ STT/TTS  │
└───┬────┘ │ +audit │ │+recall │ └────────┘ └──────────┘
    │      └───┬────┘ └────┬───┘
    │          │           │
    ▼          ▼           ▼
┌──────────────────────────────────────────┐
│  one interface, 16 adapters (9 free)      │
│  openai · groq · openrouter · cerebras    │
│  mistral · huggingface · github · nvidia  │
│  sambanova · gemini · anthropic · ollama  │
│  lmstudio · custom · webllm · mock        │
└───────┬───────────────┬──────────────────┘
        │ online.js     │ webllm.js
        │ persona shim  │ in-browser (WebGPU)
        ▼               ▼
┌──────────────────────────────────────────────┐
│                  core.js                     │
│ store · bus · perms · secrets(AES-GCM) ·     │
│ hash · identity                              │
└──────────────────────────────────────────────┘
```

Nothing above `core.js` talks to the network except `providers.js` (the endpoints you configure, plus a model download when you load one), `skills.js` (the translate endpoint) and the weather lookup in `brain.js` / `tools.js` (open-meteo, no account, no key). Five more modules arrived in 0.6.1 and every one of them is strictly local:

- **`nlu.js`** — the offline word tables `brain.js` consults *before* its English rules.
- **`attach.js`** — the paperclip; the bytes stay in RAM and are never stored or sent.
- **`voices.js`** — 15 speech presets layered on `voice.js`, rate and pitch included on Android.
- **`evolve.js`** — the consent gate for self-upgrade, plus the once-a-day learning pass.
- **`plugins.js`** — the plugin registry, now including no-code plugins made in the UI (and, since 0.6.3, plugins that name their own brain: `brainFor(spec)` says which one they would ask).
- **`setup.js`** (0.6.3) — the brain check above; it is strictly read-only apart from `apply()`.
- **`apps.js`** (0.6.4) — the apps-and-sites bridge: the Android app list (`Aevion.apps.listInstalled()` / `launch()` through the native `AppsPlugin`), and the *recent targets* list — the places Aevion opened for you, each one tap from becoming a plugin. Strictly local, and every failure is a sentence rather than a throw.

`tools.js` also grew a timer engine, a 38-entry site directory (`T.bestSite`) and `T.report()`, which is what the Tools view's **Automation report** prints.

### core.js — foundation
- `Aevion.store` — namespaced localStorage wrapper (`aevion:*` keys), JSON-safe, with `dump()`/`load()` for backups and sync bundles, plus **`dumpSafe()`** which drops credentials — every export path uses it.
- `Aevion.bus` — `emit()` / `on()` event bus. Modules never call each other directly for events (e.g. `voice:final` → app).
- `Aevion.perms` — permission manager. Web permissions are requested through real browser APIs; OS-only permissions (contacts, automation) are tracked as "browser" tier and enforced in code — Aevion never bypasses OS restrictions.
- `Aevion.memory` — replaced in 0.6.0 by `memory.js` (five layers, scored recall); the old flat API still works and the old key is migrated on first boot.
- `Aevion.secrets` — **encrypted credential vault.** Keys never live in `settings`. Setting a PIN calls `secrets.enable(pin)`, which derives an AES-GCM key with PBKDF2-SHA256 (150k iterations, per-vault salt) and re-encrypts everything with a fresh IV per write; `unlock(pin)` decrypts the cache after the PIN gate. Reads are synchronous from an in-memory cache so any module can ask for a key, and a locked vault simply reports no key rather than failing oddly. Without a PIN the vault says so (`isEncrypted() === false`) instead of pretending.
- `Aevion.hash` — SHA-256 via WebCrypto for PINs and pairing passwords (only hashes stored, never plaintext).

### memory.js — five layers, one honest rule
The layers are `session` (RAM only), `history` (the chat transcript), `longterm` (facts the user saved), `prefs` (preferences Aevion *noticed*) and `temp` (TTL scratch). The rule that matters: **`prefs` entries are stored unapproved, are excluded from recall entirely, and are invisible to the model until the user approves them in the Memory view.** Making a preference is not the same as being told one.

`recall(query)` is one scored scan — token overlap with a phrase bonus, recency decay and a per-layer weight, divided by √(item length) so long entries do not automatically win — with hard caps per layer. No model call, no embedding table, no network. `contextFor(query)` turns the top hits into a compact prompt block, which is what the provider layer receives; the Memory view's **Preview recall** runs the same function so the user can see it.

### tools.js — capability with a gate
Every tool declares a tier, and `canRun()` is consulted before anything happens:

| Tier | Runs when | Example |
|---|---|---|
| `read` | always | current time, calculator, language detection |
| `safe` | always (local, user-asked) | save a note, add a task |
| `sensitive` | its permission is granted, and online use is allowed | weather, clipboard, test the AI connection |
| `confirm` | the user approves *this call* | web search, open a link, forget a memory, export data |

`run()` throws a `ToolError` with a machine-readable `code` (`unknown` / `disabled` / `permission` / `network` / `confirm` / `failed`) instead of partially acting, tier-3 tools also emit `tool:confirm` so the UI can raise a modal, and an approval is never reusable. Every attempt — allowed or refused — is appended to a capped local audit log (`toolLog`). Tools can be switched off individually via `toolsDisabled`. **33 tools are registered at boot.**

**Timers are deadlines, not `setTimeout` calls you can lose.** Each outstanding timer carries an absolute deadline in `store('timers')`, so it survives a reload: `app.js` re-arms everything on boot and reports anything that came due while the app was closed. A per-app handle list keeps one timer from being armed twice, and a notification is raised only when the notification permission is actually granted — otherwise the timer still fires and speaks, it just does not push.

**Two lookups that never leave the device.** `T.SITES` is a 38-entry local directory and `T.bestSite(topic)` scores your words against it with no network call at all; `web.best` is tier `confirm`, asks before opening anything, and with `open: false` returns the recommendation without opening a tab. `T.report()` (tool `system.report`, tier `read`) prints one honest page: the tiers and their counts, what is switched off, what is waiting on a permission, which tools always ask first, what ran and what was refused.

### apps.js — “plug Aevion into what I install or search”, split honestly in two
A web page cannot see the apps installed on a device; no browser exposes that list. So the module does the part that *is* knowable, and says so about the part that is not:

- **Installed apps (Android only).** `Aevion.apps.supported()` is true only when `window.Capacitor.Plugins.Apps` exists — the native `AppsPlugin` (`PackageManager.queryIntentActivities(ACTION_MAIN + CATEGORY_LAUNCHER)`), registered in `MainActivity` before `super.onCreate()`, with the launcher `<queries>` entry the manifest needs on Android 11+. `launch(package)` starts an app by package name and answers `{opened:false, why}` when Android refuses. In a browser tab `listInstalled()` returns `{ok:false, why:'A browser tab cannot list the apps installed on this device …'}` — a sentence, not an exception, and the Plugins view prints it verbatim.
- **Places Aevion opened.** `open.url`, `web.search` and `web.best` call `Aevion.apps.note({url, name, query})`, so the only “what did I just use” Aevion can honestly know is what it *did* — never browser history, which it cannot read. Recents are capped at 8, deduplicated by address (the same search with a different query updates one entry), stored under the device key `appRecents`, and `template()` swaps the query you happened to use for `{query}`, which is what makes a plugged-in search a plugin instead of a bookmark.
- **No path throws.** Every function returns `{ ok, why }`; a broken bridge is caught and reported with the platform's own words; `checkLink()` validates a filled link under the same https-only rules as `open.url` **without opening anything**.

### providers.js — one interface, eighteen backends
OpenAI, Groq, **OpenRouter** (whose default model is Nex-N2.5 Mini, the open-weight agentic family), **Cerebras**, **Mistral**, **Hugging Face Inference**, **GitHub Models**, **NVIDIA NIM**, **SambaNova**, Anthropic, Gemini, Ollama, LM Studio / llama.cpp, any custom OpenAI-compatible endpoint, the in-browser model and the offline mock.

Every adapter is data + two pure functions, so adding one never touches the core. Two flags carry promises the UI depends on: `probes: true` marks the adapters that can answer “are you there?” with `GET /models`, and **`free: true`** marks the nine with a free tier — `P.freeIds()` is what the chat card's free-key picker is built from, and a test enforces the invariant behind the flag (hosted, needs a key, working default model, probeable, and a real `https://` link to where the key comes from).
An adapter is data plus two pure functions (`buildRequest(messages, cfg)`, `parseResponse(json)`, optional `parseStream(json)`), so adding a provider is additive and never touches the core. The shared HTTP layer handles SSE streaming (`data:` lines → `onToken` deltas, with a JSON fallback for gateways that ignore `stream: true`), an abort timeout, and error translation (401 → "the endpoint rejected the API key", 404 → "no model or endpoint at …", 429/5xx, unreachable host, empty reply).

`cfg` is per provider (`aiCfg` in storage), so switching back and forth never wipes an endpoint or a model name; keys are fetched from `Aevion.secrets` separately.

**Fallback is a privacy boundary.** `fallbackIds()` allows a cloud provider to hand over to another cloud *or* a local one, a loopback provider to loopback/local, and a local provider only to local. A prompt typed for one company is therefore never silently rerouted to a different one; `settings.aiFallback === false` disables fallback entirely. `chatWithFallback()` reports every reason it collected, including providers that were never configured.

**The attempt log (0.6.3).** Every request in this file goes through one wrapper (`timed()`), which appends `{ id, kind, ok, ms, chars, why }` to `brainLog` — capped at 60, never holding prompt or reply text — and emits `brain:log`. `chatWithFallback` records the chain it walks, including the providers it never tried because a key is missing (`kind: 'skip'`). That log is what the Tools view renders and what makes a reply's badge (`OLLAMA · 812 MS`) checkable rather than decorative.

### nlu.js — the offline brain underneath the router
`Aevion.languages` covers **84 languages** for the pickers; `js/nlu.js` carries real word tables for **49** of them and is consulted *before* the English rules.

- **English is untouched on purpose.** `route(text, lang)` returns `null` for English, so an English message takes exactly the path it took in 0.6.0. The new module cannot regress the old behaviour, and `tests/nlu.test.mjs` asserts the fall-through.
- **Scripts are detected, not assumed.** Digits fold through `ZEROES` (Devanagari, Kannada, Tamil, Telugu, Bengali, Arabic-Indic … → ASCII), `scripts()` reports which writing systems a string uses, and `detect()` picks a language from that plus the word hits.
- **Matching is word-boundary for Latin scripts, substring elsewhere.** “no” must not light up inside “not”, while agglutinative scripts are matched as substrings so a suffixed word still lands (`hit()`).
- **The vocabulary is data, and you can add to it.** `W` holds a table per language; `teach(lang, intent, words)` appends your own words from the Voice view's *Teach a command* card, `coverage()` counts what is recognised, and `forgetTaught()` clears it. `NUM` + `words2num()` turn spoken numbers into values and `fold()` normalises before matching.
- **28 intents**, each with a local handler in `brain.js`: timers, math (with an arithmetic fallback for bare expressions), time, date, jokes, notes, tasks, languages, thanks, clear and the rest.
- **Answers come back in your language.** `say(lang, key, vars)` and `jokeLocalized()` supply the phrasing, `localeTag()` builds the real region tag handed to speech, and `time()` / `date()` format through it — which is why `ಟೈಮರ್ 2 ನಿಮಿಷ` both answers in Kannada and sets a correct 120-second timer.

### brain.js — the router
Every message is offered to `nlu.route(text, lang)` first; if the offline tables claim it, that route wins. Otherwise it is matched against the ordered English rule list → `kind`, exactly as before. Kinds map to handlers. Handlers return strings, or `null` to fall through to the local chat fallback. If the route is open conversation and the user enabled online AI, `app.js` first tries `Aevion.online.chat()` with a persona system prompt + last 10 turns + memory, and falls back to the local brain on any error.

### webllm.js — the in-browser brain
Runs a small instruct model (Llama 3.2 / Qwen 2.5 / Gemma / Phi, 1–3B, q4f16) on your GPU through WebGPU. The engine (`vendor/webllm.esm.js`, Apache-2.0) is vendored locally — no CDN. Model weights download once from the public mlc-ai Hugging Face mirrors, get cached in browser Cache storage, and from then on chat runs 100% offline on-device. `chatStream(messages, onToken)` streams tokens for live typing. Chat priority: WebLLM → online AI → local brain. If WebGPU is missing, the Settings card says so and everything else still works.

### markdown.js — how replies look
Pure rendering module, no dependencies and no DOM required (`render(src) -> html`, `renderInto(el, src)`, `canStream(src)`, `toPlain(src)` for TTS).

- **Safety**: the source is HTML-escaped *before* any markup exists, so model output can never inject tags; links pass a scheme whitelist (`http(s)://`, `mailto:`, `#`) and are emitted with `rel="noopener noreferrer"`.
- **Blocks**: fences (``` and ~~~, language label preserved), headings, `<hr>`, blockquotes (recursive), ordered/unordered lists with one nesting level, pipe tables with `:---:` alignment, paragraphs whose line breaks are preserved (`<br>`).
- **Highlighting**: each language is an ordered list of `[tokenClass, regex]`; they are merged into one master regex and each alternative gets a marker capture group, so a single pass classifies tokens and every slice of untouched text stays escaped. Adding a language = one entry in `LANGS` + `ALIAS`.
- **Copy buttons**: emitted with the code block; `app.js` handles them with one delegated listener on `#chatLog`, so history-restored blocks work without re-binding.
- **Streaming**: `canStream()` returns false while a fence is open, which stops the chat repaint thrash during in-browser model output.

### online.js — persona only, plus which brain is on offer
Since 0.6.0 the transport lives in `providers.js`; this file owns the system prompt and a compatibility `chat()` that delegates (still refusing to run while `settings.onlineAI` is false). The prompt carries persona, language and **only the memories relevant to the current message**, plus a note when preferences are waiting for approval so the model never assumes them.

**It also owns the automatic online ↔ offline shift (0.6.2).** `available()` answers whether the online brain should be offered at all — the network is up and no failure is still cooling down — `markDown(reason)` / `markUp()` record a failed call for a 60-second cooldown, and `status()` reports `local · online · offline` with the reason and the time left until the retry. Everything here is session-only and gated on `settings.autoAI`: with that toggle off, `available()` always answers `true` and the old “try it, then fall back locally” behaviour is byte-for-byte unchanged. `app.js` renders the result as the header pill (**LOCAL · OFFLINE AI · ONLINE AI**) and passes `OFFLINE BRAIN` as the source badge when the online one was held back. The point is that a user's switches never move: offline is a state the app reports, not a setting it changes.

### The Tools view — what may run, and what did
Four cards from the same tables the gates read: **permission tiers**, the **tool list** with per-tool switches, **Run a tool**, the **automation report** (`T.report()`), the **activity log** (`toolLog`), and — since 0.6.3 — the **🧠 Brain log**: every AI attempt with its provider, latency, character count and the provider's own error message. Nothing there is written for the UI: the app's own code writes both logs at the moment of the action.

### setup.js — the one place that knows whether any brain answers (0.6.3)
The failure this module exists for is a provider that is *configured* and *not working*: Ollama picked in Settings with nothing listening on its port, a key that was never pasted, a model that was never downloaded. Every other screen could only say “Ready”.

- `quick()` — a sync snapshot from settings alone: which provider is picked, what it still needs, whether it is allowed to run. No network, no waiting; this is what the chat can ask before it sends anything.
- `probe(id)` — one `GET …/models` to a provider the user configured, 3 s timeout, `AbortController`-guarded. Only adapters that advertise `probes: true` (the OpenAI-compatible ones) can be asked; Anthropic and Gemini are reported as “no quick check” rather than guessed at. **Nothing is probed while `onlineAI` is off**, so a privacy-default install touches no network at all.
- `survey()` — every provider as `{ state, why, ms }`, plus `best` and `current`, and it emits `setup:surveyed` so the UI never keeps its own copy of the truth. `decide(options, current)` holds the rule: the choice you already made if it answers, then a server on your own machine, then the loaded in-browser model, then a hosted key you already saved — never moving your text to another company.
- `apply(id)` — the only write in the file: sets the provider, and switches `onlineAI` on *only* for a non-local provider, reporting `turnedOn` back so the UI can say so. A tap on a button that names exactly what it does is the consent.
- `note()` — one sync sentence for the offline brain to quote when it had to answer instead (“Ollama (your own machine) did not answer (nothing is listening at …)”), which is what turns “the AI is not working” into a specific, one-tap problem.

`app.js` renders the survey as the card above the composer and as the **⚡ Use the best brain this device has** button in Settings; `providers.js` uses `canAnswerNow()` so a provider that cannot answer is not offered as a fallback either.

**The card is on demand only (0.6.4).** It used to open by itself whenever nothing answered, and its *Not now* was a variable the next page load forgot — a pop-up that could not be dismissed. It now opens only from the **🧠 Set up AI** shortcut or the button in Settings → AI provider, and everything it does is reachable in Settings anyway. The header pill is what tells the truth at a glance (`LOCAL` / `OFFLINE AI` / `ONLINE AI` / **`NO BRAIN`**).

### Several brains at once (0.6.4)
`providers.js` exposes three functions, and they are the whole feature: **`multiPlan()`** returns the ticked brains that can actually answer right now (`not ticked · missing config · wrong trust class` filters, and fewer than two means an ordinary single-brain message), **`askMany()`** asks them in parallel and returns one leg per brain — never throwing for a bad provider — and **`askCritique()`** runs a chain where each next brain is handed the previous draft *plus the original question*, keeping the last good answer if a reviewer fails.

`app.js` picks between them from `settings.brainStrategy` (`first` / `compare` / `critique`) *before* the single-brain path and falls through to it when every leg fails, so a multi-brain message can never be worse than a plain one. Every leg goes through `chatWith()`, so the attempt log shows the chain. The honest boundary: two independent answers and a second reader are real, describable behaviours; models merging into something smarter is not a thing this does, so it does not claim it.

### voice.js — on-device speech, two engines
One public API (`start`, `stop`, `speak`, `voices`, `shutup`, `errorText`), two backends chosen at load time:

1. **Native (Android APK)** — if `window.Capacitor.Plugins.Speech` exists, input goes through Android's `SpeechRecognizer` and output through `TextToSpeech`. This is required because the Web Speech API is absent in Android WebView (which is why the mic button never worked in the APK). Partial results stream into the composer live; error codes are mapped to readable text. The Java side lives at `android/app/src/main/java/com/aevion/app/SpeechPlugin.java` — edit and rebuild with `update-and-rebuild.bat`.
2. **Web (Chrome/Edge/Safari)** — `SpeechRecognition` for input, `speechSynthesis` for output.

Both paths request the microphone through Aevion's permission manager first, so the OS dialog appears only after you allow it in Settings, and nothing listens until the mic is tapped. `speechSynthesis` is feature-detected everywhere, since referencing it unguarded throws in a WebView.

### voices.js — fifteen voices you can actually choose
`voice.js` speaks; `js/voices.js` decides *how*. There are **15 presets** — the device's own engine voice plus 14 named ones (`aria`, `nova`, `luna`, `mira`, `coral`, `pixie`, `blaze`, `echo`, `orion`, `atlas`, `sage`, `titan`, `vega`, …), each with its own rate and pitch.

- **Presets are plain data**, so the picker, the ▶ preview button and the “applied” state all come from one list (`list()` / `get()` / `current()`).
- **Matching is whole-word on purpose.** Engines name their voices things like “Google UK English Female”, and a careless `includes('male')` would match *Female*. `V.match()` compares whole words and ranks language and name hits.
- **Choosing a voice writes its rate and pitch into settings** and points `voiceURI` at a real engine voice only when one matches; if nothing matches you still get the preset's speed and pitch from the default voice instead of a setting that quietly does nothing.
- **Previewing never changes your settings.** `preview(id)` goes through `voice.speak(text, force, override)`, so auditioning five voices in a row leaves your chosen one alone (`syncVoiceSliders()` keeps the sliders honest afterwards).
- **Android honours it too.** The Capacitor `SpeechPlugin` reads `rate` / `pitch` and clamps them to 0.5–2 before calling `setSpeechRate` / `setPitch`, which is what makes a preset sound the same in the APK as in the browser.

### wake.js — the optional wake word
`js/wake.js` is a separate module with its own state machine: `off → armed → heard → capturing → thinking → speaking → paused`. It owns the always-on recognizer, and nothing else does.

- **Off by default, and off is real.** `enable()` asks Aevion's permission manager before it creates a recognizer, so a denied permission never opens the mic; `disable()` aborts the session and clears the setting. A reload closes the microphone with the page and `app.js` clears the stored flag rather than leaving a lit switch over a dead mic.
- **The name is a setting, not a constant.** `Aevion.settings.name` is matched exactly, plus a table of phonetic neighbours of the default name, plus a small edit distance scaled by word length — recognizers mangle names, and "averion" should still work. Greetings (`hey`, `hayy`, `yo`, `ok`, …) may precede the name, and up to two filler tokens may sit between them ("hey um aevion …").
- **The name must be addressed, not mentioned.** It has to lead the sentence or follow a greeting, so "what does aevion mean" does not wake anything.
- **One loop, three behaviours.** Name + request in one breath runs immediately; the name alone emits `wake:heard` (the UI answers with a spoken cue) and takes the next sentence as the request; after a reply a short follow-up window keeps taking sentences without the name. Talking over a reply stops it, and the interruption is used as the new request unless it is a stop word.
- **It gives up honestly.** Repeated engine errors back off exponentially instead of hot-looping, `not-allowed` turns the mode off, three idle minutes stop it and say so, and `supported()` refuses to pretend on a device with no recognizer at all. On Android the native plugin is tap-to-talk, which is why a real low-power wake word is still on the roadmap: browser-side continuous recognition costs battery and audio leaves the device to the OS speech service.
- **The ledger is inspectable.** Every transition and every ignored utterance is kept in `wake.log()`, so the UI can show why it did or did not listen.

### attach.js — the paperclip, and where the bytes go
Photo, video, document or PDF: `kindOf()` decides from the MIME type and falls back to the file extension when Android/WebView hands over an empty type. Files up to 40 MB are accepted, and a larger one is refused with the actual reason and the limit in the message rather than silently dropped.

The part that matters is what does **not** happen. The bytes live in memory for the session — nothing is written to storage, nothing is uploaded, and only metadata (name, kind, size) is kept for the chips row. `text()` reads a document through `Blob.text()` with a cap, `textAll()` concatenates what is readable, and `brain.js`'s `attachedText()` folds that into the prompt only while the attachment is still attached. Reload the page and they are gone, so the chips row says exactly that instead of implying a vault that does not exist.

### theme.js — themes, and every knob on top of them
A theme is nothing but CSS variables (`css/themes.css`); `data-theme` picks one. `js/theme.js` owns everything above that:

- **`KNOBS`** is the list of adjustable values — 8 colours and 4 shape numbers — each with its CSS variable, type, range and label. The UI builds its controls from that list, so adding a knob is one entry here and no DOM code at all.
- **Overrides are per knob and stored** in `settings.themeCustom`, so your two changes survive a reload and keep working when you switch preset. Reset removes the inline value and the preset shows through again.
- **Validation is strict on purpose**: these values end up in a stylesheet, so a colour must be plain hex or `rgb()`/`hsl()`, numbers are clamped to their range, and a value carrying a URL, an expression or a second declaration is refused — and named back to the user. `tests/theme.test.mjs` feeds it hostile input to keep that true.
- **The glow is derived from the accent** with `color-mix(in srgb, var(--accent) N%, transparent)`, so it follows a custom accent instead of being a fixed hex per theme.
- **`exportText()` / `loadText()`** make a theme one portable line, and a round trip is lossless.

All 34 `font-size` declarations in `style.css` are `calc(Npx * var(--fs-scale))` and panel blur is `var(--blur)`, so the size knobs move the real UI rather than setting an unused variable.

### evolve.js — self-upgrade, gated on consent
The user asked for a toggle Aevion cannot flip by itself, and that is what this file is.

- **`on()` is synchronous and verifies a hash.** A stored `{on: true}` record is inert unless it also carries `consent` — a SHA-256 of the moment you allowed it (`Aevion.hash('su:' + at)`). A record hand-written into localStorage, by you or by another script, therefore reads as *off*. Turning it **off never needs consent**, because taking capability away must never be hard.
- **`apply(pack)` accepts three kinds of pack only:** `words` (teach new offline words), `plugin` (a simple plugin) and `facts` (memory candidates). `kind: 'code'` is refused with a plain explanation: a web app cannot rewrite its own source, and a feature that pretended to would be worse than not having it. What it *can* do is compose new behaviour out of primitives that already exist.
- **Everything applied is reversible and logged** (`history()`), and packs land in the same code paths as the UI: taught words go through `nlu.teach()`, facts become *unapproved* memory candidates.
- **`learn()` runs at most once a day** (`learnDay` / `learnLog`). It reads the day's chat, mines statements that look worth remembering, and files them in memory's approval queue — never auto-approved. The digest says what it noticed, what it filed and what it refused.

### Device access — one switch, no bypass
`Aevion.perms` splits capabilities in two: `DEVICE` (askable in this context) and `SHELL_ONLY` (real only inside the Android shell). `requestAll()` asks for the first group one at a time and returns a per-permission report of `granted` / `denied` / `unavailable`; `revokeAll()` clears every allowed key, including stale ones.

It is deliberately **not** a master permission. A sensitive tool still checks its own permission through `tools.canRun()`, and tier `confirm` still refuses without a fresh `{ confirm: true }` from the user — `tests/device.test.mjs` asserts exactly that with everything granted. The switch is a convenience for consenting, and a faster way to take consent back.

### Event bus payloads
`Aevion.emit(name, payload)` wraps the payload in a `CustomEvent`; `Aevion.on(name, fn)` unwraps it so `fn` receives the payload directly. Handlers that ignore arguments (like `chat:clear`) are unaffected.

### Plugins
`Aevion.plugins.register({ name, desc, commands })`. Command keys are matched as message prefixes before the brain runs. Files are plain `<script>` tags — no loader magic. Since 0.6.1 the registry lives in `js/plugins.js` rather than `app.js`.

**App & site plugins (0.6.4)** are simple plugins that hold an *address* instead of an answer: `target` (with `{query}` for a search), an optional `fallback` link, and an optional Android `app` package. `openSpec()` prefers the named app when Android can start it, and otherwise opens the link through the same confirm-tier `open.url` tool as everything else — so a plugin can never open something Aevion itself would refuse, and it asks every single time. The Plugins view builds them for you: the **recent targets** list (where Aevion has taken you) turns a place into a plugin in one tap with the query replaced by `{query}`, and on Android *📱 Look for apps on this device* turns an installed app into a plugin that starts it. `checkLink()` tests a filled link — https-only, real host — without opening it.

**No-code plugins** are the same idea without a file: the Plugins view takes a name, one or more trigger words and a reply template, and `saved()` persists them in `store('simplePlugins')` (capped at 100). Templates fill `{query}`, `{name}`, `{time}`, `{date}` and `{lang}`, `describe()` renders them for the list, `collisions()` reports trigger clashes, and `rebuild()` re-registers everything at boot. A simple plugin deliberately **overrides** a file plugin with the same trigger, so the thing you can see in the UI always wins over the thing shipped in a file. Removing one is immediate.

## Data storage layout (all under `aevion:*`)

| Key | Shape |
|---|---|
| `settings` | settings, permission map, tool switch-offs, PIN hash — **never an API key** |
| `secrets` | credential vault: `{e: 0/1, salt, items}` (ciphertext when a PIN is set) |
| `aiCfg` | per-provider `{url, model}` (no keys) |
| `chatHistory` | last 60 `{role, text, t}` |
| `memory:longterm` / `memory:prefs` / `memory:temp` | layered memory entries `{id, text, tag, t, approved?, expires?}` |
| `tasks`, `notes`, `autos`, `devices`, `fcDecks` | user data |
| `files` | vault entries as data-URLs (≤2 MB each) |
| `toolLog` | last 50 tool attempts `{t, id, ok, code, ms}` |
| `timers` | outstanding timers `{id, label, at, done?}` — re-armed on boot |
| `selfUpgrade` | `{on, at, by, consent}` — the consent hash binds the record to the moment you allowed it |
| `upgradeLog`, `learnDay`, `learnLog` | what the gate applied, and the last 30 daily digests |
| `simplePlugins` | no-code plugins made in the Plugins view (≤100) |
| `appRecents` | the last 8 places Aevion opened for you — address, name and the query only, one tap from being plugged in |
| `brainCardSeen` | that the brain setup panel has been opened at least once, so nothing opens it on its own |
| `deviceId`, `deviceLabel` | local identity |

Attachments are deliberately absent from this table: their bytes live in memory only, so reloading the page forgets them.

The legacy flat `memory` key is migrated into `memory:longterm` and deleted on first boot.

## Sync model (Devices view)

1. Device A creates a pairing password → SHA-256 hash stored locally.
2. A exports a `.aevion` bundle (`dumpSafe()`: everything *except* the credential vault and any `aiKey:*`, local file only).
3. User moves the file by any means (USB, share sheet, email-to-self).
4. Device B must already have a pairing password set; import asks for the password and compares hashes **locally** before merging.
5. The sender is registered in B's device list. No server, no accounts, no background sync.

## Verification layers

Three independent gates, all runnable with a bare Node install and no packages:

```
npm run check    tools/check.mjs — static integrity
npm test         tests/*.test.mjs — behaviour, in a browser shim
npm run verify   both
```

**`tools/check.mjs`** is deliberately paranoid about the things a unit test cannot see: every asset the page loads exists on disk; no module sits on disk unloaded; every `$('#id')` in `app.js` resolves to a real element; every nav item has a view section; every emitted event has a listener; the asset version agrees across `index.html`, `sw.js`, `core.js`, `package.json`, the CI workflow and `verify-apk.ps1`; the 6.6 MB engine is *not* in the install-time cache; the Android manifest still carries `RECORD_AUDIO` and the speech `<queries>`; `registerPlugin` still precedes `super.onCreate`; no credential-looking string is committed; the promised languages, providers, tiers and memory layers all really exist; and every interactive control inside a view is either wired to a handler or listed as deliberately inert, so a button cannot quietly become dead weight.

**`tests/harness.mjs`** builds a fresh sandbox per test: a localStorage with a working quota (so "the disk is full" is testable), a `fetch` that records every call and can return JSON, SSE streams, HTTP errors or throw, a real event bus, WebCrypto, `btoa`/`atob`, and a `window.open` that records instead of navigating. It then reads the `<script>` tags out of `index.html` and evaluates those exact files, so the suite cannot drift from what ships.

The suites assert the properties that matter rather than line coverage: that a locked vault cannot be read, that an unapproved preference never reaches recall, that a sensitive tool refuses without its permission, that an approval does not carry over, that a failing cloud provider does not leak a prompt to another company, and that model output can never inject markup.

## Extension points

- **Add an AI provider:** one `Aevion.providers.register({...})` call with `buildRequest`/`parseResponse`. No other file changes.
- **Add a tool:** `Aevion.tools.register({ id, name, tier, perms, run })` — the permission and audit plumbing is already there.
- **Add a memory layer:** an entry in `LAYERS` (key, cap, weight, label) and it appears in the Memory view, `stats()` and `recall()` automatically.
- Swap `Aevion.store` for IndexedDB/SQLite — interface is 6 methods.
- Add `Aevion.skills.*` entries + brain rules for new offline skills.
- **Add a voice preset:** one entry in `js/voices.js` — the picker, the preview and the Android rate/pitch follow automatically.
- **Add an offline language:** a row in `Aevion.languages` for the picker, word tables in `js/nlu.js` for routing — or teach a few words live from the Voice view and let `coverage()` say what is now recognised.
- **Teach it a new capability without shipping code:** a `words`, `facts` or `plugin` pack through `Aevion.evolve.apply()`, which needs your consent and stays reversible.
- Replace the PWA shell with Capacitor/Node shells — `js/` stays untouched.
