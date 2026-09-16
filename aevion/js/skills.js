/* ============================================================
 * Aevion Skills — math, translation, study, code knowledge
 * Called by the brain and by Studio views.
 * ============================================================ */
(function () {
  const S = {};

  /* ---------- safe math ---------- */
  S.math = function (expr) {
    const t = (expr || '').replace(/^(?:calculate|what is|what's|compute|=)\s*/i, '').replace(/[?]/g, '').trim();
    if (!/^[-+*/^().\d\s]+$/.test(t)) return "I can only evaluate plain numbers and operators (+ - * / ^ %).";
    let e = t.replace(/\^/g, '**');
    try {
      const v = Function('"use strict"; return (' + e + ')')();
      if (typeof v !== 'number' || !isFinite(v)) return "That didn't compute to a finite number.";
      return `= ${v}`;
    } catch { return "I couldn't parse that expression."; }
  };

  /* ---------- translation ---------- */
  const LANGS = {
    en: 'English', hi: 'Hindi', ta: 'Tamil', te: 'Telugu', es: 'Spanish', fr: 'French',
    de: 'German', it: 'Italian', pt: 'Portuguese', ru: 'Russian', ja: 'Japanese',
    ko: 'Korean', zh: 'Chinese', ar: 'Arabic', bn: 'Bengali', ur: 'Urdu', mr: 'Marathi'
  };

  S.parseTranslate = function (text) {
    // "translate hello to tamil" / "translate hi into spanish"
    const m = text.match(/translate\s+(.+?)\s+(?:to|into|in)\s+([a-z]+)\s*$/i);
    if (!m) return null;
    const targetKey = m[2].toLowerCase();
    const target = Object.keys(LANGS).find(k => LANGS[k].toLowerCase() === targetKey || k === targetKey);
    return { text: m[1], target: target || null, targetLabel: LANGS[target] || m[2] };
  };

  S.translate = async function (text) {
    if (!Aevion.settings.onlineSearch) {
      return "Translation uses your browser's built-in online service. Enable “Allow online search” in Settings → Privacy first.";
    }
    const p = S.parseTranslate(text) || { text: text.replace(/^translate\s*/i, ''), target: Aevion.settings.lang === 'en' ? 'en' : Aevion.settings.lang, targetLabel: 'your language' };
    if (!p.target) return `I don't know the language "${p.targetLabel}". Try: ${Object.values(LANGS).join(', ')}.`;
    try {
      const r = await fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${p.target}&dt=t&q=${encodeURIComponent(p.text)}`);
      const j = await r.json();
      const out = (j[0] || []).map(x => x && x[0]).join('');
      return `🌐 ${p.targetLabel}: ${out}`;
    } catch (e) {
      return "Translation failed (offline or blocked): " + e.message;
    }
  };

  /* ---------- summarizer (extractive, fully offline) ---------- */
  S.summarize = function (text, mode) {
    const sents = text.replace(/\s+/g, ' ').match(/[^.!?]+[.!?]+/g) || [text];
    if (sents.length <= 2) return text.trim();
    const freq = {};
    const stop = new Set('the a an and or of to in is are was were for on with as by at it its this that be have has had not from you your'.split(' '));
    (text.toLowerCase().match(/[a-z']+/g) || []).forEach(w => { if (!stop.has(w) && w.length > 2) freq[w] = (freq[w] || 0) + 1; });
    const scored = sents.map((s, i) => {
      const words = s.toLowerCase().match(/[a-z']+/g) || [];
      const score = words.reduce((a, w) => a + (freq[w] || 0), 0) / Math.sqrt(words.length || 1) * (i === 0 ? 1.25 : 1);
      return { s: s.trim(), score, i };
    });
    const n = mode === 'short' ? Math.max(1, Math.round(sents.length * .2)) : mode === 'long' ? Math.max(2, Math.round(sents.length * .6)) : Math.max(1, Math.round(sents.length * .35));
    return scored.sort((a, b) => b.score - a.score).slice(0, n).sort((a, b) => a.i - b.i).map(x => '• ' + x.s).join('\n');
  };

  /* ---------- quiz generator (template-based, offline) ---------- */
  S.quiz = function (topic) {
    const t = (topic || 'general knowledge').trim();
    const T = [
      [t + " — what does it primarily involve?", "core concepts and principles of " + t],
      ["Which is the best first step when learning " + t + "?", "Build a small project using " + t + " basics"],
      ["True/False: " + t + " requires rote memorization only.", "False — practice and understanding beat memorization"],
      ["Name one real-world use of " + t + ".", "Any applied scenario — e.g. " + t + " in industry"],
      ["What's an effective way to test yourself on " + t + "?", "Active recall: explain it aloud or use flashcards"]
    ];
    return T;
  };

  /* ---------- code knowledge base (offline) ---------- */
  const CODE = {
    javascript: { emoji: '🟨', note: 'Single-threaded, event-driven. Use const/let, arrow fns, async/await. Ecosystem: Node.js, npm.' },
    python: { emoji: '🐍', note: 'Readable, batteries-included. Indentation matters. venv for isolation, pip for packages.' },
    typescript: { emoji: '🔷', note: 'JS + static types. Interfaces, generics, strict mode catches bugs early.' },
    html: { emoji: '🧱', note: 'Semantic structure: header, main, article, footer. Accessibility via alt, labels, landmarks.' },
    css: { emoji: '🎨', note: 'Cascade & specificity. Flexbox for 1-D, Grid for 2-D. Custom properties enable theming.' },
    java: { emoji: '☕', note: 'Class-based OOP, JVM. Compile with javac, run with java. Strong typing.' },
    c: { emoji: '⚙️', note: 'Manual memory (malloc/free), pointers, close to hardware. Compile with gcc.' },
    cpp: { emoji: '⚡', note: 'C + classes, RAII, STL containers. Compile with g++ -std=c++17.' },
    sql: { emoji: '🗄️', note: 'Declarative queries. SELECT … FROM … WHERE; JOIN to combine tables; index for speed.' },
    go: { emoji: '🐹', note: 'Simple, fast compiles, goroutines for concurrency. gofmt for style.' },
    rust: { emoji: '🦀', note: 'Ownership & borrowing prevent data races. cargo build/run. No GC.' },
    swift: { emoji: '🍎', note: 'Optionals, protocol-oriented. Xcode required for iOS builds.' },
    kotlin: { emoji: '🤖', note: 'Concise JVM language; official for Android. Null-safety built in.' },
    php: { emoji: '🐘', note: 'Server-side web scripting. Composer for deps. Modern: PHP 8+ JIT.' },
    bash: { emoji: '🐚', note: 'Shell scripting: variables, pipes |, conditionals. Quote "$vars".' }
  };

  S.codeLangs = () => Object.keys(CODE);
  S.codeNote = (lang) => CODE[lang] ? `${CODE[lang].emoji} ${lang.toUpperCase()} — ${CODE[lang].note}` : 'Language not in my local notes yet.';

  S.explainCode = function (code) {
    const c = code || '';
    const lines = c.split('\n').length;
    const chars = c.length;
    const hints = [];
    if (/function |=>/.test(c)) hints.push('function definition(s)');
    if (/\bconst\b|\blet\b|\bvar\b/.test(c)) hints.push('variable declarations');
    if (/\bclass\b/.test(c)) hints.push('a class');
    if (/async |await |promise|\.then/.test(c)) hints.push('asynchronous logic');
    if (/\bfor\b|\bwhile\b/.test(c)) hints.push('loop(s)');
    if (/\bif\b|\bswitch\b/.test(c)) hints.push('conditional(s)');
    if (/def /.test(c)) hints.push('Python function(s)');
    if (/#include|printf/.test(c)) hints.push('C/C++ includes/IO');
    if (/SELECT|INSERT|UPDATE|DELETE/i.test(c)) hints.push('SQL statement(s)');
    return `Code profile (local analysis):\n• ${lines} lines, ${chars} chars\n• Contains: ${hints.join(', ') || 'no strong signals detected'}\n\nTip: name functions by intent, keep functions < 30 lines, and add tests for edge cases.`;
  };

  Aevion.skills = S;
})();
