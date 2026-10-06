/* Tests for the offline multilingual brain (js/nlu.js) and the routing it
   feeds (js/brain.js).

   The property that matters most is at the bottom of the file: adding a
   language must never change how English is handled, and a language Aevion
   has not been taught must return "no idea" rather than a guess. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, plain } from './harness.mjs';

const en = () => createApp().Aevion;
/* The app language is a setting, exactly like it is in the UI. */
const inLang = code => createApp({ settings: { lang: code } }).Aevion;

const kindOf = (Aevion, text) => Aevion.brain.route(text).kind;

/* ---------- digits ---------- */

test('every script\'s own digits fold to 0-9', () => {
  const A = en();
  assert.equal(A.nlu.digits('೨೦೨೪'), '2024');           // Kannada
  assert.equal(A.nlu.digits('௧௨௩'), '123');             // Tamil
  assert.equal(A.nlu.digits('౧౨౩'), '123');             // Telugu
  assert.equal(A.nlu.digits('१२३'), '123');             // Devanagari
  assert.equal(A.nlu.digits('一二三'), '一二三');         // Han numerals are not digits — left alone
  assert.equal(A.nlu.digits('١٢٣'), '123');             // Arabic-Indic
  assert.equal(A.nlu.digits('１２３'), '123');           // Fullwidth
  assert.equal(A.nlu.digits('2+2'), '2+2');             // ASCII is untouched
});

test('number words become digits, but only whole words', () => {
  const A = en();
  assert.equal(A.nlu.words2num('ಎರಡು + ಮೂರು', 'kn'), '2 + 3');
  assert.equal(A.nlu.words2num('दो + दो', 'hi'), '2 + 2');
  assert.equal(A.nlu.words2num('दोस्त + दो', 'hi'), 'दोस्त + 2', 'a friend is not a two');
  assert.equal(A.nlu.words2num('tres + tres', 'es'), '3 + 3');
  assert.equal(A.nlu.words2num('tres + tres', 'kn'), 'tres + tres', 'only the language in play is consulted');
});

/* ---------- script detection ---------- */

test('the script names the candidate language', () => {
  const A = en();
  assert.equal(A.nlu.detect('ಟೈಮರ್ ಹಾಕು').lang, 'kn');
  assert.equal(A.nlu.detect('நேரம் என்ன').lang, 'ta');
  assert.equal(A.nlu.detect('సమయం').lang, 'te');
  assert.equal(A.nlu.detect('समय क्या है').lang, 'hi');
  assert.equal(A.nlu.detect('what time is it').lang, null, 'Latin says nothing on its own');
  assert.deepEqual(plain(A.nlu.detect('কেমন আছেন').langs), ['bn', 'as'], 'a shared script offers both');
});

/* ---------- the four languages that were asked for ---------- */

test('Kannada: the basic commands are understood with no provider at all', () => {
  const A = inLang('kn');
  assert.equal(kindOf(A, 'ಸಮಯ ಎಷ್ಟು'), 'time');
  assert.equal(kindOf(A, 'ಇಂದಿನ ದಿನಾಂಕ'), 'date');
  assert.equal(kindOf(A, 'ನಮಸ್ಕಾರ'), 'greet');
  assert.equal(kindOf(A, 'ಧನ್ಯವಾದ'), 'thanks');
  assert.equal(kindOf(A, 'ಒಂದು ಜೋಕ್ ಹೇಳು'), 'joke');
  assert.equal(kindOf(A, 'ಟಿಪ್ಪಣಿ ಬರೆದಿಟ್ಟುಕೊ ಬೆಳಿಗ್ಗೆ ಓಡು'), 'note');
  assert.equal(kindOf(A, 'ನನ್ನ ಕೆಲಸಗಳು'), 'tasks');
  assert.equal(kindOf(A, 'ಟೈಮರ್ 5 ನಿಮಿಷ'), 'timer');
  assert.equal(kindOf(A, 'ಸಹಾಯ'), 'help');
  assert.equal(kindOf(A, 'ಭಾಷೆಗಳು'), 'languages');
});

test('Tamil, Telugu and Hindi: the same commands, in their own words', () => {
  const ta = inLang('ta');
  assert.equal(kindOf(ta, 'நேரம் என்ன'), 'time');
  assert.equal(kindOf(ta, 'வணக்கம்'), 'greet');
  assert.equal(kindOf(ta, 'நகைச்சுவை சொல்லு'), 'joke');
  assert.equal(kindOf(ta, 'குறிப்பு எழுதி வை'), 'note');
  assert.equal(kindOf(ta, 'டைமர் 10 நிமிடம்'), 'timer');

  const te = inLang('te');
  assert.equal(kindOf(te, 'సమయం ఎంత'), 'time');
  assert.equal(kindOf(te, 'నమస్కారం'), 'greet');
  assert.equal(kindOf(te, 'జోక్ చెప్పు'), 'joke');
  assert.equal(kindOf(te, 'నోట్ రాసి పెట్టు'), 'note');
  assert.equal(kindOf(te, 'టైమర్ 2 నిమిషం'), 'timer');

  const hi = inLang('hi');
  assert.equal(kindOf(hi, 'समय क्या है'), 'time');
  assert.equal(kindOf(hi, 'नमस्ते'), 'greet');
  assert.equal(kindOf(hi, 'एक चुटकुला सुनाओ'), 'joke');
  assert.equal(kindOf(hi, 'नोट करो दूध लाना है'), 'note');
  assert.equal(kindOf(hi, '5 मिनट का टाइमर लगाओ'), 'timer');
});

test('a script on its own is enough — the app language can stay English', () => {
  const A = en();                                  // settings.lang is 'en'
  assert.equal(kindOf(A, 'ಟೈಮರ್ 5 ನಿಮಿಷ'), 'timer');
  assert.equal(kindOf(A, 'நன்றி'), 'thanks');
  assert.equal(kindOf(A, 'నమస్కారం'), 'greet');
  assert.equal(kindOf(A, 'समय क्या है'), 'time');
});

/* ---------- math in any language ---------- */

test('math works spoken, in the local words, with the local digits', async () => {
  const A = inLang('kn');
  assert.equal(await A.brain.handle('ಎರಡು + ಎರಡು'), '= 4');
  assert.equal(await A.brain.handle('೨+೨'), '= 4');
  assert.equal(await A.brain.handle('ಎರಡು + ಎರಡು ಎಷ್ಟು'), '= 4');
  const ta = inLang('ta');
  assert.equal(await ta.brain.handle('மூன்று * மூன்று'), '= 9');
  const hi = inLang('hi');
  assert.equal(await hi.brain.handle('१० / ४'), '= 2.5');
  assert.equal(await hi.brain.handle('दस / चार'), '= 2.5');
});

test('an unparseable local sum fails honestly instead of inventing an answer', async () => {
  const A = inLang('kn');
  assert.match(await A.brain.handle('ಎರಡು +'), /parse|numbers and operators/);
});

/* ---------- timers ---------- */

test('a timer is understood in every language, with digits or words', () => {
  const A = en();
  assert.deepEqual(plain(A.nlu.duration('ಟೈಮರ್ 5 ನಿಮಿಷ', 'kn')), { ms: 300000, minutes: 5, unit: 'min', value: 5 });
  assert.equal(A.nlu.duration('10 நிமிடம் டைமர்', 'ta').ms, 600000);
  assert.equal(A.nlu.duration('टाइमर 2 घंटे', 'hi').ms, 7200000);
  assert.equal(A.nlu.duration('30 second timer', 'en').ms, 30000);
  assert.equal(A.nlu.duration('ಟೈಮರ್', 'kn'), null, 'no length means asking, not guessing');
  assert.equal(A.nlu.duration('', 'en'), null);
});

/* ---------- replies ---------- */

test('canned replies and jokes come back in the language that was used', () => {
  const A = en();
  assert.equal(A.nlu.say('kn', 'thanks'), 'ಪರವಾಗಿಲ್ಲ.');
  assert.equal(A.nlu.say('ta', 'thanks'), 'பரவாயில்லை.');
  assert.match(A.nlu.say('te', 'greet'), /^నమస్కారం/);
  assert.equal(A.nlu.say('xx', 'thanks', 'Anytime.'), 'Anytime.', 'an unknown language degrades to English');
  assert.ok(A.nlu.jokeLocalized('kn'));
  assert.ok(A.nlu.jokeLocalized('ta'));
  assert.ok(A.nlu.jokeLocalized('hi'));
  assert.ok(A.nlu.jokes('te').length >= 2);
  assert.ok(A.nlu.jokes('kl').length > 0, 'a language with no jokes still gets one, never silence');
});

test('time and date are read in the caller\'s own language tag', () => {
  const A = en();
  assert.equal(A.nlu.localeTag('kn'), 'kn-IN');
  assert.equal(A.nlu.localeTag('hi'), 'hi-IN');
  assert.ok(A.nlu.time('ta').length > 0);
  assert.ok(A.nlu.date('ta').length > 0);
});

/* ---------- teaching ---------- */

test('a language with only half a table can be completed without a code change', () => {
  const A = inLang('ur');
  assert.equal(A.nlu.route('کیریم کھیلو'), null, 'nothing in the table yet');
  A.nlu.teach('ur', 'joke', ['کیریم کھیلو']);
  const hit = A.nlu.route('کیریم کھیلو');
  assert.equal(hit.kind, 'joke');
  assert.equal(hit.lang, 'ur');
  assert.ok(A.nlu.words('ur', 'joke').includes('کیریم کھیلو'));
  assert.ok(plain(A.nlu.coverage()).some(c => c.code === 'ur'));
});

test('taught words survive a reload and can be taken back', () => {
  /* Spanish has no dice word in the shipped table, so this is a real gap
     being filled rather than a word that was already there. */
  assert.equal(createApp({ settings: { lang: 'es' } }).Aevion.nlu.route('tirar dados'), null);
  const first = createApp({ settings: { lang: 'es' } });
  first.Aevion.nlu.teach('es', 'dice', ['tirar dados']);
  const second = createApp({ storage: first.storage, settings: { lang: 'es' } });
  assert.equal(second.Aevion.brain.route('tirar dados').kind, 'dice', 'stored on the device');
  second.Aevion.nlu.forgetTaught();
  assert.equal(second.Aevion.nlu.route('tirar dados'), null, 'and forgettable');
  assert.equal(second.Aevion.brain.route('tirar dados').kind, 'chat', 'so it falls back to open chat again');
});

test('coverage reports how complete each language is, without flattering itself', () => {
  const A = en();
  const cov = plain(A.nlu.coverage());
  assert.ok(cov.length >= 30, 'the basic commands cover a lot of languages');
  const kn = cov.find(c => c.code === 'kn');
  assert.ok(kn.intents >= 20, 'Kannada is one of the fully covered ones');
  assert.equal(A.nlu.INTENTS.length, 28);
  const full = cov.filter(c => c.intents >= A.nlu.INTENTS.length).map(c => c.code);
  assert.ok(full.includes('hi') && full.includes('ta') && full.includes('te') && full.includes('kn'));
  assert.ok(full.length < cov.length, 'not every language claims everything');
});

/* ---------- English is not disturbed ---------- */

test('English routing is exactly what it was before the language tables existed', () => {
  const A = en();
  assert.equal(A.nlu.route('what time is it'), null, 'nlu stays out of the way for English');
  assert.equal(kindOf(A, 'what time is it'), 'time');
  assert.equal(kindOf(A, 'hello there'), 'greet');
  assert.equal(kindOf(A, 'what is 2+2'), 'math-maybe');
  assert.equal(kindOf(A, 'tell me a joke'), 'joke');
  assert.equal(kindOf(A, 'add task: revise calculus'), 'task');
  assert.equal(kindOf(A, 'who are you'), 'whoami');
  assert.equal(kindOf(A, 'some random sentence'), 'chat');
  assert.equal(A.brain.route('what time is it').lang, undefined, 'no language means the English path');
});

test('the same sentence in a language Aevion does not know falls through to chat', () => {
  const A = inLang('kn');
  assert.equal(kindOf(A, 'ಬರೆಯುವ ಕಾಗದ ಎಲ್ಲಿದೆ'), 'chat');
});
