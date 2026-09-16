/* ============================================================
 * Aevion Online — strictly opt-in connectors
 * Nothing here runs unless the user enabled it AND granted
 * the matching permission. Memory of every request is local.
 * ============================================================ */
(function () {
  const O = {};

  function gateAI() {
    if (!Aevion.settings.onlineAI) throw new Error('Online AI is off. Enable it in Settings → Privacy (Aevion works fully offline without it).');
  }

  /* ---------- OpenAI-compatible chat (works with Ollama) ---------- */
  O.chat = async function (messages) {
    gateAI();
    const s = Aevion.settings;
    const url = (s.aiUrl || '').trim();
    if (!url) throw new Error('No AI endpoint configured.');

    const headers = { 'Content-Type': 'application/json' };
    if (s.aiKey) headers['Authorization'] = 'Bearer ' + s.aiKey;

    const body = {
      model: s.aiModel || 'llama3.2',
      messages,
      stream: false
    };

    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 60000);

    try {
      const r = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: ctl.signal
      });
      if (!r.ok) throw new Error('HTTP ' + r.status + ' — ' + (await r.text()).slice(0, 120));
      const j = await r.json();
      const out = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      if (!out) throw new Error('Empty response from endpoint.');
      Aevion.store.set('aiLastUsed', Date.now());
      return out.trim();
    } finally { clearTimeout(to); }
  };

  /* ---------- persona system prompt ---------- */
  O.systemPrompt = function () {
    const s = Aevion.settings;
    const persona = {
      balanced: 'Helpful, warm, straight to the point.',
      concise: 'Extremely concise. Answer in one short paragraph max.',
      friendly: 'Friendly and encouraging, light emoji use.',
      formal: 'Professional and precise. No slang.'
    }[s.persona] || 'Helpful.';

    let p = `You are ${s.name}, a private, local-first AI assistant running on the user's own device. ${persona} ` +
      `Never claim to send their data anywhere; data stays on-device.`;

    const mem = Aevion.memory.all().slice(-8);
    if (mem.length) p += '\nKnown facts about the user (from private local memory): ' + mem.map(m => '- ' + m.text).join(' ');

    const langName = { en: 'English', hi: 'Hindi', ta: 'Tamil', te: 'Telugu', es: 'Spanish', fr: 'French', de: 'German', ja: 'Japanese' }[s.lang];
    if (langName && s.lang !== 'en') p += `\nReply in ${langName}.`;

    return p;
  };

  Aevion.online = O;
})();
