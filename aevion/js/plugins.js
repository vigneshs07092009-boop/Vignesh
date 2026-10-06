/* ============================================================
 * Aevion Plugins — two ways to extend the assistant.
 *
 * 1. A file plugin (js/plugins/your-plugin.js) registers itself:
 *
 *      Aevion.plugins.register({
 *        name: 'Hello World',
 *        desc: 'Demo plugin',
 *        commands: { '/hello': async () => 'Hi!' }
 *      });
 *
 *    Full power, but it needs a text editor — so it stays, and a
 *    registry that lives in a module (not in app.js) is what lets the
 *    tests exercise it without a DOM.
 *
 * 2. A *simple* plugin needs no code at all. You give it a trigger, a
 *    reply, and optionally a few placeholders:
 *
 *      { name: 'Standup', triggers: ['standup'],
 *        reply: 'Standup at 10:15. Yesterday: {query}' }
 *
 *    It is stored as data on this device, appears in the Plugins view,
 *    can be edited or deleted there, and can be installed from a pack
 *    once self-upgrade is allowed. A simple plugin cannot read files,
 *    reach the network or run code — a reply template is the whole
 *    feature, which is exactly why it is safe to make this easy.
 *
 * Placeholders: {query} everything after the trigger, {name} the
 * assistant's name, {time}, {date}, {lang} the current language name.
 *
 * 3. A simple plugin may also *ask an AI* for a better answer. `ai: true`
 *    (or `ai: 'openai'` to name a specific brain) passes the template to
 *    the configured provider and returns what comes back. The template is
 *    never thrown away: it is the instruction *and* the fallback, so an
 *    AI-backed plugin cannot become a plugin that fails — no provider, no
 *    key, no network, or a switch that says no all return the template.
 *    File plugins get the same thing through `Aevion.plugins.askAI()`.
 * ============================================================ */
(function () {
  const P = { list: [], commands: {}, file: {} };

  P.register = function (p) {
    if (!p || !p.name) return null;
    const i = P.list.findIndex(x => x.name === p.name);
    if (i >= 0) P.list[i] = p; else P.list.push(p);
    Object.assign(P.file, p.commands || {});
    P.rebuild();
    return p;
  };

  P.saved = () => Aevion.store.get('simplePlugins', []);
  const save = list => Aevion.store.set('simplePlugins', list.slice(0, 100));

  const queryOf = function (spec, text) {
    const t = String(text || '');
    const lower = t.toLowerCase();
    const hit = (spec.triggers || []).find(tr => lower.startsWith(tr)) || '';
    return hit ? t.slice(hit.length).trim() : t.trim();
  };

  /* One filler for both a reply template and a link template. A link needs
     the query *encoded* (spaces and & would otherwise break the address), so
     that is the one difference between the two uses. */
  const tmpl = function (raw, spec, text, encodeQuery) {
    const query = queryOf(spec, text);
    const lang = Aevion.settings
      ? (((Aevion.languages || []).find(l => l.code === Aevion.settings.lang) || {}).english || 'English')
      : 'English';
    return String(raw == null ? '' : raw)
      .replace(/\{query\}/g, encodeQuery ? encodeURIComponent(query) : query)
      .replace(/\{name\}/g, (Aevion.settings && Aevion.settings.name) || 'Aevion')
      .replace(/\{time\}/g, new Date().toLocaleTimeString())
      .replace(/\{date\}/g, new Date().toLocaleDateString())
      .replace(/\{lang\}/g, lang);
  };
  const fill = (spec, text) => tmpl(spec.reply, spec, text, false);

  /* ---------- a plugin that opens an app or a site ----------
     The honest version of “plugin it to whatever app I install or search for”:
     a plugin can hold the *address* you give it — a site, a search with
     {query} in it, a deep link that https can reach — and opens it through the
     same confirm-tier `open.url` tool as everything else. So a plugin can
     never open anything Aevion itself would refuse, and it never opens
     something behind your back: the permission is checked, and the address is
     asked about every single time.

     What a web page cannot do is list the apps installed on your device or
     read your browser history — no browser exposes either — so nothing here
     pretends to. The Plugins view says so in as many words. */
  const openSpec = async function (spec, text) {
    /* An installed app comes first when the plugin names one: on Android that
       is the app itself, which is better than a web page of it. It cannot
       throw — Aevion.apps answers { ok, why } — and if it is not available
       here (a browser tab cannot start an app) the link below still runs, so
       the same plugin works in both builds instead of erroring in one. */
    if (spec.app && Aevion.apps) {
      const r = await Aevion.apps.launch(spec.app);
      if (r.ok) return '📱 ' + String(r.via === 'app' ? 'Opened' : 'Handed to') + ' ' + (spec.appName || spec.app) + ' on this device.' + (spec.reply ? '\n' + fill(spec, text) : '');
      if (!spec.target && !spec.fallback) return '⚠ ' + r.why;
      /* else: fall through to the address the plugin also holds */
    }
    let why = '';
    for (const raw of [spec.target, spec.fallback]) {
      if (!raw) continue;
      const url = tmpl(raw, spec, text, true).trim();
      if (!/^https:\/\//i.test(url)) { why = '“' + url + '” is not an https:// address'; continue; }
      try {
        const r = await Aevion.tools.run('open.url', { url });
        return '🔗 ' + String(r.output) + (spec.reply ? '\n' + fill(spec, text) : '');
      } catch (e) {
        why = (e && e.message) || 'the link was refused';
        if (e && e.code === 'permission') return '🔒 ' + why + ' Grant the Automation permission in Settings → Privacy and this plugin works.';
        if (e && e.code === 'confirm') return '⏳ ' + why + ' Approve it when the prompt appears and it opens.';
        if (e && e.code === 'disabled') return '⛔ ' + why;
        /* anything else (a bad address, a tool error) falls through to the
           fallback link, which is exactly what a fallback is for */
      }
    }
    return '⚠ Could not open that — ' + (why || 'no address is saved for this plugin') + '.';
  };

  /* What the test button asks before opening anything: with a made-up query
     in place of {query}, is this a link the app would really open? Same
     rules as open.url (https only, a real host), and nothing is opened —
     so a test can never become an accidental visit. */
  P.checkLink = function (spec, sample) {
    const sampleText = String(sample == null ? 'anything' : sample);
    for (const raw of [(spec && spec.target) || '', (spec && spec.fallback) || '']) {
      if (!raw) continue;
      const url = tmpl(raw, spec, sampleText, true).trim();
      if (!/^https:\/\//i.test(url)) return { ok: false, url, why: '“' + url + '” is not an https:// address' };
      try {
        const u = new URL(url);
        if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(u.hostname)) return { ok: false, url, why: '“' + u.hostname + '” is not a valid host name' };
      } catch { return { ok: false, url, why: 'that is not a valid address' }; }
      return { ok: true, url, why: '' };
    }
    return { ok: false, url: '', why: 'no address is saved for this plugin' };
  };

  /* Which brain a plugin would use, without asking it: the Plugins view can
     then say it out loud *before* anything is sent anywhere, and a test is
     only ever one press away. `auto` means the provider picked in Settings;
     a named provider is kept as itself even while it is not the default. */
  P.brainFor = function (spec) {
    const want = spec && spec.ai;
    if (!want) return null;
    const id = (want === true || want === 'auto')
      ? ((Aevion.settings && Aevion.settings.aiProvider) || '')
      : String(want);
    const a = Aevion.providers && Aevion.providers.get ? Aevion.providers.get(id) : null;
    return a ? { id, label: a.label, kind: a.kind } : null;
  };

  /* ---------- the optional AI pass ----------
     A plugin may ask a brain for a better answer, but only as an upgrade:
     the template always survives as the fallback. Every gate the rest of
     the app honours is honoured here too — the online switch, the
     auto-switch's view of reachability, and a missing key — because a
     plugin must never be a way to reach the network sideways. */
  P.askAI = async function (spec, text) {
    P.lastWhy = '';
    try {
      const want = spec && spec.ai;
      if (!want || !Aevion.providers || !Aevion.providers.get) { P.lastWhy = 'this plugin is not AI-backed'; return null; }
      const id = (want === true || want === 'auto')
        ? (Aevion.settings && Aevion.settings.aiProvider)
        : String(want);
      const a = Aevion.providers.get(id);
      if (!a) { P.lastWhy = 'there is no brain picked in Settings → Providers'; return null; }
      if (a.kind !== 'local') {
        // the two switches that say whether an *online* brain may be used
        if (Aevion.settings && !Aevion.settings.onlineAI) { P.lastWhy = 'online AI is switched off in Settings → Privacy'; return null; }
        if (Aevion.online && Aevion.online.available && !Aevion.online.available()) {
          P.lastWhy = (Aevion.online.status() || {}).why || 'the online brain is unreachable right now';
          return null;
        }
      }
      const miss = Aevion.providers.missing(id);
      if (miss.length) { P.lastWhy = ((a.label || id) + ' still needs ' + miss.join(', ')); return null; }
      const query = queryOf(spec, text);
      const sys = `You are “${spec.name || 'a plugin'}”, an extension of ${
        (Aevion.settings && Aevion.settings.name) || 'Aevion'}, a private assistant that runs on the user's own device. ` +
        `Answer the request briefly and helpfully, in the user's own language. ` +
        `Your saved reply is: «${spec.reply}» — treat it as the shape of a good answer, not as a script to repeat.`;
      const res = await Aevion.providers.chatWith(id, [
        { role: 'system', content: sys },
        { role: 'user', content: query || String(text || '') }
      ], {});
      // local providers answer with a bare string, HTTP ones with { text }
      const out = String((typeof res === 'string') ? res : (res && res.text) || '').trim();
      if (!out) P.lastWhy = 'the brain came back empty';
      return out || null;
    } catch (e) {
      /* One readable clause, not a truncated stack sentence: this string is
         shown in a toast and in the Plugins view, where “Failed to fetch.
         Check the endpoint and that the device is onl” helps nobody. */
      let why = String((e && e.message) || 'unknown error').replace(/\s+/g, ' ').trim();
      if (why.length > 110) why = why.slice(0, 110).replace(/\s+\S*$/, '') + ' …';
      P.lastWhy = 'the brain did not answer (' + why + ')';
      return null;   // any failure at all: the template answers
    }
  };

  /* The command map the chat pipeline reads. Every trigger a simple plugin
     owns points at the same handler, which receives the whole message (that
     is what {query} slices), and the user's own simple plugins win a
     collision with a file plugin — they were written for this device. */
  P.rebuild = function () {
    P.commands = Object.assign({}, P.file);
    for (const s of P.saved()) {
      const handler = async text => {
        /* A link or app plugin acts first: it is an action, not an answer. */
        if (s.target || s.app) return openSpec(s, text);
        let better = null;
        if (s.ai) {
          better = await P.askAI(s, text);
          if (!better) {
            try { Aevion.emit('plugins:ai-fallback', { name: s.name, why: P.lastWhy || 'no brain was reachable' }); } catch {}
          }
        }
        return (better ? '🧠 ' + better : '🧩 ' + fill(s, text));
      };
      for (const tr of s.triggers) P.commands[tr] = handler;
    }
    return P.commands;
  };

  P.addSimple = function (spec) {
    const name = String((spec && spec.name) || '').trim();
    const triggers = [].concat((spec && (spec.triggers || spec.trigger)) || [])
      .map(s => String(s).trim().toLowerCase()).filter(Boolean);
    const reply = String((spec && spec.reply) || '').trim();
    const target = String((spec && spec.target) || '').trim().slice(0, 300);
    const fallback = String((spec && spec.fallback) || '').trim().slice(0, 300);
    /* An Android package name, when the plugin is for a real installed app:
       “.(letter, digit, _)” only, so a stray sentence cannot end up being
       handed to the launcher as if it were a package. */
    const app = String((spec && spec.app) || '').trim().slice(0, 120);
    if (!name) return { error: 'A plugin needs a name.' };
    if (!triggers.length) return { error: 'A plugin needs at least one trigger word.' };
    if (!reply && !target && !app) return { error: 'A plugin needs a reply — or an https:// link to open.' };
    if (app && !/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)+$/.test(app)) {
      return { error: '“' + app + '” is not an Android package name (they look like com.example.app).' };
    }
    if (reply.length > 600) return { error: 'Keep the reply under 600 characters.' };
    /* Only https is ever opened (the same rule as the open.url tool), checked
       here too so a plugin cannot be *saved* holding something the app would
       refuse to run. */
    for (const t of [target, fallback]) {
      if (t && !/^https:\/\//i.test(t)) return { error: 'A link must start with https:// — ' + t + ' is not an https address.' };
    }

    /* `ai` is a small whitelist: "auto" follows the provider you picked,
       anything else has to name one the app actually knows. */
    let ai = '';
    const rawAi = spec && spec.ai;
    if (rawAi === true || rawAi === 'auto') ai = 'auto';
    else if (typeof rawAi === 'string' && rawAi.trim()) {
      const want = rawAi.trim();
      ai = (Aevion.providers && Aevion.providers.get && Aevion.providers.get(want)) ? want : 'auto';
    }

    const saved = P.saved().filter(s => s.name !== name);
    const plugin = {
      name: name.slice(0, 40),
      desc: String((spec && spec.desc) || 'Added by you').slice(0, 200),
      triggers: [...new Set(triggers)].slice(0, 8),
      reply,
      simple: true,
      t: Date.now()
    };
    if (ai) plugin.ai = ai;
    if (target) plugin.target = target;
    if (app) { plugin.app = app; plugin.appName = name; }
    if (fallback) plugin.fallback = fallback;
    saved.push(plugin);
    save(saved);
    P.rebuild();
    Aevion.emit('plugins:changed', { added: plugin.name, count: P.count() });
    return plugin;
  };

  P.remove = function (name) {
    const saved = P.saved();
    const next = saved.filter(s => s.name !== name);
    if (next.length === saved.length) return false;
    save(next);
    P.rebuild();
    Aevion.emit('plugins:changed', { removed: name, count: P.count() });
    return true;
  };

  P.get = name => P.saved().find(s => s.name === name) || P.list.find(p => p.name === name) || null;

  /* What the Plugins view renders: file plugins and simple plugins in
     one list, each knowing which kind it is. */
  P.describe = function () {
    const simples = P.saved().map(s => ({
      name: s.name, desc: s.desc || 'Added by you', kind: 'simple',
      triggers: s.triggers.slice(), reply: s.reply, ai: s.ai || '',
      target: s.target || '', fallback: s.fallback || '', app: s.app || ''
    }));
    const files = P.list.map(p => ({
      name: p.name || '(unnamed)', desc: p.desc || '', kind: 'file',
      commands: Object.keys(p.commands || {})
    }));
    return simples.concat(files);
  };

  P.count = () => P.saved().length + P.list.length;

  /* A trigger that collides with an existing one is worth warning
     about — the first match wins, so the loser looks broken. */
  P.collisions = function () {
    const seen = new Map();
    const out = [];
    P.describe().forEach(p => {
      const keys = p.triggers || p.commands || [];
      keys.forEach(k => {
        const key = String(k).toLowerCase();
        if (seen.has(key)) out.push({ trigger: key, owners: [seen.get(key), p.name] });
        else seen.set(key, p.name);
      });
    });
    return out;
  };

  Aevion.plugins = P;
  P.rebuild();
})();
