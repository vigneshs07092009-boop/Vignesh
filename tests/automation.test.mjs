/* Tests for the automation side of js/tools.js: timers that keep running
   while the user is elsewhere, the one-button report, and the local
   directory that answers "which app or site is best for this?".

   Two things are being pinned down. A timer must fire even if the platform
   throttled it (late, and saying so), and the report must come from the
   same tables the gate reads — a report that can flatter itself is worse
   than no report. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, plain } from './harness.mjs';

const app = (settings, opts) => createApp({ settings, ...opts });

/* ---------- timers ---------- */

test('a timer refuses a length it cannot honour instead of pretending', () => {
  const A = app().Aevion;
  assert.equal(A.tools.timers.add(0, 'x'), null);
  assert.equal(A.tools.timers.add(-5, 'x'), null);
  assert.equal(A.tools.timers.add(86401, 'x'), null, 'more than a day is a date, not a timer');
  assert.equal(A.tools.timers.add('soon', 'x'), null);
  assert.ok(A.tools.timers.add(60, 'tea'));
  assert.equal(A.tools.timers.active().length, 1);
  A.tools.timers.clear();
});

test('timer.start is a local, askable action and reports what it set', async () => {
  const A = app().Aevion;
  assert.equal(A.tools.get('timer.start').tier, 'safe');
  assert.deepEqual(plain(A.tools.canRun('timer.start')), { ok: true });
  const r = await A.tools.run('timer.start', { minutes: 5, label: 'tea' });
  assert.match(r.output, /Timer set for 5m — tea/);
  assert.match(r.output, /even if you switch away/);
  assert.match((await A.tools.run('timer.list')).output, /⏱ 5m left — tea/);
  assert.match((await A.tools.run('timer.clear')).output, /Cancelled 1 timer/);
  assert.match((await A.tools.run('timer.list')).output, /No timers are running/);
});

test('an overdue timer fires on catch-up, and says how late it was', () => {
  const A = app().Aevion;
  const t = A.tools.timers.add(60, 'bread');
  /* Pretend the deadline passed while the page was hidden. */
  const list = A.store.get('timers', []);
  list[0].end = Date.now() - 4000;
  A.store.set('timers', list);

  const fired = [];
  A.on('timer:done', e => fired.push(e));
  assert.equal(A.tools.timers.rearm(), 1, 'catch-up found exactly one');
  assert.equal(fired.length, 1);
  assert.equal(fired[0].id, t.id);
  assert.equal(fired[0].label, 'bread');
  assert.ok(fired[0].late >= 4, 'how late is reported, not hidden');
  assert.deepEqual(plain(A.store.get('timers', [])), [], 'and it is not left behind');
});

test('a timer rings as a notification only when notifications are allowed', async () => {
  const shown = [];
  class FakeNotification { constructor(title, o) { this.title = title; this.body = o && o.body; shown.push(this); } close() {} }
  FakeNotification.requestPermission = async () => 'granted';
  const A = createApp({ globals: { Notification: FakeNotification } }).Aevion;
  A.tools.timers.add(30, 'tea');
  const list = A.store.get('timers', []);
  list[0].end = Date.now() - 1000;
  A.store.set('timers', list);
  A.tools.timers.rearm();
  assert.equal(shown.length, 0, 'no permission, no notification');

  A.tools.timers.add(30, 'tea');
  const list2 = A.store.get('timers', []);
  list2[0].end = Date.now() - 1000;
  A.store.set('timers', list2);
  await A.perms.request('notifications');
  A.tools.timers.rearm();
  assert.equal(shown.length, 1);
  assert.match(shown[0].title, /tea/);
});

/* ---------- the report ---------- */

test('the report is built from the same tables the gate uses', async () => {
  const A = app().Aevion;
  const r = A.tools.report();
  assert.equal(r.version, A.version);
  assert.equal(r.mode.ai, 'local only');
  assert.equal(r.tiers.read > 0, true);
  assert.equal(r.tiers.safe > 0, true);
  assert.equal(r.tiers.sensitive > 0, true);
  assert.equal(r.tiers.confirm > 0, true);
  assert.ok(r.alwaysAsks.includes('web.search'), 'tier 3 tooling is named');
  assert.ok(r.blocked.some(b => b.why === 'permission'), 'what is waiting on a permission is named');
  assert.deepEqual(plain(r.off), [], 'nothing is switched off by default');
  assert.equal(r.permissions.granted.length, 0);
  assert.ok(r.permissions.missing.includes('open_apps'));
  assert.equal(r.selfUpgrade, false, 'the report tells the truth about self-upgrade');
});

test('the report counts refusals, not just successes', async () => {
  const A = app().Aevion;
  await A.tools.run('timer.start', { minutes: 1 }).then(() => {}, () => {});
  await A.tools.run('device.notify', { text: 'hi' }).then(() => {}, () => {});
  await A.tools.run('timer.clear').then(() => {}, () => {});
  const r = A.tools.report();
  assert.equal(r.activity.total, 3);
  assert.equal(r.activity.ok, 2);
  assert.equal(r.activity.refused, 1);
  assert.equal(r.activity.byCode.permission, 1);
  assert.equal(r.activity.recent[0].id, 'timer.clear', 'newest first');
});

test('system.report says all of it out loud, in one read-only answer', async () => {
  const A = app({ onlineSearch: true }).Aevion;
  const r = await A.tools.run('system.report');
  assert.match(r.output, /automation report/);
  assert.match(r.output, /Tools by tier:/);
  assert.match(r.output, /always asks first: .*web\.search/);
  assert.match(r.output, /Permissions:/);
  assert.match(r.output, /not allowed: .*open_apps/);
  assert.match(r.output, /Self-upgrade: off/);
  assert.equal(A.tools.canRun('system.report').ok, true, 'and it needs no permission to look');
});

test('granting the device everything is reflected in the report', async () => {
  const A = createApp({ globals: { Notification: class { constructor() {} close() {} } } });
  A.Aevion.settings.perms.automation = true;
  A.Aevion.settings.perms.open_apps = true;
  const r = A.Aevion.tools.report();
  assert.ok(r.permissions.granted.includes('open_apps'));
  assert.ok(!r.blocked.some(b => b.id === 'open_apps'), 'an allowed tool is no longer blocked');
});

/* ---------- the best app or site for a topic ---------- */

test('the lookup is local, and refusal to guess is part of it', () => {
  const A = app().Aevion;
  assert.equal(A.tools.bestSite('learn python for free').id, 'khan');
  assert.equal(A.tools.bestSite('merge these pdf files').id, 'ilovepdf');
  assert.equal(A.tools.bestSite('book a train to Chennai').id, 'irctc');
  assert.equal(A.tools.bestSite('what is quantum entanglement').id, 'wikipedia');
  assert.equal(A.tools.bestSite('order food to my flat').id, 'swiggy');
  assert.equal(A.tools.bestSite('run a multi agent swarm').id, 'ruflo', 'Ruflo is a place Aevion knows and can open — not an invented answer');
  assert.equal(A.tools.bestSite(''), null);
  assert.equal(A.tools.bestSite('flurble wurble'), null, 'an unknown topic gets no invented answer');
});

test('opening the best site needs its own permission, then a fresh yes', async () => {
  const a = app({ onlineSearch: true });
  const A = a.Aevion;
  const tool = A.tools.get('web.best');
  assert.equal(tool.tier, 'confirm');
  assert.deepEqual(plain(tool.perms), ['open_apps']);

  let err = await A.tools.run('web.best', { topic: 'learn python' }).catch(e => e);
  assert.equal(err.code, 'permission');
  assert.match(err.message, /Open apps & websites/);
  assert.deepEqual(plain(a.opened), [], 'nothing was opened');

  await A.perms.request('open_apps');
  err = await A.tools.run('web.best', { topic: 'learn python' }).catch(e => e);
  assert.equal(err.code, 'confirm', 'the permission unlocks the tool, the tier still asks');

  const r = await A.tools.run('web.best', { topic: 'learn python' }, { confirm: true });
  assert.match(r.output, /Khan Academy \(site\)/);
  assert.match(r.output, /https:\/\/www\.khanacademy\.org/);
  assert.match(r.output, /Opening it now/);
  assert.deepEqual(plain(a.opened), ['https://www.khanacademy.org']);
});

test('the recommendation can be asked for without opening anything', async () => {
  const a = app({ onlineSearch: true });
  const A = a.Aevion;
  A.settings.perms.open_apps = true;
  const r = await A.tools.run('web.best', { topic: 'cook a biryani', open: false }, { confirm: true });
  assert.match(r.output, /Allrecipes/);
  assert.match(r.output, /Not opened/);
  assert.deepEqual(plain(a.opened), []);
});

test('an unknown topic fails as a tool error, not as a crash', async () => {
  const A = app({ onlineSearch: true }).Aevion;
  A.settings.perms.open_apps = true;
  const err = await A.tools.run('web.best', { topic: 'flurble' }, { confirm: true }).catch(e => e);
  assert.equal(err.code, 'failed');
  assert.match(err.message, /nothing in my local directory/i);
});

test('open_apps is a permission this device can actually be asked for', () => {
  const A = app().Aevion;
  assert.ok(A.perms.DEVICE.includes('open_apps'));
  assert.ok(!A.perms.SHELL_ONLY.includes('open_apps'));
  assert.equal(A.perms.get('open_apps'), false);
  assert.equal(typeof A.perms.map.open_apps.req, 'function');
});
