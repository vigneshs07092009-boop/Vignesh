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
      ┌─────────────────┼──────────────────────┐
      ▼                 ▼                      ▼
┌───────────┐    ┌─────────────┐        ┌────────────┐
│  brain.js │───▶│  skills.js  │        │  voice.js  │
│ intent NLU│    │ math/study/ │        │ STT / TTS  │
│  router   │    │ translate   │        └────────────┘
└─────┬─────┘    └─────────────┘
      │ open conversation + onlineAI enabled
      ▼
┌───────────┐     ┌──────────────────────────────┐
│ online.js │     │           core.js            │
│ gated API │     │ store · bus · perms · memory │
└───────────┘     │        hash · identity       │
┌───────────┐     └──────────────────────────────┘
│ webllm.js │  in-browser LLM (WebGPU), loads
│ opt-in AI │  vendor/webllm.esm.js (Apache-2.0)
└───────────┘
```

### core.js — foundation
- `Aevion.store` — namespaced localStorage wrapper (`aevion:*` keys), JSON-safe, with `dump()`/`load()` for backups and sync bundles.
- `Aevion.bus` — `emit()` / `on()` event bus. Modules never call each other directly for events (e.g. `voice:final` → app).
- `Aevion.perms` — permission manager. Web permissions are requested through real browser APIs; OS-only permissions (contacts, automation) are tracked as "browser" tier and enforced in code — Aevion never bypasses OS restrictions.
- `Aevion.memory` — deduplicated local fact store (max 500), powers "remember: …" and recall.
- `Aevion.hash` — SHA-256 via WebCrypto for PINs and pairing passwords (only hashes stored, never plaintext).

### brain.js — the router
Every message is matched against an ordered rule list → `kind`. Kinds map to handlers. Handlers return strings, or `null` to fall through to the local chat fallback. If the route is open conversation and the user enabled online AI, `app.js` first tries `Aevion.online.chat()` with a persona system prompt + last 10 turns + memory, and falls back to the local brain on any error.

### webllm.js — the in-browser brain
Runs a small instruct model (Llama 3.2 / Qwen 2.5 / Gemma / Phi, 1–3B, q4f16) on your GPU through WebGPU. The engine (`vendor/webllm.esm.js`, Apache-2.0) is vendored locally — no CDN. Model weights download once from the public mlc-ai Hugging Face mirrors, get cached in browser Cache storage, and from then on chat runs 100% offline on-device. `chatStream(messages, onToken)` streams tokens for live typing. Chat priority: WebLLM → online AI → local brain. If WebGPU is missing, the Settings card says so and everything else still works.

### markdown.js — how replies look
Pure rendering module, no dependencies and no DOM required (`render(src) -> html`, `renderInto(el, src)`, `canStream(src)`, `toPlain(src)` for TTS).

- **Safety**: the source is HTML-escaped *before* any markup exists, so model output can never inject tags; links pass a scheme whitelist (`http(s)://`, `mailto:`, `#`) and are emitted with `rel="noopener noreferrer"`.
- **Blocks**: fences (``` and ~~~, language label preserved), headings, `<hr>`, blockquotes (recursive), ordered/unordered lists with one nesting level, pipe tables with `:---:` alignment, paragraphs whose line breaks are preserved (`<br>`).
- **Highlighting**: each language is an ordered list of `[tokenClass, regex]`; they are merged into one master regex and each alternative gets a marker capture group, so a single pass classifies tokens and every slice of untouched text stays escaped. Adding a language = one entry in `LANGS` + `ALIAS`.
- **Copy buttons**: emitted with the code block; `app.js` handles them with one delegated listener on `#chatLog`, so history-restored blocks work without re-binding.
- **Streaming**: `canStream()` returns false while a fence is open, which stops the chat repaint thrash during in-browser model output.

### online.js — the only door out
A single `fetch` wrapper for OpenAI-compatible endpoints (`/v1/chat/completions`), which Ollama, LM Studio, llama.cpp server, vLLM and most providers speak. Throws unless `settings.onlineAI` is true. 60 s timeout via AbortController.

### voice.js — on-device speech, two engines
One public API (`start`, `stop`, `speak`, `voices`, `shutup`, `errorText`), two backends chosen at load time:

1. **Native (Android APK)** — if `window.Capacitor.Plugins.Speech` exists, input goes through Android's `SpeechRecognizer` and output through `TextToSpeech`. This is required because the Web Speech API is absent in Android WebView (which is why the mic button never worked in the APK). Partial results stream into the composer live; error codes are mapped to readable text. The Java side lives at `android/app/src/main/java/com/aevion/app/SpeechPlugin.java` — edit and rebuild with `update-and-rebuild.bat`.
2. **Web (Chrome/Edge/Safari)** — `SpeechRecognition` for input, `speechSynthesis` for output.

Both paths request the microphone through Aevion's permission manager first, so the OS dialog appears only after you allow it in Settings, and nothing listens until the mic is tapped — there is no always-on wake word (privacy + battery). `speechSynthesis` is feature-detected everywhere, since referencing it unguarded throws in a WebView.

### Event bus payloads
`Aevion.emit(name, payload)` wraps the payload in a `CustomEvent`; `Aevion.on(name, fn)` unwraps it so `fn` receives the payload directly. Handlers that ignore arguments (like `chat:clear`) are unaffected.

### Plugins
`Aevion.plugins.register({ name, desc, commands })`. Command keys are matched as message prefixes before the brain runs. Files are plain `<script>` tags — no loader magic.

## Data storage layout (all under `aevion:*`)

| Key | Shape |
|---|---|
| `settings` | full settings object incl. permission map, PIN hash |
| `chatHistory` | last 60 `{role, text, t}` |
| `memory` | array of `{id, text, tag, t}` |
| `tasks`, `notes`, `autos`, `devices`, `fcDecks` | user data |
| `files` | vault entries as data-URLs (≤2 MB each) |
| `deviceId`, `deviceLabel` | local identity |

## Sync model (Devices view)

1. Device A creates a pairing password → SHA-256 hash stored locally.
2. A exports a `.aevion` bundle (all `aevion:*` data, plaintext, local file only).
3. User moves the file by any means (USB, share sheet, email-to-self).
4. Device B must already have a pairing password set; import asks for the password and compares hashes **locally** before merging.
5. The sender is registered in B's device list. No server, no accounts, no background sync.

## Extension points (future modules)

- Swap `Aevion.store` for IndexedDB/SQLite — interface is 6 methods.
- Add `Aevion.skills.*` entries + brain rules for new offline skills.
- Add providers in `online.js` (it only needs `chat(messages) → string`).
- Replace the PWA shell with Capacitor/Node shells — `js/` stays untouched.
