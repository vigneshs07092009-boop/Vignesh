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
                  └──────────────────────────────┘
```

### core.js — foundation
- `Aevion.store` — namespaced localStorage wrapper (`aevion:*` keys), JSON-safe, with `dump()`/`load()` for backups and sync bundles.
- `Aevion.bus` — `emit()` / `on()` event bus. Modules never call each other directly for events (e.g. `voice:final` → app).
- `Aevion.perms` — permission manager. Web permissions are requested through real browser APIs; OS-only permissions (contacts, automation) are tracked as "browser" tier and enforced in code — Aevion never bypasses OS restrictions.
- `Aevion.memory` — deduplicated local fact store (max 500), powers "remember: …" and recall.
- `Aevion.hash` — SHA-256 via WebCrypto for PINs and pairing passwords (only hashes stored, never plaintext).

### brain.js — the router
Every message is matched against an ordered rule list → `kind`. Kinds map to handlers. Handlers return strings, or `null` to fall through to the local chat fallback. If the route is open conversation and the user enabled online AI, `app.js` first tries `Aevion.online.chat()` with a persona system prompt + last 10 turns + memory, and falls back to the local brain on any error.

### online.js — the only door out
A single `fetch` wrapper for OpenAI-compatible endpoints (`/v1/chat/completions`), which Ollama, LM Studio, llama.cpp server, vLLM and most providers speak. Throws unless `settings.onlineAI` is true. 60 s timeout via AbortController.

### voice.js — on-device speech
Web `SpeechRecognition` (Chrome/Edge/Android WebView engine) for input, `speechSynthesis` for output. Mic permission is requested through the permission manager before first use. No audio ever leaves the engine the OS provides.

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
