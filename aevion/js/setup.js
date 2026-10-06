/* ============================================================
 * Aevion Setup — "is any AI answering right now, and if not, what
 * is the one tap that fixes it?"
 *
 * The offline brain always answers something, so the app never looks
 * dead. The failure this module exists for is the opposite one: a
 * provider that is *configured* but not *working*. Ollama is picked
 * in Settings and nothing is listening on its port; a key was never
 * pasted; the in-browser model was never downloaded. Every screen
 * quite honestly says "Ready", and then nothing answers — which is
 * what "the AI is not working" actually looks like.
 *
 * Everything here is read-only except apply(): it reads the real
 * registry (js/providers.js), asks the servers that can be asked,
 * and returns plain data. The card in the chat, the Settings button
 * and the local-brain fallback all quote the same survey, so the
 * check and the claim can never drift apart.
 *
 * Privacy: a probe is a GET to a provider the *user* configured.
 *   - Nothing is probed while Online AI is off.
 *   - Loopback probes ask your own machine and cannot leave it.
 *   - A cloud probe happens only for a provider that already holds a
 *     key, and only ever asks that provider's own /models listing.
 *   - A probe carries no prompt, no text, no identifier, no query.
 * ============================================================ */
(function () {
  const S = {};
  const TIMEOUT = 3000;
  let last = null;          // the last survey: sync callers (brain.js) quote it

  S.TIMEOUT = TIMEOUT;
  S.kind = id => ((Aevion.providers.get(id) || {}).kind) || 'cloud';
  const labelOf = id => ((Aevion.providers.get(id) || {}).label) || id || 'no AI';
  const brief = s => String(s || '').replace(/\s+/g, ' ').replace(/[.\s]+$/, '').slice(0, 160);

  /* ---------- what is configured, without touching the network ----------
     Enough to answer "is there even a chance this answers?", which is what
     the chat asks before it sends anything. `ok` here means "configured and
     allowed" — only a probe can say whether the far end is awake. */
  S.quick = function () {
    const s = Aevion.settings || {};
    const id = s.aiProvider || '';
    const a = Aevion.providers.get(id);
    const q = {
      id,
      label: id ? labelOf(id) : 'No provider',
      kind: (a && a.kind) || 'cloud',
      missing: a ? Aevion.providers.missing(id) : ['a provider'],
      onlineAI: !!s.onlineAI,
      loaded: !!(Aevion.webllm && Aevion.webllm.isReady()),
      gpu: !!(Aevion.webllm && Aevion.webllm.gpuSupported()),
      ok: false,
      why: ''
    };
    if (!a) {
      q.why = id
        ? 'The provider in Settings is no longer registered.'
        : 'No AI provider is picked yet — one tap sets one up.';
      return q;
    }
    if (a.kind === 'local') {
      q.ok = id === 'webllm' ? q.loaded : true;
      q.why = id === 'webllm'
        ? (q.loaded ? 'The in-browser model is loaded.' : 'No in-browser model is loaded or downloaded yet.')
        : 'Runs on this device.';
      return q;
    }
    if (q.missing.length) { q.why = q.label + ' still needs ' + q.missing.join(', ') + '.'; return q; }
    if (!q.onlineAI) { q.why = 'Online AI is switched off in Settings → Privacy.'; return q; }
    q.ok = true;
    q.why = q.label + ' is configured — answering needs a check.';
    return q;
  };

  /* ---------- one honest question to one provider ----------
     Only OpenAI-compatible adapters advertise `probes`, because GET /models
     is the one listing every one of them serves. Anthropic and Gemini have
     no cheap equivalent, so they are reported as "no quick check" instead of
     being guessed at. */
  S.modelsUrl = function (id) {
    const a = Aevion.providers.get(id);
    if (!a || !a.probes || a.kind === 'local') return '';
    const url = String((Aevion.providers.cfg(id) || {}).url || '').replace(/\/+$/, '');
    if (!url) return '';
    if (/\/chat\/completions$/.test(url)) return url.replace(/\/chat\/completions$/, '/models');
    if (/\/models$/.test(url)) return url;
    return url + '/models';
  };

  S.probe = async function (id, opts) {
    const a = Aevion.providers.get(id);
    if (!a) return { id, ok: false, ms: 0, why: 'that provider is not registered' };
    const url = S.modelsUrl(id);
    if (!url) return { id, ok: false, ms: 0, why: 'no quick check for this provider — use Test connection in Settings' };
    if (a.kind !== 'local' && !(Aevion.settings || {}).onlineAI) {
      return { id, ok: false, ms: 0, why: 'Online AI is off, so nothing was asked' };
    }
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = setTimeout(() => { if (ctl) ctl.abort(); }, (opts && opts.timeout) || TIMEOUT);
    const started = Date.now();
    try {
      const headers = {};
      const key = Aevion.providers.key(id);
      if (key) headers.Authorization = 'Bearer ' + key;
      const r = await fetch(url, { method: 'GET', headers, signal: ctl ? ctl.signal : undefined });
      const ms = Date.now() - started;
      if (!r || !r.ok) return { id, ok: false, ms, url, why: 'nothing answered at ' + url + ' (HTTP ' + ((r && r.status) || '?') + ')' };
      return { id, ok: true, ms, url, why: 'answered in ' + ms + ' ms' };
    } catch (e) {
      const ms = Date.now() - started;
      return {
        id, ok: false, ms, url,
        why: a.kind === 'loopback'
          ? 'nothing is listening at ' + url + ' — the server is not started, or the browser blocked the page from asking your own machine'
          : 'could not be reached (' + brief((e && e.message) || 'no answer') + ')'
      };
    } finally {
      clearTimeout(timer);
    }
  };

  /* ---------- one provider, fully described ---------- */
  S.option = async function (id) {
    const a = Aevion.providers.get(id);
    if (!a) return null;
    const s = Aevion.settings || {};
    const o = {
      id, label: a.label, kind: a.kind, hint: a.hint || '', docs: a.docs || '',
      free: !!a.free, missing: [], state: 'needs', why: '', ms: 0
    };
    if (id === 'mock') { o.state = 'test'; o.why = 'Canned replies — for testing the app, not an AI.'; return o; }
    o.missing = Aevion.providers.missing(id);
    if (o.missing.length) { o.state = 'needs'; o.why = 'Still needs ' + o.missing.join(', ') + '.'; return o; }
    if (a.kind === 'local') {
      const W = Aevion.webllm || {};
      const ready = !!(W.isReady && W.isReady());
      const cached = !!(W.storedProgress && W.storedProgress().includes(s.webllmModel));
      o.state = ready ? 'ready' : 'needs-download';
      o.why = ready ? 'Loaded and running on this device, fully offline.'
        : !W.gpuSupported ? 'This browser has no WebGPU, so it cannot run here.'
          : cached ? 'Downloaded before — one tap starts it again.'
            : 'Not downloaded yet: one download, then it runs offline for good.';
      if (!W.gpuSupported) o.state = 'unsupported';
      return o;
    }
    if (!s.onlineAI) { o.state = 'off'; o.why = 'Online AI is off — this is the switch that would be turned on.'; return o; }
    const p = await S.probe(id);
    o.ms = p.ms;
    o.state = p.ok ? 'ready' : 'unreachable';
    o.why = p.ok ? 'Answered in ' + p.ms + ' ms.' : brief(p.why) + '.';
    return o;
  };

  /* ---------- which one should be the brain? ----------
     The rule, in order:
       1. the one already picked, if it is answering — never move a user
          off a working choice;
       2. a server on your own machine (usually a much bigger model than
          anything that fits in a browser tab, and still yours alone);
       3. the in-browser model, when loaded — it needs nothing running;
       4. a hosted provider, but only when its key is already there.
     This only ever picks a default for a brain that is answering nothing
     at all. It is not a fallback for prompts: nothing here moves text from
     one company to another. */
  S.decide = function (options, currentId) {
    const usable = (options || []).filter(o => o && o.state === 'ready' && o.id !== 'mock');
    const cur = usable.find(o => o.id === currentId);
    if (cur) return { id: cur.id, why: 'already set, and it answered' };
    const server = usable.filter(o => o.kind === 'loopback').sort((a, b) => a.ms - b.ms)[0];
    if (server) return { id: server.id, why: 'your own machine answered' + (server.ms ? ' in ' + server.ms + ' ms' : '') };
    const onDevice = usable.find(o => o.kind === 'local');
    if (onDevice) return { id: onDevice.id, why: 'runs on this device with no server and no key' };
    const hosted = usable[0];
    if (hosted) return { id: hosted.id, why: 'a hosted model answered with the key you already saved' };
    return { id: null, why: 'nothing is answering yet' };
  };

  /* ---------- the survey ---------- */
  S.survey = async function (ids) {
    const list = (ids || Aevion.providers.list.map(a => a.id)).filter(id => id !== 'mock');
    const options = (await Promise.all(list.map(id => S.option(id)))).filter(Boolean);
    const current = (Aevion.settings || {}).aiProvider || '';
    const d = S.decide(options, current);
    last = { at: Date.now(), options, current, best: d.id, why: d.why };
    Aevion.emit('setup:surveyed', last);
    return last;
  };

  S.last = () => last;

  /* ---------- one brain, in one short line, without touching the network ----------
     The Settings lists used to say “ready” about a provider whose key was
     saved — a promise, not a fact. `verdict()` is the cached truth instead:
     the last survey when one covered that provider, and otherwise everything
     that can be known without asking it. It never probes, so a list can call
     it freely; the probing happens in `survey()`, which is what fills it in. */
  const FACES = { ready: '✅', unreachable: '⚠️', 'needs-download': '⬇️', unsupported: '🚫', off: '⏸️', needs: '⚙️', test: '🧪' };
  S.FACES = FACES;
  S.verdict = function (id) {
    const a = Aevion.providers.get(id);
    const plain = (state, text) => ({ id, state, face: FACES[state] || '•', text, checked: 0 });
    if (!a) return plain('needs', 'not a provider this build knows');
    if (id === 'mock') return plain('test', 'canned replies — for testing the app');

    const o = last && last.options ? last.options.find(x => x.id === id) : null;
    if (o) {
      const text = {
        ready: 'answering' + (o.ms ? ' in ' + o.ms + ' ms' : ''),
        unreachable: brief(o.why) || 'nothing answered',
        'needs-download': brief(o.why) || 'not downloaded yet',
        unsupported: 'this browser cannot run it (no WebGPU)',
        off: 'online AI is switched off',
        needs: brief(o.why) || 'still needs setting up',
        test: 'canned replies — for testing the app'
      }[o.state] || brief(o.why) || o.state;
      return { id, state: o.state, face: FACES[o.state] || '•', text, checked: last.at };
    }

    // No survey has covered it yet — everything except “is the far end awake?”
    const miss = Aevion.providers.missing(id);
    if (miss.length) return plain('needs', 'needs ' + miss.join(', '));
    if (id === 'webllm') {
      const W = Aevion.webllm || {};
      const ready = !!(W.isReady && W.isReady());
      const gpu = !!(W.gpuSupported && W.gpuSupported());
      if (ready) return plain('ready', 'loaded on this device — no server, no key');
      return gpu ? plain('needs-download', 'not downloaded yet — one download, then offline for good')
        : plain('unsupported', 'this browser cannot run it (no WebGPU)');
    }
    if (a.kind === 'local') return plain('ready', 'runs on this device');
    if (!(Aevion.settings || {}).onlineAI) return plain('off', 'online AI is switched off');
    return plain('test', 'set up — not checked yet');
  };

  /* Everything a list needs to show a whole set of providers, in one call. */
  S.verdicts = ids => (ids || Aevion.providers.list.map(a => a.id)).map(id => S.verdict(id));

  S.best = async function () {
    const s = await S.survey();
    return { id: s.best, why: s.why, survey: s };
  };

  /* ---------- the one write in this file ----------
     A tap on a button that says exactly what it does *is* the consent, so
     switching online AI on here is allowed — but it is reported back, never
     done silently, and a local provider never turns anything on. */
  S.apply = function (id) {
    const a = Aevion.providers.get(id);
    if (!a) throw new Error('Unknown AI provider "' + id + '".');
    const out = { id, label: a.label, kind: a.kind, turnedOn: false };
    if (a.kind !== 'local' && !(Aevion.settings || {}).onlineAI) {
      Aevion.set('onlineAI', true);
      out.turnedOn = true;
    }
    Aevion.set('aiProvider', id);
    Aevion.emit('ai:config', { id });
    return out;
  };

  /* ---------- one honest sentence for the local brain ----------
     Sync by design: the fallback reply is built while answering, and it may
     quote the last survey (no network, no waiting). Empty string when there
     is nothing to apologise for. */
  S.note = function () {
    const q = S.quick();
    if (last && last.current === q.id) {
      const o = last.options.find(x => x.id === q.id);
      if (o) {
        if (o.state === 'unreachable') return o.label + ' did not answer (' + brief(o.why) + ')';
        if (o.state === 'needs-download') return 'no in-browser model is loaded yet, so there was nothing to ask';
        if (o.state === 'unsupported') return 'this browser cannot run the in-browser model (no WebGPU)';
        if (o.state === 'off') return 'online AI is switched off, so only the offline brain was asked';
      }
    }
    if (!q.id) return 'no AI provider is picked in Settings yet';
    if (q.missing.length) return q.label + ' still needs ' + q.missing.join(', ');
    if (!q.ok) return brief(q.why);
    return '';
  };

  Aevion.setup = S;
})();
