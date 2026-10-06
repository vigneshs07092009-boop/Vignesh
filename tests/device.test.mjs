/* Tests for device access — the "let Aevion use this device" switch.
   The point of this file is the security property, not the happy path:
   granting everything must still leave every irreversible action behind its
   own confirmation, and a device that cannot do something must never be
   reported as if it could. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, plain } from './harness.mjs';

/* ---------- fake device ---------- */

function fakeNotification() {
  const shown = [];
  class FakeNotification {
    constructor(title, opts) { this.title = title; this.body = opts && opts.body; this.closed = false; shown.push(this); }
    close() { this.closed = true; }
  }
  FakeNotification.requestPermission = async () => 'granted';
  FakeNotification.shown = shown;
  return FakeNotification;
}

function deviceGlobals({ geolocate = true, media = 'granted', notify = true } = {}) {
  const notifications = notify ? fakeNotification() : undefined;
  const pos = { coords: { latitude: 12.9716, longitude: 77.5946, accuracy: 12 } };
  return {
    globals: notifications ? { Notification: notifications } : {},
    navigator: {
      clipboard: { writeText: async () => {} },
      mediaDevices: {
        getUserMedia: async () => {
          if (media === 'granted') return { getTracks: () => [{ stop() {} }] };
          throw new Error('NotAllowedError');
        }
      },
      geolocation: geolocate
        ? { getCurrentPosition: ok => ok(pos) }
        : { getCurrentPosition: (_ok, fail) => fail(new Error('denied')) }
    },
    notifications
  };
}

function deviceApp(settings = {}, device = {}) {
  const d = deviceGlobals(device);
  const app = createApp({
    settings: { perms: { microphone: false }, ...settings },
    globals: d.globals,
    navigator: d.navigator
  });
  const events = [];
  ['perm:changed', 'perms:revokedAll'].forEach(n => app.Aevion.on(n, x => events.push({ n, x })));
  return { Aevion: app.Aevion, events, notifications: d.notifications };
}

/* ---------- the table of capabilities ---------- */

test('a capability is either askable here or only in the app, never both, never neither', () => {
  const { Aevion } = deviceApp();
  const all = Object.keys(Aevion.perms.map);
  const device = Aevion.perms.DEVICE;
  const shell = Aevion.perms.SHELL_ONLY;
  for (const k of device) assert.ok(all.includes(k), `${k} is not a known permission`);
  for (const k of shell) assert.ok(all.includes(k), `${k} is not a known permission`);
  assert.equal(device.filter(k => shell.includes(k)).length, 0, 'no capability can be in both lists');
  assert.deepEqual(all.filter(k => !device.includes(k) && !shell.includes(k)), [], 'every permission is classified');
});

test('nothing is allowed until the user says so', () => {
  const { Aevion } = deviceApp();
  assert.equal(Aevion.settings.deviceAccess, false);
  assert.deepEqual(plain(Aevion.perms.granted()), []);
  assert.deepEqual(plain(Aevion.perms.missing()), plain(Aevion.perms.DEVICE));
});

test('a browser is never credited with what only the Android app can do', () => {
  const { Aevion } = deviceApp();
  assert.equal(Aevion.perms.shell(), false, 'the test sandbox is not a native shell');
  assert.deepEqual(plain(Aevion.perms.granted()), [], 'shell-only capabilities are not "granted" here');
  assert.deepEqual(plain(Aevion.perms.SHELL_ONLY), ['contacts_read', 'files_read', 'calendar_read']);
});

/* ---------- granting ---------- */

test('granting in one go reports what really happened, permission by permission', async () => {
  const { Aevion, events } = deviceApp({}, { geolocate: true, media: 'granted', notify: true });
  const seen = [];
  const report = await Aevion.perms.requestAll((k, result) => seen.push(k + ':' + result));

  assert.deepEqual(plain(report.denied), []);
  assert.ok(report.granted.includes('notifications'));
  assert.ok(report.granted.includes('geolocation'));
  assert.ok(report.granted.includes('camera'));
  assert.ok(report.granted.includes('microphone'));
  assert.ok(report.granted.includes('clipboardWrite'));
  assert.equal(seen.length, Aevion.perms.DEVICE.length, 'the caller hears about every one');
  assert.ok(events.some(e => e.n === 'perm:changed'), 'each grant is announced');
  assert.deepEqual(Aevion.perms.granted().sort(), report.granted.slice().sort());
  assert.deepEqual(plain(Aevion.perms.missing()), []);
});

test('a refusal is a refusal, not a silent success', async () => {
  const { Aevion } = deviceApp({}, { media: 'denied', geolocate: false });
  const report = await Aevion.perms.requestAll();
  assert.ok(report.denied.includes('camera'), 'a refused camera is reported as refused');
  assert.ok(report.denied.includes('microphone'));
  assert.ok(report.denied.includes('geolocation'));
  assert.equal(Aevion.perms.get('camera'), false);
  assert.equal(Aevion.perms.get('microphone'), false);
  assert.ok(!Aevion.perms.granted().includes('camera'));
});

test('a capability this device does not have is reported as unavailable, and stays un-granted', async () => {
  const { Aevion } = deviceApp({}, { notify: false });   // no Notification API at all
  const report = await Aevion.perms.requestAll();
  assert.ok(report.unavailable.includes('notifications'), 'a device without notifications says so');
  assert.equal(Aevion.perms.get('notifications'), false, 'and it is never marked granted');
  assert.ok(!report.granted.includes('notifications'));

  assert.equal(await Aevion.perms.request('notifications'), 'unavailable');
  assert.equal(Aevion.perms.status('notifications'), 'off');
});

test('the grant request includes what only the app can do, marked as such', async () => {
  const { Aevion } = deviceApp();
  const report = await Aevion.perms.requestAll();
  assert.equal(report.inShell, false);
  assert.deepEqual(plain(report.shellOnly), plain(Aevion.perms.SHELL_ONLY));
  assert.deepEqual(plain(report.unavailable).filter(k => Aevion.perms.SHELL_ONLY.includes(k)), [],
    'shell-only capabilities are not pretended into "unavailable" — they are simply not offered here');
});

/* ---------- revoking ---------- */

test('one tap takes everything back, including what only the app could use', async () => {
  const { Aevion, events } = deviceApp({ perms: { contacts_read: true } }, { geolocate: true, media: 'granted' });
  await Aevion.perms.requestAll();
  assert.ok(Aevion.perms.granted().length > 0);

  const revoked = Aevion.perms.revokeAll();
  assert.ok(revoked.includes('microphone'));
  assert.ok(revoked.includes('contacts_read'), 'a stale shell permission is swept up too');
  assert.deepEqual(plain(Aevion.perms.granted()), []);
  assert.equal(Aevion.perms.granted(true).length, 0);
  assert.equal(events.some(e => e.n === 'perms:revokedAll'), true, 'the UI is told it happened');
});

test('revoking nothing announces nothing', () => {
  const { Aevion, events } = deviceApp();
  assert.deepEqual(plain(Aevion.perms.revokeAll()), []);
  assert.equal(events.length, 0);
});

/* ---------- the new device tools ---------- */

test('the access report is a read tool: no permission needed, and it is honest', () => {
  const { Aevion } = deviceApp();
  assert.equal(Aevion.tools.canRun('device.access').ok, true, 'reading what is allowed needs no permission');
  const text = Aevion.tools.get('device.access').run();
  assert.match(text, /On this device:/);
  assert.match(text, /needs the Aevion app/);
  assert.match(text, /still asks you first/);
});

test('notifying needs the notification permission and really asks for it', async () => {
  const { Aevion, notifications } = deviceApp({}, { notify: true });
  const gate = Aevion.tools.canRun('device.notify');
  assert.equal(gate.ok, false);
  assert.equal(gate.code, 'permission');
  assert.equal(gate.perm, 'notifications');
  assert.match(gate.reason, /Device access/, 'the refusal points at the switch that fixes it');

  await Aevion.perms.request('notifications');
  assert.equal(Aevion.tools.canRun('device.notify').ok, true);
  const res = await Aevion.tools.run('device.notify', { title: 'Aevion', text: 'the timer is done' });
  assert.match(res.output, /Notified/);
  assert.equal(notifications.shown.length, 1);
  assert.equal(notifications.shown[0].body, 'the timer is done');
});

test('an empty notification is refused instead of posting a blank one', async () => {
  const { Aevion } = deviceApp({ perms: { notifications: true } });
  await assert.rejects(() => Aevion.tools.run('device.notify', { text: '   ' }), /Nothing to notify about/);
});

test('location needs the location permission and reports the coordinates it got', async () => {
  const { Aevion } = deviceApp({ perms: { geolocation: true } });
  assert.equal(Aevion.tools.canRun('device.location').ok, true);
  const res = await Aevion.tools.run('device.location');
  assert.match(res.output, /12\.9716, 77\.5946/);
  assert.match(res.output, /±12 m/);
});

test('a refused position is an error the user can read', async () => {
  const { Aevion } = deviceApp({ perms: { geolocation: true } }, { geolocate: false });
  await assert.rejects(() => Aevion.tools.run('device.location'), /refused to give a position/);
});

test('the permission gate is what stops the tool, not the switch', () => {
  const { Aevion } = deviceApp({ deviceAccess: true });
  const gate = Aevion.tools.canRun('device.location');
  assert.equal(gate.ok, false, 'ticking the switch without granting the permission does not unlock anything');
  assert.equal(gate.code, 'permission');
});

/* ---------- the security property ---------- */

test('granting everything never bypasses the confirmation tier', async () => {
  const { Aevion } = deviceApp({ perms: { automation: true, geolocation: true }, onlineSearch: true });
  Aevion.set('deviceAccess', true);
  await Aevion.perms.requestAll();

  for (const id of ['open.url', 'web.search', 'data.export', 'memory.forget']) {
    const gate = Aevion.tools.canRun(id);
    assert.equal(gate.ok, false, `${id} must still need confirmation with everything granted`);
    assert.equal(gate.code, 'confirm', `${id} should be gated on confirmation, not on permission`);
    await assert.rejects(() => Aevion.tools.run(id, { url: 'https://example.com', q: 'x', what: 'longterm' }), /confirmation/);
  }
});

test('an approved action does not carry over to the next one', async () => {
  const { Aevion } = deviceApp({ perms: { automation: true } });
  Aevion.set('deviceAccess', true);
  await Aevion.tools.run('open.url', { url: 'https://example.com' }, { confirm: true });
  await assert.rejects(() => Aevion.tools.run('open.url', { url: 'https://example.com' }), /confirmation/);
});

test('the audit log keeps the grant and the revoke, so the switch leaves a trail', async () => {
  const { Aevion } = deviceApp();
  Aevion.tools.audit('device.access', true, 'grant:3');
  Aevion.tools.audit('device.access', true, 'revoke:3');
  const log = Aevion.tools.log();
  assert.equal(log.length, 2);
  assert.deepEqual(plain(log.map(l => l.code)), ['grant:3', 'revoke:3']);
});
