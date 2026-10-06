/* Tests for tools.js — the permission tiers are the whole point of this
   file: a sensitive tool must not run without its permission, and a
   tier-3 tool must not run without a fresh, explicit yes. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, makeFetch, jsonReply, plain } from './harness.mjs';

const geo = { geolocation: { getCurrentPosition: ok => ok({ coords: { latitude: 1, longitude: 2 } }) } };

function weatherApp(settings = {}) {
  const fetch = makeFetch([{ match: c => c.url.includes('open-meteo'), reply: jsonReply({ current: { temperature_2m: 31, wind_speed_10m: 12, weather_code: 61 } }) }]);
  const app = createApp({
    settings: { onlineSearch: true, perms: { geolocation: true }, ...settings },
    navigator: geo,
    fetch
  });
  return { ...app, fetch };
}

/* ---------- registry ---------- */

test('registry: every built-in tool has a valid tier and a description', () => {
  const { Aevion } = createApp();
  assert.ok(Aevion.tools.list.length >= 15, 'the built-in tool set should be substantial');
  for (const t of Aevion.tools.list) {
    assert.ok(Aevion.tools.TIERS[t.tier], `${t.id} has tier ${t.tier}`);
    assert.ok(t.name && t.desc, `${t.id} needs a name and description`);
    assert.equal(typeof t.run, 'function');
  }
  assert.deepEqual(plain(Aevion.tools.ids()).length, new Set(Aevion.tools.ids()).size, 'ids must be unique');
});

test('registry: all four tiers are actually used by built-in tools', () => {
  const { Aevion } = createApp();
  for (const tier of ['read', 'safe', 'sensitive', 'confirm']) {
    assert.ok(Aevion.tools.byTier(tier).length > 0, `no built-in tool uses tier ${tier}`);
  }
});

test('registry: a tool cannot be registered with a bogus tier', () => {
  const { Aevion } = createApp();
  assert.throws(() => Aevion.tools.register({ id: 'bad', tier: 'root-access', run: () => '' }), /unknown tier/);
  assert.throws(() => Aevion.tools.register({ tier: 'read', run: () => '' }), /needs an id/);
});

/* ---------- tier 0/1: read and safe ---------- */

test('read: runs with no permissions at all', async () => {
  const { Aevion } = createApp({ settings: { onlineSearch: false } });
  assert.equal((await Aevion.tools.run('time')).output.startsWith('🕒'), true);
  assert.equal((await Aevion.tools.run('date')).output.startsWith('📅'), true);
  assert.equal((await Aevion.tools.run('calc', { expression: '(45*12)+9/3' })).output, '= 543');
});

test('read: an unknown tool fails loudly instead of silently doing nothing', async () => {
  const { Aevion } = createApp();
  await assert.rejects(() => Aevion.tools.run('make.coffee'), e => e.code === 'unknown');
});

test('safe: writing a note or task needs no permission', async () => {
  const { Aevion } = createApp();
  await Aevion.tools.run('notes.add', { text: 'call the bank' });
  assert.match(Aevion.store.get('notes')[0].label, /call the bank/);
  await Aevion.tools.run('tasks.add', { text: 'revise calculus', due: '2026-10-01' });
  const tasks = plain(Aevion.store.get('tasks'));
  assert.equal(tasks[0].label, 'revise calculus');
  assert.equal(tasks[0].due, '2026-10-01');
});

test('safe: tools announce data changes so the UI can refresh', async () => {
  const { Aevion } = createApp();
  const seen = [];
  Aevion.on('data:changed', d => seen.push(d.what));
  await Aevion.tools.run('notes.add', { text: 'x' });
  await Aevion.tools.run('tasks.add', { text: 'y' });
  assert.deepEqual(seen, ['notes', 'tasks']);
});

test('safe: tasks.done toggles by position and rejects a bad index', async () => {
  const { Aevion } = createApp();
  await Aevion.tools.run('tasks.add', { text: 'first' });
  assert.match((await Aevion.tools.run('tasks.done', { index: '1' })).output, /Done/);
  assert.equal(Aevion.store.get('tasks')[0].done, true);
  await assert.rejects(() => Aevion.tools.run('tasks.done', { index: '9' }), e => e.code === 'failed');
});

/* ---------- the user can switch tools off ---------- */

test('user control: a disabled tool refuses to run even when asked directly', async () => {
  const { Aevion } = createApp();
  Aevion.tools.setEnabled('calc', false);
  await assert.rejects(() => Aevion.tools.run('calc', { expression: '1+1' }), e => {
    assert.equal(e.code, 'disabled');
    assert.match(e.message, /switched off/);
    return true;
  });
  assert.equal(Aevion.tools.canRun('calc').ok, false);
  Aevion.tools.setEnabled('calc', true);
  assert.equal((await Aevion.tools.run('calc', { expression: '1+1' })).output, '= 2');
});

/* ---------- tier 2: sensitive ---------- */

test('sensitive: refuses without its permission and names it', async () => {
  const { Aevion } = createApp({ settings: { onlineSearch: true } });
  await assert.rejects(() => Aevion.tools.run('weather'), e => {
    assert.equal(e.code, 'permission');
    assert.equal(e.perm, 'geolocation');
    assert.match(e.message, /Location/);
    return true;
  });
});

test('sensitive: refuses when the internet switch is off, even with permission', async () => {
  const { Aevion, fetch } = weatherApp({ onlineSearch: false });
  await assert.rejects(() => Aevion.tools.run('weather'), e => {
    assert.equal(e.code, 'network');
    return true;
  });
  assert.equal(fetch.calls.length, 0, 'nothing may leave the device');
});

test('sensitive: runs when both gates are satisfied, and really fetches', async () => {
  const { Aevion, fetch } = weatherApp();
  const r = await Aevion.tools.run('weather');
  assert.match(r.output, /31°C/);
  assert.match(r.output, /rain/);
  assert.equal(fetch.calls.length, 1);
});

/* ---------- tier 3: confirm ---------- */

test('confirm: refuses and raises a confirmation request instead of acting', async () => {
  const { Aevion, opened } = weatherApp();
  const prompts = [];
  Aevion.on('tool:confirm', p => prompts.push(p.id));

  await assert.rejects(() => Aevion.tools.run('web.search', { query: 'kotlin coroutines' }), e => {
    assert.equal(e.code, 'confirm');
    assert.equal(e.needsConfirm, true);
    return true;
  });
  assert.deepEqual(prompts, ['web.search'], 'the UI is asked to confirm');
  assert.equal(opened.length, 0, 'and nothing was opened before the answer');
});

test('confirm: runs only with an explicit approval for that call', async () => {
  const { Aevion, opened } = weatherApp();
  const r = await Aevion.tools.run('web.search', { query: 'kotlin coroutines' }, { confirm: true });
  assert.equal(opened.length, 1);
  assert.match(opened[0], /duckduckgo\.com\/\?q=kotlin%20coroutines/);
  assert.match(r.output, /kotlin coroutines/);
});

test('confirm: an approval does not carry over to the next call', async () => {
  const { Aevion } = weatherApp();
  await Aevion.tools.run('web.search', { query: 'one' }, { confirm: true });
  await assert.rejects(() => Aevion.tools.run('web.search', { query: 'two' }), e => e.code === 'confirm');
});

test('confirm: a permission is still required after approval', async () => {
  const { Aevion } = weatherApp();
  await assert.rejects(() => Aevion.tools.run('open.url', { url: 'https://example.com' }, { confirm: true }), e => {
    assert.equal(e.code, 'permission');
    assert.equal(e.perm, 'automation');
    return true;
  });
});

test('confirm: open.url refuses every non-https scheme', async () => {
  const { Aevion, opened } = weatherApp({ perms: { geolocation: true, automation: true } });
  for (const bad of ['javascript:alert(1)', 'data:text/html,<h1>x', 'file:///C:/secret.txt', 'http://example.com']) {
    await assert.rejects(() => Aevion.tools.run('open.url', { url: bad }, { confirm: true }), e => {
      assert.equal(e.code, 'failed', bad);
      return true;
    }, `should refuse ${bad}`);
  }
  assert.deepEqual(opened, [], 'nothing may be opened');
});

test('confirm: open.url accepts a normal domain and a bare host name', async () => {
  const { Aevion, opened } = weatherApp({ perms: { geolocation: true, automation: true } });
  await Aevion.tools.run('open.url', { url: 'https://example.com/docs' }, { confirm: true });
  await Aevion.tools.run('open.url', { url: 'duckduckgo.com' }, { confirm: true });
  assert.deepEqual(opened, ['https://example.com/docs', 'https://duckduckgo.com']);
});

/* ---------- audit ---------- */

test('audit: records successful runs and refusals alike', async () => {
  const { Aevion } = createApp({ settings: { onlineSearch: false } });
  await Aevion.tools.run('time');
  await Aevion.tools.run('weather').catch(() => {});
  await Aevion.tools.run('nope').catch(() => {});
  const log = plain(Aevion.tools.log());
  assert.equal(log.length, 3);
  assert.deepEqual(log.map(l => [l.id, l.ok, l.code]), [
    ['time', true, 'ok'],
    ['weather', false, 'permission'],
    ['nope', false, 'unknown']
  ]);
});

test('audit: the log is capped so it cannot grow forever', async () => {
  const { Aevion } = createApp();
  for (let i = 0; i < 60; i++) await Aevion.tools.run('time');
  assert.equal(Aevion.tools.log().length, 50);
  Aevion.tools.clearLog();
  assert.equal(Aevion.tools.log().length, 0);
});

/* ---------- individual tools ---------- */

test('memory tools: search, add, stats and a confirm-gated forget', async () => {
  const { Aevion } = createApp();
  await Aevion.tools.run('memory.add', { text: 'the user cycles to work' });
  assert.match((await Aevion.tools.run('memory.search', { query: 'how do I get to work' })).output, /cycles to work/);
  assert.match((await Aevion.tools.run('memory.stats')).output, /Saved facts: 1/);
  const id = Aevion.memory.all('longterm')[0].id;
  await assert.rejects(() => Aevion.tools.run('memory.forget', { id }), e => e.code === 'confirm');
  await Aevion.tools.run('memory.forget', { id }, { confirm: true });
  assert.equal(Aevion.memory.all('longterm').length, 0);
});

test('status tool: reports version, provider and memory counts truthfully', async () => {
  const { Aevion } = createApp({ settings: { aiProvider: 'openai', onlineAI: true } });
  const out = (await Aevion.tools.run('system.status')).output;
  assert.match(out, new RegExp('Aevion ' + Aevion.version));
  assert.match(out, /OpenAI/);
  assert.match(out, /needs API key/, 'an unconfigured provider must be reported as such');
  assert.match(out, /Internet features: disabled/);
});

test('coding tools: detect and explain a snippet offline', async () => {
  const { Aevion } = createApp();
  const py = 'import os\n\ndef main():\n    print("hi")\n';
  assert.equal((await Aevion.tools.run('code.detect', { code: py })).output, 'python');
  assert.match((await Aevion.tools.run('code.explain', { code: py })).output, /Code profile/);
});

test('files tool: lists the vault without exposing contents', async () => {
  const { Aevion } = createApp();
  Aevion.store.set('files', [{ name: 'notes.txt', size: 2048, data: 'data:text/plain;base64,U0VDUkVU' }]);
  const out = (await Aevion.tools.run('files.list')).output;
  assert.match(out, /notes\.txt/);
  assert.equal(out.includes('U0VDUkVU'), false, 'file contents must never appear in a tool result');
});

test('describe: every tool reports an enabled flag and a runnable status', () => {
  const { Aevion } = createApp();
  const d = plain(Aevion.tools.describe());
  assert.equal(d.length, Aevion.tools.list.length);
  const weather = d.find(t => t.id === 'weather');
  assert.equal(weather.enabled, true);
  assert.equal(weather.status, 'permission');
  assert.equal(weather.network, true);
});
