/* Tests for core.js `secrets` — where API keys live.
   The security claims here are the ones the docs make, so they are
   asserted rather than assumed. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, makeStorage, plain } from './harness.mjs';

const raw = storage => Object.keys(storage).map(k => String(storage.getItem(k))).join('|');

test('plaintext mode: round-trips a key and admits it is not encrypted', async () => {
  const { Aevion } = createApp();
  await Aevion.secrets.init();
  await Aevion.secrets.put('aiKey:openai', 'sk-abc');
  assert.equal(Aevion.secrets.get('aiKey:openai'), 'sk-abc');
  assert.equal(Aevion.secrets.isEncrypted(), false);
  assert.equal(Aevion.secrets.isLocked(), false);
  assert.equal(Aevion.secrets.has('aiKey:openai'), true);
});

test('plaintext mode: the stored blob is flagged as unencrypted, not faked', async () => {
  const { Aevion } = createApp();
  await Aevion.secrets.init();
  await Aevion.secrets.put('aiKey:openai', 'sk-abc');
  const blob = plain(Aevion.store.get('secrets'));
  assert.equal(blob.e, 0, 'e=0 tells the UI to warn the user honestly');
  assert.equal(blob.items['aiKey:openai'], 'sk-abc');
});

test('encrypted mode: nothing readable is written to storage', async () => {
  const { Aevion, storage } = createApp();
  await Aevion.secrets.init();
  await Aevion.secrets.enable('4821');
  await Aevion.secrets.put('aiKey:anthropic', 'sk-ant-super-secret-value');
  assert.equal(Aevion.secrets.isEncrypted(), true);
  assert.equal(raw(storage).includes('sk-ant-super-secret-value'), false, 'the plaintext key must not appear anywhere in storage');
  assert.equal(raw(storage).includes('4821'), false, 'and neither must the PIN');
  assert.equal(Aevion.secrets.get('aiKey:anthropic'), 'sk-ant-super-secret-value', 'but it is readable in memory while unlocked');
});

test('encrypted mode: ciphertext differs between two writes of the same value', async () => {
  const { Aevion } = createApp();
  await Aevion.secrets.init();
  await Aevion.secrets.enable('9999');
  await Aevion.secrets.put('k', 'same-value');
  const first = JSON.stringify(Aevion.store.get('secrets').items.k);
  await Aevion.secrets.put('k', 'same-value');
  const second = JSON.stringify(Aevion.store.get('secrets').items.k);
  assert.notEqual(first, second, 'a fresh IV per write means identical keys do not produce identical ciphertext');
});

test('a fresh session starts locked and needs the PIN to read keys', async () => {
  const storage = makeStorage();
  const first = createApp({ storage });
  await first.Aevion.secrets.init();
  await first.Aevion.secrets.enable('1357');
  await first.Aevion.secrets.put('aiKey:openai', 'sk-vaulted');

  const second = createApp({ storage });
  assert.equal(await second.Aevion.secrets.init(), 'locked');
  assert.equal(second.Aevion.secrets.isLocked(), true);
  assert.equal(second.Aevion.secrets.get('aiKey:openai'), '', 'locked means unreadable, not merely hidden');
  assert.equal(second.Aevion.secrets.names().length, 0);
});

test('the correct PIN decrypts; a wrong PIN cannot', async () => {
  const storage = makeStorage();
  const first = createApp({ storage });
  await first.Aevion.secrets.init();
  await first.Aevion.secrets.enable('1357');
  await first.Aevion.secrets.put('aiKey:openai', 'sk-vaulted');

  const wrong = createApp({ storage });
  await wrong.Aevion.secrets.init();
  await assert.rejects(() => wrong.Aevion.secrets.unlock('0000'));
  assert.equal(wrong.Aevion.secrets.get('aiKey:openai'), '');

  const right = createApp({ storage });
  await right.Aevion.secrets.init();
  assert.equal(await right.Aevion.secrets.unlock('1357'), 1);
  assert.equal(right.Aevion.secrets.get('aiKey:openai'), 'sk-vaulted');
});

test('locking again clears the in-memory copy', async () => {
  const { Aevion } = createApp();
  await Aevion.secrets.init();
  await Aevion.secrets.enable('2468');
  await Aevion.secrets.put('k', 'v');
  Aevion.secrets.lock();
  assert.equal(Aevion.secrets.isLocked(), true);
  assert.equal(Aevion.secrets.get('k'), '');
});

test('disabling encryption returns to plaintext on purpose', async () => {
  const { Aevion } = createApp();
  await Aevion.secrets.init();
  await Aevion.secrets.enable('1111');
  await Aevion.secrets.put('k', 'v');
  await Aevion.secrets.disable();
  assert.equal(Aevion.secrets.isEncrypted(), false);
  assert.equal(plain(Aevion.store.get('secrets')).items.k, 'v');
  assert.equal(Aevion.secrets.get('k'), 'v');
});

test('deleting a secret removes it from storage too', async () => {
  const { Aevion } = createApp();
  await Aevion.secrets.init();
  await Aevion.secrets.put('aiKey:openai', 'sk-abc');
  await Aevion.secrets.put('aiKey:openai', '');
  assert.equal(Aevion.secrets.get('aiKey:openai'), '');
  assert.equal(plain(Aevion.store.get('secrets')).items['aiKey:openai'], undefined);
});

/* ---------- backups ---------- */

test('backups never contain credentials', async () => {
  const { Aevion } = createApp();
  await Aevion.secrets.init();
  await Aevion.secrets.put('aiKey:openai', 'sk-abc');
  Aevion.store.set('aiKey:legacy', 'sk-legacy');
  Aevion.store.set('tasks', [{ label: 'keep me' }]);

  const safe = Aevion.store.dumpSafe();
  const json = JSON.stringify(safe);
  assert.equal(json.includes('sk-abc'), false);
  assert.equal(json.includes('sk-legacy'), false);
  assert.equal('secrets' in safe, false);
  assert.equal(json.includes('keep me'), true, 'a backup must still contain the real data');
});

test('an explicit full dump still can read everything local (for wipe/reset paths)', async () => {
  const { Aevion } = createApp();
  await Aevion.secrets.init();
  await Aevion.secrets.put('aiKey:openai', 'sk-abc');
  assert.equal(JSON.stringify(Aevion.store.dump()).includes('sk-abc'), true);
});

test('a provider reads its key from the vault, never from settings', async () => {
  const storage = makeStorage();
  const first = createApp({ storage, settings: { aiProvider: 'openai', onlineAI: true } });
  await first.Aevion.secrets.init();
  await first.Aevion.secrets.enable('4242');
  first.Aevion.providers.setKey('openai', 'sk-from-vault');
  assert.equal(JSON.stringify(first.Aevion.store.get('settings')).includes('sk-from-vault'), false);
  assert.equal(JSON.stringify(first.Aevion.store.get('aiCfg') || {}).includes('sk-from-vault'), false);

  // a locked session cannot use the key, and says why instead of failing oddly
  const locked = createApp({ storage, settings: { aiProvider: 'openai', onlineAI: true } });
  await locked.Aevion.secrets.init();
  assert.deepEqual(plain(locked.Aevion.providers.missing('openai')), ['API key']);
});
