/* Tests for using more than one brain (providers.js `multiPlan`, `askMany`,
   `askCritique`).

   The promise being pinned is the honest one: several keys can be used
   together, each strategy does something specific that can be described in a
   sentence, every leg is recorded in the attempt log, and a brain that fails
   never takes the answer down with it. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, makeFetch, jsonReply, plain } from './harness.mjs';

const msgs = [{ role: 'user', content: 'what is a vector database?' }];

function app(settings = {}, handlers = []) {
  const fetch = makeFetch(handlers);
  const created = createApp({ settings: { onlineAI: true, ...settings }, fetch });
  // a key for every hosted provider under test, unless the test removes it
  ['openai', 'groq', 'openrouter'].forEach(id => created.Aevion.providers.setKey(id, 'sk-test'));
  return { ...created, fetch };
}
const reply = text => [{ match: () => true, reply: jsonReply({ choices: [{ message: { content: text } }] }) }];

test('strategy: anything unknown falls back to one brain, never to a surprise', () => {
  const { Aevion } = app({ brainStrategy: 'whatever' });
  assert.equal(Aevion.providers.brainStrategy(), 'first');
  assert.deepEqual(plain(Aevion.providers.multiPlan()), []);
});

test('plan: one brain at a time means no plan at all, however many are ticked', () => {
  const { Aevion } = app({ brainSet: ['openai', 'groq'], brainStrategy: 'first' });
  assert.deepEqual(plain(Aevion.providers.multiPlan()), []);
});

test('plan: only ticked brains that can actually answer take part', () => {
  const { Aevion } = app({ brainSet: ['openai', 'groq', 'anthropic'], brainStrategy: 'compare' });
  assert.deepEqual(plain(Aevion.providers.multiPlan()), ['openai', 'groq'], 'anthropic has no key, so it is not promised');
  Aevion.providers.setKey('groq', '');
  assert.deepEqual(plain(Aevion.providers.multiPlan()), [], 'fewer than two ready brains is a normal chat');
  Aevion.set('brainSet', ['openai', 'mock']);
  assert.deepEqual(plain(Aevion.providers.multiPlan()), ['openai', 'mock'], 'an on-device brain may take part too');
});

test('plan: with Online AI off, only the on-device brains can be planned', () => {
  const { Aevion } = app({ brainSet: ['openai', 'mock'], brainStrategy: 'compare', onlineAI: false });
  assert.deepEqual(plain(Aevion.providers.multiPlan()), []);
});

test('a check decides who takes part: two ticked but silent servers are not promised', async () => {
  const dead = makeFetch([{ match: c => /11434|1234/.test(c.url), reply: { throws: new Error('Failed to fetch') } }]);
  const { Aevion } = createApp({
    settings: { aiProvider: 'ollama', onlineAI: true, brainSet: ['ollama', 'lmstudio'], brainStrategy: 'compare' },
    fetch: dead
  });
  assert.deepEqual(plain(Aevion.providers.multiPlan()), ['ollama', 'lmstudio'], 'nothing has been checked yet, so nothing is claimed either way');

  await Aevion.setup.survey(['ollama', 'lmstudio']);
  assert.equal(Aevion.providers.canAnswerNow('ollama'), false, 'a server found silent is not able to answer');
  assert.deepEqual(plain(Aevion.providers.multiPlan()), [], 'so the list stops promising two brains');
  assert.equal(Aevion.setup.verdict('ollama').state, 'unreachable');

  const alive = makeFetch([{ match: c => /11434|1234/.test(c.url), reply: jsonReply({ data: [{ id: 'llama3.2' }] }) }]);
  const { Aevion: b } = createApp({
    settings: { aiProvider: 'ollama', onlineAI: true, brainSet: ['ollama', 'lmstudio'], brainStrategy: 'compare' },
    fetch: alive
  });
  await b.setup.survey(['ollama', 'lmstudio']);
  assert.equal(b.providers.canAnswerNow('ollama'), true);
  assert.deepEqual(plain(b.providers.multiPlan()), ['ollama', 'lmstudio'], 'and a server that answered is used');
});

test('compare: every brain is asked, every answer comes back, and a failure is named not hidden', async () => {
  const fetch = makeFetch([
    { match: c => c.url.includes('api.openai.com'), reply: jsonReply({ choices: [{ message: { content: 'an answer from A' } }] }) },
    { match: c => c.url.includes('api.groq.com'), reply: { status: 429, text: 'slow down', json: {} } }
  ]);
  const { Aevion } = createApp({ settings: { onlineAI: true, brainSet: ['openai', 'groq', 'mock'], brainStrategy: 'compare' }, fetch });
  Aevion.providers.setKey('openai', 'sk-test');
  Aevion.providers.setKey('groq', 'sk-test');

  const legs = await Aevion.providers.askMany(Aevion.providers.multiPlan(), msgs);
  assert.deepEqual(plain(legs.map(l => [l.id, l.ok])), [['openai', true], ['groq', false], ['mock', true]]);
  assert.equal(legs[0].text, 'an answer from A');
  assert.match(legs[1].why, /rate limited/);
  assert.ok(legs[2].text.length > 0, 'the on-device brain still answered');

  // the log is ordered by when each leg finished, so its order is the network's, not ours
  const log = plain(Aevion.providers.attempts()).map(e => e.id + (e.ok ? '+' : '-')).sort();
  assert.deepEqual(log, ['groq-', 'mock+', 'openai+'], 'each leg is its own line in the brain log');
});

test('critique: the second brain is handed the first one’s draft, and its revision is the answer', async () => {
  let reviewerBody = null;
  const fetch = makeFetch([{
    match: c => c.url.includes('api.openai.com'),
    reply: call => { reviewerBody = call.body; return jsonReply({ choices: [{ message: { content: 'corrected answer' } }] }); }
  }]);
  const { Aevion } = createApp({ settings: { onlineAI: true, brainSet: ['mock', 'openai'], brainStrategy: 'critique' }, fetch });
  Aevion.providers.setKey('openai', 'sk-test');

  const r = await Aevion.providers.askCritique(Aevion.providers.multiPlan(), msgs);
  assert.equal(r.text, 'corrected answer');
  assert.equal(r.by, 'openai');
  assert.equal(r.legs.length, 2);
  assert.equal(r.legs[1].reviewed, true, 'the second leg is a review, not a fresh guess');
  const sent = JSON.stringify(reviewerBody);
  assert.match(sent, /Draft answer/);
  assert.match(sent, /what is a vector database\?/, 'the reviewer gets the original question');
  assert.match(sent, /offline test provider/, 'and the draft it is reviewing');
});

test('critique: a reviewer that fails never throws the draft away', async () => {
  const fetch = makeFetch([{ match: c => c.url.includes('api.openai.com'), reply: { status: 500, text: 'boom', json: {} } }]);
  const { Aevion } = createApp({ settings: { onlineAI: true, brainSet: ['mock', 'openai'], brainStrategy: 'critique' }, fetch });
  Aevion.providers.setKey('openai', 'sk-test');

  const r = await Aevion.providers.askCritique(Aevion.providers.multiPlan(), msgs);
  assert.match(r.text, /offline test provider/, 'the first answer stands');
  assert.equal(r.by, 'mock', 'and it is still credited to the brain that produced it');
  assert.equal(r.legs[1].ok, false);
  assert.match(r.legs[1].why, /server error/);
});

test('critique: with only one brain reachable it is simply a normal answer', async () => {
  const { Aevion } = app({ brainSet: ['mock'], brainStrategy: 'critique' });
  const r = await Aevion.providers.askCritique(['mock'], msgs);
  assert.equal(r.legs.length, 1);
  assert.equal(r.legs[0].reviewed, false, 'nothing to review');
  assert.ok(r.text.length > 0);
});
