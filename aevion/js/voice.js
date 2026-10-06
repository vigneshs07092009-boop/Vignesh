/* ============================================================
 * Aevion Voice — speech recognition + TTS
 *
 * Two engines, picked automatically:
 *   1. Native (Android APK): the Capacitor "Speech" plugin in
 *      SpeechPlugin.java talks to Android's own speech service.
 *      Needed because the Web Speech API does not exist in
 *      Android WebView.
 *   2. Web (Chrome/Edge/Safari): SpeechRecognition / speechSynthesis.
 *
 * Privacy: nothing listens until you tap the mic, and no audio is
 * stored. Permission is requested through Aevion's permission
 * manager first, so the OS dialog only appears after you allow it
 * in Settings.
 * ============================================================ */
(function () {
  const V = { listening: false };

  const Cap = window.Capacitor;
  const Native = Cap && Cap.Plugins && Cap.Plugins.Speech ? Cap.Plugins.Speech : null;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  V.native = !!Native;
  V.supported = !!Native || !!SR;               // can we listen?
  V.ttsSupported = !!Native || typeof speechSynthesis !== 'undefined';

  /* Speech engines want a region, not a bare language code, and they guess
     badly when handed one: 'hi' can come back as Hindi (US). The expansion
     itself lives in core.js next to the language table, so an app set to
     Tamil listens in ta-IN without a second list to keep in step. */
  const lang = () => Aevion.speechTag(Aevion.settings.speechLang || Aevion.settings.lang || 'en');

  const clamp = (v, lo, hi, dflt) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
  };

  /* ---------- permission ---------- */
  V.ensureMic = async function () {
    if (!Aevion.perms.get('microphone')) {
      const r = await Aevion.perms.request('microphone');
      if (r !== 'granted') throw new Error('Microphone permission denied');
    }
  };

  /* The resolved BCP-47 tag, so the wake recognizer and this module never
     disagree about which language they are listening in. */
  V.langTag = () => lang();

  /* ---------- error text ---------- */
  const ERRORS = {
    'no-match': "I didn't catch that — try again",
    timeout: "I didn't hear anything",
    'network-timeout': 'Speech service did not respond',
    network: 'Speech recognition needs a connection on this device (Android uses an online model)',
    busy: 'The speech service is busy — try again in a second',
    permission: 'Microphone permission denied',
    audio: 'Microphone audio problem',
    server: 'The speech service reported an error',
    client: 'Speech session ended',
    tts: 'Text-to-speech error'
  };
  V.errorText = code => ERRORS[code] || ('Voice error: ' + (code || 'unknown'));

  /* ---------- native (Android) ---------- */
  function bindNative() {
    if (V._bound) return;
    V._bound = true;
    Native.addListener('speechResult', d => {
      if (!d) return;
      if (d.text) {
        if (d.isFinal) V._final = d.text;
        Aevion.emit('voice:partial', d.text);
      }
    });
    Native.addListener('speechEnd', d => {
      V.listening = false;
      const text = (d && d.text) || V._final || '';
      V._final = '';
      Aevion.emit('voice:end');
      Aevion.emit('voice:final', text);
    });
    Native.addListener('speechError', d => {
      if (V.listening) Aevion.emit('voice:error', (d && d.error) || 'unknown');
    });
  }

  async function startNative() {
    await V.ensureMic();                       // Android also grants the WebView mic here
    const cap = await Native.available().catch(() => null);
    if (cap && cap.available === false) {
      throw new Error('No speech service found — enable Google voice input in Android settings');
    }
    bindNative();
    V._final = '';
    V.listening = true;
    try {
      await Native.start({ language: lang(), partialResults: true });
    } catch (e) {
      V.listening = false;
      throw new Error(e && e.message ? e.message : 'Could not start voice input');
    }
  }

  /* ---------- web (browser) ---------- */
  function startWeb() {
    if (!SR) throw new Error('Voice input needs Chrome/Edge/Samsung Internet, or the Aevion Android app');
    return V.ensureMic().then(() => new Promise((resolve, reject) => {
      const r = new SR();
      r.lang = lang();
      r.interimResults = Aevion.settings.speechInterim !== false;
      r.continuous = false;
      let final = '';
      r.onresult = e => {
        final = '';
        for (const res of e.results) final += res[0].transcript;
        Aevion.emit('voice:partial', final);
      };
      r.onerror = e => { V.listening = false; Aevion.emit('voice:end'); reject(new Error(e.error)); };
      r.onend = () => { V.listening = false; Aevion.emit('voice:end', final); Aevion.emit('voice:final', final); };
      V.rec = r;
      V.listening = true;
      r.start();
      resolve(r);
    }));
  }

  /* Always a promise: a caller that does `start().catch(...)` should never
     have to also wrap the call in try/catch just because the engine is
     missing on this device. */
  V.start = function () {
    if (V.listening) return Promise.resolve();
    try {
      return Promise.resolve(Native ? startNative() : startWeb());
    } catch (e) {
      return Promise.reject(e);
    }
  };

  V.stop = function () {
    if (Native) {
      V.listening = false;
      try { Native.stop && Native.stop(); } catch {}
      return;
    }
    if (V.rec) { try { V.rec.stop(); } catch {} V.rec = null; }
  };

  /* ---------- TTS ---------- */
  V.voices = function () {
    // Settings voice picker: only the web engine exposes a voice list.
    if (typeof speechSynthesis === 'undefined') return [];
    const want = lang().slice(0, 2).toLowerCase();
    try {
      const all = speechSynthesis.getVoices();
      const mine = all.filter(v => String(v.lang || '').toLowerCase().startsWith(want));
      return mine.length ? mine : all;   // a voice in your language beats silence
    } catch { return []; }
  };

  // `force` is used for short cues ("Yes?") in wake mode, which must be
  // audible even when the user keeps "speak replies" off.
  // `override` ({rate, pitch, voice}) is how a voice *preview* is spoken
  // without writing anything into the user's settings.
  V.speak = function (text, force, override) {
    if (!V.ttsSupported || !(Aevion.settings.speak || force)) return;
    const clean = String(text == null ? '' : text).trim();
    if (!clean) return;
    const o = override || {};
    const rate = clamp(o.rate == null ? Aevion.settings.ttsRate : o.rate, 0.5, 2, 1);
    const pitch = clamp(o.pitch == null ? Aevion.settings.ttsPitch : o.pitch, 0.5, 2, 1);

    if (Native) {
      try { Native.stopSpeaking && Native.stopSpeaking(); } catch {}
      try { Native.speak({ text: clean.slice(0, 600), language: lang(), rate, pitch }); } catch {}
      return;
    }

    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(clean.slice(0, 300));
      u.lang = lang();
      u.rate = rate;
      u.pitch = pitch;
      const vs = V.voices();
      const chosen = o.voice || vs.find(v => v.voiceURI === Aevion.settings.voiceURI) || vs[0];
      if (chosen) u.voice = chosen;
      /* Saying when speech ends is what closes the wake-mode follow-up
         window; without it the UI would guess from the text length. */
      u.onend = () => Aevion.emit('voice:done');
      u.onerror = () => Aevion.emit('voice:done');
      speechSynthesis.speak(u);
    } catch {}
  };

  V.shutup = function () {
    if (Native) { try { Native.stopSpeaking && Native.stopSpeaking(); } catch {} return; }
    try { speechSynthesis.cancel(); } catch {}
  };

  V.wake = function () {
    // Light "wake" mode: tap the mic, listen once.
    // Privacy/battery: there is deliberately no always-on listener.
    return V.start();
  };

  Aevion.voice = V;
})();
