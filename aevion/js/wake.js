/* ============================================================
 * Aevion Wake — hands-free activation by name ("Hey Aevion…").
 *
 * What this does, in plain words:
 *   - You turn it ON (Voice tab). Until you do, the microphone is
 *     never opened by this module at all.
 *   - While it is on, Aevion keeps a recognizer running and waits for
 *     its name, or a greeting followed by its name, at the START of
 *     what you say. "Hey Aevion, what's the weather", "Hayy Aevion
 *     tell me a joke", "Yo Aevion what is 2+2" — all wake it up and
 *     run the request straight away.
 *   - Name (or greeting + name) on its own: it answers with a short
 *     cue and treats your NEXT sentence as the request, so you never
 *     have to say the name twice.
 *   - After it replies, a short window stays open: keep talking and
 *     the next sentence is taken as a new request without the name.
 *   - Talking over the reply stops it mid-sentence (barge-in). If what
 *     you said was more than "stop", that sentence becomes the new
 *     request instead of being thrown away.
 *
 * Name handling:
 *   - The assistant's own name is configurable (Appearance → Assistant
 *     name). Default is "Aevion". Whatever you type there is what it
 *     answers to — that is the nickname support.
 *   - Recognizers mangle names, so the matcher tolerates a small edit
 *     distance and a table of phonetic neighbours of the default name.
 *   - Any greeting word at the START ('hey', 'hi', 'hay', 'yo', 'ok',
 *     'hayy', ...) followed by the name wakes it. So does a bare name.
 *   - The name must still be *addressed*, not mentioned: "what does
 *     aevion mean" does NOT wake anything.
 *
 * Honest limits, because a wake word is where assistants usually cheat:
 *   - Recognising a name needs an *always-on* recognizer, which costs
 *     battery and (on Android) usually sends audio to the OS speech
 *     service. So this mode is OFF by default, says so, stops itself
 *     after a period with no interaction, and pauses whenever the page
 *     is hidden.
 *   - A true low-power wake word needs a dedicated engine (Porcupine,
 *     openWakeWord) in a native shell. In the browser we can only run a
 *     recognizer in a loop; on Android the native plugin is tap-to-talk,
 *     so `supported()` reports that honestly instead of pretending.
 * ============================================================ */
(function () {
  const W = {};

  const STATES = ['off', 'armed', 'heard', 'capturing', 'thinking', 'speaking', 'paused'];

  W.config = {
    followupMs: 6000,        // after a reply: how long "keep talking" stays open
    captureMs: 8000,         // how long a request may take after the name
    idleStopMs: 3 * 60000,   // no interaction for this long → switch itself off
    backoffMin: 400,         // recognizer crashed? wait before restarting
    backoffMax: 8000,
    // Words that mean "stop talking" rather than "here is a new request".
    stopWords: ['stop', 'stop it', 'shut up', 'quiet', 'hush', 'silence', 'cancel', 'never mind', 'nevermind'],
    // How the name is expected to arrive. Recognizers mangle names, so the
    // matcher also allows a small edit distance (see tokenMatch).
    greetings: ['hey', 'hi', 'hay', 'hei', 'hai', 'hii', 'yo', 'ok', 'okay', 'hello', 'hayy', 'haii', 'heyo', 'hie', 'heyy'],
    // Phonetic variants of the configured name. If the user calls themself
    // "Aevion", recognizers may hear "Aveon", "Avion", "Aevian", etc.
    variants: { aevion: ['aevion', 'aevian', 'aveon', 'avion', 'aevon', 'aevionn', 'aveion', 'ayevon'] }
  };

  let recognition = null;
  let state = 'off';
  let enabled = false;
  let backoff = W.config.backoffMin;
  let restartTimer = null;
  let captureTimer = null;
  let followupTimer = null;
  let idleTimer = null;
  let speakTimer = null;
  let heardName = false;       // in this utterance, did we already see the name/greeting?
  let mode = null;             // 'command' => name/greeting already given, take everything
  let followupOpen = false;    // after a reply: keep talking without repeating the name
  let lastCommandAt = 0;
  const log = [];

  /* ---------- engine ---------- */
  const SR = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;

  /* Native (Android) speech is tap-to-talk on its own, but the native
     SpeechPlugin grounds a real continuous recognizer here, so the wake
     word can run honestly in the app (planned for the native shell).
     Say so instead of faking it. */
  const Native = (typeof window !== 'undefined' && window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Speech)
    ? window.Capacitor.Plugins.Speech : null;

  W.supported = function () {
    if (!SR && !Native) return { ok: false, reason: 'This browser has no speech recognition. Chrome, Edge or the Aevion app are needed.' };
    if (Native) return { ok: true };
    if (!SR) return { ok: false, reason: 'The browser has no browser-side speech recognition — try the Aevion app.' };
    return { ok: true };
  };

  W.state = () => state;
  W.isAwake = () => state === 'capturing' || state === 'heard';
  W.log = () => log.slice();

  function setState(next, why) {
    if (state === next) return;
    const from = state;
    state = next;
    log.push({ t: Date.now(), from, to: next, why: why || '' });
    if (log.length > 50) log.shift();
    Aevion.emit('wake:state', { state: next, from, reason: why || '' });
  }

  function note(why) {
    if (log.length > 60) log.shift();
    log.push({ t: Date.now(), from: state, to: state, why });
  }

  const strip = s => String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  /* ================= name + greeting matching =================
     Deliberately strict about WHERE the name appears: Siri only responds
     when it is addressed, so the name must be the first thing said, or be
     preceded by a greeting. "what does aevion mean" must not wake it. */

  /* The user's name expanded into everything that should wake Aevion.
     The default name is "aevion" and the variants table lists common
     mishearings. A custom name (any nickname) matches itself; add its
     mishearings to `variants` and they match too. */
  W.nameVariants = function () {
    const raw = strip(Aevion.settings && Aevion.settings.name ? Aevion.settings.name : 'aevion') || 'aevion';
    const base = raw.replace(/\s+/g, '');
    const extra = W.config.variants[base] || [];
    return [...new Set([base, ...extra])];
  };
  W.variation = W.nameVariants;   // kept: older callers used this spelling

  W.greetingWords = function () {
    return W.config.greetings.slice();
  };

  function editDistance(a, b) {
    if (a === b) return 0;
    if (Math.abs(a.length - b.length) > 2) return 3;
    const prev = new Array(b.length + 1);
    const cur = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
      cur[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      }
      for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
    }
    return prev[b.length];
  }

  /* Tolerant, but scaled: short words must match exactly, longer ones may
     be one or two characters off ("averion" for "aevion"). */
  function tokenMatch(token, target) {
    if (!token || !target) return false;
    if (token === target) return true;
    const threshold = target.length >= 6 ? 2 : target.length >= 5 ? 1 : 0;
    return threshold > 0 && editDistance(token, target) <= threshold;
  }

  /* -> { matched, command, matchedWord, name, kind }
     kind: 'name' | 'name+command' | 'greeting+name' | 'greeting+name+command'
     `command` is what was asked for — the name and greeting are stripped,
     because the assistant should not have to parse its own name out of
     the request. */
  W.matchesAddress = function (text) {
    const tokens = strip(text).split(' ').filter(Boolean);
    if (!tokens.length) return { matched: false };

    const names = W.nameVariants();
    const greetings = W.greetingWords();
    const first = tokens[0];

    const nameAt = idx => {
      if (!tokens[idx]) return null;
      for (const n of names) {
        if (tokenMatch(tokens[idx], n)) return { matchedWord: tokens[idx], name: n };
      }
      return null;
    };

    // Bare name first: "Aevion" or "Aevion tell me a joke"
    const bare = nameAt(0);
    if (bare) {
      return {
        matched: true,
        matchedWord: bare.matchedWord,
        name: bare.name,
        kind: tokens.length === 1 ? 'name' : 'name+command',
        command: tokens.slice(1).join(' ')
      };
    }

    /* Greeting then name: "Hey Aevion", "Hayy Aevion tell me a joke".
       Recognizers slip a filler in ("hey um aevion…"), so the name may
       sit a couple of tokens later — but only within the opening three,
       or "hey, did you see aevion today?" would fire a request. */
    if (greetings.includes(first)) {
      for (let i = 1; i <= Math.min(3, tokens.length - 1); i++) {
        const after = nameAt(i);
        if (!after) continue;
        const rest = tokens.slice(i + 1).join(' ');
        return {
          matched: true,
          matchedWord: after.matchedWord,
          name: after.name,
          kind: rest ? 'greeting+name+command' : 'greeting+name',
          command: rest
        };
      }
      return { matched: false };
    }

    /* A greeting on its own is NOT enough: otherwise every "hey" in the
       room would wake it. The name has to be there. */
    return { matched: false };
  };

  W.isStopWord = function (text) {
    return W.config.stopWords.includes(strip(text));
  };

  /* ================= lifecycle ================= */

  function arm(delay) {
    clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      if (!enabled || state === 'paused') return;
      startRecognizer();
    }, delay || 0);
  }

  function startRecognizer() {
    if (!enabled || recognition) return;
    if (!SR) { W.disable('no speech recognition'); return; }
    let r;
    try { r = new SR(); } catch (e) { backoff = Math.min(W.config.backoffMax, backoff * 2); note('engine threw: ' + e.message); arm(backoff); return; }

    r.lang = (Aevion.voice && Aevion.voice.langTag)
      ? Aevion.voice.langTag()
      : (Aevion.settings.speechLang || Aevion.settings.lang || 'en-US');
    r.continuous = true;
    r.interimResults = Aevion.settings.speechInterim !== false;
    r.maxAlternatives = 1;

    r.onstart = () => { backoff = W.config.backoffMin; setState(heardName || mode ? 'capturing' : 'armed', 'recognizer started'); };

    r.onresult = e => {
      const result = e.results[e.results.length - 1];
      const text = result[0] && result[0].transcript ? result[0].transcript : '';
      if (!text.trim()) return;
      Aevion.emit('voice:partial', text.trim());
      if (result.isFinal === false) return;
      handleUtterance(text.trim(), true);
    };

    r.onerror = e => {
      const code = (e && e.error) || 'unknown';
      note('recognizer error: ' + code);
      Aevion.emit('wake:error', { code, text: Aevion.voice ? Aevion.voice.errorText(code) : code });
      // A hard failure must not spin: back off, and give up on permission errors.
      if (code === 'not-allowed' || code === 'service-not-allowed') { W.disable('microphone not allowed'); return; }
      backoff = Math.min(W.config.backoffMax, Math.max(W.config.backoffMin, backoff * 2));
    };

    r.onend = () => {
      recognition = null;
      if (!enabled) return;
      // The browser ends the session after silence; restart with backoff so a
      // broken engine cannot become a hot loop.
      if (state === 'capturing' && mode) {
        // A request is still expected: keep that state, just restart listening.
        arm(backoff);
        return;
      }
      setState(heardName ? 'heard' : 'armed', 'recognizer ended');
      arm(backoff);
    };

    recognition = r;
    try { r.start(); }
    catch (e) { recognition = null; backoff = Math.min(W.config.backoffMax, backoff * 2); note('start failed: ' + e.message); arm(backoff); }
  }

  function stopRecognizer() {
    clearTimeout(restartTimer);
    if (!recognition) return;
    const r = recognition;
    recognition = null;
    try { r.onend = null; r.onerror = null; r.abort(); } catch { /* already gone */ }
  }

  function bumpIdle() {
    lastCommandAt = Date.now();
    clearTimeout(idleTimer);
    if (!enabled) return;
    idleTimer = setTimeout(() => {
      W.disable('no interaction for a while — wake mode stopped itself to save battery');
      Aevion.emit('wake:idle');
    }, W.config.idleStopMs);
  }

  /* ================= the conversation flow ================= */

  function startCapture() {
    clearTimeout(captureTimer);
    setState('capturing', 'listening for a request');
    captureTimer = setTimeout(() => {
      // Nothing said: go quiet again, still armed for the name.
      Aevion.emit('wake:timeout');
      heardName = false;
      mode = null;
      setState('armed', 'no request heard');
    }, W.config.captureMs);
  }

  /* After a reply: the next sentence is a new request, name optional.
     Short by design — an unbounded window would answer the room. */
  function openFollowup() {
    clearTimeout(followupTimer);
    followupOpen = true;
    followupTimer = setTimeout(() => {
      followupOpen = false;
      note('follow-up window closed');
    }, W.config.followupMs);
  }

  function closeFollowup() {
    clearTimeout(followupTimer);
    followupOpen = false;
  }

  function resetRequest() {
    heardName = false;
    mode = null;
    clearTimeout(captureTimer);
  }

  /* Called by app.js once a reply has been delivered. */
  W.notifyReplyDone = function () {
    if (!enabled) return;
    clearTimeout(speakTimer);
    /* If the user interrupted, we are already listening — do not undo that. */
    if (state === 'capturing') return;
    setState('armed', 'reply finished — waiting for the name, or a follow-up');
    openFollowup();
  };

  /* Called by app.js just before it starts speaking the reply. The window is
     estimated from the text length too, so barge-in and the return to "armed"
     still work on engines that never report speech completion. */
  W.notifySpeaking = function (text) {
    if (!enabled) return;
    const ms = Math.min(30000, 1200 + String(text == null ? '' : text).length * 55);
    clearTimeout(speakTimer);
    setState('speaking', 'speaking the reply');
    speakTimer = setTimeout(() => W.notifyReplyDone(), ms);
  };

  function handleUtterance(text, isFinal) {
    const hit = W.matchesAddress(text);

    if (state === 'speaking') {
      /* Barge-in: the user talked over the reply. Their sentence is either
         "stop" or the next request — dropping it would feel broken. */
      try { Aevion.voice.shutup(); } catch { /* nothing playing */ }
      clearTimeout(speakTimer);
      closeFollowup();

      if (W.isStopWord(text)) {
        note('barge-in: stop');
        Aevion.emit('wake:barged', { text, action: 'stop' });
        if (enabled) setState('armed', 'stopped by voice');
        return;
      }

      note('barge-in: taking the interruption as a request');
      Aevion.emit('wake:barged', { text, action: 'request' });
      if (hit.matched && hit.command) { W.emitCommand(hit.command, true); return; }
      if (hit.matched) { acknowledge(hit); return; }
      W.emitCommand(text, false);
      return;
    }

    if (mode === 'command' || heardName) {
      // The name was already given: this sentence is the request, whatever it is.
      resetRequest();
      W.emitCommand(text, false);
      return;
    }

    if (hit.matched) {
      bumpIdle();
      if (hit.command) { W.emitCommand(hit.command, true); return; }
      acknowledge(hit);
      return;
    }

    if (followupOpen && isFinal) {
      // After a reply the user can just keep talking.
      closeFollowup();
      W.emitCommand(text, false);
      return;
    }

    if (isFinal) note('ignored (not addressed): ' + text.slice(0, 40));
  }

  /* Name, or greeting + name, on its own: cue the user and get ready. */
  function acknowledge(hit) {
    heardName = true;
    mode = 'command';
    closeFollowup();
    setState('heard', 'name or greeting recognised');
    Aevion.emit('wake:heard', {
      word: hit.matchedWord,
      name: hit.name,
      kind: hit.kind
    });
    startCapture();
  }

  W.emitCommand = function (text, fromAddress) {
    const clean = String(text || '').trim();
    if (!clean) return false;
    resetRequest();
    closeFollowup();
    clearTimeout(speakTimer);
    /* Speech is stopped by whoever noticed the interruption (see
       handleUtterance) — doing it again here would cancel a reply that
       has not started yet. */
    bumpIdle();
    Aevion.emit('wake:command', { text: clean, fromAddress: !!fromAddress });
    setState('thinking', 'request: ' + clean.slice(0, 40));
    return true;
  };

  /* ================= public control ================= */

  W.enable = async function () {
    const support = W.supported();
    if (!support.ok) throw new Error(support.reason);
    if (enabled) return true;
    // Permission first, through the normal manager — never open the mic silently.
    if (!Aevion.perms.get('microphone')) {
      const r = await Aevion.perms.request('microphone');
      if (r !== 'granted') throw new Error('Microphone permission denied');
    }
    enabled = true;
    backoff = W.config.backoffMin;
    Aevion.settings.wake = true;
    Aevion.store.set('settings', Aevion.settings);
    bumpIdle();
    setState('armed', 'wake mode enabled by the user');
    startRecognizer();
    return true;
  };

  W.disable = function (why) {
    enabled = false;
    resetRequest();
    closeFollowup();
    clearTimeout(idleTimer);
    clearTimeout(speakTimer);
    stopRecognizer();
    if (Aevion.settings) {
      Aevion.settings.wake = false;
      Aevion.store.set('settings', Aevion.settings);
    }
    setState('off', why || 'wake mode disabled');
    return true;
  };

  /* Hiding the tab/window means nobody is talking to Aevion: pause the mic. */
  W.pause = function (why) {
    if (!enabled) return false;
    if (state === 'paused') return true;
    resetRequest();
    closeFollowup();
    stopRecognizer();
    setState('paused', why || 'paused');
    return true;
  };

  W.resume = function () {
    if (!enabled) return false;
    if (state === 'paused' || state === 'off') {
      setState('armed', 'resumed');
      startRecognizer();
    }
    return true;
  };

  W.reset = function () {
    stopRecognizer();
    resetRequest();
    closeFollowup();
    clearTimeout(idleTimer);
    clearTimeout(speakTimer);
  };

  W.STATES = STATES;
  Aevion.wake = W;
})();
