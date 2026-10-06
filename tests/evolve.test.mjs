/* Tests for js/evolve.js — self-upgrade and the daily learning pass.

   The self-upgrade tests are the security-shaped ones. The promise is
   "it cannot change that switch without permission", and the way that is
   kept is that a stored record without a valid consent hash is inert: an
   edited localStorage entry, or a flip from any code path that did not
   have the user's yes, does not turn it on. Code packs are refused
   outright, because a web app rewriting its own source is not a thing
   that can be done honestly.

   The learning tests pin the other promise: Aevion may *notice* things
   about you, and noticing is all it may do until you approve them. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, plain } from './harness.mjs';

const app = (settings, opts) => createApp({ settings, ...opts });

test('self-upgrade starts off, and off is the default in settings too', () => {
  const A = app().Aevion;
  assert.equal(A.evolve.on(), false);
  assert.equal(A.evolve.enabled(), false);
  assert.equal(A.evolve.record(), null);
  assert.deepEqual(plain(A.evolve.plan().refused), ['code']);
});

test('it cannot be switched on without an explicit yes', async () => {
  const A = app().Aevion;
  const refused = await A.evolve.set(true);
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'consent');
  assert.equal(A.evolve.on(), false, 'still off');
  assert.equal(A.settings.selfUpgrade, undefined, 'and it did not sneak into settings instead');
});

test('a record written by hand is inert without the consent hash', async () => {
  const first = app();
  await first.Aevion.evolve.set(true, { consent: true });
  const stored = first.storage.getItem('aevion:selfUpgrade');
  assert.ok(stored && JSON.parse(stored).consent, 'the real record carries a hash');

  /* Now do what an edited storage entry looks like: flag on, no hash. */
  const forged = createApp({ storage: first.storage });
  forged.Aevion.store.set('selfUpgrade', { on: true });
  assert.equal(forged.Aevion.evolve.on(), false, 'the flag alone is not consent');
  forged.Aevion.store.set('selfUpgrade', { on: true, at: 1, consent: 'nope' });
  assert.equal(await forged.Aevion.evolve.verify(), false, 'and a made-up hash does not verify');
});

test('turning it off never needs consent — safety is always allowed', async () => {
  const A = app().Aevion;
  assert.equal((await A.evolve.set(true, { consent: true })).ok, true);
  assert.equal(A.evolve.on(), true);
  const off = await A.evolve.set(false);
  assert.equal(off.ok, true);
  assert.equal(A.evolve.on(), false);
});

test('installing a pack needs the switch on, a fresh yes, and a known kind', async () => {
  const A = app().Aevion;
  /* A word that is genuinely not in the shipped Kannada table, so this is
     a gap being filled rather than a keyword that already matched. */
  const pack = { kind: 'words', lang: 'kn', intent: 'timer', words: ['ಗಡಿಯಾರ ಗುರುತು ಹಾಕು'] };

  assert.equal((await A.evolve.apply(pack, { consent: true })).code, 'off', 'nothing installs while it is off');

  await A.evolve.set(true, { consent: true });
  assert.equal((await A.evolve.apply(pack)).code, 'consent', 'each install still needs its own approval');
  assert.equal((await A.evolve.apply(null, { consent: true })).code, 'shape');
  assert.equal((await A.evolve.apply({ kind: 'surprise' }, { consent: true })).code, 'kind');
  assert.equal(A.nlu.route('ಗಡಿಯಾರ ಗುರುತು ಹಾಕು'), null, 'and a refused pack changed nothing');
});

test('code packs are refused, with the reason a person can act on', async () => {
  const A = app().Aevion;
  await A.evolve.set(true, { consent: true });
  const r = await A.evolve.apply({ kind: 'code', source: 'alert(1)' }, { consent: true });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'code');
  assert.match(r.reason, /never installs code into itself/);
  assert.match(r.reason, /Update the files/);
});

test('a words pack teaches the offline brain, and is written down', async () => {
  const A = app().Aevion;
  await A.evolve.set(true, { consent: true });
  const r = await A.evolve.apply({ kind: 'words', lang: 'kn', intent: 'timer', words: ['ಗಡಿಯಾರ ಗುರುತು ಹಾಕು'] }, { consent: true });
  assert.equal(r.ok, true);
  assert.match(r.summary, /\+ 1 timer word\(s\) for kn/);
  assert.equal(A.nlu.route('ಗಡಿಯಾರ ಗುರುತು ಹಾಕು').kind, 'timer');
  const log = plain(A.evolve.history());
  assert.equal(log[0].kind, 'words');
  assert.equal(log[log.length - 1].kind, 'gate', 'switching it on is logged too');
});

test('a plugin pack installs a no-code plugin; a facts pack only proposes', async () => {
  const A = app().Aevion;
  await A.evolve.set(true, { consent: true });

  const p = await A.evolve.apply({ kind: 'plugin', spec: { name: 'Standup', triggers: ['standup'], reply: 'At 10:15. {query}' } }, { consent: true });
  assert.equal(p.ok, true);
  assert.equal(typeof A.plugins.commands.standup, 'function');
  assert.equal(await A.plugins.commands.standup('standup yoga'), '🧩 At 10:15. yoga');

  const f = await A.evolve.apply({ kind: 'facts', facts: ['My exam is on Friday.'] }, { consent: true });
  assert.equal(f.ok, true);
  assert.equal(A.memory.all('longterm').length, 0, 'facts are never saved straight to memory');
  const pending = plain(A.memory.pending());
  assert.equal(pending.length, 1);
  assert.equal(pending[0].approved, false, 'they wait for the user');
});

/* ---------- learning a little every day ---------- */

test('it mines the day\'s conversation, narrowly and without inventing', () => {
  const A = app().Aevion;
  assert.deepEqual(plain(A.evolve.mine('my exam is on Friday')), ['My exam is on Friday.']);
  assert.deepEqual(plain(A.evolve.mine('I prefer dark mode')), ['User: I prefer dark mode.']);
  assert.deepEqual(plain(A.evolve.mine('remember: the keys are in the drawer')), ['To remember: the keys are in the drawer.']);
  assert.deepEqual(plain(A.evolve.mine('call me Vignesh')), ["User's name is Vignesh."]);
  assert.deepEqual(plain(A.evolve.mine('what is the weather')), [], 'a question is not a fact');
  assert.deepEqual(plain(A.evolve.mine('')), []);
});

test('a day\'s learning files candidates and never approves them', () => {
  const A = app({ memory: true }).Aevion;
  A.store.set('chatHistory', [
    { role: 'user', text: 'my exam is on Friday', t: Date.now() },
    { role: 'ai', text: 'Noted.', t: Date.now() },
    { role: 'user', text: 'I prefer dark mode', t: Date.now() }
  ]);
  assert.equal(A.evolve.due(), true);
  const first = A.evolve.learn();
  assert.equal(first.ran, true);
  assert.equal(first.noticed.length, 2);
  assert.equal(first.proposed, 2);
  assert.equal(A.memory.all('longterm').length, 0, 'nothing is remembered yet');
  assert.equal(A.memory.pending().length, 2, 'they are waiting for approval');
  assert.equal(A.evolve.due(), false, 'and it will not run again today');
  const again = A.evolve.learn();
  assert.equal(again.ran, false);
  assert.equal(again.reason, 'Already learned today.');
  assert.equal(A.evolve.learn({ force: true }).ran, true, 'unless asked to');
});

test('it does not propose what memory already knows, and it reports refusals', () => {
  const A = app({ memory: true }).Aevion;
  A.memory.add('My exam is on Friday.', 'fact', 'longterm');
  A.store.set('chatHistory', [{ role: 'user', text: 'my exam is on Friday', t: Date.now() }]);
  A.tools.audit('device.notify', false, 'permission');
  const r = A.evolve.learn();
  assert.equal(r.noticed.length, 0, 'already known');
  assert.deepEqual(plain(r.refused), ['device.notify (permission)'], 'what kept being refused is reported');
  const digest = plain(A.evolve.digest());
  assert.equal(digest.length, 1);
  assert.equal(digest[0].day, A.evolve.day());
  A.evolve.forgetDigest();
  assert.deepEqual(plain(A.evolve.digest()), []);
});

test('the day\'s digest is per day, newest first', () => {
  const A = app({ memory: true }).Aevion;
  A.store.set('learnLog', [{ day: '2020-01-01', noticed: [] }]);
  A.store.set('chatHistory', [{ role: 'user', text: 'my bus is at 8', t: Date.now() }]);
  A.evolve.learn();
  const days = plain(A.evolve.digest()).map(d => d.day);
  assert.equal(days[0], A.evolve.day());
  assert.ok(days.includes('2020-01-01'));
});
