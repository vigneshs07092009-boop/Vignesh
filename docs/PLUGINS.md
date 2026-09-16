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

## What plugins can use

- `Aevion.store` — persist data (namespaced localStorage)
- `Aevion.memory` — read/add private local facts
- `Aevion.skills` — math, summarizer, translator helpers
- `Aevion.emit` / `Aevion.on` — event bus (`chat:clear`, `voice:final`, …)
- `Aevion.perms` — request/check permissions properly
- DOM — render buttons/views if you want a plugin UI

## Rules of the road

- Commands are prefix-matched (`/roll …`), checked before the brain.
- Return a string (or a Promise for one) — it's shown and spoken like any reply.
- Ask for permissions via `Aevion.perms.request('…')`; never assume.
- Keep network calls gated: check `Aevion.settings.onlineSearch` (or add your own toggle) — plugins should respect the privacy model too.

## Ideas to build

`/unit 5km→mi` converter · `/password 20` generator · `/define` (offline dictionary) · expense logger with `Aevion.store` · `/habit` streak tracker · Pomodoro hook that logs sessions to Organizer.
