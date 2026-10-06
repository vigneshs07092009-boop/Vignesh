/* Tests for the automatic online ↔ offline shift (js/online.js).

   The promise is "it moves between the online and the offline brain by
   itself" — and the parts that make that trustworthy are the ones pinned
   here:

   - it never moves the user's own switches (session state only, and with
     auto-switch off the old "try it and fall back" behaviour is untouched);
   - it does not claim an outage when the user simply chose the local
     brain — local by choice is not the same as offline by necessity;
   - a failure cools down for a minute and is then *retried*, because a
     switch that gets stuck off is worse than no switch at all. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, plain } from './harness.mjs';

const app = (settings, opts) => createApp({ settings, ...opts });

test('auto-switch is on by default, and local by choice never reads as an outage', () => {
  const A = app().Aevion;
  assert.equal(plain(A.defaults.autoAI), true);
  assert.equal(plain(A.settings.autoAI), true);

  // online AI is off: the offline brain is the *choice*, not a fallback
  assert.equal(A.online.available(), true);
  assert.equal(A.online.status().mode, 'local');

  // ...even if something marked the endpoint down meanwhile
  A.online.markDown('connection refused');
  assert.equal(A.online.available(), true);
  assert.equal(A.online.status().mode, 'local');
});

test('with the network down it stops offering the online brain', () => {
  const up = app({ onlineAI: true }).Aevion;
  assert.equal(up.online.available(), true);
  assert.equal(up.online.status().mode, 'online');
  assert.equal(up.online.status().why, 'reachable');

  const down = app({ onlineAI: true }, { navigator: { onLine: false } }).Aevion;
  assert.equal(down.online.available(), false);
  assert.equal(down.online.status().mode, 'offline');
  assert.equal(down.online.status().why, 'no internet connection');
});

test('auto-switch off keeps the old behaviour: it always tries online', () => {
  const A = app({ onlineAI: true, autoAI: false }, { navigator: { onLine: false } }).Aevion;
  assert.equal(A.online.available(), true);
  assert.equal(A.online.status().mode, 'online');
  assert.equal(A.online.status().why, 'auto-switch is off');
});

test('a failing endpoint cools down for a minute, then is tried again', () => {
  const A = app({ onlineAI: true }).Aevion;
  const now = Date.now();

  const st = A.online.markDown('connection refused', now);
  assert.equal(st.mode, 'offline');
  assert.equal(st.why, 'connection refused');
  assert.ok(st.retryIn > 0 && st.retryIn <= 60000, 'says how long until the retry');

  assert.equal(A.online.down(), true);
  assert.equal(A.online.available(now + 1000), false);
  assert.equal(A.online.available(now + 59000), false, 'still cooling down half a minute later');

  // one minute on, the online brain is offered again — it must not stay off for good
  assert.equal(A.online.available(now + 61000), true);
  assert.equal(A.online.down(), false, 'the expired cooldown clears itself');
  assert.equal(A.online.available(now + 62000), true);
});

test('coming back is one call and reports the online mode again', () => {
  const A = app({ onlineAI: true }).Aevion;
  A.online.markDown('endpoint unreachable');
  assert.equal(A.online.available(), false);
  assert.equal(A.online.markUp().mode, 'online');
  assert.equal(A.online.available(), true);
  assert.equal(A.online.down(), false);
  assert.equal(A.online.status().why, 'reachable');
});

test('marking down twice keeps the latest reason without shortening the wait', () => {
  const A = app({ onlineAI: true }).Aevion;
  const now = Date.now();
  A.online.markDown('first', now - 30000);
  A.online.markDown('second', now - 5000);
  assert.equal(A.online.status().why, 'second');
  assert.equal(A.online.available(now), false, 'the fresh failure restarts the wait');
  assert.equal(A.online.available(now + 56000), true);
});
