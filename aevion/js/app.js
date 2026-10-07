/* ============================================================
 * Aevion App — UI wiring, views, chat pipeline, settings
 * ============================================================ */
(function () {
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];

  /* The brain check's state (js/setup.js does the checking). Declared up here
     because two early readers need it: the header pill, which must not
     advertise an online brain the check has just found dead, and the card. */
  let brainSurvey = null;
  let brainBusy = false;
  /* The brain card is *on demand* and nothing else. It used to open by itself
     whenever no brain answered, which made it a popup: it came back on every
     reload, because its “Not now” lived in a variable that the next page load
     forgot. A panel that reappears no matter how often you close it is a
     defect, not a reminder — so now it appears only when you ask for it (the
     🧠 Set up AI shortcut, or the button in Settings → AI provider), it never
     opens on its own, and closing it is remembered. Everything it does is
     also reachable in Settings, which is what the user asked for. */
  let brainWanted = false;
  const BRAIN_SEEN = 'brainCardSeen';

  /* ============ THEME / APPEARANCE ============ */
  /* The theme itself (presets + custom overrides + validation) lives in
     js/theme.js. This file only renders the controls and hands the values
     over, so a new knob needs no DOM code at all. */

  /* Which brain the HUD is promising: LOCAL by choice, OFFLINE AI while
     the auto-switch is holding the online brain back, ONLINE AI otherwise. */
  function aiMode() {
    const s = Aevion.settings;
    if (!s || !s.onlineAI) return 'LOCAL';
    /* A real check beats a promise — and the *cached* check is enough. The pill
       used to consult only the in-memory card survey, so on any load where the
       card had not been opened it advertised ONLINE AI while the brain it
       named was an Ollama that was never installed: the exact lie behind “the
       AI is not working”. It is built from the same `verdict()` the Settings
       lists trust, so a missing key/endpoint, a provider found silent, and a
       model that was never downloaded all read as NO BRAIN — because that is
       what the next message would find. */
    const id = s.aiProvider || 'ollama';
    const a = Aevion.providers.get(id);
    const v = (Aevion.setup && Aevion.setup.verdict) ? Aevion.setup.verdict(id) : null;
    if (v) {
      if (v.state === 'needs' || v.state === 'unreachable' || v.state === 'needs-download' || v.state === 'unsupported') return 'NO BRAIN';
      /* “set up — not checked yet” is the one state that cannot be settled
         without a real reply, so it reads NO BRAIN until one lands. A
         successful attempt is that proof, it is remembered in the brain log,
         and the next tick flips the pill to ONLINE AI by itself. A provider
         that answers with no server at all (the offline mock) is never
         withheld. */
      if (v.state === 'test' && !(a && a.kind === 'local')
        && !Aevion.providers.attempts().some(e => e.id === id && e.ok)) return 'NO BRAIN';
    }
    if (s.autoAI !== false && Aevion.online && Aevion.online.available && !Aevion.online.available()) return 'OFFLINE AI';
    return 'ONLINE AI';
  }

  /* The pill can change with no event at all — a cooldown expires on its
     own — so it is rendered from one place and refreshed on a slow tick. */
  function renderMode() {
    const mode = aiMode();
    const el = $('#hudMode');
    if (!el || el.textContent === mode) return mode;
    el.textContent = mode;
    el.className = 'pill ' + (mode === 'ONLINE AI' ? 'mode-online' : 'mode-local');
    return mode;
  }

  function applySettings() {
    const s = Aevion.settings;
    Aevion.theme.apply();
    $('#hudName').textContent = (s.name || 'AEVION').toUpperCase();
    renderMode();
    document.title = `${s.name || 'Aevion'} — Private AI Assistant`;
  }

  function toast(msg, ms = 2600) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._h);
    t._h = setTimeout(() => t.classList.remove('show'), ms);
  }

  /* ============ NAV ============ */
  function show(view) {
    $$('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === view));
    $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + view));
    document.body.classList.remove('nav-open');
    if (view === 'chat') $('#chatInput').focus();
    if (view === 'tools') renderBrainLog();   // the log is only read there
  }
  $$('.nav-item').forEach(b => b.onclick = () => show(b.dataset.view));

  /* One button, and it goes both ways. Below the breakpoint the sidebar is an
     off-canvas drawer (`nav-open`), above it the sidebar is part of the
     layout and collapses (`collapsed`). Toggling the drawer class on a wide
     screen used to do nothing at all — the button looked broken — so the same
     press now closes the sidebar at every width instead of only opening it. */
  const isNarrow = () => typeof window.matchMedia === 'function'
    && window.matchMedia('(max-width: 820px)').matches;
  function navIsOpen() {
    return isNarrow()
      ? document.body.classList.contains('nav-open')
      : !document.body.classList.contains('collapsed');
  }
  function setNav(open) {
    if (isNarrow()) document.body.classList.toggle('nav-open', open);
    else {
      document.body.classList.toggle('collapsed', !open);
      Aevion.set('navCollapsed', !open);
    }
    const btn = $('#navToggle');
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.title = open ? 'Hide menu' : 'Show menu';
  }
  $('#navToggle').onclick = () => setNav(!navIsOpen());

  /* ============ CHAT ============ */
  const log = $('#chatLog');

  function addMsg(role, text, meta) {
    const d = document.createElement('div');
    d.className = 'msg ' + role;
    if (meta) {
      const m = document.createElement('div');
      m.className = 'meta';
      m.textContent = meta;
      d.appendChild(m);
      d._meta = m;      // so the badge can be corrected once the answer lands
    }
    // AI replies get rendered as markdown; user text stays literal so what
    // you typed is exactly what you see.
    const body = document.createElement('div');
    if (role === 'ai' && Aevion.md) Aevion.md.renderInto(body, text);
    else body.textContent = text;
    d.appendChild(body);
    d._body = body;
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
    return d;
  }

  /* live repaint while a model streams tokens: markdown is only re-parsed when
     it is cheap (no open code fence) — the final pass below always renders */
  function paint(el, text) {
    const b = el._body || el;
    if (Aevion.md && Aevion.md.canStream(text)) Aevion.md.renderInto(b, text);
    else b.textContent = text;
    log.scrollTop = log.scrollHeight;
  }

  function paintFinal(el, text) {
    const b = el._body || el;
    if (Aevion.md) Aevion.md.renderInto(b, text);
    else b.textContent = text;
    log.scrollTop = log.scrollHeight;
  }

  /* copy buttons on markdown code blocks (delegated — works for restored history too) */
  log.addEventListener('click', async e => {
    const btn = e.target && e.target.closest ? e.target.closest('.md-code-copy') : null;
    if (!btn) return;
    const codeEl = btn.closest('.md-code')?.querySelector('code');
    const text = (codeEl ? codeEl.textContent : '').replace(/\n$/, '');
    let ok = true;
    try {
      if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
      else throw new Error('no clipboard api');
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand('copy');
        ta.remove();
      } catch { ok = false; }
    }
    btn.textContent = ok ? 'Copied ✓' : 'Copy failed';
    btn.classList.toggle('copied', ok);
    clearTimeout(btn._h);
    btn._h = setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1500);
  });

  function history() { return Aevion.store.get('chatHistory', []); }
  function pushHistory(role, text) {
    const h = history();
    h.push({ role, text, t: Date.now() });
    Aevion.store.set('chatHistory', h.slice(-60));
  }

  /* Attachments ride along with the message: what they are, then the text
     of anything readable, so “summarize this” works with no provider at
     all. The chips are cleared once they have been sent. */
  async function attachPayload(text) {
    const lines = Aevion.attach.describe();
    const content = await Aevion.attach.textAll(6000);
    const n = Aevion.attach.clear();
    renderAttach();
    if (n) toast('📎 ' + n + ' attachment' + (n === 1 ? '' : 's') + ' sent');
    const head = (text ? text + '\n\n' : '') + lines.join('\n');
    return { shown: head, full: head + (content ? '\n\n' + content : '') };
  }

  async function send() {
    const inp = $('#chatInput');
    renderMode();   // decide which brain is on offer before routing anything
    let text = inp.value.trim();
    const attached = Aevion.attach ? Aevion.attach.list() : [];
    if (!text && !attached.length) return;
    if (tmode && text && !text.startsWith('/')) text = 'translate ' + text + ' to ' + (Aevion.settings.lang || 'en');
    inp.value = '';
    inp.style.height = 'auto';
    let shown = text;
    if (attached.length) {
      const p = await attachPayload(text);
      shown = p.shown;
      text = p.full;
    }
    addMsg('user', shown);
    pushHistory('user', shown);

    // plugin commands first
    const pc = Aevion.plugins && Aevion.plugins.commands;
    const cmdKey = Object.keys(pc || {}).find(k => text.toLowerCase().startsWith(k));
    if (cmdKey) {
      try {
        const out = await pc[cmdKey](text);
        reply(out, 'PLUGIN');
      } catch (e) { reply('Plugin error: ' + e.message, 'PLUGIN'); }
      return;
    }

    const route = Aevion.brain.route(text);

    // Open conversation → the configured provider, then (only within the
    // same trust class) its fallback, then the fully offline local brain.
    // There is never a dead end: an AI failure still gets an answer.
    if (route.kind === 'chat' || route.kind === 'math-maybe') {
      const id = Aevion.settings.aiProvider;
      const provider = Aevion.providers.get(id);
      const cloud = provider && provider.kind !== 'local';
      const auto = Aevion.settings.autoAI !== false;
      /* Automatic shifting: while auto-switch is on, the online brain is
         offered only when it is reachable — the network is up and no
         recent failure is still cooling down. Session state only: the
         user's own switches never move, and the HUD says which brain is
         answering. */
      const reachable = !cloud || !auto || Aevion.online.available();
      const usable = provider && (provider.kind === 'local' || (Aevion.settings.onlineAI && reachable)) && !Aevion.providers.missing(id).length;
      /* Why the online brain is not answering, if it is not. One message,
         not two: the reason and the answer travel together, because a chat
         that shows an error and then a reply looks like both of them
         failed. */
      let failReason = '';

      /* Two or more brains, ticked in Settings → More than one brain. It runs
         before the single-brain path and falls through to it if every leg
         fails — a multi-brain message must never be worse than a plain one. */
      const multiIds = Aevion.providers.multiPlan ? Aevion.providers.multiPlan() : [];
      if (multiIds.length >= 2) {
        const strategy = Aevion.providers.brainStrategy();
        const el = addMsg('ai', '…', 'MULTI · ' + multiIds.length + ' BRAINS');
        const t0 = Date.now();
        const messages = [
          { role: 'system', content: Aevion.online.systemPrompt(text) },
          ...history().slice(-10).map(h => ({ role: h.role === 'ai' ? 'assistant' : 'user', content: h.text }))
        ];
        try {
          if (strategy === 'compare') {
            const legs = await Aevion.providers.askMany(multiIds, messages);
            const ok = legs.filter(l => l.ok);
            if (!ok.length) throw new Error(legs.map(l => brainLabel(l.id) + ': ' + l.why).join(' · '));
            const body = ok.map(l => '### ' + brainLabel(l.id) + '\n\n' + l.text).join('\n\n');
            paintFinal(el, body);
            el._meta.textContent = 'MULTI · ' + ok.length + ' OF ' + legs.length + ' ANSWERED · ' + (Date.now() - t0) + ' MS';
            pushHistory('ai', body);
            speakReply(ok[0].text);
            const failed = legs.filter(l => !l.ok);
            if (failed.length) toast('⚠ ' + failed.map(l => brainLabel(l.id)).join(', ') + ' did not answer — the others did', 4500);
          } else {
            const r = await Aevion.providers.askCritique(multiIds, messages, {
              onToken: (_d, full) => paint(el, full)
            });
            if (!r.text) throw new Error(r.legs.map(l => brainLabel(l.id) + ': ' + l.why).join(' · '));
            paintFinal(el, r.text);
            const reviewers = r.legs.filter(l => l.ok && l.reviewed).map(l => brainLabel(l.id));
            el._meta.textContent = (reviewers.length ? 'REVIEWED BY ' + reviewers.join(' + ') : 'ONE BRAIN') +
              ' · ' + (Date.now() - t0) + ' MS';
            pushHistory('ai', r.text);
            speakReply(r.text);
            const failed = r.legs.filter(l => !l.ok);
            if (failed.length) toast('⚠ ' + failed.map(l => brainLabel(l.id)).join(', ') + ' was not reached — the answer stands', 4500);
          }
          log.scrollTop = log.scrollHeight;
          refreshBrain(false);
          return;
        } catch (e) {
          /* Every leg failed: drop the bubble and let the single-brain path
             (provider, then fallback, then the offline brain) answer. */
          el.remove();
        }
      }

      if (usable) {
        const el = addMsg('ai', '…', (provider.label || id).toUpperCase());
        try {
          const messages = [
            { role: 'system', content: Aevion.online.systemPrompt(text) },
            ...history().slice(-10).map(h => ({ role: h.role === 'ai' ? 'assistant' : 'user', content: h.text }))
          ];
          let lastPaint = 0;
          const t0 = Date.now();
          const res = await Aevion.providers.chatWithFallback(messages, {
            onToken: (_d, full) => {
              const now = Date.now();
              if (now - lastPaint > 60) { lastPaint = now; paint(el, full); }
            }
          });
          paintFinal(el, res.text);
          /* The badge names the brain that *actually* answered — which is not
             always the one the placeholder said, and never the one that only
             looked configured. Tools → 🧠 Brain log has the whole chain. */
          if (el._meta) {
            el._meta.textContent = brainShort(res.provider) + ' · ' + (Date.now() - t0) + ' MS' +
              (res.errors.length ? ' · AFTER ' + res.errors.length + ' FAILED' : '');
          }
          pushHistory('ai', res.text);
          speakReply(res.text);
          if (res.errors.length) toast('⚠ ' + res.errors[0]);
          if (auto && cloud && Aevion.online.down()) { Aevion.online.markUp(); applySettings(); toast('🌐 Online AI is back — switched automatically', 3000); }
          log.scrollTop = log.scrollHeight;
          return;
        } catch (e) {
          el.remove();
          if (auto && cloud) {
            const wasDown = Aevion.online.down();
            Aevion.online.markDown(e.message);
            applySettings();
            if (!wasDown) toast('⚠ Online AI unreachable — answering with the offline brain until it comes back', 5000);
          }
          /* the card above the box now names which brain *is* reachable */
          refreshBrain(true);
          failReason = '⚠ ' + e.message +
            '\n\nIt is retried automatically in a minute. To change brain now: Settings → Providers (🧠 Set up AI above the box).';
        }
      } else if (!provider) {
        /* No provider at all is a different situation from a provider that
           failed, and it has its own answer: the card above the box can set
           one up in a tap, so the reply says so instead of pretending the
           message was simply handled. */
        failReason = '⚠ No AI provider is picked yet. The card above the box sets one up in a tap — the in-browser model, a server on this PC, or a free hosted key.';
      } else if (cloud && Aevion.settings.onlineAI && reachable) {
        const miss = Aevion.providers.missing(id);
        failReason = miss.length
          ? '⚠ ' + (provider.label || id) + ' is not set up yet — it still needs ' + miss.join(', ') +
            '. Add them in Settings → Providers and it is used automatically; the offline brain answers meanwhile.'
          : '⚠ ' + (provider.label || id) + ' is not answering — the offline brain will do.';
      } else if (cloud && Aevion.settings.onlineAI && !reachable) {
        const why = (Aevion.online.status() || {}).why || 'the online brain is unreachable';
        failReason = '📴 ' + (why === 'no internet connection' ? 'No internet connection' : why.charAt(0).toUpperCase() + why.slice(1)) +
          '\n\nAnswering from the offline brain, and switching back by itself the moment it returns.';
      } else if (provider && provider.kind !== 'local' && !Aevion.settings.onlineAI) {
        // offline by choice — the local brain answers below, with no notice spam
      }
      const local = await Aevion.brain.handle(text);
      const source = failReason
        ? 'OFFLINE BRAIN · ' + brainShort(id) + ' DID NOT ANSWER'
        : (cloud && !reachable ? 'OFFLINE BRAIN' : 'LOCAL BRAIN');
      reply(failReason ? failReason + '\n\n' + local : local, source);
      return;
    }

    const out = await Aevion.brain.handle(text);
    reply(out, 'LOCAL BRAIN');
  }

  function reply(text, source) {
    addMsg('ai', text, (source || '').toUpperCase());
    pushHistory('ai', text);
    speakReply(text);
  }

  $('#sendBtn').onclick = send;
  $('#chatInput').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  $('#chatInput').addEventListener('input', e => {
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(120, e.target.scrollHeight) + 'px';
  });
  Aevion.on('chat:clear', () => { log.innerHTML = ''; Aevion.store.set('chatHistory', []); });

  /* ============ THE BRAIN CARD ============
     The one question no other screen could answer: a provider is picked, so
     every screen honestly says “Ready” — and then nothing answers. js/setup.js
     does the checking (a GET to a provider you configured, never a prompt);
     this paints it and wires the fixes. It appears when nothing is answering,
     disappears the moment something is, and “Not now” puts it away for the
     session — the Settings button can always reach the same engine. */
  const brainLabel = id => (Aevion.providers.get(id) || {}).label || id || 'that brain';
  /* Short enough for a message badge: “Ollama (your own machine)” is a
     helpful menu entry and a terrible label on every single reply. */
  const brainShort = id => {
    const short = String(brainLabel(id)).split(' (')[0].trim();
    return (short.length > 30 ? short.slice(0, 29) + '…' : short).toUpperCase();
  };
  const BRAIN_FACE = { ready: '✅', unreachable: '⚠️', 'needs-download': '⬇️', unsupported: '🚫', off: '⏸️', needs: '⚙️', test: '🧪' };

  /* Open only when asked. The header pill (LOCAL / OFFLINE AI / ONLINE AI /
     NO BRAIN) is what tells the truth at a glance; a panel that opens itself
     is a popup. */
  function brainShow() {
    return brainWanted;
  }

  /* The one way it opens: a deliberate press — the 🧠 Set up AI shortcut, or
     the same button in Settings. It brings the current survey with it, so the
     list is filled the moment it appears. */
  function openBrainCard() {
    brainWanted = true;
    try { Aevion.store.set(BRAIN_SEEN, true); } catch { /* a read-only store is no reason to fail */ }
    renderBrainCard();
    refreshBrain(true);
    const card = $('#brainCard');
    if (card && !card.hidden && card.scrollIntoView) card.scrollIntoView({ block: 'nearest' });
  }

  function renderBrainCard() {
    /* app.js is evaluated before boot() creates Aevion.settings — that is the
       order this whole file is written in — so every painter has to survive
       the null and simply wait for boot. */
    if (!Aevion.settings) return;
    const card = $('#brainCard');
    const q = Aevion.setup.quick();
    const s = brainSurvey;
    card.hidden = !brainShow();
    if (card.hidden) return;

    const best = s ? s.best : null;
    $('#brainCardTitle').textContent = !s
      ? (q.ok ? 'Checking which brain answers…' : 'No AI is set up yet')
      : (best && best !== s.current ? 'That brain did not answer — this one does'
        : best ? 'Checking which brain answers…' : 'No AI is answering on this device yet');
    $('#brainCardWhy').textContent = s
      ? (best && best !== s.current
        ? brainLabel(s.current) + ' did not answer. ' + brainLabel(best) + ' is answering right now — ' + s.why +
          '. One tap below switches to it; nothing you type is sent anywhere to find out.'
        : 'Nothing this device can reach is answering yet. The offline brain keeps working meanwhile — every language it knows, your memory, and every skill — and none of your text leaves the device.')
      : q.why;

    const list = $('#brainOptions');
    list.innerHTML = '';
    const rows = s ? s.options : [];
    if (!rows.length) {
      const li = document.createElement('li');
      const span = document.createElement('span');
      span.className = 'grow muted';
      span.textContent = 'Asking every brain this device can reach…';
      li.appendChild(span);
      list.appendChild(li);
    }
    rows.forEach(o => {
      const li = document.createElement('li');
      const span = document.createElement('span');
      span.className = 'grow' + (o.state === 'ready' ? '' : ' muted');
      span.textContent = (BRAIN_FACE[o.state] || '•') + ' ' + o.label + (o.free ? ' · free tier' : '') +
        (o.id === (s && s.current) ? ' (set now)' : '') + ' — ' + o.why;
      li.appendChild(span);
      if (o.state === 'ready' && s && o.id !== s.current) {
        const use = document.createElement('button');
        use.textContent = 'Use it';
        use.title = 'Make ' + o.label + ' the brain';
        use.onclick = () => applyBrain(o.id);
        li.appendChild(use);
      }
      list.appendChild(li);
    });

    const gpu = Aevion.webllm.gpuSupported();
    const W = $('#brainInBrowser');
    W.disabled = !gpu;
    W.title = gpu
      ? 'Runs on your GPU — no server, no key, and after the first download it works with no internet at all'
      : 'This browser has no WebGPU, so it cannot run here (Chrome or Edge 113+ on a PC, Chrome 121+ on Android)';
    W.textContent = Aevion.webllm.isReady()
      ? '🧠 Switch to the in-browser model (loaded)'
      : (Aevion.webllm.storedProgress().includes(Aevion.settings.webllmModel)
        ? '🧠 Start the in-browser model (already downloaded)'
        : '🧠 Download the in-browser model (~1 GB, one time)');

    const B = $('#brainBest');
    B.disabled = !best || !!(s && best === s.current);
    B.textContent = best && s && best !== s.current ? '⚡ Use ' + brainLabel(best) : '⚡ Nothing to switch to yet';
    B.title = s && best ? s.why : 'No brain answered';

    $('#brainMachine').disabled = !Aevion.settings.onlineAI;

    /* The free-to-start list comes from the registry, never from a hardcoded
       name here, so adding a provider adds it to this list too. */
    fillBrainFree();
    const freeId = $('#brainFree').value;
    const freeMissing = freeId ? Aevion.providers.missing(freeId) : ['a provider'];
    const freeLabel = (Aevion.providers.get(freeId) || {}).label || 'a free provider';
    $('#brainDocs').textContent = '🔑 ' + freeLabel + (freeMissing.length ? ' — get a free key' : ' — key saved');
    $('#brainKeyRow').hidden = !freeMissing.length;
    $('#brainCardNote').textContent = 'A check only ever asks a provider you already configured “are you there?” — a GET, never a prompt, never your text. With Online AI off, nothing is asked at all and this card is filled in from what is stored here. A free-tier key is issued to your own account (most need just an email, no card); Aevion never creates one and pays for nothing.';
  }

  async function refreshBrain(deep) {
    if (!deep) { renderBrainCard(); return brainSurvey; }
    if (brainBusy) return brainSurvey;
    brainBusy = true;
    const out = $('#brainOut');
    if (out) out.textContent = 'Asking every brain this device can reach…';
    try { brainSurvey = await Aevion.setup.survey(); } catch { /* keep the last survey */ }
    brainBusy = false;
    if (out) out.textContent = '';
    renderBrainCard();
    return brainSurvey;
  }

  async function applyBrain(id, note) {
    let r = null;
    try { r = Aevion.setup.apply(id); } catch (e) { toast('⚠ ' + e.message); return null; }
    if (note) $('#brainOut').textContent = note;
    toast('🧠 ' + r.label + ' is the brain now' + (r.turnedOn ? ' (online AI switched on)' : ''));
    fillAI();
    applySettings();
    await refreshBrain(true);
    /* The refresh borrows #brainOut for its progress line, so putting the
       answer back afterwards is what stops a result vanishing under the
       user's eyes a second after it appeared. */
    if (note) $('#brainOut').textContent = note;
    return r;
  }

  $('#brainBest').onclick = () => { if (brainSurvey && brainSurvey.best) applyBrain(brainSurvey.best); };
  /* The same panel, from Settings. It lives above the chat box because that is
     where a brain is noticed to be missing, and this is the deliberate press
     that opens it — nothing opens it by itself. */
  $('#aiSetup').onclick = () => { show('chat'); openBrainCard(); };
  $('#brainDismiss').onclick = () => {
    brainWanted = false;
    try { Aevion.store.set(BRAIN_SEEN, true); } catch { /* fine */ }
    renderBrainCard();
    toast('Closed for good — Settings → AI provider has the same setup whenever you want it', 4000);
  };

  /* “Look for a server on this PC” is deliberately manual: a page asking your
     own machine to open a port is the user's decision, not a background scan.
     It runs the same survey, so the answer matches the list above it. */
  $('#brainMachine').onclick = async () => {
    const out = $('#brainOut');
    if (!Aevion.settings.onlineAI) {
      out.textContent = '⏸ Online AI is off, so nothing was asked. Turn it on in Settings → Privacy, or use the in-browser model — that one needs no switch and no server at all.';
      return;
    }
    $('#brainMachine').disabled = true;
    out.textContent = 'Looking for a server on this PC — Ollama (port 11434), LM Studio / llama.cpp (port 1234)…';
    let s = null;
    try { s = await Aevion.setup.survey(); } catch { /* reported below */ }
    if (s) brainSurvey = s;
    $('#brainMachine').disabled = false;
    renderBrainCard();
    const hit = s && s.best;
    if (hit && hit !== s.current) return applyBrain(hit, '✅ Found ' + brainLabel(hit) + ' on this PC — ' + s.why + '.');
    if (hit) { out.textContent = '✅ ' + brainLabel(hit) + ' is on this PC and answering — it is already the brain here.'; return; }
    out.textContent = 'Nothing is listening on this PC yet. To make your own machine the brain:\n' +
      '1. Install Ollama from ollama.com (free, no account) and run “ollama serve”.\n' +
      '2. Pull a model once: “ollama pull llama3.2”.\n' +
      '3. Press “Look for a server on this PC” again.\n' +
      'Already running? A web page is only allowed to reach it if the server says so: start it with OLLAMA_ORIGINS=* (LM Studio has the same switch in its server settings).';
  };

  /* ---------- free keys ----------
     Aevion cannot sign up for anybody: a free key belongs to *your* account,
     is rate-limited in your name, and embedding one in the app would leak it.
     So what is made easy here is everything around that one step — which
     provider to pick, the exact page where the key comes from, the right
     endpoint and model already filled in, a test the second it is pasted,
     and an honest failure in the brain log if the provider refuses. */
  const brainFreeSel = $('#brainFree');
  function fillBrainFree() {
    const keep = brainFreeSel.value;
    const ids = Aevion.providers.freeIds();
    /* Rebuilding is cheap, but doing it on every repaint would close an open
       dropdown under the user's finger — so only when the list changed. */
    const had = [...brainFreeSel.options].map(o => o.value).join(',');
    if (had !== ids.join(',')) {
      brainFreeSel.innerHTML = '';
      ids.forEach(id => {
        const o = document.createElement('option');
        o.value = id;
        o.textContent = (Aevion.providers.get(id) || {}).label || id;
        brainFreeSel.appendChild(o);
      });
    }
    const pick = ids.includes(keep) ? keep
      : (ids.includes(Aevion.settings.aiProvider) ? Aevion.settings.aiProvider : ids[0]);
    if (pick) brainFreeSel.value = pick;
  }

  $('#brainDocs').onclick = () => {
    const id = brainFreeSel.value;
    const a = Aevion.providers.get(id);
    const out = $('#brainOut');
    if (!a) { out.textContent = 'No free-tier provider is registered in this build.'; return; }
    const url = a.docs || '';
    const already = Aevion.providers.key(id);
    $('#brainKeyRow').hidden = false;
    out.textContent = (already ? 'A key is already saved for ' : 'Get a key for ') + a.label + ':\n' +
      '1. ' + (url ? 'Open ' + url : 'Open the provider’s API-keys page') + ' in a browser (most need just an email; a few ask for a phone number).\n' +
      '2. Create an API key and copy it.\n' +
      '3. Paste it above and press “Save & use it” — Aevion tests it immediately and switches to it if it answers.\n' +
      '4. The key is stored in this device’s vault (never in a backup or a sync bundle) and every attempt lands in Tools → 🧠 Brain log.' +
      (a.hint ? '\n\n' + a.hint : '');
    /* Opening a link is an action with a side effect, so it happens through
       the same automation permission the rest of the app uses — otherwise the
       URL is simply printed, and nothing opens behind your back. */
    if (url && Aevion.perms.get('automation')) window.open(url, '_blank', 'noopener');
    $('#brainKey').focus();
  };

  $('#brainKeySave').onclick = async () => {
    const id = brainFreeSel.value;
    const a = Aevion.providers.get(id);
    const out = $('#brainOut');
    const key = $('#brainKey').value.trim();
    if (!a) { out.textContent = 'No free-tier provider is registered in this build.'; return; }
    if (!key) { toast('Paste the key first'); return; }
    Aevion.providers.setKey(id, key);
    $('#brainKey').value = '';
    Aevion.set('onlineAI', true);   // the button said what it does; the tap is the consent
    out.textContent = a.label + ': key saved to this device’s vault. Testing it now…';
    try {
      const r = await Aevion.providers.test(id);
      applyBrain(id, '✅ ' + a.label + ' answered in ' + r.ms + ' ms: “' + r.reply + '” — it is the brain now.');
    } catch (e) {
      const why = '⚠ The key was saved, but ' + a.label + ' did not answer: ' + e.message +
        ' Check the endpoint and model in Settings → Providers (both have working defaults), then press “Test connection” there. The attempt is in Tools → 🧠 Brain log.';
      fillAI();
      await refreshBrain(true);
      out.textContent = why;
    }
  };

  /* The in-browser model is the one brain that needs nobody: no server to
     start, no key to paste, no company in the loop. It is also the only one
     that costs a download — so the card shows the real percentage instead of
     a spinner, and keeps the model id so it can be started again later. */
  $('#brainInBrowser').onclick = async () => {
    const out = $('#brainOut');
    if (Aevion.webllm.isReady()) return applyBrain('webllm', '✅ The in-browser model is answering — nothing you type leaves this device.');
    if (!Aevion.webllm.gpuSupported()) {
      out.textContent = 'This browser has no WebGPU, so the in-browser model cannot run here. Chrome or Edge 113+ on a PC (or Chrome 121+ on Android) can. Everything else here still works offline.';
      return;
    }
    const modelId = Aevion.settings.webllmModel;
    const def = Aevion.webllm.MODELS.find(m => m.id === modelId);
    if (def && def.requiresF16 && Aevion.webllm.f16 === false) {
      out.textContent = '❌ “' + modelId + '” needs a newer GPU (shader-f16). Pick one of the q4f32 models in Settings → In-browser AI and press this button again.';
      return;
    }
    $('#brainInBrowser').disabled = true;
    try {
      await Aevion.webllm.load(modelId, p => {
        out.textContent = '⬇️ ' + Math.round((p.progress || 0) * 100) + '% — ' + (p.text || 'downloading the model (once)');
      });
      Aevion.set('webllm', true);
      applyBrain('webllm', '✅ ' + modelId + ' is loaded and answering, fully offline. It stays cached, so this download only ever happens once.');
    } catch (e) {
      /* Two very different failures, and telling them apart matters: a missing
         runtime file cannot be fixed by trying again, a bad connection can. */
      out.textContent = Aevion.webllm.runtimeMissing
        ? '❌ ' + e.message
        : '❌ Load failed: ' + e.message + ' — check the connection and press it again; the download picks up where it stopped.';
    }
    $('#brainInBrowser').disabled = false;
  };

  Aevion.on('setup:surveyed', s => { brainSurvey = s; renderBrainCard(); });
  Aevion.on('online:down', () => { renderBrainCard(); refreshBrain(true); });
  Aevion.on('online:up', () => { renderBrainCard(); refreshBrain(true); });
  Aevion.on('ai:config', () => renderBrainCard());
  renderBrainCard();

  // translator quick-mode
  let tmode = false;
  $('#translateToggle').onclick = () => {
    tmode = !tmode;
    $('#translateToggle').style.color = tmode ? 'var(--accent)' : '';
    $('#chatInput').placeholder = tmode ? 'Translate mode: text… (goes to your language)' : 'Ask Aevion…  (/help for commands)';
  };
  /* ============ ATTACHMENTS (the paperclip) ============
     The button opens the platform's own picker, filtered to the four
     families js/attach.js lists. Nothing is uploaded: the chips below
     the chat are a local record, and only a text-ish file is ever read —
     by the browser, on this device. */
  function renderAttach() {
    const box = $('#attachChips');
    const list = Aevion.attach ? Aevion.attach.list() : [];
    box.innerHTML = '';
    box.hidden = !list.length;
    list.forEach(r => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.title = r.type + ' · ' + Aevion.attach.humanSize(r.size) +
        (r.readable ? ' — text Aevion can read on-device' : ' — description only, never uploaded');
      const face = { photo: '🖼', video: '🎬', pdf: '📕', document: '📄' }[r.kind] || '📎';
      chip.appendChild(document.createTextNode(face + ' ' + r.name + ' · ' + Aevion.attach.humanSize(r.size)));
      const x = document.createElement('button');
      x.textContent = '✕';
      x.className = 'x';
      x.title = 'Remove this attachment';
      x.onclick = () => { Aevion.attach.remove(r.id); renderAttach(); };
      chip.appendChild(x);
      box.appendChild(chip);
    });
  }
  $('#attachBtn').onclick = () => $('#attachInput').click();
  $('#attachInput').onchange = e => {
    let added = 0;
    for (const f of [...(e.target.files || [])]) {
      const rec = Aevion.attach.attach(f);
      if (rec && rec.error) toast('📎 ' + rec.error, 5000);
      else added++;
    }
    e.target.value = '';
    renderAttach();
    if (added) toast('📎 ' + added + ' attached — ask away, or “summarize this” for a text file');
  };
  Aevion.on('attach:changed', renderAttach);
  renderAttach();

  /* ============ QUICK ACTIONS ============
     Every feature is reachable from the menu, but "reachable" and
     "findable" are different things once an app has this many panels.
     One row of one-tap shortcuts keeps the useful half of Aevion one
     press away, and it scrolls sideways instead of wrapping. */
  const QUICK = [
    { label: '💡 What can you do?', send: '/help' },
    { label: '⏱ Timer 5 min', send: 'set a timer for 5 minutes' },
    { label: '📄 Summarize a file', pick: true },
    { label: '📝 Note', fill: 'note: ' },
    { label: '🎯 Task', fill: 'add task: ' },
    { label: '🧭 Best app for…', send: 'best site for learning python' },
    { label: '⚙ Automation report', view: 'tools', then: () => showReport() },
    { label: '🧠 Set up AI', view: 'chat', then: () => openBrainCard() },
    { label: '🌐 Live translate', view: 'voice' },
    { label: '🗣 Teach a word', view: 'voice' },
    { label: '🧩 New plugin', view: 'plugins' }
  ];

  function buildQuick() {
    const box = $('#quickActions');
    box.innerHTML = '';
    QUICK.forEach(q => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'quick-btn';
      b.textContent = q.label;
      b.onclick = () => {
        if (q.send) {
          const inp = $('#chatInput');
          inp.value = q.send;
          inp.dispatchEvent(new Event('input'));
          send();
          return;
        }
        if (q.fill) {
          const inp = $('#chatInput');
          inp.value = q.fill;
          inp.dispatchEvent(new Event('input'));
          inp.focus();
          return;
        }
        if (q.pick) {
          $('#chatInput').value = 'summarize this';
          $('#attachBtn').click();     // the picker, then one press to send
          return;
        }
        if (q.view) { show(q.view); if (q.then) q.then(); }
      };
      box.appendChild(b);
    });
  }
  buildQuick();

  /* Escape does the expected thing wherever you are: back out of the
     confirmation first, then the slide-out menu. */
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    const modal = $('#confirmModal');
    if (modal && !modal.classList.contains('hidden')) { $('#confirmNo').click(); return; }
    if (document.body.classList.contains('nav-open')) setNav(false);
  });

  /* ============ VOICE ============ */
  $('#micBtn').onclick = async () => {
    if (Aevion.voice.listening) { Aevion.voice.stop(); return; }
    try {
      $('#micBtn').classList.add('listening');
      await Aevion.voice.start();
      toast('Listening… speak now');
    } catch (e) {
      $('#micBtn').classList.remove('listening');
      toast('🎤 ' + e.message);
    }
  };
  Aevion.on('voice:end', () => $('#micBtn').classList.remove('listening'));
  Aevion.on('voice:partial', text => { if (text && !live) $('#chatInput').value = text; });
  Aevion.on('voice:error', code => toast('🎤 ' + Aevion.voice.errorText(code)));
  Aevion.on('voice:final', text => {
    if (!text) return;
    if (live) { livePhrase(text); return; }
    $('#chatInput').value = text;
    send();
  });

  /* One place that speaks, so wake mode knows when Aevion is talking —
     that bookkeeping is what makes barge-in possible. */
  function speakReply(text) {
    const clean = Aevion.md ? Aevion.md.toPlain(text) : String(text == null ? '' : text);
    if (Aevion.settings.speak) Aevion.wake.notifySpeaking(clean);
    Aevion.voice.speak(clean);
    /* Muted replies are over the moment they are printed, so close the
       wake-mode speaking window right away instead of faking a delay. */
    if (!Aevion.settings.speak) Aevion.wake.notifyReplyDone();
  }

  /* ============ WAKE MODE (hands-free by name) ============ */
  const WAKE_LABEL = {
    off: 'WAKE OFF', armed: 'WAKE', heard: 'HEARD', capturing: 'LISTENING',
    thinking: 'THINKING', speaking: 'SPEAKING', paused: 'PAUSED'
  };

  /* One renderer for the one set of controls. Two switches driving the same
     microphone is exactly how a UI starts lying about what is listening. */
  function renderWake() {
    const support = Aevion.wake.supported();
    const on = !!Aevion.settings.wake;
    const state = Aevion.wake.state();

    $('#wakeName').textContent = Aevion.settings.name || 'Aevion';
    $('#setWakeOn').checked = on;
    $('#setWakeOn').disabled = !support.ok;
    $('#voiceToggle').disabled = on || !support.ok;
    $('#voiceStop').disabled = !on;
    $('#inputState').textContent = WAKE_LABEL[state] || state;
    $('#wakeWarn').hidden = support.ok;
    if (!support.ok) $('#wakeWarn').textContent = support.reason;

    /* The nickname lives in three places at once — the switch label, the
       hint under it and the two inputs — so they are all written here
       rather than hoping someone repaints after a change. The field the
       user is typing in is left alone. */
    const nick = (Aevion.settings.name || 'Aevion');
    const nickInput = $('#setNickname');
    if (nickInput && document.activeElement !== nickInput) nickInput.value = nick;
    const nickEx = $('#nickExample');
    if (nickEx) nickEx.textContent = nick;

    /* Both pills are buttons, so say what pressing one will do. */
    const listening = on && state !== 'off';
    const hint = 'Hands-free ' + (listening ? 'is on (' + (WAKE_LABEL[state] || state) + ')' : 'is off') +
      ' — tap to turn hands-free ' + (listening ? 'off' : 'on');
    [$('#hudWake'), $('#inputState')].forEach(el => {
      if (!el) return;
      el.title = hint;
      el.setAttribute('aria-label', hint);
      el.setAttribute('aria-pressed', String(listening));
    });

    const pill = $('#hudWake');
    pill.textContent = WAKE_LABEL[state] || 'WAKE';
    pill.className = 'pill wake-' + state;
    pill.classList.toggle('hidden', state === 'off' && !on);
  }

  async function wakeOn() {
    try {
      await Aevion.wake.enable();
      toast('Hands-free on — say "' + (Aevion.settings.name || 'Aevion') + '" and ask');
      return true;
    } catch (err) {
      toast('🎤 ' + err.message);
      return false;
    } finally {
      renderWake();
    }
  }

  $('#setWakeOn').onchange = e => {
    if (e.target.checked) wakeOn().then(ok => { if (!ok) e.target.checked = false; renderWake(); });
    else { Aevion.wake.disable('switched off by the user'); renderWake(); }
  };
  $('#voiceToggle').onclick = () => wakeOn();
  $('#voiceStop').onclick = () => {
    Aevion.wake.disable('stopped by the user');
    toast('Voice input stopped — the microphone is closed');
    renderWake();
  };

  /* The status pills are the thing people look at — and tap — when they
     want the microphone gone, so they do the obvious thing instead of
     sitting there as decoration. */
  function toggleWake() {
    if (Aevion.settings.wake && Aevion.wake.state() !== 'off') {
      Aevion.wake.disable('stopped from the status pill');
      toast('Hands-free off — the microphone is closed');
      renderWake();
      return;
    }
    wakeOn();
  }
  $('#hudWake').onclick = toggleWake;
  $('#inputState').onclick = toggleWake;

  /* When hands-free stops itself, say why. A switch that silently falls
     back to “off” is exactly how a control starts looking broken. */
  Aevion.on('wake:state', p => {
    renderWake();
    if (!p || p.state !== 'off' || p.from === 'off') return;
    const why = p.reason || '';
    if (/user|disabled/i.test(why)) return;   // they turned it off; no lecture
    toast('⏸ Hands-free stopped — ' + why, 5000);
  });
  Aevion.on('wake:heard', () => {
    $('#micBtn').classList.add('listening');
    toast('👂 Yes?');
    /* An audible cue, because hands-free means the user is not looking at
       the screen. `true` makes it play even when replies are muted. */
    Aevion.voice.speak('Yes?', true);
  });
  Aevion.on('wake:command', ({ text }) => {
    $('#micBtn').classList.remove('listening');
    $('#chatInput').value = text;
    send();
  });
  Aevion.on('wake:barged', ({ action }) => {
    $('#micBtn').classList.remove('listening');
    if (action === 'stop') toast('⏹ Stopped');
  });
  Aevion.on('wake:error', e => toast('🎤 ' + (e.text || e.code)));
  Aevion.on('wake:timeout', () => {
    $('#micBtn').classList.remove('listening');
    toast('No request heard — still listening for the name');
  });
  Aevion.on('wake:idle', () => {
    renderWake();
    $('#micBtn').classList.remove('listening');
    toast('Wake mode stopped itself to save battery — toggle it back on any time');
  });

  /* Nobody is talking to a hidden page — unless the user asked Aevion to
     keep working in the background. Then the name stays armed and, on
     return, every timer and the day's learning catch up in one pass. */
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (!Aevion.settings.background) Aevion.wake.pause('page hidden');
      return;
    }
    Aevion.wake.resume();
    const late = Aevion.tools.timers.rearm();
    if (late) toast('⏰ ' + late + ' timer' + (late === 1 ? '' : 's') + ' came due while you were away', 6000);
    if (Aevion.settings.background && Aevion.evolve.due()) Aevion.evolve.learn();
  });

  /* ============ STUDIO ============ */
  // tabs
  $$('#studioTabs .tab').forEach(t => t.onclick = () => {
    $$('#studioTabs .tab').forEach(x => x.classList.toggle('active', x === t));
    $$('#view-studio .tp').forEach(p => p.classList.toggle('active', p.dataset.tp === t.dataset.tp));
  });

  // quiz
  $('#quizBtn').onclick = () => {
    const topic = $('#quizTopic').value.trim() || 'general knowledge';
    const qs = Aevion.skills.quiz(topic);
    $('#quizOut').textContent = qs.map((q, i) => `Q${i + 1}. ${q[0]}\n   → ${q[1]}`).join('\n\n');
  };

  // summarize
  $('#summBtn').onclick = () => {
    const t = $('#summIn').value.trim();
    if (!t) return toast('Paste some text first');
    $('#summOut').textContent = Aevion.skills.summarize(t, $('#summLen').value);
  };

  // flashcards
  let decks = Aevion.store.get('fcDecks', {});
  let review = null, reviewIdx = 0, flipped = false;
  function saveDecks() { Aevion.store.set('fcDecks', decks); }
  function refreshDecks() {
    const sel = $('#fcDeckSel');
    sel.innerHTML = '';
    Object.keys(decks).forEach(d => {
      const o = document.createElement('option');
      o.value = d; o.textContent = d + ` (${decks[d].length})`;
      sel.appendChild(o);
    });
    $('#fcCount').textContent = Object.keys(decks).length + ' deck(s)';
  }
  $('#fcNew').onclick = () => {
    const n = $('#fcDeck').value.trim();
    if (!n) return toast('Name the deck first');
    decks[n] = decks[n] || []; saveDecks(); refreshDecks();
    $('#fcDeckSel').value = n; toast('Deck "' + n + '" ready');
  };
  $('#fcAdd').onclick = () => {
    const d = $('#fcDeckSel').value, f = $('#fcFront').value.trim(), b = $('#fcBack').value.trim();
    if (!d || !f || !b) return toast('Pick a deck and fill both sides');
    decks[d].push({ f, b }); saveDecks(); refreshDecks();
    $('#fcFront').value = ''; $('#fcBack').value = ''; toast('Card added');
  };
  $('#fcStart').onclick = () => {
    const d = $('#fcDeckSel').value;
    if (!d || !decks[d].length) return toast('Add cards first');
    review = decks[d]; reviewIdx = 0; flipped = false;
    $('#fcReview').textContent = `Q: ${review[0].f}`;
  };
  $('#fcFlip').onclick = () => {
    if (!review) return toast('Start a review first');
    flipped = !flipped;
    $('#fcReview').textContent = flipped ? `A: ${review[reviewIdx].b}` : `Q: ${review[reviewIdx].f}`;
  };
  $('#fcNext').onclick = () => {
    if (!review) return toast('Start a review first');
    reviewIdx = (reviewIdx + 1) % review.length; flipped = false;
    $('#fcReview').textContent = `Q: ${review[reviewIdx].f}`;
  };
  refreshDecks();

  // pomodoro
  let pomoLeft = 25 * 60, pomoTimer = null;
  function pomoRender() {
    $('#pomoTime').textContent = `${String(Math.floor(pomoLeft / 60)).padStart(2, '0')}:${String(pomoLeft % 60).padStart(2, '0')}`;
  }
  $('#pomoStart').onclick = () => {
    if (pomoTimer) return;
    pomoTimer = setInterval(() => {
      pomoLeft--; pomoRender();
      if (pomoLeft <= 0) {
        clearInterval(pomoTimer); pomoTimer = null;
        speakReply('Focus session complete. Take a break.');
        toast('⏰ Session complete!');
      }
    }, 1000);
  };
  $('#pomoPause').onclick = () => { clearInterval(pomoTimer); pomoTimer = null; };
  $('#pomoReset').onclick = () => {
    clearInterval(pomoTimer); pomoTimer = null;
    pomoLeft = parseInt($('#pomoMode').value) * 60; pomoRender();
  };
  $('#pomoMode').onchange = () => $('#pomoReset').click();
  pomoRender();

  // code tools
  const langSel = $('#langSel');
  Aevion.skills.codeLangs().forEach(l => {
    const o = document.createElement('option'); o.value = l; o.textContent = l; langSel.appendChild(o);
  });
  langSel.onchange = () => $('#langOut').textContent = Aevion.skills.codeNote(langSel.value);
  langSel.onchange();
  $('#codeBtn').onclick = () => {
    const c = $('#codeIn').value.trim();
    if (!c) return toast('Paste code first');
    $('#codeOut').textContent = Aevion.skills.explainCode(c);
  };

  /* ============ ORGANIZER ============ */
  function renderList(el, items, delFn, extraBtns) {
    el.innerHTML = '';
    items.forEach((it, i) => {
      const li = document.createElement('li');
      const span = document.createElement('span');
      span.className = 'grow';
      span.textContent = it.label + (it.due ? '  📅 ' + it.due : '');
      if (it.done) span.style.textDecoration = 'line-through';
      li.appendChild(span);
      (extraBtns || []).forEach(([lbl, fn]) => {
        const b = document.createElement('button'); b.textContent = lbl; b.className = 'x';
        b.onclick = () => fn(i); li.appendChild(b);
      });
      const x = document.createElement('button'); x.textContent = '✕'; x.className = 'x';
      x.onclick = () => delFn(i); li.appendChild(x);
      el.appendChild(li);
    });
  }

  let tasks = Aevion.store.get('tasks', []);
  function renderTasks() { renderList($('#taskList'), tasks, i => { tasks.splice(i, 1); saveTasks(); }, [['✓', i => { tasks[i].done = !tasks[i].done; saveTasks(); }]]); }
  function saveTasks() { Aevion.store.set('tasks', tasks); renderTasks(); }
  $('#taskAdd').onclick = () => {
    const v = $('#taskIn').value.trim();
    if (!v) return;
    tasks.push({ label: v, due: $('#taskDue').value || '', done: false, t: Date.now() });
    $('#taskIn').value = ''; saveTasks();
  };

  let notes = Aevion.store.get('notes', []);
  function renderNotes() { renderList($('#noteList'), notes, i => { notes.splice(i, 1); saveNotes(); }); }
  function saveNotes() { Aevion.store.set('notes', notes); renderNotes(); }
  $('#noteAdd').onclick = () => {
    const v = $('#noteIn').value.trim();
    if (!v) return;
    notes.unshift({ label: new Date().toLocaleString() + ' — ' + v });
    $('#noteIn').value = ''; saveNotes();
  };
  renderTasks(); renderNotes();

  /* ============ FILES VAULT ============ */
  let files = Aevion.store.get('files', []);
  function renderFiles() {
    const el = $('#fileList');
    el.innerHTML = '';
    files.forEach((f, i) => {
      const li = document.createElement('li');
      const s = document.createElement('span'); s.className = 'grow';
      s.textContent = `${f.name} (${(f.size / 1024).toFixed(1)} KB)`;
      li.appendChild(s);
      const dl = document.createElement('button'); dl.textContent = '⬇'; dl.title = 'Download';
      dl.onclick = () => {
        const a = document.createElement('a');
        a.href = f.data; a.download = f.name; a.click();
      };
      li.appendChild(dl);
      const x = document.createElement('button'); x.textContent = '✕'; x.className = 'x';
      x.onclick = () => { files.splice(i, 1); saveFiles(); };
      li.appendChild(x);
      el.appendChild(li);
    });
  }
  function saveFiles() { try { Aevion.store.set('files', files); } catch (e) { toast('Storage full — remove some files'); } renderFiles(); }
  $('#filePick').onchange = e => {
    [...e.target.files].forEach(f => {
      if (f.size > 2 * 1024 * 1024) { toast(`"${f.name}" is over 2 MB — skipped (browser storage limit)`); return; }
      const r = new FileReader();
      r.onload = () => { files.push({ name: f.name, size: f.size, type: f.type, data: r.result, t: Date.now() }); saveFiles(); };
      r.readAsDataURL(f);
    });
    e.target.value = '';
  };
  $('#filesClear').onclick = () => {
    if (!confirm('Delete ALL files in the vault?')) return;
    files = []; saveFiles(); toast('Vault cleared');
  };
  renderFiles();

  /* ============ AUTOMATIONS ============ */
  let autos = Aevion.store.get('autos', []);
  async function runAuto(a) {
    const map = { greet: 'greet me', weather: 'weather', time: 'what time is it' };
    const out = await Aevion.brain.handle(map[a.what] || a.what);
    addMsg('ai', `⚡ Automation (${a.when}): ${out}`, 'AUTOMATION');
    speakReply(out);
  }
  function renderAutos() {
    const el = $('#autoList');
    el.innerHTML = '';
    autos.forEach((a, i) => {
      const li = document.createElement('li');
      const s = document.createElement('span'); s.className = 'grow';
      s.textContent = `When ${a.when} → ${a.what}`;
      li.appendChild(s);
      const run = document.createElement('button'); run.textContent = '▶';
      run.onclick = () => runAuto(a); li.appendChild(run);
      const x = document.createElement('button'); x.textContent = '✕'; x.className = 'x';
      x.onclick = () => { autos.splice(i, 1); saveAutos(); }; li.appendChild(x);
      el.appendChild(li);
    });
  }
  function saveAutos() { Aevion.store.set('autos', autos); renderAutos(); }
  $('#autoAdd').onclick = () => {
    autos.push({ id: Aevion.randomId(), when: $('#autoWhen').value, what: $('#autoWhat').value });
    saveAutos(); toast('Automation added');
  };
  renderAutos();

  /* ============ DEVICES / PAIRING ============ */

  /* "Copy the theme and everything" — within limits, and the limits are
     the point. Only the keys that describe how Aevion looks and speaks
     travel across: a bundle from another device must never be able to
     widen this one's permissions, install a key, or change the PIN. */
  const APPEARANCE_KEYS = [
    'theme', 'themeCustom', 'followDevice', 'name', 'persona', 'lang', 'speechLang',
    'speechInterim', 'voiceURI', 'ttsRate', 'ttsPitch', 'speak', 'background', 'navCollapsed'
  ];
  function copyAppearance(from) {
    if (!from || typeof from !== 'object') return [];
    const stored = Object.assign({}, Aevion.store.get('settings', {}) || {});
    const moved = [];
    for (const k of APPEARANCE_KEYS) {
      if (from[k] === undefined) continue;
      stored[k] = from[k];
      moved.push(k);
    }
    Aevion.store.set('settings', stored);
    return moved;
  }

  function renderDevices() {
    const devs = Aevion.store.get('devices', []);
    const el = $('#deviceList');
    el.innerHTML = '';
    if (!devs.length) { el.innerHTML = '<li><span class="grow muted">No devices paired yet.</span></li>'; return; }
    devs.forEach((d, i) => {
      const li = document.createElement('li');
      const s = document.createElement('span'); s.className = 'grow';
      s.textContent = `${d.label} · ${d.id.slice(0, 8)}… · paired ${new Date(d.pairedAt).toLocaleDateString()}`;
      li.appendChild(s);
      const x = document.createElement('button'); x.textContent = '✕'; x.className = 'x';
      x.onclick = () => { devs.splice(i, 1); Aevion.store.set('devices', devs); renderDevices(); };
      li.appendChild(x);
      el.appendChild(li);
    });
  }
  $('#pairGen').onclick = async () => {
    const p = $('#pairPass1').value;
    if (p.length < 8) return toast('Use at least 8 characters');
    Aevion.set('pairHash', await Aevion.hash(p));
    Aevion.set('pairPub', Aevion.randomId());
    $('#pairPass1').value = '';
    const devs = Aevion.store.get('devices', []);
    if (!devs.length) { devs.push({ id: Aevion.identity.id(), label: Aevion.identity.label() + ' (this device)', pairedAt: Date.now() }); Aevion.store.set('devices', devs); }
    renderDevices();
    $('#syncOut').textContent = '✅ Pairing key created locally. Export a bundle to move data to your other device.';
  };
  $('#exportSync').onclick = () => {
    const bundle = {
      app: 'aevion', v: Aevion.version,
      from: { id: Aevion.identity.id(), label: Aevion.identity.label() },
      exported: new Date().toISOString(),
      data: Aevion.store.dumpSafe()   // credentials never travel in a bundle
    };
    const blob = new Blob([JSON.stringify(bundle)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'aevion-sync-' + Date.now() + '.aevion';
    a.click();
    $('#syncOut').textContent = '📦 Bundle exported. Move it to your other device (USB, nearby share, email to yourself) and import there.';
  };
  $('#importSync').onclick = () => $('#syncFile').click();
  $('#syncFile').onchange = e => {
    const f = e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = async () => {
      if (!Aevion.settings.pairHash) { $('#syncOut').textContent = '❌ Create a pairing password first (that IS your authorization).'; return; }
      const pass = prompt('Enter your pairing password to authorize sync:');
      if (pass === null) return;
      if (await Aevion.hash(pass) !== Aevion.settings.pairHash) { $('#syncOut').textContent = '❌ Wrong pairing password.'; return; }
      try {
        const bundle = JSON.parse(r.result);
        if (bundle.app !== 'aevion') throw new Error('Not an Aevion bundle');
        const devs = Aevion.store.get('devices', []);
        if (!devs.some(d => d.id === bundle.from.id)) {
          devs.push({ id: bundle.from.id, label: bundle.from.label + ' (remote)', pairedAt: Date.now() });
          Aevion.store.set('devices', devs);
        }
        // merge, prefer newest memory/tasks/notes entries
        Aevion.store.load(bundle.data);
        const moved = $('#pairCopyTheme').checked ? copyAppearance(bundle.data.settings) : [];
        $('#syncOut').textContent = `✅ Imported ${Object.keys(bundle.data).length} data sections from ${bundle.from.label} (${bundle.exported}).` +
          (moved.length
            ? ` Copied the theme and ${moved.length} appearance setting${moved.length === 1 ? '' : 's'} from that device.`
            : ' Appearance was left untouched — permissions, keys and your PIN never travel.') +
          ' Reloading…';
        renderDevices();
        setTimeout(() => location.reload(), 1500);
      } catch (err) {
        $('#syncOut').textContent = '❌ Import failed: ' + err.message;
      }
    };
    r.readAsText(f);
    e.target.value = '';
  };
  renderDevices();

  /* ============ PLUGINS ============
     The registry itself lives in js/plugins.js (so the tests can drive it
     without a DOM). This view renders it and adds the no-code form. */
  function renderPlugins() {
    const el = $('#pluginList');
    el.innerHTML = '';
    const list = Aevion.plugins.describe();
    const clashes = new Map(Aevion.plugins.collisions().map(c => [c.trigger, c.owners.join(' / ')]));
    if (!list.length) {
      el.innerHTML = '<li><span class="grow muted">Nothing loaded yet.</span></li>';
      return;
    }
    list.forEach(p => {
      // textContent, not innerHTML: plugin metadata is data, not markup
      const li = document.createElement('li');
      const span = document.createElement('span');
      span.className = 'grow';
      const b = document.createElement('b');
      b.textContent = p.name || '(unnamed)';
      span.appendChild(b);
      span.appendChild(document.createTextNode(' — ' + (p.desc || '')));
      if (p.ai) {
        const b = Aevion.plugins.brainFor(p);
        const aiNote = document.createElement('span');
        aiNote.className = 'muted small';
        aiNote.textContent = ' · 🧠 asks ' + (b ? b.label : 'your AI') +
          (p.ai === 'auto' ? ' (whichever brain you pick in Settings)' : '') +
          ', falling back to your text when no brain answers';
        span.appendChild(aiNote);
      }
      if (p.target) {
        const link = document.createElement('span');
        link.className = 'muted small';
        link.textContent = ' · 🔗 opens ' + p.target + (p.fallback ? ' (falls back to ' + p.fallback + ')' : '') + ' — asks every time';
        span.appendChild(link);
      }
      const keys = p.triggers || p.commands || [];
      if (keys.length) {
        span.appendChild(document.createElement('br'));
        const small = document.createElement('span');
        small.className = 'muted small';
        small.textContent = (p.kind === 'simple' ? 'Triggers: ' : 'Commands: ') +
          keys.map(k => clashes.has(String(k).toLowerCase()) ? k + ' ⚠ (also used by ' + clashes.get(String(k).toLowerCase()) + ')' : k).join(', ');
        span.appendChild(small);
      }
      li.appendChild(span);
      if (p.kind === 'simple') {
        const x = document.createElement('button');
        x.textContent = '✕';
        x.className = 'x';
        x.title = 'Delete this plugin';
        x.onclick = () => { Aevion.plugins.remove(p.name); toast('Plugin removed'); };
        li.appendChild(x);
      }
      el.appendChild(li);
    });
  }
  /* ---------- where Aevion has already taken you ----------
     The honest half of “plug into whatever I install or search for”: a page
     cannot see your installed apps or your browsing history, but it *does*
     know every place Aevion opened for you, because it opened it. One tap
     turns one of those into a plugin — the search box becomes {query}, so the
     plugin works for any search, not just tonight’s. */
  function renderRecents() {
    const el = $('#recentList');
    if (!el || !Aevion.apps) return;
    el.innerHTML = '';
    const list = Aevion.apps.recents();
    if (!list.length) {
      el.innerHTML = '<li><span class="grow muted">Nothing yet. Ask Aevion to “search the web for …” or “best site for …”, then come back — whatever it opened is listed here, ready to plug in.</span></li>';
      return;
    }
    list.forEach(r => {
      const li = document.createElement('li');
      const span = document.createElement('span');
      span.className = 'grow';
      const b = document.createElement('b');
      b.textContent = r.name || r.host || 'Link';
      span.appendChild(b);
      const small = document.createElement('span');
      small.className = 'muted small';
      small.textContent = ' — ' + Aevion.apps.template(r.url, r.query) +
        (r.query ? '   (you searched “' + r.query + '”)' : '');
      span.appendChild(small);
      li.appendChild(span);
      const plug = document.createElement('button');
      plug.type = 'button';
      plug.className = 'btn';
      plug.textContent = '🔌 Plug in';
      plug.title = 'Save this as a plugin Aevion can run by name';
      plug.onclick = () => {
        const made = Aevion.apps.plug(r);
        const out = $('#appOut');
        if (made && made.error) { out.textContent = '❌ ' + made.error; return; }
        out.textContent = '✅ “' + made.name + '” is plugged in — the trigger is “' + made.triggers[0] +
          '”, so “' + made.triggers[0] + ' your words” opens ' + made.target + (/{query}/.test(made.target)
            ? ' with your words in the search box' : '') + '. It asks for permission the same way every link does.';
      };
      li.appendChild(plug);
      el.appendChild(li);
    });
  }

  /* ---------- the apps actually installed (Android) ----------
     On the phone this is a real list read through the native Apps plugin, and
     choosing one saves a plugin that starts that app by name. In a browser
     tab there is no such API, so the panel says so in one sentence and offers
     the address form instead — never a silent failure, never a stack trace. */
  async function renderApps() {
    const out = $('#appOut');
    const list = $('#appList');
    if (!out || !list || !Aevion.apps) return;
    list.innerHTML = '';
    if (!Aevion.apps.supported()) {
      out.textContent = '📱 ' + Aevion.apps.whyNotHere();
      return;
    }
    out.textContent = 'Looking through the apps installed on this device…';
    const r = await Aevion.apps.listInstalled();
    if (!r.ok) { out.textContent = '⚠ ' + r.why; return; }
    out.textContent = '📱 ' + r.items.length + ' apps can be started by Aevion. Pick one and it becomes a plugin — say its name and it opens.';
    r.items.forEach(a => {
      const li = document.createElement('li');
      const span = document.createElement('span');
      span.className = 'grow';
      const b = document.createElement('b');
      b.textContent = a.name;
      span.appendChild(b);
      const small = document.createElement('span');
      small.className = 'muted small';
      small.textContent = ' — ' + a.id;
      span.appendChild(small);
      li.appendChild(span);
      const plug = document.createElement('button');
      plug.type = 'button';
      plug.className = 'btn';
      plug.textContent = '🔌 Plug in';
      plug.onclick = () => {
        const word = (a.name.toLowerCase().match(/[a-z0-9]+/g) || []).slice(0, 2).join(' ') || 'open';
        const made = Aevion.plugins.addSimple({
          name: a.name,
          desc: 'An app installed on this device',
          triggers: [word, a.name.toLowerCase()],
          app: a.id,
          target: a.url || '',
          reply: 'Opening ' + a.name + '.'
        });
        out.textContent = (made && made.error)
          ? '❌ ' + made.error
          : '✅ “' + made.name + '” is plugged in — say “' + made.triggers[0] + '” and Aevion starts it. No web page is involved.';
      };
      li.appendChild(plug);
      list.appendChild(li);
    });
  }
  $('#appScan').onclick = () => { renderApps(); };
  Aevion.on('apps:recent', renderRecents);
  renderRecents();
  window.addEventListener('load', renderRecents);

  $('#pluginSave').onclick = () => {
    const spec = {
      name: $('#pluginName').value,
      triggers: $('#pluginTriggers').value.split(',').map(s => s.trim()).filter(Boolean),
      reply: $('#pluginReply').value,
      target: $('#pluginTarget').value,
      app: $('#pluginApp').value,
      ai: $('#pluginAI').value
    };
    const r = Aevion.plugins.addSimple(spec);
    if (r.error) { $('#pluginOut').textContent = '❌ ' + r.error; return; }
    $('#pluginName').value = ''; $('#pluginTriggers').value = ''; $('#pluginReply').value = ''; $('#pluginTarget').value = ''; $('#pluginApp').value = ''; $('#pluginAI').value = '';
    $('#pluginOut').textContent = r.target
      ? '✅ “' + r.name + '” is live — it opens ' + r.target + ' (asking your permission each time, as any link does). Try typing: ' + r.triggers[0] + ' hello'
      : (r.ai
        ? '✅ “' + r.name + '” is live — it will ask your AI for a better answer, and fall back to your text whenever no brain is reachable. Try typing: ' + r.triggers[0] + ' hello'
        : '✅ “' + r.name + '” is live. Try typing: ' + r.triggers[0] + ' hello');
    if (r.ai) {
      const b = Aevion.plugins.brainFor(r);
      const id = (b && b.id) || Aevion.settings.aiProvider;
      const miss = Aevion.providers.missing(id);
      if (miss.length) $('#pluginOut').textContent += ' ⚠ ' + brainLabel(id) + ' still needs ' + miss.join(', ') + ' — add it in Settings → Providers, or press “🧠 Set up AI”.';
    }
  };

  /* Which brain a plugin asks is part of the plugin, so the “Answer with” list
     is built from the registry: “auto” follows whichever brain you picked in
     Settings, and every provider can be named exactly — the in-browser model,
     a server on this PC, or one hosted key. */
  const pluginAI = $('#pluginAI');
  Aevion.providers.list.forEach(a => {
    if (a.id === 'mock') return;              // a canned reply is not a brain
    const o = document.createElement('option');
    o.value = a.id;
    o.textContent = 'Your AI — ' + a.label + (a.kind === 'local' ? ' (on this device)' : a.kind === 'loopback' ? ' (your machine)' : a.free ? ' · free tier' : '');
    pluginAI.appendChild(o);
  });
  /* Same rule as every other painter in this file: app.js is evaluated
     before boot() creates Aevion.settings, so a top-level call has to wait
     for it rather than throw and take the rest of the file (boot included)
     down with it. */
  function pluginBrainLabel() {
    const auto = $('#pluginAIAuto');
    if (!auto || !Aevion.settings) return;
    auto.textContent = 'Your AI — ' + brainLabel(Aevion.settings.aiProvider) + ', whichever brain Settings picks';
  }
  pluginBrainLabel();
  Aevion.on('ai:config', pluginBrainLabel);
  window.addEventListener('load', pluginBrainLabel);   // after boot(), when the picker is real

  /* One button, one honest question: does a brain actually answer this
     plugin? It sends the same thing the chat would — a made-up sample, never
     your real text — through the same gates and the same fallback, and then
     says which of the two answered: the brain, or your saved reply. */
  $('#pluginTest').onclick = async () => {
    const out = $('#pluginOut');
    const spec = {
      name: $('#pluginName').value.trim() || 'This plugin',
      triggers: $('#pluginTriggers').value.split(',').map(s => s.trim()).filter(Boolean),
      reply: $('#pluginReply').value.trim(),
      target: $('#pluginTarget').value.trim(),
      app: $('#pluginApp').value.trim(),
      ai: pluginAI.value
    };
    if (!spec.reply && !spec.target && !spec.app) { out.textContent = '❌ Fill in the reply — or an https link to open, or an app package to start. Without one of them there is nothing for the plugin to do.'; return; }
    const preview = '「' + (spec.reply || '').replace(/\{query\}/g, '…') + '」';
    /* A link or app plugin is an action, so a “test” would mean opening
       something: that is exactly what the confirm prompt in the chat is for.
       What it *can* check is the address itself, filled with a made-up query
       — the same rules the open tool applies — so a typo is caught here
       instead of at the moment you ask for it. */
    if (spec.target || spec.app) {
      const check = spec.target ? Aevion.plugins.checkLink(spec, 'example words') : { ok: true, url: '' };
      if (!check.ok) { out.textContent = '❌ That link would not work — ' + check.why + '. Nothing was opened.'; return; }
      out.textContent = '🔗 This is an action plugin — nothing has been opened by this test. Typing “' +
        (spec.triggers[0] || 'hello') + ' your words” will ' +
        (spec.app && Aevion.apps && Aevion.apps.supported()
          ? 'start ' + spec.app + ' on this device'
          : (spec.target ? 'open ' + check.url + ' after you approve it' : 'try to start ' + spec.app + ' (which needs the Aevion Android app)')) +
        '.' + (spec.app && Aevion.apps && !Aevion.apps.supported() ? ' Starting an app needs Android, so here the address above is what opens.' : '') +
        ' The confirm prompt every link gets is still shown at that moment.';
      return;
    }
    if (!spec.ai) { out.textContent = '🧩 “My text” is the whole answer and needs no brain: ' + preview; return; }
    const b = Aevion.plugins.brainFor(spec);
    out.textContent = '🧠 Asking ' + (b ? b.label : 'your AI') + '…';
    const better = await Aevion.plugins.askAI(spec, (spec.triggers[0] || 'hello') + ' — does this work?');
    if (better) { out.textContent = '✅ ' + (b ? b.label : 'Your AI') + ' answered: ' + better; return; }
    out.textContent = '⚠ No brain answered — ' + (Aevion.plugins.lastWhy || 'nothing was reachable') + '. The plugin still works — it answers with ' + preview +
      '. Fix the brain in Settings → Providers, or press “🧠 Set up AI” in the chat.';
  };
  Aevion.on('plugins:changed', renderPlugins);
  /* When an AI-backed plugin had to answer from its own text, say so once —
     otherwise “your AI” quietly becomes “your text” and nobody knows. */
  Aevion.on('plugins:ai-fallback', p => toast('🧠 ' + p.name + ' answered from your saved text — ' + p.why, 5000));
  renderPlugins();
  // hello-world registers itself after this point via its own file; re-render on load
  window.addEventListener('load', renderPlugins);

  /* ============ MEMORY ============ */
  const LAYER_ORDER = ['session', 'history', 'longterm', 'prefs', 'temp'];

  function renderMemory() {
    const stats = Aevion.memory.stats();

    const layers = $('#memLayers');
    layers.innerHTML = '';
    LAYER_ORDER.forEach(l => {
      const def = Aevion.memory.LAYERS[l];
      const li = document.createElement('li');
      const s = document.createElement('span');
      s.className = 'grow';
      s.textContent = `${def.label} — ${stats[l].count}/${def.cap}`;
      li.appendChild(s);
      const b = document.createElement('button');
      b.textContent = 'Clear';
      b.className = 'toggle';
      b.onclick = () => {
        if (!confirm(`Clear “${def.label}”? This cannot be undone.`)) return;
        Aevion.memory.clear(l);
        if (l === 'history') Aevion.emit('chat:clear');
        renderMemory();
      };
      li.appendChild(b);
      layers.appendChild(li);
    });

    const facts = $('#memList');
    facts.innerHTML = '';
    const items = Aevion.memory.all('longterm');
    if (!items.length) {
      facts.innerHTML = '<li><span class="grow muted">Nothing saved yet. Ask Aevion to “remember: …” or add one above.</span></li>';
    } else {
      items.slice().reverse().slice(0, 60).forEach(i => {
        const li = document.createElement('li');
        const s = document.createElement('span');
        s.className = 'grow';
        s.textContent = i.text + (i.tag && i.tag !== 'fact' ? `  (${i.tag})` : '');
        li.appendChild(s);
        const x = document.createElement('button');
        x.textContent = '✕';
        x.className = 'x';
        x.title = 'Forget this';
        x.onclick = () => { Aevion.memory.remove(i.id, 'longterm'); renderMemory(); };
        li.appendChild(x);
        facts.appendChild(li);
      });
    }

    const pend = Aevion.memory.pending();
    $('#memPendingCount').textContent = pend.length ? `${pend.length} waiting` : 'none waiting';
    const pel = $('#memPending');
    pel.innerHTML = '';
    if (!pend.length) {
      pel.innerHTML = '<li><span class="grow muted">Nothing waiting for approval.</span></li>';
    } else {
      pend.forEach(p => {
        const li = document.createElement('li');
        const s = document.createElement('span');
        s.className = 'grow';
        s.textContent = p.text;
        li.appendChild(s);
        const yes = document.createElement('button');
        yes.textContent = 'Approve';
        yes.className = 'toggle';
        yes.onclick = () => { Aevion.memory.approve(p.id); renderMemory(); toast('Saved to memory'); };
        li.appendChild(yes);
        const no = document.createElement('button');
        no.textContent = '✕';
        no.className = 'x';
        no.title = 'Reject and delete';
        no.onclick = () => { Aevion.memory.remove(p.id, 'prefs'); renderMemory(); };
        li.appendChild(no);
        pel.appendChild(li);
      });
    }
  }

  $('#memRecallBtn').onclick = () => {
    const q = $('#memQuery').value.trim();
    if (!q) return toast('Type something to test recall with');
    const hits = Aevion.memory.recall(q, { limit: 6 });
    $('#memRecall').textContent = hits.length
      ? hits.map(h => `• [${h.layer}] ${h.text}   (score ${h.score})`).join('\n') +
        '\n\nThese — and only these — would be offered to the model as context.'
      : 'Nothing in memory matches that, so no memory would be sent.';
  };

  $('#memAddBtn').onclick = () => {
    const t = $('#memAdd').value.trim();
    if (!t) return;
    const saved = Aevion.memory.add(t, 'fact', 'longterm');
    $('#memAdd').value = '';
    toast(saved ? 'Saved locally' : 'Already saved');
    renderMemory();
  };
  $('#memExport').onclick = () => {
    const dump = {};
    LAYER_ORDER.forEach(l => { dump[l] = Aevion.memory.all(l); });
    const blob = new Blob([JSON.stringify({ app: 'aevion', exported: new Date().toISOString(), memory: dump }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'aevion-memory-' + Date.now() + '.json';
    a.click();
    toast('Memory exported to your downloads folder');
  };
  $('#memClearTemp').onclick = () => { Aevion.memory.clear('temp'); renderMemory(); toast('Temporary context cleared'); };
  $('#memClearConvo').onclick = () => { Aevion.memory.clear('history'); Aevion.emit('chat:clear'); renderMemory(); toast('Conversation cleared'); };
  $('#memClearAll').onclick = () => {
    if (!confirm('Erase every memory layer, including the conversation? Saved notes, tasks and files are not touched.')) return;
    Aevion.memory.wipe();
    Aevion.emit('chat:clear');
    renderMemory();
    toast('All memory erased');
  };
  Aevion.on('memory:changed', renderMemory);

  /* ============ TOOLS ============ */
  function tierBadge(tier) {
    const b = document.createElement('span');
    b.className = 'badge tier-' + tier;
    b.textContent = Aevion.tools.TIERS[tier].label;
    return b;
  }

  function renderTools() {
    const legend = $('#tierLegend');
    legend.innerHTML = '';
    Object.keys(Aevion.tools.TIERS).forEach(k => {
      const li = document.createElement('li');
      li.appendChild(tierBadge(k));
      const s = document.createElement('span');
      s.className = 'grow muted';
      s.textContent = Aevion.tools.TIERS[k].desc;
      li.appendChild(s);
      legend.appendChild(li);
    });

    const list = $('#toolList');
    list.innerHTML = '';
    Aevion.tools.describe().forEach(t => {
      const li = document.createElement('li');
      const wrap = document.createElement('div');
      wrap.className = 'tool-row' + (t.enabled ? '' : ' off');
      const head = document.createElement('div');
      head.appendChild(tierBadge(t.tier));
      const name = document.createElement('span');
      name.className = 'tool-name';
      name.textContent = ' ' + t.name;
      head.appendChild(name);
      if (t.network) {
        const net = document.createElement('span');
        net.className = 'badge';
        net.textContent = 'internet';
        head.appendChild(net);
      }
      if (t.perms.length) {
        const p = document.createElement('span');
        p.className = 'badge';
        p.textContent = 'needs ' + t.perms.join(' + ');
        head.appendChild(p);
      }
      wrap.appendChild(head);
      const sub = document.createElement('span');
      sub.className = 'tool-sub';
      sub.textContent = t.desc + (t.status === 'permission' || t.status === 'network' ? '  ⚠ ' + t.status : '');
      wrap.appendChild(sub);
      li.appendChild(wrap);
      const toggle = document.createElement('button');
      toggle.className = 'toggle';
      toggle.textContent = t.enabled ? 'On' : 'Off';
      toggle.onclick = () => { Aevion.tools.setEnabled(t.id, !t.enabled); renderTools(); };
      li.appendChild(toggle);
      list.appendChild(li);
    });

    const pick = $('#toolPick');
    const keep = pick.value;
    pick.innerHTML = '';
    Aevion.tools.list.forEach(t => {
      const o = document.createElement('option');
      o.value = t.id;
      o.textContent = `${Aevion.tools.TIERS[t.tier].label} · ${t.name}`;
      pick.appendChild(o);
    });
    if (keep) pick.value = keep;

    const lg = $('#toolLogList');
    lg.innerHTML = '';
    const entries = Aevion.tools.log().slice().reverse();
    if (!entries.length) {
      lg.innerHTML = '<li><span class="grow muted">Nothing has run yet.</span></li>';
    } else {
      entries.slice(0, 25).forEach(e => {
        const li = document.createElement('li');
        const s = document.createElement('span');
        s.className = 'grow';
        const icon = e.ok ? '✓' : (e.code === 'permission' || e.code === 'disabled' ? '⛔' : '✕');
        s.textContent = `${icon} ${e.id} · ${e.code}${e.ms ? ' · ' + e.ms + 'ms' : ''} · ${new Date(e.t).toLocaleTimeString()}`;
        li.appendChild(s);
        lg.appendChild(li);
      });
    }
  }

  /* Every tier-3 tool raises this before it refuses, so the user gives
     an explicit, per-call yes instead of a blanket allowance. */
  /* The same modal serves tool confirmations and the device-access grant, so
     `note` lets each say honestly what it is asking for. */
  function askConfirm(tool, args, note) {
    return new Promise(resolve => {
      const modal = $('#confirmModal');
      $('#confirmTitle').textContent = 'Approve: ' + (tool ? tool.name : 'tool');
      $('#confirmBody').textContent = (tool ? tool.desc + '\n\n' : '') +
        (args && Object.keys(args).length ? 'Arguments: ' + JSON.stringify(args) : 'Runs with no arguments.') +
        '\n\n' + (note || 'This approval is for this one action only.');
      modal.classList.remove('hidden');
      const finish = ok => {
        modal.classList.add('hidden');
        $('#confirmYes').onclick = null;
        $('#confirmNo').onclick = null;
        resolve(ok);
      };
      $('#confirmYes').onclick = () => finish(true);
      $('#confirmNo').onclick = () => finish(false);
    });
  }

  async function runTool(id, args, confirmed) {
    $('#toolOut').textContent = 'Running ' + id + '…';
    try {
      const r = await Aevion.tools.run(id, args, { confirm: !!confirmed });
      $('#toolOut').textContent = r.output;
    } catch (e) {
      $('#toolOut').textContent = e.code === 'confirm'
        ? '⏳ Waiting for your approval…'
        : (e.code === 'permission' || e.code === 'disabled' || e.code === 'network' ? '⛔ ' + e.message : '❌ ' + e.message);
    }
    renderTools();
  }

  $('#toolRun').onclick = () => {
    const id = $('#toolPick').value;
    let args = {};
    const raw = $('#toolArgs').value.trim();
    if (raw) {
      try { args = JSON.parse(raw); }
      catch { toast('Arguments must be valid JSON, e.g. {"query":"weather"}'); return; }
    }
    runTool(id, args, false);
  };
  $('#toolLogClear').onclick = () => { Aevion.tools.clearLog(); renderTools(); toast('Activity log cleared'); };

  /* ============ THE BRAIN LOG ============
     The record itself lives in providers.js, where every real request passes,
     so this is only a renderer — and it cannot flatter the brain, because the
     list is the same data the chat wrote when it answered or failed. */
  function renderBrainLog() {
    const list = $('#brainLogList');
    if (!list) return;
    const stats = Aevion.providers.attemptStats();
    const entries = Aevion.providers.attempts().slice().reverse();
    $('#brainLogState').textContent = stats.total
      ? '(' + stats.ok + ' answered · ' + stats.failed + ' failed · last 60 kept)'
      : '(nothing tried yet)';
    list.innerHTML = '';
    if (!entries.length) {
      const li = document.createElement('li');
      const s = document.createElement('span');
      s.className = 'grow muted';
      s.textContent = 'No brain has been asked yet. Ask something in the chat, then come back — every attempt lands here.';
      li.appendChild(s);
      list.appendChild(li);
      return;
    }
    entries.slice(0, 30).forEach(e => {
      const li = document.createElement('li');
      const s = document.createElement('span');
      s.className = 'grow';
      const face = e.skipped ? '⏭' : e.ok ? '✅' : '❌';
      const what = e.ok
        ? e.chars + ' characters back'
        : (e.skipped ? 'never tried — ' + e.why : (e.why || 'failed with no message'));
      s.textContent = face + ' ' + brainLabel(e.id) + ' · ' + what +
        (e.ms ? ' · ' + e.ms + ' ms' : '') + ' · ' + new Date(e.t).toLocaleTimeString();
      li.appendChild(s);
      list.appendChild(li);
    });
  }

  /* “Copy the log” exists for one reason: reporting a failure somewhere else.
     The same clipboard path the code blocks use, with the same fallback. */
  function brainLogText() {
    const lines = Aevion.providers.attempts().map(e =>
      new Date(e.t).toLocaleString() + '  ' + e.id + '  ' +
      (e.skipped ? 'skipped: ' + e.why
        : e.ok ? 'answered (' + e.chars + ' chars, ' + e.ms + ' ms)'
          : 'failed: ' + e.why));
    return lines.length ? lines.join('\n') : 'The brain log is empty.';
  }
  $('#brainLogClear').onclick = () => { Aevion.providers.clearAttempts(); renderBrainLog(); toast('Brain log cleared'); };
  $('#brainLogCopy').onclick = async () => {
    const text = brainLogText();
    const out = $('#brainLogOut');
    try {
      if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
      else throw new Error('no clipboard api');
      out.textContent = '✅ Copied ' + text.split('\n').length + ' line(s) — no prompt or reply text is in there.';
    } catch {
      out.textContent = text;   // no clipboard: show it, let it be selected
    }
  };
  Aevion.on('brain:log', renderBrainLog);

  /* ---------- the automation report, one button ----------
     It runs the read-only system.report tool, so the screen and the
     audit log cannot disagree about what Aevion may do. */
  async function showReport() {
    $('#autoReportOut').textContent = 'Reading the gate, the permissions and the log…';
    try {
      const r = await Aevion.tools.run('system.report');
      $('#autoReportOut').textContent = r.output;
    } catch (e) {
      $('#autoReportOut').textContent = '❌ ' + e.message;
    }
  }
  $('#autoReportBtn').onclick = showReport;
  $('#autoReportCopy').onclick = async () => {
    if (!($('#autoReportOut').textContent || '').trim()) await showReport();
    const body = $('#autoReportOut').textContent || '';
    let ok = false;
    try { await navigator.clipboard.writeText(body); ok = true; } catch { /* no clipboard on this origin */ }
    toast(ok ? '📋 Report copied' : 'Copy it from the box on screen');
  };

  /* Timers report themselves wherever they were set from — and they keep
     counting while other apps are in front, which is the whole point. */
  Aevion.on('timer:done', ({ label, late }) => {
    const what = label || 'Timer';
    toast('⏰ ' + what + ' — time is up' + (late > 5 ? ' (late by ' + late + 's: the device was asleep)' : ''), 8000);
    Aevion.voice.speak(what + ': time is up.', true);
  });
  Aevion.on('timer:changed', ({ timers }) => {
    if (timers.length) toast('⏱ ' + timers.length + ' timer' + (timers.length === 1 ? '' : 's') + ' running');
  });
  Aevion.on('tools:changed', renderTools);
  Aevion.on('tool:confirm', ({ id, args, tool }) => {
    askConfirm(tool || Aevion.tools.get(id), args).then(ok => { if (ok) runTool(id, args, true); });
  });
  /* tools write through the same store the Organizer renders from */
  Aevion.on('data:changed', ({ what }) => {
    if (what === 'notes') { notes = Aevion.store.get('notes', []); renderNotes(); }
    if (what === 'tasks') { tasks = Aevion.store.get('tasks', []); renderTasks(); }
  });

  /* ============ SETTINGS ============ */
  const themeSel = $('#setTheme');
  Aevion.theme.THEMES.forEach(t => { const o = document.createElement('option'); o.value = t; o.textContent = t; themeSel.appendChild(o); });

  /* One row per knob, built from the theme engine's own list. A colour gets a
     picker, a number gets a slider with its value beside it, and every row can
     be cleared back to what the theme says. */
  function buildThemeKnobs() {
    const box = $('#themeKnobs');
    box.innerHTML = '';
    Aevion.theme.KNOBS.forEach(k => {
      const row = document.createElement('div');
      row.className = 'row';
      const label = document.createElement('label');
      label.textContent = k.label;
      label.htmlFor = 'knob-' + k.key;
      row.appendChild(label);

      const input = document.createElement('input');
      input.id = 'knob-' + k.key;
      if (k.type === 'color') input.type = 'color';
      else {
        input.type = 'range';
        input.min = k.min; input.max = k.max; input.step = k.step || (k.type === 'length' ? 1 : 0.05);
      }
      row.appendChild(input);

      const readout = document.createElement('span');
      readout.className = 'muted small';
      readout.id = 'knobVal-' + k.key;
      row.appendChild(readout);

      const clear = document.createElement('button');
      clear.className = 'btn';
      clear.textContent = 'Reset';
      clear.title = 'Use the theme\'s own value for ' + k.label.toLowerCase();
      clear.onclick = () => { Aevion.theme.reset(k.key); fillTheme(); };
      row.appendChild(clear);

      if (k.type === 'color') input.oninput = e => { Aevion.theme.set(k.key, e.target.value); fillTheme(); };
      else input.oninput = e => { Aevion.theme.set(k.key, Number(e.target.value)); fillTheme(); };

      box.appendChild(row);
    });
  }

  /* Show the stored value where there is one, and the preset's own value where
     there is not, so “Reset” is never a mystery. */
  function fillTheme() {
    const preset = getComputedStyle(document.documentElement);
    themeSel.value = Aevion.theme.theme();
    Aevion.theme.KNOBS.forEach(k => {
      const input = $('#knob-' + k.key);
      if (!input) return;
      const saved = Aevion.theme.value(k.key);
      let shown = saved;
      if (k.type === 'color') {
        if (shown === null) shown = toHex(preset.getPropertyValue(k.cssVar).trim()) || '#000000';
      } else {
        const fromCss = parseFloat(String(preset.getPropertyValue(k.cssVar)).replace('px', ''));
        if (shown === null) shown = Number.isFinite(fromCss) ? fromCss : (k.type === 'length' ? k.min : 1);
      }
      input.value = shown;
      $('#knobVal-' + k.key).textContent = saved === null
        ? (k.type === 'length' ? shown + 'px' : String(shown)) + ' (theme)'
        : (k.type === 'length' ? shown + 'px' : String(shown));
    });
    const n = Object.keys(Aevion.theme.overrides()).length;
    const following = Aevion.theme.followDevice();
    $('#setFollowDevice').checked = following;
    $('#themeState').textContent = (n ? n + ' custom change' + (n === 1 ? '' : 's') : 'using the theme as-is') +
      (following ? ' · following the device (' + Aevion.theme.deviceScheme() + ' → ' + Aevion.theme.effective() + ')' : '');
    $('#themeReset').disabled = n === 0;
  }

  /* An <input type="color"> only accepts #rrggbb, so a computed rgb()/
     rgba()/hsl() value from the preset is converted for display. */
  function toHex(value) {
    const v = String(value || '').trim();
    if (/^#[0-9a-f]{6}$/i.test(v)) return v;
    const m = v.match(/^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
    if (!m) return null;
    return '#' + [m[1], m[2], m[3]].map(x => Number(x).toString(16).padStart(2, '0')).join('');
  }

  themeSel.onchange = e => { Aevion.theme.setTheme(e.target.value); fillTheme(); };
  $('#themeReset').onclick = () => {
    const had = Aevion.theme.resetCustom();
    fillTheme();
    toast(had ? 'Custom theme changes cleared' : 'Nothing was changed');
  };
  $('#themeCopy').onclick = async () => {
    const text = Aevion.theme.exportText();
    $('#themeText').value = text;
    let copied = false;
    try { await navigator.clipboard.writeText(text); copied = true; } catch { /* no clipboard on this origin */ }
    toast(copied ? '✅ Theme copied to the clipboard' : 'Theme is in the box — copy it from there', 5000);
  };
  $('#themeLoad').onclick = () => {
    const text = $('#themeText').value.trim();
    if (!text) return toast('Paste a theme line first');
    const r = Aevion.theme.loadText(text);
    fillTheme();
    if (!r.applied.length) return toast('Nothing in that line is a theme value I understand: ' + r.rejected.slice(0, 3).join(', '), 6000);
    toast('✅ Applied ' + r.applied.length + ' value' + (r.applied.length === 1 ? '' : 's') +
      (r.rejected.length ? ' — refused ' + r.rejected.length + ': ' + r.rejected.slice(0, 3).join(', ') : ''), 6000);
  };
  Aevion.on('theme:changed', fillTheme);
  buildThemeKnobs();
  fillTheme();

  /* Following the device never touches the theme you chose: that is what
     "remember the previous theme" means in practice. */
  $('#setFollowDevice').onchange = e => {
    Aevion.theme.setFollowDevice(e.target.checked);
    fillTheme();
    toast(e.target.checked
      ? 'Following the device — your theme (' + Aevion.theme.theme() + ') is kept and comes straight back when you turn this off'
      : 'Back to your own theme: ' + Aevion.theme.theme(), 5000);
  };

  function fillSettings() {
    const s = Aevion.settings;
    fillLangs();   // options first, then the stored values
    fillTheme();
    $('#setName').value = s.name; $('#setNickname').value = s.name; $('#setPersona').value = s.persona; $('#setLang').value = s.lang;
    $('#setOnlineAI').checked = !!s.onlineAI;
    $('#setAutoAI').checked = s.autoAI !== false;
    fillAI();
    $('#setOnlineSearch').checked = !!s.onlineSearch;
    $('#setMemory').checked = !!s.memory;
    $('#setMemory2').checked = !!s.memory;
    $('#setWebllm').checked = !!s.webllm; wSel.value = s.webllmModel || wSel.options[0].value;
    webllmCapText();
    $('#setPinOn').checked = !!s.pinOn;
    $('#setPinBrowser').checked = !!s.pinOutside;
    renderPinNote();
    $('#setTtsOn').checked = !!s.speak;
    $('#setRate').value = s.ttsRate == null ? 1 : s.ttsRate;
    $('#setPitch').value = s.ttsPitch == null ? 1 : s.ttsPitch;
    $('#setSpeechLang').value = s.speechLang || '';
    $('#setInterim').checked = s.speechInterim !== false;
    fillVoiceStyle();
    renderBackground();
    renderEvolve();
    fillLive();
    fillTeach();
    renderWake();
  }

  /* The engine's own list — the advanced override under the presets.
     Only the web engine exposes one; Android's TTS holds a single voice
     per language, which is why the presets exist in the first place. */
  function refreshVoices() {
    const sel = $('#setVoice');
    sel.innerHTML = '<option value="">(follow the chosen voice)</option>';
    try {
      Aevion.voice.voices().forEach(v => {
        const o = document.createElement('option');
        o.value = v.voiceURI || v.name; o.textContent = `${v.name} (${v.lang})`;
        sel.appendChild(o);
      });
      if (Aevion.settings.voiceURI) sel.value = Aevion.settings.voiceURI;
    } catch {}
  }
  if ('speechSynthesis' in window) {
    refreshVoices();
    speechSynthesis.onvoiceschanged = refreshVoices;
  }

  /* ---------- the fifteen voices ----------
     Built from Aevion.voices.PRESETS, so a new voice is one entry in
     js/voices.js and no DOM code at all. */
  function fillVoiceStyle() {
    const sel = $('#setVoiceStyle');
    sel.innerHTML = '';
    Aevion.voices.list().forEach(p => {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.id === 'system' ? p.name + ' — ' + p.desc : p.name + ' · ' + p.desc;
      sel.appendChild(o);
    });
    sel.value = Aevion.voices.currentId();
    /* The sliders have to show the chosen voice's numbers, or the next
       drag would start from a value that is no longer in effect. */
    syncVoiceSliders();
    voiceStateText();
  }

  function syncVoiceSliders() {
    const s = Aevion.settings;
    $('#setRate').value = s.ttsRate == null ? 1 : s.ttsRate;
    $('#setPitch').value = s.ttsPitch == null ? 1 : s.ttsPitch;
  }

  /* The one line that says which voice is in effect and whether the
     sliders still match it. Kept separate because the sliders call it
     on every drag — rebuilding the whole picker there would be silly. */
  function voiceStateText() {
    const p = Aevion.voices.current();
    const custom = Aevion.voices.isCustom();
    $('#voiceState').textContent = custom ? '· ' + p.name + ' (adjusted)' : (p.id === 'system' ? '' : '· ' + p.name);
    $('#voiceHint').textContent = Aevion.voices.summary() +
      (custom
        ? ' The sliders are no longer at ' + p.name + '’s values, so it is marked adjusted — pick ' + p.name + ' again to put them back.'
        : '');
  }
  $('#setVoiceStyle').onchange = e => {
    const p = Aevion.voices.apply(e.target.value);
    fillVoiceStyle();
    refreshVoices();
    if (!Aevion.settings.speak) {
      toast('Voice set to ' + p.name + ' — turn on “Speak replies” (or press ▶ Hear this voice) to hear it', 5000);
    } else {
      toast('Voice: ' + p.name + ' · ' + p.desc);
    }
  };
  $('#voicePreview').onclick = () => {
    if (!Aevion.voice.ttsSupported) return toast('This device has no speech engine to preview with');
    const r = Aevion.voices.preview($('#setVoiceStyle').value);
    if (!r) return toast('Nothing to preview on this device');
    toast('▶ ' + Aevion.voices.get(r.id).name + ' · ' + r.rate + '× speed, pitch ' + r.pitch +
      (r.matched ? ' · matched an engine voice' : ''), 4000);
  };
  Aevion.on('voice:style', fillVoiceStyle);

  /* Both language dropdowns are built from Aevion.languages, so adding a
     language to the app is one entry in core.js and nothing else. Each option
     carries its English name beside its own ("ಕನ್ನಡ Kannada"), and the label
     says how many there are, so the list is countable instead of a mystery. */
  function fillLangs() {
    const appSel = $('#setLang');
    const speechSel = $('#setSpeechLang');
    const appCode = Aevion.settings.lang || 'en';
    const speechCode = Aevion.settings.speechLang || '';
    const n = Aevion.languages.length;

    const current = Aevion.languages.find(l => l.code === appCode) || Aevion.languages[0];
    $('#setLangLabel').textContent = 'Language · ' + n + ' available';
    $('#langHint').textContent = 'Each option shows the language\'s own name and its English name. ' +
      'The one you pick here is also what Aevion speaks and listens in — so “translate hello to ' +
      current.english + '” follows this setting.';

    appSel.innerHTML = '';
    Aevion.languages.forEach(l => {
      const o = document.createElement('option');
      o.value = l.code; o.textContent = Aevion.langLabel(l);
      appSel.appendChild(o);
    });
    appSel.value = Aevion.languages.some(l => l.code === appCode) ? appCode : 'en';

    const tags = Aevion.speechTags();
    $('#setSpeechLangLabel').textContent = 'Speech language · ' + n + ' available';
    $('#speechLangHint').textContent = 'Your device\'s speech engine decides which of these it can actually ' +
      'recognise and pronounce — if it cannot do the one you picked, Aevion says so instead of failing silently.';

    speechSel.innerHTML = '';
    tags.forEach(t => {
      const o = document.createElement('option');
      o.value = t.value; o.textContent = t.label;
      speechSel.appendChild(o);
    });
    speechSel.value = speechCode;
  }

  /* The wake controls and listeners live with the rest of wake mode, above:
     one switch, one set of handlers. This block only closes the loop when the
     speech engine reports that it has finished talking. */
  if (window.Aevion && Aevion.wake) {
    Aevion.on('voice:done', () => Aevion.wake.notifyReplyDone());
  }

  /* One nickname, two boxes (Settings and the Voice card): it is the name
     in the tab title, on the HUD, and the one the mic listens for. */
  function setName(raw) {
    const v = (raw || '').trim().slice(0, 24) || 'Aevion';
    const was = Aevion.settings.name || 'Aevion';
    if (v !== was) toast(`I'm “${v}” now — say “Hey ${v} …” to wake me`);
    Aevion.set('name', v);
    applySettings();
    renderWake();
    if ($('#setName').value !== v) $('#setName').value = v;
    if ($('#setNickname').value !== v) $('#setNickname').value = v;
  }
  $('#setName').onchange = e => setName(e.target.value);
  $('#setNickname').onchange = e => setName(e.target.value);
  $('#setPersona').onchange = e => Aevion.set('persona', e.target.value);
  $('#setLang').onchange = e => { Aevion.set('lang', e.target.value); fillLangs(); };
  $('#setVoice').onchange = e => Aevion.set('voiceURI', e.target.value);
  $('#setTtsOn').onchange = e => Aevion.set('speak', e.target.checked);
  $('#setRate').oninput = e => { Aevion.set('ttsRate', parseFloat(e.target.value)); voiceStateText(); };
  $('#setPitch').oninput = e => { Aevion.set('ttsPitch', parseFloat(e.target.value)); voiceStateText(); };
  $('#setSpeechLang').onchange = e => Aevion.set('speechLang', e.target.value);
  $('#setInterim').onchange = e => Aevion.set('speechInterim', e.target.checked);
  

  $('#setOnlineAI').onchange = e => { Aevion.set('onlineAI', e.target.checked); applySettings(); fillAI(); toast(e.target.checked ? 'Online AI enabled — your choice, always reversible' : 'Online AI disabled — fully local again'); };
  $('#setAutoAI').onchange = e => {
    Aevion.set('autoAI', e.target.checked);
    applySettings();
    toast(e.target.checked
      ? 'Auto-switch on — Aevion will move between the online and offline brain by itself'
      : 'Auto-switch off — it will always try the online brain and tell you when it cannot');
  };

  /* ---- AI providers (registry-driven: no hardcoded provider list here) ---- */
  const KEY_MASK = '••••••••••••';
  const providerSel = $('#setAIProvider');
  Aevion.providers.list.forEach(a => {
    const o = document.createElement('option');
    o.value = a.id;
    o.textContent = a.label + (a.kind === 'local' ? ' — on device' : a.kind === 'loopback' ? ' — your machine' : '') +
      (a.free ? ' · free tier' : '');
    providerSel.appendChild(o);
  });

  function secretsNote() {
    const el = $('#secretsNote');
    if (!Aevion.secrets) return;
    if (Aevion.secrets.isEncrypted()) {
      el.textContent = Aevion.secrets.isLocked()
        ? '🔒 Keys are encrypted at rest. Unlock with your PIN to load them.'
        : '🔒 Keys are encrypted at rest with your PIN (AES-GCM). They are also excluded from every backup and sync bundle.';
    } else {
      el.textContent = '🔑 Keys are stored on this device but not encrypted. Set a PIN lock in Security below to encrypt them at rest. Backups never include them either way.';
    }
  }

  function fillAI() {
    const id = Aevion.settings.aiProvider;
    const a = Aevion.providers.get(id) || Aevion.providers.list[0];
    if (!a) return;
    Aevion.set('aiProvider', a.id);
    providerSel.value = a.id;
    const cfg = Aevion.providers.cfg(a.id);
    $('#aiHint').textContent = (a.hint || '') + (a.docs ? '  ·  ' + a.docs : '');
    $('#setAIUrl').value = cfg.url;
    $('#setAIModel').value = cfg.model;
    $('#setAIKey').value = Aevion.providers.key(a.id) ? KEY_MASK : '';
    $('#aiUrlRow').style.display = a.needsUrl === false ? 'none' : '';
    $('#aiModelRow').style.display = a.kind === 'local' ? 'none' : '';
    $('#setAIFallback').checked = Aevion.settings.aiFallback !== false;
    /* The “get a free key” row exists only for the providers that actually
       carry a free tier and link to where the key comes from — both from the
       registry, so it cannot drift. */
    const freeRow = $('#aiFreeRow');
    if (freeRow) {
      freeRow.hidden = !(a.free && a.docs);
      const gk = $('#aiGetKey');
      if (gk) gk.textContent = '🔑 Get a free key for ' + a.label;
    }
    const missing = Aevion.providers.missing(a.id);
    $('#aiStatus').textContent = a.kind === 'local'
      ? (missing.length ? 'Needs: ' + missing.join(', ') : 'Ready — runs on this device with no network.')
      : (missing.length ? 'Not ready — needs: ' + missing.join(', ') + '.' : 'Ready to test.');
    secretsNote();
  }

  providerSel.onchange = () => { Aevion.set('aiProvider', providerSel.value); fillAI(); };
  $('#setAIUrl').onchange = e => { Aevion.providers.setCfg(Aevion.settings.aiProvider, { url: e.target.value.trim() }); fillAI(); };
  $('#setAIModel').onchange = e => { Aevion.providers.setCfg(Aevion.settings.aiProvider, { model: e.target.value.trim() }); fillAI(); };
  $('#setAIKey').onchange = e => {
    const v = e.target.value.trim();
    if (v === KEY_MASK) return;                       // the mask is not a key
    Aevion.providers.setKey(Aevion.settings.aiProvider, v);
    setTimeout(fillAI, 60);                           // after the vault persists
  };
  $('#setAIFallback').onchange = e => Aevion.set('aiFallback', e.target.checked);
  $('#aiKeyClear').onclick = () => {
    Aevion.providers.setKey(Aevion.settings.aiProvider, '');
    fillAI();
    toast('Stored key deleted from this device');
  };
  $('#aiTest').onclick = async () => {
    const id = Aevion.settings.aiProvider;
    const a = Aevion.providers.get(id);
    $('#aiStatus').textContent = 'Testing ' + (a ? a.label : id) + '…';
    try {
      const r = await Aevion.providers.test(id);
      $('#aiStatus').textContent = `✅ ${a.label} answered in ${r.ms} ms: “${r.reply}”`;
    } catch (e) {
      $('#aiStatus').textContent = '❌ ' + e.message;
    }
  };
  /* The same free-key flow as the chat card, for the person already standing
     in Settings. Aevion never creates the key: the button prints the exact
     steps, opens the provider's own page if the automation permission allows
     it, and points at the box right above for pasting it. */
  const aiGetKeyBtn = $('#aiGetKey');
  if (aiGetKeyBtn) aiGetKeyBtn.onclick = () => {
    const id = Aevion.settings.aiProvider;
    const a = Aevion.providers.get(id);
    if (!a) return;
    const url = a.docs || '';
    $('#aiStatus').textContent = 'Get a key for ' + a.label + ':\n' +
      '1. ' + (url ? 'Open ' + url : 'Open the provider’s API-keys page') + ' in a browser (most need just an email; a few ask for a phone number).\n' +
      '2. Create an API key and copy it.\n' +
      '3. Paste it into the API key box above — Aevion saves it to this device’s vault; then press “Test connection”.\n' +
      '4. The key is stored on this device only (never in a backup or a sync bundle) and every attempt lands in Tools → 🧠 Brain log.' +
      (a.hint ? '\n\n' + a.hint : '');
    /* Opening a link is an action with a side effect, so it goes through the
       same automation permission the rest of the app uses — otherwise the URL
       is simply printed, and nothing opens behind your back. */
    if (url && Aevion.perms.get('automation')) window.open(url, '_blank', 'noopener');
    const keyEl = $('#setAIKey');
    if (keyEl) keyEl.focus();
  };
  /* ---------- more than one brain ----------
     One checkbox per provider, with the truth about each one beside it: a
     brain whose key is missing cannot take part in an answer, and saying that
     here is what stops a puzzling failure later. */
  const brainSet = () => (Aevion.settings && Aevion.settings.brainSet) || [];

  function renderMulti() {
    const list = $('#brainSetList');
    if (!Aevion.settings || !list) return;
    $('#setBrainStrategy').value = Aevion.providers.brainStrategy();
    const chosen = brainSet();
    const plan = Aevion.providers.multiPlan();
    list.innerHTML = '';
    Aevion.providers.list.forEach(a => {
      if (a.id === 'mock') return;                       // a canned reply is not a brain
      const li = document.createElement('li');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.id = 'brainPick-' + a.id;
      cb.checked = chosen.includes(a.id);
      const label = document.createElement('label');
      label.htmlFor = cb.id;
      label.className = 'grow';
      /* The truth, from the last check — not “ready” because a key is saved.
         A provider that is configured but silent has to read as silent here,
         or this screen makes the same promise the old pill did. */
      const v = Aevion.setup.verdict(a.id);
      label.textContent = ' ' + a.label + (a.free ? ' · free tier' : '') + ' — ' + v.face + ' ' + v.text;
      cb.onchange = () => {
        const set = brainSet().slice();
        const i = set.indexOf(a.id);
        if (cb.checked && i < 0) set.push(a.id);
        if (!cb.checked && i >= 0) set.splice(i, 1);
        Aevion.set('brainSet', set);
        renderMulti();
      };
      li.appendChild(cb);
      li.appendChild(label);
      list.appendChild(li);
    });

    const strat = Aevion.providers.brainStrategy();
    const checked = Aevion.setup.last();
    $('#multiState').textContent = '· ' + chosen.length + ' ticked' +
      (checked ? ' · checked ' + new Date(checked.at).toLocaleTimeString() : '');
    /* A tick alone is not a promise: the plan only contains providers that can
       answer, so a pair of servers that are not running reads as “nothing can
       run yet” with the reason beside each one — instead of “2 brains will be
       used”, followed by two failures. */
    const silent = chosen.filter(id => plan.length < 2 && !Aevion.providers.canAnswerNow(id));
    $('#multiOut').textContent = strat === 'first'
      ? 'One brain at a time — ticking more than one changes nothing until you choose “Ask all of them…” or “One answers, the next reviews…”.'
      : (plan.length >= 2
        ? '✅ ' + plan.length + ' brains will be used for the next open question: ' + plan.map(brainLabel).join(' → ') + '.'
        : '⚠ Nothing multi-brain can run yet — tick at least two providers that have a key and are allowed to run' +
          (plan.length === 1 ? ' (only ' + brainLabel(plan[0]) + ' is ready so far).' : '.') +
          (silent.length
            ? ' Right now these cannot answer at all: ' + silent.map(id => brainLabel(id) + ' (' + Aevion.setup.verdict(id).text + ')').join(' · ') + '.'
            : ''));
  }
  $('#setBrainStrategy').onchange = e => { Aevion.set('brainStrategy', e.target.value); renderMulti(); };
  Aevion.on('ai:config', renderMulti);
  Aevion.on('secrets:changed', renderMulti);
  Aevion.on('setup:surveyed', renderMulti);

  /* The same engine as the chat card, for the person already standing in
     Settings: one press asks every brain this device can reach and switches to
     the one that answers. It never overrules a choice that already works, and
     it never sends a prompt to find out — only “are you there?”. */
  $('#aiBest').onclick = async () => {
    const status = $('#aiStatus');
    status.textContent = 'Checking every brain this device can reach…';
    let r = null;
    try { r = await Aevion.setup.best(); } catch (e) { status.textContent = '❌ ' + e.message; return; }
    if (r.id && r.id !== Aevion.settings.aiProvider) {
      const applied = Aevion.setup.apply(r.id);
      fillAI();
      status.textContent = '✅ Switched to ' + applied.label + ' — ' + r.why + (applied.turnedOn ? ' (online AI switched on for it)' : '') + '.';
      toast('🧠 ' + applied.label + ' is the brain now');
      return;
    }
    if (r.id) { status.textContent = '✅ ' + brainLabel(r.id) + ' is already the brain here — ' + r.why + '.'; return; }
    const needs = ((r.survey && r.survey.options) || []).filter(o => o.state !== 'ready' && o.state !== 'test')
      .map(o => o.label + ': ' + o.why).join(' ');
    status.textContent = '⚠ Nothing is answering yet. ' + needs + ' The 🧠 card in the chat has the one-tap fixes.';
  };

  Aevion.on('ai:config', fillAI);
  Aevion.on('secrets:changed', secretsNote);
  $('#setOnlineSearch').onchange = e => Aevion.set('onlineSearch', e.target.checked);
  $('#setMemory').onchange = e => { Aevion.set('memory', e.target.checked); $('#setMemory2').checked = e.target.checked; };
  $('#setMemory2').onchange = e => { Aevion.set('memory', e.target.checked); $('#setMemory').checked = e.target.checked; };

  // in-browser AI (WebLLM)
  const wSel = $('#setWebllmModel');
  Aevion.webllm.detect().then(() => {
    const cur = Aevion.settings.webllmModel;
    wSel.innerHTML = '';
    Aevion.webllm.availableModels().forEach(m => {
      const o = document.createElement('option'); o.value = m.id; o.textContent = m.label; wSel.appendChild(o);
    });
    // keep saved model if this GPU can run it, else fall back to first compatible
    if (![...wSel.options].some(o => o.value === cur)) Aevion.set('webllmModel', wSel.options[0].value);
    wSel.value = Aevion.settings.webllmModel;
  });
  function webllmCapText() {
    const el = $('#webllmCap');
    if (!Aevion.webllm.gpuSupported()) {
      el.textContent = '⚠ WebGPU not available in this browser — use Chrome or Edge 113+ (Windows: update; Android: Chrome 121+).';
      return false;
    }
    el.textContent = '✅ WebGPU available — in-browser models ready to load.';
    return true;
  }
  $('#setWebllm').onchange = e => {
    Aevion.set('webllm', e.target.checked);
    if (e.target.checked && !Aevion.webllm.isReady()) {
      $('#webllmOut').textContent = 'Model not loaded yet — click “Download & load” below.';
    }
    toast(e.target.checked ? 'In-browser AI enabled' : 'In-browser AI disabled');
  };
  wSel.onchange = () => Aevion.set('webllmModel', wSel.value);
  $('#webllmLoad').onclick = async () => {
    if (!webllmCapText()) return;
    const modelId = wSel.value;
    const modelDef = Aevion.webllm.MODELS.find(m => m.id === modelId);
    if (modelDef && modelDef.requiresF16 && Aevion.webllm.f16 === false) {
      $('#webllmOut').textContent = '❌ This model needs shader-f16 (newer GPU). Pick a q4f32 model instead.';
      return;
    }
    const out = $('#webllmOut');
    $('#webllmLoad').disabled = true;
    try {
      await Aevion.webllm.load(modelId, p => {
        out.textContent = `${Math.round((p.progress || 0) * 100)}% — ${p.text || ''}`;
      });
      out.textContent = '✅ ' + modelId + ' loaded and cached. Chat now uses this model (toggle above).';
      toast('🧠 Model ready — fully offline now');
    } catch (e) {
      out.textContent = '❌ Load failed: ' + e.message;
    }
    $('#webllmLoad').disabled = false;
  };
  $('#webllmUnload').onclick = async () => {
    await Aevion.webllm.unload();
    $('#webllmOut').textContent = 'Model unloaded; GPU memory freed. Cached download is kept.';
  };

  // permissions UI
  function renderPerms() {
    const el = $('#permList');
    if (!el || !Aevion.settings) return;
    el.innerHTML = '';
    Object.keys(Aevion.perms.map).forEach(k => {
      const li = document.createElement('li');
      const s = document.createElement('span'); s.className = 'grow';
      s.textContent = `${Aevion.perms.map[k].label} — ${Aevion.perms.status(k)}`;
      li.appendChild(s);
      const grant = document.createElement('button'); grant.textContent = 'Grant';
      grant.onclick = async () => { toast('Requesting ' + k + '…'); await Aevion.perms.request(k); renderPerms(); };
      li.appendChild(grant);
      const rev = document.createElement('button'); rev.textContent = 'Revoke'; rev.className = 'x';
      rev.onclick = () => { Aevion.perms.revoke(k); renderPerms(); };
      li.appendChild(rev);
      el.appendChild(li);
    });
  }
  Aevion.on('perm:changed', renderPerms);
  renderPerms();

  /* ============ DEVICE ACCESS ============
     One switch that asks for every permission this device can actually give.
     It is a shortcut for the rows above — never a bypass: sensitive tools
     still check their own permission, and tier "confirm" still asks every
     time. Off unless asked for, reported honestly, revocable in one tap. */
  const PERM_LABEL = k => (Aevion.perms.map[k] && Aevion.perms.map[k].label) || k;

  function groupWords(keys) {
    const names = keys.map(PERM_LABEL);
    if (names.length <= 1) return names.join('');
    return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
  }

  function renderDeviceAccess() {
    /* Called once at load, and Aevion.settings only exists after boot().
       Everything at the top of this file has to survive that null. */
    if (!Aevion.settings) return;
    const on = !!Aevion.settings.deviceAccess;
    const allowed = Aevion.perms.granted();
    const canAsk = Aevion.perms.missing();
    const shellOnly = Aevion.perms.SHELL_ONLY.map(PERM_LABEL);

    $('#setDeviceAccess').checked = on;
    $('#deviceAccessGrant').disabled = !canAsk.length;
    $('#deviceAccessGrant').textContent = canAsk.length
      ? 'Grant ' + canAsk.length + ' device permission' + (canAsk.length === 1 ? '' : 's')
      : 'All device permissions granted';
    $('#deviceAccessRevoke').disabled = !allowed.length;

    const parts = [];
    parts.push(allowed.length
      ? 'Allowed: ' + groupWords(allowed) + '.'
      : 'Nothing is allowed yet — Aevion can read its own local data and nothing else.');
    if (canAsk.length) parts.push('Still not allowed: ' + groupWords(canAsk) + '.');
    if (!Aevion.perms.shell()) parts.push(groupWords(shellOnly) + ' need the Aevion Android app; a browser cannot offer them, so they are never claimed here.');
    if (on) parts.push('Anything irreversible still asks first, every time.');
    $('#deviceAccessNote').textContent = parts.join(' ');
  }
  Aevion.on('perm:changed', renderDeviceAccess);
  Aevion.on('perms:revokedAll', () => { toast('🔒 Device permissions revoked — Aevion is back to local data only'); renderDeviceAccess(); });

  $('#deviceAccessGrant').onclick = async () => {
    const missing = Aevion.perms.missing();
    if (!missing.length) return toast('Every permission this device offers is already granted');
    const ok = await askConfirm({
      name: 'device access',
      desc: 'Grant ' + missing.length + ' permission' + (missing.length === 1 ? '' : 's') + ': ' + groupWords(missing) + '.'
    }, {}, 'These stay granted until you revoke them — one tap in Settings takes them all back.');
    if (!ok) return toast('Nothing was granted');

    const btn = $('#deviceAccessGrant');
    btn.disabled = true;
    toast('Asking the device — answer each prompt as it appears…', 6000);
    const report = await Aevion.perms.requestAll((k, result) => {
      if (result !== 'granted') toast(' ' + PERM_LABEL(k) + ': ' + result, 4000);
    });
    Aevion.set('deviceAccess', report.granted.length > 0);
    Aevion.tools.audit('device.access', true, 'grant:' + report.granted.length);
    toast(report.granted.length
      ? '✅ Allowed: ' + groupWords(report.granted) + '.' + (report.denied.length ? ' Refused: ' + groupWords(report.denied) + '.' : '')
      : 'Nothing was granted — the device or the browser refused every request.', 6000);
    renderDeviceAccess();
  };

  /* The checkbox is a mirror, not a second switch: ticking it asks for what is
     missing, unticking it takes everything back. */
  $('#setDeviceAccess').onchange = e => {
    if (e.target.checked) $('#deviceAccessGrant').click();
    else $('#deviceAccessRevoke').click();
  };

  $('#deviceAccessRevoke').onclick = () => {
    const revoked = Aevion.perms.revokeAll();
    Aevion.set('deviceAccess', false);
    Aevion.tools.audit('device.access', true, 'revoke:' + revoked.length);
    renderPerms();
    renderDeviceAccess();
    if (!revoked.length) toast('Nothing was allowed, so nothing changed');
  };

  renderDeviceAccess();

  // PIN
  /* What the lock actually protects — stated plainly, because a lock screen
     mistaken for encryption is worse than no lock at all. */
  function renderPinNote() {
    const el = $('#pinBrowserNote');
    if (!el || !Aevion.settings) return;
    const shell = Aevion.perms.shell();
    const on = !!Aevion.settings.pinOutside;
    if (!Aevion.settings.pinHash) {
      el.textContent = 'No PIN is saved yet, so this switch can do nothing: save one below and it starts working. A PIN is a lock screen, not encryption of everything — it keeps a passer-by out of the app, and it is the same PIN that encrypts your saved API keys.';
      return;
    }
    el.textContent = on
      ? (shell
        ? 'On — Aevion is running in its own app, so the switch above decides whether the PIN is asked at start.'
        : 'On — this window is a plain browser tab, so the PIN is asked before anything is shown. Same PIN, same vault: nothing in this tab is readable until it is entered.')
      : 'Off — a plain browser tab opens straight into the app. Turn it on and Aevion asks for your PIN first whenever it is opened outside its own app, which is the weaker place to leave it open.';
  }
  $('#setPinBrowser').onchange = e => {
    if (e.target.checked && !Aevion.settings.pinHash) {
      e.target.checked = false;
      renderPinNote();
      toast('Save a PIN first — the lock needs one');
      return;
    }
    Aevion.set('pinOutside', e.target.checked);
    renderPinNote();
    toast(e.target.checked
      ? '🔒 Aevion asks for your PIN in a plain browser tab from now on'
      : 'PIN requirement outside the Aevion app is off');
  };

  $('#setPinSave').onclick = async () => {
    const p = $('#setPin1').value;
    if (!/^\d{4,8}$/.test(p)) return toast('PIN must be 4-8 digits');
    Aevion.set('pinHash', await Aevion.hash(p));
    // the PIN also becomes the key that encrypts stored API keys
    try { await Aevion.secrets.enable(p); } catch (e) { toast('Stored keys could not be encrypted: ' + e.message); }
    $('#setPin1').value = '';
    secretsNote();
    fillAI();
    renderPinNote();
    toast('PIN saved — stored API keys are now encrypted at rest');
  };
  $('#setPinOn').onchange = e => {
    if (e.target.checked && !Aevion.settings.pinHash) {
      e.target.checked = false;
      toast('Save a PIN first');
      return;
    }
    Aevion.set('pinOn', e.target.checked);
    renderPinNote();
    if (!e.target.checked && Aevion.secrets.isEncrypted()) {
      Aevion.secrets.disable().then(() => {
        secretsNote();
        fillAI();
        toast('PIN lock off — stored keys are no longer encrypted at rest');
      });
    }
  };

  // export / wipe
  $('#exportData').onclick = () => {
    const blob = new Blob([JSON.stringify({ app: 'aevion', v: Aevion.version, data: Aevion.store.dumpSafe() }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'aevion-backup-' + Date.now() + '.json';
    a.click();
  };

  /* Restore. The twin of exportData: export existed from the start, the way
     back in never did, which is a one-way door for someone who just factory
     reset or moved machines. Same contract both ways: JSON, app==='aevion',
     dumpSafe() shape — and the merge is deliberately conservative.
       * settings are merged KEY BY KEY: a key absent from the backup keeps
         its current value, so a restore can never blank a device that is
         already configured for more than the backup knew.
       * everything else (chats, memory, notes, tasks, plugins) is restored
         wholesale, because those are collections, not configuration.
       * secrets are refused in both directions (dumpSafe strips them on
         export; an import carrying them is tampering) — the notice says so.
       * a `v` older than 0.6.0 is refused rather than half-understood.
     The page reloads afterwards so every view re-renders from real state. */
  $('#importData').onclick = () => $('#backupFile').click();
  $('#backupFile').onchange = e => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    const out = $('#restoreOut');
    const r = new FileReader();
    r.onload = () => {
      try {
        const parsed = JSON.parse(r.result);
        if (!parsed || parsed.app !== 'aevion' || typeof parsed.data !== 'object' || !parsed.data) {
          throw new Error('that file is not an Aevion backup (expected {"app":"aevion",...})');
        }
        if (Object.prototype.hasOwnProperty.call(parsed.data, 'secrets')) {
          throw new Error('the backup carries API keys, which backups never do — it may have been edited');
        }
        const bv = String(parsed.v || '0');
        const [bmaj, bmin] = bv.split('.').map(Number);
        if (!(bmaj > 0 || bmin >= 6)) throw new Error('backup from ' + bv + ' is too old to restore safely');
        const d = parsed.data;
        if (d.settings && typeof d.settings === 'object') {
          const cur = Aevion.store.get('settings', {});
          Aevion.store.set('settings', Object.assign({}, cur, d.settings));
        }
        for (const [k, v] of Object.entries(d)) {
          if (k === 'settings') continue;
          Aevion.store.set(k, v);
        }
        const n = Object.keys(d).length;
        out.textContent = '✅ Restored ' + n + ' section' + (n === 1 ? '' : 's') + ' from the ' + bv + ' backup. Reloading…';
        setTimeout(() => location.reload(), 1200);
      } catch (err) {
        out.textContent = '❌ Restore failed: ' + err.message;
      }
    };
    r.readAsText(f);
  };
  $('#wipeBtn').onclick = () => {
    if (!confirm('Factory reset: delete ALL Aevion data on this device? This cannot be undone.')) return;
    if (!confirm('Really sure? Export a backup first if you need one.')) return;
    Aevion.store.keys().forEach(k => Aevion.store.del(k));
    location.reload();
  };

  /* ============ LIVE SPEAK & TRANSLATE ============
     Speak in one language, hear it in another, phrase by phrase. It is a
     loop around the recognizer you already have: listen → translate →
     speak → listen again, which keeps one microphone and one code path. */
  let live = false;
  let liveWasLang = null;

  function fillLangSelect(sel, keep) {
    sel.innerHTML = '';
    Aevion.languages.forEach(l => {
      const o = document.createElement('option');
      o.value = l.code;
      o.textContent = Aevion.langLabel(l);
      sel.appendChild(o);
    });
    sel.value = Aevion.languages.some(l => l.code === keep) ? keep : 'en';
  }

  function fillLive() {
    fillLangSelect($('#liveSrc'), $('#liveSrc').value || Aevion.settings.lang || 'en');
    fillLangSelect($('#liveDst'), $('#liveDst').value || 'en');
  }

  function liveStop(msg) {
    if (!live) return;
    live = false;
    Aevion.voice.stop();
    if (liveWasLang !== null) { Aevion.set('speechLang', liveWasLang); liveWasLang = null; }
    $('#liveToggle').textContent = 'Start live translation';
    if (msg) $('#liveOut').textContent = msg;
  }

  async function livePhrase(text) {
    if (!live || !text || !text.trim()) return;
    const dst = $('#liveDst').value;
    $('#liveOut').textContent = '🎙 ' + text + '\n…translating';
    const out = await Aevion.skills.translate('translate ' + text + ' to ' + dst);
    if (!live) return;
    $('#liveOut').textContent = '🎙 ' + text + '\n' + out;
    Aevion.voice.speak(out, true);   // forced: live mode must be audible
  }

  async function liveOn() {
    if (!Aevion.voice.supported) return toast('This device has no speech engine for live translation');
    if (!Aevion.settings.onlineSearch) return toast('Live translation needs “Allow online search” in Settings');
    const src = $('#liveSrc').value, dst = $('#liveDst').value;
    if (src === dst) return toast('Pick two different languages');
    if (!Aevion.perms.get('microphone')) {
      const r = await Aevion.perms.request('microphone');
      if (r !== 'granted') return toast('The microphone permission is needed to listen');
    }
    live = true;
    liveWasLang = Aevion.settings.speechLang || '';
    Aevion.set('speechLang', src);     // the recognizer must hear the source language
    $('#liveToggle').textContent = 'Stop live translation';
    const label = (Aevion.languages.find(l => l.code === dst) || {}).english || dst;
    $('#liveOut').textContent = 'Listening — speak, and Aevion says it back in ' + label + '.';
    Aevion.voice.start().catch(e => liveStop('Could not start listening: ' + e.message));
  }

  $('#liveToggle').onclick = () => { if (live) liveStop('Stopped.'); else liveOn(); };

  /* The loop's other half: once Aevion has finished speaking, listen again. */
  Aevion.on('voice:done', () => {
    if (!live) return;
    setTimeout(() => {
      if (!live) return;
      Aevion.voice.start().catch(() => liveStop('The speech engine stopped — tap start to resume.'));
    }, 300);
  });

  /* ============ TEACH A COMMAND (offline words) ============
     The offline brain has tables per language; this is how a word that is
     missing from them gets added without a code change. It is also how a
     language with no table yet starts working — one intent at a time. */
  const INTENT_LABEL = {
    time: 'what time is it', date: 'today’s date', greet: 'a greeting', thanks: 'thanks',
    joke: 'tell a joke', note: 'save a note', task: 'add a task', tasks: 'list tasks',
    timer: 'set a timer', timerlist: 'list timers', timerstop: 'cancel timers',
    help: 'help', languages: 'list languages', clear: 'clear the chat',
    translate: 'translate', search: 'search the web', weather: 'weather',
    privacy: 'privacy', whoami: 'who am I talking to', features: 'what can you do',
    status: 'system status', setname: 'remember my name', remember: 'remember a fact',
    recall: 'what do you remember', coin: 'flip a coin', dice: 'roll a dice',
    'open-site': 'open a site', math: 'do some math'
  };

  function fillTeach() {
    const langSel = $('#teachLang'), intentSel = $('#teachIntent');
    if (!langSel.options.length) {
      Aevion.languages.forEach(l => {
        const o = document.createElement('option');
        o.value = l.code;
        o.textContent = Aevion.langLabel(l);
        langSel.appendChild(o);
      });
      langSel.value = Aevion.settings.lang || 'en';
    }
    if (!intentSel.options.length) {
      Aevion.nlu.INTENTS.forEach(i => {
        const o = document.createElement('option');
        o.value = i;
        o.textContent = INTENT_LABEL[i] || i;
        intentSel.appendChild(o);
      });
      intentSel.value = 'time';
    }
    showTeach();
  }

  function showTeach() {
    const l = $('#teachLang').value || 'en';
    const i = $('#teachIntent').value || 'time';
    const words = Aevion.nlu.words(l, i);
    const cov = Aevion.nlu.coverage();
    $('#teachCount').textContent = '· ' + cov.length + ' languages recognised offline';
    $('#teachOut').textContent = words.length
      ? words.length + ' word(s) currently match “' + (INTENT_LABEL[i] || i) + '” in ' + l + ':\n' + words.join(', ')
      : 'No words yet for “' + (INTENT_LABEL[i] || i) + '” in ' + l + ' — the first word you add switches it on.';
  }

  $('#teachLang').onchange = showTeach;
  $('#teachIntent').onchange = showTeach;
  $('#teachSave').onclick = () => {
    const words = $('#teachWords').value.split(',').map(s => s.trim()).filter(Boolean);
    if (!words.length) return toast('Type at least one word or phrase');
    const l = $('#teachLang').value, i = $('#teachIntent').value;
    Aevion.nlu.teach(l, i, words);
    $('#teachWords').value = '';
    showTeach();
    toast('✅ Taught ' + words.length + ' word(s) for “' + (INTENT_LABEL[i] || i) + '” in ' + l, 5000);
  };
  Aevion.on('nlu:changed', showTeach);

  /* ============ SELF-UPGRADE ============ */
  function renderEvolve() {
    const on = Aevion.evolve.on();
    $('#setSelfUpgrade').checked = on;
    $('#evolveState').textContent = on ? '· allowed' : '· off';
    $('#evolveNote').textContent = on
      ? 'Allowed. Aevion can install a knowledge pack you approve in the moment — new words, a no-code plugin, proposed facts — and still nothing that is code. Turning this off is immediate and needs no approval.'
      : 'Off. No pack can be installed, and this switch itself cannot be turned on from code or from storage without your explicit approval.';

    const log = $('#upgradeLog');
    log.innerHTML = '';
    const hist = Aevion.evolve.history();
    if (!hist.length) {
      log.innerHTML = '<li><span class="grow muted">Nothing has ever been installed.</span></li>';
      return;
    }
    hist.slice(0, 10).forEach(h => {
      const li = document.createElement('li');
      const s = document.createElement('span');
      s.className = 'grow';
      s.textContent = new Date(h.t).toLocaleString() + ' · ' + h.kind + ' · ' + (h.summary || h.action) +
        (h.ok === false ? ' (refused: ' + h.code + ')' : '');
      li.appendChild(s);
      log.appendChild(li);
    });
  }

  $('#setSelfUpgrade').onchange = async e => {
    if (!e.target.checked) {
      await Aevion.evolve.set(false);
      renderEvolve();
      return toast('Self-upgrade off — nothing can be installed, and it took effect immediately');
    }
    const ok = await askConfirm({
      name: 'self-upgrade',
      desc: 'Let Aevion install knowledge packs you approve: new words for the offline brain, no-code plugins, and proposed facts. It can never install code into itself.'
    }, {}, 'This stays on until you turn it off, and every pack still needs its own approval.');
    if (!ok) { e.target.checked = false; return; }
    const r = await Aevion.evolve.set(true, { consent: true });
    renderEvolve();
    toast(r.ok ? '✅ Self-upgrade allowed — you still approve every single pack' : '❌ ' + r.reason, 6000);
  };

  $('#upgradePlan').onclick = () => {
    $('#upgradeOut').textContent = JSON.stringify(Aevion.evolve.plan(), null, 2);
  };

  $('#upgradeApply').onclick = async () => {
    let pack;
    try { pack = JSON.parse($('#upgradePack').value); }
    catch { return toast('That is not valid JSON — a pack looks like {"kind":"words","lang":"kn","intent":"timer","words":["ಟೈಮರ್"]}'); }
    if (Aevion.evolve.on()) {
      const ok = await askConfirm({
        name: 'knowledge pack',
        desc: 'Install this pack on this device: ' + JSON.stringify(pack).slice(0, 200)
      }, {}, 'The pack is applied locally. Code packs are always refused.');
      if (!ok) return;
    }
    const r = await Aevion.evolve.apply(pack, { consent: true });
    $('#upgradeOut').textContent = r.ok ? '✅ Installed: ' + r.summary : '⛔ ' + r.reason;
    renderEvolve();
  };
  Aevion.on('evolve:changed', renderEvolve);

  /* ============ APP UPDATES ============ */
  /* The card behind Settings → App updates. Checking is free; installing
     happens only on Android, only with the self-upgrade gate on, and only
     after this in-app confirm AND Android's own install dialog. The APK is
     checksum-verified before either dialog ever appears. */
  function renderUpdate() {
    if (!Aevion.update) return;
    const r = Aevion.update.report();
    const last = Aevion.settings.updateCheckedAt;
    const when = last ? new Date(last).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'never';
    const pend = Aevion.settings.updatePending;
    let state = '· v' + r.currentVersionName;
    if (pend && pend.versionCode > r.currentVersionCode) state += ' · update available: ' + pend.versionName;
    else state += ' · up to date';
    state += ' · checked ' + when;
    $('#updateState').textContent = state;
  }

  $('#updateCheck').onclick = async () => {
    const out = $('#updateOut'), note = $('#updateNote');
    out.textContent = 'Checking…';
    note.textContent = '';
    const r = await Aevion.update.checkForUpdate({ force: true });
    try {
      if (r.state === 'newer-available') {
        const rem = r.latest.remote;
        if (r.latest.canInstall) {
          out.textContent = '✅ Newer build available: ' + rem.versionName + ' (v' + rem.versionCode + ')' +
            (rem.note ? '\n' + rem.note : '') +
            '\nThe download is checksum-verified before anything is offered, it must be signed by the same key, and it replaces this app in place — chats, memory and settings stay.';
          const ok = await askConfirm({
            name: 'app update',
            desc: 'Download and install Aevion ' + rem.versionName + ' (v' + rem.versionCode + '). The APK is verified against its published checksum, then handed to Android\'s installer. Your data stays.'
          }, {}, 'Android shows its own install dialog afterwards — you approve there too. Nothing is silent.');
          if (!ok) { note.textContent = 'Deferred — the update stays listed here until you install or a newer one appears.'; renderUpdate(); return; }
          const res = await Aevion.update.installApk({ consent: true });
          if (res.ok) {
            out.textContent = '✅ ' + res.versionName + ' handed to Android — approve the system dialog. The app restarts into the new version; every chat, memory and setting stays put.';
            toast('✅ Update ' + res.versionName + ' ready — approve it in the system dialog', 6000);
          } else {
            out.textContent = '⛔ ' + (res.reason || 'The install did not happen.');
          }
        } else {
          out.textContent = '✅ Newer build available: ' + rem.versionName + ' (v' + rem.versionCode + ')' +
            (rem.note ? '\n' + rem.note : '') +
            '\nThis is a browser tab, so it cannot install the APK — open the Aevion Android app and check there, or download it yourself:\n' + rem.downloadUrl;
        }
      } else if (r.state === 'up-to-date') {
        out.textContent = '✅ This is the newest signed build (v' + r.latest.currentVersionCode + ').';
      } else if (r.state === 'offline' || r.state === 'rate-limited') {
        out.textContent = '— ' + (r.reason || 'Could not check right now.');
      } else {
        out.textContent = '⚠ ' + (r.error || 'The check failed.');
      }
    } catch (e) {
      out.textContent = '⚠ ' + ((e && e.message) || 'Something went wrong during the check.');
    }
    renderUpdate();
  };
  /* ---------- the update dialog ---------- */
  /* One place an update can start from, and one place that shows what is
     happening while it does. The card in Settings stays a status surface; the
     dialog is the action. */
  const fmtMB = n => (n / 1048576).toFixed(1) + ' MB';

  function openUpdateModal(latest) {
    if (!Aevion.update || !latest) return;
    const rem = latest.remote || {};
    const v = Aevion.update.report();
    $('#updateCurrent').textContent = v.currentVersionName + ' (v' + v.currentVersionCode + ')';
    $('#updateNewVersion').textContent = (rem.versionName || '?') + ' (v' + rem.versionCode + ')';
    $('#updateWhatsNew').textContent = rem.note
      ? rem.note
      : 'No release notes were published with this build.';

    /* Required when the publisher said so, or when this install has fallen
       below the oldest version the update source still supports. A required
       update has no Later button — a door, not a suggestion. */
    const required = latest.mandatory === true;
    const req = $('#updateRequired');
    req.classList.toggle('hidden', !required);
    if (required) {
      req.textContent = latest.belowFloor
        ? 'This update is required — Aevion ' + v.currentVersionName + ' is older than the oldest version this update source still supports.'
        : 'This update is required by the publisher.';
    }
    $('#updateLater').classList.toggle('hidden', required);
    $('#updateStatus').textContent = '';
    $('#updateProgressWrap').classList.remove('on');
    $('#updateProgressBar').style.width = '0%';
    $('#updateNow').disabled = false;
    $('#updateModal').classList.remove('hidden');
  }

  const closeUpdateModal = () => $('#updateModal').classList.add('hidden');

  /* Download progress, told honestly: a percentage when the server sent a
     Content-Length, and the bytes so far when it did not. */
  function updateProgress(p) {
    const wrap = $('#updateProgressWrap'), bar = $('#updateProgressBar');
    wrap.classList.add('on');
    const pct = (p && typeof p.percent === 'number') ? p.percent : null;
    if (pct !== null) {
      bar.style.width = pct + '%';
      $('#updateStatus').textContent = 'Downloading… ' + pct + '%'
        + (p.total ? ' (' + fmtMB(p.loaded) + ' of ' + fmtMB(p.total) + ')' : '');
    } else {
      $('#updateStatus').textContent = 'Downloading… ' + fmtMB((p && p.loaded) || 0);
    }
  }

  $('#updateNow').onclick = async () => {
    if (!Aevion.update) return;
    $('#updateNow').disabled = true;
    $('#updateStatus').textContent = 'Downloading…';
    $('#updateProgressWrap').classList.add('on');

    /* consent: true is this button. The system dialog that follows is the
       second, mandatory approval — Android will not install without it. */
    const res = await Aevion.update.installApk({ consent: true, onProgress: updateProgress });

    $('#updateProgressWrap').classList.remove('on');
    if (res.ok) {
      $('#updateStatus').textContent = '✅ ' + res.versionName
        + ' handed to Android — approve the system dialog. Your data stays.';
      toast('✅ Aevion ' + res.versionName + ' ready — approve it in the system dialog', 6000);
      closeUpdateModal();
    } else {
      $('#updateStatus').textContent = '⛔ ' + (res.reason || 'The update did not happen.');
      $('#updateNow').disabled = false;
    }
    renderUpdate();
  };

  $('#updateLater').onclick = () => {
    const r = Aevion.update.deferLater();
    closeUpdateModal();
    toast(r.ok ? '👍 Reminder postponed — the offer comes back tomorrow' : '⚠ ' + r.reason, 5000);
    renderUpdate();
  };

  Aevion.on('update:new-version', latest => {
    renderUpdate();
    /* Never interrupt: if the user already said "later", the offer waits. */
    if (Aevion.update && !Aevion.update.isDeferred()) openUpdateModal(latest);
  });
  /* Fired the moment Android accepts the install session — usually the last
     thing the old version ever does before the system restarts it into the
     new one. Whatever is still painted says so plainly. */
  Aevion.on('update:installed', info => {
    toast('✅ Aevion ' + (info && info.versionName ? info.versionName : '') + ' is installing — your data stays', 8000);
    try { renderUpdate(); } catch (e) { /* the card must not be the thing that fails */ }
  });
  renderUpdate();

  /* ---------- what the day's learning noticed ---------- */
  Aevion.on('learn:day', entry => {
    if (!entry || !entry.ran) return;
    if (!entry.noticed.length) return;
    toast('🧠 Today’s learning: ' + entry.noticed.length + ' thing(s) worth remembering — approve them in 🧠 Memory', 8000);
  });

  /* ============ BACKGROUND ============ */
  function renderBackground() {
    const on = !!Aevion.settings.background;
    $('#setBackground').checked = on;
    $('#backgroundNote').textContent = on
      ? 'Timers keep counting and ring while you are in another app, hands-free stays armed, and anything that came due is reported when you come back instead of being swallowed. Your device may still suspend a backgrounded page — the Android app is not suspended.'
      : 'With this off, Aevion stops listening and stops catching anything up the moment the page is hidden. It never changes anything while you are away.';
  }
  $('#setBackground').onchange = e => {
    Aevion.set('background', e.target.checked);
    renderBackground();
    toast(e.target.checked
      ? 'Background on — timers and the wake word keep going while you are elsewhere'
      : 'Background off — Aevion pauses whenever the page is hidden');
  };

  /* ============ NETWORK STATUS ============ */
  function netPill() {
    const on = navigator.onLine;
    const el = $('#hudNet');
    el.textContent = on ? 'NET' : 'OFFLINE';
    el.className = 'pill ' + (on ? 'net-on' : 'net-off');
  }
  window.addEventListener('online', () => {
    netPill();
    if (Aevion.online && Aevion.online.down && Aevion.online.down()) {
      Aevion.online.markUp();
      toast('🌐 Internet is back — online AI is available again', 3500);
    }
    renderMode();
  });
  window.addEventListener('offline', () => {
    netPill();
    if (Aevion.online && Aevion.online.markDown) Aevion.online.markDown('no internet connection');
    applySettings();
  });
  /* A cooldown does not announce itself: without this tick the pill could
     claim OFFLINE AI for up to a minute after the endpoint came back. */
  setInterval(() => renderMode(), 15000);

  /* ============ BOOT ============ */
  async function boot() {
    Aevion.settings = Object.assign({}, Aevion.defaults, Aevion.store.get('settings', {}));
    Aevion.settings.perms = Object.assign({}, Aevion.defaults.perms, Aevion.settings.perms);

    /* Hands-free never reopens by itself: the microphone closed with the page,
       and listening again is the user's call, not the app's. Clear the flag
       rather than leave a lit switch sitting over a closed microphone. */
    if (Aevion.settings.wake) {
      Aevion.settings.wake = false;
      Aevion.store.set('settings', Aevion.settings);
      setTimeout(() => toast(`Hands-free was on when you left — the microphone closed with the page. Turn “Answer when I say ${Aevion.settings.name || 'Aevion'}” back on in 🎤 Voice to resume.`, 6000), 400);
    }

    // 1. vault first: providers read keys from it, and it has to know whether
    //    it is encrypted before any key is shown or used
    try { await Aevion.secrets.init(); } catch (e) { console.warn('secrets vault', e); }

    // 2. one-time migrations (flat AI settings → per-provider config,
    //    flat memory array → the layered store)
    Aevion.providers.migrateLegacy();
    Aevion.memory.migrate();

    applySettings();
    fillSettings();
    renderMulti();
    renderPerms();
    /* The first call at load-time is deliberately skipped (settings did not
       exist yet), so the card is painted here instead of being left blank
       until the first permission change. */
    renderDeviceAccess();
    // timers and the device-theme watcher survive a reload by being re-armed here
    Aevion.tools.timers.rearm();
    Aevion.theme.watchDevice();
    renderMemory();
    renderTools();
    renderBrainLog();
    renderWake();
    netPill();
    $('#verLabel').textContent = Aevion.version;
    /* Ask the native bridge for the package versionCode once, so the
       update comparison uses the number the APK was actually built with
       instead of one derived from the web version string. */
    if (Aevion.update && Aevion.update.initNative) Aevion.update.initNative();

    /* One quiet check a moment after boot, so “the AI is not working” is
       answered on the screen instead of in a failed reply. It runs only when
       something could answer at all — a privacy-default install is never
       probed — and never while the first screen is still painting. */
    setTimeout(() => {
      const q = Aevion.setup.quick();
      if (q.ok && q.kind !== 'local') refreshBrain(true); else renderBrainCard();
    }, 1600);

    /* The automatic update check, started a moment after boot — never before
       the first screen is painted, never while locked. startAutoCheck covers
       the three moments that matter: boot, each return to the foreground (that
       is when a stale build is most obvious), and a half-hourly heartbeat
       while the app stays open. All three go through the module's own 6-hour
       floor, refuse to run offline, and never install anything: they only ever
       raise the offer, which the user answers.

       The offer it raises is the dialog; if the user already chose "later",
       the module stays quiet until that expires. */
    setTimeout(() => {
      if (Aevion.update && Aevion.update.startAutoCheck) {
        Aevion.update.startAutoCheck({
          onNewer: latest => { if (!Aevion.update.isDeferred()) openUpdateModal(latest); }
        });
      }
    }, 2200);

    // PIN lock
    /* PIN lock — and, if asked for, the same lock when Aevion is opened in a
       plain browser tab instead of its own app. A browser tab is the weaker
       place to be: any other window on this computer shares its storage, so
       the user can require the PIN before anything is shown there. */
    const outside = !!Aevion.settings.pinOutside && !Aevion.perms.shell();
    if ((Aevion.settings.pinOn || outside) && Aevion.settings.pinHash) {
      $('#lock').classList.remove('hidden');
      const tryUnlock = async () => {
        const v = $('#lockPin').value;
        if (await Aevion.hash(v) === Aevion.settings.pinHash) {
          $('#lock').classList.add('hidden');
          $('#lockPin').value = ''; $('#lockErr').textContent = '';
          // the same PIN decrypts the stored credentials (AES-GCM)
          try { await Aevion.secrets.unlock(v); } catch (e) { toast('Stored keys could not be decrypted: ' + e.message); }
          fillAI();
          afterUnlock();
        } else { $('#lockErr').textContent = 'Wrong PIN'; $('#lockPin').value = ''; }
      };
      $('#lockBtn').onclick = tryUnlock;
      $('#lockPin').addEventListener('keydown', e => { if (e.key === 'Enter') tryUnlock(); });
    } else afterUnlock();

    function afterUnlock() {
      // restore collapsed state
      if (Aevion.settings.navCollapsed) document.body.classList.add('collapsed');

      // restore chat history view
      const h = history();
      if (h.length) h.slice(-30).forEach(m => addMsg(m.role, m.text, ''));

      // launch automations
      const launchers = autos.filter(a => a.when === 'onLaunch');
      if (launchers.length) setTimeout(() => launchers.forEach(runAuto), 900);

      /* Learning a little every day — at most once a day, only candidates,
         and never an approval: whatever it notices waits in 🧠 Memory. */
      if (Aevion.settings.background && Aevion.evolve.due()) {
        setTimeout(() => { Aevion.evolve.learn(); }, 2500);
      }

      // boot fade
      setTimeout(() => {
        const b = $('#boot');
        b.style.opacity = '0';
        setTimeout(() => b.remove(), 500);
        if (!h.length) {
          reply(`Aevion ${Aevion.version} online — running 100% locally on this device.\nTry: "/help", a math expression, "remember: …", or flip on online AI in Settings when you want it.`, 'SYSTEM');
          /* After boot, give the user one clear status line about Aevion's own
             update story — what version it is, where it came from, and whether
             a newer signed build is waiting. This is informational only: the
             user always approves any install, and the browser cannot install
             anything. */
          if (typeof Aevion.update === 'object' && typeof Aevion.update.report === 'function') {
            try {
              const r = Aevion.update.report()
              const from = r.isAndroid
                ? 'installed as an app'
                : 'running as a web app (a browser tab cannot replace an installed app — update by downloading the APK yourself)'
              let status = `You're on Aevion ${r.currentVersionName} (${from})`
              if (r.pending) {
                status += `. A newer signed build is waiting — ${r.pending.versionName} (v${r.pending.versionCode}). In Settings → App updates you can check for it and install it — only if you approve, and only inside the Aevion app.`
              } else if (r.isAndroid) {
                status += `. There's no newer signed build right now — this is the latest one for this device.`
              } else {
                status += `. Check for a newer build in Settings → App updates — the app will tell you what's waiting and, on Android, install it in place with your approval. In a browser tab you download the signed APK yourself and install it the way you install any app.`
              }
              reply(status, 'SYSTEM')
            } catch (e) { /* update module is optional — a bad check never breaks the boot */ }
          }
        }
      }, 700);

      // service worker (only when served over http/https)
      if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
        navigator.serviceWorker.register('sw.js').catch(() => {});
      }
    }
  }

  boot();
})();
