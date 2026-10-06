/* Tests for the in-browser engine's guards (js/webllm.js).
   They exist because of a real failure: the engine is vendored as a single
   ESM file, its WebAssembly runtime was missing from the build, and a model
   load therefore waited forever with no progress and no error — the worst
   possible way to look broken. A build that cannot run a model must say so
   in one sentence, immediately, and it must not look like it is working. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, makeFetch, jsonReply } from './harness.mjs';

const MODEL = 'Llama-3.2-1B-Instruct-q4f32_1-MLC';

test('a build without the engine runtime refuses to start, in plain words', async () => {
  const fetch = makeFetch([{ match: c => c.url.includes('tvmjs_runtime'), reply: { status: 404, json: {} } }]);
  const { Aevion } = createApp({ fetch });
  Aevion.webllm.gpuSupported = () => true;                 // the GPU is not the problem here

  await assert.rejects(() => Aevion.webllm.load(MODEL), /runtime file/);
  assert.equal(Aevion.webllm.loading, false, 'a refused load must not look like a running one');
  assert.equal(Aevion.webllm.isReady(), false);
  assert.equal(Aevion.webllm.loadedModel, null);
});

test('the runtime is asked for once per page, not on every tap', async () => {
  const fetch = makeFetch([{ match: c => c.url.includes('tvmjs_runtime'), reply: { status: 404, json: {} } }]);
  const { Aevion } = createApp({ fetch });
  assert.equal(await Aevion.webllm.checkRuntime(), false);
  assert.equal(await Aevion.webllm.checkRuntime(), false);
  assert.equal(fetch.calls.filter(c => c.url.includes('tvmjs_runtime')).length, 1);
});

test('the runtime check never leaves the device', async () => {
  const fetch = makeFetch([{ match: c => c.url.includes('tvmjs_runtime'), reply: jsonReply({ ok: true }) }]);
  const { Aevion } = createApp({ fetch });
  assert.equal(await Aevion.webllm.checkRuntime(), true);
  const urls = fetch.calls.map(c => c.url);
  assert.ok(urls.every(u => !/^https?:/.test(u) || u.includes('127.0.0.1') || u.includes('localhost')), 'it is a same-origin file, not a network call');
});

test('with the runtime present the guard lets the load through, and still never hangs', async () => {
  const fetch = makeFetch([{ match: c => c.url.includes('tvmjs_runtime'), reply: jsonReply({ ok: true }) }]);
  const { Aevion } = createApp({ fetch });
  Aevion.webllm.gpuSupported = () => true;
  assert.equal(await Aevion.webllm.checkRuntime(), true);

  /* The engine import cannot run inside the VM, so this is expected to fail —
     the point is that it fails with the engine's own error rather than the
     missing-file one, and that the state is left clean. */
  await assert.rejects(() => Aevion.webllm.load(MODEL), e => !/runtime file/.test(e.message));
  assert.equal(Aevion.webllm.loading, false);
});

test('an unknown model is refused before anything is fetched', async () => {
  const fetch = makeFetch([{ match: () => true, reply: jsonReply({ ok: true }) }]);
  const { Aevion } = createApp({ fetch });
  Aevion.webllm.gpuSupported = () => true;
  await assert.rejects(() => Aevion.webllm.load('Not-A-Real-Model'), /Unknown model/);
  assert.equal(fetch.calls.length, 0);
});
