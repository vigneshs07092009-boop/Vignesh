/* ============================================================
 * Aevion Tools — every capability that *does* something goes here.
 *
 * A tool declares what it needs before it may run:
 *
 *   read       local, no side effects            → always allowed
 *   safe       local, reversible, user-asked     → always allowed
 *   sensitive  device data or the network        → needs its permission
 *   confirm    leaves the device / irreversible  → needs a fresh yes
 *
 * Nothing sensitive runs silently: `run()` refuses with a machine
 * readable code ('permission' | 'confirm' | 'disabled' | 'network')
 * and the caller must resolve it with the user first. Every attempt,
 * allowed or refused, is written to a local audit log.
 * ============================================================ */
(function () {
  const TIERS = {
    read: { level: 0, label: 'Read', desc: 'Local and read-only. No permission needed.' },
    safe: { level: 1, label: 'Safe action', desc: 'Changes something local that you asked for.' },
    sensitive: { level: 2, label: 'Sensitive', desc: 'Uses device data or the network. Needs its permission.' },
    confirm: { level: 3, label: 'Confirm', desc: 'Leaves the device or is irreversible — asks first, every time.' }
  };

  class ToolError extends Error {
    constructor(code, message, extra) {
      super(message);
      this.code = code;
      Object.assign(this, extra || {});
    }
  }

  const T = {
    TIERS,
    ToolError,
    list: [],
    register(spec) {
      if (!spec || !spec.id) throw new Error('a tool needs an id');
      if (!TIERS[spec.tier]) throw new Error(`tool "${spec.id}" has unknown tier "${spec.tier}"`);
      const i = this.list.findIndex(t => t.id === spec.id);
      if (i >= 0) this.list[i] = spec; else this.list.push(spec);
      return spec;
    },
    get(id) { return this.list.find(t => t.id === id) || null; },
    ids() { return this.list.map(t => t.id); },
    byTier(tier) { return this.list.filter(t => t.tier === tier); },

    /* --- user control --- */
    disabled() { return Aevion.store.get('toolsDisabled', []); },
    enabled(id) { return !this.disabled().includes(id); },
    setEnabled(id, on) {
      const off = this.disabled().filter(x => x !== id);
      if (!on) off.push(id);
      Aevion.store.set('toolsDisabled', off);
      Aevion.emit('tools:changed', { id, enabled: on });
    },

    /* What would happen if we tried to run this right now? */
    canRun(id) {
      const tool = this.get(id);
      if (!tool) return { ok: false, code: 'unknown', reason: `Unknown tool "${id}".` };
      if (!this.enabled(id)) return { ok: false, code: 'disabled', reason: `${tool.name} is switched off in Settings → Tools.` };

      const missing = (tool.perms || []).filter(p => !Aevion.perms.get(p));
      if (missing.length) {
        const labels = missing.map(p => (Aevion.perms.map[p] && Aevion.perms.map[p].label) || p);
        return {
          ok: false, code: 'permission', perm: missing[0],
          reason: `${tool.name} needs the ${labels.join(' + ')} permission — grant that one in Settings → Privacy, or turn on Device access there to grant them all at once.`
        };
      }
      if (tool.network && !Aevion.settings.onlineSearch) {
        return { ok: false, code: 'network', reason: `${tool.name} uses the internet — enable “Allow online search” in Settings first.` };
      }
      if (tool.tier === 'confirm') {
        return { ok: false, code: 'confirm', needsConfirm: true, reason: `${tool.name} needs your confirmation before it runs.` };
      }
      return { ok: true };
    },

    /* Run a tool. Throws a ToolError the UI can branch on.
       opts.confirm === true is the user's explicit yes for tier 'confirm'. */
    async run(id, args = {}, opts = {}) {
      const tool = this.get(id);
      const gate = this.canRun(id);
      const isConfirmation = gate.code === 'confirm' && opts.confirm === true;

      if (!gate.ok && !isConfirmation) {
        this.audit(id, false, gate.code);
        if (gate.needsConfirm) Aevion.emit('tool:confirm', { id, args, tool });
        throw new ToolError(gate.code, gate.reason, { perm: gate.perm, needsConfirm: gate.needsConfirm, tool });
      }

      const started = Date.now();
      try {
        const output = await tool.run(args || {}, opts);
        this.audit(id, true, 'ok', Date.now() - started);
        return { ok: true, id, output: typeof output === 'string' ? output : String(output == null ? '' : output) };
      } catch (e) {
        this.audit(id, false, e.code || 'failed', Date.now() - started);
        if (e instanceof ToolError) throw e;
        throw new ToolError('failed', e && e.message ? e.message : 'The tool failed.');
      }
    },

    /* Local audit trail — the user can see exactly what ran. */
    audit(id, ok, code, ms) {
      const log = Aevion.store.get('toolLog', []);
      log.push({ t: Date.now(), id, ok, code: code || 'ok', ms: ms || 0 });
      Aevion.store.set('toolLog', log.slice(-50));
    },
    log() { return Aevion.store.get('toolLog', []); },
    clearLog() { Aevion.store.set('toolLog', []); },

    describe() {
      return this.list.map(t => ({
        id: t.id, name: t.name, tier: t.tier, desc: t.desc,
        perms: t.perms || [], network: !!t.network, enabled: this.enabled(t.id),
        status: this.canRun(t.id).code
      }));
    },

    /* ---------- the automation report ----------
       Everything Aevion is allowed to do, everything it is not, and
       everything it has actually done — in one structured answer, so
       the UI (and the brain, via system.report) can be specific instead
       of reassuring. Nothing here is inferred: it all comes from the
       same tables the gate itself reads. */
    report() {
      const tools = this.describe();
      const log = this.log();
      const granted = Aevion.perms.granted();
      const missing = Aevion.perms.missing();
      const tiers = {};
      for (const t of tools) tiers[t.tier] = (tiers[t.tier] || 0) + 1;
      const ok = log.filter(e => e.ok).length;
      const refused = log.filter(e => !e.ok).length;
      const byCode = {};
      for (const e of log) byCode[e.code] = (byCode[e.code] || 0) + 1;

      return {
        version: Aevion.version,
        generated: Date.now(),
        mode: {
          ai: Aevion.settings.onlineAI ? 'online AI allowed' : 'local only',
          provider: Aevion.settings.aiProvider,
          search: !!Aevion.settings.onlineSearch
        },
        tiers,
        tools,
        off: tools.filter(t => !t.enabled).map(t => t.id),
        blocked: tools.filter(t => t.status === 'permission' || t.status === 'network')
          .map(t => ({ id: t.id, why: t.status })),
        alwaysAsks: tools.filter(t => t.tier === 'confirm').map(t => t.id),
        permissions: {
          granted, missing,
          shellOnly: Aevion.perms.SHELL_ONLY.slice(),
          inShell: Aevion.perms.shell()
        },
        automations: (Aevion.store.get('autos', []) || []).map(a => ({ when: a.when, what: a.what })),
        timers: this.timers.active().map(t => ({ label: t.label, endsInSec: Math.round((t.end - Date.now()) / 1000) })),
        selfUpgrade: !!(Aevion.evolve && Aevion.evolve.enabled()),
        activity: { total: log.length, ok, refused, byCode, recent: log.slice(-20).reverse() }
      };
    }
  };

  /* ================= timers =================
     A timer is the one thing that has to keep working while the user is
     doing something else. The deadline is stored on this device (so the
     list survives a reload) and the wake-up is a plain setTimeout: a
     hidden tab still fires it, and if the platform throttled it, the app
     calls rearm() the moment it is visible again and overdue timers fire
     then — late is reported honestly, never silently dropped. */
  const handles = new Map();

  const timerList = () => Aevion.store.get('timers', []) || [];
  function saveTimers(list) {
    Aevion.store.set('timers', list);
    Aevion.emit('timer:changed', { timers: list.slice() });
  }
  function humanTime(sec) {
    const s = Math.max(0, Math.round(sec));
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    return m + 'm' + (s % 60 ? ' ' + (s % 60) + 's' : '');
  }
  function fire(t) {
    handles.delete(t.id);
    saveTimers(timerList().filter(x => x.id !== t.id));
    const late = Math.max(0, Math.round((Date.now() - t.end) / 1000));
    Aevion.emit('timer:done', { id: t.id, label: t.label, seconds: t.seconds, late });
    if (Aevion.perms.get('notifications') && typeof Notification !== 'undefined') {
      try {
        const n = new Notification('⏰ ' + (t.label || 'Timer finished'), {
          body: humanTime(t.seconds) + ' is up' + (late > 5 ? ' (' + humanTime(late) + ' late — the device was asleep)' : '')
        });
        setTimeout(() => { try { n.close(); } catch { /* already gone */ } }, 15000);
      } catch { /* notifications are optional */ }
    }
  }

  T.timers = {
    active() { const n = Date.now(); return timerList().filter(t => t.end > n); },
    overdue() { const n = Date.now(); return timerList().filter(t => t.end <= n); },

    add(seconds, label) {
      const s = Math.round(Number(seconds));
      if (!Number.isFinite(s) || s <= 0 || s > 86400) return null;
      const t = {
        id: Aevion.randomId(), end: Date.now() + s * 1000, seconds: s,
        label: String(label == null ? '' : label).slice(0, 80), set: Date.now()
      };
      const list = timerList();
      list.push(t);
      saveTimers(list);
      T.timers.arm(t);
      return t;
    },

    arm(t) {
      if (handles.has(t.id)) return;
      const wait = Math.max(0, t.end - Date.now());
      handles.set(t.id, setTimeout(() => fire(t), Math.min(wait, 2147000000)));
    },

    cancel(id) {
      const list = timerList();
      const t = list.find(x => x.id === id);
      if (!t) return null;
      const h = handles.get(id);
      if (h) { clearTimeout(h); handles.delete(id); }
      saveTimers(list.filter(x => x.id !== id));
      return t;
    },

    clear() {
      const list = timerList();
      list.forEach(t => { const h = handles.get(t.id); if (h) clearTimeout(h); });
      handles.clear();
      saveTimers([]);
      return list.length;
    },

    /* Called at boot and whenever the app comes back to the foreground:
       re-arm what is still in the future, fire what came due while we
       were away. */
    rearm() {
      let fired = 0;
      for (const t of T.timers.overdue()) { fire(t); fired++; }
      for (const t of T.timers.active()) T.timers.arm(t);
      return fired;
    },

    text(list) {
      const l = list || T.timers.active();
      if (!l.length) return 'No timers are running.';
      return l.map(t => '⏱ ' + humanTime(Math.round((t.end - Date.now()) / 1000)) + ' left' + (t.label ? ' — ' + t.label : '')).join('\n');
    }
  };

  /* ================= built-in tools ================= */

  T.register({
    id: 'time', name: 'Current time', tier: 'read', category: 'basics',
    desc: 'Reads the device clock. Never leaves the device.',
    run: () => '🕒 ' + new Date().toLocaleTimeString()
  });

  T.register({
    id: 'date', name: 'Current date', tier: 'read', category: 'basics',
    desc: 'Today’s date, formatted for the device locale.',
    run: () => '📅 ' + new Date().toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
  });

  T.register({
    id: 'calc', name: 'Calculator', tier: 'read', category: 'basics',
    desc: 'Evaluates a numeric expression locally (+ - * / ^ % and parentheses).',
    params: { expression: 'e.g. (45*12)+9/3' },
    run: ({ expression }) => Aevion.skills.math(expression || '')
  });

  T.register({
    id: 'memory.search', name: 'Search memory', tier: 'read', category: 'memory',
    desc: 'Scored lookup across the memory layers.',
    params: { query: 'what to look for' },
    run: ({ query }) => {
      const hits = Aevion.memory.recall(query || '', { limit: 8 });
      return hits.length ? hits.map(h => `• [${h.layer}] ${h.text}`).join('\n') : 'Nothing in memory matches that.';
    }
  });

  T.register({
    id: 'memory.add', name: 'Remember a fact', tier: 'safe', category: 'memory',
    desc: 'Stores a fact in saved memory. Only run when you ask.',
    params: { text: 'the fact' },
    run: ({ text }) => {
      const saved = Aevion.memory.add(text, 'fact', 'longterm');
      return saved ? `Saved locally: “${saved}”` : 'I already had that one.';
    }
  });

  T.register({
    id: 'memory.stats', name: 'Memory report', tier: 'read', category: 'memory',
    desc: 'Counts per memory layer, and how many preferences await approval.',
    run: () => {
      const s = Aevion.memory.stats();
      const lines = Aevion.memory.layerNames().map(l => `• ${Aevion.memory.LAYERS[l].label}: ${s[l].count}/${s[l].cap}${l === 'prefs' ? ` (${s.prefs.approved} approved)` : ''}`);
      const pend = Aevion.memory.pending().length;
      if (pend) lines.push(`\n⚠ ${pend} noticed preference(s) waiting for your approval.`);
      return lines.join('\n');
    }
  });

  T.register({
    id: 'memory.forget', name: 'Forget a memory', tier: 'confirm', category: 'memory',
    desc: 'Deletes one stored fact by id. Irreversible.',
    params: { id: 'memory id' },
    run: ({ id }) => { Aevion.memory.remove(id, 'longterm'); return 'Forgotten.'; }
  });

  T.register({
    id: 'notes.add', name: 'Save a note', tier: 'safe', category: 'organizer',
    desc: 'Adds a timestamped note to Organizer.',
    params: { text: 'note text' },
    run: ({ text }) => {
      const t = String(text || '').trim();
      if (!t) throw new ToolError('failed', 'Nothing to save.');
      const notes = Aevion.store.get('notes', []);
      notes.unshift({ label: new Date().toLocaleString() + ' — ' + t, t: Date.now() });
      Aevion.store.set('notes', notes);
      Aevion.emit('data:changed', { what: 'notes' });
      return '📝 Note saved locally.';
    }
  });

  T.register({
    id: 'notes.list', name: 'List notes', tier: 'read', category: 'organizer',
    desc: 'Shows your saved notes.',
    run: () => {
      const notes = Aevion.store.get('notes', []);
      if (!notes.length) return 'No notes yet.';
      return notes.slice(0, 20).map(n => '• ' + (n.label || n.text)).join('\n');
    }
  });

  T.register({
    id: 'tasks.add', name: 'Add a task', tier: 'safe', category: 'organizer',
    desc: 'Adds a task to Organizer, optionally with a due date.',
    params: { text: 'task', due: 'YYYY-MM-DD (optional)' },
    run: ({ text, due }) => {
      const t = String(text || '').trim();
      if (!t) throw new ToolError('failed', 'What should the task be?');
      const tasks = Aevion.store.get('tasks', []);
      tasks.push({ label: t, due: due || '', done: false, t: Date.now() });
      Aevion.store.set('tasks', tasks);
      Aevion.emit('data:changed', { what: 'tasks' });
      return `✅ Task added${due ? ' (due ' + due + ')' : ''}.`;
    }
  });

  T.register({
    id: 'tasks.list', name: 'List tasks', tier: 'read', category: 'organizer',
    desc: 'Shows open tasks and their due dates.',
    run: () => {
      const tasks = Aevion.store.get('tasks', []);
      if (!tasks.length) return 'No tasks yet.';
      return tasks.map(t => `${t.done ? '✔' : '○'} ${t.label}${t.due ? ' — due ' + t.due : ''}`).join('\n');
    }
  });

  T.register({
    id: 'tasks.done', name: 'Complete a task', tier: 'safe', category: 'organizer',
    desc: 'Toggles the done state of a task by index (1-based, as listed).',
    params: { index: '1' },
    run: ({ index }) => {
      const tasks = Aevion.store.get('tasks', []);
      const i = parseInt(index, 10) - 1;
      if (!tasks[i]) throw new ToolError('failed', 'No task at that position.');
      tasks[i].done = !tasks[i].done;
      Aevion.store.set('tasks', tasks);
      Aevion.emit('data:changed', { what: 'tasks' });
      return `${tasks[i].done ? '✔ Done' : '○ Reopened'}: ${tasks[i].label}`;
    }
  });

  T.register({
    id: 'files.list', name: 'List vault files', tier: 'read', category: 'files',
    desc: 'Lists filenames in the local vault. Contents are never read out.',
    run: () => {
      const files = Aevion.store.get('files', []);
      if (!files.length) return 'The vault is empty.';
      return files.map(f => `• ${f.name} (${(f.size / 1024).toFixed(1)} KB)`).join('\n');
    }
  });

  T.register({
    id: 'code.explain', name: 'Explain code', tier: 'read', category: 'coding',
    desc: 'Local structural analysis of a code snippet — language, shape, hotspots.',
    params: { code: 'the snippet' },
    run: ({ code }) => Aevion.skills.explainCode(code || '')
  });

  T.register({
    id: 'code.detect', name: 'Detect language', tier: 'read', category: 'coding',
    desc: 'Identifies the language of a snippet from its syntax.',
    params: { code: 'the snippet' },
    run: ({ code }) => Aevion.skills.detectLanguage(code || '')
  });

  T.register({
    id: 'summarize', name: 'Summarize text', tier: 'read', category: 'study',
    desc: 'Offline extractive summary — your text never leaves the device.',
    params: { text: 'the text', mode: 'short | medium | long' },
    run: ({ text, mode }) => {
      if (!String(text || '').trim()) throw new ToolError('failed', 'Nothing to summarize.');
      return Aevion.skills.summarize(text, mode || 'medium');
    }
  });

  T.register({
    id: 'system.status', name: 'System status', tier: 'read', category: 'system',
    desc: 'Aevion version, active AI provider, memory and storage usage.',
    run: () => {
      const s = Aevion.settings;
      const active = Aevion.providers.get(s.aiProvider);
      const missing = Aevion.providers.missing(s.aiProvider);
      const stats = Aevion.memory.stats();
      let bytes = 0;
      try { for (const k of Aevion.store.keys()) bytes += (Aevion.store.get(k) ? JSON.stringify(Aevion.store.get(k)).length : 0); } catch {}
      return [
        `Aevion ${Aevion.version}`,
        `AI: ${active ? active.label : 'none'}${s.onlineAI ? '' : ' (online AI off)'}${missing.length ? ' — needs ' + missing.join(', ') : ''}`,
        `Internet features: ${s.onlineSearch ? 'enabled' : 'disabled'}`,
        `Memory: ${stats.longterm.count} saved facts, ${stats.prefs.pending || Aevion.memory.pending().length} awaiting approval`,
        `Local storage in use: ~${(bytes / 1024).toFixed(1)} KB`,
        `Voice: ${Aevion.voice.supported ? (Aevion.voice.native ? 'native (Android)' : 'browser') : 'unavailable'} · speak replies: ${s.speak ? 'on' : 'off'}`
      ].join('\n');
    }
  });

  T.register({
    id: 'weather', name: 'Weather', tier: 'sensitive', category: 'web', network: true,
    perms: ['geolocation'],
    desc: 'Current conditions for your location, via open-meteo (no API key, no account).',
    run: async () => {
      const pos = await new Promise((res, rej) => navigator.geolocation.getCurrentPosition(res, rej, { timeout: 8000 }));
      const { latitude: la, longitude: lo } = pos.coords;
      const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${la}&longitude=${lo}&current=temperature_2m,wind_speed_10m,weather_code`);
      const j = await r.json();
      const c = j.current || {};
      const desc = {
        0: 'clear sky', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'freezing fog',
        51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle', 61: 'light rain', 63: 'rain', 65: 'heavy rain',
        71: 'light snow', 73: 'snow', 75: 'heavy snow', 80: 'showers', 81: 'showers', 82: 'violent showers',
        95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'severe thunderstorm'
      }[c.weather_code] || ('conditions ' + c.weather_code);
      return `🌤 ${c.temperature_2m}°C, ${desc}, wind ${c.wind_speed_10m} km/h — open-meteo.com`;
    }
  });

  T.register({
    id: 'web.search', name: 'Web search', tier: 'confirm', category: 'web', network: true,
    desc: 'Opens a search for your query in the system browser. The engine sees the query.',
    params: { query: 'search terms' },
    run: ({ query }) => {
      const q = String(query || '').trim();
      if (!q) throw new ToolError('failed', 'What should I search for?');
      const engines = {
        ddg: 'https://duckduckgo.com/?q=',
        google: 'https://www.google.com/search?q=',
        bing: 'https://www.bing.com/search?q='
      };
      const engine = engines[Aevion.store.get('searchEngine', 'ddg')] || engines.ddg;
      const url = engine + encodeURIComponent(q);
      /* Remembered, so the site you just searched on can be plugged in as a
         plugin with one tap — this is the only “what did I use” a browser
         lets Aevion know, because Aevion is the one doing the opening. */
      if (Aevion.apps) Aevion.apps.note({ url, name: (Aevion.store.get('searchEngine', 'ddg') || '').toUpperCase() || 'Search', query: q });
      window.open(url, '_blank', 'noopener');
      return `🔎 Opened a search for “${q}” in your browser.`;
    }
  });

  T.register({
    id: 'open.url', name: 'Open a link', tier: 'confirm', category: 'web',
    perms: ['automation'],
    desc: 'Opens an https link in the system browser.',
    params: { url: 'https://…' },
    run: ({ url }) => {
      const raw = String(url || '').trim().replace(/\s+/g, '');
      if (!raw) throw new ToolError('failed', 'No address given.');

      // An explicit scheme is only ever allowed to be https. Anything else
      // (javascript:, data:, file:, http:) is refused outright rather than
      // rewritten into something that looks harmless.
      const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(raw);
      if (scheme && scheme[1].toLowerCase() !== 'https') {
        throw new ToolError('failed', `Only https links can be opened — refused a ${scheme[1].toLowerCase()}: address.`);
      }
      const full = scheme ? raw : 'https://' + raw;

      let host;
      try { host = new URL(full).hostname; }
      catch { throw new ToolError('failed', 'That does not look like a valid address.'); }
      if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(host)) {
        throw new ToolError('failed', `“${host}” is not a valid host name.`);
      }

      if (Aevion.apps) Aevion.apps.note({ url: full });
      window.open(full, '_blank', 'noopener');
      return `Opened ${full} in your browser.`;
    }
  });

  T.register({
    id: 'translate', name: 'Translate', tier: 'sensitive', category: 'web', network: true,
    desc: 'Translates via your browser’s online service. The text is sent to that service.',
    params: { text: 'text', to: 'language code, e.g. ta' },
    run: ({ text, to }) => Aevion.skills.translate(`translate ${text} to ${to}`)
  });

  T.register({
    id: 'clipboard.copy', name: 'Copy to clipboard', tier: 'sensitive', category: 'device',
    perms: ['clipboardWrite'],
    desc: 'Copies text to the device clipboard.',
    params: { text: 'text' },
    run: async ({ text }) => {
      await navigator.clipboard.writeText(String(text || ''));
      return '📋 Copied.';
    }
  });

  T.register({
    id: 'device.access', name: 'What Aevion may use here', tier: 'read', category: 'device',
    desc: 'Lists every device capability, what is allowed, what is refused and what this device cannot do at all. Reads nothing itself.',
    run: () => {
      const line = k => {
        const label = (Aevion.perms.map[k] && Aevion.perms.map[k].label) || k;
        const after = Aevion.perms.get(k) ? 'allowed' : 'not allowed';
        return '• ' + label + ' — ' + after;
      };
      const here = Aevion.perms.DEVICE.map(line);
      const shell = Aevion.perms.SHELL_ONLY.map(k => '• ' + ((Aevion.perms.map[k] && Aevion.perms.map[k].label) || k) +
        (Aevion.perms.shell() ? ' — ' + (Aevion.perms.get(k) ? 'allowed' : 'not allowed') : ' — needs the Aevion app'));
      return '📱 On this device:\n' + here.join('\n') +
        '\n\nOnly in the Aevion app:\n' + shell.join('\n') +
        '\n\nAllowing a capability only unlocks the tools that use it. Anything irreversible still asks you first, every single time.';
    }
  });

  T.register({
    id: 'device.notify', name: 'Notify me', tier: 'sensitive', category: 'device',
    perms: ['notifications'],
    desc: 'Shows a notification on this device.',
    params: { title: 'title', text: 'body' },
    run: ({ title, text }) => {
      const body = String(text || '').trim();
      if (!body) throw new ToolError('failed', 'Nothing to notify about — give it some text.');
      const n = new Notification(String(title || 'Aevion'), { body: body.slice(0, 200) });
      setTimeout(() => { try { n.close(); } catch { /* already gone */ } }, 12000);
      return '🔔 Notified: ' + body.slice(0, 80);
    }
  });

  T.register({
    id: 'device.location', name: 'Where am I', tier: 'sensitive', category: 'device',
    perms: ['geolocation'],
    desc: 'Reads the device position once. Stays on this device unless you ask for something online.',
    run: async () => {
      if (!navigator.geolocation) throw new ToolError('failed', 'This device has no location service.');
      const pos = await new Promise((res, rej) => {
        navigator.geolocation.getCurrentPosition(res, () => rej(new ToolError('failed', 'The device refused to give a position.')), { timeout: 8000 });
      });
      const c = pos.coords || {};
      const acc = c.accuracy ? ' (±' + Math.round(c.accuracy) + ' m)' : '';
      return '📍 ' + c.latitude.toFixed(4) + ', ' + c.longitude.toFixed(4) + acc;
    }
  });

  T.register({
    id: 'speak', name: 'Speak aloud', tier: 'safe', category: 'device',
    desc: 'Reads text out loud with the device voice.',
    params: { text: 'text' },
    run: ({ text }) => {
      const clean = Aevion.md ? Aevion.md.toPlain(String(text || '')) : String(text || '');
      const wasOn = Aevion.settings.speak;
      Aevion.settings.speak = true;                 // explicit user request to speak
      Aevion.voice.speak(clean);
      Aevion.settings.speak = wasOn;
      return Aevion.voice.ttsSupported ? '🔊 Speaking.' : 'No text-to-speech engine is available on this device.';
    }
  });

  T.register({
    id: 'provider.test', name: 'Test the AI connection', tier: 'sensitive', category: 'system', network: true,
    desc: 'Sends one tiny prompt to the configured provider and reports the real result.',
    run: async () => {
      const id = Aevion.settings.aiProvider;
      const r = await Aevion.providers.test(id);
      return `✅ ${Aevion.providers.get(id).label} answered in ${r.ms} ms: “${r.reply}”`;
    }
  });

  T.register({
    id: 'data.export', name: 'Export my data', tier: 'confirm', category: 'system',
    desc: 'Builds a JSON backup of everything Aevion stores locally (never your API keys).',
    run: () => {
      const safe = Aevion.store.dumpSafe();
      const blob = new Blob([JSON.stringify({ app: 'aevion', v: Aevion.version, exported: new Date().toISOString(), data: safe }, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'aevion-backup-' + Date.now() + '.json';
      a.click();
      return '📦 Backup written to your downloads folder. API keys are deliberately excluded.';
    }
  });

  /* ================= timers ================= */

  T.register({
    id: 'timer.start', name: 'Set a timer', tier: 'safe', category: 'device',
    desc: 'Rings after the given time, even while you are using other apps. The deadline is kept on this device.',
    params: { minutes: '5', seconds: '0', label: 'optional name' },
    run: ({ minutes, seconds, label }) => {
      const sec = (Number(seconds) || 0) + (Number(minutes) || 0) * 60;
      const t = T.timers.add(sec, label);
      if (!t) throw new ToolError('failed', 'A timer needs a length between 1 second and 24 hours.');
      return '⏱ Timer set for ' + humanTime(t.seconds) + (t.label ? ' — ' + t.label : '') + '. It will ring even if you switch away.';
    }
  });

  T.register({
    id: 'timer.list', name: 'List timers', tier: 'read', category: 'device',
    desc: 'Shows every timer still counting down and how long is left.',
    run: () => T.timers.text()
  });

  T.register({
    id: 'timer.clear', name: 'Cancel all timers', tier: 'safe', category: 'device',
    desc: 'Stops every running timer. Asked for, immediate, and you can always set them again.',
    run: () => {
      const n = T.timers.clear();
      return n ? 'Cancelled ' + n + ' timer' + (n === 1 ? '' : 's') + '.' : 'No timers were running.';
    }
  });

  /* ================= the best place to do a thing =================
     A small, hand-picked directory answering "which app or site is
     best for this topic?". It is local data, not a search: the answer
     works with no network at all, names the pick, and says why. Reaching
     it is still tier 'confirm' — a permission lets Aevion *find* the
     place, never leave the device quietly. */
  const SITES = [
    { id: 'youtube', name: 'YouTube', url: 'https://www.youtube.com', kind: 'app', why: 'the largest video library, with auto-captions', words: ['video', 'watch', 'movie', 'film', 'tutorial video', 'music video', 'song', 'lecture'] },
    { id: 'meet', name: 'Google Meet', url: 'https://meet.google.com', kind: 'app', why: 'free group video calls with no install', words: ['video call', 'meeting', 'call', 'conference', 'online class'] },
    { id: 'spotify', name: 'Spotify', url: 'https://open.spotify.com', kind: 'app', why: 'playlists, podcasts and offline downloads', words: ['music', 'podcast', 'playlist', 'audio', 'songs'] },
    { id: 'maps', name: 'Google Maps', url: 'https://maps.google.com', kind: 'app', why: 'turn-by-turn directions and live traffic', words: ['maps', 'map', 'direction', 'route', 'navigate', 'travel', 'nearby', 'distance'] },
    { id: 'gmail', name: 'Gmail', url: 'https://mail.google.com', kind: 'app', why: 'the mail client most people already have', words: ['mail', 'email', 'inbox', 'message'] },
    { id: 'docs', name: 'Google Docs', url: 'https://docs.google.com', kind: 'app', why: 'free collaborative word processing', words: ['document', 'doc', 'write', 'essay', 'report', 'word', 'letter'] },
    { id: 'sheets', name: 'Google Sheets', url: 'https://sheets.google.com', kind: 'app', why: 'spreadsheets you can share and edit together', words: ['spreadsheet', 'sheet', 'table', 'excel', 'budget', 'data entry'] },
    { id: 'drive', name: 'Google Drive', url: 'https://drive.google.com', kind: 'app', why: '15 GB free and searchable from anywhere', words: ['storage', 'drive', 'cloud', 'backup', 'upload', 'share file'] },
    { id: 'keep', name: 'Google Keep', url: 'https://keep.google.com', kind: 'app', why: 'quick notes with reminders', words: ['notes app', 'notepad', 'todo app', 'checklist'] },
    { id: 'calendar', name: 'Google Calendar', url: 'https://calendar.google.com', kind: 'app', why: 'shared calendars and reminders', words: ['calendar', 'schedule', 'appointment', 'event', 'plan week'] },
    { id: 'github', name: 'GitHub', url: 'https://github.com', kind: 'site', why: 'the default home for code and issues', words: ['code', 'git', 'repository', 'repo', 'programming', 'open source', 'pull request'] },
    { id: 'stackoverflow', name: 'Stack Overflow', url: 'https://stackoverflow.com', kind: 'site', why: 'answers to concrete programming questions', words: ['error', 'bug', 'exception', 'stack trace', 'debug'] },
    { id: 'mdn', name: 'MDN Web Docs', url: 'https://developer.mozilla.org', kind: 'site', why: 'the reference for anything web', words: ['html', 'css', 'javascript', 'web api', 'browser api'] },
    /* Ruflo is an agent harness, not an assistant: you run it yourself (npx)
       and it points agent swarms at coding tools over MCP. It is in this
       directory — and deliberately not in the provider list — because a
       directory entry means “Aevion knows the place and will open it for
       you”, while a provider would promise a chat endpoint Ruflo does not
       serve. */
    { id: 'ruflo', name: 'Ruflo', url: 'https://github.com/ruvnet/ruflo', kind: 'site', why: 'an open-source multi-agent orchestration harness you run yourself (formerly Claude Flow)', words: ['ai agent', 'ai agents', 'agent swarm', 'multi agent', 'agentic', 'agent orchestration', 'orchestration', 'claude flow', 'ruflo', 'swarm'] },
    { id: 'khan', name: 'Khan Academy', url: 'https://www.khanacademy.org', kind: 'site', why: 'free structured maths and science lessons', words: ['learn', 'study', 'school', 'maths practice', 'science', 'exam prep'] },
    { id: 'coursera', name: 'Coursera', url: 'https://www.coursera.org', kind: 'site', why: 'university courses you can audit free', words: ['course', 'certificate', 'university', 'degree', 'specialization'] },
    { id: 'wikipedia', name: 'Wikipedia', url: 'https://wikipedia.org', kind: 'site', why: 'a sourced starting point for any topic', words: ['what is', 'definition', 'encyclopedia', 'history', 'biography', 'meaning'] },
    { id: 'dictionary', name: 'Cambridge Dictionary', url: 'https://dictionary.cambridge.org', kind: 'site', why: 'clear definitions with example sentences', words: ['dictionary', 'meaning of word', 'synonym', 'antonym', 'pronounce'] },
    { id: 'translate', name: 'Google Translate', url: 'https://translate.google.com', kind: 'site', why: 'fast text, voice and document translation', words: ['translate', 'translation', 'language'] },
    { id: 'wolfram', name: 'Wolfram Alpha', url: 'https://www.wolframalpha.com', kind: 'site', why: 'solves equations and plots them', words: ['equation', 'calculus', 'algebra', 'integral', 'derivative', 'solve for'] },
    { id: 'desmos', name: 'Desmos', url: 'https://www.desmos.com/calculator', kind: 'site', why: 'a free graphing calculator', words: ['graph', 'plot', 'function'] },
    { id: 'arxiv', name: 'arXiv', url: 'https://arxiv.org', kind: 'site', why: 'open preprints in physics, maths and CS', words: ['research', 'paper', 'preprint', 'thesis', 'journal'] },
    { id: 'amazon', name: 'Amazon', url: 'https://www.amazon.in', kind: 'app', why: 'widest catalogue with buyer protection', words: ['buy', 'shop', 'shopping', 'product', 'order', 'price'] },
    { id: 'swiggy', name: 'Swiggy', url: 'https://www.swiggy.com', kind: 'app', why: 'fast food delivery with live tracking', words: ['food', 'order food', 'restaurant', 'delivery', 'hungry'] },
    { id: 'uber', name: 'Uber', url: 'https://m.uber.com', kind: 'app', why: 'cabs with upfront pricing', words: ['cab', 'taxi', 'ride', 'auto', 'travel booking'] },
    { id: 'irctc', name: 'IRCTC', url: 'https://www.irctc.co.in', kind: 'site', why: 'the official Indian Railways booking site', words: ['train', 'railway', 'ticket', 'rail'] },
    { id: 'flights', name: 'Google Flights', url: 'https://www.google.com/travel/flights', kind: 'site', why: 'compares every airline and can watch prices', words: ['flight', 'airline', 'air ticket', 'airport', 'holiday booking'] },
    { id: 'booking', name: 'Booking.com', url: 'https://www.booking.com', kind: 'site', why: 'free cancellation on most rooms', words: ['hotel', 'stay', 'room', 'accommodation', 'hostel'] },
    { id: 'linkedin', name: 'LinkedIn', url: 'https://www.linkedin.com', kind: 'app', why: 'where jobs and recruiters actually are', words: ['job', 'career', 'resume', 'cv', 'hire', 'internship', 'interview'] },
    { id: 'news', name: 'Google News', url: 'https://news.google.com', kind: 'site', why: 'many sources for the same story', words: ['news', 'headline', 'current affairs', 'what happened'] },
    { id: 'weather', name: 'Weather.com', url: 'https://weather.com', kind: 'site', why: 'an hourly forecast and radar', words: ['weather', 'forecast', 'rain', 'temperature', 'humidity'] },
    { id: 'unsplash', name: 'Unsplash', url: 'https://unsplash.com', kind: 'site', why: 'free photos you may reuse', words: ['image', 'photo', 'picture', 'wallpaper', 'stock photo'] },
    { id: 'canva', name: 'Canva', url: 'https://www.canva.com', kind: 'app', why: 'templates for posters, slides and logos', words: ['design', 'poster', 'logo', 'presentation', 'slide', 'invitation'] },
    { id: 'ilovepdf', name: 'iLovePDF', url: 'https://www.ilovepdf.com', kind: 'site', why: 'merges, splits and compresses PDFs in the browser', words: ['pdf', 'merge pdf', 'compress', 'convert pdf', 'scan'] },
    { id: 'gutenberg', name: 'Project Gutenberg', url: 'https://www.gutenberg.org', kind: 'site', why: '70,000+ free public-domain books', words: ['book', 'novel', 'read online', 'ebook', 'literature'] },
    { id: 'allrecipes', name: 'Allrecipes', url: 'https://www.allrecipes.com', kind: 'site', why: 'recipes reviewed by people who cooked them', words: ['recipe', 'cook', 'cooking', 'bake', 'ingredients'] },
    { id: 'ankidroid', name: 'AnkiWeb', url: 'https://ankiweb.net', kind: 'site', why: 'spaced-repetition flashcards that really work', words: ['flashcard', 'spaced repetition', 'memorize', 'revision'] },
    { id: 'playstore', name: 'Google Play', url: 'https://play.google.com', kind: 'app', why: 'the only app store this device trusts', words: ['app', 'install app', 'android app', 'download app'] },
    { id: 'whatsapp', name: 'WhatsApp Web', url: 'https://web.whatsapp.com', kind: 'app', why: 'your chats on a bigger screen', words: ['whatsapp', 'chat app', 'message friend', 'text someone'] },
    { id: 'gov', name: 'india.gov.in', url: 'https://www.india.gov.in', kind: 'site', why: 'the official index of Indian government services', words: ['government', 'aadhaar', 'pan card', 'passport', 'tax', 'scheme', 'certificate'] }
  ];

  /* Picks the best entry for a topic by counting which entry's words the
     topic actually contains. Ties go to the earlier (more general) entry,
     and a topic nothing matches returns null rather than a guess. */
  T.bestSite = function (topic) {
    const t = String(topic == null ? '' : topic).toLowerCase().replace(/[^\p{L}\p{N}+ ]+/gu, ' ').replace(/\s+/g, ' ').trim();
    if (!t) return null;
    let best = null;
    for (const s of SITES) {
      let score = 0;
      for (const w of s.words) if (t.includes(w)) score += w.split(' ').length + (w.length / 20);
      if (score > 0 && (!best || score > best.score)) best = { score, site: s };
    }
    return best ? Object.assign({ score: best.score }, best.site) : null;
  };
  T.SITES = SITES;

  T.register({
    id: 'web.best', name: 'Best app or site for a topic', tier: 'confirm', category: 'web', network: true,
    perms: ['open_apps'],
    desc: 'Looks up the best-known app or website for a topic in Aevion’s own local directory, then — only with your yes — opens it.',
    params: { topic: 'e.g. learn python for free' },
    run: ({ topic, open }) => {
      const pick = T.bestSite(topic);
      if (!pick) {
        throw new ToolError('failed', 'Nothing in my local directory matches “' + String(topic || '').trim() + '”. Try a plainer topic, or ask me to search instead.');
      }
      const line = '🧭 ' + pick.name + ' (' + pick.kind + ') — ' + pick.why + '\n' + pick.url;
      if (open === false) return line + '\n(Not opened — you asked for the recommendation only.)';
      if (Aevion.apps) Aevion.apps.note({ url: pick.url, name: pick.name });
      window.open(pick.url, '_blank', 'noopener');
      return line + '\nOpening it now.';
    }
  });

  /* ================= the automation report ================= */

  T.register({
    id: 'system.report', name: 'Automation & activity report', tier: 'read', category: 'system',
    desc: 'One page: what Aevion may use, what is switched off, what always asks, what ran and what was refused.',
    run: () => {
      const r = T.report();
      const lines = [
        '⚙ Aevion ' + r.version + ' — automation report',
        'Mode: ' + r.mode.ai + ' · provider: ' + r.mode.provider + ' · internet: ' + (r.mode.search ? 'allowed' : 'off'),
        '',
        'Tools by tier:',
        ...Object.keys(T.TIERS).map(k => '  • ' + T.TIERS[k].label + ': ' + (r.tiers[k] || 0)),
        '  • always asks first: ' + (r.alwaysAsks.length ? r.alwaysAsks.join(', ') : 'nothing'),
        r.off.length ? '  • switched off by you: ' + r.off.join(', ') : '  • nothing is switched off',
        r.blocked.length ? '  • waiting on a permission: ' + r.blocked.map(b => b.id + ' (' + b.why + ')').join(', ') : '  • nothing is blocked by a missing permission',
        '',
        'Permissions:',
        '  • allowed: ' + (r.permissions.granted.length ? r.permissions.granted.join(', ') : 'nothing'),
        '  • not allowed: ' + (r.permissions.missing.length ? r.permissions.missing.join(', ') : 'everything that can be asked'),
        '  • app-only: ' + r.permissions.shellOnly.join(', ') + (r.permissions.inShell ? ' (available here)' : ' (needs the Aevion app)'),
        '',
        'Activity (last ' + r.activity.total + ' attempts): ' + r.activity.ok + ' ran, ' + r.activity.refused + ' refused',
        ...Object.entries(r.activity.byCode).map(([c, n]) => '  • ' + c + ': ' + n),
        r.automations.length ? 'Routines: ' + r.automations.map(a => a.what + ' @ ' + a.when).join(', ') : 'Routines: none set',
        r.timers.length ? 'Timers: ' + r.timers.map(t => t.label + ' (' + t.endsInSec + 's left)').join(', ') : 'Timers: none running',
        'Self-upgrade: ' + (r.selfUpgrade ? 'allowed by you' : 'off — Aevion cannot change its own code')
      ];
      return lines.join('\n');
    }
  });

  Aevion.tools = T;
})();
