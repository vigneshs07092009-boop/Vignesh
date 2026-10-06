/* ============================================================
 * Aevion Attachments — the paperclip in the composer.
 *
 * What an attachment is here: a file the user picked, kept on this
 * device, described honestly. Nothing is uploaded to decide what it
 * is — the type comes from the file itself, and the size from the
 * file's own byte count.
 *
 * What can be *done* with one, offline and truthfully:
 *   - a text-ish file (.txt, .md, .csv, .json, source code) can be
 *     read here and summarized, searched or explained by the local
 *     skills — no provider, no network;
 *   - a photo, video, PDF or office document is recorded by name,
 *     kind and size, and handed to an AI provider only when one is
 *     configured and the user asks. Aevion never pretends to have
 *     looked inside an image it cannot see.
 *
 * Files themselves are never written to localStorage: the bytes stay
 * in memory for this session and the metadata is what is remembered.
 * That is a deliberate privacy and quota decision — a 20 MB video in
 * localStorage would break the app, and storing someone's photo there
 * silently would be worse.
 * ============================================================ */
(function () {
  const A = {};

  /* The four families the paperclip offers, each with the accept
     pattern a file picker needs. Rendered from this table, so the
     button and the picker can never disagree. */
  A.KINDS = [
    { id: 'photo', label: 'Photo', icon: '🖼', accept: 'image/*' },
    { id: 'video', label: 'Video', icon: '🎬', accept: 'video/*' },
    { id: 'document', label: 'Document', icon: '📄', accept: '.doc,.docx,.odt,.rtf,.txt,.md,.csv,.tsv,.json,.log,.xml,.yml,.yaml' },
    { id: 'pdf', label: 'PDF', icon: '📕', accept: '.pdf' }
  ];

  A.ACCEPT = 'image/*,video/*,application/pdf,.doc,.docx,.odt,.rtf,.txt,.md,.csv,.tsv,.json,.log,.xml,.yml,.yaml,.ppt,.pptx,.xls,.xlsx';

  /* 40 MB is the point where holding the bytes in memory stops being
     reasonable on a phone. Bigger files are refused with a reason
     rather than crashing the tab. */
  A.MAX_BYTES = 40 * 1024 * 1024;

  A._cache = [];

  /* Text families we can actually read offline. Everything else is
     metadata-only, and saying so is the honest answer. */
  const TEXTY = [
    /^text\//i, /^application\/(json|xml|x-yaml|javascript|csv|sql)/i,
    /^application\/.*\+(json|xml)$/i
  ];
  const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|log|xml|ya?ml|js|mjs|ts|tsx|jsx|py|java|kt|c|h|cpp|cs|go|rs|rb|php|sh|bat|ps1|sql|html?|css)$/i;
  const PDF_EXT = /\.pdf$/i;
  /* When a picker hands over a file with no MIME type at all (which does
     happen for photos and videos on some devices), the extension is the
     next best evidence — and far better than filing a photo as a document. */
  const IMG_EXT = /\.(jpe?g|png|gif|webp|bmp|heic|heif|avif|svgz?|tiff?)$/i;
  const VID_EXT = /\.(mp4|m4v|mov|webm|mkv|avi|3gp|wmv|flv|mpe?g)$/i;

  A.kindOf = function (name, type) {
    const n = String(name || '').toLowerCase();
    const t = String(type || '').toLowerCase();
    if (PDF_EXT.test(n) || t === 'application/pdf') return 'pdf';
    if (t.startsWith('image/') || (!t && IMG_EXT.test(n))) return 'photo';
    if (t.startsWith('video/') || (!t && VID_EXT.test(n))) return 'video';
    if (TEXT_EXT.test(n) || TEXTY.some(re => re.test(t))) return 'document';
    if (/\.(docx?|odt|rtf|pptx?|xlsx?)$/i.test(n)) return 'document';
    return 'document';
  };

  A.readable = function (name, type) {
    return TEXT_EXT.test(String(name || '')) || TEXTY.some(re => re.test(String(type || '')));
  };

  A.humanSize = function (bytes) {
    const b = Number(bytes) || 0;
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1024 / 1024).toFixed(1) + ' MB';
  };

  /* Attach one picked file. Returns the record, or {error} with a
     reason the UI can show — never a silent failure. */
  A.attach = function (file) {
    if (!file) return { error: 'No file was given.' };
    const name = String(file.name || 'file');
    const size = Number(file.size) || 0;
    if (size > A.MAX_BYTES) {
      return { error: name + ' is ' + A.humanSize(size) + ' — the paperclip stops at ' + A.humanSize(A.MAX_BYTES) + '.' };
    }
    const rec = {
      id: (Aevion.randomId ? Aevion.randomId() : String(Date.now() + Math.random())),
      name,
      kind: A.kindOf(name, file.type),
      type: file.type || 'unknown type',
      size,
      added: Date.now(),
      readable: A.readable(name, file.type),
      file
    };
    A._cache.push(rec);
    Aevion.emit('attach:changed', { added: rec.id, count: A._cache.length });
    return rec;
  };

  A.list = () => (A._cache || []).slice();
  A.count = () => (A._cache || []).length;
  A.get = id => (A._cache || []).find(r => r.id === id) || null;

  A.remove = function (id) {
    const before = A._cache.length;
    A._cache = A._cache.filter(r => r.id !== id);
    if (A._cache.length !== before) Aevion.emit('attach:changed', { removed: id, count: A._cache.length });
    return before !== A._cache.length;
  };

  A.clear = function () {
    const n = A._cache.length;
    A._cache = [];
    if (n) Aevion.emit('attach:changed', { count: 0 });
    return n;
  };

  /* One line per attachment, ready to put in front of the brain. */
  A.describe = function () {
    return A.list().map(r =>
      '📎 ' + r.name + ' — ' + r.kind + ', ' + r.type + ', ' + A.humanSize(r.size) +
      (r.readable ? ' (text I can read on-device)' : ' (I cannot look inside this one on-device)')
    );
  };

  /* The text of one readable attachment. Uses Blob.text(), which the
     browser already has — no FileReader, no library, no upload. */
  A.text = async function (id, cap) {
    const rec = A.get(id);
    if (!rec || !rec.readable) return null;
    const limit = cap || 20000;
    try {
      if (rec.file && typeof rec.file.text === 'function') {
        const t = await rec.file.text();
        return String(t).slice(0, limit);
      }
    } catch { /* fall through */ }
    return null;
  };

  /* Everything readable, concatenated, capped — what the composer
     hands the brain so "summarize this" works with no provider. */
  A.textAll = async function (cap) {
    const parts = [];
    let budget = cap || 20000;
    for (const r of A.list()) {
      if (!r.readable || budget <= 0) continue;
      const t = await A.text(r.id, budget);
      if (t) { parts.push('--- ' + r.name + ' ---\n' + t); budget -= t.length; }
    }
    return parts.join('\n\n');
  };

  A.hasReadable = () => A.list().some(r => r.readable);

  /* A short factual answer when the user asks what is attached. */
  A.summary = function () {
    const l = A.list();
    if (!l.length) return 'Nothing is attached right now.';
    const kinds = {};
    l.forEach(r => { kinds[r.kind] = (kinds[r.kind] || 0) + 1; });
    const total = l.reduce((n, r) => n + r.size, 0);
    return l.length + ' attachment' + (l.length === 1 ? '' : 's') + ' (' +
      Object.entries(kinds).map(([k, n]) => n + ' ' + k).join(', ') + '), ' + A.humanSize(total) + ' in total:\n' +
      A.describe().join('\n');
  };

  Aevion.attach = A;
})();
