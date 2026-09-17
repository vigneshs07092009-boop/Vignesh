/* ============================================================
 * Aevion Core — storage, events, permissions, memory, crypto
 * ============================================================ */
window.Aevion = {
  version: '0.4.1',
  bus: new EventTarget(),
  emit(ev, data) { this.bus.dispatchEvent(new CustomEvent(ev, { detail: data })); },
  on(ev, fn) { this.bus.addEventListener(ev, fn); },

  /* ---------- storage (namespaced, JSON-safe) ---------- */
  store: {
    get(k, dflt) {
      try {
        const raw = localStorage.getItem('aevion:' + k);
        return raw == null ? dflt : JSON.parse(raw);
      } catch { return dflt; }
    },
    set(k, v) { try { localStorage.setItem('aevion:' + k, JSON.stringify(v)); } catch (e) { console.warn('store', e); } },
    del(k) { try { localStorage.removeItem('aevion:' + k); } catch {} },
    keys() { return Object.keys(localStorage).filter(k => k.startsWith('aevion:')).map(k => k.slice(7)); },
    dump() {
      const o = {};
      for (const k of this.keys()) {
        try { o[k] = JSON.parse(localStorage.getItem('aevion:' + k)); } catch {}
      }
      return o;
    },
    load(d) { for (const [k, v] of Object.entries(d || {})) this.set(k, v); }
  },

  /* ---------- settings ---------- */
  settings: null,
  defaults: {
    theme: 'cyber', accent: '#37e0c8', name: 'Aevion', persona: 'balanced', lang: 'en',
    voiceURI: '', speak: false,
    onlineAI: false, aiProvider: 'ollama', aiUrl: 'http://localhost:11434/v1/chat/completions', aiModel: 'llama3.2', aiKey: '',
    onlineSearch: false, memory: true,
    webllm: false, webllmModel: 'Llama-3.2-1B-Instruct-q4f16_1-MLC',
    pinOn: false, pinHash: '',
    pairHash: '', pairPub: '',
    perms: { notifications: false, geolocation: false, camera: false, microphone: false, clipboardWrite: false, automation: false, contacts_read: false, files_read: false, calendar_read: false },
    navCollapsed: false
  },

  set(key, val) {
    this.settings[key] = val;
    this.store.set('settings', this.settings);
  },

  async hash(s) {
    const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
  },
  randomId() { return crypto.getRandomValues(new Uint32Array(1))[0].toString(36) + Date.now().toString(36); },

  /* ---------- permission manager ---------- */
  perms: {
    map: {
      notifications: { label: 'Notifications', req: () => Notification.requestPermission() },
      geolocation: { label: 'Location (weather etc.)', req: () => new Promise((res) => {
        if (!navigator.geolocation) return res('denied');
        navigator.geolocation.getCurrentPosition(() => res('granted'), () => res('denied'), { timeout: 8000 });
      })},
      camera: { label: 'Camera', req: () => navigator.mediaDevices.getUserMedia({ video: true }).then(s => { s.getTracks().forEach(t => t.stop()); return 'granted'; }).catch(() => 'denied') },
      microphone: { label: 'Microphone (voice input)', req: () => navigator.mediaDevices.getUserMedia({ audio: true }).then(s => { s.getTracks().forEach(t => t.stop()); return 'granted'; }).catch(() => 'denied') },
      clipboardWrite: { label: 'Clipboard write', req: async () => { try { await navigator.clipboard.writeText(' '); return 'granted'; } catch { return 'denied'; } } },
      automation: { label: 'Automation (device actions)', req: () => 'browser' },
      contacts_read: { label: 'Contacts (read)', req: () => 'browser' },
      files_read: { label: 'File access', req: () => 'browser' },
      calendar_read: { label: 'Calendar (read)', req: () => 'browser' }
    },
    get(k) { return (Aevion.settings.perms || {})[k] || false; },
    async request(k) {
      const def = this.map[k];
      if (!def) return 'unknown';
      const r = await def.req();
      const granted = r === 'granted' || r === 'browser';
      Aevion.settings.perms[k] = granted;
      Aevion.store.set('settings', Aevion.settings);
      Aevion.emit('perm:changed', { key: k, granted });
      return granted ? 'granted' : 'denied';
    },
    revoke(k) {
      Aevion.settings.perms[k] = false;
      Aevion.store.set('settings', Aevion.settings);
      Aevion.emit('perm:changed', { key: k, granted: false });
    },
    status(k) {
      if (!Aevion.settings) return 'off';
      if (!this.map[k]) return 'unknown';
      return Aevion.settings.perms[k] ? 'granted' : 'off';
    }
  },

  /* ---------- long-term memory ---------- */
  memory: {
    all() { return Aevion.store.get('memory', []); },
    add(text, tag) {
      const items = this.all();
      const t = (text || '').trim();
      if (!t) return null;
      if (items.some(i => i.text.toLowerCase() === t.toLowerCase())) return null;
      items.push({ id: Aevion.randomId(), text: t, tag: tag || 'fact', t: Date.now() });
      Aevion.store.set('memory', items.slice(-500));
      return t;
    },
    find(q) {
      q = (q || '').toLowerCase();
      return this.all().filter(i => i.text.toLowerCase().includes(q));
    },
    remove(id) { Aevion.store.set('memory', this.all().filter(i => i.id !== id)); },
    clear() { Aevion.store.set('memory', []); }
  },

  /* ---------- device identity (local only) ---------- */
  identity: {
    id() { let id = Aevion.store.get('deviceId'); if (!id) { id = Aevion.randomId() + '-' + Aevion.randomId(); Aevion.store.set('deviceId', id); } return id; },
    label() { return Aevion.store.get('deviceLabel') || (navigator.platform || 'device'); }
  }
};
