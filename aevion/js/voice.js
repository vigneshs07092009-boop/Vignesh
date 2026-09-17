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

  const lang = () => {
    const l = Aevion.settings.lang || 'en';
    return l === 'en' ? 'en-US' : l;
  };

  /* ---------- permission ---------- */
  V.ensureMic = async function () {
    if (!Aevion.perms.get('microphone')) {
      const r = await Aevion.perms.request('microphone');
      if (r !== 'granted') throw new Error('Microphone permission denied');
    }
  };

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
      r.interimResults = true;
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

  V.start = function () {
    if (V.listening) return Promise.resolve();
    return Native ? startNative() : startWeb();
  };

  V.stop = function () {
    if (Native) {
      V.listening = false;
      try { Native.stop && Native.stop(); } catch {}
      return;
    }
    try { V.rec && V.rec.stop(); } catch {}
  };

  /* ---------- TTS ---------- */
  V.voices = function () {
    // Settings voice picker: only the web engine exposes a voice list.
    if (typeof speechSynthesis === 'undefined') return [];
    try { return speechSynthesis.getVoices().filter(v => v.lang.startsWith(Aevion.settings.lang)); } catch { return []; }
  };

  V.speak = function (text) {
    if (!V.ttsSupported || !Aevion.settings.speak) return;
    const clean = String(text == null ? '' : text).trim();
    if (!clean) return;

    if (Native) {
      try { Native.stopSpeaking && Native.stopSpeaking(); } catch {}
      try { Native.speak({ text: clean.slice(0, 600), language: lang() }); } catch {}
      return;
    }

    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(clean.slice(0, 300));
      u.lang = lang();
      const vs = V.voices();
      const chosen = vs.find(v => v.voiceURI === Aevion.settings.voiceURI) || vs[0];
      if (chosen) u.voice = chosen;
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
