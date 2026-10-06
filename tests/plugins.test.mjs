/* Tests for js/plugins.js — file plugins and the no-code ones.

   A simple plugin is data: a trigger, a reply, and placeholders. That is
   the whole reason it is safe to make adding one a two-field form, so the
   tests check both that it works and that a template cannot become more
   than a template. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, plain, modulesFromIndex } from './harness.mjs';

const app = (settings) => createApp({ settings });
/* The harness loads everything index.html loads except the DOM-only files,
   which includes the sample plugin — so ask for it explicitly here. */
const withSample = (settings, storage) => createApp({
  settings,
  storage,
  modules: [...modulesFromIndex(), 'js/plugins/hello-world.js']
});

test('a file plugin registers its commands, and re-registering replaces it', () => {
  const A = app().Aevion;
  A.plugins.register({ name: 'Demo', desc: 'test', commands: { '/hello': async () => 'hi' } });
  assert.equal(typeof A.plugins.commands['/hello'], 'function');
  assert.equal(A.plugins.list.length, 1);
  A.plugins.register({ name: 'Demo', desc: 'changed', commands: { '/hello': async () => 'hi again' } });
  assert.equal(A.plugins.list.length, 1, 'the same name is the same plugin');
  assert.equal(A.plugins.list[0].desc, 'changed');
});

test('the bundled sample plugin is loaded and usable', async () => {
  const A = withSample().Aevion;
  assert.ok(A.plugins.list.some(p => p.name === 'Hello World'));
  assert.match(await A.plugins.commands['/hello'](), /Hello from a plugin/);
  assert.ok(A.plugins.commands['/fortune'], 'and so is its second command');
});

test('a simple plugin needs a name, a trigger and a reply', () => {
  const A = app().Aevion;
  assert.match(A.plugins.addSimple({}).error, /needs a name/);
  assert.match(A.plugins.addSimple({ name: 'X' }).error, /trigger/);
  assert.match(A.plugins.addSimple({ name: 'X', triggers: ['x'] }).error, /reply/);
  assert.match(A.plugins.addSimple({ name: 'X', triggers: ['x'], reply: 'y'.repeat(700) }).error, /under 600/);
  assert.deepEqual(plain(A.plugins.saved()), [], 'a refused plugin is not stored');
});

test('a saved plugin answers immediately, with the placeholders filled', async () => {
  const A = app({ name: 'Aevion', lang: 'kn' }).Aevion;
  A.plugins.addSimple({
    name: 'Standup',
    desc: 'daily',
    triggers: ['standup', 'daily'],
    reply: 'At 10:15, {name}. Yesterday: {query}. Language: {lang}'
  });
  const out = await A.plugins.commands.standup('standup fixed the login bug');
  assert.equal(out, '🧩 At 10:15, Aevion. Yesterday: fixed the login bug. Language: Kannada');
  const alias = await A.plugins.commands.daily('daily wrote tests');
  assert.match(alias, /wrote tests/, 'every trigger reaches the same reply');
  assert.match(await A.plugins.commands.standup('standup'), /Yesterday: \. Language:/, 'an empty query is just empty');
});

test('a template cannot reach the network or run code — it is only text', async () => {
  const A = app().Aevion;
  A.plugins.addSimple({ name: 'Echo', triggers: ['echo'], reply: '{query}' });
  const out = await A.plugins.commands.echo('echo <script>fetch("http://x")</script>');
  assert.equal(out, '🧩 <script>fetch("http://x")</script>', 'it comes back as text for the renderer to treat as text');
  assert.equal(typeof out, 'string');
});

test('plugins are stored on the device and can be deleted', () => {
  const first = app();
  first.Aevion.plugins.addSimple({ name: 'Keep me', triggers: ['km'], reply: 'here' });
  const second = createApp({ storage: first.storage });
  assert.ok(second.Aevion.plugins.saved().some(p => p.name === 'Keep me'), 'it survived the reload');
  assert.equal(second.Aevion.plugins.remove('Keep me'), true);
  assert.equal(second.Aevion.plugins.remove('Keep me'), false, 'removing it twice is not an error');
  assert.equal(typeof second.Aevion.plugins.commands.km, 'undefined', 'and the command is gone');
});

test('describe() reports both kinds and counts them', () => {
  const A = withSample().Aevion;
  A.plugins.addSimple({ name: 'Mine', triggers: ['mine'], reply: 'ok' });
  const described = plain(A.plugins.describe());
  const mine = described.find(p => p.name === 'Mine');
  const sample = described.find(p => p.name === 'Hello World');
  assert.equal(mine.kind, 'simple');
  assert.deepEqual(mine.triggers, ['mine']);
  assert.equal(sample.kind, 'file');
  assert.ok(sample.commands.includes('/hello'));
  assert.equal(A.plugins.count(), 2);
});

test('a trigger two plugins both claim is reported instead of silently losing', () => {
  const A = app().Aevion;
  A.plugins.addSimple({ name: 'One', triggers: ['go'], reply: 'first' });
  A.plugins.register({ name: 'Two', desc: '', commands: { go: async () => 'second' } });
  const collisions = plain(A.plugins.collisions());
  assert.equal(collisions.length, 1);
  assert.equal(collisions[0].trigger, 'go');
  assert.deepEqual(collisions[0].owners, ['One', 'Two']);
});

/* ---------- the optional AI pass ----------
   A plugin may ask a brain for a better answer, but the template is
   never thrown away: it is the instruction *and* the fallback, so an
   AI-backed plugin cannot become a plugin that fails. */

test('a plugin can ask an AI for a better answer, and says so in the list', async () => {
  const A = app({ aiProvider: 'mock' }).Aevion;
  const saved = A.plugins.addSimple({ name: 'Coach', triggers: ['coach'], reply: 'Do this: {query}', ai: true });
  assert.equal(saved.ai, 'auto');
  assert.equal(plain(A.plugins.describe()).find(p => p.name === 'Coach').ai, 'auto');

  const out = await A.plugins.commands.coach('coach how do I start');
  assert.match(out, /^🧠 \[offline test provider\]/, 'the brain answered, not the template');
  assert.match(out, /You said: "how do I start"/, 'it was given the words after the trigger');
});

test('with no brain available the template answers instead of an error', async () => {
  // the online switch is off: a cloud brain may not be used at all
  const off = app({ aiProvider: 'openai', onlineAI: false }).Aevion;
  off.plugins.addSimple({ name: 'Coach', triggers: ['coach'], reply: 'Do this: {query}', ai: true });
  assert.equal(await off.plugins.commands.coach('coach hi'), '🧩 Do this: hi');

  // a missing key is the same story, with no exception escaping
  const noKey = app({ aiProvider: 'openai', onlineAI: true }).Aevion;
  noKey.plugins.addSimple({ name: 'Coach', triggers: ['coach'], reply: 'Do this: {query}', ai: true });
  assert.equal(await noKey.plugins.commands.coach('coach hi'), '🧩 Do this: hi');

  // and with no ai flag at all nothing changes
  const plain1 = app({ aiProvider: 'mock' }).Aevion;
  plain1.plugins.addSimple({ name: 'Coach', triggers: ['coach'], reply: 'Do this: {query}' });
  assert.equal(await plain1.plugins.commands.coach('coach hi'), '🧩 Do this: hi');
});

test('the reachability gate applies to online brains, never to on-device ones', async () => {
  const offNet = createApp({
    settings: { aiProvider: 'openai', onlineAI: true, autoAI: true },
    navigator: { onLine: false }
  }).Aevion;
  offNet.plugins.addSimple({ name: 'Coach', triggers: ['coach'], reply: 'Do this: {query}', ai: true });
  assert.equal(await offNet.plugins.commands.coach('coach hi'), '🧩 Do this: hi', 'no internet → no cloud brain');

  const localBrain = createApp({
    settings: { aiProvider: 'mock' },
    navigator: { onLine: false }
  }).Aevion;
  localBrain.plugins.addSimple({ name: 'Coach', triggers: ['coach'], reply: 'Do this: {query}', ai: true });
  assert.match(await localBrain.plugins.commands.coach('coach hi'), /^🧠 \[offline test provider\]/,
    'an on-device brain still answers with the network away');
});

test('the brain choice is a whitelist, and no flag means no AI', () => {
  const A = app({ aiProvider: 'mock' }).Aevion;
  assert.equal(A.plugins.addSimple({ name: 'A', triggers: ['a'], reply: 'x', ai: 'not-a-provider' }).ai, 'auto',
    'a name the app does not know falls back to the configured brain');
  assert.equal(A.plugins.addSimple({ name: 'B', triggers: ['b'], reply: 'x', ai: 'mock' }).ai, 'mock',
    'a provider it does know may be named');
  assert.equal(A.plugins.addSimple({ name: 'C', triggers: ['c'], reply: 'x', ai: '' }).ai, undefined,
    'and an empty choice stores nothing at all');
});

test('a reply is still required when the AI is doing the answering', () => {
  const A = app().Aevion;
  assert.match(A.plugins.addSimple({ name: 'X', triggers: ['x'], ai: true }).error, /reply/);
});
