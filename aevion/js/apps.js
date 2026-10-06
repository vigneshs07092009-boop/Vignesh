/* ============================================================
 * Aevion — apps & sites bridge (js/apps.js)
 *
 * “If I install an app, or search for something in the browser,
 *  plug Aevion into it — and let it use that without any error.”
 *
 * That request has two halves, and only one of them can be done
 * by a web page:
 *
 *   • the apps installed on the device — on Android this is real:
 *     js/apps.js talks to the native AppsPlugin (PackageManager),
 *     lists every launchable app, and opens one by name. In a
 *     browser tab there is no such API at all: no browser lets a
 *     page enumerate installed programs, and this file says so in
 *     one sentence instead of throwing.
 *
 *   • anywhere Aevion itself takes you — a search, a “best app or
 *     site” pick, an opened link — that *is* knowable, because
 *     Aevion is the one opening it. Every such place is remembered
 *     as a *recent target*, and one tap turns it into a plugin:
 *     “youtube → https://youtube.com/results?search_query={query}”.
 *     From then on the app you already use is a plugin Aevion can
 *     run, no address typing.
 *
 * Nothing here throws: every call answers { ok, … } with a `why`
 * sentence a person can act on, because “without any error” means
 * the user never sees a stack trace where a sentence belongs.
 * Nothing here reaches the network on its own either — the only
 * outbound path is the confirm-tier `open.url` tool every other
 * link already goes through.
 * ============================================================ */
(function () {
  const A = {};

  const Cap = typeof window !== 'undefined' ? window.Capacitor : null;
  const Native = Cap && Cap.Plugins && Cap.Plugins.Apps ? Cap.Plugins.Apps : null;

  /* The native bridge, when this build is the Android app. */
  A.native = !!Native;

  const RECENTS = 'appRecents';
  const CAP = 8;

  const store = () => Aevion.store;
  const tidy = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const why = e => {
    const m = tidy((e && e.message) || e || 'unknown error');
    return m.length > 110 ? m.slice(0, 110).replace(/\s+\S*$/, '') + ' …' : m;
  };

  /* One sentence for the honest limit, used wherever the UI asks for the
     installed-app list and there is no Android behind the page. */
  A.whyNotHere = () =>
    'A browser tab cannot list the apps installed on this device — no browser exposes that. ' +
    'Aevion can still hold any app or site you name: plug in its address once and it opens on demand. ' +
    'In the Aevion Android app this list is real.';

  /* ---------- installed apps (Android only, and honestly so) ---------- */
  A.supported = () => !!Native;

  A.listInstalled = async function () {
    if (!Native) return { ok: false, items: [], why: A.whyNotHere() };
    try {
      const r = await Native.listInstalled();
      const raw = (r && (r.apps || r.items)) || [];
      /* Tidy, one row per package (a native list may report an app several
         times, once per activity), and never a row with no name to show. */
      const seen = new Set();
      const items = raw
        .map(a => ({ name: tidy(a.label || a.name), id: tidy(a.package || a.id), url: tidy(a.url || '') }))
        .filter(a => a.name && a.id && !seen.has(a.id) && seen.add(a.id))
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, 400);
      return items.length
        ? { ok: true, items, why: '' }
        : { ok: false, items: [], why: 'Android returned no launchable apps, which usually means the app list is restricted for Aevion in system settings.' };
    } catch (e) {
      return { ok: false, items: [], why: 'Android did not return the app list (' + why(e) + ').' };
    }
  };

  /* Launch a real app by package name. No prompt is invented here: the
     caller (a plugin, behind its own permission) decides. */
  A.launch = async function (id) {
    const pkg = tidy(id);
    if (!pkg) return { ok: false, why: 'No app was named.' };
    if (!Native) {
      return { ok: false, why: '“' + pkg + '” is an app on your device — a browser tab cannot start it, but the Aevion Android app can.' };
    }
    try {
      const r = await Native.open({ package: pkg });
      return (r && r.opened === false)
        ? { ok: false, why: 'Android would not start ' + pkg + ' — it may not be installed any more.' }
        : { ok: true, via: 'app', id: pkg };
    } catch (e) {
      return { ok: false, why: 'Android would not start ' + pkg + ' (' + why(e) + ').' };
    }
  };

  /* ---------- where Aevion has taken you ---------- */
  A.recents = () => {
    const list = store().get(RECENTS, []);
    return Array.isArray(list) ? list : [];
  };

  const hostName = url => {
    try {
      const h = new URL(url).hostname.replace(/^www\./, '');
      const bare = h.split('.').slice(0, -1).join('.') || h;
      return bare.charAt(0).toUpperCase() + bare.slice(1);
    } catch { return 'Link'; }
  };

  /* Remember one place. Called by the tools that open things, so it can
     only ever hold addresses Aevion really did open — never history, never
     anything read out of the browser. Same address twice updates the entry
     instead of filling the list with duplicates. */
  A.note = function (o) {
    try {
      const url = tidy(o && o.url);
      if (!/^https:\/\//i.test(url)) return null;
      let form = url;
      try {
        const u = new URL(url);
        form = u.origin + u.pathname;             // same search, later query: one entry
      } catch { /* keep the raw address */ }
      const entry = {
        name: tidy((o && o.name) || '') || hostName(url),
        host: (function () { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } })(),
        form,
        url,
        query: tidy(o && o.query),
        at: Date.now()
      };
      const rest = A.recents().filter(r => r.form !== form);
      store().set(RECENTS, [entry].concat(rest).slice(0, CAP));
      try { Aevion.emit('apps:recent', entry); } catch { /* no listeners is fine */ }
      return entry;
    } catch { return null; }
  };

  A.forget = function (form) {
    const next = A.recents().filter(r => r.form !== tidy(form));
    store().set(RECENTS, next);
    try { Aevion.emit('apps:recent', null); } catch { /* fine */ }
    return next.length;
  };
  A.clear = () => { store().set(RECENTS, []); return 0; };

  /* ---------- turning a place into a plugin ---------- */
  /* A search address is only worth plugging if it stays a search: the query
     you happened to use is swapped for the {query} placeholder, so the plugin
     answers *any* search rather than repeating tonight's. */
  A.template = function (url, query) {
    const raw = tidy(url);
    const q = tidy(query);
    if (!q) return raw;
    const enc = encodeURIComponent(q);
    if (raw.includes(enc)) return raw.split(enc).join('{query}');
    if (raw.includes(q)) return raw.split(q).join('{query}');
    try {
      const u = new URL(raw);
      for (const key of ['q', 'query', 'search_query', 'search', 's', 'text', 'k']) {
        if (u.searchParams.get(key)) { u.searchParams.set(key, '{query}'); return u.toString().replace(/%7Bquery%7D/g, '{query}'); }
      }
    } catch { /* not a search address — plug it as it is */ }
    return raw;
  };

  /* What the 🔌 button writes: a plugin whose trigger is the name you would
     actually say. Kept deliberately plain — one word, lowercased — because a
     trigger is matched at the start of a sentence. */
  A.suggest = function (recent) {
    const r = recent || {};
    const name = tidy(r.name) || hostName(r.url);
    const word = (tidy(r.host).split('.')[0] || name).toLowerCase().replace(/[^a-z0-9]/g, '');
    const target = A.template(r.url, r.query);
    return {
      name: name,
      desc: 'Plugged in from “' + (r.host || r.url) + '”',
      triggers: [word || 'open'].filter(Boolean),
      reply: 'Opening ' + name + '.',
      target: target
    };
  };

  A.plug = function (recent) {
    try {
      if (!Aevion.plugins || !Aevion.plugins.addSimple) return { error: 'The plugin registry is not loaded.' };
      const spec = A.suggest(recent);
      const r = Aevion.plugins.addSimple(spec);
      if (r && r.error) return r;
      if (recent && recent.form) A.forget(recent.form);
      return r;
    } catch (e) {
      return { error: 'That could not be saved (' + why(e) + ').' };
    }
  };

  /* The apps already plugged in *and* the Android list, in one shape the
     Plugins view can render without knowing which is which. */
  A.everything = async function () {
    const saved = (Aevion.plugins && Aevion.plugins.describe ? Aevion.plugins.describe() : [])
      .filter(p => p.target)
      .map(p => ({ name: p.name, target: p.target, plugged: true }));
    const installed = await A.listInstalled();
    return { plugged: saved, installed: installed.items, ok: installed.ok, why: installed.why };
  };

  Aevion.apps = A;
})();
