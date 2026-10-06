/* Tests for theme.js — the preset themes plus the custom layer on top.
   The security-shaped part matters most here: a theme can be pasted in from
   anywhere, and its values end up in a stylesheet, so a value that is not a
   plain colour or number has to be refused rather than trusted. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, plain } from './harness.mjs';

/* The harness has no DOM, so documentElement is faked just enough to record
   what the theme engine writes — which is exactly what is being tested. */
function makeRoot() {
  const props = new Map();
  return {
    props,
    dataset: {},
    style: {
      setProperty: (k, v) => props.set(k, v),
      removeProperty: k => props.delete(k),
      getPropertyValue: k => props.get(k) || ''
    }
  };
}

function themeApp(settings = {}) {
  const root = makeRoot();
  const app = createApp({
    settings,
    document: { documentElement: root, querySelector: () => null, querySelectorAll: () => [] }
  });
  return { Aevion: app.Aevion, root, app };
}

/* ---------- the knobs ---------- */

test('every knob writes a CSS variable and is either a colour or a number', () => {
  const { Aevion } = themeApp();
  assert.ok(Aevion.theme.KNOBS.length >= 10, 'there should be a real set of knobs');
  const keys = Aevion.theme.KNOBS.map(k => k.key);
  assert.equal(new Set(keys).size, keys.length, 'no duplicate knobs');
  for (const k of Aevion.theme.KNOBS) {
    assert.match(k.cssVar, /^--[a-z][a-z0-9-]*$/, `${k.key} needs a CSS variable`);
    assert.ok(k.label, `${k.key} needs a label`);
    assert.ok(['color', 'number', 'length'].includes(k.type), `${k.key} has type ${k.type}`);
    if (k.type !== 'color') assert.ok(k.min < k.max, `${k.key} needs a range`);
  }
  assert.ok(Aevion.theme.knobsIn('Colour').length >= 6, 'colours are the bulk of it');
  assert.ok(Aevion.theme.knobsIn('Shape').length >= 3, 'and shape is more than a colour');
});

test('the theme names match the ones the stylesheet defines', () => {
  const { Aevion } = themeApp();
  assert.deepEqual(plain(Aevion.theme.THEMES), ['cyber', 'midnight', 'aurora', 'synthwave', 'light', 'mono']);
  assert.equal(Aevion.theme.theme(), 'cyber', 'the first theme is the default');
});

/* ---------- validation ---------- */

test('a colour is accepted only if it is a plain colour', () => {
  const { Aevion } = themeApp();
  for (const good of ['#0af', '#37e0c8', '#37e0c8ff', 'rgb(10, 20, 30)', 'rgba(10,20,30,.5)', 'hsl(200 50% 40%)']) {
    assert.ok(Aevion.theme.cleanColor(good), `${good} should be accepted`);
  }
  for (const bad of [
    'javascript:alert(1)',
    'url(https://evil.test/x.png)',
    'red; background: url(https://evil.test)',
    'expression(alert(1))',
    '#fff} body { background: url(https://evil.test) ',
    'var(--bg)',
    '"quoted"',
    'a'.repeat(80),
    '',
    null
  ]) {
    assert.equal(Aevion.theme.cleanColor(bad), null, `${bad} must be refused`);
  }
});

test('numbers are clamped to their range instead of being written through', () => {
  const { Aevion } = themeApp();
  assert.equal(Aevion.theme.cleanNumber('radius', 999), 28);
  assert.equal(Aevion.theme.cleanNumber('radius', -5), 0);
  assert.equal(Aevion.theme.cleanNumber('fontScale', 0.1), 0.85);
  assert.equal(Aevion.theme.cleanNumber('fontScale', 1.1), 1.1);
  assert.equal(Aevion.theme.cleanNumber('radius', 'abc'), null);
  assert.equal(Aevion.theme.cleanNumber('radius', NaN), null);
  assert.equal(Aevion.theme.cleanNumber('nope', 5), null);
});

test('an unknown knob is refused rather than invented', () => {
  const { Aevion, root } = themeApp();
  assert.equal(Aevion.theme.set('made-up', '#fff'), null);
  assert.equal(Aevion.theme.set('accent', 'url(https://evil.test)'), null);
  assert.equal(root.props.get('--accent'), undefined, 'nothing was written');
});

/* ---------- applying ---------- */

test('nothing is written until the user changes something', () => {
  const { Aevion, root } = themeApp({ theme: 'cyber' });
  Aevion.theme.apply();
  assert.equal(root.dataset.theme, 'cyber');
  assert.equal(root.props.size, 0, 'the stylesheet already has the theme; no inline override needed');
});

test('a change is stored, applied to the right variable, and reported', () => {
  const { Aevion, root } = themeApp({ theme: 'cyber' });
  const seen = [];
  Aevion.on('theme:changed', d => seen.push(d.key));

  Aevion.theme.set('accent', '#ff0055');
  assert.equal(root.props.get('--accent'), '#ff0055');
  assert.equal(Aevion.settings.themeCustom.accent, '#ff0055');
  assert.equal(Aevion.store.get('settings').themeCustom.accent, '#ff0055', 'and it is stored on the device');
  assert.equal(Aevion.theme.isCustom(), true);

  Aevion.theme.set('radius', 4);
  assert.equal(root.props.get('--radius'), '4px', 'a length gets its unit');
  Aevion.theme.set('fontScale', 1.2);
  assert.equal(root.props.get('--fs-scale'), '1.2');
  assert.deepEqual(seen.slice(0, 3), ['accent', 'radius', 'fontScale']);
});

test('the glow follows the accent, so a custom accent glows in its own colour', () => {
  const { Aevion, root } = themeApp();
  Aevion.theme.set('glow', 0.5);
  const glow = root.props.get('--glow');
  assert.match(glow, /color-mix\(in srgb, var\(--accent\) 20%, transparent\)/);
  Aevion.theme.set('glow', 0);
  assert.match(root.props.get('--glow'), /var\(--accent\) 0%/);
  Aevion.theme.set('glow', 1);
  assert.match(root.props.get('--glow'), /var\(--accent\) 40%/);
});

test('resetting one knob gives the theme its own value back', () => {
  const { Aevion, root } = themeApp();
  Aevion.theme.set('bg', '#000000');
  assert.equal(root.props.get('--bg'), '#000000');
  Aevion.theme.reset('bg');
  assert.equal(root.props.get('--bg'), undefined, 'the inline override is gone, so the theme shows through');
  assert.equal('bg' in Aevion.settings.themeCustom, false);
});

test('resetting everything clears every override, not just the last one', () => {
  const { Aevion, root } = themeApp();
  Aevion.theme.set('accent', '#123456');
  Aevion.theme.set('radius', 3);
  Aevion.theme.set('blur', 2);
  assert.equal(Aevion.theme.isCustom(), true);
  assert.equal(Aevion.theme.resetCustom(), true);
  assert.equal(Aevion.theme.isCustom(), false);
  assert.deepEqual(plain(Aevion.settings.themeCustom), {});
  assert.equal(root.props.size, 0);
  assert.equal(Aevion.theme.resetCustom(), false, 'a second reset reports that there was nothing to do');
});

test('picking a theme switches the preset and keeps the custom changes on top', () => {
  const { Aevion, root } = themeApp({ theme: 'cyber' });
  Aevion.theme.set('accent', '#00ff00');
  Aevion.theme.setTheme('mono');
  assert.equal(Aevion.settings.theme, 'mono');
  assert.equal(root.dataset.theme, 'mono');
  assert.equal(root.props.get('--accent'), '#00ff00', 'the user\'s accent still wins over the new theme');
  assert.equal(Aevion.theme.setTheme('not-a-theme'), null);
  assert.equal(Aevion.settings.theme, 'mono', 'an unknown theme does not change anything');
});

/* ---------- sharing ---------- */

test('a theme exports as one line and loads back identically', () => {
  const { Aevion } = themeApp({ theme: 'aurora' });
  Aevion.theme.set('accent', '#ff8800');
  Aevion.theme.set('radius', 6);
  Aevion.theme.set('fontScale', 1.15);
  const text = Aevion.theme.exportText();
  assert.match(text, /^theme=aurora;/);
  assert.match(text, /accent=#ff8800/);
  assert.match(text, /radius=6/);

  const other = themeApp({ theme: 'cyber' });
  const result = other.Aevion.theme.loadText(text);
  assert.deepEqual(plain(result.rejected), []);
  assert.equal(other.Aevion.settings.theme, 'aurora');
  assert.equal(other.root.props.get('--accent'), '#ff8800');
  assert.equal(other.root.props.get('--radius'), '6px');
  assert.equal(other.Aevion.theme.exportText(), text, 'a round trip is lossless');
});

test('loading a hostile theme applies what is valid and names what it refused', () => {
  const { Aevion, root } = themeApp();
  const result = Aevion.theme.loadText(
    'theme=light;accent=url(https://evil.test/leak.png);radius=6;bg=red;color: url(x)'
  );
  assert.equal(Aevion.settings.theme, 'light', 'the valid part still works');
  assert.equal(root.props.get('--radius'), '6px');
  assert.equal(root.props.get('--accent'), undefined, 'the URL never reached the stylesheet');
  assert.equal(root.props.get('--bg'), undefined);
  assert.ok(result.rejected.includes('accent=url(https://evil.test/leak.png)'));
  assert.ok(result.rejected.length >= 3, 'every refusal is named');
});

test('junk input is refused without throwing', () => {
  const { Aevion } = themeApp();
  for (const junk of ['', '   ', 'no equals sign', ';;;;', 'theme=', '===']) {
    const r = Aevion.theme.loadText(junk);
    assert.deepEqual(plain(r.applied), [], `${junk} should apply nothing`);
  }
  assert.equal(Aevion.theme.cleanColor(undefined), null);
  assert.equal(Aevion.theme.cleanColor(123), null);
});

test('the engine survives being asked before boot', () => {
  const { Aevion } = themeApp();
  Aevion.settings = null;                      // exactly the state app.js starts in
  assert.equal(Aevion.theme.theme(), 'cyber');
  assert.deepEqual(plain(Aevion.theme.overrides()), {});
  assert.equal(Aevion.theme.isCustom(), false);
  assert.equal(Aevion.theme.setTheme('mono'), null);
  assert.equal(Aevion.theme.apply(), true, 'and applying it does not throw');
});

/* ---------- following the device, without losing your own theme ---------- */

/* A device that can be told which scheme it is in. */
function deviceApp(scheme, settings = {}) {
  const root = makeRoot();
  const listeners = [];
  const state = { scheme };          // mutable: the device can change its mind
  const app = createApp({
    settings,
    document: { documentElement: root, querySelector: () => null, querySelectorAll: () => [] },
    globals: {
      matchMedia: q => ({
        matches: (state.scheme === 'light') === /light/.test(q),
        addEventListener: (_t, fn) => listeners.push(fn),
        removeEventListener: () => {}
      })
    }
  });
  return { Aevion: app.Aevion, root, listeners, state };
}

test('an app with no signal keeps the theme you chose', () => {
  const { Aevion } = themeApp({ theme: 'synthwave' });
  assert.equal(Aevion.theme.followDevice(), false);
  assert.equal(Aevion.theme.effective(), 'synthwave');
  assert.equal(Aevion.theme.deviceScheme(), 'dark', 'no matchMedia means your theme, not a guess');
});

test('following the device switches the look and remembers what you picked', () => {
  const dark = deviceApp('dark', { theme: 'synthwave' });
  dark.Aevion.theme.setFollowDevice(true);
  assert.equal(dark.Aevion.theme.effective(), 'synthwave', 'dark device keeps your theme');
  assert.equal(dark.Aevion.theme.theme(), 'synthwave', 'and your choice is still what is stored');

  const light = deviceApp('light', { theme: 'synthwave' });
  light.Aevion.theme.setFollowDevice(true);
  assert.equal(light.Aevion.theme.effective(), 'light', 'a light device gets the light preset');
  assert.equal(light.root.dataset.theme, 'light', 'and it is actually applied');
  assert.equal(light.Aevion.theme.theme(), 'synthwave', 'your theme was never overwritten');

  /* Turning it off is the "remember the previous theme" promise. */
  light.Aevion.theme.setFollowDevice(false);
  assert.equal(light.Aevion.theme.effective(), 'synthwave');
  assert.equal(light.root.dataset.theme, 'synthwave');
});

test('a light device that is already set to light is left alone', () => {
  const a = deviceApp('light', { theme: 'light' });
  a.Aevion.theme.setFollowDevice(true);
  assert.equal(a.Aevion.theme.effective(), 'light');
  assert.equal(a.Aevion.theme.setTheme('mono'), 'mono', 'and you can still change your own theme');
  assert.equal(a.Aevion.theme.effective(), 'light');
});

test('custom colours ride along with the device switch', () => {
  const a = deviceApp('light', { theme: 'cyber' });
  a.Aevion.theme.set('accent', '#ff0055');
  a.Aevion.theme.setFollowDevice(true);
  assert.equal(a.root.props.get('--accent'), '#ff0055', 'the override survives the preset change');
  assert.equal(a.root.dataset.theme, 'light');
});

test('the device change is watched, and only re-applies while following', () => {
  const a = deviceApp('dark', { theme: 'aurora' });
  const stop = a.Aevion.theme.watchDevice();
  assert.equal(typeof stop, 'function');
  assert.equal(a.listeners.length, 1, 'the watcher is registered');
  a.state.scheme = 'light';
  a.Aevion.theme.setFollowDevice(true);
  a.listeners[0]();
  assert.equal(a.root.dataset.theme, 'light');
  a.Aevion.theme.setFollowDevice(false);
  a.listeners[0]();
  assert.equal(a.root.dataset.theme, 'aurora', 'not following means nothing moves it');
  stop();
});
