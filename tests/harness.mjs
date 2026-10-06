/* ============================================================
 * Aevion test harness — runs the REAL browser modules headlessly.
 *
 * The modules in aevion/js/ are plain IIFEs that attach to a
 * global `Aevion` object and expect browser globals (localStorage,
 * CustomEvent, crypto, navigator, fetch...). This harness builds a
 * fresh sandbox with those globals faked, then evaluates the exact
 * files index.html loads — in the same order.
 *
 * That means the tests exercise shipped code, not a copy of it, and
 * a module that is added to index.html is picked up automatically.
 * ============================================================ */
import { readFileSync, existsSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');
export const APP = path.join(ROOT, 'aevion');

export function appFile(rel) {
  return path.join(APP, rel.split('?')[0]);
}

export function readApp(rel) {
  return readFileSync(appFile(rel), 'utf8');
}

/* ---------- browser global fakes ---------- */

/* A localStorage that behaves like the real thing. Stored keys are plain
   enumerable properties (core.js scans them with Object.keys); the API
   itself is non-enumerable, exactly like the real Storage object. */
export function makeStorage({ quota = Infinity } = {}) {
  const o = {};
  let bytes = 0;
  let dead = false;                       // set once the quota is blown

  const keys = () => Object.keys(o);
  const api = {
    getItem(k) { return Object.prototype.hasOwnProperty.call(o, k) ? o[k] : null; },
    setItem(k, v) {
      const s = String(v);
      if (dead) throw new Error('QuotaExceededError');
      const prev = Object.prototype.hasOwnProperty.call(o, k) ? o[k].length : 0;
      if (bytes - prev + s.length > quota) { dead = true; throw new Error('QuotaExceededError'); }
      bytes += s.length - prev;
      o[k] = s;
    },
    removeItem(k) { if (Object.prototype.hasOwnProperty.call(o, k)) { bytes -= o[k].length; delete o[k]; } },
    clear() { for (const k of keys()) api.removeItem(k); },
    key(i) { return keys()[i] ?? null; },
    get length() { return keys().length; },
    get bytes() { return bytes; }
  };
  for (const [name, value] of Object.entries(Object.getOwnPropertyDescriptors(api))) {
    Object.defineProperty(o, name, Object.assign({}, value, { enumerable: false }));
  }
  return o;
}

class FakeEvent {
  constructor(type, opts = {}) {
    this.type = type;
    this.detail = opts.detail;
    this.defaultPrevented = false;
  }
}

class FakeEventTarget {
  constructor() { this._listeners = new Map(); }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const l = this._listeners.get(type) || [];
    const i = l.indexOf(fn);
    if (i >= 0) l.splice(i, 1);
  }
  dispatchEvent(e) {
    for (const fn of [...(this._listeners.get(e.type) || [])]) fn(e);
    return true;
  }
}

/* A fake ReadableStream with getReader(), so SSE parsing is testable. */
export function streamFrom(chunks) {
  const enc = new TextEncoder();
  let i = 0;
  return {
    getReader: () => ({
      read: async () => (i < chunks.length ? { done: false, value: enc.encode(chunks[i++]) } : { done: true, value: undefined }),
      releaseLock: () => {}
    })
  };
}

/* Records every fetch so tests can assert on URLs/headers/bodies. */
export function makeFetch(handlers = []) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    let parsedBody = null;
    try { parsedBody = opts.body ? JSON.parse(opts.body) : null; } catch { parsedBody = opts.body; }
    const call = { url: String(url), opts, body: parsedBody };
    calls.push(call);
    const handler = handlers.find(h => (h.match ? h.match(call) : true));
    if (!handler) return { ok: false, status: 404, json: async () => ({}), text: async () => 'no handler registered', body: null };
    const r = typeof handler.reply === 'function' ? handler.reply(call) : handler.reply;
    if (r.throws) throw r.throws;
    return {
      ok: r.status ? r.status < 400 : true,
      status: r.status || 200,
      json: async () => r.json,
      text: async () => (typeof r.text === 'string' ? r.text : JSON.stringify(r.json)),
      body: r.sse ? streamFrom(r.sse) : null
    };
  };
  fn.calls = calls;
  return fn;
}

export function jsonReply(json, status = 200) {
  return { status, json };
}

/* Server-sent-events reply: sseReply(['data: {...}', ...]) */
export function sseReply(lines, status = 200) {
  return { status, sse: lines.map(l => l + '\n\n') };
}

/**
 * Build a fresh Aevion instance.
 * @param {object}   opts
 * @param {object}   opts.settings  partial settings override (merged over defaults)
 * @param {string[]} opts.modules   module paths relative to aevion/ (default: everything index.html loads)
 * @param {Function} opts.fetch     fetch mock
 * @param {object}   opts.globals   extra sandbox globals
 */
export function createApp(opts = {}) {
  const sandbox = {};
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.console = opts.silent === false ? console : { log() {}, warn() {}, error() {}, info() {} };
  sandbox.localStorage = opts.storage || makeStorage();
  sandbox.sessionStorage = opts.sessionStorage || makeStorage();
  sandbox.CustomEvent = FakeEvent;
  sandbox.Event = FakeEvent;
  sandbox.EventTarget = FakeEventTarget;
  sandbox.crypto = webcrypto;
  sandbox.setTimeout = setTimeout;
  sandbox.clearTimeout = clearTimeout;
  sandbox.setInterval = setInterval;
  sandbox.clearInterval = clearInterval;
  sandbox.fetch = opts.fetch || makeFetch();
  sandbox.AbortController = AbortController;
  sandbox.TextEncoder = TextEncoder;
  sandbox.TextDecoder = TextDecoder;
  sandbox.btoa = btoa;
  sandbox.atob = atob;
  sandbox.Blob = class Blob { constructor() {} };
  sandbox.URL = URL;
  sandbox.location = { protocol: 'https:', origin: 'https://aevion.test', href: 'https://aevion.test/index.html', reload() {} };
  // opening a link is a real side effect: record it instead of doing it
  const opened = [];
  sandbox.open = url => { opened.push(String(url)); return null; };

  // a tiny helper so test-only modules can wrap fire-and-forget async work.
  // using it inside a real test() still works; it only quietly ignores any
  // rejection a test author chose not to await.
  const __w = { settled: Promise.resolve(true), count: 0 };
  sandbox.awaitless = function(asyncFn) {
    __w.count++;
    const p = Promise.resolve().then(() => asyncFn()).catch(err => {
      if (__w.count > 0) console.error('[awaitless] unhandled:', err);
      __w.count--;
    });
    __w.settled.then(() => __w.count--).catch(() => {});
    __w.settled = __w.settled.then(() => p, () => {}).catch(() => {});
    return p;
  };
  sandbox.speakAnd = async function(text) { sandbox.Aevion && sandbox.Aevion.wake && sandbox.Aevion.wake.notifySpeaking && await sandbox.Aevion.wake.notifySpeaking(text); };
  sandbox.navigator = Object.assign({
    platform: 'TestOS',
    onLine: true,
    userAgent: 'aevion-test',
    language: 'en-US',
    gpu: undefined,
    geolocation: undefined,
    mediaDevices: undefined
  }, opts.navigator || {});
  sandbox.document = opts.document || { querySelector: () => null, querySelectorAll: () => [], createElement: () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} }, appendChild() {}, setAttribute() {} }) };
  // Capacitor / Web Speech are absent unless a test installs them
  sandbox.speechSynthesis = undefined;
  sandbox.SpeechRecognition = undefined;
  Object.assign(sandbox, opts.globals || {});

  const context = createContext(sandbox);

  // load order: mirror index.html (single source of truth) unless overridden
  const modules = opts.modules || modulesFromIndex();
  const loaded = [];
  for (const m of modules) {
    const file = appFile(m);
    if (!existsSync(file)) throw new Error(`module not found on disk: ${m}`);
    runInContext(readFileSync(file, 'utf8'), context, { filename: file });
    loaded.push(m);
  }

  const Aevion = sandbox.Aevion;
  if (!Aevion) throw new Error('modules did not create window.Aevion');

  // settings need bootstrapping the same way app.js does it
  Aevion.settings = Object.assign({}, Aevion.defaults, sandbox.localStorage.getItem('aevion:settings')
    ? JSON.parse(sandbox.localStorage.getItem('aevion:settings')) : {}, opts.settings || {});
  Aevion.settings.perms = Object.assign({}, Aevion.defaults.perms, Aevion.settings.perms);
  if (opts.settings && opts.settings.perms) Object.assign(Aevion.settings.perms, opts.settings.perms);
  Aevion.store.set('settings', Aevion.settings);

  return { Aevion, sandbox, context, loaded, opened, fetch: sandbox.fetch, storage: sandbox.localStorage };
}

/* Read index.html and return the script tags it loads, minus the
   DOM-only ones (app.js wires the UI; plugins self-register). */
export function modulesFromIndex() {
  const html = readApp('index.html');
  return [...html.matchAll(/<script\s+src="([^"]+)"/g)]
    .map(m => m[1].split('?')[0])
    .filter(src => !src.endsWith('app.js') && !src.includes('/plugins/'));
}

/* Convenience: a ready-to-use app with custom settings. */
export function app(settings = {}, opts = {}) {
  return createApp({ settings, ...opts });
}

/* Objects created inside the VM live in another realm, so their
   prototypes differ and assert.deepStrictEqual would reject them.
   JSON round-trip brings a value back into this realm as plain data
   (which is exactly how it is stored on disk anyway). */
export function plain(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}
