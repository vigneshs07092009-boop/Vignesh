/* Tests for the brain attempt log in providers.js.
   The promise these pin: “the AI is not working” is answerable from the app
   itself. Every real attempt is recorded — which brain, whether it answered,
   how long it took, and why it did not — and the record never contains the
   prompt, the reply or a key. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, makeFetch, jsonReply, plain } from './harness.mjs';

const msgs = [{ role: 'user', content: 'my secret prompt' }];
const ANSWER = 'the secret answer';
const okReply = jsonReply({ choices: [{ message: { content: ANSWER } }] });

function app(settings = {}, handlers = []) {
  const fetch = makeFetch(handlers);
  return { ...createApp({ settings, fetch }), fetch };
}

test('an answered attempt is recorded with its provider, timing and size', async () => {
  const { Aevion } = app({ onlineAI: true, aiProvider: 'openai' }, [{ match: c => c.url.includes('openai'), reply: okReply }]);
  Aevion.providers.setKey('openai', 'sk-test-key');
  await Aevion.providers.chatWith('openai', msgs);

  const log = plain(Aevion.providers.attempts());
  assert.equal(log.length, 1);
  assert.equal(log[0].id, 'openai');
  assert.equal(log[0].ok, true);
  assert.equal(log[0].chars, ANSWER.length);
  assert.equal(log[0].kind, 'chat');
  assert.ok(log[0].ms >= 0);
  assert.deepEqual(plain(Aevion.providers.attemptStats()), { total: 1, ok: 1, failed: 0 });
});

test('the log records the attempt, never the content', async () => {
  const { Aevion } = app({ onlineAI: true, aiProvider: 'openai' }, [{ match: () => true, reply: okReply }]);
  Aevion.providers.setKey('openai', 'sk-verysecretkey');
  await Aevion.providers.chatWith('openai', msgs);

  const dump = JSON.stringify(plain(Aevion.providers.attempts()));
  assert.equal(dump.includes('my secret prompt'), false, 'no prompt text may be stored');
  assert.equal(dump.includes(ANSWER), false, 'no reply text may be stored');
  assert.equal(dump.includes('sk-verysecretkey'), false, 'no key material may be stored');
});

test('a failed attempt keeps the message the provider itself gave', async () => {
  const { Aevion } = app({ onlineAI: true, aiProvider: 'openai' }, [{ match: () => true, reply: jsonReply({ error: 'nope' }, 401) }]);
  Aevion.providers.setKey('openai', 'sk-test-key');
  await assert.rejects(() => Aevion.providers.chatWith('openai', msgs), /rejected the API key/);

  const log = plain(Aevion.providers.attempts());
  assert.equal(log[0].ok, false);
  assert.match(log[0].why, /rejected the API key \(HTTP 401\)/);
  assert.equal(log[0].chars, 0);
});

test('a fallback chain is recorded attempt by attempt, in order', async () => {
  const fetch = makeFetch([
    { match: c => c.url.includes('localhost:11434'), reply: { throws: new Error('Failed to fetch') } },
    { match: c => c.url.includes('localhost:1234'), reply: jsonReply({ choices: [{ message: { content: 'local one' } }] }) }
  ]);
  const { Aevion } = createApp({ settings: { onlineAI: true, aiProvider: 'ollama' }, fetch });
  const r = await Aevion.providers.chatWithFallback(msgs);
  assert.equal(r.provider, 'lmstudio');

  const log = plain(Aevion.providers.attempts());
  assert.deepEqual(log.map(e => e.id), ['ollama', 'lmstudio']);
  assert.deepEqual(log.map(e => e.ok), [false, true]);
  assert.match(log[0].why, /cannot reach http:\/\/localhost:11434/);
});

test('a provider that was never tried says so, instead of looking like a failure', async () => {
  const { Aevion } = app({ onlineAI: true, aiProvider: 'groq' });
  await assert.rejects(() => Aevion.providers.chatWithFallback(msgs));

  const log = plain(Aevion.providers.attempts());
  const first = log[0];
  assert.equal(first.id, 'groq');
  assert.equal(first.skipped, true);
  assert.equal(first.kind, 'skip');
  assert.match(first.why, /not set up: needs API key/);
  assert.ok(log.every(e => e.ok === false), 'nothing answered, so nothing may look like it did');
});

test('the log is capped, so it cannot grow without limit', () => {
  const { Aevion } = app();
  for (let i = 0; i < 70; i++) Aevion.providers.noteAttempt({ id: 'mock', ok: true, chars: 1, ms: 1 });
  const log = plain(Aevion.providers.attempts());
  assert.equal(log.length, 60, 'sixty attempts are kept, the oldest fall off');
  assert.ok(log[0].t <= log[log.length - 1].t, 'and they stay in the order they happened');
});

test('clearing the log empties it and says so on the bus', () => {
  const { Aevion } = app();
  let events = 0;
  Aevion.on('brain:log', () => events++);
  Aevion.providers.noteAttempt({ id: 'ollama', ok: false, why: 'nothing listening' });
  Aevion.providers.noteAttempt({ id: 'webllm', ok: true, chars: 12, ms: 900 });
  assert.deepEqual(plain(Aevion.providers.attemptStats()), { total: 2, ok: 1, failed: 1 });

  Aevion.providers.clearAttempts();
  assert.deepEqual(plain(Aevion.providers.attempts()), []);
  assert.equal(events, 3, 'two attempts and one clear were announced');
});

test('on-device brains are recorded too, not only the network ones', async () => {
  const { Aevion } = app({ aiProvider: 'mock' });
  await Aevion.providers.chatWith('mock', msgs);
  const log = plain(Aevion.providers.attempts());
  assert.equal(log[0].id, 'mock');
  assert.equal(log[0].ok, true);
  assert.ok(log[0].chars > 0);
});

test('an in-browser model that was never loaded is recorded as the failure it is', async () => {
  const { Aevion } = app({ aiProvider: 'webllm', onlineAI: true });
  await assert.rejects(() => Aevion.providers.chatWith('webllm', msgs), /No in-browser model is loaded yet/);
  const log = plain(Aevion.providers.attempts());
  assert.equal(log[0].id, 'webllm');
  assert.equal(log[0].ok, false);
  assert.match(log[0].why, /No in-browser model is loaded yet/);
});
