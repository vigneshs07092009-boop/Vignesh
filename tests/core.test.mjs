/* Tests for core.js — storage, event bus, permissions, memory, crypto, identity. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createApp, plain, makeStorage, ROOT } from './harness.mjs';

test('store: round-trips values and returns defaults', () => {
  const { Aevion } = createApp();
  assert.equal(Aevion.store.get('nope', 'dflt'), 'dflt');
  Aevion.store.set('thing', { a: [1, 2], b: 'x' });
  assert.deepEqual(plain(Aevion.store.get('thing')), { a: [1, 2], b: 'x' });
  assert.equal(Aevion.store.keys().includes('thing'), true);
});

test('store: a corrupt value never throws, it degrades to the default', () => {
  const { Aevion, storage } = createApp();
  storage.setItem('aevion:broken', '{not json');
  assert.equal(Aevion.store.get('broken', 'safe'), 'safe');
});

test('store: a full disk does not crash the app', () => {
  const storage = makeStorage({ quota: 20000 });
  const { Aevion } = createApp({ storage });
  const big = 'x'.repeat(2000);
  let hits = 0;
  for (let i = 0; i < 40; i++) {
    try { Aevion.store.set('f' + i, big); } catch { hits++; }
    Aevion.store.set('f' + i, big);   // must never throw out of the store
  }
  assert.ok(storage.bytes > 0, 'some of it did get written');
  assert.doesNotThrow(() => Aevion.store.set('final', 'y'));
  void hits;
});

test('store: dump/load move every aevion key', () => {
  const { Aevion } = createApp();
  Aevion.store.set('tasks', [{ label: 'a' }]);
  Aevion.store.set('notes', [{ label: 'b' }]);
  const dump = Aevion.store.dump();
  assert.ok(dump.tasks && dump.notes);
  const { Aevion: other } = createApp();
  other.store.load(dump);
  assert.deepEqual(plain(other.store.get('tasks')), [{ label: 'a' }]);
});

test('store: only aevion-prefixed keys are exposed', () => {
  const { Aevion, storage } = createApp();
  storage.setItem('someone-elses-key', '1');
  Aevion.store.set('mine', '2');
  assert.equal(Aevion.store.keys().includes('someone-elses-key'), false);
  assert.equal(plain(Aevion.store.dump()).mine, '2');
});

test('event bus: handlers receive the payload itself, not the event wrapper', () => {
  const { Aevion } = createApp();
  const seen = [];
  Aevion.on('demo', payload => seen.push(payload));
  Aevion.emit('demo', { text: 'hello', isFinal: true });
  Aevion.emit('demo');
  assert.deepEqual(seen[0], { text: 'hello', isFinal: true });
  assert.equal(seen[1], undefined);
});

test('event bus: multiple listeners all fire, in order', () => {
  const { Aevion } = createApp();
  const order = [];
  Aevion.on('x', () => order.push(1));
  Aevion.on('x', () => order.push(2));
  Aevion.emit('x');
  assert.deepEqual(order, [1, 2]);
});

test('hash: SHA-256 of a known vector', async () => {
  const { Aevion } = createApp();
  assert.equal(
    await Aevion.hash('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  );
});

test('hash: PINs are never stored in plaintext', async () => {
  const { Aevion } = createApp();
  const digest = await Aevion.hash('4821');
  Aevion.set('pinHash', digest);
  const raw = JSON.stringify(Aevion.store.get('settings'));
  assert.equal(raw.includes('"4821"'), false);
  assert.equal(raw.includes(digest), true);
});

test('randomId: unique and URL-safe', () => {
  const { Aevion } = createApp();
  const ids = new Set(Array.from({ length: 50 }, () => Aevion.randomId()));
  assert.equal(ids.size, 50);
  for (const id of ids) assert.match(id, /^[a-z0-9]+$/);
});

test('perms: granting a real browser permission persists and flips status', async () => {
  const { Aevion } = createApp({
    navigator: { clipboard: { writeText: async () => {} } }
  });
  assert.equal(await Aevion.perms.request('clipboardWrite'), 'granted');
  assert.equal(Aevion.perms.status('clipboardWrite'), 'granted');
  assert.equal(plain(Aevion.store.get('settings')).perms.clipboardWrite, true);
});

test('perms: a denied request records false, not true', async () => {
  const { Aevion } = createApp({
    navigator: { mediaDevices: { getUserMedia: async () => { throw new Error('nope'); } } }
  });
  assert.equal(await Aevion.perms.request('camera'), 'denied');
  assert.equal(Aevion.perms.get('camera'), false);
  assert.equal(Aevion.perms.status('camera'), 'off');
});

test('perms: revoke turns a permission off and announces it', () => {
  const { Aevion } = createApp({ settings: { perms: { geolocation: true } } });
  let event = null;
  Aevion.on('perm:changed', e => { event = e; });
  Aevion.perms.revoke('geolocation');
  assert.equal(Aevion.perms.get('geolocation'), false);
  assert.deepEqual(plain(event), { key: 'geolocation', granted: false });
});

test('perms: unknown permission is reported, not silently granted', async () => {
  const { Aevion } = createApp();
  assert.equal(await Aevion.perms.request('teleport'), 'unknown');
  assert.equal(Aevion.perms.status('teleport'), 'unknown');
});

test('perms: OS-only capabilities are tracked locally, never bypassed', async () => {
  const { Aevion } = createApp();
  // automation/contacts/calendar have no browser API to call. They resolve to
  // the "browser" tier: tracked locally by Aevion, never an OS bypass.
  assert.equal(Aevion.perms.map.automation.req(), 'browser');
  assert.equal(Aevion.perms.map.contacts_read.req(), 'browser');
  assert.equal(await Aevion.perms.request('automation'), 'granted');
});

test('memory: adds, dedupes case-insensitively, finds and removes', () => {
  const { Aevion } = createApp();
  assert.equal(Aevion.memory.add('I like coffee'), 'I like coffee');
  assert.equal(Aevion.memory.add('i LIKE coffee'), null, 'duplicate must be rejected');
  assert.equal(Aevion.memory.add('   '), null, 'blank must be rejected');
  Aevion.memory.add('I use Kotlin', 'profile');
  assert.equal(Aevion.memory.all().length, 2);
  assert.equal(Aevion.memory.find('kotlin').length, 1);
  const id = Aevion.memory.all()[0].id;
  Aevion.memory.remove(id);
  assert.equal(Aevion.memory.all().length, 1);
  Aevion.memory.clear();
  assert.deepEqual(plain(Aevion.memory.all()), []);
});

test('memory: storage is capped so it cannot grow without bound', () => {
  const { Aevion } = createApp();
  for (let i = 0; i < 520; i++) Aevion.memory.add('fact number ' + i);
  assert.equal(Aevion.memory.all().length, 500);
});

test('identity: stable across calls, persisted, and local-only', () => {
  const { Aevion } = createApp();
  const id = Aevion.identity.id();
  assert.equal(Aevion.identity.id(), id);
  assert.ok(Aevion.store.get('deviceId'));
  assert.equal(Aevion.identity.label(), 'TestOS');
});

test('version: ships the version package.json declares', () => {
  const { Aevion } = createApp();
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(Aevion.version, pkg.version);
  assert.ok(existsSync(path.join(ROOT, 'aevion', 'index.html')));
});
