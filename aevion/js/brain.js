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
    { re: /^\/?clear\b/i, kind: 'clear' },
    { re: /\b(what(?:'| i)?s? the time|current time|what time is it|tell me the time)\b/i, kind: 'time' },
    { re: /\b(what(?:'s| is)? (?:the )?date|today'?s date)\b/i, kind: 'date' },
    { re: /\bhi\b|\bhello\b|\bhey\b|^yo\b/i, kind: 'greet' },
    { re: /\b(who are you|your name)\b/i, kind: 'whoami' },
    { re: /\b(what can you do|capabilit|features)\b/i, kind: 'features' },
    { re: /\bthank/i, kind: 'thanks' },
    { re: /\b(what do you (?:know|remember) about (?:me|my))\b/i, kind: 'recall' },
    { re: /\b(remember|note down|save this)[:\s]/i, kind: 'remember' },
    { re: /\b(my name is|i am called|call me)\b/i, kind: 'setname' },
    { re: /\btranslate\b/i, kind: 'translate' },
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

  B.route = function (text) {
    const t = (text || '').trim();
    if (!t) return { kind: 'empty' };
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

  function personaWrap(s) {
    const p = Aevion.settings.persona;
    if (p === 'concise') return s.split('\n')[0];
    if (p === 'friendly') return '😊 ' + s;
    if (p === 'formal') return s.replace(/\bcan't\b/g, 'cannot').replace(/\bI'm\b/g, 'I am');
    return s;
  }

  /* ---------- handlers ---------- */
  const H = {
    empty: () => "Say something and I'll process it locally.",

    help: () =>
      "Aevion commands & skills:\n" +
      "• Math — type any expression: (45*12)+9/3\n" +
      "• \"remember: I like coffee\" — store a fact\n" +
      "• \"what do you remember about me?\"\n" +
      "• \"translate <text> to <language>\" or use 🌐 mode\n" +
      "• \"time\" / \"date\"\n" +
      "• \"weather\" (needs location + online permission)\n" +
      "• \"search <query>\" (needs online permission)\n" +
      "• \"open site <name>\"\n" +
      "• /clear — reset the conversation\n" +
      "Studio: quizzes, flashcards, pomodoro, code tools.\n" +
      "Everything runs on-device unless you allow online features.",

    clear: () => { Aevion.emit('chat:clear'); return "Conversation cleared."; },

    time: () => "🕒 " + now().toLocaleTimeString(),

    date: () => "📅 " + now().toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),

    greet: () => pick(GREET),

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

    thanks: () => pick(THANKS),

    privacy: () =>
      "Privacy model:\n" +
      "• All data stays in this device's local storage — nothing is transmitted.\n" +
      "• Online AI/search only run after you enable them in Settings and grant permission.\n" +
      "• Voice stays on-device (browser speech APIs); no cloud wake-word service.\n" +
      "• You can export or wipe everything from Settings.",

    joke: () => pick(JOKES),
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

    math: (m) => Aevion.skills.math(m.raw),

    'math-maybe': (m) => {
      const t = m.raw.trim();
      if (/^[\d\s+\-*/().^%]+$/.test(t)) return Aevion.skills.math(t);
      return null; // fall through to chat
    },

    translate: (m) => Aevion.skills.translate(m.raw),

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
    const h = H[m.kind];

    if (!h) return B.chatFallback(m.raw);
    const out = await h(m);
    if (out === null) return B.chatFallback(m.raw);
    if (typeof out === 'string') return personaWrap(out);
    return out;
  };

  /* ---------- local fallback chat ---------- */
  B.chatFallback = function (text) {
    // memory-aware local reply
    const mem = Aevion.memory.find(text.split(/\s+/).filter(w => w.length > 3).slice(0, 3).join('|'));
    const memLine = mem.length ? "\n\n(From memory: " + mem.slice(0, 2).map(i => i.text).join('; ') + ")" : '';
    return personaWrap(
      "I processed that locally. My offline brain handles math, time, memory, translation, study tools, " +
      "and simple commands — for open conversation, connect an AI in Settings → Privacy (" +
      "Ollama runs fully on your PC with zero cost) or ask me a skill I know." + memLine
    );
  };

  Aevion.brain = B;
})();
