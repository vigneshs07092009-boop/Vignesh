/* Tests for providers.js — the multi-provider AI layer.
   These assert the REAL request each adapter builds, so a wrong header
   or body shape is caught here instead of on the user's phone. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, makeFetch, jsonReply, sseReply, plain } from './harness.mjs';

const msgs = [{ role: 'system', content: 'be nice' }, { role: 'user', content: 'hello' }];

function ai(settings = {}, handlers = []) {
  const fetch = makeFetch(handlers);
  const merged = { onlineAI: true, aiProvider: 'openai', ...settings };
  const app = createApp({ settings: merged, fetch });
  // the provider under test is assumed configured, except where a test
  // explicitly checks the "not configured yet" path
  if (merged.aiProvider !== 'mock' && merged.aiProvider !== 'webllm') {
    app.Aevion.providers.setKey(merged.aiProvider, 'sk-test-key');
  }
  return { ...app, fetch };
}

test('registry: every promised provider is registered with the right kind', () => {
  const { Aevion } = createApp();
  const ids = Aevion.providers.ids();
  for (const id of ['openai', 'ollama', 'anthropic', 'gemini', 'webllm', 'mock']) {
    assert.ok(ids.includes(id), `${id} must be registered`);
  }
  assert.equal(Aevion.providers.kindOf('openai'), 'cloud');
  assert.equal(Aevion.providers.kindOf('ollama'), 'loopback');
  assert.equal(Aevion.providers.kindOf('webllm'), 'local');
  assert.equal(Aevion.providers.kindOf('mock'), 'local');
});

test('config: each provider keeps its own endpoint, and switching never wipes it', () => {
  const { Aevion } = createApp();
  assert.equal(Aevion.providers.cfg('ollama').url, 'http://localhost:11434/v1/chat/completions');
  assert.equal(Aevion.providers.cfg('openai').model, 'gpt-4o-mini');
  Aevion.providers.setCfg('openai', { model: 'gpt-4o' });
  Aevion.providers.setCfg('ollama', { model: 'mistral' });
  assert.equal(Aevion.providers.cfg('openai').model, 'gpt-4o');
  assert.equal(Aevion.providers.cfg('ollama').model, 'mistral');
  assert.equal(Aevion.providers.cfg('anthropic').model, 'claude-3-5-haiku-latest');
});

test('config: a custom URL survives a provider switch', () => {
  const { Aevion } = createApp({ settings: { aiProvider: 'custom' } });
  Aevion.providers.setCfg('custom', { url: 'http://192.168.1.9:8000/v1/chat/completions', model: 'local' });
  Aevion.set('aiProvider', 'ollama');
  assert.equal(Aevion.providers.cfg('custom').url, 'http://192.168.1.9:8000/v1/chat/completions');
});

test('config: legacy flat settings migrate once and the plaintext key is cleared', () => {
  const { Aevion } = createApp({
    settings: { aiProvider: 'openai', aiUrl: 'https://api.openai.com/v1/chat/completions', aiModel: 'gpt-4o-mini', aiKey: 'legacy-secret' }
  });
  assert.equal(Aevion.providers.migrateLegacy(), true);
  assert.equal(Aevion.providers.key('openai'), 'legacy-secret');
  assert.equal(Aevion.settings.aiKey, '', 'the key must not stay in the plain settings blob');
  assert.equal(Aevion.providers.migrateLegacy(), false, 'migration must be idempotent');
});

test('missing: reports exactly what is not configured yet', () => {
  const { Aevion } = createApp();
  assert.deepEqual(plain(Aevion.providers.missing('ollama')), []);
  assert.deepEqual(plain(Aevion.providers.missing('openai')), ['API key']);
  assert.deepEqual(plain(Aevion.providers.missing('custom')), ['endpoint URL', 'model name']);
});

/* ---------- request shapes ---------- */

test('openai-compatible: builds the documented /v1/chat/completions request', () => {
  const { Aevion } = createApp();
  const a = Aevion.providers.get('openai');
  const built = a.buildRequest(msgs, { url: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o-mini', key: 'sk-test', stream: false, temperature: 0.5, maxTokens: 256 });
  assert.equal(built.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(built.headers.Authorization, 'Bearer sk-test');
  assert.equal(built.headers['Content-Type'], 'application/json');
  assert.equal(built.body.model, 'gpt-4o-mini');
  assert.equal(built.body.stream, false);
  assert.equal(built.body.max_tokens, 256);
  assert.deepEqual(built.body.messages, msgs);
});

test('openai-compatible: a local server needs no Authorization header', () => {
  const { Aevion } = createApp();
  const built = Aevion.providers.get('ollama').buildRequest(msgs, { url: 'http://localhost:11434/v1/chat/completions', model: 'llama3.2', key: '', stream: false });
  assert.equal('Authorization' in built.headers, false);
});

test('openai-compatible: parses all four response dialects', () => {
  const a = createApp().Aevion.providers.get('openai');
  assert.equal(a.parseResponse({ choices: [{ message: { content: 'hi' } }] }), 'hi');
  assert.equal(a.parseResponse({ choices: [{ delta: { content: 'chunk' } }] }), 'chunk');
  assert.equal(a.parseResponse({ choices: [{ text: 'legacy' }] }), 'legacy');
  assert.equal(a.parseResponse({ response: 'ollama-native' }), 'ollama-native');
  assert.equal(a.parseResponse({}), '');
});

test('anthropic: uses x-api-key, a version header and a top-level system prompt', () => {
  const { Aevion } = createApp();
  const built = Aevion.providers.get('anthropic').buildRequest(msgs, {
    url: 'https://api.anthropic.com/v1/messages', model: 'claude-3-5-haiku-latest', key: 'sk-ant', maxTokens: 512, temperature: 0.7, stream: false
  });
  assert.equal(built.headers['x-api-key'], 'sk-ant');
  assert.equal(built.headers['anthropic-version'], '2023-06-01');
  assert.equal(built.headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.equal(built.body.system, 'be nice');
  assert.equal(built.body.messages.length, 1, 'system must be lifted out of messages');
  assert.equal(built.body.messages[0].role, 'user');
  assert.equal(built.body.max_tokens, 512);
});

test('anthropic: joins text blocks and ignores non-text ones', () => {
  const a = createApp().Aevion.providers.get('anthropic');
  assert.equal(a.parseResponse({ content: [{ type: 'text', text: 'Hello ' }, { type: 'tool_use' }, { type: 'text', text: 'world' }] }), 'Hello world');
  assert.equal(a.parseStream({ type: 'content_block_delta', delta: { text: 'tok' } }), 'tok');
  assert.equal(a.parseStream({ type: 'message_start' }), '');
});

test('gemini: puts the model and key in the URL and maps roles correctly', () => {
  const { Aevion } = createApp();
  const built = Aevion.providers.get('gemini').buildRequest(
    [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }],
    { url: 'https://generativelanguage.googleapis.com/v1beta/models', model: 'gemini-2.0-flash', key: 'AIza-test', temperature: 0.7, maxTokens: 100, stream: false }
  );
  assert.match(built.url, /models\/gemini-2\.0-flash:generateContent\?key=AIza-test$/);
  assert.equal(built.body.contents[1].role, 'model', 'assistant maps to "model" in Gemini');
  assert.equal(built.body.systemInstruction.parts[0].text, 'be brief');
  assert.equal(built.body.generationConfig.maxOutputTokens, 100);
});

test('gemini: a streaming call asks for the SSE endpoint', () => {
  const { Aevion } = createApp();
  const built = Aevion.providers.get('gemini').buildRequest(msgs, {
    url: 'https://generativelanguage.googleapis.com/v1beta/models', model: 'gemini-2.0-flash', key: 'k', stream: true
  });
  assert.match(built.url, /:streamGenerateContent\?alt=sse&key=k$/);
});

test('gemini: parses candidate parts', () => {
  const a = createApp().Aevion.providers.get('gemini');
  assert.equal(a.parseResponse({ candidates: [{ content: { parts: [{ text: 'hey' }, { text: ' there' }] } }] }), 'hey there');
  assert.equal(a.parseResponse({ candidates: [] }), '');
});

/* ---------- end-to-end chat ---------- */

test('chat: posts to the configured provider and returns its text', async () => {
  const { Aevion, fetch } = ai({}, [{ reply: jsonReply({ choices: [{ message: { content: '  hello there  ' } }] }) }]);
  const out = await Aevion.providers.chat(msgs);
  assert.equal(out, 'hello there');
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].body.messages[0].content, 'be nice');
  assert.equal(plain(Aevion.store.get('aiLastUsed')).provider, 'openai');
});

test('chat: refuses cloud providers while Online AI is off, and says how to fix it', async () => {
  const fetch = makeFetch([{ reply: jsonReply({}) }]);
  const { Aevion } = createApp({ settings: { onlineAI: false, aiProvider: 'openai' }, fetch });
  await assert.rejects(() => Aevion.providers.chat(msgs), /Online AI is off/);
  assert.equal(fetch.calls.length, 0, 'nothing may leave the device');
});

test('chat: a loopback provider explains it is your own machine', async () => {
  const { Aevion } = createApp({ settings: { onlineAI: false, aiProvider: 'ollama' } });
  await assert.rejects(() => Aevion.providers.chat(msgs), /your own server at http:\/\/localhost:11434/);
});

test('chat: refuses to run without the required API key', async () => {
  const fetch = makeFetch([{ reply: jsonReply({}) }]);
  const { Aevion } = createApp({ settings: { onlineAI: true, aiProvider: 'anthropic' }, fetch });
  await assert.rejects(() => Aevion.providers.chat(msgs), /needs: API key/);
  assert.equal(fetch.calls.length, 0);
});

test('chat: stores the key outside the normal settings blob', async () => {
  const { Aevion } = ai({}, [{ reply: jsonReply({ choices: [{ message: { content: 'ok' } }] }) }]);
  Aevion.providers.setKey('openai', 'sk-super-secret');
  await Aevion.providers.chat(msgs);
  const settingsBlob = JSON.stringify(Aevion.store.get('settings'));
  assert.equal(settingsBlob.includes('sk-super-secret'), false);
  assert.equal(JSON.stringify(Aevion.store.get('aiCfg') || {}).includes('sk-super-secret'), false);
});

test('chat: turns HTTP failures into actionable messages', async () => {
  const cases = [
    [401, /rejected the API key/],
    [404, /no model or endpoint/],
    [429, /rate limited/],
    [500, /server error/]
  ];
  for (const [status, re] of cases) {
    const { Aevion } = ai({}, [{ reply: { status, text: 'nope', json: {} } }]);
    await assert.rejects(() => Aevion.providers.chat(msgs), re, `HTTP ${status}`);
  }
});

test('chat: reads the key from the secrets vault only', async () => {
  const { Aevion, fetch } = ai({}, [{ reply: jsonReply({ choices: [{ message: { content: 'ok' } }] }) }]);
  Aevion.providers.setKey('openai', 'sk-vaulted');
  await Aevion.providers.chat(msgs);
  assert.equal(fetch.calls[0].opts.headers.Authorization, 'Bearer sk-vaulted');
});

test('chat: an unreachable endpoint says so, rather than pretending', async () => {
  const { Aevion } = ai({}, [{ reply: { throws: new TypeError('fetch failed') } }]);
  await assert.rejects(() => Aevion.providers.chat(msgs), /cannot reach https:\/\/api\.openai\.com/);
});

test('chat: an empty provider reply is an error, not an empty bubble', async () => {
  const { Aevion } = ai({}, [{ reply: jsonReply({ choices: [{ message: { content: '' } }] }) }]);
  await assert.rejects(() => Aevion.providers.chat(msgs), /empty message/);
});

test('streaming: deltas are handed to onToken and the full text returned', async () => {
  const { Aevion } = ai({}, [{
    reply: sseReply([
      'data: {"choices":[{"delta":{"content":"Hel"}}]}',
      'data: {"choices":[{"delta":{"content":"lo"}}]}',
      'data: [DONE]'
    ])
  }]);
  const deltas = [];
  const out = await Aevion.providers.chat(msgs, { onToken: (d, full) => deltas.push([d, full]) });
  assert.equal(out, 'Hello');
  assert.deepEqual(deltas.map(d => d[0]), ['Hel', 'lo']);
  assert.equal(deltas[1][1], 'Hello', 'the second callback must see the accumulated text');
});

test('streaming: a stream that carries no content falls back to the JSON body', async () => {
  // some gateways answer with SSE envelopes but put the text in the final JSON
  const fetch = makeFetch([{
    reply: {
      status: 200,
      sse: ['data: {"choices":[{"delta":{}}]}\n\n'],
      json: { choices: [{ message: { content: 'fallback answer' } }] }
    }
  }]);
  const { Aevion } = createApp({ settings: { onlineAI: true, aiProvider: 'openai' }, fetch });
  Aevion.providers.setKey('openai', 'sk-test-key');
  const deltas = [];
  const out = await Aevion.providers.chat(msgs, { onToken: d => deltas.push(d) });
  assert.equal(out, 'fallback answer');
  assert.deepEqual(deltas, ['fallback answer'], 'the fallback text is still streamed to the UI');
});

test('mock provider: answers offline, shapes the reply, and never touches the network', async () => {
  const fetch = makeFetch();
  const { Aevion } = createApp({ settings: { aiProvider: 'mock', onlineAI: false }, fetch });
  const out = await Aevion.providers.chat([{ role: 'user', content: 'ping' }]);
  assert.match(out, /offline test provider/);
  assert.match(out, /ping/);
  assert.equal(fetch.calls.length, 0);
});

test('mock provider: the Test button works with nothing configured', async () => {
  const { Aevion } = createApp({ settings: { aiProvider: 'mock' } });
  const r = await Aevion.providers.test('mock');
  assert.equal(r.ok, true);
  assert.equal(typeof r.ms, 'number');
});

test('webllm provider: explains itself when no model is loaded, works when one is', async () => {
  const { Aevion } = createApp({ settings: { onlineAI: false, aiProvider: 'webllm' } });
  await assert.rejects(() => Aevion.providers.chat(msgs), /No in-browser model is loaded/);

  Aevion.webllm = Aevion.webllm || {};
  Aevion.webllm.isReady = () => true;
  Aevion.webllm.chatStream = async (m, onToken) => { onToken('local', 'local'); return 'local answer'; };
  assert.equal(await Aevion.providers.chat(msgs), 'local answer');
});

test('fallback: a local server takes over when another local server fails', async () => {
  const fetch = makeFetch([
    { match: c => c.url.includes('localhost:11434'), reply: { status: 500, text: 'ollama down', json: {} } },
    { match: c => c.url.includes('localhost:1234'), reply: jsonReply({ choices: [{ message: { content: 'local one' } }] }) }
  ]);
  const { Aevion } = createApp({ settings: { onlineAI: true, aiProvider: 'ollama' }, fetch });
  const r = await Aevion.providers.chatWithFallback(msgs);
  assert.equal(r.text, 'local one');
  assert.equal(r.provider, 'lmstudio');
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /server error/);
});

test('fallback: a failing cloud provider never silently reroutes to another cloud', async () => {
  const fetch = makeFetch([
    { match: c => c.url.includes('api.openai.com'), reply: { status: 500, text: 'boom', json: {} } },
    { match: c => c.url.includes('localhost:1234'), reply: jsonReply({ choices: [{ message: { content: 'LEAKED' } }] }) }
  ]);
  const { Aevion } = createApp({ settings: { onlineAI: true, aiProvider: 'openai' }, fetch });
  Aevion.providers.setKey('openai', 'sk-test-key');
  Aevion.providers.setCfg('lmstudio', { model: 'local-model' });
  /* A fallback has to be able to answer: an in-browser model that was never
     downloaded can only produce an error line, so it is not offered either. */
  assert.deepEqual(plain(Aevion.providers.fallbackIds('openai')), []);
  Aevion.webllm.engine = {};
  Aevion.webllm.loadedModel = 'Llama-3.2-1B-Instruct-q4f32_1-MLC';
  const ids = Aevion.providers.fallbackIds('openai');
  assert.deepEqual(plain(ids), ['webllm'], 'only a provider that cannot reach the internet may take over');
  await assert.rejects(() => Aevion.providers.chatWithFallback(msgs));
  assert.equal(fetch.calls.some(c => c.url.includes('localhost:1234')), false, 'the prompt must not reach a provider the user did not choose');
});

test('fallback: can be switched off completely', async () => {
  const fetch = makeFetch([
    { match: c => c.url.includes('localhost:11434'), reply: { status: 500, text: 'down', json: {} } },
    { match: c => c.url.includes('localhost:1234'), reply: jsonReply({ choices: [{ message: { content: 'local one' } }] }) }
  ]);
  const { Aevion } = createApp({ settings: { onlineAI: true, aiProvider: 'ollama', aiFallback: false }, fetch });
  await assert.rejects(() => Aevion.providers.chatWithFallback(msgs), /server error/);
  assert.equal(fetch.calls.length, 1);
});

test('fallback: when nothing can answer it reports every reason', async () => {
  const fetch = makeFetch([{ reply: { throws: new TypeError('offline') } }]);
  const { Aevion } = createApp({ settings: { onlineAI: true, aiProvider: 'openai' }, fetch });
  await assert.rejects(() => Aevion.providers.chatWithFallback(msgs), e => {
    assert.ok(Array.isArray(e.errors), 'the error must carry the per-provider reasons');
    assert.ok(e.errors.length >= 1);
    return true;
  });
});

/* ---------- free to start: a key that costs nothing must always exist ---------- */

test('free list: every provider that calls itself free is usable and says where the key comes from', () => {
  const { Aevion } = createApp();
  const free = Aevion.providers.freeIds();
  for (const id of ['groq', 'openrouter', 'gemini', 'cerebras', 'mistral', 'huggingface', 'github', 'nvidia', 'sambanova']) {
    assert.ok(free.includes(id), `${id} must be offered as a free-tier provider`);
  }
  assert.ok(!free.includes('webllm') && !free.includes('mock'), 'local providers have no key to fetch');
  for (const id of free) {
    const a = Aevion.providers.get(id);
    assert.ok(a.docs, id + ' must link to the page where its key comes from');
    assert.ok(/^https:\/\/\S+$/.test(a.docs), id + ' must link https, not a sentence');
    assert.equal(a.kind, 'cloud', id + ' is a hosted free tier');
    assert.equal(a.needsKey, true, id + ' needs a key, which is the whole point of the flow');
    assert.match(a.defaults.url, /^https:\/\//, id + ' must have a real endpoint');
    assert.ok(a.defaults.model, id + ' must come with a working default model');
    if (id === 'gemini') {
      // Gemini is the one adapter with its own request shape, not the OpenAI one
      assert.match(a.defaults.url, /\/v1beta\/models$/);
    } else {
      assert.match(a.defaults.url, /\/chat\/completions$/, id + ' must speak the OpenAI shape');
      assert.equal(a.probes, true, id + ' must be checkable with GET /models');
    }
    assert.ok(Aevion.providers.key(id) === '' && Aevion.providers.missing(id).length === 1, id + ' starts unconfigured');
  }
});

test('freeIds(): the picker stays on the providers that actually work', () => {
  const { Aevion } = createApp();
  const ids = Aevion.providers.freeIds();
  assert.ok(ids.includes('gemini'), 'gemini must be in the free picker');
  assert.ok(!ids.includes('webllm') && !ids.includes('mock'), 'local providers are never in the picker');
  assert.deepEqual(plain(ids), ['groq', 'openrouter', 'cerebras', 'mistral', 'huggingface', 'github', 'nvidia', 'sambanova', 'gemini'], 'the list is exactly the nine free tiers in registry order');
});

test('free request: a pasted key is what gets sent, to the endpoint the registry names', async () => {
  const { Aevion, fetch } = ai({ aiProvider: 'cerebras' },
    [{ match: c => c.url.includes('cerebras'), reply: jsonReply({ choices: [{ message: { content: 'fast' } }] }) }]);
  assert.equal(await Aevion.providers.chatWith('cerebras', msgs), 'fast');
  const call = fetch.calls[0];
  assert.equal(call.url, 'https://api.cerebras.ai/v1/chat/completions');
  assert.equal(call.opts.headers.Authorization, 'Bearer sk-test-key');
  assert.equal(call.body.model, 'llama3.1-8b');
});

test('free options: the brain check marks them, so the card can lead with them', async () => {
  const { Aevion } = createApp({ settings: { onlineAI: true, aiProvider: 'groq' }, fetch: makeFetch() });
  const opt = await Aevion.setup.option('mistral');
  assert.equal(opt.free, true);
  assert.equal(opt.state, 'needs');
  assert.match(opt.why, /API key/);
  const paid = await Aevion.setup.option('anthropic');
  assert.equal(paid.free, false);
});

/* ---------- llama.cpp's server: the local brain people usually already have ---------- */

test('registry: llama.cpp server is a keyless loopback brain on its real default port', () => {
  const { Aevion } = createApp();
  const a = Aevion.providers.get('llamacpp');
  assert.ok(a, 'llamacpp must be registered — llama-server’s default port is not the one the ollama entry guesses');
  assert.equal(a.kind, 'loopback');
  assert.equal(a.needsKey, false);
  assert.equal(a.defaults.url, 'http://localhost:8080/v1/chat/completions', 'the port llama-server actually listens on');
  assert.equal(Aevion.setup.modelsUrl('llamacpp'), 'http://localhost:8080/v1/models');
  assert.equal(a.probes, true);
  assert.deepEqual(plain(Aevion.providers.missing('llamacpp')), [], 'a local server needs no key');
  assert.ok(!Aevion.providers.freeIds().includes('llamacpp'), 'not a hosted free tier');
});

/* ---------- Cactus Needle 3: an on-device brain with no key at all ---------- */

test('registry: Needle 3 is a keyless loopback brain whose address you supply', () => {
  const { Aevion } = createApp();
  const a = Aevion.providers.get('needle');
  assert.ok(a, 'needle must be registered');
  assert.equal(a.kind, 'loopback', 'open weights on your own machine, not a cloud service');
  assert.equal(a.needsKey, false, 'there is no key to paste for a local model');
  assert.equal(a.free, false, 'no hosted free tier — so it must never appear in the free-key picker');
  assert.ok(!Aevion.providers.freeIds().includes('needle'), 'it is not a “get a free key” provider');
  assert.equal(a.probes, true, 'Cactus serves an OpenAI-compatible listing, so it can be checked');
  assert.match(a.docs, /^https:\/\/\S+$/);
  assert.equal(a.defaults.model, 'needle3');
  assert.deepEqual(plain(Aevion.providers.missing('needle')), ['endpoint URL'], 'the address is deliberately left for you');
  const v = Aevion.setup.verdict('needle');
  assert.equal(v.state, 'needs');
  assert.match(v.text, /endpoint URL/);
});

test('needle: an address is all it needs, and it speaks the OpenAI shape without a key', async () => {
  const fetch = makeFetch([
    { match: c => c.url.includes('/chat/completions'), reply: jsonReply({ choices: [{ message: { content: 'tool chosen' } }] }) }
  ]);
  const { Aevion } = createApp({ settings: { onlineAI: true, aiProvider: 'needle' }, fetch });
  assert.deepEqual(plain(Aevion.providers.missing('needle')), ['endpoint URL']);
  Aevion.providers.setCfg('needle', { url: 'http://localhost:8000/v1/chat/completions' });
  assert.deepEqual(plain(Aevion.providers.missing('needle')), [], 'the endpoint was the only thing missing');
  assert.equal(Aevion.setup.modelsUrl('needle'), 'http://localhost:8000/v1/models');
  assert.equal(await Aevion.providers.chatWith('needle', msgs), 'tool chosen');
  const call = fetch.calls[0];
  assert.equal(call.url, 'http://localhost:8000/v1/chat/completions');
  assert.equal(call.opts.headers.Authorization, undefined, 'a local brain sends no key');
  assert.equal(call.body.model, 'needle3');
});

/* ---------- OpenRouter: one key, many models — Nex-N2.5 included ---------- */

test('registry: OpenRouter is a probeable, OpenAI-compatible cloud provider', () => {
  const { Aevion } = createApp();
  const a = Aevion.providers.get('openrouter');
  assert.ok(a, 'openrouter must be registered');
  assert.equal(a.kind, 'cloud');
  assert.equal(a.defaults.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(a.defaults.model, 'nex-agi/nex-n2.5-mini', 'Nex-N2.5 Mini is the default brain there');
  assert.equal(a.probes, true, 'it can be checked with GET /models');
  assert.equal(Aevion.setup.modelsUrl('openrouter'), 'https://openrouter.ai/api/v1/models');
  assert.deepEqual(plain(Aevion.providers.missing('openrouter')), ['API key']);
});

test('openrouter: the request it builds carries the model, the key and the messages', async () => {
  const { Aevion, fetch } = ai({ aiProvider: 'openrouter' },
    [{ match: c => c.url.includes('openrouter.ai'), reply: jsonReply({ choices: [{ message: { content: 'ok' } }] }) }]);
  const out = await Aevion.providers.chatWith('openrouter', msgs);
  assert.equal(out, 'ok');
  const call = fetch.calls[0];
  assert.equal(call.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(call.opts.headers.Authorization, 'Bearer sk-test-key');
  assert.equal(call.body.model, 'nex-agi/nex-n2.5-mini');
  assert.equal(call.body.messages.length, msgs.length);
});

test('openrouter: any model id works, so a newer Nex-N2.5 is one box away', async () => {
  const { Aevion } = createApp({ settings: { onlineAI: true, aiProvider: 'openrouter' } });
  Aevion.providers.setCfg('openrouter', { model: 'nex-agi/nex-n2.5-pro' });
  assert.equal(Aevion.providers.cfg('openrouter').model, 'nex-agi/nex-n2.5-pro');
  assert.equal(Aevion.providers.cfg('openrouter').url, 'https://openrouter.ai/api/v1/chat/completions');
});

test('usableIds: local providers are always available, cloud ones need the switch', () => {
  const off = createApp({ settings: { onlineAI: false } }).Aevion;
  assert.ok(off.providers.usableIds().includes('webllm'));
  assert.ok(off.providers.usableIds().includes('mock'));
  assert.equal(off.providers.usableIds().includes('openai'), false);
  const on = createApp({ settings: { onlineAI: true } }).Aevion;
  assert.ok(on.providers.usableIds().includes('openai'));
});
