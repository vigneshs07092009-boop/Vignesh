# Plugin Guide

Aevion plugins are single JavaScript files. No bundler, no registry, no permissions beyond what you grant.

## Anatomy

```js
// js/plugins/my-plugin.js
Aevion.plugins.register({
  name: 'Dice Roller',              // shown in Plugins view
  desc: 'Roll any dice: /roll 2d20',
  commands: {
    '/roll': async (text) => {
      const m = text.match(/\/roll\s*(\d*)d(\d+)/i);
      const n = parseInt(m?.[1] || '1'), d = parseInt(m?.[2] || '6');
      let total = 0, rolls = [];
      for (let i = 0; i < Math.min(n, 20); i++) {
        const r = 1 + Math.floor(Math.random() * d);
        rolls.push(r); total += r;
      }
      return `🎲 [${rolls.join(' + ')}] = ${total}`;
    }
  }
});
```

## Install

1. Save the file into `aevion/js/plugins/`
2. Add one line to `aevion/index.html` (after `app.js`):

```html
<script src="js/plugins/my-plugin.js"></script>
```

3. Refresh. Your command appears instantly — type `/roll 2d20` in chat.

## No-code plugins (no file, no `<script>` tag)

Open **Plugins** in the sidebar and fill three boxes:

| Field | What it does | Example |
|---|---|---|
| Name | shown in the installed list | `Standup notes` |
| Triggers | words that start it, separated by commas | `standup, daily notes` |
| Reply | the template Aevion answers with | `🧩 At {time} I'm looking at {query}` |

Placeholders you can use: `{query}` (the rest of what you typed), `{name}` (Aevion's name), `{time}`, `{date}`, `{lang}`.

Saved plugins live in `store('simplePlugins')` as plain data (max 100), are re-registered on every boot, and disappear from the list the moment you remove one — no file, no refresh, no restart. Two rules worth knowing:

- A no-code plugin **overrides** a file plugin that claims the same trigger, so what you can see in the UI always beats what a file shipped.
- Trigger clashes between two no-code plugins are reported at save time rather than silently resolved.

Use a file plugin when you need logic, state or a tool; use a no-code plugin when you just want Aevion to answer something specific.

## App & site plugins — a plugin that does something instead of answering

An **https** address makes a plugin an *action*. Add one in the fourth box (and change the third to whatever you want said alongside it):

| Field | What it does | Example |
|---|---|---|
| Link to open | opened through the confirm-tier `open.url` tool | `https://duckduckgo.com/?q={query}` |
| Android app package | optional; preferred when the app is installed | `com.whatsapp` |

Rules that make this safe rather than clever:

- **`https:` only**, checked both when you save it and when it runs — the same rule the `open.url` tool enforces, so a plugin can never open something Aevion itself would refuse.
- **It asks every single time.** Opening is confirm-tier: the prompt appears at the moment you use the plugin, on that call only. A plugin is a shortcut for consenting, never a bypass.
- **`{query}` is encoded for you** — spaces and `&` cannot break the address.
- **One fallback link** is allowed, tried only if the first one fails.
- On Android, a named app is started through the native plugin instead of the browser, and if Android refuses, the link is used — so the same plugin works in both builds.

### Where the list of apps and sites comes from

You never type an address if you do not want to. The Plugins view offers two one-tap routes:

- **🔌 Plug in**, next to any place Aevion has already taken you — a web search, an opened link, a “best app or site for…“ pick. It is the address Aevion itself opened, with the query you used replaced by `{query}`, so the plugin works for *any* search rather than repeating tonight's one. (Aevion can only know the places *it* opened: no browser lets a page read your history.)
- **📱 Look for apps on this device** — Android only, where the installed-app list is a real system API. In a browser tab the panel says exactly why it cannot, rather than showing an empty box that looks broken.

**Test the answer** works for these too: it validates the link with a made-up query — https, real host, what the finished address looks like — and **opens nothing**, so a test can never become an accidental visit.

## Letting a plugin use your AI

A reply template is instant and offline, but it cannot *think*. Every no-code plugin has an **Answer with** choice:

| Choice | What happens |
|---|---|
| **My text** (default) | Your words, verbatim, offline. |
| **Your AI** | The template is sent to the brain you picked in Settings → Providers as an *instruction* — “your saved reply is «…», treat it as the shape of a good answer” — and the plugin replies with what comes back, prefixed 🧠. |

The template is never thrown away: it is both the instruction and the fallback. **No provider, no key, no network, or a switch that says no** — all of them return your text instead of an error, and a toast tells you why (“answered from your saved text — Ollama still needs endpoint URL”). An AI-backed plugin therefore cannot become a plugin that fails.

The gates are the same ones the rest of the app honours: `onlineAI` must be on for a cloud brain, the auto-switch must consider it reachable, and the provider must actually be configured. A plugin is never a side door to the network.

File plugins get the same thing through the API:

```js
const better = await Aevion.plugins.askAI({
  name: 'Coach',
  reply: 'Encourage them and suggest one small step.',
  ai: 'openai'        // or true to follow the provider in Settings
}, textAfterYourTrigger);
return better ? '🧠 ' + better : '🧩 ' + myFallback(textAfterYourTrigger);
```

`ai` may name a specific provider (`'openai'`, `'groq'`, `'ollama'`, `'mock'`…); a name the app does not know is stored as `auto` rather than silently pointing somewhere else.

## What plugins can use

- `Aevion.store` — persist data (namespaced localStorage), `dumpSafe()` for backups
- `Aevion.memory` — the five layers: `add`, `recall`, `suggest` (unapproved), `contextFor`, `stats`
- `Aevion.skills` — math, summarizer, translator, language detection helpers
- `Aevion.providers` — `chat(messages, {onToken})` through whichever backend the user configured
- `Aevion.tools` — register your own capability with a permission tier (below)
- `Aevion.emit` / `Aevion.on` — event bus (`chat:clear`, `voice:final`, `data:changed`, …)
- `Aevion.perms` — request/check permissions properly
- DOM — render buttons/views if you want a plugin UI

## Registering a tool (better than a command for anything with a side effect)

Commands are fine for pure text replies. If your plugin *does* something — writes a file, opens a link, spends an API call — register it as a tool so it inherits the permission tier, the confirmation gate and the audit log automatically:

```js
Aevion.tools.register({
  id: 'roll.dice',
  name: 'Roll dice',
  tier: 'safe',                 // read | safe | sensitive | confirm
  desc: 'Rolls n dice with d sides.',
  params: { spec: '2d20' },
  run: async ({ spec }) => {
    const [n, d] = (spec || '1d6').split('d').map(Number);
    const rolls = Array.from({ length: Math.min(n || 1, 20) }, () => 1 + Math.floor(Math.random() * (d || 6)));
    return `🎲 [${rolls.join(' + ')}] = ${rolls.reduce((a, b) => a + b, 0)}`;
  }
});
```

Pick the tier honestly: `read` for pure local computation, `safe` for reversible local writes, `sensitive` for device data or anything that spends a network call (add `network: true`), and `confirm` when the action cannot be undone or leaves the device. A `confirm` tool is asked about *every time* — do not try to remember approvals on the user's behalf.

## Rules of the road

- Commands are prefix-matched (`/roll …`), checked before the brain.
- Return a string (or a Promise for one) — it's shown and spoken like any reply.
- Ask for permissions via `Aevion.perms.request('…')`; never assume.
- Keep network calls gated: check `Aevion.settings.onlineSearch` (or add your own toggle) — plugins should respect the privacy model too.

## Ideas to build

`/unit 5km→mi` converter · `/password 20` generator · `/define` (offline dictionary) · expense logger with `Aevion.store` · `/habit` streak tracker · Pomodoro hook that logs sessions to Organizer.
