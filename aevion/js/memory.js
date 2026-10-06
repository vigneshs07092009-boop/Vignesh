/* ============================================================
 * Aevion Memory — five separate layers, all local.
 *
 *   session  what is relevant right now (RAM only, gone on reload)
 *   history  the conversation log (the chat transcript)
 *   longterm facts the user explicitly asked to keep
 *   prefs    preferences Aevion *noticed* — inert until approved
 *   temp     short-lived scratch notes with a TTL
 *
 * Rules that keep it honest and small:
 *   - nothing is written unless the user caused it ("remember: …",
 *     "add note", "add task") or it is a temp/session value
 *   - `prefs` entries start unapproved and are excluded from recall
 *     until the user taps Approve — inferred ≠ remembered
 *   - every layer has a hard cap, and retrieval is a scored scan
 *     (no model call, no embedding table, no network)
 *
 * This module replaces the flat store `Aevion.memory` from 0.5.x and
 * keeps its old API (add/all/find/remove/clear) working on `longterm`,
 * migrating the legacy `memory` key on first use.
 * ============================================================ */
(function () {
  const LAYERS = {
    session: { key: null, cap: 50, weight: 1.2, label: 'This session' },
    history: { key: 'chatHistory', cap: 200, weight: 0.8, label: 'Conversation history' },
    longterm: { key: 'memory:longterm', cap: 500, weight: 1.0, label: 'Saved facts' },
    prefs: { key: 'memory:prefs', cap: 200, weight: 0.9, label: 'Noticed preferences' },
    temp: { key: 'memory:temp', cap: 100, weight: 0.5, label: 'Temporary context' }
  };

  const STOP = new Set(('the a an and or of to in is are was were for on with as by at it its this that be have has had not ' +
    'from you your i me my we they he she do does did so if then than but').split(' '));

  const session = [];   // RAM only — never persisted

  const tokens = s => (String(s || '').toLowerCase().match(/[a-z0-9']+/g) || [])
    .filter(t => t.length > 2 && !STOP.has(t));

  const isTempExpired = it => it && it.expires && it.expires < Date.now();

  /* ---------- raw layer access ---------- */
  function readRaw(layer) {
    const def = LAYERS[layer];
    if (!def) return [];
    if (layer === 'session') return session.slice();
    const items = Aevion.store.get(def.key, []);
    if (layer === 'history') return items.map(h => ({ id: 'h' + h.t + (h.role || ''), text: h.text, tag: h.role || 'chat', t: h.t }));
    return Array.isArray(items) ? items.filter(i => !isTempExpired(i)) : [];
  }

  function writeRaw(layer, items) {
    const def = LAYERS[layer];
    if (!def) return;
    const capped = items.slice(-def.cap);
    if (layer === 'session') { session.length = 0; session.push(...capped); return; }
    Aevion.store.set(def.key, capped);
  }

  /* ================= public API ================= */
  const M = {
    LAYERS,
    layerNames: () => Object.keys(LAYERS),

    /* Back-compatible: add(text, tag) writes to longterm. */
    add(text, tag, layer = 'longterm') {
      const t = String(text || '').trim();
      if (!t) return null;
      if (!LAYERS[layer]) throw new Error('Unknown memory layer: ' + layer);
      const items = readRaw(layer);
      if (items.some(i => i.text.toLowerCase() === t.toLowerCase())) return null;
      items.push({ id: Aevion.randomId(), text: t, tag: tag || 'fact', t: Date.now(), approved: layer !== 'prefs' });
      writeRaw(layer, items);
      Aevion.emit('memory:changed', { layer, count: items.length });
      return t;
    },

    /* Back-compatible: all()/all('longterm') */
    all(layer = 'longterm') { return readRaw(layer); },

    /* Back-compatible: substring search on a layer. */
    find(q, layer = 'longterm') {
      q = String(q || '').toLowerCase();
      return readRaw(layer).filter(i => i.text.toLowerCase().includes(q));
    },

    remove(id, layer = 'longterm') {
      writeRaw(layer, readRaw(layer).filter(i => i.id !== id));
      Aevion.emit('memory:changed', { layer });
    },

    clear(layer = 'longterm') {
      writeRaw(layer, []);
      Aevion.emit('memory:changed', { layer });
    },

    clearAll() { this.layerNames().forEach(l => this.clear(l)); },

    temp(text, ttlMs = 30 * 60 * 1000) {
      const items = readRaw('temp');
      items.push({ id: Aevion.randomId(), text: String(text || '').trim(), tag: 'temp', t: Date.now(), expires: Date.now() + ttlMs, approved: true });
      writeRaw('temp', items);
      return true;
    },

    /* --- preferences: noticed, but inert until approved --- */
    suggest(text, tag = 'inferred') {
      const t = String(text || '').trim();
      if (!t) return null;
      const items = readRaw('prefs');
      if (items.some(i => i.text.toLowerCase() === t.toLowerCase())) return null;
      items.push({ id: Aevion.randomId(), text: t, tag, t: Date.now(), approved: false });
      writeRaw('prefs', items);
      Aevion.emit('memory:changed', { layer: 'prefs', pending: true });
      return t;
    },
    approve(id) {
      const items = readRaw('prefs').map(i => (i.id === id ? Object.assign({}, i, { approved: true }) : i));
      writeRaw('prefs', items);
      Aevion.emit('memory:changed', { layer: 'prefs' });
      return true;
    },
    pending() { return readRaw('prefs').filter(i => !i.approved); },

    /* --- retrieval: one scored scan, no model, no network --- */
    recall(query, opts = {}) {
      const q = tokens(query);
      const layers = opts.layers || ['longterm', 'prefs', 'session', 'history', 'temp'];
      const limit = opts.limit || 5;
      const now = Date.now();
      const scored = [];

      for (const layer of layers) {
        if (!LAYERS[layer]) continue;
        for (const it of readRaw(layer)) {
          if (layer === 'prefs' && !it.approved) continue;     // unapproved prefs stay out
          if (!it.text) continue;
          const itTokens = tokens(it.text);
          let overlap = 0;
          for (const t of new Set(itTokens)) if (q.includes(t)) overlap++;
          if (q.length && overlap === 0) continue;
          const lower = it.text.toLowerCase();
          const phrase = q.length > 1 && q.every(t => lower.includes(t)) ? 1 : 0;
          const ageDays = Math.max(0, (now - (it.t || now)) / 86400000);
          const recency = 1 / (1 + ageDays);                   // 1 today, 0.5 yesterday…
          const score = (overlap * 2 + phrase * 1.5) * (LAYERS[layer].weight) / Math.sqrt(Math.max(1, itTokens.length)) + recency * 0.5;
          scored.push({ layer, id: it.id, text: it.text, tag: it.tag, t: it.t, score: Math.round(score * 1000) / 1000 });
        }
      }
      scored.sort((a, b) => b.score - a.score || (b.t || 0) - (a.t || 0));
      return scored.slice(0, limit);
    },

    /* Compact text block for a system prompt: only what is relevant. */
    contextFor(query, limit = 6) {
      const hits = this.recall(query, { limit });
      if (!hits.length) return '';
      return hits.map(h => `- (${h.layer}) ${h.text}`).join('\n');
    },

    stats() {
      const out = {};
      for (const l of this.layerNames()) {
        const items = readRaw(l);
        out[l] = { count: items.length, cap: LAYERS[l].cap, approved: l === 'prefs' ? items.filter(i => i.approved).length : undefined };
      }
      return out;
    },

    /* One-time move from the 0.5.x flat `memory` array. */
    migrate() {
      const legacy = Aevion.store.get('memory', null);
      if (!Array.isArray(legacy) || !legacy.length) return 0;
      const items = readRaw('longterm');
      let moved = 0;
      for (const it of legacy) {
        const text = String((it && it.text) || '').trim();
        if (!text) continue;
        if (items.some(i => i.text.toLowerCase() === text.toLowerCase())) continue;
        items.push({ id: it.id || Aevion.randomId(), text, tag: it.tag || 'fact', t: it.t || Date.now(), approved: true });
        moved++;
      }
      writeRaw('longterm', items);
      Aevion.store.del('memory');
      return moved;
    },

    wipe() { this.clearAll(); Aevion.store.del('memory'); }
  };

  Aevion.memory = M;
})();
