/* Tests for update.js — the Play-Store-style self-update layer.
 *
 * Covered here: manifest reading/validation, version comparison, the
 * checksum gate over raw bytes, and the consent/gating rules around
 * installApk(). The native half (UpdatePlugin.java) is compile-checked
 * by javac-check.ps1 and linted by tools/check.mjs; what a browser test
 * can honestly exercise is the web side of the chain.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, app, plain, makeFetch } from './harness.mjs';

/* A tiny well-formed manifest a test can tweak per case. */
const GOOD = {
  versionCode: 6006,
  versionName: '0.6.6',
  downloadUrl: 'https://aevion.app/downloads/Aevion-0.6.6.apk',
  fileSha256: 'ebe1704b09ac4e17588994c1dad1cf82c262f275b8f0c6d918706dfb7868657a',
  note: 'test build'
};

const manifestFetch = (manifest, status = 200) =>
  makeFetch([{ match: c => /update|manifest|\.json/.test(c.url), reply: { status, json: manifest } }]);

test('update: module is present with its whole API', () => {
  const { Aevion } = createApp();
  for (const fn of ['currentVersionName', 'currentVersionCode', 'isAndroid', 'readManifest',
    'latest', 'canCheck', 'checkForUpdate', 'sha256Hex', 'downloadApk', 'installApk',
    'initNative', 'report']) {
    assert.equal(typeof Aevion.update[fn], 'function', `Aevion.update.${fn} missing`);
  }
});

test('update: versionCode falls back to the major*1e6+minor*1e3+patch scheme', () => {
  const { Aevion } = createApp();
  assert.equal(Aevion.update.currentVersionCode(), 6 * 1000 + 6, '0.6.6 -> 6006');
  assert.equal(Aevion.update.currentVersionName(), Aevion.version);
});

test('update: a browser tab is not "Android" — it can never install', () => {
  const { Aevion } = createApp();
  // the harness has no Capacitor bridge at all
  assert.equal(Aevion.update.isAndroid(), false);
});

/* ---------- manifest reading and validation ---------- */

test('update: readManifest fetches the default URL and hands back the body', async () => {
  const fetch = manifestFetch(GOOD);
  const { Aevion } = app({}, { fetch });
  const m = await Aevion.update.readManifest();
  assert.equal(fetch.calls[0].url, 'https://raw.githubusercontent.com/vigneshs07092009-boop/Vignesh/main/downloads/update.json');
  assert.equal(m.versionCode, 6006);
});

test('update: readManifest honors a settings override for the URL', async () => {
  const fetch = manifestFetch(GOOD);
  const { Aevion } = app({ updateUrl: 'https://example.com/updates/aevion.json' }, { fetch });
  const m = await Aevion.update.readManifest();
  assert.equal(fetch.calls[0].url, 'https://example.com/updates/aevion.json');
  assert.equal(m.versionCode, 6006);
});

test('update: a server error is an error, never a silent "up to date"', async () => {
  const { Aevion } = app({}, { fetch: manifestFetch(GOOD, 503) });
  await assert.rejects(() => Aevion.update.readManifest(), /503/);
});

for (const [label, bad] of [
  ['missing versionCode', { ...GOOD, versionCode: undefined }],
  ['non-numeric versionCode', { ...GOOD, versionCode: '6006' }],
  ['negative versionCode', { ...GOOD, versionCode: -1 }],
  ['missing downloadUrl', { ...GOOD, downloadUrl: '' }],
  ['http (not https) downloadUrl', { ...GOOD, downloadUrl: 'http://aevion.app/A.apk' }],
  ['missing fileSha256', { ...GOOD, fileSha256: '' }],
  ['truncated fileSha256', { ...GOOD, fileSha256: 'ebe1704b' }]
]) {
  test(`update: manifest validation refuses ${label}`, async () => {
    const { Aevion } = app({}, { fetch: manifestFetch(bad) });
    await assert.rejects(() => Aevion.update.readManifest(), /update\.json|downloadUrl|fileSha256|versionCode/);
  });
}

/* ---------- version comparison ---------- */

test('update: same versionCode is not an update', async () => {
  const { Aevion } = app({}, { fetch: manifestFetch({ ...GOOD, versionCode: 6006 }) });
  const l = await Aevion.update.latest();
  assert.equal(l.isNewer, false);
  assert.equal(l.isSame, true);
  assert.equal(l.canInstall, false, 'same version is never an install offer');
});

test('update: a higher versionCode is newer; install needs Android too', async () => {
  const { Aevion } = app({}, { fetch: manifestFetch({ ...GOOD, versionCode: 6007 }) });
  const l = await Aevion.update.latest();
  assert.equal(l.isNewer, true);
  assert.equal(l.canInstall, false, 'no native bridge in the harness — reporting only');
  assert.equal(l.isOlder, false);
});

test('update: an older remote version is never offered', async () => {
  const { Aevion } = app({}, { fetch: manifestFetch({ ...GOOD, versionCode: 6005 }) });
  const l = await Aevion.update.latest();
  assert.equal(l.isOlder, true);
  assert.equal(l.isNewer, false);
  assert.equal(l.canInstall, false);
});

test('update: a newer manifest without a checksum is refused outright', async () => {
  const { Aevion } = app({}, { fetch: manifestFetch({ ...GOOD, versionCode: 6007, fileSha256: undefined }) });
  await assert.rejects(() => Aevion.update.readManifest(), /fileSha256/);
});

/* ---------- the check lifecycle ---------- */

test('update: checkForUpdate reports up-to-date and stamps lastChecked', async () => {
  const fetch = manifestFetch({ ...GOOD, versionCode: 6006 });
  const { Aevion } = app({}, { fetch });
  const r = await Aevion.update.checkForUpdate({ force: true });
  assert.equal(r.state, 'up-to-date');
  assert.ok(Aevion.settings.updateCheckedAt > 0, 'a completed check stamps the time');
  assert.equal(plain(Aevion.settings.updatePending), null, 'no stale pending after the server catches up');
});

test('update: checkForUpdate reports a newer build, stores it, and emits', async () => {
  const fetch = manifestFetch({ ...GOOD, versionCode: 6007, versionName: '0.6.7' });
  const { Aevion } = app({}, { fetch });
  const emitted = [];
  Aevion.on('update:new-version', d => emitted.push(d));
  const r = await Aevion.update.checkForUpdate({ force: true });
  assert.equal(r.state, 'newer-available');
  const pending = plain(Aevion.settings.updatePending);
  assert.equal(pending.versionCode, 6007);
  assert.equal(pending.versionName, '0.6.7');
  assert.equal(emitted.length, 1, 'the card listens for this event');
  assert.equal(emitted[0].remote.versionCode, 6007);
});

test('update: a failed check does not stamp lastChecked (no 6-hour lockout)', async () => {
  const { Aevion } = app({}, { fetch: manifestFetch(null, 500) });
  const r = await Aevion.update.checkForUpdate({ force: true });
  assert.equal(r.state, 'error');
  assert.ok(!Aevion.settings.updateCheckedAt, 'the failed check must not count as a check');
});

test('update: the rate limit allows a first check and blocks a second', async () => {
  const fetch = manifestFetch({ ...GOOD, versionCode: 6006 });
  const { Aevion } = app({}, { fetch });
  assert.equal(Aevion.update.canCheck(), true);
  await Aevion.update.checkForUpdate({ force: true });
  assert.equal(Aevion.update.canCheck(), false, 'just checked — auto-checks stop for 6 hours');
  const again = await Aevion.update.checkForUpdate({});
  assert.equal(again.state, 'rate-limited');
  assert.equal(fetch.calls.length, 1, 'a rate-limited check must not touch the network');
  const forced = await Aevion.update.checkForUpdate({ force: true });
  assert.equal(forced.state, 'up-to-date', 'the Settings button bypasses the limiter');
});

test('update: offline is reported honestly', async () => {
  const { Aevion } = app({}, {
    fetch: manifestFetch(GOOD),
    navigator: { onLine: false }
  });
  const r = await Aevion.update.checkForUpdate({ force: true });
  assert.equal(r.state, 'offline');
});

/* ---------- the checksum gate ---------- */

test('update: sha256Hex matches the sha256sum of the raw bytes', async () => {
  const { Aevion } = createApp();
  // known SHA-256 of the ASCII string "aevion"
  const bytes = new TextEncoder().encode('aevion');
  const hex = await Aevion.update.sha256Hex(bytes);
  assert.equal(hex, '91c8e077b2167d4b9ab49d8d4997c66abce4bf0b80e5e9871b6abbd430dae3ee');
});

test('update: downloadApk refuses on the web — a tab cannot install', async () => {
  const { Aevion } = createApp();
  await assert.rejects(() => Aevion.update.downloadApk(), /browser tab/);
});

/* ---------- the consent gate ---------- */

test('update: installApk on the web is refused as unavailable — whatever the consent', async () => {
  const { Aevion } = createApp();
  const r = await Aevion.update.installApk({ consent: true });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'unavailable');
});

test('update: installApk without consent never reaches the download', async () => {
  const fetch = manifestFetch(GOOD);
  const { Aevion } = app({}, { fetch, globals: fakeBridge().value });
  const noArg = await Aevion.update.installApk({});
  assert.equal(noArg.code, 'consent');
  const falseArg = await Aevion.update.installApk({ consent: false });
  assert.equal(falseArg.code, 'consent');
  assert.equal(fetch.calls.length, 0, 'nothing was fetched — refusal happens first');
});

/* A minimal Capacitor bridge fake: isNativePlatform + an Update plugin
   that records what it was handed and replies with what the test wants. */
function fakeBridge(installReply = { ok: true }) {
  const installs = [];
  const plugin = {
    meta: async () => ({ versionCode: 6007, versionName: '0.6.7' }),
    install: async args => { installs.push(args); return installReply; }
  };
  return { installs, value: { Capacitor: { isNativePlatform: () => true, Plugins: { Update: plugin } } } };
}

test('update: installApk with the gate off is refused before any download', async () => {
  const fetch = manifestFetch(GOOD);
  const { Aevion } = app({}, { fetch, globals: fakeBridge().value });
  // gate OFF + consent given: the evolve gate must still stop it
  const r = await Aevion.update.installApk({ consent: true });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'off');
  assert.equal(fetch.calls.length, 0, 'refusal happens before anything is fetched');
});

/* ---------- the full Android chain, with a fake XHR and bridge ---------- */

/* A fake XHR that "downloads" a fixed byte payload, so downloadApk()
   runs its real checksum path in the harness. */
function fakeXhr(payloadBytes, status = 200) {
  function XHR() {}
  XHR.prototype.open = function () {};
  XHR.prototype.send = function () {
    const buf = new ArrayBuffer(payloadBytes.length);
    new Uint8Array(buf).set(payloadBytes);
    this.response = buf;
    this.status = status;
    setTimeout(() => this.listeners.load(), 0);
  };
  XHR.prototype.addEventListener = function (type, fn) { this.listeners[type] = fn; };
  XHR.prototype.listeners = {};
  return XHR;
}

/* Deterministic 2 KB "APK" payloads — big enough to pass the 1 KB sanity
   gate, fixed so the digests never change between runs. */
function fakeApkBytes(fill) {
  const b = new Uint8Array(2048);
  b[0] = 0x50; b[1] = 0x4b; b[2] = 0x03; b[3] = 0x04;   // the ZIP magic
  for (let i = 4; i < b.length; i++) b[i] = (fill + i) & 0xff;
  return b;
}
const APK_BYTES = fakeApkBytes(7);
const APK_SHA = await crypto.subtle.digest('SHA-256', APK_BYTES).then(b =>
  [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join(''));
const TAMPERED_BYTES = fakeApkBytes(99);   // same size, different bytes

test('update: the full Android chain — download, verify, base64, hand over', async () => {
  const fetch = manifestFetch({ ...GOOD, fileSha256: APK_SHA });
  const bridge = fakeBridge({ ok: true });
  const { Aevion, sandbox } = app({}, { fetch, globals: bridge.value });
  sandbox.XMLHttpRequest = fakeXhr(APK_BYTES);   // the download happens inside the VM
  Aevion.update._nativeVersionCode = 6006;   // pretend initNative already ran
  await Aevion.evolve.set(true, { consent: true });
  Aevion.set(Aevion.update.pendingKey, {
    versionCode: 6007, versionName: '0.6.7',
    downloadUrl: 'https://aevion.app/downloads/Aevion-0.6.7.apk',
    fileSha256: APK_SHA, note: '', t: Date.now()
  });
  try {
    const r = await Aevion.update.installApk({ consent: true });
    assert.equal(r.ok, true, 'the happy path ends at the bridge');
    assert.equal(r.versionCode, 6007);
    assert.equal(bridge.installs.length, 1, 'the native side was called exactly once');
    const sent = bridge.installs[0];
    assert.equal(sent.expectedSha256, APK_SHA, 'Java gets the digest to re-verify');
    assert.ok(typeof sent.base64 === 'string' && sent.base64.length > 8, 'the bytes crossed as base64');
    assert.equal(Buffer.from(sent.base64, 'base64').toString(), Buffer.from(APK_BYTES).toString(), 'byte-for-byte the same file');
    assert.equal(plain(Aevion.settings.updatePending), null, 'a successful install clears the pending record');
  } catch (e) { assert.fail(e && e.message); }
});

test('update: a checksum mismatch anywhere in the chain refuses the install', async () => {
  const fetch = manifestFetch({ ...GOOD, fileSha256: APK_SHA });
  const bridge = fakeBridge({ ok: true });
  const { Aevion, sandbox } = app({}, { fetch, globals: bridge.value });
  sandbox.XMLHttpRequest = fakeXhr(TAMPERED_BYTES);   // right size, wrong bytes
  Aevion.update._nativeVersionCode = 6006;
  await Aevion.evolve.set(true, { consent: true });
  Aevion.set(Aevion.update.pendingKey, {
    versionCode: 6007, versionName: '0.6.7',
    downloadUrl: 'https://aevion.app/downloads/Aevion-0.6.7.apk',
    fileSha256: APK_SHA, note: '', t: Date.now()
  });
  const r = await Aevion.update.installApk({ consent: true });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'download');
  assert.match(r.reason, /checksum/i);
  assert.equal(bridge.installs.length, 0, 'nothing reached Java');
});

test('update: initNative caches the bridge version when present', async () => {
  const bridge = fakeBridge();
  const { Aevion } = app({}, { globals: bridge.value });
  await Aevion.update.initNative();
  assert.equal(Aevion.update.currentVersionCode(), 6007, 'the bridge number wins over the derived one');
  const r = Aevion.update.report();
  assert.equal(r.currentVersionName, '0.6.7', 'report() surfaces the native versionName');
});

test('update: initNative is a no-op without a bridge', async () => {
  const { Aevion } = createApp();
  await Aevion.update.initNative();
  assert.equal(Aevion.update.currentVersionCode(), 6006, 'the derived number keeps answering');
});

/* ---------- the report ---------- */

test('update: report tells the boot sequence the truth', async () => {
  const { Aevion } = createApp();
  const r = Aevion.update.report();
  assert.equal(r.isAndroid, false);
  assert.equal(r.currentVersionName, Aevion.version);
  assert.equal(r.pending, null);
  assert.equal(typeof r.canCheck, 'boolean');
  assert.ok(r.updateUrl.includes('downloads/update.json'));
});

test('update: deferUntil windows open and expire', async () => {
  const { Aevion } = createApp();
  assert.equal(Aevion.update.isDeferred(), false);
  Aevion.update.deferUntil(50);
  assert.equal(Aevion.update.isDeferred(), true);
  await new Promise(res => setTimeout(res, 60));
  assert.equal(Aevion.update.isDeferred(), false, 'an expired window is cleared, not remembered');
});

test('update: deferUntil rejects nonsense windows', () => {
  const { Aevion } = createApp();
  assert.throws(() => Aevion.update.deferUntil(0));
  assert.throws(() => Aevion.update.deferUntil(-5));
  assert.throws(() => Aevion.update.deferUntil('soon'));
});
