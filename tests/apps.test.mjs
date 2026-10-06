/* Tests for js/apps.js — “plug Aevion into whatever app I install or whatever
   I search for, and let it use that without any error”.

   Two promises are pinned here, and the second matters more than the first:
   the places Aevion itself opened become one-tap plugins, and *every* failure
   path answers with a sentence a person can act on instead of throwing. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, plain } from './harness.mjs';

const app = (opts = {}) => createApp({
  settings: { onlineSearch: true, perms: { automation: true, open_apps: true }, ...(opts.settings || {}) },
  globals: opts.globals
});

/* A stand-in for the Android Apps plugin: two apps, one of which refuses. */
const android = () => ({
  Capacitor: {
    Plugins: {
      Apps: {
        listInstalled: async () => ({
          apps: [
            { label: 'Zed', package: 'dev.zed.app' },
            { label: '  Alpha  ', package: 'com.alpha' },
            { label: 'Zed again', package: 'dev.zed.app' },   // same package twice
            { label: '', package: 'com.nameless' },           // junk row
            { label: 'Ghost', package: '' }                   // junk row
          ]
        }),
        open: async ({ package: p }) => (p === 'com.alpha' ? { opened: true } : { opened: false, why: 'not installed' })
      }
    }
  }
});

test('a browser tab says it cannot see installed apps — it does not fail', async () => {
  const { Aevion } = app();
  assert.equal(Aevion.apps.native, false);
  assert.equal(Aevion.apps.supported(), false);
  const l = await Aevion.apps.listInstalled();
  assert.equal(l.ok, false);
  assert.deepEqual(plain(l.items), []);
  assert.match(l.why, /browser tab cannot list the apps/);
  assert.match(l.why, /Android app/, 'and it says where the list is real');

  const o = await Aevion.apps.launch('com.whatsapp');
  assert.equal(o.ok, false);
  assert.match(o.why, /Android app can/);
});

test('with Android behind it, the real list is used: tidy, deduped, sorted', async () => {
  const { Aevion } = app({ globals: android() });
  assert.equal(Aevion.apps.native, true);
  const l = await Aevion.apps.listInstalled();
  assert.equal(l.ok, true);
  assert.equal(l.why, '');
  assert.deepEqual(plain(l.items), [
    { name: 'Alpha', id: 'com.alpha', url: '' },
    { name: 'Zed', id: 'dev.zed.app', url: '' }
  ]);
});

test('starting an app answers whether it really started', async () => {
  const { Aevion } = app({ globals: android() });
  const yes = await Aevion.apps.launch('com.alpha');
  assert.equal(yes.ok, true);
  assert.equal(yes.via, 'app');
  const no = await Aevion.apps.launch('dev.zed.app');
  assert.equal(no.ok, false);
  assert.match(no.why, /would not start dev\.zed\.app/);
  const none = await Aevion.apps.launch('');
  assert.equal(none.ok, false);
  assert.match(none.why, /No app was named/);
});

test('a broken native bridge is a sentence, never a thrown stack', async () => {
  const { Aevion } = app({
    globals: { Capacitor: { Plugins: { Apps: {
      listInstalled: async () => { throw new Error('SecurityException: no access'); },
      open: async () => { throw new Error('ActivityNotFound'); }
    } } } }
  });
  const l = await Aevion.apps.listInstalled();
  assert.equal(l.ok, false);
  assert.match(l.why, /SecurityException/);
  const o = await Aevion.apps.launch('com.alpha');
  assert.equal(o.ok, false);
  assert.match(o.why, /ActivityNotFound/);
});

test('only places Aevion opened are remembered, https only, newest first', () => {
  const { Aevion } = app();
  assert.deepEqual(plain(Aevion.apps.recents()), []);
  assert.equal(Aevion.apps.note({ url: 'http://insecure.example/x' }), null, 'plain http is not a place Aevion opens');
  assert.equal(Aevion.apps.note({ url: 'javascript:alert(1)' }), null);
  assert.equal(Aevion.apps.recents().length, 0);

  Aevion.apps.note({ url: 'https://duckduckgo.com/?q=kotlin+coroutines', name: 'DDG', query: 'kotlin coroutines' });
  Aevion.apps.note({ url: 'https://www.youtube.com/results?search_query=lofi+beats', query: 'lofi beats' });
  const r = Aevion.apps.recents();
  assert.equal(r.length, 2);
  assert.equal(r[0].host, 'youtube.com', 'newest first');
  assert.equal(r[0].name, 'Youtube', 'a name is derived when none is given');
  assert.equal(r[0].query, 'lofi beats');

  Aevion.apps.note({ url: 'https://duckduckgo.com/?q=something%20else', query: 'something else' });
  const again = Aevion.apps.recents();
  assert.equal(again.length, 2, 'the same address updates its entry instead of duplicating');
  assert.equal(again[0].query, 'something else');
});

test('the list stays short: eight places, then the oldest falls off', () => {
  const { Aevion } = app();
  for (let i = 0; i < 12; i++) Aevion.apps.note({ url: 'https://example' + i + '.com/page', name: 'E' + i });
  const r = Aevion.apps.recents();
  assert.equal(r.length, 8);
  assert.equal(r[0].host, 'example11.com');
  assert.equal(r[7].host, 'example4.com');
  assert.equal(Aevion.apps.forget(r[0].form), 7);
  assert.equal(Aevion.apps.clear(), 0);
  assert.deepEqual(plain(Aevion.apps.recents()), []);
});

test('a search address becomes a template, so the plugin searches anything', () => {
  const { Aevion } = app();
  assert.equal(Aevion.apps.template('https://duckduckgo.com/?q=lofi+beats', 'lofi beats'),
    'https://duckduckgo.com/?q={query}');
  assert.equal(Aevion.apps.template('https://www.youtube.com/results?search_query=lofi%20beats', 'lofi beats'),
    'https://www.youtube.com/results?search_query={query}');
  assert.equal(Aevion.apps.template('https://flipkart.com/search?q=shoes', 'shoes'),
    'https://flipkart.com/search?q={query}', 'a key with no query remembered still templates');
  assert.equal(Aevion.apps.template('https://example.com/about', ''), 'https://example.com/about',
    'a page that is not a search stays exactly as it is');
});

test('one tap turns a place into a working plugin', () => {
  const { Aevion } = app();
  Aevion.apps.note({ url: 'https://www.youtube.com/results?search_query=lofi+beats', query: 'lofi beats' });
  const r = Aevion.apps.recents()[0];
  const s = Aevion.apps.suggest(r);
  assert.equal(s.name, 'Youtube');
  assert.deepEqual(plain(s.triggers), ['youtube']);
  assert.equal(s.target, 'https://www.youtube.com/results?search_query={query}');

  const made = Aevion.apps.plug(r);
  assert.equal(made.name, 'Youtube');
  assert.ok(Aevion.plugins.commands.youtube, 'the chat pipeline now owns the trigger');
  assert.equal(Aevion.apps.recents().length, 0, 'a plugged-in place leaves the “plug in” list');
  const listed = plain(Aevion.plugins.describe()).find(p => p.name === 'Youtube');
  assert.equal(listed.target, 'https://www.youtube.com/results?search_query={query}');
});

test('the tools that open things are the ones that record them', async () => {
  const { Aevion, opened } = app();
  await Aevion.tools.run('web.search', { query: 'kotlin coroutines' }, { confirm: true });
  assert.equal(opened.length, 1);
  const r = Aevion.apps.recents();
  assert.equal(r.length, 1);
  assert.match(r[0].url, /duckduckgo\.com\/\?q=kotlin%20coroutines/);
  assert.equal(r[0].query, 'kotlin coroutines');

  await Aevion.tools.run('open.url', { url: 'https://news.ycombinator.com/item?id=1' }, { confirm: true });
  assert.equal(Aevion.apps.recents().length, 2);
  assert.equal(Aevion.apps.recents()[0].host, 'news.ycombinator.com');
});

test('an app plugin is an action, and asking without approval is a sentence, not a crash', async () => {
  const { Aevion } = app({ globals: android() });
  const made = Aevion.plugins.addSimple({
    name: 'Alpha', triggers: ['alpha'], app: 'com.alpha', target: 'https://example.com/alpha', reply: 'Opening Alpha.'
  });
  assert.equal(made.app, 'com.alpha');

  let out;
  Aevion.on('tool:confirm', p => { out = 'asked:' + p.id; });
  const answer = await Aevion.plugins.commands.alpha('alpha now');
  assert.match(answer, /📱 Opened Alpha on this device/);
  assert.equal(out, undefined, 'the app started without needing a web confirmation');

  // the same plugin with an app Android refuses: the link it also holds is used
  const { Aevion: b } = app({ globals: android() });
  b.plugins.addSimple({ name: 'Zed', triggers: ['zed'], app: 'dev.zed.app', target: 'https://zed.dev/download' });
  let confirmed = null;
  b.on('tool:confirm', p => { confirmed = p.args.url; });
  const second = await b.plugins.commands.zed('zed');
  assert.match(second, /⏳/, 'the link path is taken, and it asks the same question every link asks');
  assert.equal(confirmed, 'https://zed.dev/download');
});

test('checking a link never opens it, and catches a typo before you use it', async () => {
  const { Aevion, opened } = app();
  const good = Aevion.plugins.checkLink({ target: 'https://duckduckgo.com/?q={query}' }, 'cat videos');
  assert.equal(good.ok, true);
  assert.equal(good.url, 'https://duckduckgo.com/?q=cat%20videos');
  assert.equal(opened.length, 0, 'a test must never become a visit');

  const bad = Aevion.plugins.checkLink({ target: 'http://insecure.example/x' }, 'x');
  assert.equal(bad.ok, false);
  assert.match(bad.why, /is not an https:\/\/ address/);
  const host = Aevion.plugins.checkLink({ target: 'https://not a host/{query}' }, 'x');
  assert.equal(host.ok, false);
  const none = Aevion.plugins.checkLink({}, 'x');
  assert.equal(none.ok, false);
  assert.match(none.why, /no address/);
});
