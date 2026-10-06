/* ============================================================
 * Aevion Brain — intent routing + local NLU + response building
 * The brain decides: answer locally, run a skill, use memory,
 * call the online AI (only if permitted), or hand off to voice.
 * ============================================================ */
(function () {
  const B = {};
  const now = () => new Date();

  const RULES = [
    { re: /^\/?help\b/i, kind: 'help' },
    { re: /^\s*(?:list|show)\s+(?:the\s+)?languages\b/i, kind: 'languages' },
    { re: /^\/?clear\b/i, kind: 'clear' },
    { re: /\b(what(?:'| i)?s? the time|current time|what time is it|tell me the time)\b/i, kind: 'time' },
    { re: /\b(what(?:'s| is)? (?:the )?date|today'?s date)\b/i, kind: 'date' },
    { re: /\bhi\b|\bhello\b|\bhey\b|^yo\b/i, kind: 'greet' },
    { re: /\b(who are you|your name)\b/i, kind: 'whoami' },
    { re: /\b(what can you do|capabilit|features)\b/i, kind: 'features' },
    { re: /\bthank/i, kind: 'thanks' },
    { re: /\b(what do you (?:know|remember) about (?:me|my))\b/i, kind: 'recall' },
    { re: /\b(remember|note down|save this)[:\s]/i, kind: 'remember' },
    { re: /^\s*(?:add\s+(?:a\s+)?task|todo|remind me to)\b[:\s]/i, kind: 'task' },
    { re: /^\s*(?:note|add note|new note)[:\s]/i, kind: 'note' },
    { re: /\b(?:list|show|what are)\s+(?:my\s+)?(?:tasks|todos)\b/i, kind: 'tasks' },
    { re: /^\s*(?:status|system status|diagnostics|sysinfo)\b/i, kind: 'status' },
    { re: /\b(my name is|i am called|call me)\b/i, kind: 'setname' },
    { re: /\btranslate\b/i, kind: 'translate' },
    /* Timers first: "set a timer for 5 minutes" must never reach the
       calculator, which would happily evaluate the "5" on its own. */
    { re: /^\s*(?:list|show|what are)\s+(?:my\s+)?timers\b/i, kind: 'timerlist' },
    { re: /^\s*(?:stop|cancel|clear)\s+(?:all\s+)?timers?\b/i, kind: 'timerstop' },
    { re: /\b(?:set\s+(?:a\s+)?timer|timer|remind me in)\b/i, kind: 'timer' },
    /* With a .txt/.md/.csv attached (or the text pasted after a colon)
       this is answered by the on-device summarizer — no provider. */
    { re: /\b(summaris|summariz|tldr|tl;dr|shorten|gist)\w*\b/i, kind: 'summarize' },
    { re: /\bcalculate|math\b/i, kind: 'math' },
    { re: /[-+*/^().\d\s]{3,}/, kind: 'math-maybe' },
    { re: /\b(open|launch|start)\s+site\b/i, kind: 'open-site' },
    { re: /\b(privacy|what data|collect)\b/i, kind: 'privacy' },
    { re: /\b(joke|make me laugh)\b/i, kind: 'joke' },
    { re: /\b(flip a coin|coin flip)\b/i, kind: 'coin' },
    { re: /\b(roll a dice|dice roll|d6)\b/i, kind: 'dice' },
    { re: /\bweather\b/i, kind: 'weather' },
    { re: /\b(search|look up)\b/i, kind: 'search' }
  ];

  /* Routing order, and why it is this way round:
       1. The multilingual table (js/nlu.js) first — but it only answers
          when a non-Latin script or a non-English app language is in play,
          so pure-English behaviour is byte-for-byte what it always was.
       2. The English rules below, exactly as before.
       3. Open chat. */
  B.route = function (text) {
    const t = (text || '').trim();
    if (!t) return { kind: 'empty' };
    const n = Aevion.nlu ? Aevion.nlu.route(t) : null;
    if (n) return Object.assign({ raw: t }, n);
    for (const r of RULES) if (r.re.test(t)) return { kind: r.kind, raw: t };
    return { kind: 'chat', raw: t };
  };

  /* ---------- small local "personality" ---------- */
  const GREET = ["Hey! Aevion online and local. What do you need?", "Hello! Systems nominal — how can I help?", "Hi! Ready when you are."];
  const THANKS = ["Anytime.", "Always here.", "You got it."];
  const JOKES = [
    "Why do programmers prefer dark mode? Because light attracts bugs.",
    "There are 10 types of people: those who understand binary and those who don't.",
    "I'd tell you a UDP joke, but you might not get it.",
    "Why did the developer go broke? He used up all his cache."
  ];
  const pick = a => a[Math.floor(Math.random() * a.length)];

  /* ---------- speaking the user's language ----------
     `lang` is set by js/nlu.js when it recognized a request in a language
     other than English. Everything below still works when it is absent:
     the English string is the answer, so a missing translation degrades to
     English instead of to silence. */
  function localized(m) { return !!(m && m.lang && m.lang !== 'en'); }
  function say(m, key, english) {
    return localized(m) && Aevion.nlu ? Aevion.nlu.say(m.lang, key, english) : english;
  }
  function jokeFor(m) {
    if (!Aevion.nlu) return pick(JOKES);
    const list = Aevion.nlu.jokes(localized(m) ? m.lang : 'en');
    return pick(list.length ? list : JOKES);
  }
  /* The arithmetic hiding inside a sentence, in whatever language and
     whatever digits it was typed in. Empty string when there is none. */
  function expressionOf(m) {
    if (!m) return '';
    if (m.expression) return m.expression;
    return Aevion.nlu ? Aevion.nlu.cleanMath(m.raw, m.lang) : '';
  }

  /* Tools are permission-gated and may refuse — a refusal is an answer,
     not a crash, so it is turned into readable text here. */
  async function tool(id, args) {
    try {
      const r = await Aevion.tools.run(id, args);
      return r.output;
    } catch (e) {
      return e.code === 'confirm'
        ? `⚠ ${e.message} Approve it in the Tools view when you're ready.`
        : `⚠ ${e.message}`;
    }
  }

  /* Preferences the user states in passing are *noticed*, never assumed:
     they land in the prefs layer unapproved and stay out of recall until
     the user approves them in the Memory view. */
  function noticePreferences(text) {
    try {
      if (!Aevion.settings.memory) return;
      const m = String(text || '').match(/\b(?:i (?:prefer|like|love|always|usually|hate|dislike|never)|my favou?rite)\b[^.!?\n]{3,80}/i);
      if (!m) return;
      Aevion.memory.suggest(m[0].trim().replace(/[.,!]+$/, ''), 'inferred');
    } catch { /* never let noticing break the reply */ }
  }

  function personaWrap(s) {
    const p = Aevion.settings.persona;
    if (p === 'concise') return s.split('\n')[0];
    if (p === 'friendly') return '😊 ' + s;
    if (p === 'formal') return s.replace(/\bcan't\b/g, 'cannot').replace(/\bI'm\b/g, 'I am');
    return s;
  }

  /* ---------- handlers ---------- */

  /* What an attachment contributed to the message: the composer puts one
     📎 description line per file, then the readable content under a
     "--- name ---" header, so the body is everything after the first one. */
  function attachedText(raw) {
    const t = String(raw || '');
    const i = t.indexOf('--- ');
    if (i < 0) return '';
    const nl = t.indexOf('\n', i);
    return nl < 0 ? '' : t.slice(nl + 1).trim();
  }

  const H = {
    empty: () => "Say something and I'll process it locally.",

    help: () =>
      "Aevion commands & skills:\n" +
      "• Math — type any expression: (45*12)+9/3\n" +
      "• \"remember: I like coffee\" — store a fact (see the Memory view)\n" +
      "• \"add task: revise calculus Friday\", \"note: call the bank\", \"status\"\n" +
      "• \"what do you remember about me?\"\n" +
      "• \"translate <text> to <language>\" or use 🌐 mode\n" +
      "• \"time\" / \"date\"\n" +
      "• \"set a timer for 10 minutes\" / \"list timers\" / \"stop timers\"\n" +
      "• \"weather\" (needs location + online permission)\n" +
      "• \"search <query>\" (needs online permission)\n" +
      "• \"open site <name>\"\n" +
      "• Markdown renders — **bold**, *italic*, `code`, lists, tables and fenced code blocks (code gets syntax colors + a Copy button)\n" +
      "• /clear — reset the conversation\n" +
      "• \"teach a command\" — in 🎤 Voice you can add your own words for any language\n" +
      "Studio: quizzes, flashcards, pomodoro, code tools.\n" +
      "Offline command coverage: " + (Aevion.nlu ? Aevion.nlu.coverage().length : 0) +
      " languages (time, date, greetings, jokes, notes, tasks, timers and math) — \"list languages\".\n" +
      "Everything runs on-device unless you allow online features.",

    clear: (m) => { Aevion.emit('chat:clear'); return say(m, 'clear', 'Conversation cleared.'); },

    /* The clock and the calendar are read in the caller's own numerals
       when they are not in English — a Tamil question about the time
       should not answer in English digits. */
    time: (m) => '🕒 ' + (localized(m) ? Aevion.nlu.time(m.lang) : now().toLocaleTimeString()),

    date: (m) => '📅 ' + (localized(m)
      ? Aevion.nlu.date(m.lang)
      : now().toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })),

    greet: (m) => say(m, 'greet', pick(GREET)),

    whoami: () => `I'm ${Aevion.settings.name} — your local-first assistant. I run in your browser/WebView, store data on this device only, and use the internet only when you allow it.`,

    features: () =>
      "Here's my toolkit:\n" +
      "• 💬 Chat (local brain, optional online AI)\n" +
      "• 🎓 Studio — quizzes, summaries, flashcards, pomodoro, code tools\n" +
      "• 🗂️ Organizer — tasks & notes\n" +
      "• 📁 Files — private on-device vault\n" +
      "• ⚡ Automations — launch-time routines\n" +  // eslint-disable-line
      "• 🔗 Devices — password-protected pairing & sync\n" +
      "• 🧩 Plugins — extend me with new skills\n" +
      "• 🔒 Permission manager, PIN lock, full data export/wipe",

    thanks: (m) => say(m, 'thanks', pick(THANKS)),

    /* Which languages the offline brain can answer in right now, and
       which of them still have gaps — the honest version, not a boast. */
    languages: () => {
      if (!Aevion.nlu) return "Language coverage is unavailable in this build.";
      const cov = Aevion.nlu.coverage();
      const full = Aevion.nlu.INTENTS.length;
      const rich = cov.filter(c => c.intents >= full).map(c => c.label);
      const part = cov.filter(c => c.intents < full).map(c => c.label);
      return '🗣 Offline commands work in ' + cov.length + ' languages.\n' +
        '• Fully covered (' + rich.length + '): ' + rich.join(', ') + '\n' +
        '• Core commands only (' + part.length + '): ' + part.join(', ') + '\n' +
        'Anything beyond this needs an AI provider — or teach me the words yourself in 🎤 Voice.';
    },

    privacy: () =>
      "Privacy model:\n" +
      "• All data stays in this device's local storage — nothing is transmitted.\n" +
      "• Online AI/search only run after you enable them in Settings and grant permission.\n" +
      "• Voice stays on-device (browser speech APIs); no cloud wake-word service.\n" +
      "• You can export or wipe everything from Settings.",

    joke: (m) => jokeFor(m),
    coin: () => "🪙 " + (Math.random() < .5 ? "Heads" : "Tails"),
    dice: () => "🎲 " + (1 + Math.floor(Math.random() * 6)),

    setname: (m) => {
      const n = m.raw.replace(/.*(?:my name is|i am called|call me)\s*/i, '').split(/[.,!]/)[0].trim();
      if (!n) return "What should I call you?";
      Aevion.memory.add(`User's name is ${n}.`, 'profile');
      return `Noted — nice to meet you, ${n}! (Saved to local memory.)`;
    },

    remember: (m) => {
      const fact = m.raw.replace(/^.*?(?:remember|note down|save this)[:,]?\s*/i, '').trim();
      if (!fact) return "Tell me what to remember, e.g. \"remember: my exam is on Friday\".";
      const saved = Aevion.memory.add(fact);
      return saved ? `Stored locally: “${saved}”` : "I already know that one.";
    },

    recall: () => {
      const items = Aevion.memory.all();
      if (!items.length) return "My local memory is empty so far.";
      return "From local memory:\n" + items.slice(-10).map(i => "• " + i.text).join('\n');
    },

    task: (m) => {
      const t = m.raw.replace(/^.*?\b(?:add\s+(?:a\s+)?task|todo|remind me to)\b[:\s]*/i, '').replace(/^to\s+/i, '').trim();
      if (!t) return 'What should the task be? e.g. "add task: revise calculus Friday"';
      const due = (t.match(/\b(\d{4}-\d{2}-\d{2})\b/) || [])[1] || '';
      return tool('tasks.add', { text: due ? t.replace(due, '').trim() : t, due });
    },

    note: (m) => {
      const t = m.raw.replace(/^\s*(?:note|add note|new note)[:\s]*/i, '').trim();
      if (!t) return 'What should I note down?';
      return tool('notes.add', { text: t });
    },

    tasks: () => tool('tasks.list'),

    status: () => tool('system.status'),

    /* Shorten a document that came in with the paperclip, or text pasted
       after the word. Entirely local, and honest when there is nothing to
       read — a PDF or a photo cannot be read here, and saying so is the
       answer, not an excuse. */
    summarize: (m) => {
      const pasted = m.raw.replace(/^.*?\b(?:summari[sz]e|tldr|tl;dr|shorten|gist)\w*\b[:\s]*/i, '').trim();
      const body = attachedText(m.raw) || pasted;
      const mode = /\b(short|brief|one line)\b/i.test(m.raw) ? 'short'
        : /\b(long|detail|thorough)\b/i.test(m.raw) ? 'long' : 'medium';
      if (body.length < 40) {
        return 'Give me something to shorten: attach a .txt, .md or .csv with 📎 and say “summarize this”, or paste the text after “summarize:”. A photo or a PDF cannot be read on this device, and I will not pretend otherwise.';
      }
      return '📄 ' + Aevion.skills.summarize(body, mode);
    },

    /* Math in any language. The expression is extracted by js/nlu.js,
       which knows the local "how much is…" words and folds every
       script's digits to 0-9 first; for English the sentence goes to the
       calculator the way it always has. */
    math: (m) => Aevion.skills.math(expressionOf(m) || m.raw),

    'math-maybe': (m) => {
      if (m.expression) return Aevion.skills.math(m.expression);
      // strip the conversational dressing first, so "what is 2+2?" actually
      // reaches the calculator instead of falling through to open chat
      const t = m.raw.trim()
        .replace(/^(?:what\s+is|what's|whats|how much is|calculate|compute|solve|eval)\s*/i, '')
        .replace(/[?=]+/g, '')
        .trim();
      if (/^[\d\s+\-*/().^%]+$/.test(t)) return Aevion.skills.math(t);
      return null; // fall through to chat
    },

    /* ---------- timers ---------- */
    timer: (m) => {
      const d = Aevion.nlu ? Aevion.nlu.duration(m.raw, m.lang) : null;
      if (!d) {
        return say(m, 'timerAsk', 'For how long? Try “set a timer for 10 minutes” — or “ಟೈಮರ್ 5 ನಿಮಿಷ”.');
      }
      const when = new Date(Date.now() + d.ms).toLocaleTimeString();
      /* Seconds only: the tool adds minutes and seconds together, so
         passing both would set twice the length the user asked for. */
      return tool('timer.start', {
        seconds: Math.round(d.ms / 1000),
        label: m.raw.replace(/\s+/g, ' ').slice(0, 60)
      }).then(out => out + ' (rings at ' + when + ')');
    },

    timerlist: () => tool('timer.list'),
    timerstop: () => tool('timer.clear'),

    translate: (m) => Aevion.skills.translate(m.raw),

    /* Open conversation with no brain reachable. It tries what is genuinely
       local first (memory that really matches, a language in my own notes,
       text I can actually operate on) and only then admits it cannot. The
       canned apology is the last resort, not the first answer. */
    chat: (m) => B.localChat(m.raw),

    'open-site': (m) => {
      if (!Aevion.perms.get('automation')) return "Grant the Automation permission in Settings → Privacy first.";
      const name = m.raw.replace(/.*open\s+(?:site\s+)?/i, '').trim().toLowerCase();
      const sites = { youtube: 'https://youtube.com', google: 'https://google.com', github: 'https://github.com', gmail: 'https://mail.google.com', maps: 'https://maps.google.com', wikipedia: 'https://wikipedia.org' };
      const url = sites[name] || (name.startsWith('http') ? name : 'https://' + name + '.com');
      window.open(url, '_blank', 'noopener');
      return `Opening ${name}… (requested by you, on your device)`;
    },

    weather: async () => {
      if (!Aevion.perms.get('geolocation')) return "Enable Location permission in Settings → Privacy first.";
      if (!Aevion.settings.onlineSearch) return "Enable “Allow online search” in Settings first — I keep everything offline by default.";
      try {
        const pos = await new Promise((res, rej) => navigator.geolocation.getCurrentPosition(res, rej, { timeout: 8000 }));
        const { latitude: la, longitude: lo } = pos.coords;
        const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${la}&longitude=${lo}&current=temperature_2m,wind_speed_10m,weather_code`);
        const j = await r.json();
        const c = j.current;
        const desc = { 0: 'clear sky', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 51: 'light drizzle', 61: 'rain', 63: 'heavy rain', 71: 'snow', 80: 'showers', 95: 'thunderstorm' }[c.weather_code] || 'conditions ' + c.weather_code;
        return `🌤 ${c.temperature_2m}°C, ${desc}, wind ${c.wind_speed_10m} km/h (open-meteo.com, no API key)`;
      } catch (e) { return "Couldn't fetch weather: " + e.message; }
    },

    search: async (m) => {
      if (!Aevion.settings.onlineSearch) return "Enable “Allow online search” in Settings first.";
      const q = m.raw.replace(/^(?:search|look up)\s*(?:for)?\s*/i, '').trim();
      if (!q) return "What should I search for?";
      const sites = { google: 'https://www.google.com/search?q=', ddg: 'https://duckduckgo.com/?q=', bing: 'https://www.bing.com/search?q=' };
      const eng = sites[Aevion.store.get('searchEngine', 'ddg')];
      window.open(eng + encodeURIComponent(q), '_blank', 'noopener');
      return `Searching the web for “${q}” — opened in a new tab (search engines see only that query).`;
    }
  };

  /* ---------- main entry ---------- */
  B.handle = async function (text) {
    const m = B.route(text);
    noticePreferences(text);
    const h = H[m.kind];

    if (!h) return B.chatFallback(m.raw);
    const out = await h(m);
    if (out === null) return B.chatFallback(m.raw);
    if (typeof out === 'string') return personaWrap(out);
    return out;
  };

  /* ---------- open conversation, offline ----------
     Returns a real answer, or null the moment there is nothing honest to
     add — so the fallback below still gets to speak. Nothing here guesses:
     every branch answers from something that is actually on this device. */
  B.localChat = function (text) {
    const raw = String(text || '').trim();
    const lower = raw.toLowerCase();
    if (!raw) return null;

    /* 1. Something you told me before, when the question is about you. */
    const hits = Aevion.memory.recall(raw, { limit: 2 });
    const strong = hits.filter(h => (h.score || 0) >= 0.9);
    if (strong.length && /\b(what|who|where|when|which|my|mine|remember|know|about|prefer|favourite|favorite)\b/.test(lower)) {
      return 'From your own memory on this device: ' + strong.map(h => h.text).join(' · ') +
        '\n\n(Recalled locally — no AI was asked, and nothing was sent anywhere.)';
    }

    /* 2. A language in my local notes, when the *language itself* is the
       question: “what is python”, “explain rust”, “python basics”. Asking
       about pointers in C is a different question, and my note on C is not
       an answer to it — so the match is anchored, not a word hunt, and a
       real question falls through to the honest fallback instead of being
       answered with a note about something else. */
    const lang = Aevion.skills.codeLangs().find(l => new RegExp('\\b' + l + '\\b', 'i').test(lower));
    if (lang) {
      const about = new RegExp(
        '^(?:(?:what|which)\\s+is|tell\\s+me\\s+about|explain|learn|study|notes?\\s+on|about)\\s+(?:the\\s+)?(?:programming\\s+)?(?:language\\s+)?' + lang + '\\b[\\s?.!]*$|^' + lang + '\\s+(?:basics|notes|language)\\b[\\s?.!]*$',
        'i');
      if (about.test(raw.trim())) {
        return Aevion.skills.codeNote(lang) + '\n\n(Same note the Code Tools tab shows — part of the offline brain.)';
      }
    }

    /* 3. Text I can really operate on: counts, case, order, reverse. */
    const op = Aevion.skills.textOp ? Aevion.skills.textOp(raw) : null;
    if (op) return op;

    return null;
  };

  /* ---------- local fallback chat ---------- */
  B.chatFallback = function (text) {
    // Scored, cross-layer recall — the old substring-join lookup here never
    // matched anything, so this line is now real (and only when relevant).
    const hits = Aevion.memory.recall(text, { limit: 2 });
    const memLine = hits.length ? "\n\n(From memory: " + hits.map(i => i.text).join('; ') + ")" : '';
    /* Naming the actual fault is the whole point: "the AI is not working"
       needs to read as one specific thing that is one tap away from fixed. */
    const note = Aevion.setup ? Aevion.setup.note() : '';
    return personaWrap(
      'No brain answered that one' + (note ? ' — ' + note : '') + '. So this is answered locally, by the offline brain, which is not a stub: ' +
      'math, times and dates, timers, notes, tasks, translation, summarising text you attach or paste, my code notes, ' +
      'your memory, and everything in /help.\n\n' +
      'For open questions, any of these takes one tap — the card above the box checks which this device can do, and ' +
      'Settings → AI provider has the same engine and the “Set up AI” shortcut:\n' +
      '• 🧠 In-browser model — press “Download the in-browser model”. Runs on your GPU, then works offline for good.\n' +
      '• 🖥 A server on this PC — press “Look for a server on this PC” (Ollama, LM Studio, llama.cpp).\n' +
      '• 🔑 A free hosted key — press “Free hosted key (Groq)” and paste it once.' + memLine
    );
  };

  Aevion.brain = B;
})();
