/* ============================================================
 * Aevion Skills — math, translation, study, code knowledge
 * Called by the brain and by Studio views.
 * ============================================================ */
(function () {
  const S = {};

  /* ---------- safe math ---------- */
  S.math = function (expr) {
    const t = (expr || '').replace(/^(?:calculate|what is|what's|compute|=)\s*/i, '').replace(/[?]/g, '').trim();
    // the allowed set must match what the message below promises
    if (!/^[-+*/%^().\d\s]+$/.test(t)) return "I can only evaluate plain numbers and operators (+ - * / ^ %).";
    let e = t.replace(/\^/g, '**');
    try {
      const v = Function('"use strict"; return (' + e + ')')();
      if (typeof v !== 'number' || !isFinite(v)) return "That didn't compute to a finite number.";
      return `= ${v}`;
    } catch { return "I couldn't parse that expression."; }
  };

  /* ---------- translation ----------
     The language list lives in core.js so the settings dropdown and the
     translate skill can never disagree. LANGS is the code → English name map
     the matcher below wants ("translate hi into spanish"). */
  const LANGS = {};
  (Aevion.languages || []).forEach(l => { LANGS[l.code] = l.english || l.label; });

  S.parseTranslate = function (text) {
    /* "translate hello to tamil" / "translate hi into spanish" / "translate
       good morning into Haitian Creole". The target is allowed to be two
       words, because some languages are named with two (Haitian Creole,
       Bahasa Indonesia) and refusing them would be the skill's fault, not
       the user's. */
    const m = text.match(/translate\s+(.+?)\s+(?:to|into|in)\s+([^\s]{2,20}(?:\s+[^\s]{2,20})?)\s*$/i);
    if (!m) return null;
    const targetKey = m[2].toLowerCase().replace(/\s+/g, ' ').trim();
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
    csharp: { emoji: '🎯', note: '.NET language: LINQ, async/await, properties. dotnet build / dotnet test. NuGet for packages.' },
    ruby: { emoji: '💎', note: 'Expressive, everything is an object. Blocks & symbols. gem/bundler; rails for web.' },
    dart: { emoji: '🎯', note: 'Null-safe, compiled to native or JS. Flutter for UI. pub for packages, dart test.' },
    powershell: { emoji: '🪟', note: 'Object-based Windows shell. Cmdlets Verb-Noun, pipelines pass objects. Get-Help.' },
    lua: { emoji: '🌙', note: 'Tiny embeddable scripting language. Tables are the only structure. Used in games & nvim.' },
    r: { emoji: '📊', note: 'Statistics-first. Vectors are the unit; data.frame for tables. CRAN packages.' },
    kotlin: { emoji: '🤖', note: 'Concise JVM language; official for Android. Null-safety built in.' },
    php: { emoji: '🐘', note: 'Server-side web scripting. Composer for deps. Modern: PHP 8+ JIT.' },
    bash: { emoji: '🐚', note: 'Shell scripting: variables, pipes |, conditionals. Quote "$vars".' }
  };

  S.codeLangs = () => Object.keys(CODE);

  /* ---------- language detection (offline, ordered most-specific first) ----------
     Scores a snippet against the signature of each language rather than
     trusting a single keyword, so "const x" alone is not proof of JS. */
  const SIGNATURES = [
    ['typescript', [/\binterface\s+\w+/, /:\s*(string|number|boolean)\b/, /\btype\s+\w+\s*=/, /<[A-Z]\w*>/, /\benum\s+\w+/]],
    ['python', [/^\s*def\s+\w+\s*\(/m, /^\s*import\s+\w+/m, /:\s*$/m, /\bprint\(/, /\belif\b/, /__name__/]],
    ['javascript', [/\bconst\b|\blet\b|\bvar\b/, /=>/, /\bfunction\b/, /console\.log/, /require\(/, /\bawait\b/]],
    ['java', [/\bpublic\s+(static\s+)?\w+\s+\w+\s*\(/, /\bimport\s+java\./, /System\.out\.print/]],
    ['kotlin', [/\bfun\s+\w+\s*\(/, /\bval\b|\bvar\b/, /\bdata\s+class\b/, /\bprintln\(/]],
    ['csharp', [/\busing\s+System\b/, /\bnamespace\b/, /\bpublic\s+class\b.*\n.*\{/s, /Console\.WriteLine/]],
    ['cpp', [/#include\s*<(iostream|vector|string)>/, /\bstd::/, /\btemplate\s*</, /\bcout\b/]],
    ['c', [/#include\s*<(stdio|stdlib|string)\.h>/, /\bprintf\s*\(/, /\bmalloc\s*\(/, /\bint\s+main\s*\(/]],
    ['rust', [/\bfn\s+\w+\s*\(/, /\blet\s+mut\b/, /\bimpl\b/, /println!/, /\bpub\s+fn\b/]],
    ['go', [/\bpackage\s+\w+/, /\bfunc\s+\w+\s*\(/, /\bfmt\./, /:=/]],
    ['swift', [/\bfunc\s+\w+\s*\([^)]*\)\s*->/, /\bvar\s+\w+\s*:\s*\w+/, /\blet\s+\w+\s*=/, /\bimport\s+(Foundation|SwiftUI|UIKit)\b/]],
    ['php', [/<\?php/, /\$\w+\s*=/, /\becho\s+/, /\bfunction\s+\w+\s*\(/]],
    ['ruby', [/^\s*def\s+\w+$/m, /\bend\b/, /\bputs\b/, /\brequire\s+['"]/, /\bdo\s*\|/]],
    ['dart', [/\bvoid\s+main\s*\(\s*\)/, /\bWidget\b/, /\bfinal\s+\w+/, /\bimport\s+['"]package:/]],
    ['sql', [/\bSELECT\b[\s\S]*\bFROM\b/i, /\bINSERT\s+INTO\b/i, /\bCREATE\s+TABLE\b/i, /\bUPDATE\b[\s\S]*\bSET\b/i]],
    ['powershell', [/\bGet-\w+/, /\$\w+\s*=/, /\bWrite-Host\b/, /\bparam\s*\(/]],
    ['bash', [/^#!\/.*sh/, /\becho\s+["$]/, /\bfi\b/, /\bdo\b/, /\$\{?\w+\}?/, /\|\s*grep\b/]],
    ['html', [/<(!DOCTYPE|html|div|body|head|span|p)\b/i]],
    ['css', [/[.#]?[\w-]+\s*\{[^}]*:[^}]*;/s, /@media\b/, /\bdisplay\s*:/]],
    ['json', [/^\s*[{[][\s\S]*[}\]]\s*$/, /"[\w-]+"\s*:/]],
    ['yaml', [/^\s*[\w-]+:\s*$/m, /^\s*-\s+\w+/m, /^\s{2,}\w+:/m]],
    ['markdown', [/^#{1,6}\s+\w/m, /\*\*[^*]+\*\*/, /^\s*[-*]\s+\w/m, /\[[^\]]+\]\([^)]+\)/]]
  ];

  S.detectLanguage = function (code) {
    const c = String(code || '');
    if (!c.trim()) return 'unknown';
    let best = { lang: 'unknown', score: 0 };
    for (const [lang, rules] of SIGNATURES) {
      let hits = 0;
      for (const re of rules) if (re.test(c)) hits++;
      // require a decent share of the signature, and prefer the densest match
      const score = hits / rules.length + hits * 0.15;
      if (hits > 0 && score > best.score) best = { lang, score };
    }
    return best.score >= 0.4 ? best.lang : (best.score > 0 ? best.lang : 'unknown');
  };
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

  /* ---------- text operations the offline brain can really do ----------
     Small, exact and honestly local: counting, case, order, de-duplication,
     word frequency. Each one answers a plain request exactly, and each one
     returns null when there is no body to work on — so a sentence *about*
     text is never mistaken for a request to change some. */
  S.textOp = function (text) {
    const t = String(text || '');
    const lower = t.toLowerCase();
    const quoted = (t.match(/[«"“”']([^"”']{1,2000})["”'»]/) || [])[1];
    const afterColon = t.includes(':') ? t.slice(t.indexOf(':') + 1).trim() : '';
    const body = String(quoted || afterColon || '').trim();
    if (!body) return null;
    const has = re => re.test(lower);
    const local = s => s + '\n\n(Done here on this device — no AI, and nothing was sent.)';

    if (has(/\b(how many (words|characters|letters|lines)|word count|character count|count the (words|characters|lines))\b/)) {
      const words = body.split(/\s+/).filter(Boolean).length;
      const lines = body.split(/\r?\n/).length;
      const longest = body.split(/\s+/).reduce((m, w) => Math.max(m, w.length), 0);
      return local(`📄 ${words} word${words === 1 ? '' : 's'}, ${body.length} character${body.length === 1 ? '' : 's'}, ${lines} line${lines === 1 ? '' : 's'} (longest word ${longest}).`);
    }
    if (has(/\b(uppercase|upper case|all caps)\b/)) return local('🔠 ' + body.toUpperCase());
    if (has(/\b(lowercase|lower case)\b/)) return local('🔡 ' + body.toLowerCase());
    if (has(/\b(reverse|backwards)\b/)) return local('↔️ ' + [...body].reverse().join(''));
    if (has(/\bword frequency\b|\bmost (used|common) words\b/)) {
      const words = body.toLowerCase().match(/[a-z0-9']+/g) || [];
      if (words.length < 3) return null;
      const counts = new Map();
      words.forEach(w => counts.set(w, (counts.get(w) || 0) + 1));
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5);
      return local('📊 Most used words: ' + top.map(([w, n]) => `${w} ×${n}`).join(', '));
    }
    const linesOf = () => body.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (has(/\b(sort|order)\b[^.!?]{0,20}\b(lines?|alphabetical|a-z)\b|\balphabetical\b/)) {
      const l = linesOf();
      if (l.length < 2) return null;
      return local('🔤 Sorted:\n' + l.slice().sort((a, b) => a.localeCompare(b)).join('\n'));
    }
    if (has(/\b(remove|drop|delete) (the )?(duplicates?|repeated lines?)\b|\bdedupe\b/)) {
      const l = linesOf();
      if (l.length < 2) return null;
      const seen = new Set();
      const keep = [];
      for (const x of l) { const k = x.toLowerCase(); if (!seen.has(k)) { seen.add(k); keep.push(x); } }
      const dropped = l.length - keep.length;
      return local(`🧹 ${dropped} duplicate line${dropped === 1 ? '' : 's'} removed:\n` + keep.join('\n'));
    }
    return null;
  };

  Aevion.skills = S;
})();
