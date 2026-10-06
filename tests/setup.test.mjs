/* Tests for setup.js — the brain doctor.
   These pin the promise that makes “the AI is not working” fixable at all:
   a provider that is configured but dead is *found*, named in plain words,
   and one tap away from being replaced by the best brain this device can
   actually reach. Also covers the two things that make the fix worth
   having: fallbacks that can really answer, and a local chat answer that is
   real before it is an apology. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, makeFetch, jsonReply, plain } from './harness.mjs';

/* nothing on this machine is listening on either local port */
const DEAD = { match: c => /11434|1234|localhost/.test(c.url), reply: { throws: new Error('Failed to fetch') } };
const MODELS_OK = { match: c => /\/models$/.test(c.url), reply: jsonReply({ data: [{ id: 'some-model' }] }) };

function app(settings = {}, handlers = []) {
  const fetch = makeFetch(handlers);
  const created = createApp({ settings, fetch });
  return { ...created, fetch };
}

test('quick(): a fresh install is honest about having no brain that can answer', () => {
  const { Aevion } = app();
  const q = Aevion.setup.quick();
  assert.equal(q.id, 'ollama');
  assert.equal(q.ok, false, 'nothing has been asked yet, so nothing may claim to work');
  assert.match(q.why, /Online AI is switched off/);
  assert.equal(q.gpu, false);
  assert.deepEqual(plain(q.missing), []);
});

test('quick(): a picked but unloaded in-browser model is not “ready”', () => {
  const { Aevion } = app({ aiProvider: 'webllm', onlineAI: true });
  const q = Aevion.setup.quick();
  assert.equal(q.ok, false);
  assert.match(q.why, /in-browser model/i);
});

test('quick(): a cloud provider without its key names exactly what is missing', () => {
  const { Aevion } = app({ aiProvider: 'groq', onlineAI: true });
  const q = Aevion.setup.quick();
  assert.deepEqual(plain(q.missing), ['API key']);
  assert.equal(q.ok, false);
  assert.match(q.why, /API key/);
});

test('modelsUrl(): only OpenAI-compatible adapters can be probed cheaply', () => {
  const { Aevion } = app();
  assert.equal(Aevion.setup.modelsUrl('ollama'), 'http://localhost:11434/v1/models');
  assert.equal(Aevion.setup.modelsUrl('lmstudio'), 'http://localhost:1234/v1/models');
  assert.equal(Aevion.setup.modelsUrl('openai'), 'https://api.openai.com/v1/models');
  assert.equal(Aevion.setup.modelsUrl('anthropic'), '', 'no keyless listing → reported, never guessed at');
  assert.equal(Aevion.setup.modelsUrl('gemini'), '');
  assert.equal(Aevion.setup.modelsUrl('webllm'), '');
  assert.equal(Aevion.setup.modelsUrl('mock'), '');
});

test('probe(): a server that answers is reported with its timing, and its key is sent', async () => {
  const { Aevion, fetch } = app({ onlineAI: true, aiProvider: 'openai' }, [MODELS_OK]);
  Aevion.providers.setKey('openai', 'sk-test');
  const p = await Aevion.setup.probe('openai');
  assert.equal(p.ok, true);
  assert.ok(p.ms >= 0);
  assert.equal(fetch.calls[0].opts.method, 'GET', 'a probe is a listing, never a prompt');
  assert.equal(fetch.calls[0].opts.headers.Authorization, 'Bearer sk-test');
  assert.match(fetch.calls[0].url, /\/v1\/models$/);
});

test('probe(): nothing listening on your own machine is said in plain words', async () => {
  const { Aevion } = app({ onlineAI: true }, [DEAD]);
  const p = await Aevion.setup.probe('ollama');
  assert.equal(p.ok, false);
  assert.match(p.why, /nothing is listening at http:\/\/localhost:11434/);
});

test('probe(): while Online AI is off, nothing at all is asked', async () => {
  const { Aevion, fetch } = app({ onlineAI: false }, [MODELS_OK]);
  const p = await Aevion.setup.probe('ollama');
  assert.equal(p.ok, false);
  assert.equal(fetch.calls.length, 0, 'the network must not be touched');
  assert.match(p.why, /Online AI is off/);
});

test('survey(): the exact reported bug — Ollama picked, nothing on the port', async () => {
  const { Aevion } = app({ aiProvider: 'ollama', onlineAI: true, autoAI: true }, [DEAD]);
  const s = await Aevion.setup.survey();
  const ollama = s.options.find(o => o.id === 'ollama');
  assert.equal(ollama.state, 'unreachable');
  assert.match(ollama.why, /nothing is listening/);
  assert.equal(s.current, 'ollama');
  assert.equal(s.best, null);
  assert.match(s.why, /nothing is answering/i);
  assert.match(Aevion.setup.note(), /did not answer/, 'the local reply can name the real fault');
  assert.equal(Aevion.setup.last().best, null);
});

test('survey(): a loaded in-browser model is found when every server is dead', async () => {
  const { Aevion } = app({ aiProvider: 'ollama', onlineAI: true }, [DEAD]);
  Aevion.webllm.engine = {};
  Aevion.webllm.loadedModel = 'Llama-3.2-1B-Instruct-q4f32_1-MLC';
  const s = await Aevion.setup.survey();
  assert.equal(s.best, 'webllm');
  assert.match(s.why, /on this device/);
});

test('decide(): a working choice is never overruled, and a local brain beats a hosted one', () => {
  const { Aevion } = app();
  const opt = (id, kind, state, ms = 0) => ({ id, kind, state, ms, label: id, why: '' });
  const both = () => [opt('ollama', 'loopback', 'ready', 40), opt('webllm', 'local', 'ready'), opt('groq', 'cloud', 'ready')];

  assert.equal(Aevion.setup.decide(both(), 'groq').id, 'groq', 'never move off a choice that works');
  assert.match(Aevion.setup.decide(both(), 'groq').why, /already set/);
  assert.equal(Aevion.setup.decide(both(), 'anthropic').id, 'ollama', 'a server on your own machine first');
  assert.equal(Aevion.setup.decide([opt('webllm', 'local', 'ready'), opt('groq', 'cloud', 'ready')], 'ollama').id, 'webllm');
  const hosted = Aevion.setup.decide([opt('groq', 'cloud', 'ready')], 'ollama');
  assert.equal(hosted.id, 'groq');
  assert.match(hosted.why, /key you already saved/);
  assert.equal(Aevion.setup.decide([opt('ollama', 'loopback', 'unreachable')], 'ollama').id, null);
});

test('best() + apply(): one tap switches to the brain that is actually answering', async () => {
  const { Aevion } = app({ aiProvider: 'ollama', onlineAI: true }, [DEAD, MODELS_OK]);
  Aevion.providers.setKey('groq', 'gsk-test');
  const r = await Aevion.setup.best();
  assert.equal(r.id, 'groq');
  const applied = Aevion.setup.apply(r.id);
  assert.equal(Aevion.settings.aiProvider, 'groq');
  assert.equal(applied.label, 'Groq (fast hosted)');
  assert.equal(applied.turnedOn, false, 'online AI was already on');
});

test('apply(): a local brain never switches online AI on, a hosted one asks for it', () => {
  const { Aevion } = app({ onlineAI: false });
  const onDevice = Aevion.setup.apply('mock');
  assert.equal(onDevice.turnedOn, false);
  assert.equal(Aevion.settings.onlineAI, false);
  const hosted = Aevion.setup.apply('ollama');
  assert.equal(hosted.turnedOn, true, 'the button said so, so the tap is the consent');
  assert.equal(Aevion.settings.onlineAI, true);
  assert.equal(Aevion.settings.aiProvider, 'ollama');
  assert.throws(() => Aevion.setup.apply('nope-not-a-brain'));
});

test('note(): stays quiet about a provider that has not been asked yet', () => {
  const { Aevion } = app({ aiProvider: 'groq', onlineAI: true });
  assert.match(Aevion.setup.note(), /still needs API key/);
  const healthy = app({ aiProvider: 'ollama', onlineAI: true });
  healthy.Aevion.setup.quick();
  assert.equal(healthy.Aevion.setup.note(), '', 'a configured provider is not slandered before it is asked');
});

test('fallbacks: a provider that cannot answer now is not offered as one', () => {
  const { Aevion } = app({ aiProvider: 'ollama', onlineAI: true });
  assert.equal(Aevion.providers.canAnswerNow('webllm'), false, 'nothing is loaded yet');
  assert.ok(!Aevion.providers.fallbackIds('ollama').includes('webllm'));
  Aevion.webllm.engine = {};
  Aevion.webllm.loadedModel = 'Llama-3.2-1B-Instruct-q4f32_1-MLC';
  assert.equal(Aevion.providers.canAnswerNow('webllm'), true);
  assert.ok(Aevion.providers.fallbackIds('ollama').includes('webllm'));
  assert.ok(!Aevion.providers.fallbackIds('ollama').includes('mock'), 'the canned provider is never a fallback');
});

test('local chat: with no brain, the offline answer is real before it is an apology', async () => {
  const { Aevion } = app({ aiProvider: 'ollama', onlineAI: true, memory: true }, [DEAD]);
  await Aevion.setup.survey();

  const noted = await Aevion.brain.handle('what is python');
  assert.match(noted, /PYTHON/, 'a language in my own local notes is a real answer');

  const counted = await Aevion.brain.handle('how many words in "one two three"');
  assert.match(counted, /3 words/, 'text I can really operate on is a real answer');

  const nothing = await Aevion.brain.handle('tell me a story about the ocean at midnight');
  assert.match(nothing, /No brain answered/);
  assert.match(nothing, /nothing is listening/, 'and it names the actual fault, not a shrug');
  assert.match(nothing, /in-browser model/, 'and the one-tap ways forward');
});

test('textOp(): the offline brain really does the text work it claims', () => {
  const { Aevion } = app();
  assert.match(Aevion.skills.textOp('count the words in "a b c d"'), /4 words/);
  assert.match(Aevion.skills.textOp('uppercase: hello'), /HELLO/);
  assert.match(Aevion.skills.textOp('reverse: abc'), /cba/);
  assert.match(Aevion.skills.textOp('sort these lines alphabetically:\nb\na\nc'), /a\nb\nc/);
  assert.match(Aevion.skills.textOp('dedupe: x\nx\ny'), /1 duplicate line removed/);
  assert.match(Aevion.skills.textOp('word frequency of: "go go go stop stop"'), /go ×3/);
  assert.equal(Aevion.skills.textOp('just a normal question about life'), null, 'no body, no work');
});

test('verdict(): a list can tell the truth about one brain without asking it anything', () => {
  const { Aevion, fetch } = app();
  const v = Aevion.setup.verdict('groq');
  assert.equal(v.state, 'needs', 'a saved key is not the same thing as a working brain');
  assert.match(v.text, /needs API key/);
  assert.equal(v.face, '⚙️');
  assert.equal(fetch.calls.length, 0, 'verdict() never probes — a list can call it freely');

  /* A configured Ollama with nothing behind it must never read “ready”. A
     fresh install has Online AI off, so that is what it says first; with the
     switch on it says “set up — not checked yet”, which is what it is. */
  const off = Aevion.setup.verdict('ollama');
  assert.equal(off.state, 'off');
  assert.match(off.text, /online AI is switched off/);

  const { Aevion: on } = app({ aiProvider: 'ollama', onlineAI: true });
  const unchecked = on.setup.verdict('ollama');
  assert.equal(unchecked.state, 'test');
  assert.match(unchecked.text, /not checked yet/);
  assert.match(on.setup.verdict('webllm').text, /not downloaded yet|no WebGPU/);
  assert.equal(Aevion.setup.verdict('mock').state, 'test');
  assert.match(Aevion.setup.verdict('not-a-thing').text, /not a provider/);
});

test('verdict(): after a real check it repeats what that check found, with the time', async () => {
  const { Aevion } = app({ aiProvider: 'ollama', onlineAI: true, perms: { automation: true } }, [DEAD]);
  const s = await Aevion.setup.survey(['ollama', 'groq']);
  const v = Aevion.setup.verdict('ollama');
  assert.equal(v.state, 'unreachable');
  assert.match(v.text, /nothing is listening at http:\/\/localhost:11434/);
  assert.equal(v.face, '⚠️');
  assert.equal(v.checked, s.at);
  assert.equal(Aevion.setup.verdict('groq').state, 'needs');
});

test('plugin brains: a plugin can name its own brain, and auto follows the picker', () => {
  const { Aevion } = app({ aiProvider: 'ollama' });
  assert.equal(Aevion.plugins.brainFor({ ai: '' }), null);
  assert.equal(Aevion.plugins.brainFor({ ai: 'auto' }).id, 'ollama');
  assert.equal(Aevion.plugins.brainFor({ ai: 'groq' }).id, 'groq');
  Aevion.set('aiProvider', 'webllm');
  assert.equal(Aevion.plugins.brainFor({ ai: 'auto' }).id, 'webllm');

  const named = Aevion.plugins.addSimple({ name: 'Named brain', triggers: ['nmd'], reply: 'hi', ai: 'groq' });
  assert.equal(named.ai, 'groq');
  assert.equal(Aevion.plugins.describe().find(p => p.name === 'Named brain').ai, 'groq');
  const junk = Aevion.plugins.addSimple({ name: 'Junk brain', triggers: ['jnk'], reply: 'hi', ai: 'not-a-brain' });
  assert.equal(junk.ai, 'auto', 'an unknown brain falls back to whichever is picked');
  Aevion.plugins.remove('Named brain');
  Aevion.plugins.remove('Junk brain');
});
