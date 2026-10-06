/* ============================================================
 * Aevion Core — storage, events, permissions, memory, crypto
 * ============================================================ */
/* ---------- small crypto helpers (WebCrypto, no dependencies) ---------- */
const __enc = new TextEncoder();
const __dec = new TextDecoder();
function b64(bytes) {
  let s = '';
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s);
}
function unb64(str) {
  const raw = atob(String(str || ''));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
function deriveKey(pin, salt, iterations = 150000) {
  return crypto.subtle
    .importKey('raw', __enc.encode(String(pin)), 'PBKDF2', false, ['deriveKey'])
    .then(base => crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    ));
}
async function encryptValue(key, plain) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, __enc.encode(plain));
  return { i: b64(iv), c: b64(ct) };
}
async function decryptValue(key, rec) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(rec.i) }, key, unb64(rec.c));
  return __dec.decode(pt);
}

/* Ask for a device once and release it immediately: Aevion only ever wants
   the *permission*, never a live track it has to supervise. Missing or
   blocked media APIs answer 'denied' — a denial the UI can explain —
   instead of throwing a TypeError out of the permission manager. */
async function capturePermission(constraints) {
  const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : null;
  if (!md || !md.getUserMedia) return 'denied';
  try {
    const stream = await md.getUserMedia(constraints);
    stream.getTracks().forEach(t => t.stop());
    return 'granted';
  } catch { return 'denied'; }
}

window.Aevion = {    version: '0.6.7',
  bus: new EventTarget(),
  emit(ev, data) { this.bus.dispatchEvent(new CustomEvent(ev, { detail: data })); },
  // handlers receive the payload itself, not the CustomEvent wrapper
  on(ev, fn) { this.bus.addEventListener(ev, e => fn(e && e.detail)); },

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
    load(d) { for (const [k, v] of Object.entries(d || {})) this.set(k, v); },
    /* Same as dump(), minus credentials. Used by every export path so an
       API key can never travel inside a backup or a sync bundle. */
    dumpSafe() {
      const o = this.dump();
      for (const k of Object.keys(o)) {
        if (k === 'secrets' || k.startsWith('aiKey:') || k === 'aiKey') delete o[k];
      }
      return o;
    }
  },

  /* ---------- secrets vault ----------
     API keys never go into `settings`. Reads are synchronous (from an
     in-memory cache) so any module can ask for a key; writes persist
     asynchronously. When a PIN is set the vault is encrypted at rest
     with AES-GCM under a PBKDF2 key derived from that PIN, and nothing
     can be read until the PIN is entered at unlock. */
  secrets: {
    _cache: {},
    _key: null,
    _encrypted: false,
    _salt: null,

    isEncrypted() { return !!this._encrypted; },
    isLocked() { return !!this._encrypted && !this._key; },

    /* Called once at boot, before any provider reads a key. */
    async init() {
      const blob = Aevion.store.get('secrets', null);
      if (!blob || typeof blob !== 'object') { this._cache = {}; this._encrypted = false; return; }
      this._encrypted = !!blob.e;
      this._salt = blob.salt ? unb64(blob.salt) : null;
      this._cache = {};
      if (!this._encrypted) {
        for (const [k, v] of Object.entries(blob.items || {})) this._cache[k] = String(v);
      }
      return this.isLocked() ? 'locked' : 'ready';
    },

    names() { return Object.keys(this._cache); },
    get(name) { return this._cache[name] || ''; },
    has(name) { return !!this.get(name); },

    put(name, value) {
      const v = value == null ? '' : String(value);
      if (v) this._cache[name] = v; else delete this._cache[name];
      return this._persist();
    },
    del(name) { delete this._cache[name]; return this._persist(); },
    clear() { this._cache = {}; Aevion.store.del('secrets'); },

    /* Turn on encryption-at-rest using the user's PIN. */
    async enable(pin) {
      if (!pin) throw new Error('A PIN is required to encrypt stored keys.');
      this._salt = this._salt || crypto.getRandomValues(new Uint8Array(16));
      this._key = await deriveKey(pin, this._salt);
      this._encrypted = true;
      await this._persist();
      return true;
    },

    /* Back to plaintext storage (used when the PIN lock is switched off). */
    async disable() {
      this._encrypted = false;
      this._key = null;
      await this._persist();
      return true;
    },

    /* Reads every stored secret once the PIN is known. */
    async unlock(pin) {
      if (!this._salt) throw new Error('This vault has no stored key material.');
      const blob = Aevion.store.get('secrets', null) || { items: {} };
      const key = await deriveKey(pin, this._salt);
      const cache = {};
      for (const [name, rec] of Object.entries(blob.items || {})) {
        if (rec && rec.c) cache[name] = await decryptValue(key, rec);
        else if (typeof rec === 'string') cache[name] = rec;
      }
      this._key = key;
      this._encrypted = true;
      this._cache = cache;
      return this.names().length;
    },

    lock() { this._key = null; if (this._encrypted) this._cache = {}; },

    async _persist() {
      if (this._encrypted) {
        if (!this._key) throw new Error('The vault is locked — unlock it with your PIN first.');
        const items = {};
        for (const [name, value] of Object.entries(this._cache)) items[name] = await encryptValue(this._key, value);
        Aevion.store.set('secrets', { e: 1, salt: b64(this._salt), items });
      } else {
        Aevion.store.set('secrets', { e: 0, salt: null, items: Object.assign({}, this._cache) });
      }
      Aevion.emit('secrets:changed', { encrypted: this._encrypted });
      return true;
    }
  },

  /* ---------- settings ---------- */
  settings: null,
  defaults: {
    theme: 'cyber', accent: '#37e0c8', name: 'Aevion', persona: 'balanced', lang: 'en',
    voiceURI: '', voiceStyle: 'system', speak: false,
    wake: false, ttsRate: 1, ttsPitch: 1, speechLang: '', speechInterim: true,
    deviceAccess: false, background: true, followDevice: false,
    onlineAI: false, autoAI: true, aiProvider: 'ollama', aiUrl: '', aiModel: '', aiKey: '',
    aiFallback: true,
    /* More than one brain: which providers to use together, and how. */
    brainSet: [], brainStrategy: 'first',
    onlineSearch: false, memory: true,
    webllm: false, webllmModel: 'Llama-3.2-1B-Instruct-q4f16_1-MLC',
    pinOn: false, pinOutside: false, pinHash: '',
    pairHash: '', pairPub: '',
    perms: { notifications: false, geolocation: false, camera: false, microphone: false, clipboardWrite: false, automation: false, open_apps: false, contacts_read: false, files_read: false, calendar_read: false },
    navCollapsed: false
  },

  /* Every language Aevion can listen in, speak and translate to — one table,
     so the two dropdowns, the recognizer, the voice picker and the translate
     skill can never disagree about what "hi" means. `label` is the endonym
     (how the language names itself), `english` is its English name — the
     pickers show both, via langLabel(), so a language you do not read is still
     one you can find — and `tag` is what a speech engine needs, region and
     all, because a bare "hi" has come back as Hindi (US). */
  languages: [
    { code: 'en', label: 'English', english: 'English', tag: 'en-US' },
    { code: 'hi', label: 'हिन्दी', english: 'Hindi', tag: 'hi-IN' },
    { code: 'ta', label: 'தமிழ்', english: 'Tamil', tag: 'ta-IN' },
    { code: 'te', label: 'తెలుగు', english: 'Telugu', tag: 'te-IN' },
    { code: 'kn', label: 'ಕನ್ನಡ', english: 'Kannada', tag: 'kn-IN' },
    { code: 'ml', label: 'മലയാളം', english: 'Malayalam', tag: 'ml-IN' },
    { code: 'bn', label: 'বাংলা', english: 'Bengali', tag: 'bn-IN' },
    { code: 'mr', label: 'मराठी', english: 'Marathi', tag: 'mr-IN' },
    { code: 'gu', label: 'ગુજરાતી', english: 'Gujarati', tag: 'gu-IN' },
    { code: 'pa', label: 'ਪੰਜਾਬੀ', english: 'Punjabi', tag: 'pa-IN' },
    { code: 'or', label: 'ଓଡ଼ିଆ', english: 'Odia', tag: 'or-IN' },
    { code: 'as', label: 'অসমীয়া', english: 'Assamese', tag: 'as-IN' },
    { code: 'ur', label: 'اردو', english: 'Urdu', tag: 'ur-IN' },
    { code: 'ne', label: 'नेपाली', english: 'Nepali', tag: 'ne-NP' },
    { code: 'si', label: 'සිංහල', english: 'Sinhala', tag: 'si-LK' },
    { code: 'es', label: 'Español', english: 'Spanish', tag: 'es-ES' },
    { code: 'fr', label: 'Français', english: 'French', tag: 'fr-FR' },
    { code: 'de', label: 'Deutsch', english: 'German', tag: 'de-DE' },
    { code: 'it', label: 'Italiano', english: 'Italian', tag: 'it-IT' },
    { code: 'pt', label: 'Português', english: 'Portuguese', tag: 'pt-BR' },
    { code: 'nl', label: 'Nederlands', english: 'Dutch', tag: 'nl-NL' },
    { code: 'sv', label: 'Svenska', english: 'Swedish', tag: 'sv-SE' },
    { code: 'da', label: 'Dansk', english: 'Danish', tag: 'da-DK' },
    { code: 'nb', label: 'Norsk', english: 'Norwegian', tag: 'nb-NO' },
    { code: 'fi', label: 'Suomi', english: 'Finnish', tag: 'fi-FI' },
    { code: 'pl', label: 'Polski', english: 'Polish', tag: 'pl-PL' },
    { code: 'cs', label: 'Čeština', english: 'Czech', tag: 'cs-CZ' },
    { code: 'ro', label: 'Română', english: 'Romanian', tag: 'ro-RO' },
    { code: 'hu', label: 'Magyar', english: 'Hungarian', tag: 'hu-HU' },
    { code: 'el', label: 'Ελληνικά', english: 'Greek', tag: 'el-GR' },
    { code: 'ru', label: 'Русский', english: 'Russian', tag: 'ru-RU' },
    { code: 'uk', label: 'Українська', english: 'Ukrainian', tag: 'uk-UA' },
    { code: 'tr', label: 'Türkçe', english: 'Turkish', tag: 'tr-TR' },
    { code: 'he', label: 'עברית', english: 'Hebrew', tag: 'he-IL' },
    { code: 'fa', label: 'فارسی', english: 'Persian', tag: 'fa-IR' },
    { code: 'ar', label: 'العربية', english: 'Arabic', tag: 'ar-SA' },
    { code: 'sw', label: 'Kiswahili', english: 'Swahili', tag: 'sw-KE' },
    { code: 'id', label: 'Bahasa Indonesia', english: 'Indonesian', tag: 'id-ID' },
    { code: 'ms', label: 'Bahasa Melayu', english: 'Malay', tag: 'ms-MY' },
    { code: 'fil', label: 'Filipino', english: 'Filipino', tag: 'fil-PH' },
    { code: 'vi', label: 'Tiếng Việt', english: 'Vietnamese', tag: 'vi-VN' },
    { code: 'th', label: 'ไทย', english: 'Thai', tag: 'th-TH' },
    { code: 'ja', label: '日本語', english: 'Japanese', tag: 'ja-JP' },
    { code: 'ko', label: '한국어', english: 'Korean', tag: 'ko-KR' },
    { code: 'zh', label: '中文', english: 'Chinese', tag: 'zh-CN' },
    { code: 'az', label: 'Azərbaycan', english: 'Azerbaijani', tag: 'az-AZ' },
    { code: 'kk', label: 'Қазақша', english: 'Kazakh', tag: 'kk-KZ' },
    { code: 'uz', label: 'Oʻzbekcha', english: 'Uzbek', tag: 'uz-UZ' },
    { code: 'mn', label: 'Монгол', english: 'Mongolian', tag: 'mn-MN' },
    { code: 'hy', label: 'Հայերեն', english: 'Armenian', tag: 'hy-AM' },
    { code: 'ka', label: 'ქართული', english: 'Georgian', tag: 'ka-GE' },
    { code: 'my', label: 'မြန်မာ', english: 'Burmese', tag: 'my-MM' },
    { code: 'km', label: 'ខ្មែរ', english: 'Khmer', tag: 'km-KH' },
    { code: 'lo', label: 'ລາວ', english: 'Lao', tag: 'lo-LA' },
    { code: 'am', label: 'አማርኛ', english: 'Amharic', tag: 'am-ET' },
    { code: 'so', label: 'Soomaali', english: 'Somali', tag: 'so-SO' },
    { code: 'mg', label: 'Malagasy', english: 'Malagasy', tag: 'mg-MG' },
    { code: 'ha', label: 'Hausa', english: 'Hausa', tag: 'ha-NG' },
    { code: 'yo', label: 'Yorùbá', english: 'Yoruba', tag: 'yo-NG' },
    { code: 'ig', label: 'Igbo', english: 'Igbo', tag: 'ig-NG' },
    { code: 'zu', label: 'isiZulu', english: 'Zulu', tag: 'zu-ZA' },
    { code: 'xh', label: 'isiXhosa', english: 'Xhosa', tag: 'xh-ZA' },
    { code: 'af', label: 'Afrikaans', english: 'Afrikaans', tag: 'af-ZA' },
    { code: 'hr', label: 'Hrvatski', english: 'Croatian', tag: 'hr-HR' },
    { code: 'sr', label: 'Српски', english: 'Serbian', tag: 'sr-RS' },
    { code: 'bs', label: 'Bosanski', english: 'Bosnian', tag: 'bs-BA' },
    { code: 'bg', label: 'Български', english: 'Bulgarian', tag: 'bg-BG' },
    { code: 'sk', label: 'Slovenčina', english: 'Slovak', tag: 'sk-SK' },
    { code: 'sl', label: 'Slovenščina', english: 'Slovenian', tag: 'sl-SI' },
    { code: 'sq', label: 'Shqip', english: 'Albanian', tag: 'sq-AL' },
    { code: 'mk', label: 'Македонски', english: 'Macedonian', tag: 'mk-MK' },
    { code: 'lt', label: 'Lietuvių', english: 'Lithuanian', tag: 'lt-LT' },
    { code: 'lv', label: 'Latviešu', english: 'Latvian', tag: 'lv-LV' },
    { code: 'et', label: 'Eesti', english: 'Estonian', tag: 'et-EE' },
    { code: 'is', label: 'Íslenska', english: 'Icelandic', tag: 'is-IS' },
    { code: 'ga', label: 'Gaeilge', english: 'Irish', tag: 'ga-IE' },
    { code: 'cy', label: 'Cymraeg', english: 'Welsh', tag: 'cy-GB' },
    { code: 'ca', label: 'Català', english: 'Catalan', tag: 'ca-ES' },
    { code: 'gl', label: 'Galego', english: 'Galician', tag: 'gl-ES' },
    { code: 'eu', label: 'Euskara', english: 'Basque', tag: 'eu-ES' },
    { code: 'ht', label: 'Kreyòl Ayisyen', english: 'Haitian Creole', tag: 'ht-HT' },
    { code: 'jv', label: 'Basa Jawa', english: 'Javanese', tag: 'jv-ID' },
    { code: 'su', label: 'Basa Sunda', english: 'Sundanese', tag: 'su-ID' },
    { code: 'ceb', label: 'Cebuano', english: 'Cebuano', tag: 'ceb-PH' }
  ],

  /* How a language is shown in a picker: its own name, and the English name
     beside it whenever they differ ('ಕನ್ನಡ Kannada', 'Ελληνικά Greek').
     Knowing Greek is not a prerequisite for finding it in a list. */
  langLabel(l) {
    if (!l) return '';
    if (!l.english || l.label === l.english || l.label.includes(l.english)) return l.label;
    return l.label + ' ' + l.english;
  },

  /* code ('hi') or region tag ('hi-IN') → the tag a speech engine wants. */
  speechTag(code) {
    if (!code) return '';
    const exact = this.languages.find(l => l.tag.toLowerCase() === String(code).toLowerCase());
    if (exact) return exact.tag;
    const short = this.languages.find(l => l.code === String(code).toLowerCase());
    return short ? short.tag : String(code);      // an unlisted tag is passed through
  },

  /* Every tag worth offering in the speech-language picker: the table, plus
     the English variants people actually pick for recognition quality. */
  speechTags() {
    return [
      { value: '', label: 'Use the app language' },
      { value: 'en-GB', label: 'English (UK)' },
      { value: 'en-IN', label: 'English (India)' }
    ].concat(this.languages.map(l => ({ value: l.tag, label: this.langLabel(l) })));
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
    /* Everything this device can actually be asked for right now. The rest
       (contacts, files, calendar) are real only inside the Android shell, so
       they are listed separately and never reported as granted in a browser. */
    DEVICE: ['notifications', 'geolocation', 'camera', 'microphone', 'clipboardWrite', 'automation', 'open_apps'],
    SHELL_ONLY: ['contacts_read', 'files_read', 'calendar_read'],

    /* Are we running inside the native shell? */
    shell() {
      if (typeof window === 'undefined' || !window.Capacitor) return false;
      return typeof window.Capacitor.isNativePlatform === 'function'
        ? !!window.Capacitor.isNativePlatform()
        : true;
    },

    /* Keys currently allowed. shellOnly=false hides what only the app can do. */
    granted(shellOnly) {
      return Object.keys(this.map).filter(k => {
        if (this.get(k) === false) return false;
        if (!shellOnly && this.SHELL_ONLY.includes(k)) return false;
        return true;
      });
    },

    /* What this device offers but the user has not allowed yet. */
    missing() { return this.DEVICE.filter(k => !this.get(k)); },

    /* Ask for everything this device can give, one permission at a time, and
       report what really happened — including refusals. This is a shortcut
       for the same requests the individual rows make, never a bypass: every
       sensitive tool still checks its own permission and every irreversible
       action still asks separately. */
    async requestAll(onEach) {
      const report = { granted: [], denied: [], unavailable: [] };
      for (const k of this.DEVICE) {
        let result;
        if (this.get(k)) result = 'granted';
        else if (!this.map[k]) result = 'unavailable';
        else {
          try { result = await this.request(k); } catch { result = 'denied'; }
        }
        if (result === 'granted') report.granted.push(k);
        else if (result === 'unavailable' || result === 'unknown') report.unavailable.push(k);
        else report.denied.push(k);
        if (onEach) onEach(k, result);
      }
      report.shellOnly = this.SHELL_ONLY.slice();
      report.inShell = this.shell();
      return report;
    },

    /* One tap takes it all back. */
    revokeAll() {
      const revoked = this.granted(true);
      revoked.forEach(k => this.revoke(k));
      if (revoked.length) Aevion.emit('perms:revokedAll', { keys: revoked });
      return revoked;
    },

    map: {
      notifications: { label: 'Notifications', req: () => (typeof Notification === 'undefined' ? 'unavailable' : Notification.requestPermission()) },
      geolocation: { label: 'Location (weather etc.)', req: () => new Promise((res) => {
        if (!navigator.geolocation) return res('denied');
        navigator.geolocation.getCurrentPosition(() => res('granted'), () => res('denied'), { timeout: 8000 });
      })},
      camera: { label: 'Camera', req: () => capturePermission({ video: true }) },
      microphone: { label: 'Microphone (voice input)', req: () => capturePermission({ audio: true }) },
      clipboardWrite: { label: 'Clipboard write', req: async () => { try { await navigator.clipboard.writeText(' '); return 'granted'; } catch { return 'denied'; } } },
      automation: { label: 'Automation (device actions)', req: () => 'browser' },
      open_apps: { label: 'Open apps & websites', req: () => 'browser' },
      contacts_read: { label: 'Contacts (read)', req: () => 'browser' },
      files_read: { label: 'File access', req: () => 'browser' },
      calendar_read: { label: 'Calendar (read)', req: () => 'browser' }
    },
    get(k) { return (Aevion.settings.perms || {})[k] || false; },
    async request(k) {
      const def = this.map[k];
      if (!def) return 'unknown';
      const r = await def.req();
      if (r === 'unavailable') {
        // This device has no such capability. Say so, and stay un-granted.
        Aevion.settings.perms[k] = false;
        Aevion.store.set('settings', Aevion.settings);
        Aevion.emit('perm:changed', { key: k, granted: false, unavailable: true });
        return 'unavailable';
      }
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
