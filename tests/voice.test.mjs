/* Tests for voice.js — listening, speaking and the language it does it in.
   The Web Speech API, the Android plugin and the TTS engine are faked, so
   every branch runs headlessly. The point of this file is the part that is
   easy to fake in a README and hard to fake here: which language each
   engine is actually handed, and when the app is allowed to make noise. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, plain } from './harness.mjs';

/* ---------- fakes ---------- */

function makeSynth() {
  const voices = [
    { name: 'English', lang: 'en-US', voiceURI: 'en-us-1' },
    { name: 'English UK', lang: 'en-GB', voiceURI: 'en-gb-1' },
    { name: 'Hindi', lang: 'hi-IN', voiceURI: 'hi-in-1' },
    { name: 'Tamil', lang: 'ta-IN', voiceURI: 'ta-in-1' }
  ];
  const state = { spoken: [], cancelled: 0, onvoiceschanged: null };
  return {
    state,
    getVoices: () => voices,
    speak(u) { state.spoken.push(u); },
    cancel() { state.cancelled++; }
  };
}

function makeUtterance() {
  const made = [];
  class FakeUtterance {
    constructor(text) { this.text = text; this.rate = 1; this.pitch = 1; this.voice = null; this.lang = ''; made.push(this); }
  }
  FakeUtterance.made = made;
  return FakeUtterance;
}

function makeEngine() {
  const instances = [];
  class FakeSR {
    constructor() { this.lang = ''; this.interimResults = false; this.continuous = false; this.started = 0; instances.push(this); }
    start() { this.started++; }
    stop() { this.stopped = true; }
    onresult = null; onend = null; onerror = null;
  }
  FakeSR.instances = instances;
  FakeSR.latest = () => instances[instances.length - 1];
  return FakeSR;
}

function makeNative() {
  const calls = { started: [], spoken: [], stopSpeaking: 0, stopped: 0, listeners: {} };
  return {
    calls,
    addListener(name, fn) { calls.listeners[name] = fn; },
    async available() { return { available: true }; },
    async start(o) { calls.started.push(o); },
    async stop() { calls.stopped++; },
    async speak(o) { calls.spoken.push(o); },
    async stopSpeaking() { calls.stopSpeaking++; }
  };
}

function voiceApp(settings = {}, extra = {}) {
  const synth = makeSynth();
  const Utterance = makeUtterance();
  const SpeechRecognition = extra.SpeechRecognition === null ? undefined : (extra.SpeechRecognition || makeEngine());
  const app = createApp({
    settings: { perms: { microphone: true }, ...settings },
    globals: Object.assign({
      speechSynthesis: synth,
      SpeechSynthesisUtterance: Utterance,
      SpeechRecognition
    }, extra.globals || {})
  });
  const events = [];
  ['voice:partial', 'voice:final', 'voice:end', 'voice:error', 'voice:done', 'voice:speak']
    .forEach(n => app.Aevion.on(n, d => events.push({ n, d })));
  return { Aevion: app.Aevion, synth, Utterance, SpeechRecognition, events, app };
}

/* ---------- language ---------- */

test('every language the app offers is handed to the engines as a real region tag', () => {
  const expected = {
    en: 'en-US', hi: 'hi-IN', ta: 'ta-IN', te: 'te-IN',
    es: 'es-ES', fr: 'fr-FR', de: 'de-DE', ja: 'ja-JP'
  };
  for (const [code, tag] of Object.entries(expected)) {
    const { Aevion } = voiceApp({ lang: code });
    assert.equal(Aevion.voice.langTag(), tag, `${code} should listen and speak ${tag}`);
  }
});

test('every language in the app is a real region tag, for every one of them', () => {
  const { Aevion } = voiceApp();
  assert.ok(Aevion.languages.length >= 40, 'the app offers the languages it can actually serve');
  for (const code of ['hi', 'ta', 'te', 'kn', 'ml', 'bn', 'mr', 'gu', 'pa', 'or', 'as', 'ur', 'ne', 'si']) {
    assert.ok(Aevion.languages.some(l => l.code === code), `${code} should be offered (India has 22 scheduled languages)`);
  }
  const codes = Aevion.languages.map(l => l.code);
  assert.equal(new Set(codes).size, codes.length, 'no duplicate language codes');
  const tags = Aevion.languages.map(l => l.tag);
  assert.equal(new Set(tags).size, tags.length, 'no duplicate region tags');
  for (const l of Aevion.languages) {
    // BCP-47 allows a 2-3 letter language subtag (fil-PH, nb-NO) — what matters
    // is that a region is there, so an engine cannot guess the wrong variant.
    assert.match(l.tag, /^[a-z]{2,3}-[A-Z]{2}$/, `${l.code} needs a region tag, not a bare code`);
    assert.ok(l.label && l.label.length > 0, `${l.code} needs a label`);
    Aevion.settings.lang = l.code;
    Aevion.settings.speechLang = '';
    assert.equal(Aevion.voice.langTag(), l.tag, `${l.code} should listen in ${l.tag}`);
  }
});

test('the tag expansion is shared, and an unknown tag is passed through untouched', () => {
  const { Aevion } = voiceApp();
  assert.equal(Aevion.speechTag('hi'), 'hi-IN', 'a short code is expanded');
  assert.equal(Aevion.speechTag('hi-IN'), 'hi-IN', 'a full tag is left alone');
  assert.equal(Aevion.speechTag('en-GB'), 'en-GB', 'a region variant survives, so British English stays British');
  assert.equal(Aevion.speechTag('xx-YY'), 'xx-YY', 'an unlisted language is still honest about what was asked');
  assert.equal(Aevion.speechTag(''), '');
});

test('every language option carries its English name, so the list is usable in English', () => {
  const { Aevion } = voiceApp();
  for (const l of Aevion.languages) {
    const shown = Aevion.langLabel(l);
    assert.ok(shown.length > 0, `${l.code} needs a label`);
    assert.ok(shown.includes(l.english), `${l.code} should show "${l.english}" beside its own name`);
  }
  assert.equal(Aevion.langLabel({ label: 'ಕನ್ನಡ', english: 'Kannada' }), 'ಕನ್ನಡ Kannada');
  assert.equal(Aevion.langLabel({ label: 'Ελληνικά', english: 'Greek' }), 'Ελληνικά Greek');
  assert.equal(Aevion.langLabel({ label: 'English', english: 'English' }), 'English', 'no pointless repetition');
  assert.equal(Aevion.langLabel({ label: 'Filipino', english: 'Filipino' }), 'Filipino');
  assert.equal(Aevion.langLabel(null), '');
});

test('the speech picker offers the app language plus the English variants people actually choose', () => {
  const { Aevion } = voiceApp();
  const tags = Aevion.speechTags();
  assert.deepEqual(plain(tags[0]), { value: '', label: 'Use the app language' });
  for (const t of tags) assert.ok(t.value !== undefined && !!t.label, 'every option has a value and a label');
  assert.equal(tags.length, Aevion.languages.length + 3, 'one option per language, plus the three English ones');
  const values = tags.map(t => t.value);
  assert.ok(values.includes('en-IN'), 'recognizers treat Indian English differently, so it is offered');
  for (const l of Aevion.languages) {
    const opt = tags.find(t => t.value === l.tag);
    assert.ok(opt, `${l.tag} should be selectable`);
    assert.ok(opt.label.includes(l.english), `${l.tag} should show "${l.english}"`);
  }
});

test('the translate skill knows every language the app offers', () => {
  const { Aevion } = voiceApp();
  for (const l of Aevion.languages) {
    const parsed = Aevion.skills.parseTranslate(`translate hello into ${l.english}`);
    assert.ok(parsed, `"translate hello into ${l.english}" should be understood`);
    assert.equal(parsed.target, l.code, `${l.english} should resolve to ${l.code}`);
  }
});

test('the speech-input language overrides the app language, and wins over a bare code', () => {
  const { Aevion } = voiceApp({ lang: 'en', speechLang: 'en-GB' });
  assert.equal(Aevion.voice.langTag(), 'en-GB');
  const other = voiceApp({ lang: 'en', speechLang: '' });
  assert.equal(other.Aevion.voice.langTag(), 'en-US', 'empty means "use the app language"');
});

test('the recognizer is started in that language, with the interim setting it was given', async () => {
  const { Aevion, SpeechRecognition } = voiceApp({ lang: 'hi', speechInterim: false });
  await Aevion.voice.start();
  const rec = SpeechRecognition.latest();
  assert.equal(rec.lang, 'hi-IN');
  assert.equal(rec.interimResults, false);
  assert.equal(rec.started, 1);
});

test('interim feedback is on unless the user turns it off', async () => {
  const { Aevion, SpeechRecognition } = voiceApp({ lang: 'en' });
  await Aevion.voice.start();
  assert.equal(SpeechRecognition.latest().interimResults, true, 'default is on');
});

/* ---------- listening ---------- */

test('listening needs the microphone permission first', async () => {
  const { Aevion, SpeechRecognition } = voiceApp({ perms: { microphone: false } });
  await assert.rejects(() => Aevion.voice.start(), /Microphone permission denied/);
  assert.equal(SpeechRecognition.instances.length, 0, 'no recognizer is created without consent');
});

test('a transcript is reported as partial while speaking and final when it ends', async () => {
  const { Aevion, SpeechRecognition, events } = voiceApp();
  await Aevion.voice.start();
  const rec = SpeechRecognition.latest();
  const alt = Object.assign([{ transcript: 'open youtube' }], { isFinal: false });
  rec.onresult({ results: Object.assign([alt], { length: 1 }) });
  assert.deepEqual(events.filter(e => e.n === 'voice:partial').map(e => e.d), ['open youtube']);

  rec.onend();
  assert.deepEqual(events.filter(e => e.n === 'voice:final').map(e => e.d), ['open youtube']);
  assert.equal(Aevion.voice.listening, false);
});

test('stopping a session does not leave the button lit', async () => {
  const { Aevion, SpeechRecognition } = voiceApp();
  await Aevion.voice.start();
  assert.equal(Aevion.voice.listening, true);
  Aevion.voice.stop();
  assert.equal(SpeechRecognition.latest().stopped, true);
});

test('without a speech engine it says so instead of hanging', async () => {
  const { Aevion } = voiceApp({}, { SpeechRecognition: null });
  assert.equal(Aevion.voice.supported, false);
  await assert.rejects(() => Aevion.voice.start(), /Chrome\/Edge|Android/i);
});

/* ---------- speaking ---------- */

test('muted by default: printing a reply must not make noise', () => {
  const { Aevion, synth } = voiceApp({ speak: false });
  Aevion.voice.speak('hello there');
  assert.equal(synth.state.spoken.length, 0);
});

test('speaking uses the chosen voice, rate and pitch', () => {
  const { Aevion, synth, Utterance } = voiceApp({ speak: true, voiceURI: 'en-gb-1', ttsRate: 1.4, ttsPitch: 0.8, lang: 'en' });
  Aevion.voice.speak('the weather is nice');
  const u = synth.state.spoken[0];
  assert.equal(u.text, 'the weather is nice');
  assert.equal(u.rate, 1.4);
  assert.equal(u.pitch, 0.8);
  assert.equal(u.voice.voiceURI, 'en-gb-1', 'the voice picked in settings is the one used');
  assert.equal(synth.state.cancelled > 0, true, 'a new reply cuts off the previous one');
  assert.ok(Utterance.made.includes(u));
});

test('out-of-range rate and pitch are clamped instead of thrown at the engine', () => {
  const { Aevion, synth } = voiceApp({ speak: true, ttsRate: 99, ttsPitch: -5 });
  Aevion.voice.speak('hi');
  assert.equal(synth.state.spoken[0].rate, 2);
  assert.equal(synth.state.spoken[0].pitch, 0.5);
});

test('an empty reply is not spoken at all', () => {
  const { Aevion, synth } = voiceApp({ speak: true });
  Aevion.voice.speak('   ');
  assert.equal(synth.state.spoken.length, 0);
});

test('it reports when speech finishes — that is what closes the wake-mode window', () => {
  const { Aevion, synth, events } = voiceApp({ speak: true });
  Aevion.voice.speak('hello');
  synth.state.spoken[0].onend();
  synth.state.spoken[0].onerror();
  assert.equal(events.filter(e => e.n === 'voice:done').length, 2, 'both endings count as finished');
});

test('a forced cue is audible even when replies are muted', () => {
  const { Aevion, synth } = voiceApp({ speak: false });
  Aevion.voice.speak('Yes?', true);
  assert.equal(synth.state.spoken.length, 1);
  assert.equal(synth.state.spoken[0].text, 'Yes?');
});

test('shutting up stops the current reply', () => {
  const { Aevion, synth } = voiceApp({ speak: true });
  Aevion.voice.speak('a long reply');
  Aevion.voice.shutup();
  assert.ok(synth.state.cancelled >= 2, 'cancel is what actually stops a browser utterance');
});

test('the voice list is filtered to your language, and never left empty', () => {
  const { Aevion } = voiceApp({ lang: 'hi' });
  const mine = Aevion.voice.voices();
  assert.deepEqual(mine.map(v => v.voiceURI), ['hi-in-1']);

  const none = voiceApp({ lang: 'te' });        // no Telugu voice installed
  assert.ok(none.Aevion.voice.voices().length > 0, 'a voice in another language beats silence');
});

/* ---------- the Android path ---------- */

test('with the native plugin the app listens through it, in the right language', async () => {
  const Speech = makeNative();
  const { Aevion } = voiceApp({ lang: 'ta' }, { globals: { Capacitor: { Plugins: { Speech } } } });
  assert.equal(Aevion.voice.native, true);
  assert.equal(Aevion.voice.supported, true);
  await Aevion.voice.start();
  // plain(): the call was made inside the VM realm, so its objects are not
  // the same prototypes as this realm's object literals.
  assert.deepEqual(plain(Speech.calls.started), [{ language: 'ta-IN', partialResults: true }]);
});

test('native results and errors arrive as the same events as the web engine', async () => {
  const Speech = makeNative();
  const { Aevion, events } = voiceApp({}, { globals: { Capacitor: { Plugins: { Speech } } } });
  await Aevion.voice.start();
  Speech.calls.listeners.speechResult({ text: 'hey aevion', isFinal: false });
  assert.deepEqual(events.filter(e => e.n === 'voice:partial').map(e => e.d), ['hey aevion']);
  Speech.calls.listeners.speechError({ error: 'network' });
  assert.deepEqual(events.filter(e => e.n === 'voice:error').map(e => e.d), ['network']);
  Speech.calls.listeners.speechEnd({ text: 'hey aevion' });
  assert.deepEqual(events.filter(e => e.n === 'voice:final').map(e => e.d), ['hey aevion']);
});

test('native speech is stopped through the plugin, not the browser engine', () => {
  const Speech = makeNative();
  const { Aevion } = voiceApp({ speak: true }, { globals: { Capacitor: { Plugins: { Speech } } } });
  Aevion.voice.speak('hello');
  assert.deepEqual(plain(Speech.calls.spoken), [{ text: 'hello', language: 'en-US', rate: 1, pitch: 1 }]);
  Aevion.voice.shutup();
  // Two calls on purpose: speak() cuts off whatever was playing so replies
  // never overlap, and shutup() is the explicit stop.
  assert.equal(Speech.calls.stopSpeaking, 2);
});

test('a voice preset reaches the Android engine as speed and pitch', () => {
  const Speech = makeNative();
  const { Aevion } = voiceApp({ speak: true }, { globals: { Capacitor: { Plugins: { Speech } } } });
  Aevion.voices.apply('titan');
  Aevion.voice.speak('hello');
  const sent = Speech.calls.spoken[Speech.calls.spoken.length - 1];
  assert.equal(sent.rate, 1, 'Titan speaks at normal speed');
  assert.equal(sent.pitch, 0.65, 'and very low');
  /* Android has one voice per language, so "matched an engine voice" is
     honestly false here — and the preview says so instead of guessing. */
  assert.deepEqual(plain(Aevion.voices.preview('echo')), { id: 'echo', rate: 0.85, pitch: 0.8, matched: false });
});

test('a device with no speech service is reported instead of pretending to listen', async () => {
  const Speech = makeNative();
  Speech.available = async () => ({ available: false });
  const { Aevion } = voiceApp({}, { globals: { Capacitor: { Plugins: { Speech } } } });
  await assert.rejects(() => Aevion.voice.start(), /No speech service found/);
});

/* ---------- honesty about failure ---------- */

test('every recognizer error has words a person can act on', () => {
  const { Aevion } = voiceApp();
  for (const code of ['no-match', 'timeout', 'network', 'busy', 'permission', 'audio', 'server', 'client', 'tts']) {
    const text = Aevion.voice.errorText(code);
    assert.equal(typeof text, 'string');
    assert.ok(text.length > 5, `${code} needs a real explanation`);
    assert.ok(!/undefined/.test(text));
  }
  assert.match(Aevion.voice.errorText('no-match'), /catch that/i);
  assert.match(Aevion.voice.errorText('permission'), /permission/i);
  assert.match(Aevion.voice.errorText('something-new'), /something-new/, 'an unknown code is still reported verbatim');
});
