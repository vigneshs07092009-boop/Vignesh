/* ============================================================
 * Aevion Online — thin compatibility layer.
 *
 * Since 0.6.0 the real work lives in js/providers.js (OpenAI,
 * Anthropic, Gemini, local servers, in-browser model, offline mock).
 * This file keeps the long-standing `Aevion.online.chat()` entry point
 * working and owns the one thing that is not provider-specific: the
 * system prompt.
 * ============================================================ */
(function () {
  const O = {};

  /* Kept for callers that expect the old gate behaviour. The provider
     layer enforces this too — belt and braces, never a bypass. */
  function gateAI() {
    if (!Aevion.settings.onlineAI) throw new Error('Online AI is off. Enable it in Settings → Privacy (Aevion works fully offline without it).');
  }

  O.chat = async function (messages, opts) {
    gateAI();
    return Aevion.providers.chat(messages, opts);
  };

  /* ---------- persona + relevant memory, not the whole store ---------- */
  const PERSONAS = {
    balanced: 'Helpful, warm, straight to the point.',
    concise: 'Extremely concise. Answer in one short paragraph max.',
    friendly: 'Friendly and encouraging, light emoji use.',
    formal: 'Professional and precise. No slang.'
  };

  const LANG_NAMES = {
    en: 'English', hi: 'Hindi', ta: 'Tamil', te: 'Telugu', es: 'Spanish', fr: 'French',
    de: 'German', ja: 'Japanese', it: 'Italian', pt: 'Portuguese', ru: 'Russian',
    ko: 'Korean', zh: 'Chinese', ar: 'Arabic', bn: 'Bengali', ur: 'Urdu', mr: 'Marathi'
  };

  O.systemPrompt = function (query) {
    const s = Aevion.settings;
    let p = `You are ${s.name}, a private, local-first AI assistant running on the user's own device. ` +
      `${PERSONAS[s.persona] || PERSONAS.balanced} ` +
      `Never claim to send their data anywhere; data stays on-device. ` +
      `Be honest about uncertainty and about your own limits.`;

    // Only the memories that actually relate to this message, so the
    // context stays small (and cheap) however much is stored.
    const relevant = Aevion.memory.contextFor(query || '', 6);
    if (relevant) p += '\nKnown facts about the user (from private local memory — use them only if relevant):\n' + relevant;

    const pending = Aevion.memory.pending ? Aevion.memory.pending().length : 0;
    if (pending) p += `\n(${pending} preference(s) are waiting for the user's approval and must not be assumed.)`;

    const langName = LANG_NAMES[s.lang];
    if (langName && s.lang !== 'en') p += `\nReply in ${langName}.`;

    return p;
  };

  /* ---------- automatic online ↔ offline shifting ----------
   *
   * The user's switches stay exactly where they put them: this is
   * session-only bookkeeping, and `settings.autoAI` (Settings → Privacy)
   * is the consent that makes it our business at all. With auto-switch
   * off, `available()` answers true and the old behaviour — try the
   * provider, fall back to the local brain — is untouched.
   */
  const COOLDOWN = 60000;   // one minute offline before the online brain is retried
  let down = null;          // { reason, at }

  O.markDown = function (reason, at) {
    down = { reason: String(reason || 'endpoint unreachable'), at: at == null ? Date.now() : at };
    try { Aevion.emit('online:down', O.status()); } catch { /* a listener is optional */ }
    return O.status();
  };
  O.markUp = function () {
    const was = !!down;
    down = null;
    if (was) { try { Aevion.emit('online:up'); } catch { /* a listener is optional */ } }
    return O.status();
  };
  O.down = function () { return !!down; };

  O.available = function (now) {
    const s = Aevion.settings || {};
    if (!s.onlineAI || s.autoAI === false) return true;   // not our call to make
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
    if (!down) return true;
    const t = now == null ? Date.now() : now;
    if (t - down.at < COOLDOWN) return false;
    down = null;   // the minute is up: give the online brain another chance
    return true;
  };

  O.status = function () {
    const s = Aevion.settings || {};
    if (!s.onlineAI) return { mode: 'local', why: 'online AI is off' };
    if (s.autoAI === false) return { mode: 'online', why: 'auto-switch is off' };
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return { mode: 'offline', why: 'no internet connection' };
    if (down) return { mode: 'offline', why: down.reason, at: down.at, retryIn: Math.max(0, down.at + COOLDOWN - Date.now()) };
    return { mode: 'online', why: 'reachable' };
  };

  Aevion.online = O;
})();
