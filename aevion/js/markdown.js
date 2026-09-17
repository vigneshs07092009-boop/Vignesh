/* ============================================================
 * Aevion Markdown — chat rendering + syntax highlighting
 *
 * Zero dependencies, one file, no build step.
 *
 * Safety model (why this is XSS-proof):
 *   every character coming from a model/user is HTML-escaped
 *   BEFORE any markup is generated. The only tags emitted are
 *   the ones written literally in this file, and link targets
 *   are restricted to http(s)://, mailto: and #fragments.
 *
 * Everything degrades gracefully: unknown language, unclosed
 * fence, broken link — you still get clean readable text.
 * ============================================================ */
(function () {
  const M = {};
  Aevion.md = M;

  /* ============ escaping ============ */
  const ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ENT[c]);
  M.escape = esc;

  /* ============ syntax highlighting ============ */
  /* Each language is an ordered list of [cssClass, regex].
     Order matters: comments/strings first so keywords inside
     them are not re-highlighted. Rules must not use capture
     groups (use (?:…) ) so group indices stay predictable. */

  const K = words => new RegExp('\\b(?:' + words.trim().split(/\s+/).join('|') + ')\\b');

  // case-insensitive keywords (SQL) — expands "select" -> [Ss][Ee][Ll][Ee][Cc][Tt]
  const I = words => new RegExp('\\b(?:' + words.trim().split(/\s+/).map(w =>
    w.split('').map(c => /[a-z]/i.test(c) ? '[' + c.toUpperCase() + c.toLowerCase() + ']' : '\\' + c).join('')
  ).join('|') + ')\\b');

  const C_LINE = /\/\/[^\n]*/;
  const C_BOTH = /\/\*[\s\S]*?\*\/|\/\/[^\n]*/;
  const S_C = /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/;
  const S_TICK = /`(?:\\[\s\S]|[^`\\])*`/;
  const S_JS = /`(?:\\[\s\S]|[^`\\])*`|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/;
  const S_PY = /"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/;
  const S_MULTI = /"""[\s\S]*?"""|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/;
  const NUM = /\b0[xX][\da-fA-F]+\b|\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/;

  // shared builder for C-family style languages
  function mk(o) {
    const r = [];
    if (o.comment) r.push(['tok-cmt', o.comment]);
    if (o.string) r.push(['tok-str', o.string]);
    r.push(['tok-num', NUM]);
    if (o.kw) r.push(['tok-kw', o.kw]);
    if (o.extra) r.push(...o.extra);
    r.push(['tok-fn', /\b[A-Za-z_$][\w$]*(?=\s*\()/]);
    r.push(['tok-typ', /\b[A-Z][A-Za-z0-9_]*\b/]);
    r.push(['tok-op', /[+\-*/%=<>!&|^~?:]+/]);
    return r;
  }

  const JS_KW = 'const let var function return if else for while do switch case break continue class extends new delete typeof instanceof in of this super null undefined true false async await yield import export from default try catch finally throw static get set void debugger';

  const LANGS = {
    js: mk({
      comment: C_BOTH, string: S_JS,
      kw: K(JS_KW)
    }),
    ts: mk({
      comment: C_BOTH, string: S_JS,
      kw: K(JS_KW + ' interface type enum implements declare readonly private public protected abstract as satisfies keyof infer namespace is asserts override')
    }),
    py: mk({
      comment: /#[^\n]*/, string: S_PY,
      kw: K('def class return if elif else for while break continue import from as pass raise try except finally with lambda yield global nonlocal assert del in is not and or None True False self async await match case'),
      extra: [['tok-fn', /@[\w.]+/]]
    }),
    java: mk({
      comment: C_BOTH, string: S_MULTI,
      kw: K('abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while var record sealed permits yield true false null')
    }),
    c: mk({
      comment: C_BOTH, string: S_C,
      kw: K('auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while true false NULL')
    }),
    cpp: mk({
      comment: C_BOTH, string: S_C,
      kw: K('alignas alignof auto bool break case catch char class const constexpr continue decltype default delete do double else enum explicit export extern false float for friend goto if inline int long mutable namespace new noexcept nullptr operator override private protected public register return short signed sizeof static struct switch template this throw true try typedef typename union unsigned using virtual void volatile while'),
      extra: [['tok-fn', /\bstd::[A-Za-z_]\w*/]]
    }),
    cs: mk({
      comment: C_BOTH, string: S_MULTI,
      kw: K('abstract as base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new null object operator out override params private protected public readonly ref return sbyte sealed short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using var virtual void volatile while async await record')
    }),
    go: mk({
      comment: C_BOTH, string: /`[^`]*`|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/,
      kw: K('break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false make new len cap append copy delete panic recover error string int int64 int32 float64 float32 bool byte rune any err')
    }),
    rs: mk({
      comment: C_BOTH, string: /r#"(?:[^"]|"(?!#))*"#|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/,
      kw: K('as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while'),
      extra: [['tok-fn', /\b(?:std|core|alloc|self)::[A-Za-z_]\w*/], ['tok-typ', /\b[A-Z]\w*\b/]]
    }),
    php: mk({
      comment: /\/\*[\s\S]*?\*\/|\/\/[^\n]*|#[^\n]*/, string: S_C,
      kw: K('abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enum extends final finally fn for foreach function global goto if implements include include_once instanceof insteadof interface isset list match namespace new or print private protected public readonly require require_once return static switch throw trait try unset use var while xor yield true false null this self'),
      extra: [['tok-var', /\$[A-Za-z_]\w*/]]
    }),
    rb: mk({
      comment: /#[^\n]*/, string: /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|:[A-Za-z_]\w*/,
      kw: K('alias and begin break case class def do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield require attr_accessor puts new'),
      extra: [['tok-var', /@@?\w+|\$\w+/]]
    }),
    kt: mk({
      comment: C_BOTH, string: S_MULTI,
      kw: K('abstract actual annotation as break by catch class companion const constructor continue crossinline data delegate do dynamic else enum expect external final finally for fun get if import in infix init inline inner interface internal is lateinit noinline object open operator out override package private protected public reified return sealed set super suspend tailrec this throw try typealias val var vararg when where while true false null it')
    }),
    swift: mk({
      comment: C_BOTH, string: /"""[\s\S]*?"""|"(?:\\.|[^"\\\n])*"/,
      kw: K('associatedtype class deinit enum extension fileprivate func import init inout internal let open operator private protocol public static struct subscript typealias var break case continue default defer do else fallthrough for guard if in repeat return switch where while as catch is throw throws try await async actor some any nil true false self super')
    }),
    html: [
      ['tok-cmt', /<!--[\s\S]*?-->/],
      ['tok-tag', /<\/?[A-Za-z][\w:-]*|\/?>/],
      ['tok-str', /"[^"\n]*"|'[^'\n]*'/],
      ['tok-attr', /\b[A-Za-z_:][\w:.-]*(?=\s*=)/],
      ['tok-op', /[=<>/]/]
    ],
    css: [
      ['tok-cmt', /\/\*[\s\S]*?\*\//],
      ['tok-kw', /@[\w-]+/],
      ['tok-str', /"[^"\n]*"|'[^'\n]*'/],
      ['tok-num', /#[0-9a-fA-F]{3,8}\b|\b\d+(?:\.\d+)?(?:px|em|rem|%|vh|vw|vmin|vmax|s|ms|deg|fr|ch|pt)?\b/],
      ['tok-attr', /[a-z-]+(?=\s*:)/],
      ['tok-typ', /\.[A-Za-z_][\w-]*|::?[a-z-]+|#[A-Za-z_][\w-]*/],
      ['tok-op', /[{}();:,]/]
    ],
    json: [
      ['tok-key', /"(?:\\.|[^"\\])*"(?=\s*:)/],
      ['tok-str', /"(?:\\.|[^"\\])*"/],
      ['tok-num', /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/],
      ['tok-kw', /\b(?:true|false|null)\b/],
      ['tok-op', /[{}[\],:]/]
    ],
    yaml: [
      ['tok-cmt', /#[^\n]*/],
      ['tok-str', /"[^"\n]*"|'[^'\n]*'/],
      ['tok-key', /[A-Za-z_][\w.-]*(?=\s*:)/],
      ['tok-kw', /\b(?:true|false|null|yes|no|on|off)\b/],
      ['tok-num', /-?\b\d+(?:\.\d+)?\b/],
      ['tok-op', /[-:|>~]/]
    ],
    sh: [
      ['tok-cmt', /#[^\n]*/],
      ['tok-str', /"(?:\\.|[^"\\])*"|'[^'\n]*'/],
      ['tok-var', /\$\{[^}\n]*\}|\$\w+|\$[?#@!*]/],
      ['tok-kw', K('if then else elif fi for while until do done case esac function return export local readonly declare source exit echo cd ls pwd cat grep sed awk mkdir rm cp mv chmod chown touch curl wget git npm npx node python pip sudo apt brew docker')],
      ['tok-num', /\b\d+\b/],
      ['tok-op', /[|&;<>()=]+/]
    ],
    sql: [
      ['tok-cmt', /--[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*/],
      ['tok-str', /'(?:''|[^'])*'|"(?:\\.|[^"\\])*"/],
      ['tok-kw', I('select from where insert into values update set delete create table alter drop join left right inner outer full on group by order having limit offset and or not null as distinct union all case when then else end like in between is asc desc primary key foreign references index default constraint')],
      ['tok-num', /\b\d+(?:\.\d+)?\b/],
      ['tok-fn', /\b(?:count|sum|avg|min|max|coalesce|cast|now|lower|upper|length)\b/i],
      ['tok-op', /[(),;*=<>]+/]
    ],
    md: [
      ['tok-str', /```[\s\S]*?```|`[^`\n]*`/],
      ['tok-kw', /\*\*[^*\n]+\*\*|__[^_\n]+__/],
      ['tok-typ', /\*[^*\n]+\*|_[^_\n]+_|~~[^~\n]+~~/],
      ['tok-fn', /\[[^\]\n]*\]\([^)\n]*\)/],
      ['tok-key', /#{1,6}[^\n]*/]
    ]
  };
  LANGS.plain = LANGS.text = LANGS.txt = null;

  const ALIAS = {
    javascript: 'js', jsx: 'js', mjs: 'js', cjs: 'js', node: 'js',
    typescript: 'ts', tsx: 'ts',
    python: 'py', python3: 'py', py3: 'py',
    'c++': 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', 'c#': 'cs', csharp: 'cs',
    golang: 'go', rust: 'rs', ruby: 'rb', kotlin: 'kt',
    xml: 'html', svg: 'html', vue: 'html', htm: 'html', markup: 'html',
    scss: 'css', less: 'css', sass: 'css',
    bash: 'sh', shell: 'sh', zsh: 'sh', console: 'sh', terminal: 'sh',
    yml: 'yaml', postgres: 'sql', postgresql: 'sql', mysql: 'sql', sqlite: 'sql',
    markdown: 'md'
  };

  M.langFor = function (name) {
    const n = String(name || '').toLowerCase().replace(/^language-/, '').trim();
    const key = ALIAS[n] || n;
    return LANGS[key] ? key : 'text';
  };

  /* count capture groups (so we can tell which rule matched) */
  function groupCount(src) {
    let n = 0;
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (c === '\\') { i++; continue; }
      if (c === '[') {                       // skip character classes
        while (i < src.length && src[i] !== ']') { if (src[i] === '\\') i++; i++; }
        continue;
      }
      if (c === '(' && src[i + 1] !== '?') n++;
    }
    return n;
  }

  /* fallback classification for rules whose marker group is optional */
  function classify(rules, text) {
    for (const [cls, re] of rules) {
      try { if (new RegExp('^(?:' + re.source + ')$').test(text)) return cls; } catch {}
    }
    return null;
  }

  function highlight(code, rules) {
    // Every alternative needs its own marker group so we can tell which rule
    // won; rules that already contain capture groups are wrapped as-is.
    let master = '', meta = [], g = 1;
    for (const [cls, re] of rules) {
      const inner = groupCount(re.source);
      if (inner === 0) {
        master += (master ? '|' : '') + '(' + re.source + ')';
        meta.push({ cls, at: g });
        g += 1;
      } else {
        master += (master ? '|' : '') + '(?:' + re.source + ')';
        meta.push({ cls, at: g, optional: true });
        g += inner;
      }
    }
    let rx;
    try { rx = new RegExp(master, 'g'); } catch { return esc(code); }

    let out = '', last = 0, m;
    while ((m = rx.exec(code)) !== null) {
      if (m[0] === '') { rx.lastIndex++; continue; }
      if (m.index > last) out += esc(code.slice(last, m.index));
      const hit = meta.find(r => m[r.at] !== undefined);
      const cls = hit ? hit.cls : (classify(rules, m[0]) || 'tok');
      out += '<span class="' + cls + '">' + esc(m[0]) + '</span>';
      last = m.index + m[0].length;
    }
    return out + esc(code.slice(last));
  }

  /* ============ inline markup ============ */
  const SAFE_URL = /^(?:https?:\/\/|mailto:|#|\/)/i;

  function link(text, url) {
    const u = String(url).trim();
    if (!SAFE_URL.test(u)) return esc(text);
    return '<a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">' + esc(text) + '</a>';
  }

  function inline(src) {
    // 1. protect code spans so ** and _ inside them stay literal
    const codes = [];
    let s = String(src == null ? '' : src).replace(/`+([^`]+?)`+/g, (_m, c) => {
      codes.push(c);
      return '\u0001' + (codes.length - 1) + '\u0001';
    });
    // 2. escape everything (from here on, only our own tags exist)
    s = esc(s);
    // 3. links: explicit first, then bare autolinks
    s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_m, t, u) => link(t, u));
    s = s.replace(/(^|[\s(])((?:https?:\/\/|mailto:)[^\s<&)]+)/g, (_m, pre, u) => pre + link(u, u));
    // 4. emphasis
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^\w*])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^\w_])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
    // 5. restore code spans
    s = s.replace(/\u0001(\d+)\u0001/g, (_m, n) => '<code class="md-code-inline">' + esc(codes[+n]) + '</code>');
    return s;
  }
  M.inline = inline;

  /* ============ block parsing ============ */
  const FENCE = /^\s{0,3}(```+|~~~+)\s*([^\s`]*)\s*$/;
  const HEAD = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
  const HR = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
  const QUOTE = /^\s{0,3}>\s?(.*)$/;
  const LI = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
  const TDELIM = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/;

  function isTableRow(lines, i) {
    return i + 1 < lines.length && lines[i] && lines[i].includes('|') && TDELIM.test(lines[i + 1]);
  }
  function isBlockStart(lines, i) {
    const l = lines[i];
    return FENCE.test(l) || HEAD.test(l) || HR.test(l) || QUOTE.test(l) || LI.test(l) || isTableRow(lines, i);
  }

  function codeBlock(code, info) {
    const label = String(info || '').toLowerCase().replace(/^language-/, '').trim() || 'text';
    const rules = LANGS[M.langFor(label)];
    const body = rules ? highlight(code, rules) : esc(code);
    return '<div class="md-code">' +
      '<div class="md-code-head"><span class="md-code-lang">' + esc(label) + '</span>' +
      '<button class="md-code-copy" type="button" title="Copy code to clipboard" aria-label="Copy code">Copy</button></div>' +
      '<pre><code class="lang-' + esc(M.langFor(label).replace(/[^\w-]/g, '')) + '">' + body + '</code></pre>' +
      '</div>';
  }

  function table(lines, start) {
    const split = l => l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim());
    const head = split(lines[start]);
    const align = split(lines[start + 1]).map(c =>
      /^:-+:$/.test(c) ? 'center' : /-+:$/.test(c) ? 'right' : /^:-+/.test(c) ? 'left' : '');
    const cellAlign = n => align[n] ? ' style="text-align:' + align[n] + '"' : '';
    let i = start + 2, rows = [];
    while (i < lines.length && lines[i].trim() && lines[i].includes('|')) { rows.push(split(lines[i])); i++; }
    let html = '<table><thead><tr>' + head.map((c, n) => '<th' + cellAlign(n) + '>' + inline(c) + '</th>').join('') + '</tr></thead><tbody>';
    for (const r of rows) html += '<tr>' + r.map((c, n) => '<td' + cellAlign(n) + '>' + inline(c) + '</td>').join('') + '</tr>';
    return { html: html + '</tbody></table>', next: i };
  }

  function list(lines, start) {
    const first = lines[start].match(LI);
    const base = first[1].length;
    const ordered = /\d/.test(first[2]);
    let i = start, items = [], cur = null;
    while (i < lines.length) {
      const line = lines[i];
      const m = line.match(LI);
      if (m && m[1].length <= base + 1) { cur = { text: m[3], sub: [] }; items.push(cur); i++; continue; }
      if (!line.trim()) {
        const nxt = lines[i + 1];
        if (nxt && (LI.test(nxt) || /^\s+\S/.test(nxt))) { i++; continue; }
        break;
      }
      if (cur && (m || /^\s+\S/.test(line))) { cur.sub.push(m ? '  ' + (m[2] + ' ' + m[3]) : line); i++; continue; }
      break;
    }
    let html = '<' + (ordered ? 'ol' : 'ul') + '>';
    for (const it of items) {
      let inner = inline(it.text);
      if (it.sub.length) inner += blocks(it.sub);
      html += '<li>' + inner + '</li>';
    }
    return { html: html + '</' + (ordered ? 'ol' : 'ul') + '>', next: i };
  }

  function blocks(lines) {
    let out = '', i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }

      /* fenced code block (unclosed fences still render — matters while streaming) */
      const f = line.match(FENCE);
      if (f) {
        const closer = new RegExp('^\\s{0,3}' + (f[1][0] === '`' ? '`{3,}' : '~{3,}') + '\\s*$');
        const buf = [];
        i++;
        while (i < lines.length && !closer.test(lines[i])) { buf.push(lines[i]); i++; }
        if (i < lines.length) i++;
        out += codeBlock(buf.join('\n'), f[2]);
        continue;
      }

      const h = line.match(HEAD);
      if (h) { const n = h[1].length; out += '<h' + n + '>' + inline(h[2]) + '</h' + n + '>'; i++; continue; }

      if (HR.test(line)) { out += '<hr>'; i++; continue; }

      if (isTableRow(lines, i)) { const t = table(lines, i); out += t.html; i = t.next; continue; }

      if (QUOTE.test(line)) {
        const buf = [];
        while (i < lines.length && lines[i].trim() && (QUOTE.test(lines[i]) || (buf.length && !isBlockStart(lines, i)))) {
          const q = lines[i].match(QUOTE);
          buf.push(q ? q[1] : lines[i]);
          i++;
        }
        out += '<blockquote>' + blocks(buf) + '</blockquote>';
        continue;
      }

      if (LI.test(line)) { const l = list(lines, i); out += l.html; i = l.next; continue; }

      /* paragraph — consecutive lines become <br>-separated text */
      const buf = [];
      while (i < lines.length && lines[i].trim() && !isBlockStart(lines, i)) { buf.push(lines[i]); i++; }
      out += '<p>' + buf.map(inline).join('<br>') + '</p>';
    }
    return out;
  }

  /* ============ public API ============ */
  M.render = function (src) {
    const text = String(src == null ? '' : src).replace(/\r\n?/g, '\n');
    if (!text.trim()) return '';
    return blocks(text.split('\n'));
  };

  M.renderInto = function (el, src) {
    if (!el) return el;
    el.innerHTML = M.render(src);
    el.classList.add('md');
    return el;
  };

  /* cheap streaming guard: fenced code mid-stream re-renders too often */
  M.canStream = src => !/```|~~~/.test(String(src || ''));

  /* plain text for text-to-speech: nobody wants asterisks read aloud */
  M.toPlain = function (src) {
    return String(src == null ? '' : src)
      .replace(/```[\s\S]*?```/g, ' (code block) ')
      .replace(/`+([^`]+?)`+/g, '$1')
      .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/^\s{0,3}>\s?/gm, '')
      .replace(/^\s*[-*+]\s+/gm, '')
      .replace(/\*\*|__|~~|[*_|]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  };
})();
