/* Tests for js/voices.js — the fifteen voices.

   A "voice" in this app is speed, pitch, and (when the device has a
   choice) which engine voice to use. The properties worth pinning down
   are that every preset is actually different, that every preset is
   inside the same range as the sliders so nothing becomes unreachable,
   and that trying a voice out never changes what you had selected. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, plain } from './harness.mjs';

/* A stand-in browser speech engine with a handful of named voices. */
const NAMED = [
  { name: 'Google UK English Female', lang: 'en-GB', voiceURI: 'guk-f' },
  { name: 'Microsoft David - English (United States)', lang: 'en-US', voiceURI: 'david' },
  { name: 'Samantha', lang: 'en-US', voiceURI: 'samantha' },
  { name: 'Tamil (India)', lang: 'ta-IN', voiceURI: 'ta' }
];

function fakeVoices(voices = NAMED) {
  const spoken = [];
  class FakeUtterance {
    constructor(text) { this.text = text; }
  }
  return {
    voices,
    spoken,
    globals: {
      speechSynthesis: {
        getVoices: () => voices,
        speak: u => spoken.push(u),
        cancel: () => {},
        onvoiceschanged: null
      },
      SpeechSynthesisUtterance: FakeUtterance
    }
  };
}

const app = (settings = {}, opts = {}) => createApp({ settings, ...opts });

/* ---------- the list itself ---------- */

test('there are fifteen voices to choose between, and they are all different', () => {
  const A = app().Aevion;
  const list = plain(A.voices.list());
  assert.equal(list.length, 15, 'system default plus fourteen named voices');
  assert.equal(new Set(list.map(p => p.id)).size, 15, 'ids must be unique');
  assert.equal(new Set(list.map(p => p.name)).size, 15, 'names must be unique');
  const shapes = list.slice(1).map(p => p.rate + '/' + p.pitch);
  assert.equal(new Set(shapes).size, 14, 'no two voices sound the same');
  for (const p of list) {
    assert.ok(p.desc && p.desc.length > 3, `${p.id} needs a description`);
    if (p.id === 'system') continue;
    assert.ok(p.rate >= 0.5 && p.rate <= 2, `${p.id} rate must be inside the slider range`);
    assert.ok(p.pitch >= 0.5 && p.pitch <= 2, `${p.id} pitch must be inside the slider range`);
    assert.ok([null, 'female', 'male'].includes(p.prefer), `${p.id} has an unknown preference`);
  }
});

test('the default is the untouched path: system, and the sliders decide', () => {
  const A = app({ ttsRate: 1.4, ttsPitch: 0.7 }).Aevion;
  assert.equal(A.voices.currentId(), 'system');
  assert.deepEqual(plain(A.voices.settingsFor('system')), { rate: 1.4, pitch: 0.7 }, 'system uses your own values');
  assert.equal(A.voices.isCustom(), false, 'system is never reported as adjusted');
});

/* ---------- choosing one ---------- */

test('choosing a voice writes its numbers into the normal settings', () => {
  const A = app().Aevion;
  const p = A.voices.apply('luna');
  assert.equal(p.name, 'Luna');
  assert.equal(A.settings.voiceStyle, 'luna');
  assert.equal(A.settings.ttsRate, 0.9);
  assert.equal(A.settings.ttsPitch, 1.35);
  assert.equal(A.voices.isCustom(), false, 'just picked, so not adjusted');
  assert.equal(plain(A.store.get('settings')).voiceStyle, 'luna', 'and it is stored, not just in memory');
});

test('moving a slider afterwards marks the voice as adjusted, and picking it again resets', () => {
  const A = app().Aevion;
  A.voices.apply('aria');
  A.settings.ttsRate = 1.8;
  assert.equal(A.voices.isCustom(), true);
  A.voices.apply('aria');
  assert.equal(A.voices.isCustom(), false);
  assert.equal(A.settings.ttsRate, 0.95);
});

test('an unknown or missing voice falls back to the system default, never to nothing', () => {
  const A = app().Aevion;
  assert.equal(A.voices.get('does-not-exist').id, 'system');
  assert.equal(A.voices.get(undefined).id, 'system');
  assert.equal(A.voices.get(null).id, 'system');
  A.settings.voiceStyle = 'nonsense';
  assert.equal(A.voices.currentId(), 'system');
});

test('choosing a voice announces it, so the rest of the app can follow', () => {
  const A = app().Aevion;
  const seen = [];
  A.on('voice:style', e => seen.push(e.id));
  A.voices.apply('vega');
  A.voices.apply('system');
  assert.deepEqual(seen, ['vega', 'system']);
});

/* ---------- engine voices ---------- */

test('a preference is best-effort: it finds a matching engine voice when there is one', () => {
  const fv = fakeVoices();
  const A = app({}, { globals: fv.globals }).Aevion;
  const female = A.voices.match(A.voices.get('luna'), fv.voices);
  const male = A.voices.match(A.voices.get('titan'), fv.voices);
  assert.equal(female.voiceURI, 'guk-f', 'the name said Female');
  assert.equal(male.voiceURI, 'david', 'the name said David');
  assert.equal(A.voices.match(A.voices.get('aevion'), fv.voices), null, 'the neutral voice asks for nothing');

  /* Applying it points the engine override at the match… */
  A.voices.apply('luna');
  assert.equal(A.settings.voiceURI, 'guk-f');
});

test('with no name to match, nothing is claimed about the engine voice', () => {
  const anonymous = [
    { name: 'Voice 1', lang: 'en-US', voiceURI: 'v1' },
    { name: 'Voice 2', lang: 'en-GB', voiceURI: 'v2' }
  ];
  const A = app({}, { globals: fakeVoices(anonymous).globals }).Aevion;
  assert.equal(A.voices.match(A.voices.get('aria'), anonymous), null);
  A.settings.voiceURI = '';
  A.voices.apply('echo');
  assert.equal(A.settings.voiceURI, '', 'no match means the engine keeps its own default');
});

/* ---------- previewing ---------- */

test('hearing a voice does not change the voice you have selected', () => {
  const fv = fakeVoices();
  const A = app({ speak: true, voiceStyle: 'system', ttsRate: 1.2, ttsPitch: 1.3 }, { globals: fv.globals }).Aevion;
  const before = plain(A.settings);
  const r = A.voices.preview('titan');
  assert.deepEqual(plain(r), { id: 'titan', rate: 1, pitch: 0.65, matched: true });
  assert.deepEqual(plain(A.settings), before, 'settings are untouched by a preview');
  const last = fv.spoken[0];
  assert.equal(last.rate, 1, 'spoken at the previewed speed');
  assert.equal(last.pitch, 0.65, 'and pitch');
  assert.equal(last.voice.voiceURI, 'david', 'through the matched engine voice');
  assert.match(last.text, /2 \+ 2 = 4/, 'and speaks the sample line');
});

test('a preview speaks even when replies are switched off, and says nothing without an engine', () => {
  const fv = fakeVoices();
  const A = app({ speak: false }, { globals: fv.globals }).Aevion;
  assert.ok(A.voices.preview('nova'), 'preview is an explicit request, so it is heard');
  assert.equal(fv.spoken.length, 1);
  const quiet = app().Aevion;                       // the sandbox has no engine at all
  assert.equal(quiet.voices.preview('nova'), null);
});

test('the sample line follows the app language', () => {
  const A = app({ lang: 'kn' }).Aevion;
  assert.match(A.voices.sample(), /ನಮಸ್ಕಾರ/, 'spoken in Kannada when that is the language');
  assert.match(A.voices.sample(), /2 \+ 2 = 4/);
});

/* ---------- telling the truth about the device ---------- */

test('the summary says what this device can actually do', () => {
  const noEngine = app().Aevion;
  assert.match(noEngine.voices.summary(), /no speech engine/);

  const fv = fakeVoices();
  const browser = app({}, { globals: fv.globals }).Aevion;
  assert.equal(browser.voices.capability().engine, 'browser');
  assert.equal(browser.voices.capability().engineVoices, 3, 'three of the four speak English');
  assert.match(browser.voices.summary(), /15 presets, with 3 engine voices/);

  const native = app({}, {
    globals: {
      Capacitor: { isNativePlatform: () => true, Plugins: { Speech: { available: async () => ({ available: true }), start: async () => {}, stop: () => {}, addListener: () => {}, speak: () => {}, stopSpeaking: () => {} } } }
    }
  }).Aevion;
  assert.equal(native.voices.capability().engine, 'android');
  assert.equal(native.voices.capability().canPickVoice, false, 'Android holds one voice per language');
  assert.match(native.voices.summary(), /system supplies one voice per language/);
});

test('the engine voice list only offers voices the app language can use', () => {
  const fv = fakeVoices();
  const A = app({ lang: 'ta' }, { globals: fv.globals }).Aevion;
  const list = A.voice.voices();
  assert.equal(list.length, 1, 'a Tamil app is not offered English voices');
  assert.equal(list[0].voiceURI, 'ta');
});
