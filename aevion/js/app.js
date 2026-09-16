/* ============================================================
 * Aevion App — UI wiring, views, chat pipeline, settings
 * ============================================================ */
(function () {
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];

  /* ============ THEME / APPEARANCE ============ */
  const THEMES = ['cyber', 'midnight', 'aurora', 'synthwave', 'light', 'mono'];

  function applySettings() {
    const s = Aevion.settings;
    document.documentElement.dataset.theme = s.theme;
    document.documentElement.style.setProperty('--accent', s.accent);
    $('#hudName').textContent = (s.name || 'AEVION').toUpperCase();
    $('#hudMode').textContent = s.onlineAI ? 'ONLINE AI' : 'LOCAL';
    $('#hudMode').className = 'pill ' + (s.onlineAI ? 'mode-online' : 'mode-local');
    document.title = `${s.name} — Private AI Assistant`;
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
  }
  $$('.nav-item').forEach(b => b.onclick = () => show(b.dataset.view));
  $('#navToggle').onclick = () => document.body.classList.toggle('nav-open');

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
    }
    d.appendChild(document.createTextNode(text));
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
    return d;
  }

  function history() { return Aevion.store.get('chatHistory', []); }
  function pushHistory(role, text) {
    const h = history();
    h.push({ role, text, t: Date.now() });
    Aevion.store.set('chatHistory', h.slice(-60));
  }

  async function send() {
    const inp = $('#chatInput');
    let text = inp.value.trim();
    if (!text) return;
    if (tmode && !text.startsWith('/')) text = 'translate ' + text + ' to ' + (Aevion.settings.lang || 'en');
    inp.value = '';
    inp.style.height = 'auto';
    addMsg('user', text);
    pushHistory('user', text);

    // plugin commands first
    const pc = Aevion.plugins && Aevion.plugins.commands;
    const cmdKey = Object.keys(pc || {}).find(k => text.toLowerCase().startsWith(k));
    if (cmdKey) {
      try {
        const out = await pc[cmdKey](text);
        reply(out, 'plugin');
      } catch (e) { reply('Plugin error: ' + e.message, 'plugin'); }
      return;
    }

    const route = Aevion.brain.route(text);

    // open conversation → online AI if user enabled it, else local fallback
    if (route.kind === 'chat' || route.kind === 'math-maybe') {
      if (Aevion.settings.onlineAI) {
        const thinking = addMsg('ai', '…thinking via your AI endpoint…', 'ONLINE AI');
        try {
          const msgs = [{ role: 'system', content: Aevion.online.systemPrompt() },
            ...history().slice(-10).map(h => ({ role: h.role === 'ai' ? 'assistant' : 'user', content: h.text }))];
          const out = await Aevion.online.chat(msgs);
          thinking.remove();
          reply(out, 'online AI');
          return;
        } catch (e) {
          thinking.remove();
          addMsg('ai', '⚠ Online AI failed: ' + e.message + '\nFalling back to local brain.', 'error');
        }
      }
      const local = await Aevion.brain.handle(text);
      reply(local, 'local brain');
      return;
    }

    const out = await Aevion.brain.handle(text);
    reply(out, 'local brain');
  }

  function reply(text, source) {
    addMsg('ai', text, (source || '').toUpperCase());
    pushHistory('ai', text);
    Aevion.voice.speak(text);
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

  // translator quick-mode
  let tmode = false;
  $('#translateToggle').onclick = () => {
    tmode = !tmode;
    $('#translateToggle').style.color = tmode ? 'var(--accent)' : '';
    $('#chatInput').placeholder = tmode ? 'Translate mode: text… (goes to your language)' : 'Ask Aevion…  (/help for commands)';
  };
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
  Aevion.on('voice:final', text => {
    if (!text) return;
    $('#chatInput').value = text;
    send();
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
        Aevion.voice.speak('Focus session complete. Take a break.');
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
    Aevion.voice.speak(out);
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
      data: Aevion.store.dump()
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
        $('#syncOut').textContent = `✅ Imported ${Object.keys(bundle.data).length} data sections from ${bundle.from.label} (${bundle.exported}). Reloading…`;
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

  /* ============ PLUGINS ============ */
  Aevion.plugins = { list: [], commands: {}, register(p) { this.list.push(p); Object.assign(this.commands, p.commands || {}); } };
  function renderPlugins() {
    const el = $('#pluginList');
    el.innerHTML = '';
    (Aevion.plugins.list.length ? Aevion.plugins.list : [{ name: '(none loaded)', desc: '' }]).forEach(p => {
      const li = document.createElement('li');
      li.innerHTML = `<span class="grow"><b>${p.name}</b> — ${p.desc}</span>`;
      el.appendChild(li);
    });
  }
  renderPlugins();
  // hello-world plugin registers itself after this point via its own file; re-render on load
  window.addEventListener('load', renderPlugins);

  /* ============ SETTINGS ============ */
  const themeSel = $('#setTheme');
  THEMES.forEach(t => { const o = document.createElement('option'); o.value = t; o.textContent = t; themeSel.appendChild(o); });

  function fillSettings() {
    const s = Aevion.settings;
    themeSel.value = s.theme; $('#setAccent').value = s.accent;
    $('#setName').value = s.name; $('#setPersona').value = s.persona; $('#setLang').value = s.lang;
    $('#setSpeak').checked = !!s.speak;
    $('#setOnlineAI').checked = !!s.onlineAI; $('#setAIProvider').value = s.aiProvider;
    $('#setAIUrl').value = s.aiUrl; $('#setAIModel').value = s.aiModel; $('#setAIKey').value = s.aiKey;
    $('#setOnlineSearch').checked = !!s.onlineSearch; $('#setMemory').checked = !!s.memory;
    $('#setPinOn').checked = !!s.pinOn;
  }

  function refreshVoices() {
    const sel = $('#setVoice');
    sel.innerHTML = '<option value="">(system default)</option>';
    try {
      speechSynthesis.getVoices().forEach(v => {
        const o = document.createElement('option');
        o.value = v.voiceURI; o.textContent = `${v.name} (${v.lang})`;
        sel.appendChild(o);
      });
      if (Aevion.settings.voiceURI) sel.value = Aevion.settings.voiceURI;
    } catch {}
  }
  if ('speechSynthesis' in window) {
    refreshVoices();
    speechSynthesis.onvoiceschanged = refreshVoices;
  }

  themeSel.onchange = () => { Aevion.set('theme', themeSel.value); applySettings(); };
  $('#setAccent').oninput = e => { Aevion.set('accent', e.target.value); applySettings(); };
  $('#setName').onchange = e => { Aevion.set('name', e.target.value || 'Aevion'); applySettings(); };
  $('#setPersona').onchange = e => Aevion.set('persona', e.target.value);
  $('#setLang').onchange = e => Aevion.set('lang', e.target.value);
  $('#setVoice').onchange = e => Aevion.set('voiceURI', e.target.value);
  $('#setSpeak').onchange = e => Aevion.set('speak', e.target.checked);

  $('#setOnlineAI').onchange = e => { Aevion.set('onlineAI', e.target.checked); applySettings(); toast(e.target.checked ? 'Online AI enabled — your choice, always reversible' : 'Online AI disabled — fully local again'); };
  $('#setAIProvider').onchange = e => {
    Aevion.set('aiProvider', e.target.value);
    if (e.target.value === 'ollama') {
      $('#setAIUrl').value = 'http://localhost:11434/v1/chat/completions';
      $('#setAIModel').value = 'llama3.2';
    } else {
      $('#setAIUrl').value = '';
      $('#setAIModel').value = '';
    }
    Aevion.set('aiUrl', $('#setAIUrl').value); Aevion.set('aiModel', $('#setAIModel').value);
  };
  $('#setAIUrl').onchange = e => Aevion.set('aiUrl', e.target.value.trim());
  $('#setAIModel').onchange = e => Aevion.set('aiModel', e.target.value.trim());
  $('#setAIKey').onchange = e => Aevion.set('aiKey', e.target.value.trim());
  $('#setOnlineSearch').onchange = e => Aevion.set('onlineSearch', e.target.checked);
  $('#setMemory').onchange = e => Aevion.set('memory', e.target.checked);

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

  // PIN
  $('#setPinSave').onclick = async () => {
    const p = $('#setPin1').value;
    if (!/^\d{4,8}$/.test(p)) return toast('PIN must be 4-8 digits');
    Aevion.set('pinHash', await Aevion.hash(p));
    $('#setPin1').value = '';
    toast('PIN saved. Enable "PIN lock on start" to use it.');
  };
  $('#setPinOn').onchange = e => {
    if (e.target.checked && !Aevion.settings.pinHash) {
      e.target.checked = false;
      toast('Save a PIN first');
    } else Aevion.set('pinOn', e.target.checked);
  };

  // export / wipe
  $('#exportData').onclick = () => {
    const blob = new Blob([JSON.stringify({ app: 'aevion', v: Aevion.version, data: Aevion.store.dump() }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'aevion-backup-' + Date.now() + '.json';
    a.click();
  };
  $('#wipeBtn').onclick = () => {
    if (!confirm('Factory reset: delete ALL Aevion data on this device? This cannot be undone.')) return;
    if (!confirm('Really sure? Export a backup first if you need one.')) return;
    Aevion.store.keys().forEach(k => Aevion.store.del(k));
    location.reload();
  };

  /* ============ NETWORK STATUS ============ */
  function netPill() {
    const on = navigator.onLine;
    const el = $('#hudNet');
    el.textContent = on ? 'NET' : 'OFFLINE';
    el.className = 'pill ' + (on ? 'net-on' : 'net-off');
  }
  window.addEventListener('online', netPill);
  window.addEventListener('offline', netPill);

  /* ============ BOOT ============ */
  async function boot() {
    Aevion.settings = Object.assign({}, Aevion.defaults, Aevion.store.get('settings', {}));
    Aevion.settings.perms = Object.assign({}, Aevion.defaults.perms, Aevion.settings.perms);
    applySettings();
    fillSettings();
    renderPerms();
    netPill();
    $('#verLabel').textContent = Aevion.version;

    // PIN lock
    if (Aevion.settings.pinOn && Aevion.settings.pinHash) {
      $('#lock').classList.remove('hidden');
      const tryUnlock = async () => {
        const v = $('#lockPin').value;
        if (await Aevion.hash(v) === Aevion.settings.pinHash) {
          $('#lock').classList.add('hidden');
          $('#lockPin').value = ''; $('#lockErr').textContent = '';
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

      // boot fade
      setTimeout(() => {
        const b = $('#boot');
        b.style.opacity = '0';
        setTimeout(() => b.remove(), 500);
        if (!h.length) {
          reply(`Aevion ${Aevion.version} online — running 100% locally on this device.\nTry: "/help", a math expression, "remember: …", or flip on online AI in Settings when you want it.`, 'SYSTEM');
        }
      }, 700);

      // service worker (only when served over http/https)
      if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
        navigator.serviceWorker.register('sw.js').catch(() => {});
      }
    }
  }

  // nav collapse persistence
  $('#navToggle').addEventListener('dblclick', () => {
    document.body.classList.toggle('collapsed');
    Aevion.set('navCollapsed', document.body.classList.contains('collapsed'));
  });

  boot();
})();
