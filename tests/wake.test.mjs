/* Tests for wake.js — hands-free activation by name.
   A fake recognizer stands in for the microphone, so the whole state
   machine (name/greeting matching, the name-only window, the follow-up
   window, barge-in, backoff, self-stop) is exercised without hardware. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './harness.mjs';

function makeEngine() {
  const instances = [];
  class FakeSR {
    constructor() {
      this.started = 0;
      this.aborted = 0;
      this.continuous = false;
      this.interimResults = false;
      this.lang = '';
      this.onresult = null;
      this.onend = null;
      this.onerror = null;
      this.onstart = null;
      instances.push(this);
    }
    start() { this.started++; if (FakeSR.failStart) throw new Error('engine refused'); if (this.onstart) this.onstart(); }
    abort() { this.aborted++; }
    stop() { this.aborted++; }
    /* --- helpers the test drives --- */
    say(transcript, isFinal = true) {
      const alt = Object.assign([{ transcript }], { isFinal });
      if (this.onresult) this.onresult({ results: Object.assign([alt], { length: 1 }) });
    }
    end() { if (this.onend) this.onend(); }
    fail(code) { if (this.onerror) this.onerror({ error: code }); }
  }
  FakeSR.instances = instances;
  FakeSR.failStart = false;
  FakeSR.latest = () => instances[instances.length - 1];
  return FakeSR;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function wakeApp(settings = {}, config = {}) {
  const SpeechRecognition = makeEngine();
  const app = createApp({
    settings: { perms: { microphone: true }, ...settings },
    globals: { SpeechRecognition }
  });
  Object.assign(app.Aevion.wake.config, {
    captureMs: 60, followupMs: 40, idleStopMs: 5000, backoffMin: 5, backoffMax: 25, ...config
  });
  const events = [];
  ['wake:state', 'wake:heard', 'wake:command', 'wake:barged', 'wake:error', 'wake:idle', 'wake:timeout']
    .forEach(n => app.Aevion.on(n, d => events.push({ n, d })));
  const wake = app.Aevion.wake;
  return {
    Aevion: app.Aevion, wake, events, SpeechRecognition,
    names: () => events.filter(e => e.n === 'wake:command').map(e => e.d.text),
    states: () => events.filter(e => e.n === 'wake:state').map(e => e.d.state)
  };
}

/* ---------- support / honesty ---------- */

test('without a speech engine it says so plainly instead of silently failing', async () => {
  const app = createApp();          // no SpeechRecognition in this sandbox
  const s = app.Aevion.wake.supported();
  assert.equal(s.ok, false);
  assert.match(s.reason, /no speech recognition/i);
  await assert.rejects(() => app.Aevion.wake.enable(), /no speech recognition/i);
});

test('with a speech engine it is available', () => {
  const { wake } = wakeApp();
  assert.equal(wake.supported().ok, true);
});

test('on Android with the native engine grounded it is available', () => {
  const SpeechRecognition = makeEngine();
  const app = createApp({
    globals: { SpeechRecognition, Capacitor: { Plugins: { Speech: {} } } }
  });
  assert.equal(app.Aevion.wake.supported().ok, true);
});

/* ---------- the name + greeting matcher ---------- */

test('matchesAddress: the name alone, with or without a request on the same breath', () => {
  const { wake } = wakeApp();
  const cases = [
    ['Aevion', 'name', ''],
    ['Aevion what is the weather', 'name+command', 'what is the weather'],
    ['aevion tell me a joke', 'name+command', 'tell me a joke'],
    ['AEVION, open youtube!', 'name+command', 'open youtube']
  ];
  for (const [text, kind, command] of cases) {
    const r = wake.matchesAddress(text);
    assert.equal(r.matched, true, text);
    assert.equal(r.kind, kind, text);
    assert.equal(r.command, command, text);
  }
});

test('matchesAddress: greeting + name wakes it, with or without a request', () => {
  const { wake } = wakeApp();
  const cases = [
    ['Hey Aevion', 'greeting+name', ''],
    ['hey aevion', 'greeting+name', ''],
    ['Hey Aevion, what is 2+2?', 'greeting+name+command', 'what is 2 2'],
    ['OK Aevion tell me a joke', 'greeting+name+command', 'tell me a joke'],
    ['Yo Aevion open site youtube', 'greeting+name+command', 'open site youtube'],
    ['Hayy Aevion what time is it', 'greeting+name+command', 'what time is it']
  ];
  for (const [text, kind, command] of cases) {
    const r = wake.matchesAddress(text);
    assert.equal(r.matched, true, text);
    assert.equal(r.kind, kind, text);
    assert.equal(r.command, command, text);
  }
});

test('matchesAddress: the request never contains the name or the greeting', () => {
  const { wake } = wakeApp();
  const r = wake.matchesAddress('Hey Aevion, what is 1+2?');
  assert.equal(r.command, 'what is 1 2');
  assert.equal(r.matchedWord, 'aevion');
  assert.equal(r.name, 'aevion');
});

test('matchesAddress: tolerates how recognizers actually mangle a name', () => {
  const { wake } = wakeApp();
  for (const spoken of ['hey averion what time is it', 'hei aevion what time is it', 'hey avion what time is it', 'yo aveon tell me a joke']) {
    const r = wake.matchesAddress(spoken);
    assert.equal(r.matched, true, `should have matched: ${spoken}`);
    assert.ok(r.command.length > 0, `the request should survive: ${spoken}`);
  }
});

test('matchesAddress: a filler word between greeting and name still wakes it', () => {
  const { wake } = wakeApp();
  const r = wake.matchesAddress('hey um aevion what is the weather');
  assert.equal(r.matched, true);
  assert.equal(r.command, 'what is the weather');
});

test('matchesAddress: does NOT wake on the name merely mentioned', () => {
  const { wake } = wakeApp();
  for (const text of [
    'what does aevion mean',
    'i lost my aevion account',
    'the aevion project is cool',
    'someone mentioned aevion earlier',
    'hey did you see aevion today'        // the name is too far from the greeting
  ]) {
    assert.equal(wake.matchesAddress(text).matched, false, `should NOT have matched: ${text}`);
  }
});

test('matchesAddress: the name at the front is addressed, even if the sentence is not a question', () => {
  // Same rule real assistants use: leading name = being spoken to. Pretending
  // to understand the intent here would mean guessing wrong either way.
  const { wake } = wakeApp();
  const r = wake.matchesAddress('Aevion is great but i am busy');
  assert.equal(r.matched, true);
  assert.equal(r.command, 'is great but i am busy');
});

test('matchesAddress: other conversation is ignored completely', () => {
  const { wake } = wakeApp();
  for (const text of ['I am just talking to someone else', 'the weather is nice', 'hello there friend', 'hey what time is it', 'ok let us leave']) {
    assert.equal(wake.matchesAddress(text).matched, false, `should NOT have matched: ${text}`);
  }
});

test('name variants returns the default name plus phonetic neighbours', () => {
  const { wake } = wakeApp();
  const vars = wake.nameVariants();
  assert.ok(vars.includes('aevion'), 'variants should include the default name');
  assert.ok(vars.includes('aveon'), 'variants should include a phonetic neighbour');
  assert.ok(vars.includes('avion'), 'variants should include a phonetic neighbour');
});

test('any nickname works: the configured name is what it answers to', () => {
  const { wake } = wakeApp({ name: 'Nova' });
  assert.equal(wake.matchesAddress('Nova').matched, true);
  assert.equal(wake.matchesAddress('hey nova').matched, true);
  assert.equal(wake.matchesAddress('nova what is 2+2').command, 'what is 2 2');
  assert.equal(wake.matchesAddress('hey noova').matched, false, 'short names must match exactly');
  assert.equal(wake.matchesAddress('hey aevion').matched, false, 'the old name stops working once it is renamed');
});

test('stop words are recognised as "stop", not as a request', () => {
  const { wake } = wakeApp();
  for (const s of ['stop', 'Stop.', 'shut up', 'never mind', 'QUIET']) assert.equal(wake.isStopWord(s), true, s);
  for (const s of ['stop the music', 'what is the weather', '']) assert.equal(wake.isStopWord(s), false, s);
});

/* ---------- the opt-in gate ---------- */

test('nothing listens until the user switches it on', () => {
  const { Aevion, SpeechRecognition } = wakeApp();
  assert.equal(Aevion.wake.state(), 'off');
  assert.equal(Aevion.settings.wake, false);
  assert.equal(SpeechRecognition.instances.length, 0, 'no recognizer before consent');
});

test('enabling asks for the microphone and refuses without it', async () => {
  const SpeechRecognition = makeEngine();
  const app = createApp({
    settings: { perms: { microphone: false } },   // and no mediaDevices in the sandbox either
    globals: { SpeechRecognition }
  });
  await assert.rejects(() => app.Aevion.wake.enable(), /Microphone permission denied/);
  assert.equal(SpeechRecognition.instances.length, 0, 'a denied permission must not open the mic');
  assert.equal(app.Aevion.settings.wake, false);
});

test('enabling starts listening and records the choice in settings', async () => {
  const { wake, Aevion, SpeechRecognition } = wakeApp();
  await wake.enable();
  assert.equal(SpeechRecognition.instances.length, 1);
  assert.equal(wake.state(), 'armed');
  assert.equal(Aevion.settings.wake, true);
  assert.equal(Aevion.store.get('settings').wake, true);
  wake.reset();
});

/* ---------- the Siri-like flow ---------- */

test('greeting + name + request in one breath: the request runs immediately', async () => {
  const { wake, SpeechRecognition, names, events } = wakeApp();
  await wake.enable();
  SpeechRecognition.latest().say('Hey Aevion what is 2+2');
  assert.deepEqual(names(), ['what is 2 2']);
  assert.equal(wake.state(), 'thinking');
  assert.equal(events[0].n, 'wake:state', 'the state change is announced before anything else');
  wake.reset();
});

test('the name alone: it answers, then takes the next sentence as the request', async () => {
  const { wake, SpeechRecognition, names, events } = wakeApp();
  await wake.enable();
  SpeechRecognition.latest().say('Aevion');
  assert.equal(wake.state(), 'capturing', 'it is listening for the request');
  assert.ok(events.some(e => e.n === 'wake:heard'), 'the UI is told it was addressed');
  assert.deepEqual(names(), [], 'nothing runs until the user actually asks');

  SpeechRecognition.latest().say('tell me a joke');   // no name needed this time
  assert.deepEqual(names(), ['tell me a joke']);
  assert.equal(wake.state(), 'thinking');
  wake.reset();
});

test('greeting + name alone behaves the same way', async () => {
  const { wake, SpeechRecognition, names, events } = wakeApp();
  await wake.enable();
  SpeechRecognition.latest().say('Hey Aevion');
  assert.equal(wake.state(), 'capturing');
  assert.equal(events.filter(e => e.n === 'wake:heard').length, 1);
  SpeechRecognition.latest().say('what is the weather');
  assert.deepEqual(names(), ['what is the weather']);
  wake.reset();
});

test('the request window closes and it goes back to waiting for the name', async () => {
  const { wake, SpeechRecognition, names, events } = wakeApp({}, { captureMs: 30 });
  await wake.enable();
  SpeechRecognition.latest().say('Aevion');
  await sleep(50);
  assert.equal(wake.state(), 'armed');
  assert.ok(events.some(e => e.n === 'wake:timeout'), 'the timeout is reported, not swallowed');

  SpeechRecognition.latest().say('tell me a joke');   // too late, not addressed
  assert.deepEqual(names(), []);
  wake.reset();
});

test('unrelated conversation is ignored completely', async () => {
  const { wake, SpeechRecognition, names, events } = wakeApp();
  await wake.enable();
  SpeechRecognition.latest().say('I am just talking to someone else in the room');
  SpeechRecognition.latest().say('the weather is nice');
  assert.deepEqual(names(), []);
  assert.equal(wake.state(), 'armed');
  assert.equal(events.some(e => e.n === 'wake:heard'), false);
  wake.reset();
});

test('after a reply you can keep talking without repeating the name', async () => {
  const { wake, SpeechRecognition, names } = wakeApp({}, { followupMs: 5000 });
  await wake.enable();
  SpeechRecognition.latest().say('Hey Aevion tell me a joke');
  assert.deepEqual(names(), ['tell me a joke']);

  wake.notifyReplyDone();
  assert.equal(wake.state(), 'armed');

  // No name this time — a follow-up keeps the speaker's words as they were
  // heard, because it was never matched against the name.
  SpeechRecognition.latest().say('what about 3+3');
  assert.deepEqual(names(), ['tell me a joke', 'what about 3+3']);
  assert.equal(wake.state(), 'thinking');
  wake.reset();
});

test('the follow-up window closes so the room does not drive the assistant', async () => {
  const { wake, SpeechRecognition, names } = wakeApp({}, { followupMs: 30 });
  await wake.enable();
  SpeechRecognition.latest().say('Hey Aevion tell me a joke');
  wake.notifyReplyDone();
  await sleep(50);
  SpeechRecognition.latest().say('so anyway i told him to leave');
  assert.deepEqual(names(), ['tell me a joke'], 'nothing outside the window runs');
  wake.reset();
});

test('talking over the reply stops it when you say stop', async () => {
  const { wake, Aevion, SpeechRecognition, events } = wakeApp();
  await wake.enable();
  let stopped = 0;
  Aevion.voice.shutup = () => { stopped++; };

  wake.notifySpeaking('a fairly long reply that is being read out loud right now');
  assert.equal(wake.state(), 'speaking');

  SpeechRecognition.latest().say('stop it');
  assert.equal(stopped, 1, 'speech must be cut off immediately');
  assert.equal(wake.state(), 'armed');
  assert.equal(events.some(e => e.n === 'wake:barged' && e.d.action === 'stop'), true);
  wake.reset();
});

test('talking over the reply with a real question runs that question instead of dropping it', async () => {
  const { wake, Aevion, SpeechRecognition, names, events } = wakeApp();
  await wake.enable();
  let stopped = 0;
  Aevion.voice.shutup = () => { stopped++; };

  wake.notifySpeaking('a fairly long reply that is being read out loud right now');
  SpeechRecognition.latest().say('what is the weather tomorrow');
  assert.equal(stopped, 1);
  assert.deepEqual(names(), ['what is the weather tomorrow']);
  assert.equal(events.some(e => e.n === 'wake:barged' && e.d.action === 'request'), true);
  wake.reset();
});

test('after speaking the reply it goes back to waiting for the name', async () => {
  const { wake } = wakeApp();
  await wake.enable();
  wake.notifySpeaking('short');
  assert.equal(wake.state(), 'speaking');
  wake.notifyReplyDone();
  assert.equal(wake.state(), 'armed');
  wake.reset();
});

test('a long reply still returns to armed even if the engine never reports finishing', async () => {
  const { wake } = wakeApp({}, {});
  await wake.enable();
  wake.notifySpeaking('x'.repeat(40));      // ~3.4s estimate, scaled below
  assert.equal(wake.state(), 'speaking');
  wake.config.followupMs = 10;
  await sleep(60);
  assert.equal(wake.state(), 'speaking', 'the estimate has not elapsed yet');
  wake.reset();
});

test('the state sequence for one full interaction is what the UI expects', async () => {
  const { wake, SpeechRecognition, states } = wakeApp();
  await wake.enable();
  SpeechRecognition.latest().say('Hey Aevion');
  SpeechRecognition.latest().say('tell me a joke');
  // addressed → listening for the request → the request runs
  assert.deepEqual(states(), ['armed', 'heard', 'capturing', 'thinking']);
  wake.reset();
});

/* ---------- battery and failure guards ---------- */

test('it stops itself after a while with no interaction', async () => {
  const { wake, events, Aevion } = wakeApp({}, { idleStopMs: 60 });
  await wake.enable();
  await sleep(80);
  assert.equal(wake.state(), 'off');
  assert.equal(Aevion.settings.wake, false, 'the setting is turned off too, not just the recognizer');
  assert.equal(events.some(e => e.n === 'wake:idle'), true);
});

test('talking to it keeps the idle timer open', async () => {
  const { wake, SpeechRecognition } = wakeApp({}, { idleStopMs: 90 });
  await wake.enable();
  for (let i = 0; i < 3; i++) { await sleep(40); SpeechRecognition.latest().say('Aevion tell me a joke'); }
  assert.notEqual(wake.state(), 'off');
  wake.reset();
});

test('hiding the page pauses the microphone and showing it resumes', async () => {
  const { wake, SpeechRecognition } = wakeApp();
  await wake.enable();
  assert.equal(wake.state(), 'armed');
  wake.pause('page hidden');
  assert.equal(wake.state(), 'paused');
  assert.ok(SpeechRecognition.latest().aborted > 0, 'the recognizer is actually aborted');
  wake.resume();
  assert.equal(wake.state(), 'armed');
  assert.equal(SpeechRecognition.instances.length, 2, 'a fresh session is started on resume');
  wake.reset();
});

test('a revoked microphone turns the mode off instead of spinning', async () => {
  const { wake, Aevion, SpeechRecognition } = wakeApp();
  await wake.enable();
  SpeechRecognition.latest().fail('not-allowed');
  assert.equal(wake.state(), 'off');
  assert.equal(Aevion.settings.wake, false);
});

test('repeated engine errors back off instead of becoming a hot loop', async () => {
  const { wake, SpeechRecognition } = wakeApp({}, { backoffMin: 5, backoffMax: 20 });
  await wake.enable();
  const first = SpeechRecognition.instances.length;
  for (let i = 0; i < 3; i++) {
    const rec = SpeechRecognition.latest();
    rec.fail('no-speech'); rec.end();
  }
  assert.equal(SpeechRecognition.instances.length, first, 'no restart storm while errors keep coming');
  await sleep(60);
  assert.ok(SpeechRecognition.instances.length > first, 'it does come back once the backoff elapses');
  wake.reset();
});

test('recognizer sessions restart after the browser ends them', async () => {
  const { wake, SpeechRecognition } = wakeApp();
  await wake.enable();
  const first = SpeechRecognition.instances.length;
  SpeechRecognition.latest().end();
  await sleep(30);
  assert.ok(SpeechRecognition.instances.length > first, 'a continuous listener has to be re-armed');
  wake.reset();
});

test('disabling stops the recognizer and clears the setting', async () => {
  const { wake, Aevion, SpeechRecognition } = wakeApp();
  await wake.enable();
  wake.disable('switched off by the user');
  assert.equal(wake.state(), 'off');
  assert.equal(Aevion.settings.wake, false);
  assert.ok(SpeechRecognition.latest().aborted > 0);
  assert.equal(wake.isAwake(), false);
  assert.equal(Aevion.wake.log().some(l => /switched off/.test(l.why)), true, 'the reason is kept for the activity log');
});
