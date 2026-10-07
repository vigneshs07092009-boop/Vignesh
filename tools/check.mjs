/* ============================================================
 * Aevion static integrity check — zero dependencies, no build.
 *
 * Catches the class of bug a passing unit test cannot see:
 *   - a script/stylesheet the page loads that is not on disk
 *   - a module on disk that nothing loads (dead code / forgotten tag)
 *   - a UI selector wired to an id that does not exist (broken screen)
 *   - an event emitted that nobody listens to (dead wiring)
 *   - a nav item with no matching view section
 *   - asset versions drifting between index.html, sw.js, core.js,
 *     package.json, the APK verifier and the CI workflow
 *   - a bundled asset that is missing from the offline cache
 *   - the Android manifest losing the permissions/`<queries>` that
 *     native voice depends on (checked before a slow Gradle build)
 *   - accidentally committed credentials
 *
 * Usage: node tools/check.mjs        (exit 1 = something is wrong)
 * ============================================================ */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, 'aevion');
const read = p => readFileSync(path.join(ROOT, p), 'utf8');
const there = p => existsSync(path.join(ROOT, p));

const failures = [];
const warnings = [];
function check(label, fn) {
  try {
    const problem = fn();
    if (problem) failures.push(`${label}: ${problem}`);
  } catch (e) {
    failures.push(`${label}: threw ${e.message}`);
  }
}
function warn(label, fn) {
  try {
    const problem = fn();
    if (problem) warnings.push(`${label}: ${problem}`);
  } catch { /* ignore */ }
}

const html = read('aevion/index.html');
const scripts = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map(m => m[1]);
const links = [...html.matchAll(/<link\s+[^>]*href="([^"]+)"/g)].map(m => m[1]).filter(h => !/^https?:/.test(h));
const assets = [...scripts, ...links];

/* ---------- 0. every shipped script parses ----------
   The test harness loads every module except app.js (it needs a DOM),
   so a stray brace in a UI file would otherwise only surface in the
   browser. Parsing is enough: no execution, no globals. */
check('every shipped script parses', () => {
  const files = [
    ...readdirSync(path.join(APP, 'js')).filter(f => f.endsWith('.js')).map(f => `aevion/js/${f}`),
    ...readdirSync(path.join(APP, 'js', 'plugins')).filter(f => f.endsWith('.js')).map(f => `aevion/js/plugins/${f}`),
    'aevion/sw.js'
  ];
  const broken = [];
  for (const f of files) {
    try { new vm.Script(read(f), { filename: f }); }
    catch (e) { broken.push(`${f}: ${e.message}`); }
  }
  return broken.length ? broken.join('; ') : null;
});

/* ---------- 1. everything the page loads exists ---------- */
check('index.html assets on disk', () => {
  const missing = assets.filter(a => !there(path.join('aevion', a.split('?')[0])));
  return missing.length ? `missing ${missing.join(', ')}` : null;
});

/* ---------- 2. every module on disk is loaded by the page ---------- */
check('no orphan modules', () => {
  const loadedNames = new Set(scripts.map(s => path.basename(s.split('?')[0])));
  const onDisk = readdirSync(path.join(APP, 'js')).filter(f => f.endsWith('.js'));
  const orphans = onDisk.filter(f => !loadedNames.has(f));
  return orphans.length ? `present but never loaded: ${orphans.join(', ')}` : null;
});

/* ---------- 3. every module is in the offline cache list ---------- */
check('offline cache covers every module', () => {
  const cached = [...read('aevion/sw.js').matchAll(/'\.\/([^']+)'/g)].map(m => m[1]);
  const missing = scripts.map(s => s.split('?')[0]).filter(s => !cached.includes(s));
  return missing.length ? `not precached: ${missing.join(', ')}` : null;
});

/* ---------- 3b. the cache list points at real files ---------- */
check('service worker cache list is accurate', () => {
  const sw = read('aevion/sw.js');
  const listed = [...sw.matchAll(/'(\.\/[^']+)'/g)].map(m => m[1]);
  if (!listed.length) return 'sw.js lists no assets';
  // __twin-sync is a marker the worker writes into its own cache (twin-origin
  // warm-up bookkeeping), not a file on disk; everything else must exist.
  const missing = listed.filter(p => p !== './' && p !== './__twin-sync' && !there(path.join('aevion', p.replace(/^\.\//, ''))));
  return missing.length ? `cached but not on disk: ${missing.join(', ')}` : null;
});

/* ---------- 3c. the big engine must not be precached (startup cost) ---------- */
check('the 6.6 MB engine stays out of the install-time cache', () => {
  const sw = read('aevion/sw.js');
  const assetsBlock = sw.slice(sw.indexOf('const ASSETS'), sw.indexOf('];', sw.indexOf('const ASSETS')));
  if (assetsBlock.includes('webllm.esm.js')) {
    return 'vendor/webllm.esm.js is back in ASSETS — every visitor would download it at install';
  }
  return sw.includes('LAZY_ASSETS') && sw.includes('webllm.esm.js') ? null : 'LAZY_ASSETS no longer lists the engine';
});

/* ---------- 4. selectors used by app.js exist in the page ---------- */
check('app.js selectors resolve', () => {
  const app = read('aevion/js/app.js');
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));
  const used = [...app.matchAll(/\$\$?\('#([A-Za-z0-9_-]+)'\)/g)].map(m => m[1]);
  const dead = [...new Set(used)].filter(id => !ids.has(id));
  return dead.length ? `selector(s) with no element: ${dead.map(d => '#' + d).join(', ')}` : null;
});

/* ---------- 4b. every control in the page is actually wired ----------
   A button nothing listens to is a promise the UI cannot keep: the user
   clicks it and nothing happens. Buttons, inputs, selects and textareas
   are checked; a layout container with an id is not a control. */
check('every control in the page is wired to code', () => {
  const js = readdirSync(path.join(APP, 'js')).filter(f => f.endsWith('.js'))
    .map(f => readFileSync(path.join(APP, 'js', f), 'utf8'))
    .concat(read('aevion/js/plugins/hello-world.js')).join('\n');
  const controls = [...html.matchAll(/<(button|input|select|textarea)\b([^>]*)>/g)]
    .map(m => (m[2].match(/\bid="([^"]+)"/) || [])[1])
    .filter(Boolean);
  const dead = [...new Set(controls)].filter(id => !new RegExp('#' + id + '(?![A-Za-z0-9_-])').test(js));
  return dead.length ? `control(s) nothing listens to: ${dead.map(d => '#' + d).join(', ')}` : null;
});

/* ---------- 5. nav items have view sections ---------- */
check('nav ↔ view wiring', () => {
  const views = new Set([...html.matchAll(/data-view="([^"]+)"/g)].map(m => m[1]));
  const sections = new Set([...html.matchAll(/id="view-([^"]+)"/g)].map(m => m[1]));
  const missing = [...views].filter(v => !sections.has(v));
  const orphan = [...sections].filter(s => !views.has(s));
  return (missing.length ? `nav without a view: ${missing.join(', ')}. ` : '') +
    (orphan.length ? `view with no nav item: ${orphan.join(', ')}` : '') || null;
});

/* ---------- 6. emitted events have listeners ---------- */
check('event bus wiring', () => {
  const files = readdirSync(path.join(APP, 'js')).filter(f => f.endsWith('.js'))
    .map(f => readFileSync(path.join(APP, 'js', f), 'utf8'))
    .concat(read('aevion/js/plugins/hello-world.js'));
  const src = files.join('\n');
  const emitted = new Set([...src.matchAll(/emit\(\s*'([^']+)'/g)].map(m => m[1]));
  const listened = new Set([...src.matchAll(/\bon\(\s*'([^']+)'/g)].map(m => m[1]));
  const dead = [...emitted].filter(e => !listened.has(e));
  return dead.length ? `emitted but never handled: ${dead.join(', ')}` : null;
});

/* ---------- 7. versions agree everywhere ---------- */
const pkg = JSON.parse(read('package.json'));
const vShort = pkg.version.replace(/\./g, ''); // 0.6.0 -> 060
check('asset version consistent in index.html', () => {
  const versions = new Set([...html.matchAll(/\?v=(\d+)/g)].map(m => m[1]));
  if (versions.size === 0) return 'no ?v= asset versions in index.html';
  if (versions.size > 1) return `mixed asset versions: ${[...versions].join(', ')}`;
  const found = [...versions][0];
  return found === vShort ? null : `index.html says v=${found}, package.json is ${pkg.version} (expected v=${vShort})`;
});
check('core.js version matches package.json', () => {
  const found = read('aevion/js/core.js').match(/version:\s*'([^']+)'/)[1];
  return found === pkg.version ? null : `core.js ${found} vs package.json ${pkg.version}`;
});
check('service worker cache version matches package.json', () => {
  const found = read('aevion/sw.js').match(/CACHE_VERSION\s*=\s*'([^']+)'/)[1];
  return found.includes(pkg.version) ? null : `${found} does not contain ${pkg.version}`;
});
check('CI workflow verifies the current asset version', () => {
  const wf = read('.github/workflows/build-apk.yml');
  return wf.includes(`?v=${vShort}`) ? null : `workflow still checks a different ?v= than v=${vShort}`;
});
check('APK verifier checks the current version', () => {
  const ps = read('android-wrapper/verify-apk.ps1');
  // The verifier derives the expected tag from the bundled core.js version
  // ($vShort = version with dots stripped), so it always checks the current
  // one; what must never disappear is that derivation itself.
  return ps.includes("$vShort = $webVersion -replace") ? null : 'verify-apk.ps1 no longer derives the cache-busting tag from the bundled version';
});

check('CI runs a Node the Capacitor CLI can actually run', () => {
  // @capacitor/cli (see android-wrapper/package-lock.json) declares engines.node.
  // npm only warns when the engine does not match, so a too-old runner passes the
  // install step and then the Capacitor CLI dies instantly on the sync step —
  // which is exactly how every Build APK run failed for 20 runs in a row.
  const lock = JSON.parse(read('android-wrapper/package-lock.json'));
  const want = lock.packages['node_modules/@capacitor/cli'].engines.node;
  const min = Number((want.match(/\d+/) || [0])[0]);
  const wf = read('.github/workflows/build-apk.yml');
  let ciMajor;
  if (/node-version-file:\s*'\.nvmrc'/.test(wf)) {
    ciMajor = Number(read('.nvmrc').trim().replace(/^v/, '').split('.')[0]);
  } else {
    const m = wf.match(/node-version:\s*'(\d+)/);
    if (!m) return 'workflow no longer pins a Node version';
    ciMajor = Number(m[1]);
  }
  if (!Number.isFinite(ciMajor)) return `.nvmrc does not name a Node major (${read('.nvmrc').trim()})`;
  return ciMajor >= min
    ? null
    : `CI runs Node ${ciMajor} but @capacitor/cli needs ${want} — the sync step will fail`;
});

check('the backup restore keeps its safety chain', () => {
  const app = read('aevion/js/app.js');
  const html = read('aevion/index.html');
  const misses = [];
  if (!html.includes('id="importData"')) misses.push('Import a backup button');
  if (!html.includes('id="backupFile"')) misses.push('backup file input');
  if (!app.includes("parsed.app !== 'aevion'")) misses.push('backup shape check');
  if (!app.includes("hasOwnProperty.call(parsed.data, 'secrets')")) misses.push('secrets refusal');
  if (!app.includes('too old to restore safely')) misses.push('version floor');
  if (!app.includes("Aevion.store.get('settings', {})")) misses.push('merge-dont-blank settings');
  return misses.length ? `missing: ${misses.join(', ')}` : null;
});

/* ---------- 8. Android manifest keeps what voice needs ---------- */
check('AndroidManifest keeps voice requirements', () => {
  const mf = read('android-wrapper/android/app/src/main/AndroidManifest.xml');
  const problems = [];
  if (!mf.includes('android.permission.RECORD_AUDIO')) problems.push('RECORD_AUDIO missing');
  if (!mf.includes('android.speech.RecognitionService')) problems.push('speech <queries> missing (Android 11+ hides services without it)');
  if (!mf.includes('android.intent.category.LAUNCHER')) problems.push('launcher <queries> missing (Android 11+ hides every installed app, so the app list is empty)');
  if (!mf.includes('MAIN')) problems.push('no launcher intent');
  return problems.length ? problems.join('; ') : null;
});

check('the app-list plugin is registered, and early enough to exist', () => {
  const src = read('android-wrapper/android/app/src/main/java/com/aevion/app/MainActivity.java');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  if (!code.includes('registerPlugin(AppsPlugin.class)')) return 'AppsPlugin is not registered — the Plugins view would promise an app list Android never returns';
  const file = 'android-wrapper/android/app/src/main/java/com/aevion/app/AppsPlugin.java';
  if (!there(file)) return 'AppsPlugin.java is missing';
  const java = read(file);
  if (!java.includes('CATEGORY_LAUNCHER')) return 'AppsPlugin no longer asks for launcher activities';
  if (!/public\s+void\s+open\s*\(\s*PluginCall/.test(java)) return 'AppsPlugin has no open() method, so nothing can start an app';
  return null;
});

check('the browser half of the app bridge tells the truth', () => {
  const js = read('aevion/js/apps.js');
  if (!js.includes('cannot list the apps installed')) return 'apps.js no longer explains the browser limit — silence there reads as a bug';
  return /Aevion\.apps\s*=/.test(js) ? null : 'apps.js does not publish Aevion.apps';
});
check('SpeechPlugin is registered before the bridge is built', () => {
  const src = read('android-wrapper/android/app/src/main/java/com/aevion/app/MainActivity.java');
  // strip comments first: the surrounding comment explains super.onCreate(),
  // and matching that would be a false alarm (it must come after the call)
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const reg = code.indexOf('registerPlugin(SpeechPlugin.class)');
  const sup = code.indexOf('super.onCreate(');
  if (reg < 0) return 'registerPlugin(SpeechPlugin.class) is gone';
  if (sup < 0) return 'super.onCreate missing';
  return reg < sup ? null : 'registerPlugin must run BEFORE super.onCreate, or the plugin silently disappears';
});
check('SpeechPlugin keeps its permission callback name in sync', () => {
  const j = read('android-wrapper/android/app/src/main/java/com/aevion/app/SpeechPlugin.java');
  if (!j.includes('micPermission')) return 'the @PermissionCallback method is gone';
  return null;
});

/* ---------- 9. no credentials in the repo ---------- */
check('no credentials committed', () => {
  const patterns = [
    [/sk-[A-Za-z0-9]{20,}/, 'an OpenAI-style secret key'],
    [/AIza[0-9A-Za-z_-]{30,}/, 'a Google API key'],
    [/ghp_[A-Za-z0-9]{20,}/, 'a GitHub token'],
    [/xox[baprs]-[A-Za-z0-9-]{10,}/, 'a Slack token'],
    [/AKIA[0-9A-Z]{16}/, 'an AWS access key id'],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key']
  ];
  const skip = new Set(['.git', 'node_modules', 'vendor', 'build', '.gradle', 'zips']);
  const hits = [];
  (function walk(dir) {
    for (const entry of readdirSync(dir)) {
      if (skip.has(entry)) continue;
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!/\.(js|mjs|json|html|css|md|yml|yaml|ps1|bat|java|xml|properties)$/.test(entry)) continue;
      if (/package-lock\.json$/.test(entry)) continue;
      const text = readFileSync(full, 'utf8');
      for (const [re, label] of patterns) {
        if (re.test(text)) hits.push(`${path.relative(ROOT, full)} looks like it contains ${label}`);
      }
    }
  })(ROOT);
  return hits.length ? hits.join('; ') : null;
});

/* ---------- 10. capability coverage the project promises ---------- */
const PROMISED_LANGS = ['python', 'javascript', 'typescript', 'java', 'kotlin', 'c', 'cpp', 'csharp',
  'go', 'rust', 'swift', 'php', 'ruby', 'dart', 'sql', 'html', 'css', 'bash', 'powershell'];

check('every promised language has local notes', () => {
  const skills = read('aevion/js/skills.js');
  const missing = PROMISED_LANGS.filter(l => !new RegExp(`\\b${l}:\\s*\\{`).test(skills));
  return missing.length ? `no local notes for ${missing.join(', ')}` : null;
});

/* Detection lives in skills.js SIGNATURES and highlighting in
   markdown.js LANGS + ALIAS. A language that is only half-wired is a
   promise the app cannot keep, so all three must line up. */
check('every promised language is detected', () => {
  const skills = read('aevion/js/skills.js');
  const missing = PROMISED_LANGS.filter(l => !new RegExp(`\\['${l}',`).test(skills));
  return missing.length ? `no detection rules for ${missing.join(', ')}` : null;
});
check('every promised language is syntax highlighted', () => {
  const md = read('aevion/js/markdown.js');
  const block = md.slice(md.indexOf('const LANGS'), md.indexOf('const ALIAS'));
  const aliasBlock = md.slice(md.indexOf('const ALIAS'), md.indexOf('M.langFor'));
  const keys = new Set([...block.matchAll(/^\s{4}([A-Za-z0-9_]+):/gm)].map(m => m[1]));
  // the alias map packs several pairs per line, so do not anchor to line start
  const aliases = new Set([...aliasBlock.matchAll(/(?:'([A-Za-z0-9_+#.-]+)'|([A-Za-z0-9_+#.-]+)):\s*'([a-z]+)'/g)]
    .map(m => (m[1] || m[2]).toLowerCase()));
  const missing = PROMISED_LANGS.filter(l => !keys.has(l) && !aliases.has(l));
  return missing.length ? `no highlighting rules for ${missing.join(', ')}` : null;
});
check('AI provider registry covers the promised providers', () => {
  if (!there('aevion/js/providers.js')) return 'js/providers.js is missing';
  const src = read('aevion/js/providers.js');
  /* The last line of these are the free-to-start ones: a promise that there is
     always a way to run Aevion's AI without paying, and it must not quietly
     disappear from the registry. */
  const required = ['openai', 'groq', 'openrouter', 'cerebras', 'mistral', 'huggingface',
    'github', 'nvidia', 'sambanova', 'ollama', 'anthropic', 'gemini', 'webllm', 'mock'];
  const missing = required.filter(id => !src.includes(`id: '${id}'`));
  return missing.length ? `provider adapter(s) absent: ${missing.join(', ')}` : null;
});
check('tool system declares permission tiers', () => {
  if (!there('aevion/js/tools.js')) return 'js/tools.js is missing';
  const src = read('aevion/js/tools.js');
  const required = ['read', 'safe', 'sensitive', 'confirm'];
  const missing = required.filter(t => !new RegExp(`\\b${t}\\b`).test(src));
  return missing.length ? `tier(s) not implemented: ${missing.join(', ')}` : null;
});
check('memory system has the promised layers', () => {
  if (!there('aevion/js/memory.js')) return 'js/memory.js is missing';
  const src = read('aevion/js/memory.js');
  const required = ['session', 'history', 'longterm', 'prefs', 'temp'];
  const missing = required.filter(l => !new RegExp(`['"]?${l}['"]?\\s*:`).test(src));
  return missing.length ? `layer(s) not implemented: ${missing.join(', ')}` : null;
});

/* ---------- 11b. the self-update flow keeps its promises ----------
   The in-place update is only safe if every link in its chain is still
   there: the checksum gate (twice — JS and Java), the consent gates, the
   no-silent-install receiver, and the manifest permission. Any of these
   going missing must fail this check, not a phone. */
check('self-update flow keeps its safety chain', () => {
  if (!there('aevion/js/update.js')) return 'js/update.js is missing';
  const upd = read('aevion/js/update.js');
  const needsJs = [
    ['consent refusal', /consent !== true/],
    ['evolve gate', /Aevion\.evolve\.on\(\)/],
    ['sha256 over raw bytes', /crypto\.subtle\.digest\('SHA-256'/],
    ['checksum comparison', /!== String\(pending\.fileSha256\)/],
    ['android-only install', /isAndroid\(\)/],
    ['native bridge call', /expectedSha256/]
  ];
  const missJs = needsJs.filter(([, re]) => !re.test(upd)).map(([n]) => n);
  if (missJs.length) return `update.js lost: ${missJs.join(', ')}`;
  const main = read('android-wrapper/android/app/src/main/java/com/aevion/app/UpdatePlugin.java');
  const needsJava = [
    ['java checksum gate', /MessageDigest/],
    ['mismatch refusal', /does not match its published checksum/],
    ['package installer session', /PackageInstaller/],
    ['user-action receiver', /UpdateStatusReceiver/]
  ];
  const missJava = needsJava.filter(([, re]) => !re.test(main)).map(([n]) => n);
  if (missJava.length) return `UpdatePlugin.java lost: ${missJava.join(', ')}`;
  const recv = read('android-wrapper/android/app/src/main/java/com/aevion/app/UpdateStatusReceiver.java');
  if (!/STATUS_PENDING_USER_ACTION/.test(recv)) return 'UpdateStatusReceiver lost the user-consent dialog intent';
  const mani = read('android-wrapper/android/app/src/main/AndroidManifest.xml');
  if (!/REQUEST_INSTALL_PACKAGES/.test(mani)) return 'AndroidManifest lost REQUEST_INSTALL_PACKAGES';
  const act = read('android-wrapper/android/app/src/main/java/com/aevion/app/MainActivity.java');
  if (!/registerPlugin\(UpdatePlugin\.class\)/.test(act)) return 'MainActivity no longer registers UpdatePlugin';
  return null;
});

/* ---------- 11. test suite exists and is wired up ---------- */
check('tests are wired to npm scripts', () => {
  if (!pkg.scripts || !pkg.scripts.test) return 'no npm test script';
  if (!pkg.scripts.check) return 'no npm run check script';
  const testDir = path.join(ROOT, 'tests');
  if (!existsSync(testDir)) return 'no tests/ directory';
  const files = readdirSync(testDir).filter(f => f.endsWith('.test.mjs'));
  return files.length ? null : 'no *.test.mjs files';
});

/* ---------- 12. the web app must not require a build step ---------- */
warn('no build step crept in', () => {
  const pkgModules = Object.keys(pkg.dependencies || {}).concat(Object.keys(pkg.devDependencies || {}));
  return pkgModules.length ? `root package.json gained dependencies: ${pkgModules.join(', ')}` : null;
});
warn('no leftover debug logging in shipped modules', () => {
  const files = readdirSync(path.join(APP, 'js')).filter(f => f.endsWith('.js'));
  const noisy = files.filter(f => /console\.log\(/.test(readFileSync(path.join(APP, 'js', f), 'utf8')));
  return noisy.length ? `console.log left in ${noisy.join(', ')}` : null;
});

/* ---------- report ---------- */
const line = '─'.repeat(64);
console.log(`\nAevion check — ${assets.length} assets, ${scripts.length} modules, v${pkg.version}\n${line}`);
for (const w of warnings) console.log(`  WARN  ${w}`);
if (warnings.length) console.log(line);
if (failures.length) {
  for (const f of failures) console.log(`  FAIL  ${f}`);
  console.log(`${line}\n${failures.length} CHECK(S) FAILED\n`);
  process.exit(1);
}
console.log('  ALL CHECKS PASSED');
console.log(`${line}\n`);
