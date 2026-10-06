/* ============================================================
 * Aevion Voices — fifteen ways to be spoken to.
 *
 * Where the sound actually comes from: your device's own speech
 * engine (Web Speech in a browser, Android's TextToSpeech in the
 * app). This app cannot ship neural voices, so it does the honest
 * thing instead of pretending:
 *
 *   - a *voice* here is a named combination of the three things a
 *     speech engine really accepts — rate, pitch, and (when the
 *     device offers more than one) which engine voice to use;
 *   - every preset is audible on every device, because rate and
 *     pitch always work;
 *   - the engine-voice preference is best-effort and says so: it
 *     looks for a voice whose own name suggests it fits ("Female",
 *     "Zira", "Daniel"…) *in the language you are listening in*, and
 *     falls back to the language default when there is none.
 *
 * Nothing here talks to the network, and picking a voice never
 * changes what the assistant says — only how.
 * ============================================================ */
(function () {
  const V = {};

  /* The one option that leaves everything exactly as the user set it. */
  V.SYSTEM = {
    id: 'system',
    name: 'System default',
    desc: 'your device’s own voice, exactly as the sliders below say',
    rate: null, pitch: null, prefer: null
  };

  /* rate/pitch are inside the same 0.5–2 range as the sliders, so a
     preset is always reachable by hand afterwards — a voice you pick
     never becomes a value you cannot edit. */
  V.PRESETS = [
    { id: 'aevion', name: 'Aevion', desc: 'the neutral baseline', rate: 1, pitch: 1, prefer: null },
    { id: 'aria', name: 'Aria', desc: 'calm and bright', rate: 0.95, pitch: 1.15, prefer: 'female' },
    { id: 'nova', name: 'Nova', desc: 'quick and bright', rate: 1.15, pitch: 1.25, prefer: 'female' },
    { id: 'luna', name: 'Luna', desc: 'soft and high', rate: 0.9, pitch: 1.35, prefer: 'female' },
    { id: 'mira', name: 'Mira', desc: 'friendly middle', rate: 1.05, pitch: 1.1, prefer: 'female' },
    { id: 'coral', name: 'Coral', desc: 'warm and steady', rate: 1.1, pitch: 1.05, prefer: 'female' },
    { id: 'pixie', name: 'Pixie', desc: 'playful and fast', rate: 1.3, pitch: 1.45, prefer: 'female' },
    { id: 'blaze', name: 'Blaze', desc: 'very fast, no flourishes', rate: 1.5, pitch: 1, prefer: 'male' },
    { id: 'echo', name: 'Echo', desc: 'deep and unhurried', rate: 0.85, pitch: 0.8, prefer: 'male' },
    { id: 'orion', name: 'Orion', desc: 'low and even', rate: 0.95, pitch: 0.85, prefer: 'male' },
    { id: 'atlas', name: 'Atlas', desc: 'slow, with weight', rate: 0.8, pitch: 0.75, prefer: 'male' },
    { id: 'sage', name: 'Sage', desc: 'measured, almost a narration', rate: 0.9, pitch: 0.95, prefer: 'male' },
    { id: 'titan', name: 'Titan', desc: 'very deep', rate: 1, pitch: 0.65, prefer: 'male' },
    { id: 'vega', name: 'Vega', desc: 'brisk and low', rate: 1.2, pitch: 0.9, prefer: 'male' }
  ];

  V.list = () => [V.SYSTEM].concat(V.PRESETS);
  V.get = function (id) {
    return V.list().find(p => p.id === id) || V.SYSTEM;
  };

  /* What is selected right now. "system" is the default, so an app that
     has never touched this keeps the behaviour it always had. */
  V.current = function () {
    const id = Aevion.settings ? Aevion.settings.voiceStyle : null;
    return V.get(id);
  };
  V.currentId = () => V.current().id;

  /* Engine voices whose own names suggest a fit. Deliberately a name
     list and not a guess about gender: if none of these words is in a
     voice's name, this returns null and the caller keeps what it had. */
  const NAMES = {
    female: ['female', 'woman', 'aria', 'jenny', 'zira', 'samantha', 'susan', 'karen', 'tessa',
      'victoria', 'catherine', 'salli', 'joanna', 'fiona', 'serena', 'amelie', 'anna', 'kalpana',
      'swara', 'heera', 'sara', 'nora', 'emma', 'olivia', 'zoe', 'ava'],
    male: ['male', 'man', 'david', 'mark', 'daniel', 'george', 'matthew', 'guy', 'rishi', 'thomas',
      'alex', 'fred', 'oliver', 'ryan', 'hemant', 'prabhat', 'james', 'brian', 'liam']
  };

  V.match = function (preset, voices) {
    if (!preset || !preset.prefer || !Array.isArray(voices)) return null;
    const words = NAMES[preset.prefer] || [];
    const lower = v => String((v && v.name) || '').toLowerCase();
    /* Whole words only. This is not pedantry: "Female" contains "male",
       so a substring search would hand a deep voice to "Google UK English
       Female" and call it a match. */
    const says = (name, w) => new RegExp('(^|[^a-z])' + w + '(?![a-z])').test(name);
    return voices.find(v => words.some(w => says(lower(v), w))) || null;
  };

  /* The rate/pitch this preset would speak at, falling back to whatever
     the user has set — so "system" really is the untouched path. */
  V.settingsFor = function (id) {
    const p = V.get(id);
    const s = Aevion.settings || {};
    return {
      rate: p.rate == null ? (s.ttsRate == null ? 1 : s.ttsRate) : p.rate,
      pitch: p.pitch == null ? (s.ttsPitch == null ? 1 : s.ttsPitch) : p.pitch
    };
  };

  /* Choosing a voice writes the preset's numbers into the normal
     settings, so the sliders show the truth and can be nudged from
     there. The engine voice is only re-pointed when the preset asks
     for a particular kind and the device actually has one. */
  V.apply = function (id) {
    if (!Aevion.settings) return null;
    const p = V.get(id);
    Aevion.settings.voiceStyle = p.id;
    if (p.id !== 'system') {
      Aevion.settings.ttsRate = p.rate;
      Aevion.settings.ttsPitch = p.pitch;
      const found = V.match(p, Aevion.voice && Aevion.voice.voices ? Aevion.voice.voices() : []);
      if (found) Aevion.settings.voiceURI = found.voiceURI || found.name;
    }
    Aevion.store.set('settings', Aevion.settings);
    Aevion.emit('voice:style', { id: p.id, preset: p });
    return p;
  };

  /* True when the sliders no longer match the preset that was picked:
     the UI says so instead of silently pretending it is still "Luna". */
  V.isCustom = function () {
    const p = V.current();
    if (p.id === 'system') return false;
    const s = Aevion.settings || {};
    return Number(s.ttsRate) !== p.rate || Number(s.ttsPitch) !== p.pitch;
  };

  /* A line to hear. Spoken in the app's language, and short enough that
     comparing two voices is quick. */
  V.sample = function () {
    const lang = (Aevion.settings && Aevion.settings.lang) || 'en';
    /* A greeting in the language the app is set to, plus a sum — short
       enough to compare two voices quickly, long enough to hear the
       speed, and spoken in the same language real replies use. */
    const base = Aevion.nlu
      ? Aevion.nlu.say(lang, 'greet', 'Hello — this is how I sound.')
      : 'Hello — this is how I sound.';
    return base + ' 2 + 2 = 4.';
  };

  /* Speak a sample in a voice *without* selecting it: trying one out
     must never change your settings. */
  V.preview = function (id) {
    if (!Aevion.voice || !Aevion.voice.ttsSupported) return null;
    const p = V.get(id);
    const nums = V.settingsFor(id);
    const match = V.match(p, Aevion.voice.voices ? Aevion.voice.voices() : []);
    Aevion.voice.speak(V.sample(), true, {
      rate: nums.rate,
      pitch: nums.pitch,
      voice: match || undefined
    });
    return { id: p.id, rate: nums.rate, pitch: nums.pitch, matched: !!match };
  };

  /* What the device can actually do, said plainly for the UI. */
  V.capability = function () {
    const engineVoices = (Aevion.voice && Aevion.voice.voices) ? Aevion.voice.voices().length : 0;
    const native = !!(Aevion.voice && Aevion.voice.native);
    return {
      engine: native ? 'android' : (Aevion.voice && Aevion.voice.ttsSupported ? 'browser' : 'none'),
      engineVoices,
      /* Rate and pitch always work; picking between engine voices does not
         exist on Android, where the system holds one voice per language. */
      canPickVoice: !native && engineVoices > 0,
      count: V.list().length
    };
  };

  /* A one-line truth for the picker: how many voices, and what the
     count actually means on this device. */
  V.summary = function () {
    const c = V.capability();
    if (c.engine === 'none') return V.list().length + ' voice presets — but this device has no speech engine, so nothing is spoken here.';
    if (c.engine === 'android') {
      return V.list().length + ' presets: speed and pitch change on Android; the system supplies one voice per language, so the engine-voice list is browser-only.';
    }
    return V.list().length + ' presets, with ' + c.engineVoices + ' engine voice' + (c.engineVoices === 1 ? '' : 's') +
      ' available in this language for the ones that prefer a particular kind.';
  };

  Aevion.voices = V;
})();
