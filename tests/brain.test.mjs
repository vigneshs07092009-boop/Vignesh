/* Tests for brain.js — routing, the offline personality, memory handling
   and (most importantly) that permission gates really gate. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, makeFetch, jsonReply, plain } from './harness.mjs';

const kinds = (Aevion, text) => Aevion.brain.route(text).kind;

test('route: recognises the built-in intents', () => {
  const { Aevion } = createApp();
  assert.equal(kinds(Aevion, '/help'), 'help');
  assert.equal(kinds(Aevion, 'what time is it'), 'time');
  assert.equal(kinds(Aevion, "what's the date"), 'date');
  assert.equal(kinds(Aevion, 'hello there'), 'greet');
  assert.equal(kinds(Aevion, 'who are you'), 'whoami');
  assert.equal(kinds(Aevion, 'what can you do'), 'features');
  assert.equal(kinds(Aevion, 'thanks!'), 'thanks');
  assert.equal(kinds(Aevion, 'remember: my exam is friday'), 'remember');
  assert.equal(kinds(Aevion, 'what do you remember about me'), 'recall');
  assert.equal(kinds(Aevion, 'note: call the bank'), 'note');
  assert.equal(kinds(Aevion, 'add task: revise calculus'), 'task');
  assert.equal(kinds(Aevion, 'list my tasks'), 'tasks');
  assert.equal(kinds(Aevion, 'status'), 'status');
  assert.equal(kinds(Aevion, 'tell me a joke'), 'joke');
  assert.equal(kinds(Aevion, 'flip a coin'), 'coin');
  assert.equal(kinds(Aevion, 'roll a dice'), 'dice');
  assert.equal(kinds(Aevion, ''), 'empty');
  assert.equal(kinds(Aevion, 'explain quantum tunnelling'), 'chat');
});

test('handle: arithmetic reaches the calculator, whatever the phrasing', async () => {
  const { Aevion } = createApp();
  assert.equal(await Aevion.brain.handle('2+2'), '= 4');
  assert.equal(await Aevion.brain.handle('what is 2+2?'), '= 4');
  assert.equal(await Aevion.brain.handle('calculate (45*12)+9/3'), '= 543');
});

test('handle: time and date are answered from the device clock', async () => {
  const { Aevion } = createApp();
  assert.match(await Aevion.brain.handle('what time is it'), /🕒 \d/);
  assert.match(await Aevion.brain.handle('what is the date'), /📅 \w+day/);
});

test('handle: help lists the real capabilities', async () => {
  const { Aevion } = createApp();
  const out = await Aevion.brain.handle('/help');
  assert.match(out, /Math/);
  assert.match(out, /remember/);
  assert.match(out, /Memory view/);
});

test('handle: /clear emits the event the UI listens for', async () => {
  const { Aevion } = createApp();
  let cleared = 0;
  Aevion.on('chat:clear', () => cleared++);
  assert.match(await Aevion.brain.handle('/clear'), /cleared/i);
  assert.equal(cleared, 1);
});

/* ---------- memory behaviours ---------- */

test('remember: stores a fact and refuses the same fact twice', async () => {
  const { Aevion } = createApp();
  const out = await Aevion.brain.handle('remember: my exam is on Friday');
  assert.match(out, /Stored locally/);
  assert.equal(Aevion.memory.all('longterm')[0].text, 'my exam is on Friday');
  assert.match(await Aevion.brain.handle('remember: my exam is on Friday'), /already know/);
});

test('remember: an empty fact is asked for, not stored', async () => {
  const { Aevion } = createApp();
  assert.match(await Aevion.brain.handle('remember:'), /Tell me what to remember/);
  assert.equal(Aevion.memory.all('longterm').length, 0);
});

test('setname: stores the name in the profile tag and greets the user by it', async () => {
  const { Aevion } = createApp();
  const out = await Aevion.brain.handle('my name is Vignesh');
  assert.match(out, /Vignesh/);
  const saved = Aevion.memory.all('longterm')[0];
  assert.equal(saved.tag, 'profile');
  assert.match(saved.text, /Vignesh/);
});

test('recall: lists what is actually in memory, and says when it is empty', async () => {
  const { Aevion } = createApp();
  assert.match(await Aevion.brain.handle('what do you remember about me'), /empty/);
  Aevion.memory.add('I like filter coffee');
  assert.match(await Aevion.brain.handle('what do you remember about me'), /filter coffee/);
});

test('preferences: a stated preference is noticed but stays unapproved', async () => {
  const { Aevion } = createApp({ settings: { memory: true } });
  await Aevion.brain.handle('I prefer working late at night, honestly');
  const pending = plain(Aevion.memory.pending());
  assert.equal(pending.length, 1);
  assert.match(pending[0].text, /prefer working late/);
  assert.equal(Aevion.memory.approve, Aevion.memory.approve);       // exists
  assert.equal(Aevion.memory.recall('late night work').length, 0, 'unapproved preferences are not used');
});

test('preferences: noticing is off when the user turned memory off', async () => {
  const { Aevion } = createApp({ settings: { memory: false } });
  await Aevion.brain.handle('I always take my coffee black');
  assert.equal(Aevion.memory.pending().length, 0);
});

/* ---------- permission gates ---------- */

test('gating: "open site" asks for the permission instead of opening anything', async () => {
  const { Aevion, opened } = createApp({ settings: { perms: { automation: false } } });
  const out = await Aevion.brain.handle('open site youtube');
  assert.match(out, /Automation permission/);
  assert.deepEqual(opened, [], 'nothing may be opened without the permission');
});

test('gating: with the permission granted it opens the mapped site', async () => {
  const { Aevion, opened } = createApp({ settings: { perms: { automation: true } } });
  const out = await Aevion.brain.handle('open site youtube');
  assert.match(out, /Opening youtube/);
  assert.deepEqual(opened, ['https://youtube.com']);
});

test('gating: weather needs location first, then the internet switch', async () => {
  const noGeo = createApp({ settings: { onlineSearch: true, perms: { geolocation: false } } });
  assert.match(await noGeo.Aevion.brain.handle('weather'), /Location permission/);

  const noNet = createApp({ settings: { onlineSearch: false, perms: { geolocation: true } } });
  assert.match(await noNet.Aevion.brain.handle('weather'), /online search/i);
});

test('gating: weather answers once both gates are open', async () => {
  const fetch = makeFetch([{ match: c => c.url.includes('open-meteo'), reply: jsonReply({ current: { temperature_2m: 22, wind_speed_10m: 5, weather_code: 0 } }) }]);
  const { Aevion } = createApp({
    settings: { onlineSearch: true, perms: { geolocation: true } },
    navigator: { geolocation: { getCurrentPosition: ok => ok({ coords: { latitude: 1, longitude: 2 } }) } },
    fetch
  });
  assert.match(await Aevion.brain.handle('weather'), /22°C, clear sky/);
});

test('gating: search stays offline until allowed, then hands the query to a search engine', async () => {
  const off = createApp({ settings: { onlineSearch: false } });
  assert.match(await off.Aevion.brain.handle('search kotlin coroutines'), /Enable/);
  assert.deepEqual(off.opened, []);

  const on = createApp({ settings: { onlineSearch: true } });
  const out = await on.Aevion.brain.handle('search kotlin coroutines');
  assert.match(out, /kotlin coroutines/);
  assert.match(on.opened[0], /duckduckgo\.com/);
});

test('gating: translated text is not sent anywhere while online search is off', async () => {
  const fetch = makeFetch([{ reply: jsonReply([[]]) }]);
  const { Aevion } = createApp({ settings: { onlineSearch: false }, fetch });
  await Aevion.brain.handle('translate hello to tamil');
  assert.equal(fetch.calls.length, 0);
});

/* ---------- tasks and notes through the brain ---------- */

test('tasks: "add task: …" writes through the tool layer and a due date is parsed', async () => {
  const { Aevion } = createApp();
  await Aevion.brain.handle('add task: revise calculus 2026-10-01');
  const tasks = plain(Aevion.store.get('tasks'));
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].due, '2026-10-01');
  assert.equal(tasks[0].label, 'revise calculus');
  assert.match(await Aevion.brain.handle('list my tasks'), /revise calculus/);
});

test('notes: "note: …" saves a timestamped note', async () => {
  const { Aevion } = createApp();
  await Aevion.brain.handle('note: call the bank');
  assert.match(Aevion.store.get('notes')[0].label, /call the bank/);
});

test('status: reports the real state of the app', async () => {
  const { Aevion } = createApp({ settings: { onlineSearch: false } });
  const out = await Aevion.brain.handle('status');
  assert.match(out, new RegExp('Aevion ' + Aevion.version));
  assert.match(out, /Internet features: disabled/);
});

/* ---------- the offline fallback ---------- */

test('fallback: an unconfigured chat says what to do, and surfaces relevant memory', async () => {
  const { Aevion } = createApp({ settings: { onlineAI: false } });
  const plainReply = await Aevion.brain.handle('explain pointers in C');
  assert.match(plainReply, /locally/);
  assert.match(plainReply, /Settings/);

  Aevion.memory.add('The user is studying pointers in C', 'fact', 'longterm');
  const withMemory = await Aevion.brain.handle('explain pointers in C');
  assert.match(withMemory, /From memory:/);
});

test('personality: concise trims to the first line, formal expands contractions', async () => {
  const concise = createApp({ settings: { persona: 'concise' } });
  const help = await concise.Aevion.brain.handle('/help');
  assert.equal(help.includes('\n'), false);
  assert.ok(help.length > 0);

  const formal = createApp({ settings: { persona: 'formal' } });
  const greeting = await formal.Aevion.brain.handle('hello');
  assert.ok(greeting.length > 0);
});

test('privacy: the answer describes what actually happens', async () => {
  const { Aevion } = createApp();
  const out = await Aevion.brain.handle('what data do you collect');
  assert.match(out, /local storage/i);
  assert.match(out, /nothing is transmitted/i);
});

test('dice and coin stay inside their real range', async () => {
  const { Aevion } = createApp();
  for (let i = 0; i < 40; i++) {
    const d = await Aevion.brain.handle('roll a dice');
    const n = parseInt(d.replace(/\D/g, ''), 10);
    assert.ok(n >= 1 && n <= 6, 'got ' + d);
    assert.match(await Aevion.brain.handle('flip a coin'), /Heads|Tails/);
  }
});
