/* ============================================================
 * Aevion WebLLM — in-browser AI, zero server, zero API keys
 *
 * Runs a small language model on your GPU via WebGPU. Model
 * weights download ONCE from Hugging Face (mlc-ai mirrors),
 * are cached in the browser's Cache storage, and after that
 * the model runs 100% locally and offline.
 *
 * This module never sends your text anywhere: it only fetches
 * public model files when you first download a model.
 * ============================================================ */
(function () {
  const W = {
    engine: null,
    loading: false,
    loadedModel: null,
    f16: null, // set by detect(): whether GPU supports shader-f16
    // Curated small models. q4f32 runs on ALL WebGPU GPUs;
    // q4f16 is smaller/faster but needs the shader-f16 feature.
    MODELS: [
      { id: 'Llama-3.2-1B-Instruct-q4f32_1-MLC', label: 'Llama 3.2 1B — fastest, ~1.1 GB', vramGB: 1.6 },
      { id: 'Qwen2.5-1.5B-Instruct-q4f32_1-MLC', label: 'Qwen 2.5 1.5B — balanced, ~1.5 GB', vramGB: 2.2 },
      { id: 'gemma-2-2b-it-q4f32_1-MLC', label: 'Gemma 2 2B — Google, ~2.0 GB', vramGB: 2.7 },
      { id: 'Llama-3.2-3B-Instruct-q4f32_1-MLC', label: 'Llama 3.2 3B — smartest, ~2.6 GB', vramGB: 3.4 },
      { id: 'Llama-3.2-1B-Instruct-q4f16_1-MLC', label: 'Llama 3.2 1B (f16, faster — needs newer GPU)', vramGB: 1.2, requiresF16: true },
      { id: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC', label: 'Qwen 2.5 1.5B (f16 — needs newer GPU)', vramGB: 1.8, requiresF16: true }
    ]
  };

  /* ---------- capability detection ---------- */
  W.gpuSupported = function () {
    try { return !!navigator.gpu; } catch { return false; }
  };

  /* Detect shader-f16 (q4f16 models need it; q4f32 works everywhere) */
  W.detect = async function () {
    if (!W.gpuSupported()) { W.f16 = false; return false; }
    try {
      const a = await navigator.gpu.requestAdapter();
      W.f16 = !!(a && a.features && a.features.has('shader-f16'));
    } catch { W.f16 = false; }
    return W.f16;
  };

  /* Models this GPU can actually run */
  W.availableModels = function () {
    return W.MODELS.filter(m => !m.requiresF16 || W.f16);
  };

  W.storedProgress = function () {
    return Aevion.store.get('webllmDownloaded', []);
  };

  /* ---------- engine loading ---------- */
  /* ---------- the runtime file, and the watchdog ----------
     The engine is vendored as a single ESM file, but its WebAssembly runtime
     is resolved by Emscripten *next to that file* (vendor/tvmjs_runtime.wasm).
     A bundle shipped without it does not error — it waits forever, with no
     progress and no message, which is the worst possible way to look broken.
     So the file is asked for first, and every load carries a watchdog. */
  W.RUNTIME_FILE = 'vendor/tvmjs_runtime.wasm';
  W.STALL_MS = 60000;

  /* Same-origin GET, headers only: this never leaves the device. */
  W.checkRuntime = async function () {
    if (W.runtimeMissing !== undefined) return !W.runtimeMissing;
    W.runtimeMissing = false;
    try {
      const ctl = typeof AbortController === 'function' ? new AbortController() : null;
      const r = await fetch(W.RUNTIME_FILE, { method: 'GET', signal: ctl ? ctl.signal : undefined });
      W.runtimeMissing = !(r && r.ok);
      if (ctl) ctl.abort();          // the headers were the whole question
    } catch {
      W.runtimeMissing = true;
    }
    return !W.runtimeMissing;
  };

  W.load = async function (modelId, onProgress) {
    if (W.loading) throw new Error('A model is already loading — wait for it to finish.');
    if (!W.gpuSupported()) throw new Error('WebGPU not available in this browser (use Chrome/Edge 113+).');

    const mod = W.MODELS.find(m => m.id === modelId);
    if (!mod) throw new Error('Unknown model: ' + modelId);

    if (!(await W.checkRuntime())) {
      W.loading = false;
      throw new Error('This build of Aevion is missing the engine’s runtime file (' + W.RUNTIME_FILE +
        '), so no in-browser model can start. Nothing else is affected: use a server on your own machine (Ollama, LM Studio) ' +
        'or a hosted key — the 🧠 card above the chat box checks which of those are reachable.');
    }

    W.loading = true;
    W.progressAt = Date.now();
    let watchdog = null;
    const stalled = new Promise((_, reject) => {
      watchdog = setInterval(() => {
        if (!W.loading) return;
        if (Date.now() - W.progressAt > W.STALL_MS) {
          reject(new Error('the model stopped making progress for ' + Math.round(W.STALL_MS / 1000) +
            ' s — this network may be blocking the model files, or the GPU ran out of memory. Nothing was changed; you can try again.'));
        }
      }, 5000);
    });

    try {
      const webllm = await import('../vendor/webllm.esm.js');
      const engine = await Promise.race([
        webllm.CreateMLCEngine(modelId, {
          initProgressCallback: p => {
            W.progressAt = Date.now();
            // p.progress: 0..1, p.text: human-readable status
            if (onProgress) onProgress(p);
          }
        }),
        stalled
      ]);
      W.engine = engine;
      W.loadedModel = modelId;
      const done = W.storedProgress();
      if (!done.includes(modelId)) { done.push(modelId); Aevion.store.set('webllmDownloaded', done); }
      return engine;
    } catch (e) {
      W.engine = null;
      W.loadedModel = null;
      throw e;
    } finally {
      W.loading = false;
      if (watchdog) clearInterval(watchdog);
    }
  };

  W.unload = async function () {
    if (W.engine) {
      try { await W.engine.unload(); } catch {}
      W.engine = null;
      W.loadedModel = null;
    }
  };

  W.isReady = function () { return !!(W.engine && W.loadedModel); };

  /* ---------- generation ---------- */
  /* calls onToken(delta, fullText) repeatedly, returns the full text */
  W.chatStream = async function (messages, onToken) {
    if (!W.isReady()) throw new Error('No in-browser model loaded.');
    const stream = await W.engine.chat.completions.create({ messages, stream: true, temperature: 0.7, max_tokens: 700 });
    let full = '';
    for await (const chunk of stream) {
      const delta = (chunk.choices && chunk.choices[0] && chunk.choices[0].delta && chunk.choices[0].delta.content) || '';
      if (delta) { full += delta; onToken(delta, full); }
    }
    return full.trim();
  };

  Aevion.webllm = W;
})();
