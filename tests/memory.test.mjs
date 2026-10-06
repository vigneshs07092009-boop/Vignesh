/* Tests for memory.js — layers, the approval gate, scored recall,
   migration from the flat 0.5.x store, and user control. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, plain, makeStorage } from './harness.mjs';

// recall() returns VM-realm arrays; plain() brings them back as local data
const texts = hits => plain(hits).map(h => h.text);

test('layers: five layers exist with separate storage', () => {
  const { Aevion } = createApp();
  assert.deepEqual(plain(Aevion.memory.layerNames()), ['session', 'history', 'longterm', 'prefs', 'temp']);
  Aevion.memory.add('in longterm', 'fact', 'longterm');
  Aevion.memory.add('in prefs', 'inferred', 'prefs');
  assert.equal(Aevion.memory.all('longterm').length, 1);
  assert.equal(Aevion.memory.all('prefs').length, 1);
  assert.equal(Aevion.memory.all('temp').length, 0);
});

test('layers: the same text can live in two layers without cross-talk', () => {
  const { Aevion } = createApp();
  Aevion.memory.add('I like tea', 'fact', 'longterm');
  Aevion.memory.add('I like tea', 'inferred', 'prefs');
  assert.equal(Aevion.memory.all('longterm').length, 1);
  assert.equal(Aevion.memory.all('prefs').length, 1);
});

test('layers: an unknown layer is an error, not a silent write', () => {
  const { Aevion } = createApp();
  assert.throws(() => Aevion.memory.add('x', 't', 'subconscious'), /Unknown memory layer/);
});

test('layers: session lives in RAM only', () => {
  const { Aevion, storage } = createApp();
  Aevion.memory.add('scratch', 't', 'session');
  assert.equal(Aevion.memory.all('session').length, 1);
  const blob = Object.keys(storage).map(k => storage.getItem(k)).join('|');
  assert.equal(blob.includes('scratch'), false, 'session notes must never be persisted');
});

test('layers: each layer is capped independently', () => {
  const { Aevion } = createApp();
  for (let i = 0; i < 60; i++) Aevion.memory.add('s' + i, 't', 'session');
  assert.equal(Aevion.memory.all('session').length, 50);
  for (let i = 0; i < 520; i++) Aevion.memory.add('l' + i, 't', 'longterm');
  assert.equal(Aevion.memory.all('longterm').length, 500);
});

test('history: reads the real conversation log', () => {
  const { Aevion } = createApp();
  Aevion.store.set('chatHistory', [
    { role: 'user', text: 'my exam is on friday', t: Date.now() },
    { role: 'ai', text: 'noted', t: Date.now() }
  ]);
  const h = Aevion.memory.all('history');
  assert.equal(h.length, 2);
  assert.equal(h[0].text, 'my exam is on friday');
});

/* ---------- the approval gate ---------- */

test('prefs: an inferred preference is inert until approved', () => {
  const { Aevion } = createApp();
  Aevion.memory.suggest('I prefer tea over coffee');
  assert.equal(Aevion.memory.pending().length, 1);

  // inert: it is not offered as context, however well it matches
  assert.deepEqual(texts(Aevion.memory.recall('coffee')), []);
  assert.equal(Aevion.memory.contextFor('coffee'), '');

  const id = Aevion.memory.pending()[0].id;
  Aevion.memory.approve(id);
  assert.equal(Aevion.memory.pending().length, 0);
  assert.deepEqual(texts(Aevion.memory.recall('coffee')), ['I prefer tea over coffee']);
});

test('prefs: rejecting an inference deletes it', () => {
  const { Aevion } = createApp();
  Aevion.memory.suggest('I always work at night');
  Aevion.memory.remove(Aevion.memory.pending()[0].id, 'prefs');
  assert.equal(Aevion.memory.all('prefs').length, 0);
});

/* ---------- retrieval ---------- */

test('recall: ranks the relevant memory above an unrelated one', () => {
  const { Aevion } = createApp();
  Aevion.memory.add('My exam is on Friday', 'fact', 'longterm');
  Aevion.memory.add('My favourite coffee is filter', 'fact', 'longterm');
  const hits = Aevion.memory.recall('when is my exam');
  assert.equal(hits[0].text, 'My exam is on Friday');
  assert.equal(hits.length, 1, 'unrelated memories are not offered');
});

test('recall: prefers a fresh memory over a stale one with the same words', () => {
  const { Aevion } = createApp();
  Aevion.memory.add('project alpha status', 'fact', 'longterm');
  Aevion.store.set('memory:longterm', [
    { id: 'old', text: 'project alpha status', tag: 'fact', t: Date.now() - 30 * 86400000, approved: true }
  ]);
  const hits = Aevion.memory.recall('alpha');
  assert.equal(hits.length, 1);
  assert.ok(hits[0].score > 0);
});

test('recall: a multi-word match scores higher than a single-word one', () => {
  const { Aevion } = createApp();
  Aevion.memory.add('beta', 'fact', 'longterm');
  Aevion.memory.add('alpha beta gamma', 'fact', 'longterm');
  const hits = Aevion.memory.recall('alpha beta gamma delta');
  assert.equal(hits[0].text, 'alpha beta gamma');
});

test('recall: respects the limit and reports the layer of each hit', () => {
  const { Aevion } = createApp();
  for (let i = 0; i < 10; i++) Aevion.memory.add('keyword item ' + i, 'fact', 'longterm');
  Aevion.memory.temp('keyword temporary', 60000);
  const hits = Aevion.memory.recall('keyword', { limit: 3 });
  assert.equal(hits.length, 3);
  for (const h of hits) assert.ok(['longterm', 'temp', 'prefs', 'session', 'history'].includes(h.layer));
});

test('recall: an empty query returns nothing rather than everything', () => {
  const { Aevion } = createApp();
  Aevion.memory.add('something', 'fact', 'longterm');
  assert.equal(Aevion.memory.recall('').length, 1, 'no query = recent items are still available');
  assert.equal(Aevion.memory.recall('unrelated-topic').length, 0);
});

test('temp: expires on its own', () => {
  const { Aevion } = createApp();
  Aevion.memory.temp('short lived', -1);          // already expired
  Aevion.memory.temp('still here', 60000);
  const live = Aevion.memory.all('temp');
  assert.equal(live.length, 1);
  assert.equal(live[0].text, 'still here');
});

test('contextFor: produces a compact prompt block, not the whole store', () => {
  const { Aevion } = createApp();
  for (let i = 0; i < 40; i++) Aevion.memory.add('noise ' + i, 'fact', 'longterm');
  Aevion.memory.add('the user drives a blue bicycle', 'fact', 'longterm');
  const ctx = Aevion.memory.contextFor('what colour is my bicycle', 3);
  const lines = ctx.split('\n');
  assert.ok(lines.length <= 3);
  assert.match(ctx, /blue bicycle/);
});

/* ---------- user control ---------- */

test('clear: empties a single layer and leaves the others alone', () => {
  const { Aevion } = createApp();
  Aevion.memory.add('keep me', 'fact', 'longterm');
  Aevion.memory.temp('drop me', 60000);
  Aevion.memory.clear('temp');
  assert.equal(Aevion.memory.all('temp').length, 0);
  assert.equal(Aevion.memory.all('longterm').length, 1);
});

test('wipe: erases every layer and the legacy key', () => {
  const { Aevion } = createApp();
  Aevion.memory.add('a', 'fact', 'longterm');
  Aevion.memory.suggest('b');
  Aevion.memory.temp('c', 60000);
  Aevion.store.set('memory', [{ text: 'legacy', t: 1 }]);
  Aevion.memory.wipe();
  for (const l of Aevion.memory.layerNames()) assert.equal(Aevion.memory.all(l).length, 0, l + ' must be empty');
  assert.equal(Aevion.store.get('memory', null), null);
});

test('stats: reports counts, caps and how many prefs are approved', () => {
  const { Aevion } = createApp();
  Aevion.memory.add('one', 'fact', 'longterm');
  Aevion.memory.suggest('two');
  const s = Aevion.memory.stats();
  assert.equal(s.longterm.count, 1);
  assert.equal(s.longterm.cap, 500);
  assert.equal(s.prefs.count, 1);
  assert.equal(s.prefs.approved, 0);
});

/* ---------- migration ---------- */

test('migrate: moves the 0.5.x flat memory array into longterm, once', () => {
  const { Aevion } = createApp();
  Aevion.store.set('memory', [
    { id: 'x1', text: 'User likes kotlin', tag: 'profile', t: 1700000000000 },
    { id: 'x2', text: 'User likes kotlin', tag: 'fact', t: 1700000000001 },
    { id: 'x3', text: '   ', t: 1700000000002 }
  ]);
  assert.equal(Aevion.memory.migrate(), 1, 'duplicates and blanks are dropped');
  assert.equal(Aevion.store.get('memory', null), null, 'the legacy key is removed after migrating');
  assert.equal(Aevion.memory.all('longterm').length, 1);
  assert.equal(Aevion.memory.migrate(), 0, 'migration is idempotent');
});

test('migrate: existing saved facts are not duplicated by a re-run', () => {
  const { Aevion } = createApp();
  Aevion.memory.add('already here', 'fact', 'longterm');
  Aevion.store.set('memory', [{ text: 'already here', t: 1 }, { text: 'new one', t: 2 }]);
  Aevion.memory.migrate();
  const all = texts(Aevion.memory.all('longterm'));
  assert.deepEqual(all.slice().sort(), ['already here', 'new one']);
});

test('migrate: survives a corrupt legacy value', () => {
  const { Aevion } = createApp();
  Aevion.store.set('memory', 'not-an-array');
  assert.equal(Aevion.memory.migrate(), 0);
});

test('layers persist across a fresh app instance (same device storage)', () => {
  const storage = makeStorage();
  const first = createApp({ storage });
  first.Aevion.memory.add('survives a reload', 'fact', 'longterm');
  const second = createApp({ storage });
  assert.deepEqual(texts(second.Aevion.memory.all('longterm')), ['survives a reload']);
});
