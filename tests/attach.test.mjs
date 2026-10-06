/* Tests for js/attach.js — the paperclip.

   Two properties carry the weight here: the four families the button
   offers are recognised from the file itself, and the module is honest
   about which of them Aevion can actually look inside. A photo is never
   reported as if it had been read. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, plain, readApp } from './harness.mjs';

const app = () => createApp().Aevion;

/* A stand-in for the browser File the picker hands over: the same own
   properties, including Blob.text(). */
const fakeFile = (name, type, size, body) => ({ name, type, size, text: async () => body });

test('the four families are recognised from the file, not from the name alone', () => {
  const A = app();
  assert.equal(A.attach.kindOf('IMG_1234.jpg', 'image/jpeg'), 'photo');
  assert.equal(A.attach.kindOf('clip.mov', 'video/quicktime'), 'video');
  assert.equal(A.attach.kindOf('invoice.pdf', 'application/pdf'), 'pdf');
  assert.equal(A.attach.kindOf('report.docx', ''), 'document');
  assert.equal(A.attach.kindOf('notes.md', 'text/markdown'), 'document');
  assert.equal(A.attach.kindOf('photo.png', ''), 'photo', 'the extension is enough when the type is missing');
});

test('only text-ish files are claimed as readable', () => {
  const A = app();
  assert.equal(A.attach.readable('notes.txt', 'text/plain'), true);
  assert.equal(A.attach.readable('data.json', 'application/json'), true);
  assert.equal(A.attach.readable('main.py', ''), true);
  assert.equal(A.attach.readable('holiday.jpg', 'image/jpeg'), false);
  assert.equal(A.attach.readable('scan.pdf', 'application/pdf'), false);
  assert.equal(A.attach.readable('movie.mp4', 'video/mp4'), false);
});

test('sizes are reported the way a person reads them', () => {
  const A = app();
  assert.equal(A.attach.humanSize(512), '512 B');
  assert.equal(A.attach.humanSize(2048), '2.0 KB');
  assert.equal(A.attach.humanSize(5 * 1024 * 1024), '5.0 MB');
});

test('attaching records what it is, and says whether it can be read', () => {
  const A = app();
  const rec = A.attach.attach(fakeFile('notes.txt', 'text/plain', 1200, 'hello'));
  assert.equal(rec.kind, 'document');
  assert.equal(rec.readable, true);
  assert.equal(A.attach.count(), 1);
  const photo = A.attach.attach(fakeFile('holiday.jpg', 'image/jpeg', 400000, ''));
  assert.equal(photo.kind, 'photo');
  assert.match(A.attach.describe().join('\n'), /holiday\.jpg — photo, image\/jpeg, 390\.6 KB \(I cannot look inside this one on-device\)/);
  assert.match(A.attach.summary(), /photo/);
});

test('an oversized file is refused with a reason instead of breaking the tab', () => {
  const A = app();
  const r = A.attach.attach(fakeFile('huge.mp4', 'video/mp4', A.attach.MAX_BYTES + 1, ''));
  assert.ok(r.error, 'refused');
  assert.match(r.error, /paperclip stops at 40\.0 MB/);
  assert.equal(A.attach.count(), 0, 'and nothing was kept');
});

test('reading a text attachment is local, and an unreadable one returns nothing', async () => {
  const A = app();
  const t = A.attach.attach(fakeFile('notes.txt', 'text/plain', 10, 'line one\nline two'));
  const p = A.attach.attach(fakeFile('photo.png', 'image/png', 10, ''));
  assert.equal(await A.attach.text(t.id), 'line one\nline two');
  assert.equal(await A.attach.text(p.id), null, 'no pretending to read a picture');
  assert.equal(await A.attach.text('nope'), null);
});

test('everything readable is gathered for the brain, capped and labelled', async () => {
  const A = app();
  A.attach.attach(fakeFile('a.txt', 'text/plain', 10, 'alpha'));
  A.attach.attach(fakeFile('b.md', 'text/markdown', 10, 'beta'));
  A.attach.attach(fakeFile('c.png', 'image/png', 10, ''));
  const all = await A.attach.textAll();
  assert.match(all, /--- a\.txt ---\nalpha/);
  assert.match(all, /--- b\.md ---\nbeta/);
  assert.ok(!all.includes('c.png'), 'the picture is not silently included');
  A.attach.attach(fakeFile('big.txt', 'text/plain', 10, 'x'.repeat(5000)));
  const capped = await A.attach.textAll(100);
  assert.ok(capped.length <= 200, 'the cap is respected');
});

test('removing and clearing are quiet when there is nothing to remove', () => {
  const A = app();
  assert.equal(A.attach.remove('ghost'), false);
  assert.equal(A.attach.clear(), 0);
  const events = [];
  A.on('attach:changed', e => events.push(e));
  const r = A.attach.attach(fakeFile('x.txt', 'text/plain', 4, 'x'));
  assert.equal(A.attach.remove(r.id), true);
  assert.equal(A.attach.count(), 0);
  assert.equal(events.length, 2, 'you hear about both the add and the remove');
  assert.equal(A.attach.summary(), 'Nothing is attached right now.');
});

test('the picker offers photo, video, document and PDF — and index.html agrees', () => {
  const A = app();
  assert.deepEqual(plain(A.attach.KINDS).map(k => k.id), ['photo', 'video', 'document', 'pdf']);
  for (const need of ['image/*', 'video/*', 'application/pdf', '.docx', '.txt']) {
    assert.ok(A.attach.ACCEPT.includes(need), `the picker accepts ${need}`);
  }
  /* A button that opens a picker with a different list than the module
     says would be a promise the file dialog cannot keep. */
  const html = readApp('index.html');
  const accept = (html.match(/id="attachInput"[^>]*accept="([^"]+)"/) || [])[1] || '';
  for (const need of ['image/*', 'video/*', 'application/pdf', '.docx', '.txt']) {
    assert.ok(accept.includes(need), `index.html accept list is missing ${need}`);
  }
});

/* ---------- what the paperclip is actually for ---------- */

test('the message the brain receives carries the description and the readable text', async () => {
  const A = app();
  A.attach.attach(fakeFile('notes.txt', 'text/plain', 10, 'alpha beta gamma'));
  A.attach.attach(fakeFile('photo.jpg', 'image/jpeg', 10, ''));
  const lines = A.attach.describe();
  const body = await A.attach.textAll(6000);
  assert.match(lines.join('\n'), /notes\.txt/);
  assert.match(body, /--- notes\.txt ---\nalpha beta gamma/);
  assert.ok(!body.includes('photo.jpg'), 'the picture contributes its description, never fake content');
});

test('"summarize this" is answered on-device from the attached text', async () => {
  const A = app();
  assert.equal(A.brain.route('summarize this').kind, 'summarize');
  assert.equal(A.brain.route('tldr please').kind, 'summarize');

  const text = 'The first sentence carries the most weight here. '
    + 'The second sentence repeats the words that matter for the score. '
    + 'The third says something else entirely and mentions nothing useful. '
    + 'The fourth sentence closes the paragraph neatly.';
  const message = 'summarize this\n\n📎 notes.txt — document, text/plain, 120 B (text I can read on-device)\n\n--- notes.txt ---\n' + text;
  const reply = await A.brain.handle(message);
  assert.match(reply, /^📄 /);
  assert.ok(reply.length < text.length, 'a summary is shorter than what it summarizes');
});

test('with nothing readable it says what to do instead of inventing a summary', async () => {
  const A = app();
  const reply = await A.brain.handle('summarize this');
  assert.match(reply, /attach a \.txt, \.md or \.csv/);
  assert.match(reply, /A photo or a PDF cannot be read on this device/);
});
