/* ============================================================
 * Aevion Theme — presets plus a custom layer on top of them.
 *
 * How it works, in plain words:
 *   - A theme is a set of CSS variables (css/themes.css). Picking one sets
 *     data-theme and nothing else changes.
 *   - On top of that, EVERY knob can be overridden one at a time and the
 *     override is stored in settings, so a theme you like plus two changes
 *     survives a reload. Clearing one knob puts the preset's value back.
 *   - The knobs are colours (accent, backgrounds, text, borders) and shape
 *     (corner radius, text size, panel blur, glow). The theme file defines
 *     the defaults; this module only ever writes what the user asked for.
 *
 * Why validation is strict: these values become CSS. A colour is accepted
 * only if it is a plain hex, rgb() or hsl() value, and numbers only inside
 * their range, so a pasted theme cannot smuggle in url(), expression() or
 * anything that reaches off the device. Loading an exported theme reports
 * what it rejected instead of silently dropping it.
 * ============================================================ */
(function () {
  const T = {};

  /* One entry per knob: what it is called, which CSS variable it writes, how
     to validate it, and the range for the ones that are numbers. */
  T.KNOBS = [
    { key: 'accent',    cssVar: '--accent',       type: 'color',  label: 'Accent',            group: 'Colour' },
    { key: 'accent2',   cssVar: '--accent2',      type: 'color',  label: 'Second accent',     group: 'Colour' },
    { key: 'bg',        cssVar: '--bg',           type: 'color',  label: 'Background',        group: 'Colour' },
    { key: 'bg2',       cssVar: '--bg2',          type: 'color',  label: 'Raised surface',    group: 'Colour' },
    { key: 'panel',     cssVar: '--panel',        type: 'color',  label: 'Panels',            group: 'Colour', alpha: true },
    { key: 'line',      cssVar: '--line',         type: 'color',  label: 'Borders',           group: 'Colour' },
    { key: 'text',      cssVar: '--text',         type: 'color',  label: 'Text',              group: 'Colour' },
    { key: 'muted',     cssVar: '--muted',        type: 'color',  label: 'Secondary text',    group: 'Colour' },
    { key: 'radius',    cssVar: '--radius',       type: 'length', label: 'Corner radius',     group: 'Shape', min: 0,  max: 28 },
    { key: 'fontScale', cssVar: '--fs-scale',     type: 'number', label: 'Text size',         group: 'Shape', min: .85, max: 1.4, step: .05 },
    { key: 'blur',      cssVar: '--blur',         type: 'length', label: 'Panel blur',        group: 'Shape', min: 0,  max: 30 },
    { key: 'glow',      cssVar: '--glow-strength', type: 'number', label: 'Glow',             group: 'Shape', min: 0,  max: 1, step: .05 }
  ];

  /* The names must match the [data-theme="…"] blocks in css/themes.css. */
  T.THEMES = ['cyber', 'midnight', 'aurora', 'synthwave', 'light', 'mono'];

  T.knob = key => T.KNOBS.find(k => k.key === key) || null;
  T.knobsIn = group => T.KNOBS.filter(k => k.group === group);

  /* ---------- validation ---------- */

  const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
  const FUNC = /^(?:rgb|rgba|hsl|hsla)\(\s*[0-9.%,\s/]+\)$/i;

  /* A colour, or nothing. Anything that could carry a URL, an expression or a
     second declaration is refused — this value ends up in a stylesheet. */
  T.cleanColor = function (value) {
    const v = String(value == null ? '' : value).trim();
    if (!v || v.length > 64) return null;
    if (/[;{}\\()'"<>\n]/.test(v) && !FUNC.test(v)) return null;
    if (HEX.test(v)) return v.toLowerCase();
    if (FUNC.test(v)) return v.replace(/\s+/g, '');
    return null;
  };

  T.cleanNumber = function (key, value) {
    const k = T.knob(key);
    if (!k || (k.type !== 'number' && k.type !== 'length')) return null;
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    const clamped = Math.min(k.max, Math.max(k.min, n));
    return Math.round(clamped * 100) / 100;
  };

  /* -> the value to store, or null if this is not a usable value for the knob */
  T.clean = function (key, value) {
    const k = T.knob(key);
    if (!k) return null;
    if (k.type === 'color') return T.cleanColor(value);
    return T.cleanNumber(key, value);
  };

  /* ---------- reading and writing the stored overrides ---------- */

  function store() {
    if (!Aevion.settings) return {};
    if (!Aevion.settings.themeCustom || typeof Aevion.settings.themeCustom !== 'object') {
      Aevion.settings.themeCustom = {};
    }
    return Aevion.settings.themeCustom;
  }

  T.value = function (key) {
    const v = store()[key];
    return v === undefined ? null : v;
  };
  T.overrides = () => Object.assign({}, store());
  T.isCustom = () => Object.keys(T.overrides()).length > 0;
  /* Safe before boot(): the UI builds its controls while Aevion.settings is
     still null, and a theme is not worth throwing over. */
  T.theme = () => {
    const name = Aevion.settings ? Aevion.settings.theme : null;
    return T.THEMES.includes(name) ? name : T.THEMES[0];
  };

  /* ---------- following the device, without losing your own choice ----------
     The theme you picked is stored once and never overwritten. When
     "follow the device" is on, the effective theme is derived from it:
     the device in dark mode gets your theme, the device in light mode gets
     the light preset. Turning the switch off therefore always restores
     exactly what you had — that is the "remember the previous theme"
     promise, and it costs one setting, not a history log. */
  T.deviceScheme = function () {
    try {
      if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
        if (window.matchMedia('(prefers-color-scheme: light)').matches) return 'light';
        if (window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
      }
    } catch { /* older WebViews have no matchMedia */ }
    return 'dark';   // no signal: your own theme is the safe answer
  };

  T.followDevice = () => !!(Aevion.settings && Aevion.settings.followDevice);

  /* Which preset [data-theme] actually gets right now. */
  T.effective = function () {
    const mine = T.theme();
    if (!T.followDevice()) return mine;
    return T.deviceScheme() === 'light' ? (mine === 'light' ? mine : 'light') : mine;
  };

  T.setFollowDevice = function (on) {
    if (!Aevion.settings) return null;
    Aevion.settings.followDevice = !!on;
    Aevion.store.set('settings', Aevion.settings);
    T.apply();
    Aevion.emit('theme:changed', { key: 'followDevice', value: !!on, overrides: T.overrides() });
    return !!on;
  };

  /* Re-apply when the device flips between light and dark. Returns an
     unsubscribe function, so a caller can stop watching. */
  T.watchDevice = function () {
    try {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
      const mq = window.matchMedia('(prefers-color-scheme: light)');
      const onChange = () => { if (T.followDevice()) T.apply(); };
      if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onChange);
      else if (typeof mq.addListener === 'function') mq.addListener(onChange);
      return () => {
        if (typeof mq.removeEventListener === 'function') mq.removeEventListener('change', onChange);
        else if (typeof mq.removeListener === 'function') mq.removeListener(onChange);
      };
    } catch { return () => {}; }
  };

  function commit(key, value) {
    const s = store();
    if (value === null || value === undefined) delete s[key];
    else s[key] = value;
    Aevion.settings.themeCustom = s;
    Aevion.store.set('settings', Aevion.settings);
    T.apply();
    Aevion.emit('theme:changed', { key, value: value === undefined ? null : value, overrides: T.overrides() });
    return value === undefined ? null : value;
  }

  /* ---------- the CSS the knobs produce ---------- */

  /* The glow is derived from whatever accent is in effect, so it follows a
     custom accent automatically. Browsers without color-mix() simply keep the
     preset's own glow (the declaration does not resolve). */
  function glowFor(strength) {
    const alpha = Math.round(strength * 40);
    return '0 0 18px color-mix(in srgb, var(--accent) ' + alpha + '%, transparent)';
  }

  T.cssFor = function (key, value) {
    const k = T.knob(key);
    if (!k || value === null || value === undefined) return null;
    if (key === 'glow') return { cssVar: '--glow', value: glowFor(value) };
    if (k.type === 'length') return { cssVar: k.cssVar, value: value + 'px' };
    return { cssVar: k.cssVar, value: String(value) };
  };

  /* ---------- applying ---------- */

  T.apply = function () {
    const root = typeof document !== 'undefined' ? document.documentElement : null;
    if (!root) return false;
    root.dataset.theme = T.effective();

    const custom = T.overrides();
    for (const k of T.KNOBS) {
      const css = T.cssFor(k.key, custom[k.key] === undefined ? null : custom[k.key]);
      /* Clear first, always: an override that was removed has to fall back to
         the preset, and a leftover inline value would silently pin the old one. */
      root.style.removeProperty(k.cssVar);
      if (css) root.style.setProperty(css.cssVar, css.value);
    }
    return true;
  };

  T.setTheme = function (name) {
    if (!Aevion.settings || !T.THEMES.includes(name)) return null;
    Aevion.settings.theme = name;
    Aevion.store.set('settings', Aevion.settings);
    T.apply();
    Aevion.emit('theme:changed', { key: 'theme', value: name, overrides: T.overrides() });
    return name;
  };

  T.set = function (key, value) {
    const clean = T.clean(key, value);
    if (clean === null) return null;
    return commit(key, clean);
  };

  T.reset = key => commit(key, undefined);
  T.resetCustom = function () {
    const had = T.isCustom();
    Aevion.settings.themeCustom = {};
    Aevion.store.set('settings', Aevion.settings);
    T.apply();
    Aevion.emit('theme:changed', { key: 'reset', value: null, overrides: {} });
    return had;
  };

  /* ---------- sharing a theme as text ---------- */

  T.exportText = function () {
    const custom = T.overrides();
    const keys = T.KNOBS.map(k => k.key).filter(k => custom[k] !== undefined);
    return 'theme=' + T.theme() + ';' + keys.map(k => k + '=' + custom[k]).join(';');
  };

  /* Loads text like "theme=mono;accent=#ff0;radius=4". Returns what it did,
     including every value it refused, so the UI can be honest about it. */
  T.loadText = function (text) {
    const result = { applied: [], rejected: [], theme: null };
    const parts = String(text == null ? '' : text).split(';').map(p => p.trim()).filter(Boolean);
    for (const part of parts) {
      const eq = part.indexOf('=');
      if (eq < 0) { result.rejected.push(part); continue; }
      const key = part.slice(0, eq).trim();
      const raw = part.slice(eq + 1).trim();
      if (key === 'theme') {
        if (T.setTheme(raw)) { result.applied.push('theme'); result.theme = raw; }
        else result.rejected.push(part);
        continue;
      }
      if (T.set(key, raw) === null) result.rejected.push(part);
      else result.applied.push(key);
    }
    return result;
  };

  Aevion.theme = T;
})();
