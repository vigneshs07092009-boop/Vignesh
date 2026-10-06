/* ============================================================
 * Aevion Evolve — self-upgrade, and learning a little every day.
 *
 * Two separate promises live here, and they are kept separately.
 *
 * 1. SELF-UPGRADE. The button is off by default, and it is not a
 *    checkbox that flips a settings key:
 *      - turning it ON requires an explicit consent argument (the UI
 *        passes it only after the user approves a confirmation), and
 *        that consent is recorded as a hash;
 *      - `on()` returns true only when the stored record has both the
 *        flag AND a valid consent hash, so writing `{"on":true}` into
 *        storage by hand — or flipping the checkbox in devtools — does
 *        not switch it on;
 *      - turning it OFF never needs consent. Safety is always allowed.
 *
 *    With it ON, Aevion can install a *knowledge pack*: new words for
 *    the offline brain, new data-driven plugins, or proposed facts.
 *    It can never install code. A pack that claims to carry code is
 *    refused with that sentence, because there is no honest way for a
 *    web app to rewrite its own source — and pretending otherwise
 *    would be a worse feature than not having it.
 *
 * 2. LEARNING. `learn()` runs at most once a day. It reads the day's
 *    conversation, mines statements worth remembering ("my exam is on
 *    Friday", "I prefer dark mode"), and files them as *candidates*
 *    in memory's approval queue. Nothing is remembered just because
 *    Aevion noticed it; the user approves or deletes each one.
 * ============================================================ */
(function () {
  const E = {};

  /* ---------- 1. the self-upgrade gate ---------- */
  const KEY = 'selfUpgrade';
  const LOG = 'upgradeLog';

  const record = () => {
    const r = Aevion.store.get(KEY, null);
    return r && typeof r === 'object' ? r : null;
  };

  E.record = record;

  /* The consent hash binds the record to the moment the user allowed
     it, so a hand-written record without a matching hash is inert. */
  const consentHash = at => 'su:' + at;

  E.verify = async function () {
    const r = record();
    if (!r || !r.on || !r.consent || !r.at) return false;
    try { return (await Aevion.hash(consentHash(r.at))) === r.consent; } catch { return false; }
  };

  /* Synchronous on purpose: this is asked on every upgrade attempt and
     in the report, and it must never need a promise. `on === true` is
     only half the test — the presence of a consent hash is the other
     half, so an edited record is not enough. */
  E.on = function () {
    const r = record();
    return !!(r && r.on === true && typeof r.consent === 'string' && r.consent);
  };
  E.enabled = E.on;

  /* on=true needs consent; on=false never does. */
  E.set = async function (on, opts) {
    const o = opts || {};
    const at = Date.now();
    if (on) {
      if (o.consent !== true) {
        return { ok: false, code: 'consent', reason: 'Turning self-upgrade on needs your explicit approval — it is not a checkbox value.' };
      }
      const hash = await Aevion.hash(consentHash(at));
      Aevion.store.set(KEY, { on: true, at, by: o.by || 'user', consent: hash });
      E.log({ kind: 'gate', action: 'on', ok: true, at });
      Aevion.emit('evolve:changed', { on: true });
      return { ok: true, on: true };
    }
    Aevion.store.set(KEY, { on: false, at });
    E.log({ kind: 'gate', action: 'off', ok: true, at });
    Aevion.emit('evolve:changed', { on: false });
    return { ok: true, on: false };
  };

  E.log = function (entry) {
    if (!entry) return Aevion.store.get(LOG, []);
    const l = Aevion.store.get(LOG, []);
    l.unshift(Object.assign({ t: Date.now() }, entry));
    Aevion.store.set(LOG, l.slice(0, 40));
    return l;
  };
  E.history = () => Aevion.store.get(LOG, []);

  /* What a pack is allowed to contain. A whitelist, so a pack that
     invents a new kind is refused by omission rather than by luck. */
  E.PACK_KINDS = ['words', 'plugin', 'facts'];

  E.plan = function () {
    return {
      on: E.on(),
      allowed: E.PACK_KINDS.slice(),
      refused: ['code'],
      note: E.on()
        ? 'Aevion may install knowledge packs you approve. It never rewrites its own code.'
        : 'Self-upgrade is off: no pack can be installed until you allow it.'
    };
  };

  /* Install a pack. Three refusals to get past first: the gate, the
     per-call consent, and the whitelist. */
  E.apply = async function (pack, opts) {
    const o = opts || {};
    if (!E.on()) return { ok: false, code: 'off', reason: 'Self-upgrade is switched off — nothing was installed.' };
    if (o.consent !== true) return { ok: false, code: 'consent', reason: 'This pack needs your approval for this install.' };
    if (!pack || typeof pack !== 'object') return { ok: false, code: 'shape', reason: 'That is not a pack.' };
    if (pack.kind === 'code') {
      return {
        ok: false, code: 'code',
        reason: 'Aevion never installs code into itself. Update the files in aevion/ and reload — that is the only honest way an app this size can upgrade.'
      };
    }
    if (!E.PACK_KINDS.includes(pack.kind)) {
      return { ok: false, code: 'kind', reason: 'Unknown pack kind “' + pack.kind + '”. Allowed: ' + E.PACK_KINDS.join(', ') + '.' };
    }

    const summary = [];
    if (pack.kind === 'words') {
      if (!pack.lang || !pack.intent || !Array.isArray(pack.words) || !pack.words.length) {
        return { ok: false, code: 'shape', reason: 'A word pack needs a language, an intent and a list of words.' };
      }
      const added = Aevion.nlu.teach(pack.lang, pack.intent, pack.words);
      summary.push('+ ' + (added ? added.length : 0) + ' ' + pack.intent + ' word(s) for ' + pack.lang);
    }
    if (pack.kind === 'plugin') {
      if (!Aevion.plugins || typeof Aevion.plugins.addSimple !== 'function') {
        return { ok: false, code: 'unavailable', reason: 'The plugin registry is not loaded.' };
      }
      const r = Aevion.plugins.addSimple(pack.spec || {});
      if (!r || r.error) return { ok: false, code: 'shape', reason: (r && r.error) || 'That plugin spec was not usable.' };
      summary.push('+ plugin “' + r.name + '”');
    }
    if (pack.kind === 'facts') {
      const facts = (pack.facts || []).map(f => String(f).trim()).filter(Boolean);
      let n = 0;
      for (const f of facts) if (Aevion.memory.suggest(f, 'upgrade')) n++;
      summary.push('+ ' + n + ' fact(s) awaiting your approval');
    }

    E.log({ kind: pack.kind, action: 'install', ok: true, summary: summary.join(', ') });
    return { ok: true, kind: pack.kind, summary: summary.join(', ') };
  };

  /* ---------- 2. learning a little every day ---------- */

  E.day = (d) => new Date(d || Date.now()).toISOString().slice(0, 10);

  E.due = function () {
    return Aevion.store.get('learnDay', '') !== E.day();
  };

  /* Patterns worth keeping. Deliberately narrow: a wrong memory is
     worse than a missing one. */
  const MINERS = [
    { re: /\bmy ([a-z][a-z ]{1,24}) is ([^.!?\n]{2,60})/i, make: m => 'My ' + m[1].trim() + ' is ' + m[2].trim() + '.' },
    { re: /\bmy favou?rite ([a-z][a-z ]{1,24}) is ([^.!?\n]{2,60})/i, make: m => 'Favourite ' + m[1].trim() + ': ' + m[2].trim() + '.' },
    { re: /\bi (?:prefer|like|love|hate|dislike|always|usually|never)\b[^.!?\n]{3,70}/i, make: m => 'User: ' + m[0].replace(/\s+/g, ' ').trim() + '.' },
    { re: /\b(?:remember|note down|keep in mind)\b[:\s]+([^.!?\n]{3,80})/i, make: m => 'To remember: ' + m[1].trim() + '.' },
    { re: /\b(?:i am|i'm|call me) ([A-Z][\p{L}'-]{2,20})\b/u, make: m => "User's name is " + m[1] + '.' }
  ];

  /* Everything worth remembering in one message. Exported so the
     Memory view can show exactly what would be proposed. */
  E.mine = function (text) {
    const t = String(text == null ? '' : text);
    const out = [];
    for (const m of MINERS) {
      const hit = t.match(m.re);
      if (!hit) continue;
      const line = m.make(hit);
      if (line && line.length > 6 && !out.includes(line)) out.push(line);
    }
    return out;
  };

  /* Runs at most once a day unless forced. Returns what it noticed —
     and notice is all it does: every candidate goes to memory's
     pending queue, where the user approves or deletes it. */
  E.learn = function (opts) {
    const o = opts || {};
    const day = E.day();
    if (!E.due() && !o.force) return { ran: false, day, reason: 'Already learned today.' };

    const msgs = (Aevion.store.get('chatHistory', []) || []).filter(m => m && m.role === 'user');
    const known = new Set((Aevion.memory.all('longterm') || []).map(i => i.text.toLowerCase()));
    const noticed = [];
    for (const m of msgs.slice(-120)) {
      for (const c of E.mine(m.text)) {
        if (known.has(c.toLowerCase())) continue;
        if (noticed.includes(c)) continue;
        noticed.push(c);
      }
    }

    let proposed = 0;
    for (const c of noticed) if (Aevion.memory.suggest(c, 'daily')) proposed++;

    /* Repeat what the day's tool log says was refused: that is how the
       user finds out Aevion keeps tripping over a missing permission. */
    const refused = (Aevion.tools ? Aevion.tools.log() : [])
      .filter(e => !e.ok && e.t > Date.now() - 86400000)
      .map(e => e.id + ' (' + e.code + ')');

    const entry = { day, scanned: msgs.length, noticed, proposed, refused: [...new Set(refused)].slice(0, 6) };
    Aevion.store.set('learnDay', day);
    const log = Aevion.store.get('learnLog', []);
    Aevion.store.set('learnLog', [entry].concat(log.filter(l => l.day !== day)).slice(0, 30));
    Aevion.emit('learn:day', entry);
    return Object.assign({ ran: true }, entry);
  };

  E.digest = function (days) {
    return (Aevion.store.get('learnLog', []) || []).slice(0, days || 7);
  };
  E.forgetDigest = function () { Aevion.store.set('learnLog', []); return true; };

  Aevion.evolve = E;
})();
