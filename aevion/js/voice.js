/* ============================================================
 * Aevion Voice — speech recognition + TTS (on-device engines)
 * ============================================================ */
(function () {
  const V = { listening: false };
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  V.supported = !!SR;
  V.ttsSupported = 'speechSynthesis' in window;

  V.ensureMic = async function () {
    if (!Aevion.perms.get('microphone')) {
      const r = await Aevion.perms.request('microphone');
      if (r !== 'granted') throw new Error('Microphone permission denied');
    }
  };

  V.start = async function () {
    if (!SR) throw new Error('Voice input needs Chrome/Edge/Samsung Internet, or a Chromium-based Android WebView');
    await V.ensureMic();
    return new Promise((resolve, reject) => {
      const r = new SR();
      r.lang = Aevion.settings.lang === 'en' ? 'en-US' : Aevion.settings.lang;
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
    });
  };

  V.stop = function () { try { V.rec && V.rec.stop(); } catch {} };

  /* ---------- TTS ---------- */
  V.voices = () => speechSynthesis.getVoices().filter(v => v.lang.startsWith(Aevion.settings.lang));

  V.speak = function (text) {
    if (!V.ttsSupported || !Aevion.settings.speak) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text.slice(0, 300));
    u.lang = Aevion.settings.lang === 'en' ? 'en-US' : Aevion.settings.lang;
    const vs = V.voices();
    const chosen = vs.find(v => v.voiceURI === Aevion.settings.voiceURI) || vs[0];
    if (chosen) u.voice = chosen;
    speechSynthesis.speak(u);
  };

  V.wake = function () {
    // Light "wake" mode: listen briefly when user taps mic (privacy: no always-on listener)
    return V.start();
  };

  Aevion.voice = V;
})();
