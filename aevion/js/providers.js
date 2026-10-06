/* ============================================================
 * Aevion Providers — one interface, many AI backends.
 *
 * The rest of the app only ever calls:
 *     Aevion.providers.chat(messages, { onToken })
 * and every backend (OpenAI-compatible, Anthropic, Gemini, a local
 * server, the in-browser model or the offline mock) is an adapter
 * registered here. Adding a provider never touches the core.
 *
 * An adapter is plain data + two pure functions:
 *   { id, label, kind, needsKey, needsUrl, needsModel,
 *     defaults: { url, model }, caps: { stream },
 *     buildRequest(messages, cfg) -> { url, headers, body }
 *     parseResponse(json) -> string
 *     parseStream(json)   -> string delta   (only when caps.stream) }
 *
 * Privacy: nothing here runs unless the user enabled Online AI, and a
 * cloud provider additionally refuses to run without a key. Local
 * providers (in-browser model, offline mock) never touch the network.
 * ============================================================ */
(function () {
  const P = {
    list: [],
    /* kind: 'local' (no network at all) | 'loopback' (your own machine)
             | 'cloud' (a third party) */
    register(adapter) {
      const existing = this.list.findIndex(a => a.id === adapter.id);
      if (existing >= 0) this.list[existing] = adapter;
      else this.list.push(adapter);
      return adapter;
    },
    get(id) { return this.list.find(a => a.id === id) || null; },
    ids() { return this.list.map(a => a.id); },
    /* Providers that can run right now, given the settings. */
    usableIds() {
      return this.list.filter(a => {
        if (a.kind === 'local') return true;
        return !!Aevion.settings.onlineAI;
      }).map(a => a.id);
    }
  };

  /* ================= per-provider configuration =================
     Each provider keeps its own endpoint/model so switching backends
     never wipes what you typed. Keys live in the secrets vault instead
     (Aevion.secrets), so they never end up in a backup bundle. */
  const chosen = (v, fallback) => (v === undefined || v === null || v === '' ? fallback : v);

  P.cfg = function (id) {
    const a = P.get(id);
    if (!a) return null;
    const saved = (Aevion.store.get('aiCfg', {})[id]) || {};
    return {
      url: String(chosen(saved.url, a.defaults.url || '')).trim(),
      model: String(chosen(saved.model, a.defaults.model || '')).trim(),
      temperature: chosen(saved.temperature, 0.7),
      maxTokens: chosen(saved.maxTokens, 1024)
    };
  };

  P.setCfg = function (id, patch) {
    const all = Aevion.store.get('aiCfg', {});
    const next = Object.assign({}, all[id] || {}, patch);
    if (patch && 'key' in patch) { P.setKey(id, patch.key); delete next.key; }
    all[id] = next;
    Aevion.store.set('aiCfg', all);
    Aevion.emit('ai:config', { id });
    return this.cfg(id);
  };

  /* One-time move from the pre-0.6 flat settings (aiUrl/aiModel/aiKey),
     which are then cleared so no plaintext key survives in `settings`. */
  P.migrateLegacy = function () {
    const s = Aevion.settings;
    const id = s.aiProvider || 'ollama';
    const hadLegacy = !!(s.aiUrl || s.aiModel || s.aiKey);
    if (hadLegacy) {
      const all = Aevion.store.get('aiCfg', {});
      if (!all[id]) all[id] = { url: s.aiUrl || '', model: s.aiModel || '' };
      Aevion.store.set('aiCfg', all);
      if (s.aiKey) P.setKey(id, s.aiKey);
    }
    if (Aevion.store.get('aiCfg') === undefined) Aevion.store.set('aiCfg', {});
    for (const k of ['aiUrl', 'aiModel', 'aiKey']) {
      if (k in s) { s[k] = ''; Aevion.store.set('settings', s); }
    }
    return hadLegacy;
  };

  /* Keys go through the secrets vault (encrypted at rest when a PIN
     exists), never into the plain settings blob or a backup. */
  P.setKey = function (id, key) {
    if (Aevion.secrets) Aevion.secrets.put('aiKey:' + id, key || '');
    else Aevion.store.set('aiKey:' + id, key || '');
  };
  P.key = function (id) {
    return Aevion.secrets ? Aevion.secrets.get('aiKey:' + id) : Aevion.store.get('aiKey:' + id, '');
  };
  P.hasKey = function (id) { return !!P.key(id); };

  /* What is still missing before this provider can answer. */
  P.missing = function (id) {
    const a = P.get(id);
    if (!a) return ['unknown provider'];
    const cfg = P.cfg(id);
    const out = [];
    if (a.needsUrl && !cfg.url) out.push('endpoint URL');
    if (a.needsModel && !cfg.model) out.push('model name');
    if (a.needsKey && !P.key(id)) out.push('API key');
    return out;
  };

  /* ================= HTTP plumbing (shared by every adapter) ===== */

  function explainHttp(status, body, url) {
    const detail = String(body || '').replace(/\s+/g, ' ').slice(0, 160);
    if (status === 401 || status === 403) return `the endpoint rejected the API key (HTTP ${status})${detail ? ' — ' + detail : ''}`;
    if (status === 404) return `no model or endpoint at ${url} (HTTP 404)${detail ? ' — ' + detail : ''}`;
    if (status === 429) return 'rate limited by the provider (HTTP 429) — try again shortly';
    if (status >= 500) return `the provider had a server error (HTTP ${status})`;
    return `HTTP ${status}${detail ? ' — ' + detail : ''}`;
  }

  /* Reads a text/event-stream body and hands each JSON payload to onJson.
     Works with a real fetch Response and with the test harness stream. */
  async function readSSE(res, onJson) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line || line.startsWith(':') || line.startsWith('event:')) continue;
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') return;
        try { onJson(JSON.parse(data)); } catch { /* partial line, ignore */ }
      }
    }
  }

  const abortAfter = ms => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    return { signal: ctl.signal, clear: () => clearTimeout(t) };
  };

  /* One request for one adapter. Returns the full text. */
  async function request(a, messages, cfg, opts) {
    const wantsStream = !!(opts.onToken && a.caps.stream);
    const built = a.buildRequest(messages, Object.assign({}, cfg, { stream: wantsStream }));
    const timer = abortAfter(a.timeout || 90000);
    let r;
    try {
      r = await fetch(built.url, {
        method: 'POST',
        headers: built.headers,
        body: JSON.stringify(built.body),
        signal: timer.signal
      });
    } catch (e) {
      timer.clear();
      if (e && e.name === 'AbortError') throw new Error(`no response from ${built.url} within ${Math.round((a.timeout || 90000) / 1000)}s`);
      throw new Error(`cannot reach ${built.url} — ${e.message}. Check the endpoint and that the device is online.`);
    }
    if (!r.ok) {
      let body = '';
      try { body = await r.text(); } catch { /* ignore */ }
      timer.clear();
      throw new Error(explainHttp(r.status, body, built.url));
    }

    try {
      if (wantsStream && r.body) {
        let full = '';
        await readSSE(r, json => {
          const delta = a.parseStream(json);
          if (delta) { full += delta; opts.onToken(delta, full); }
        });
        if (!full.trim()) {
          // some servers ignore stream:true — fall back to a normal read
          const text = r.json ? await r.json() : null;
          const out = text ? a.parseResponse(text) : '';
          if (out) { opts.onToken(out, out); return out; }
          throw new Error('the provider returned an empty message');
        }
        return full.trim();
      }
      const json = await r.json();
      const parsed = a.parseResponse(json);
      if (!parsed || !parsed.trim()) throw new Error('the provider returned an empty message');
      const text = parsed.trim();
      if (opts.onToken) opts.onToken(text, text);
      return text;
    } catch (e) {
      if (e && e.name === 'AbortError') throw new Error('the request timed out');
      throw e;
    } finally {
      timer.clear();
    }
  }

  /* ================= chat entry points ================= */

  function gate(a) {
    if (a.kind === 'local') return;
    if (!Aevion.settings.onlineAI) {
      throw new Error(a.kind === 'loopback'
        ? `Online AI is off — enable it in Settings to talk to your own server at ${Aevion.providers.cfg(a.id).url}`
        : 'Online AI is off — enable it in Settings → Privacy (Aevion works fully offline without it).');
    }
    const missing = P.missing(a.id);
    if (missing.length) throw new Error(`${a.label} needs: ${missing.join(', ')}.`);
  }

  P.chat = function (messages, opts = {}) {
    return P.chatWith(Aevion.settings.aiProvider || 'ollama', messages, opts);
  };

  P.chatWith = async function (id, messages, opts = {}) {
    const a = P.get(id);
    if (!a) throw new Error(`Unknown AI provider "${id}".`);
    gate(a);
    const cfg = Object.assign({}, P.cfg(id), { key: P.key(id) });
    const out = await request(a, normalize(messages), cfg, opts);
    Aevion.store.set('aiLastUsed', { t: Date.now(), provider: id });
    return out;
  };

  /* Which providers may take over from a failing one.
     This is a privacy boundary, not a preference: a prompt typed for one
     backend must never be silently rerouted to a *different* third party.
     So fallback only happens within the same trust class, or inwards to a
     provider that cannot reach the internet at all. */
  const TRUST_ORDER = {
    cloud: ['cloud', 'local'],
    loopback: ['loopback', 'local'],
    local: ['local']
  };

  /* How long a check is trusted. Long enough that a list is not re-asking all
     the time, short enough that a server started five minutes ago counts. */
  const CHECK_TTL = 10 * 60 * 1000;

  /* Can this provider answer *right now*? A configured provider pointing at
     nothing (a server that is not running, an in-browser model that was never
     downloaded) is still a real provider — it just must not be promised as a
     fallback or as one of the brains in a multi-brain message, where the only
     thing it can produce is an error line.

     The last check (js/setup.js) is the authority when it is fresh: a
     provider the check found silent does not count as able to answer, which
     is what stops a list from promising two brains that both do nothing. */
  P.canAnswerNow = function (id) {
    const a = P.get(id);
    if (!a) return false;
    if (P.missing(id).length) return false;
    if (id === 'webllm') return !!(Aevion.webllm && Aevion.webllm.isReady());
    const seen = P.lastCheck ? P.lastCheck(id) : null;
    if (seen && seen !== 'ready') return false;
    return true;
  };

  /* The verdict from the last survey, if one recent enough covered this
     provider. Read through Aevion.setup when it is there, so this file keeps
     working with the module absent (tests, older builds) and never probes by
     itself: a provider list must not phone home. */
  P.lastCheck = function (id) {
    const S = Aevion.setup;
    if (!S || !S.last) return null;
    const last = S.last();
    if (!last || !last.at) return null;
    if (Date.now() - last.at > CHECK_TTL) return null;
    const o = (last.options || []).find(x => x.id === id);
    if (!o) return null;
    return o.state === 'ready' ? 'ready'
      : o.state === 'test' ? null            // “not checked”: no opinion either way
      : o.state;
  };

  P.fallbackIds = function (primaryId) {
    const primary = P.get(primaryId);
    if (!primary) return [];
    const allowed = TRUST_ORDER[primary.kind] || ['local'];
    return P.list
      .filter(a => allowed.includes(a.kind))
      .filter(a => a.id !== primaryId && a.id !== 'mock')
      .filter(a => P.canAnswerNow(a.id))
      .map(a => a.id);
  };

  /* Ask the chosen provider, then (only if allowed) an in-class one, until
     something answers. Used by the chat pipeline so a dead backend degrades
     instead of failing outright. */
  P.chatWithFallback = async function (messages, opts = {}) {
    const primary = Aevion.settings.aiProvider || 'ollama';
    const order = Aevion.settings.aiFallback === false
      ? [primary]
      : [primary, ...P.fallbackIds(primary)];
    const errors = [];
    for (const id of order) {
      const a = P.get(id);
      if (!a) continue;
      const missing = P.missing(id);
      if (missing.length) {
        /* A skip is worth recording too: “it never even tried, because the
           key is missing” is a different problem from “it tried and died”. */
        P.noteAttempt({ id, kind: 'skip', ok: false, skipped: true, why: 'not set up: needs ' + missing.join(', ') });
        errors.push(`${a.label}: needs ${missing.join(', ')}`);
        continue;
      }
      try {
        const out = await P.chatWith(id, messages, opts);
        return { text: out, provider: id, errors };
      } catch (e) {
        errors.push(`${a.label}: ${e.message}`);
      }
    }
    const err = new Error(errors[0] || 'No AI provider answered.');
    err.errors = errors;
    throw err;
  };

  /* ================= more than one brain =================
     Several keys, used together. The planner is deliberately small, because
     the honest part of “use more than one for better results” is knowing what
     each strategy actually does:

       compare  — ask them all at once and put every answer next to the brain
                  that gave it. The value is real and it is not magic: you see
                  the disagreement, instead of trusting one voice.
       critique — one brain answers, the next reads that draft and returns the
                  corrected answer. The value is a second reader catching what
                  the first one got wrong.

     Neither one merges models into something smarter, and neither is silent:
     every leg goes through chatWith, so the attempt log shows each call. Any
     leg that fails is reported and the others still answer. */
  const STRATEGIES = ['first', 'compare', 'critique'];

  P.brainStrategy = () => {
    const s = Aevion.settings || {};
    return STRATEGIES.includes(s.brainStrategy) ? s.brainStrategy : 'first';
  };

  /* The brains that will be used for the next message, in the order the user
     ticked them: configured, allowed, and answering-capable. One is a normal
     chat; two or more is a multi-brain message. */
  P.multiPlan = function () {
    const s = Aevion.settings || {};
    if (P.brainStrategy() === 'first') return [];
    const on = (s.brainSet || []).filter(id => P.get(id));
    const ready = on.filter(id => !P.missing(id).length && P.canAnswerNow(id) && (P.kindOf(id) === 'local' || s.onlineAI));
    return ready.length >= 2 ? ready : [];
  };

  /* Ask each brain the same thing, in parallel. Never throws for one bad
     provider: the caller gets one leg per brain, ok or not. */
  P.askMany = async function (ids, messages, opts = {}) {
    const perBrain = opts.onToken ? {} : null;
    return Promise.all(ids.map(async id => {
      try {
        const text = await P.chatWith(id, messages, perBrain ? Object.assign({}, opts, {
          onToken: (d, full) => opts.onToken(d, full, id)
        }) : opts);
        return { id, ok: true, text };
      } catch (e) {
        return { id, ok: false, why: (e && e.message) || String(e) };
      }
    }));
  };

  const lastUser = messages => {
    const m = [...normalize(messages)].reverse().find(x => x.role === 'user');
    return m ? m.content : '';
  };

  /* One answers, the next reviews. A failing reviewer never throws the draft
     away: the best text so far is what comes back. */
  P.askCritique = async function (ids, messages, opts = {}) {
    const legs = [];
    let draft = null;
    let by = null;
    for (const id of ids) {
      const a = P.get(id);
      if (!a) continue;
      try {
        let text;
        if (!draft) {
          text = await P.chatWith(id, messages, opts);
        } else {
          text = await P.chatWith(id, [
            { role: 'system', content: 'You are reviewing another assistant’s draft answer. Say briefly what is wrong or missing, then give the corrected, final answer on its own — no preamble, no meta-commentary.' },
            { role: 'user', content: 'Question:\n' + lastUser(messages) + '\n\nDraft answer:\n' + draft }
          ], opts);
        }
        draft = text;
        by = id;
        legs.push({ id, ok: true, text, reviewed: legs.length > 0 });
      } catch (e) {
        legs.push({ id, ok: false, why: (e && e.message) || String(e) });
      }
    }
    return { legs, text: draft, by };
  };

  /* The Settings "Test" button: a real round trip with a tiny prompt, so
     the UI can tell the truth about connectivity. */
  P.test = async function (id) {
    const started = Date.now();
    const reply = await P.chatWith(id, [{ role: 'user', content: 'Reply with the single word: ready' }], { maxTokens: 16 });
    return { ok: true, ms: Date.now() - started, reply: reply.trim().slice(0, 80) };
  };

  function normalize(messages) {
    return (messages || [])
      .filter(m => m && typeof m.content === 'string' && m.content.trim())
      .map(m => ({ role: m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user', content: m.content }));
  }
  const splitSystem = msgs => ({
    system: msgs.filter(m => m.role === 'system').map(m => m.content).join('\n\n'),
    rest: msgs.filter(m => m.role !== 'system')
  });

  /* ================= adapters ================= */

  /* --- OpenAI-compatible: OpenAI, Groq, Ollama, LM Studio, vLLM,
         llama.cpp server, OpenRouter, or anything you point at a URL --- */
  function openAICompatible(spec) {
    return {
      id: spec.id,
      label: spec.label,
      kind: spec.kind,
      needsKey: !!spec.needsKey,
      needsUrl: spec.needsUrl !== false,
      needsModel: true,
      /* GET /models is the one listing every OpenAI-compatible server
         serves, so these adapters can answer "are you there?" cheaply.
         An adapter without it is reported as unknown, never guessed at. */
      probes: spec.probes !== false,
      /* Free to start: no card needed, or a free monthly allowance. The UI
         builds its “get a free key” list from this flag, so the list can
         never drift from the registry — and a provider that claims it must
         link to where the key comes from (see docs). */
      free: !!spec.free,
      caps: { stream: true },
      docs: spec.docs,
      hint: spec.hint,
      defaults: { url: spec.url, model: spec.model },
      timeout: spec.timeout || 90000,
      buildRequest(messages, cfg) {
        const headers = { 'Content-Type': 'application/json' };
        if (cfg.key) headers.Authorization = 'Bearer ' + cfg.key;
        return {
          url: cfg.url,
          headers,
          body: {
            model: cfg.model,
            messages,
            stream: !!cfg.stream,
            temperature: cfg.temperature,
            max_tokens: cfg.maxTokens
          }
        };
      },
      parseResponse(j) {
        const c = j && j.choices && j.choices[0];
        const msg = c && (c.message || c.delta);
        if (msg && typeof msg.content === 'string') return msg.content;
        if (c && typeof c.text === 'string') return c.text;         // legacy completions
        if (j && typeof j.response === 'string') return j.response; // Ollama native
        return '';
      },
      parseStream(j) { return this.parseResponse(j); }
    };
  }

  P.register(openAICompatible({
    id: 'openai', label: 'OpenAI', kind: 'cloud', needsKey: true,
    url: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o-mini',
    docs: 'https://platform.openai.com/api-keys',
    hint: 'Your key stays on this device and is sent only to OpenAI.'
  }));

  P.register(openAICompatible({
    id: 'groq', label: 'Groq (fast hosted)', kind: 'cloud', needsKey: true, free: true,
    url: 'https://api.groq.com/openai/v1/chat/completions', model: 'llama-3.3-70b-versatile',
    docs: 'https://console.groq.com/keys',
    hint: 'OpenAI-compatible, no local install.'
  }));

  /* --- OpenRouter: one key, many models, including the open-weight Nex-N2.5
         family (agentic coding and computer use, with a free tier). Any
         OpenRouter model id works in the Model box; Nex-N2.5 Mini is the
         default because it is the one that runs on a free key. --- */
  P.register(openAICompatible({
    id: 'openrouter', label: 'OpenRouter (many models, incl. Nex-N2.5)', kind: 'cloud', needsKey: true, free: true,
    url: 'https://openrouter.ai/api/v1/chat/completions', model: 'nex-agi/nex-n2.5-mini',
    docs: 'https://openrouter.ai/keys',
    hint: 'One key, many models. Defaults to Nex-N2.5 Mini (agentic, open weights); paste any other OpenRouter model id into the Model box.'
  }));

  /* --- The rest of the free tiers. Every one of them is OpenAI-compatible,
         which is why none of them needed a line of adapter code: a base URL,
         a model id and the page where the key comes from. Free means one of
         two things and the hint says which: no card at all, or a free monthly
         allowance / free models. Limits and model names change; the Model box
         is always editable and the brain log shows exactly what came back. --- */
  P.register(openAICompatible({
    id: 'cerebras', label: 'Cerebras (free tier, very fast)', kind: 'cloud', needsKey: true, free: true,
    url: 'https://api.cerebras.ai/v1/chat/completions', model: 'llama3.1-8b',
    docs: 'https://cloud.cerebras.ai/',
    hint: 'Free tier, no credit card: sign up at cloud.cerebras.ai. Open models (Llama, Qwen) at unusual speed.'
  }));
  P.register(openAICompatible({
    id: 'mistral', label: 'Mistral (free tier)', kind: 'cloud', needsKey: true, free: true,
    url: 'https://api.mistral.ai/v1/chat/completions', model: 'mistral-small-latest',
    docs: 'https://console.mistral.ai/api-keys',
    hint: 'Free “La Plateforme” tier (a phone number is asked for). Mistral models, including vision.'
  }));
  P.register(openAICompatible({
    id: 'huggingface', label: 'Hugging Face Inference (free credits)', kind: 'cloud', needsKey: true, free: true,
    url: 'https://router.huggingface.co/v1/chat/completions', model: 'meta-llama/Llama-3.1-8B-Instruct',
    docs: 'https://huggingface.co/settings/tokens',
    hint: 'Free monthly credits on the Inference Router. Any routed model id works in the Model box.'
  }));
  P.register(openAICompatible({
    id: 'github', label: 'GitHub Models (free with a GitHub token)', kind: 'cloud', needsKey: true, free: true,
    url: 'https://models.github.ai/inference/chat/completions', model: 'openai/gpt-4o-mini',
    docs: 'https://github.com/marketplace/models',
    hint: 'A normal GitHub personal access token is the key. Free with rate limits; change the Model box for other models.'
  }));
  P.register(openAICompatible({
    id: 'nvidia', label: 'NVIDIA NIM (free credits)', kind: 'cloud', needsKey: true, free: true,
    url: 'https://integrate.api.nvidia.com/v1/chat/completions', model: 'meta/llama-3.3-70b-instruct',
    docs: 'https://build.nvidia.com/settings/api-keys',
    hint: 'Credit-based free tier (a phone number is asked for). Many open models, big ones included.'
  }));
  P.register(openAICompatible({
    id: 'sambanova', label: 'SambaNova (free tier)', kind: 'cloud', needsKey: true, free: true,
    url: 'https://api.sambanova.ai/v1/chat/completions', model: 'Meta-Llama-3.3-70B-Instruct',
    docs: 'https://cloud.sambanova.ai/apis',
    hint: 'Free tier on signup. Fast Llama and Qwen models.'
  }));

  P.register(openAICompatible({
    id: 'ollama', label: 'Ollama (your own machine)', kind: 'loopback', needsKey: false,
    url: 'http://localhost:11434/v1/chat/completions', model: 'llama3.2',
    docs: 'https://ollama.com',
    hint: 'Runs on your PC. Start it with: ollama serve'
  }));

  P.register(openAICompatible({
    id: 'lmstudio', label: 'LM Studio / llama.cpp (local)', kind: 'loopback', needsKey: false,
    url: 'http://localhost:1234/v1/chat/completions', model: 'local-model',
    docs: 'https://lmstudio.ai',
    hint: 'Any OpenAI-compatible local server: LM Studio, llama.cpp, vLLM.'
  }));

  /* --- llama.cpp's own server (`llama-server`) ---
     llama.cpp ships an OpenAI-compatible server whose default port is **8080**
     — not the 1234 LM Studio uses. That difference mattered in practice: run
     llama-server, have Aevion find nothing, and the app looks broken when in
     fact a perfectly good local brain is one port away. It is loopback and
     keyless, exactly like Ollama. llama-server serves the single model it was
     started with and ignores the name it is sent, so the default here is a
     placeholder that can be left alone. --- */
  P.register(openAICompatible({
    id: 'llamacpp', label: 'llama.cpp server (local)', kind: 'loopback', needsKey: false,
    url: 'http://localhost:8080/v1/chat/completions', model: 'local-model',
    docs: 'https://github.com/ggml-org/llama.cpp',
    hint: 'Start it with: llama-server -m your-model.gguf --port 8080 — it serves the one model it was given, so the Model box can stay as it is.'
  }));

  /* --- Cactus Needle 3 (on-device, tool calling) ---
     Needle 3 is Cactus Compute's tiny automation model: 26M–98M parameters,
     a handful of megabytes, built to run on the device it is already on and
     to call tools rather than to hold a long conversation. It is open weights,
     not a service — there is no hosted endpoint and no key to paste, which is
     why this one is deliberately *not* in the “get a free key” list: Cactus
     serves it through an OpenAI-compatible API on your own machine, so it
     plugs in exactly like Ollama or LM Studio, as a loopback brain.

     The address is left for you to fill in, on purpose. Cactus prints the
     port when you start its server; this file will not invent one, because a
     guessed default would only aim the check at a port nobody opened and then
     read as Needle's fault. The Model box defaults to `needle3`, the name the
     published weights use, and stays editable for a different served id. --- */
  P.register(openAICompatible({
    id: 'needle', label: 'Cactus Needle 3 (on-device, tool calling)', kind: 'loopback', needsKey: false,
    url: '', model: 'needle3',
    docs: 'https://docs.cactuscompute.com/',
    hint: 'Open-weight, a few MB, and it runs on this machine — no key, no account. Start Cactus’s OpenAI-compatible server and put the address it prints here (the Model box already says needle3). It is a tool-calling model first: expect it to pick actions well and to chat modestly. https://docs.cactuscompute.com/'
  }));

  P.register(openAICompatible({
    id: 'custom', label: 'Other OpenAI-compatible endpoint', kind: 'cloud', needsKey: false,
    url: '', model: '',
    hint: 'Point this at any server that speaks /v1/chat/completions. Add a key only if it needs one.'
  }));

  /* --- Anthropic (Messages API) --- */
  P.register({
    id: 'anthropic', label: 'Anthropic Claude', kind: 'cloud',
    needsKey: true, needsUrl: true, needsModel: true,
    caps: { stream: true },
    docs: 'https://console.anthropic.com/settings/keys',
    hint: 'Claude models. The key is sent only to api.anthropic.com.',
    defaults: { url: 'https://api.anthropic.com/v1/messages', model: 'claude-3-5-haiku-latest' },
    timeout: 120000,
    buildRequest(messages, cfg) {
      const { system, rest } = splitSystem(messages);
      const body = {
        model: cfg.model,
        max_tokens: cfg.maxTokens || 1024,
        temperature: cfg.temperature,
        stream: !!cfg.stream,
        // Anthropic wants strict user/assistant alternation
        messages: rest.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }))
      };
      if (system) body.system = system;
      return {
        url: cfg.url,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': cfg.key,
          'anthropic-version': '2023-06-01',
          // required for direct browser calls, per Anthropic's own docs
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body
      };
    },
    parseResponse(j) {
      if (!j || !Array.isArray(j.content)) return '';
      return j.content.filter(c => c && c.type === 'text').map(c => c.text).join('');
    },
    parseStream(j) {
      if (!j) return '';
      if (j.type === 'content_block_delta' && j.delta && typeof j.delta.text === 'string') return j.delta.text;
      return '';
    }
  });

  /* --- Google Gemini (Google AI Studio) ---
         Google AI Studio hands out the most generous no-card free key of the
         group, so this is the one to lead with in the “get a free key” list.
         The label names the lab as well as the model family, because that is
         the page people actually search for. --- */
  P.register({
    id: 'gemini', label: 'Google AI Studio (Gemini)', kind: 'cloud', free: true,
    needsKey: true, needsUrl: true, needsModel: true,
    caps: { stream: true },
    docs: 'https://aistudio.google.com/apikey',
    hint: 'Google AI Studio — a free key with no credit card, at https://aistudio.google.com/apikey. The key is sent only to Google.',
    defaults: { url: 'https://generativelanguage.googleapis.com/v1beta/models', model: 'gemini-2.0-flash' },
    timeout: 120000,
    buildRequest(messages, cfg) {
      const { system, rest } = splitSystem(messages);
      const base = (cfg.url || '').replace(/\/$/, '');
      const body = {
        contents: rest.map(m => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }]
        })),
        generationConfig: { temperature: cfg.temperature, maxOutputTokens: cfg.maxTokens }
      };
      if (system) body.systemInstruction = { parts: [{ text: system }] };
      return {
        url: `${base}/${encodeURIComponent(cfg.model)}:${cfg.stream ? 'streamGenerateContent?alt=sse&' : 'generateContent?'}key=${encodeURIComponent(cfg.key)}`,
        headers: { 'Content-Type': 'application/json' },
        body
      };
    },
    parseResponse(j) {
      const c = j && j.candidates && j.candidates[0];
      const parts = c && c.content && c.content.parts;
      if (!Array.isArray(parts)) return '';
      return parts.map(p => (p && typeof p.text === 'string') ? p.text : '').join('');
    },
    parseStream(j) { return this.parseResponse(j); }
  });

  /* --- In-browser model (WebGPU). Local: no network at all. --- */
  P.register({
    id: 'webllm', label: 'In-browser model (offline, on your GPU)', kind: 'local',
    needsKey: false, needsUrl: false, needsModel: false,
    caps: { stream: true },
    hint: 'Runs entirely on this device after a one-time model download.',
    defaults: { url: '', model: '' },
    buildRequest() { throw new Error('the in-browser model has no HTTP endpoint'); },
    parseResponse() { return ''; },
    /* handled by chatWith's local branch */
    local: true
  });

  /* --- Offline mock: proves the pipeline without any network or AI.
         It is deliberately honest: it does not pretend to be a model. --- */
  P.register({
    id: 'mock', label: 'Offline test provider (no AI)', kind: 'local',
    needsKey: false, needsUrl: false, needsModel: false,
    caps: { stream: false },
    hint: 'Deterministic canned replies — for testing the app with nothing configured.',
    defaults: { url: '', model: 'mock-1' },
    buildRequest() { throw new Error('the mock provider makes no HTTP requests'); },
    parseResponse() { return ''; },
    local: true
  });

  /* ================= the attempt log =================
     Every real request to a brain lands here: which provider, how long it
     took, whether it answered, and — when it did not — why. This is what
     turns “the AI is not working” into something readable instead of
     mysterious, and it is inspectable in Tools → 🧠 Brain log.

     Privacy: the *attempt* is recorded, never the content. No prompt text,
     no reply text, no key — an id, a duration, a character count, and the
     message the provider itself returned. */
  const LOG_CAP = 60;
  const brief = s => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 200);

  P.attempts = () => Aevion.store.get('brainLog', []);
  P.clearAttempts = function () {
    Aevion.store.set('brainLog', []);
    Aevion.emit('brain:log', { cleared: true });
  };
  P.noteAttempt = function (e) {
    const entry = {
      t: Date.now(),
      id: String(e.id || ''),
      kind: e.kind || 'chat',
      ok: !!e.ok,
      skipped: !!e.skipped,
      ms: Math.max(0, Math.round(e.ms || 0)),
      chars: e.chars == null ? 0 : e.chars,
      why: brief(e.why)
    };
    Aevion.store.set('brainLog', P.attempts().concat([entry]).slice(-LOG_CAP));
    Aevion.emit('brain:log', { entry });
    return entry;
  };
  P.attemptStats = function () {
    const log = P.attempts();
    const ok = log.filter(e => e.ok).length;
    return { total: log.length, ok, failed: log.length - ok };
  };

  /* One wrapper, so nothing can reach a brain without being recorded. */
  const timed = (id, kind, fn) => {
    const started = Date.now();
    return Promise.resolve().then(fn).then(
      text => {
        const chars = String(text == null ? '' : text).length;
        P.noteAttempt({ id, kind, ok: !!chars, chars, ms: Date.now() - started, why: chars ? '' : 'the provider came back empty' });
        return text;
      },
      err => {
        P.noteAttempt({ id, kind, ok: false, ms: Date.now() - started, why: (err && err.message) || String(err) });
        throw err;
      }
    );
  };

  /* Local providers do not go through fetch at all. */
  const chatWithLocals = async (id, messages, opts) => {
    const last = [...messages].reverse().find(m => m.role === 'user');
    if (id === 'mock') {
      const text = `[offline test provider] You said: "${(last ? last.content : '').slice(0, 200)}". ` +
        `No AI is configured, so nothing was sent anywhere. Pick a provider in Settings → AI to talk to a real model.`;
      if (opts.onToken) opts.onToken(text, text);
      return text;
    }
    if (id === 'webllm') {
      if (!Aevion.webllm.isReady()) throw new Error('No in-browser model is loaded yet — tap “Download the in-browser model” above the chat box, or load one in Settings → In-browser AI.');
      return Aevion.webllm.chatStream(messages, opts.onToken || (() => {}));
    }
    throw new Error(`Unknown local provider "${id}".`);
  };

  const httpChatWith = P.chatWith;
  P.chatWith = function (id, messages, opts = {}) {
    const a = P.get(id);
    if (!a) throw new Error(`Unknown AI provider "${id}".`);
    return timed(id, 'chat', () => (a.kind === 'local'
      ? chatWithLocals(id, normalize(messages), opts)
      : httpChatWith.call(P, id, messages, opts)));
  };

  /* The free-to-start providers, in registry order: what the “get a free key”
     list in the chat card is built from. Local providers are excluded — they
     have no key to fetch at all. */
  P.freeIds = () => P.list.filter(a => a.free && a.kind !== 'local').map(a => a.id);

  P.kindOf = id => (P.get(id) || {}).kind || 'cloud';
  P.isLocal = id => P.kindOf(id) === 'local';

  Aevion.providers = P;
})();
