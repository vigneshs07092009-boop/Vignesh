# Aevion — Technical Changelog

## 0.6.9 — an update that proves what it is, shows its work, and asks at the right moments

### Added: a real update dialog
- Settings' App-updates card said what was available; it never *asked*. There is now a dialog that does the asking, in the app's own design language (the same card, tokens and buttons as the confirmation dialog): **New version available**, current version, new version, **What's new** from the manifest's `note`, and Update / Later. It is the only place an update can start, so there is one place to look and one place to reason about.
- **Later means a day**, not forever: the offer returns tomorrow. A required update has no Later button at all — a door, not a suggestion.
- **Progress is told honestly.** The bar follows `percent` when the server sends a Content-Length and shows the bytes downloaded when it does not, because pretending to know a percentage that was never sent is worse than saying "2.1 MB so far".

### Added: the download is proved to be *this* app, not just the published file
- The checksum already proved the file was the one update.json described. It did not prove the file was **Aevion on this device**. Now, before Android is asked anything, the staged APK is asked what it is: which package it declares (must be `com.aevion.app` — otherwise the "update" would install a second app beside this one, the exact failure the spec forbids), which versionCode it carries (must match what the manifest promised, and must be strictly higher than what is installed), and **which certificate signed it** (must be the same key). Android enforces the last two by itself, but only after showing the user an install dialog that then fails; asking first turns a cryptic installer error into a sentence.
- Anything that fails is **deleted**, not left in the cache, and each refusal carries its own code — `identity`, `signature`, `downgrade`, `storage`, `download`, `checksum`, `install` — so the UI can say which one happened instead of "it didn't work".
- **Free storage is checked before a byte is written.** The APK is staged in the app's private cache, and the check asks for the file's size plus a margin, so the failure reads as "this device has 480 MB spare, the update needs 8.5 MB" rather than a half-finished write.

### Added: mandatory updates, and a supported floor
- The manifest gains `mandatory` and now *enforces* `minVersionCode`, which it previously only carried: a build older than the floor the publisher still supports is treated as required even when the flag is absent. Two independent claims, either is enough — a manifest that forgets the flag cannot leave someone stranded on an unsupported build. Both are optional, and a malformed value is ignored rather than fatal: a typo in one field must not take the whole update channel down.

### Added: the check runs by itself
- Boot already checked once, quietly. Now `startAutoCheck` covers the three moments that matter: **boot**, **every return to the foreground** (a phone app is backgrounded and resumed constantly, and that resume is when a stale build is most obvious), and a **half-hourly heartbeat** while the app stays open. All three go through the same 6-hour floor, refuse to run offline, never install anything, and stay silent while a deferral is live.
- Every failure the spec names now has its own honest answer: no internet (its own state, not a generic error), interrupted download (network error / timeout), invalid APK (checksum), incompatible APK (package, signer or version), insufficient storage (free-space probe), user cancels (Android's dialog is the gate and the refusal is reported back), server unavailable (HTTP status, surfaced with the status text).

### Changed
- Version 0.6.9 everywhere (`core.js`, `package.json`, `sw.js` cache `aevion-v0.6.9`, all 23 `?v=069` tags); `tools/check.mjs` still fails the build when any of them disagree, and gained three guards for this release: the dialog must keep current version, new version, What's new, a movable progress bar and a hidden-Later-when-required; the native side must keep the package, signer, version and storage checks; the automatic check must stay periodic, resume-aware and deferral-respecting.
- `tests/update.test.mjs` grows from 27 to 50 tests, all of it on things that can silently regress: mandatory and the floor, a malformed flag being ignored, `deferLater` refusing a required update, progress arithmetic (half the bytes = half the bar), a progress callback that throws not breaking a download, the version/size the bridge is told to expect, each native refusal code reaching the caller with its own words, and the auto-check offering a newer build but never pushing at someone who chose Later.

## 0.6.8 — the way back in, a CI build that finally works, and a server that is simply there

### Added: "Import a backup" — the twin that was missing
- Settings has had **Export all my data** from day one, but no way back in: the restore button simply did not exist, so a factory reset or a machine move was a one-way door. Settings now carries **Import a backup** beside it.
- The restore is deliberately conservative, and the rules cut both ways: the file must be `{"app":"aevion", data:{...}}` — the exact shape export writes; a backup **carrying `secrets` is refused** (dumpSafe strips keys on export, so one that has them was edited by hand — that is tampering, not restoring); a backup older than 0.6.0 is refused rather than half-understood; **settings are merged key-by-key**, so restoring can never blank a device that already knows more than the backup did; and chats, memory, notes and plugins come back wholesale. API keys are re-entered by hand afterwards — by design, because they never travel in a backup. `tools/check.mjs` fails the build if any gate (shape check, secrets refusal, version floor, merge-not-blank) disappears.

### Fixed: the cloud build failed on every push — CI ran a Node the Capacitor CLI refuses to start on
- **The root cause, and it is not subtle once seen:** `@capacitor/cli@8.5.2` declares `engines.node: ">=22.0.0"`, and its own `bin/capacitor` enforces that as the *very first thing it does* — `require('semver/functions/satisfies')`, compare `process.version`, print `[fatal] The Capacitor CLI requires NodeJS >=22.0.0`, `process.exit(1)`. The workflow pinned **Node 20**. So the CLI died before it parsed a single argument.
- Why it looked like an environment mystery: **npm only warns** about a mismatched engine (`engine-strict` is off by default), so `npm install` reported success and the job failed at the *next* step, in about a second, with no useful annotation. Every "Build APK" run in the job history has `failure` at exactly that step — roughly 20 runs, zero successes — while the identical command succeeds locally, because this machine's toolchain is Node 22.14.0.
- The fix is one line of intent: the required version now lives in **`.nvmrc` (`22`)** and the workflow reads it with `node-version-file: '.nvmrc'`, so CI and a developer's machine cannot drift apart again. A **guard step** reads the engine requirement straight out of `android-wrapper/package-lock.json` and fails with a written explanation if the runner's Node cannot satisfy it — the failure now names itself instead of hiding one step later. `tools/check.mjs` carries the same check statically, so a future Capacitor bump that raises the floor breaks the build locally, before it ever reaches GitHub.
- **Behind that one there was a second one, which only became visible once the first was fixed:** `gradlew` was committed to the index as mode **100644** instead of 100755. On Windows that is invisible — the build uses `gradlew.bat` — but on a Linux runner `./gradlew` answers `Permission denied` and the step dies about a second in. The blob itself was fine (`core.autocrlf` had already normalised it to LF, confirmed byte-wise with `cat -A`); only the exec bit was missing. Fixed in the index (`--chmod=+x`), *and* the build step now runs `chmod +x gradlew` so an exec bit lost again on a Windows machine cannot resurrect it. Two failures, two seconds each, and the job went from "fails at step 8" to "fails at step 9" — which is how the second one was found at all.
- **And a third, which only became visible once the second was fixed.** The Capacitor 8 modules are generated with `sourceCompatibility JavaVersion.VERSION_21` — both `android/app/capacitor.build.gradle` and the `capacitor-cordova-android-plugins` module say so — while the workflow installed **JDK 17**. Gradle's words: `Execution failed for task ':capacitor-android:compileDebugJavaWithJavac'. > Java compilation initialization error  error: invalid source release: 21`. This machine never saw it because its JDK is 21, and `assembleDebug` succeeds here. CI now installs Java 21, and `tools/check.mjs` compares the workflow's `java-version` against the Java level written in those Gradle files, so the two cannot drift apart again.
- **How the third one was found at all** — the run log needs admin rights to fetch through the API, so every failure arrived as the words "Process completed with exit code 1". The build step now emits its **own error annotation** carrying Gradle's `FAILURE: … * What went wrong:` block, and the env step emits a notice with the runner toolchain (node, java, `ANDROID_HOME`, installed platforms and build-tools). Annotations are public on a public repo, so a failed build now explains itself to anyone, with or without the log. The first attempt at this reported forty lines of `org.gradle.internal` stack frames and nothing else — Gradle prints the reason *above* the trace — which is why the step now extracts that block specifically.
- The build step also drops `--quiet` and gains `--stacktrace`: a CI log nobody can read is the reason all of this took as long as it did.
- **And a fourth, in a step that had never once executed.** Every earlier failure happened *before* step 8, so the APK verifier had never run in its life. The moment the build finally succeeded, it failed on two stale assumptions: it scanned only `classes.dex` (a debug APK ships **six** dex files, and `SpeechPlugin` lives in `classes6.dex`), and it grepped `AndroidManifest.xml` as though it were text — inside an APK that file is binary AXML with a UTF-16 string pool, so a plain grep does not find `RECORD_AUDIO` even in a perfectly correct APK. Both assertions were run locally against a real build before being rewritten, which is why neither needed a CI round trip to find. The step now searches every dex, strips the NUL bytes to make the manifest greppable, checks the whole native surface (`SpeechPlugin`, `AppsPlugin`, `UpdatePlugin`, `UpdateStatusReceiver`, `micPermission`, `RECORD_AUDIO`, the speech `<queries>`, `REQUEST_INSTALL_PACKAGES` and the fileprovider authority), derives its `?v=` tag from the bundled `core.js` instead of naming one release, and reports **every** failure it finds in a single annotation instead of dying on the first.
- Two earlier hypotheses were wrong and are recorded so nobody re-treads them: the step's `ANDROID_HOME: ${{ env.ANDROID_HOME }}` / `JAVA_HOME` overrides (unset at workflow *level*, so they did substitute empty strings) and CRLF line endings in the YAML. The overrides are gone now anyway — the step runs `node node_modules/@capacitor/cli/bin/capacitor sync android`, the CLI `npm install` already placed in `node_modules`, with no environment overrides at all — and the YAML is plain LF, confirmed byte-wise with `cat -A`. `setup-java` also moves v4 → v5 (v4 is deprecated).

### Added: the local server starts at login — `tools/autostart-server.ps1`
- The desktop launcher already starts the server if it is not running, but only when clicked. Now a per-user **Run-key entry** starts the server hidden at login, so the installed app just opens, every time, with nothing else running. `-Remove` undoes it.
- Not a scheduled task: `schtasks /Create /SC ONLOGON` returns **Access is denied** for the current user on this machine even without admin flags — the Run key is the designed admin-free per-user hook, pointed at the same silent `wscript` shim the desktop launcher uses. `dev-server.mjs` exits cleanly when a copy is already listening, so the login start and the launcher can never fight.

### Changed
- Version 0.6.8 everywhere (`core.js`, `package.json`, `sw.js` cache, all 23 `?v=` tags, the CI workflow); `tools/check.mjs` still fails the build when any of them disagree.

## 0.6.7 — installable on the desktop, and an upgrade you can actually receive

### Fixed: the app could not be installed from a browser at all
- The manifest shipped **only an SVG icon**. Chromium will not offer *Install this site as an app* without a raster icon of at least 144x144, so the one thing the PWA was built for — being installed, not bookmarked — was unreachable in a browser. The manifest now carries `assets/icon-192.png` and `assets/icon-512.png`, and the SVG stays as the scalable fallback.
- The SVG also animated itself (`<animate>` on the centre dot). That is fine in a tab and wrong for a launcher icon, which is another reason it should never have been the only icon.
- **New tool `tools/make-icons.ps1`** rasterises `assets/icon.svg` into both PNGs. Rasterising is done by headless Edge/Chrome, because nothing here depends on an SVG library — and a headless screenshot always composites onto white, which is exactly what happened first: the icons came out with white wedges where the artwork's rounded corners should be transparent. The corners are therefore rebuilt **analytically** — the artwork is a 512x512 rect with `rx=110`, so the covered span of each corner row is known exactly and the boundary pixel gets a real coverage value instead of a jagged step. The script checks its own output (corner alpha 0, background dark, centre coloured) and fails if an icon looks wrong, so a silently blank or white-cornered icon cannot ship.

### Added: Aevion as a real desktop app — `tools/install-desktop-app.ps1`
- One command puts Aevion in the **Start menu and on the desktop**: its own window with no browser chrome, its own multi-resolution icon, one click away. `-Uninstall` removes it. The launcher starts the local server itself if nothing is already listening, so the app opens after a reboot with nothing else running.
- A `.lnk` that points straight at `powershell.exe` flashes a console on every launch, so the shortcut targets a **`wscript` shim** that runs the launcher with a hidden window style: there is no console at all, only the app window. Both the launcher and the shim are generated from templates in `tools/` (`__TOKEN__` placeholders) rather than written out with here-strings, so each one is a real file that can be syntax-checked on its own.
- The icon is a genuine multi-resolution `.ico` (16/24/32/48/64/128/256) built from the 512 PNG. Windows picks a different size for the Start menu, the taskbar, alt-tab and Explorer, so a single-size icon looks blurry in most of them.

### Fixed: the localhost twins - one app, two doors, an empty-looking one
- `http://localhost:8787` and `http://127.0.0.1:8787` are the same server, but a browser treats **every origin as its own world**: separate saved data, separate service worker. Someone who configures their brain through one name and comes back through the other finds an empty app - the most common shape of "it says NO BRAIN". `serve.ps1` and the dev server now bind **both** names but open only the canonical `http://127.0.0.1:8787` (the address the installed app and the desktop launcher use), and the service worker **shares its cache across the twins**: on every release the fresher worker copies shared assets to the other door, so a first visit through the non-canonical name boots warm instead of re-fetching ~7 MB. Saved *data* still never crosses origins - that is the platform's privacy rule, not something to engineer around - but every door now leads to the same, warm app.

### Fixed: an APK built from the repo advertised itself as version 1.0
- `android-wrapper/android/app/build.gradle` still hardcoded `versionCode 1` / `versionName "1.0"`, while the build folder's copy derives both from the packaged web app (`js/core.js` -> `major*10^6 + minor*10^3 + patch`). Since the repo is the source of truth, a build made from a fresh clone claimed **versionCode 1** — and Android refuses an install whose versionCode goes backwards, so that APK could never be installed over a 0.6.x release. The version-deriving file is now in the repo, which also means an APK still cannot advertise a version it does not contain.

### Changed
- Version 0.6.7 everywhere (`core.js`, `package.json`, `sw.js` cache `aevion-v0.6.7`, all 23 `?v=` asset tags, the CI workflow), so the icon and desktop work actually reach an installed client. `tools/check.mjs` still fails the build if any of these disagree.

## 0.6.6 — the app updates itself, the way an app store does

### Added: in-place self-update — new signed build over the old one, data untouched
- Aevion can now update **itself, in place, without uninstalling** — the flow any Play-Store app takes. It checks a small `update.json` committed to this repo's `downloads/` folder and served by GitHub's raw host (open CORS, nothing to host), and when a newer **signed** build exists it downloads the APK, verifies it against the published SHA-256, and hands it to Android's `PackageInstaller`, which replaces the app while every chat, memory note, setting, key and file stays exactly where it is. The same release key must sign old and new — that is Android's own guarantee that an update can never be an impostor.
- **Consent at every layer, nothing silent.** A check after boot is quiet and rate-limited to one per six hours; an install requires the Settings → **App updates** card, an in-app confirm dialog, the **Self-upgrade** consent gate (`Aevion.evolve.on()`), and Android's own system install dialog. A browser tab can only *report* an update — it has no power to install anything, and it says so rather than pretending.
- **The checksum gate is doubled.** The web layer digests the raw downloaded bytes with WebCrypto and refuses a mismatch before anything is offered; the new native `UpdatePlugin` recomputes the same digest **in Java over the bytes that actually arrived across the bridge** before a single session byte is written. A hijacked download URL or a corrupted transfer is caught twice, in two languages.
- **New native plugins**: `UpdatePlugin` (`meta()` → the real package versionCode/versionName; `install({ base64, expectedSha256 })` → a `PackageInstaller` session, falling back to an `ACTION_VIEW` intent via `FileProvider`) and `UpdateStatusReceiver`, which surfaces Android's `STATUS_PENDING_USER_ACTION` dialog — the user-consent step — and reports every failure code as a toast. The manifest gains `REQUEST_INSTALL_PACKAGES`; the user grants "install unknown apps" once, in system settings, visibly.
- **New web module** `js/update.js` (`Aevion.update`): manifest fetch + strict validation (https-only URL, 64-hex checksum, positive integer versionCode), version comparison on the major·10⁶+minor·10³+patch scheme that matches Gradle's versionCode derivation, a 6-hour auto-check rate limit that a failed check never triggers, raw-bytes SHA-256 (not `Aevion.hash()`, which TextEncoder-mangles byte arrays), base64 as the only shape that survives the JS→Java bridge, and honest refusals (`consent`, `off`, `unavailable`, `download`) with a plain-language reason each.
- **The build now emits the update source.** `build-release.ps1` writes `update.json` (versionCode, versionName, downloadUrl, fileSha256, note) and a versioned `Aevion-<ver>.apk` straight into the repo's `downloads/` folder — committed to `main`, GitHub serves both with open CORS, which is exactly what the in-app updater needs; no separate host, no server. `verify-apk.ps1` grew to 28 checks: the plugin classes in dex, `REQUEST_INSTALL_PACKAGES` in the manifest, and `update.js` bundled with its consent and checksum gates intact.
- **Guarded forever**: `tools/check.mjs` fails the build if any link in the chain goes missing — consent refusal, evolve gate, raw-bytes digest, checksum comparison, the Java gates, the user-action receiver, the manifest permission, or the MainActivity registration. `tests/update.test.mjs` adds 34 tests: manifest validation, version comparison, checksum acceptance/rejection over a real 2 KB payload, consent refusal, rate-limit behavior, and the full fake-bridge Android chain down to byte-for-byte base64 equality.

## 0.6.5 — an on-device brain, a findable free key, and a pill that stops lying

### Fixed: the header pill can no longer advertise a brain that is not there (for real this time)
- 0.6.4 added the rule and then under-delivered it: `aiMode()` consulted only the **in-memory** card survey, so on any load where the 🧠 card had not been opened the pill read `ONLINE AI` while the brain it named was an Ollama that was never installed. That is the single most common “the AI is not working” — the app claimed a brain and the message was answered by the offline one.
- The pill is now built from the same **`Aevion.setup.verdict()`** the Settings lists trust, which is cached truth rather than a promise: a missing key or endpoint, a provider the last check found silent, an in-browser model that was never downloaded, and a browser without WebGPU all read **NO BRAIN**. A successful attempt in the brain log is treated as proof, so a provider that has actually answered flips the pill back to `ONLINE AI` on the next tick (15 s) with nothing to press. The offline mock, which answers with no server at all, is never withheld.

### Added: Cactus Needle 3 as an on-device brain — `providers.js` id `needle`
- **Needle 3 is not a hosted service and has no API key.** It is Cactus Compute’s open-weight automation model (26M–98M parameters, a handful of megabytes) built to run on the device it is already on and to **call tools** rather than to hold a conversation. It is registered as a **loopback** brain with `needsKey: false`, so it is honest by construction: it never appears in the “get a free key” list, because there is no key to get.
- **It plugs in like Ollama or LM Studio.** Cactus serves it through an OpenAI-compatible API on your own machine, so the same adapter that talks to every other OpenAI-shaped endpoint talks to it — `/v1/chat/completions` and a `/models` listing the check can use.
- **The address is left blank on purpose.** Cactus prints its port when the server starts; this build will not invent a default, because a guessed port would only aim the check at something nobody opened and then read as Needle’s fault. `missing()` says exactly `endpoint URL`, the Model box already says `needle3`, and the hint names what it is — a tool-calling model first, so expect it to pick actions well and to chat modestly.

### Added: llama.cpp's own server as a first-class local brain — `providers.js` id `llamacpp`
- `llama-server` is the local brain people most often already have, and its **default port is 8080** — not the 1234 that LM Studio uses. Aevion only ever offered Ollama (11434) and LM Studio (1234), so a working local server one port away read as **nothing is listening**, which is the second most common shape of “the AI is not working”.
- The adapter is loopback and keyless like Ollama, with the real port baked in, so **🧠 Look for a server on this PC** and **⚡ Use the best brain this device has** now find it. `llama-server` serves the single model it was started with and ignores the name it is sent, so the Model box can be left alone.
- Verified end to end on a machine with no GPU: Qwen2.5-0.5B Q4_K_M answered a real question through Aevion's own chat box, the reply badge read `LLAMA.CPP SERVER · 30532 MS`, and the header pill moved from `NO BRAIN` to `ONLINE AI` on its own.

### Changed: the Google AI Studio key is findable from Settings, not only from the chat card
- The free-tier adapter is labelled **“Google AI Studio (Gemini)”** rather than “Google Gemini”, because that is the page people actually search for, and its hint names the no-card free key and links it in one line.
- **Settings → AI provider gained a 🔑 Get a free key for … button.** It shows only for providers that carry a free tier and link to where the key comes from (both read from the registry, so the row cannot drift), prints the same per-provider steps as the chat card, opens the provider’s page when the Automation permission allows it, and points at the key box right above it. Until now that flow existed only inside the 🧠 card, which is not where anyone looks first.

### Housekeeping
- Version 0.6.5 everywhere (`core.js`, `package.json`, `sw.js` cache `aevion-v0.6.5`, all 21 `?v=` asset tags, the CI workflow), so an installed client actually receives the new provider and the pill fix.
- Tests: 418 passing, including the free-picker list pinned by value and the Needle 3 registry/request shape.

## 0.6.4 — several brains at once, and apps & sites as plugins

### Added: more than one brain, used together (Settings → More than one brain)
- Every provider already kept **its own** endpoint, model and key, so adding a second and a third was always possible; what was missing was *using* them together. The new card lets you **tick the brains to use** and choose what “together” means, three honest strategies and no fourth:
  - **Use one brain** (default) — the fastest one that answers. Nothing changes.
  - **Compare** — the same question goes to every ticked brain in parallel, and the reply shows each answer under its own heading (`### Groq`, `### Cerebras`), with the badge reading `MULTI · 3 OF 3 ANSWERED · 812 MS` and a toast naming any brain that did not come back. You see where models disagree, which is the point.
  - **Critique** — one answers, the next is handed that draft *plus the original question* and asked to correct it; the revised text is the reply and the badge says `REVIEWED BY CEREBRAS`. A failing reviewer never throws the draft away: the first answer stands and is still credited to the brain that produced it.
- **`providers.js` gained `multiPlan()`, `askMany()` and `askCritique()`.** The plan is built from `not ticked · cannot answer · wrong trust class` filters, so the UI cannot promise a brain that is merely *configured*: an unloaded in-browser model, a keyless provider, a cloud brain while Online AI is off, or — since `canAnswerNow()` now consults `lastCheck()` — a server the last check found silent (a 10-minute window, so starting Ollama and pressing the check brings it straight back). Fewer than two ready brains means a normal single-brain message with the reason printed beside each silent provider — multi-brain must never be worse than plain chat, and a tick must never read as a promise.
- **Every leg goes through `chatWith()`**, which is the one door every request passes through, so a compare or a critique appears in Tools → 🧠 Brain log as a chain: `openai ✅ 640 ms · groq ❌ 429 rate limited · cerebras ✅ 812 ms`. The log is ordered by when each leg *finished*, because that is what happened.
- **Nothing here claims models merge into something smarter.** Two independent answers and a second reader are real, describable things; a hidden ensemble score is not, so it is not sold as one.

### Added: plug Aevion into an app you installed, or a site you searched — `js/apps.js`
- **The honest half first:** a web page cannot enumerate the apps installed on a device — no browser exposes it — so `Aevion.apps.listInstalled()` says exactly that in one sentence instead of failing, and offers the address form instead. In the **Android** app the list is real: `android-wrapper/.../AppsPlugin.java` reads launchable apps through the PackageManager (`<queries>` for `MAIN`/`LAUNCHER` added to the manifest — without it Android 11+ returns an empty list) and starts one by package name, answering `{opened:false, why}` rather than throwing when Android refuses.
- **The half a page *can* do, done properly:** every place Aevion opened for you is remembered — `open.url`, `web.search` and `web.best` all call `Aevion.apps.note()` — because Aevion is the one that opened it. That is the only “what did I just use” a browser permits, and it is enough: the **Plugins view** lists those places with a **🔌 Plug in** button that writes a real plugin, with the query you used turned into `{query}` (`https://youtube.com/results?search_query={query}`), so the plugin searches anything, not just tonight's words.
- **On the phone, apps plug in the same way:** *📱 Look for apps on this device* lists what is installed (name + package), and choosing one saves a plugin that starts that app by name — `openSpec()` prefers the named app on Android and falls back to the plugin's link everywhere else, so one plugin works in both builds.
- **“Without any error” is the design rule, not a hope:** nothing in `apps.js` throws. Every path returns `{ ok, why }` with a sentence a person can act on, the Android plugin answers rather than rejects, `listInstalled()` is deduped, sorted, capped and skips junk rows, and `checkLink()` validates a filled-in link (https-only, real host) **without opening anything** so the Plugins view can catch a typo before you rely on it.
- New tools check: `AppsPlugin` must be registered before the bridge is built, the manifest must keep the launcher `<queries>`, and `apps.js` must still explain the browser limit — silence there reads as a bug.

### Changed: the brain card is no longer a pop-up
- It used to open by itself whenever no brain answered, and its **Not now** lived in a variable the next page load forgot — so it came back every single time, which is a pop-up. **A panel that reappears no matter how often you close it is a defect, not a reminder.**
- It now opens **only when you ask**: the **🧠 Set up AI** shortcut in the chat, or **🧠 Open the one-tap setup** in Settings → AI provider. Closing it is remembered. Nothing opens it on its own — not boot, not `online:down`, not a failed message.
- The quiet truth stays where it belongs: the header pill still reads **NO BRAIN** while nothing answers, and a failed reply still names the provider's own error and points at Settings, in one message in the chat.

### Changed: “ready” in a list now means the last check, not a saved key
- Settings → More than one brain used to say **ready** beside a provider whose key was saved — the same promise the old header pill made, and the reason “the AI is not working” was hard to see. `Aevion.setup.verdict(id)` is the cached truth instead: **✅ answering in 240 ms · ⚠️ nothing is listening at http://localhost:11434/v1/models · ⬇️ not downloaded yet · 🚫 no WebGPU · ⏸️ online AI is switched off · ⚙️ still needs an API key · 🧪 set up — not checked yet**, with the time of the check beside the list. It never probes (a list can call it freely) and it is filled by the same survey the card runs, so every screen quotes one verdict.

### Tests
- 415 tests (`tests/multibrain.test.mjs` adds 9, `tests/apps.test.mjs` adds 11, and `setup.test.mjs` pins `verdict()`), `ALL CHECKS PASSED`.

## 0.6.3 — the brain says why it is not answering, and fixes itself in one tap

### Added: a brain check that tells the truth — `js/setup.js`
- **The bug this exists for:** a provider can be *configured* and *not working*. Every screen honestly said “Ready”, the chat said nothing useful, and the only way to find out was to watch a message fail. `setup.js` asks each provider the one cheap question an OpenAI-compatible server can answer — `GET /models` — and reports, in plain words, what each one is: **✅ answering · ⚠️ nothing listening · ⬇️ not downloaded · 🚫 no WebGPU · ⏸️ online AI is off · ⚙️ still needs an API key**.
- **Nothing is guessed at.** “nothing is listening at http://localhost:11434/v1/models — the server is not started, or the browser blocked the page from asking your own machine” is a sentence the app can now say because it actually asked. Anthropic and Gemini have no keyless listing, so they are reported as “no quick check” instead of being invented.
- **⚡ Use the best brain this device has** (Settings → AI provider, and the same button on the card in the chat) switches to the first brain that is *answering*: the one you already picked if it works, then a server on your own machine, then the loaded in-browser model, then a hosted key you already saved. It never overrules a choice that works, and it never moves your text to another company to find out.
- `providers.js` gained `canAnswerNow()`: an in-browser model that was never downloaded, or a provider still missing its key, is no longer *offered* as a fallback — it could only ever produce an error line. The trust boundary is unchanged: a failing cloud provider still never reroutes to another cloud.

### Added: the card above the chat box
- When nothing is answering, a card appears above the composer: what is wrong, which brains this device *can* reach, and four one-tap fixes — **🧠 Download the in-browser model** (with the real download percentage), **🖥 Look for a server on this PC** (Ollama, LM Studio, llama.cpp — deliberately manual: a page asking your own machine to open a port is your decision, not a background scan), **🔑 Free hosted key (Groq)** (paste once, tested immediately), and **Not now — keep the offline brain**.
- The chat's 🧠 **Set up AI** chip and Settings → AI provider drive the same engine, so “is any AI working?” has one answer instead of three screens disagreeing.
- One quiet check runs a moment after boot — only when a provider could answer at all, so a privacy-default install (Online AI off) is never probed, and a local-only install is never probed either.
- `online.js` now emits `online:down` / `online:up`, which is what re-paints the card the moment a provider dies or comes back.
- **The header pill can no longer advertise a brain that is not there.** When the check found the configured provider unreachable, the pill read `ONLINE AI` while every message was being answered by the offline brain — the exact lie that made the failure feel mysterious. It now reads **NO BRAIN** until something answers, and returns to `ONLINE AI` on its own once one does.

### Changed: an open question with no brain is answered, not apologised for
- `brain.js` gained a real offline conversational layer (`B.localChat`) that runs *before* the canned fallback: memory that actually matches, a language in the local notes (“what is python”, “explain rust” — anchored to the language itself, so “explain pointers in C” is not answered with a note about C), and text it can genuinely operate on — **counts, upper/lower case, reverse, sort lines, de-duplicate, word frequency** (`Aevion.skills.textOp`), all on the device.
- The apology that used to end every open question now names the actual fault — “Ollama (your own machine) did not answer (nothing is listening at …)” — and lists the three one-tap ways forward instead of a shrug.

### Added: a plugin names its brain, and can be tested
- The no-code plugin form's **Answer with** list is built from the provider registry: *My text*, *Your AI* (follows Settings) or **any specific provider** — the in-browser model, your own machine, or one hosted key. The plugin list says which brain each plugin asks.
- **Test the answer** runs exactly what the chat would run — the same `askAI()`, the same gates, the same fallback — with a made-up sample (never your real text) and reports which of the two answered.

### Added: a brain log you can actually read (Tools → 🧠 Brain log)
- **Every real attempt is recorded**: which brain, how long it took, whether it answered, and — when it did not — the message the provider itself returned. The log is written in `providers.js` (`timed()`, `noteAttempt()`, `attempts()`, `attemptStats()`, `clearAttempts()`), which is the one door every request passes through, so nothing can reach a brain without a line appearing here.
- It distinguishes the three failures that used to look identical: **✅ answered** · **❌ tried and refused** (HTTP 401/404/429, unreachable endpoint, empty message) · **⏭ never tried — not set up**, which is what a missing key or endpoint actually is. A fallback chain appears as a chain, in order, so “it answered, but only after Ollama died” is visible instead of implied.
- Capped at 60 entries, local, clearable, **Copy the log** for reporting one, and the header says how many answered and how many failed. It is also how the 🧠 card's claim can be checked rather than trusted.
- **Privacy: the attempt is recorded, never the content.** No prompt text, no reply text, no key, no URL query — an id, a duration, a character count and the provider's own error message. The Tools card says so in as many words.

### Added: the badge on every reply names the brain that answered
- A reply's badge used to name the provider that was *set*, which is a promise; it now names the brain that actually **answered**, with its latency — `OLLAMA · 812 MS`, or `LMSTUDIO · 240 MS · AFTER 1 FAILED`, or `OFFLINE BRAIN · OLLAMA DID NOT ANSWER` when the offline brain had to step in. The chat cannot claim a brain that stayed silent.
- `online.js`'s `online:down` / `online:up` plus this badge mean the pill, the card, the badge and the log all describe the same reality.

### Added: free-to-start providers, one paste from the chat card
- **Nine providers now carry a free tier** and are registered as adapters, every one of them OpenAI-compatible (so not a line of transport code was needed — a base URL, a default model, and the page where the key comes from): **Groq** · **OpenRouter** · **Google AI Studio (Gemini)** · **Cerebras** (`api.cerebras.ai/v1`, no card) · **Mistral** (`api.mistral.ai/v1`) · **Hugging Face Inference Router** (`router.huggingface.co/v1`, free monthly credits) · **GitHub Models** (`models.github.ai/inference`, any GitHub token) · **NVIDIA NIM** (`integrate.api.nvidia.com/v1`) · **SambaNova** (`api.sambanova.ai/v1`).
- Each one carries `free: true`, and **`Aevion.providers.freeIds()`** is what the UI builds its list from — so the “get a free key” list cannot drift from the providers that actually work. A test enforces the invariant behind the flag: a provider that calls itself free must be hosted, must need a key, must ship a working default model, must be checkable (`GET /models`), and must link to the exact page its key comes from (`https://…`, not a sentence).
- **The chat card now leads with it**: a **free-tier picker** plus one button (+ **🖥 Look for a server on this PC** for the local route), then the paste box, which saves the key into the device vault, switches online AI on, tests it immediately, and reports the result — success in the reply badge and the brain log, failure with the provider's own words. Steps are printed per provider (most need just an email; two ask for a phone number), and the link only opens by itself if you have granted the Automation permission — otherwise the URL is simply shown.
- **The same flow is in Settings → AI provider**, where people look first: a **🔑 Get a free key for …** button appears only for the providers that carry a free tier, prints the identical steps, opens the provider's page when Automation allows it, and points at the key box right above it — so a key can be added without ever opening the chat card. Both the button and the picker are built from the registry's `free`/`docs`, never a hardcoded list. Google AI Studio (Gemini) is labelled with the lab as well as the model family, because that is the page people actually search for, and its hint names the no-card free tier in one line.
- Free-tier keys are marked as such everywhere they appear: Settings → AI provider, the 🧠 card's option list, and the plugin “Answer with” list.
- **What Aevion cannot do, it says instead of implying:** it cannot sign up for you. A free key belongs to your own account, is rate-limited in your name, and one embedded in the app would be a shared secret — which is why the flow ends at “paste it here”, and why the card says so in as many words.

### Added: OpenRouter, with Nex-N2.5 Mini as its default model
- A tenth provider adapter: `openrouter` (cloud, OpenAI-compatible, `https://openrouter.ai/api/v1/chat/completions`), defaulting to **`nex-agi/nex-n2.5-mini`** — Nex-AGI's open-weight agentic model. Any other OpenRouter model id (including `nex-agi/nex-n2.5-pro`) goes in the Model box; one key covers all of them.
- Nothing else had to change to make it first-class: the registry drives the Settings picker, the 🧠 plugin brain list, the brain check (`GET /models`, so it is probeable) and the attempt log — which is the point of the adapter design.

### Fixed: the in-browser model could never start, and said nothing about it
- **Found while trying to load it for real:** the engine is vendored as one ESM file, but its WebAssembly runtime is resolved *next to that file* (`vendor/tvmjs_runtime.wasm`) — and that file was not in the build. Emscripten then waits forever: no progress, no error, no download, just a blank line under a button that looks busy. Every tap of “Download the in-browser model” was a dead end.
- `js/webllm.js` now asks for the runtime file first (`checkRuntime()`, a same-origin GET, asked once per page) and refuses to start with a sentence a human can act on: *“This build of Aevion is missing the engine's runtime file (vendor/tvmjs_runtime.wasm), so no in-browser model can start. Nothing else is affected: use a server on your own machine (Ollama, LM Studio) or a hosted key…”*.
- Every load also carries a **watchdog**: if no progress arrives for 60 seconds, the load fails with what actually happened (“this network may be blocking the model files, or the GPU ran out of memory”) instead of hanging. `loading` is always cleared, in both paths.
- Five new tests in `tests/webllm.test.mjs` pin it: a missing runtime refuses immediately and leaves a clean state, the probe is same-origin and asked once, an unknown model is refused before anything is fetched.

### Added: the PIN can be required outside the app
- New switch (Settings → Security): **Require that PIN outside the Aevion app too** (`settings.pinOutside`, off by default). With a PIN saved, opening Aevion in a plain browser tab asks for it before anything is shown — the same PIN, and the same vault unlock.
- The note under it is deliberately blunt: a PIN is a lock screen for a passer-by *and* the key that encrypts stored API keys — not encryption of the whole local store.

### Changed
- Version 0.6.3 everywhere (`core.js`, `package.json`, `sw.js`, all 21 `?v=` asset tags, the CI workflow). `js/setup.js` is precached and added to the harness automatically.

## 0.6.2 — it switches brains by itself, and the controls tell the truth

### Added: automatic online ↔ offline AI
- **New switch, on by default: “Auto-switch online ↔ offline AI”** (Settings → Privacy). With it on, Aevion answers from the online brain while the internet is there, drops to the offline brain by itself when the network is down *or* when the endpoint stops answering, and offers the online brain again a minute later — no message to dismiss, no switch to flip.
- The header pill now says which brain is answering: **LOCAL · OFFLINE AI · ONLINE AI**, and the chat badge says `OFFLINE BRAIN` when the online one was held back.
- A failed call is remembered for exactly 60 seconds (`Aevion.online.markDown/markUp/available/status` in `js/online.js`) and then retried automatically; a pill that could otherwise sit on “OFFLINE AI” is refreshed on a slow tick. Turning the toggle off restores the old behaviour exactly: always try the online brain, fall back locally, say so.
- The user's switches are never touched by any of this — it is session-only bookkeeping, gated on the toggle you can see.

### Added: plugins can ask your AI for a better answer
- The no-code plugin form gained **Answer with** — *My text* (offline, exactly as written) or *Your AI*. With AI on, your template is handed to the brain you picked in Settings → Providers as an **instruction**, and the plugin replies with what comes back (🧠), falling back to your own text otherwise.
- The template is never discarded: it is the instruction *and* the fallback. No provider, no key, no network, or a switch that says no all return your text — with a toast that says **why** ("answered from your saved text — Ollama still needs endpoint URL"), because a plugin quietly becoming dumber than you asked for is its own kind of bug.
- Same gates as everywhere else: `onlineAI`, the auto-switch's view of reachability, and a provider that is actually configured. A plugin is not a side door to the network. File plugins call the same thing through `Aevion.plugins.askAI(spec, text)`, and may name a specific brain.

### Added: a nickname it answers to, where you would look for it
- The Voice tab has its own **Nickname** box under “Hands-free by name”. What you type is what the tab title, the HUD, the switch label and the wake word all use, and it is the same setting as “Assistant name” — change either one and the other follows. Empty or whitespace falls back to Aevion instead of naming the app “undefined”.

### Changed
- **The status pills are buttons now.** “WAKE” / “WAKE OFF” in the header and beside the hands-free heading did nothing when tapped, which is how they read as broken controls; tapping either one turns hands-free on or off, with a title that says which, and `aria-pressed` for screen readers.
- **When hands-free stops itself** (engine error, idle timeout, no speech engine) the reason is now shown — “⏸ Hands-free stopped — microphone not allowed” instead of a switch that quietly falls back to off.
- **The 🎤 button moved out of the header and into the composer**, next to the paperclip: voice input is still one tap away from anywhere, the top bar is not carrying three controls and three pills.

### Changed: when the AI cannot answer, one message says why and then answers
- Open conversation used to produce **two** bubbles — an error, then a local reply — which reads as two failures. The reason and the answer now travel together under an `OFFLINE BRAIN` badge, and each situation gets its own sentence: the endpoint did not answer (with the retry in a minute and where to change brain), it still needs an API key (with the exact field), or there is no internet and the auto-switch will move back by itself.
- A new quick-action chip, **🧠 Set up AI**, jumps straight to Settings → Providers.

### Fixed
- The app name in the tab title, the HUD and the assistant's own self-introduction had been left reading **“audit”** by the automated button sweep (it types into every field it finds). Restored to Aevion, and the sweep's other leftovers — one test timer and one test plugin — were removed.

### Verification
- **351 tests** (`npm run verify`), including 6 new ones for the auto-switch: default on, local-by-choice is not reported as an outage, auto-off keeps the old behaviour, a failure cools down for a minute and is retried, coming back is one call, and a fresh failure restarts the wait without shortening it.

## 0.6.1 — the offline brain learns languages, and every button is checked

### Added: the offline brain understands other languages (`js/nlu.js`)
- **Basic commands need no provider in any language.** Time, date, greetings, thanks, jokes, notes, tasks, timers and math are matched from per-language word tables instead of English keywords, so «ಟೈಮರ್ 5 ನಿಮಿಷ», «நேரம் என்ன», «సమయం ఎంత» and «समय क्या है» all run locally.
- **84 languages** in the picker (was 45), and **49 languages of offline word tables** — the ones people actually speak to it, extended by what the user teaches.
- **Digits and number words.** Every script's own digits fold to 0-9 first (`೨+೨`, `१० / ४`), and spoken numbers become digits in the language in play, so «ಎರಡು + ಎರಡು» is `= 4` — with whole-word matching, because “दोस्त” is a friend, not a two.
- **Replies come back in the language of the question** — the clock and date are read in the caller's own locale tag, and jokes are localized for the languages that have them, with an English fallback rather than silence.
- **English is untouched.** The table only answers when a non-Latin script or a non-English app language is in play; a pure-English sentence takes exactly the path it always did, which is asserted by tests.
- **Teach it a word.** `Aevion.nlu.teach(lang, intent, words)` stores words on the device, and the 🎤 Voice tab has a form for it — which is also how a language with no table starts working.

### Added: timers that keep running (`js/tools.js`)
- `timer.start`, `timer.list` and `timer.clear`, in every language. The deadline is stored, a hidden tab still fires it, and if the platform throttled it the app fires it late **and says how late** instead of swallowing it. Notifications only when that permission is granted.

### Added: one button for the whole automation picture (`system.report`)
- The 🧰 Tools view gained an **Automation report** button: tools per tier, what always asks first, what is switched off, what is waiting on a permission, which permissions are allowed, the routines, the timers, the self-upgrade state, and the real counts of what ran and what was refused — all read from the same tables the gate itself uses.
- **Best app or site for a topic** (`web.best`): a hand-written local directory of ~38 picks, scored against the topic, with a new `open_apps` permission and tier-3 confirmation. It refuses to guess rather than answering with something plausible and wrong.

### Added: the paperclip (`js/attach.js`)
- A button in the composer for **photo, video, document and PDF**, with chips above the box. Nothing is uploaded to classify a file; the kind comes from the file itself.
- Text-ish files (`.txt`, `.md`, `.csv`, code…) are readable on-device, so «summarize this» is answered by the local summarizer with no provider. A photo or a PDF is described honestly — “I cannot look inside this one on-device” — never faked.
- The chips row carries its own footnote — “kept only while this page is open — never uploaded” — so a clip to a message is never mistaken for something filed away.

### Added: 15 voices (`js/voices.js`)
- Fourteen named voices plus the system default, each a combination of **speed, pitch and which engine voice to use**. Every preset is audible on every device, because rate and pitch always work; the “which voice” part is best-effort, matched on the engine's own voice names with whole-word matching (“Female” must not match “male”), and reported as unmatched when there is none.
- **▶ Hear this voice** previews without changing anything you have selected, and moving the sliders afterwards marks the voice *adjusted* instead of silently pretending it is still Luna.
- Android's `SpeechPlugin` now forwards rate and pitch as well, so the same voices are audible in the APK.

### Added: self-upgrade that cannot be switched on from code (`js/evolve.js`)
- The toggle is **off by default** and turning it on needs an explicit consent argument, recorded as a hash. A hand-written `{"on": true}` in storage, or a flip from any code path without the user's yes, is inert — `on()` requires the flag *and* a valid consent hash. Turning it **off** never needs consent.
- With it on, Aevion can install a **knowledge pack** you approve: new words for the offline brain, a no-code plugin, or facts that go to the approval queue. **Code packs are refused**, with the reason stated: a web app rewriting its own source is not something that can be done honestly, and pretending otherwise would be worse than not having the feature.
- **Learning a little every day**: `evolve.learn()` runs at most once a day, mines the day's conversation for statements worth keeping, and files them as *candidates*. Nothing is remembered because Aevion noticed it — the user approves or deletes each one.

### Added: easier plugins (`js/plugins.js`)
- The registry moved out of `app.js` into a module, and gained **no-code plugins**: a name, a trigger word and a reply with `{query}`, `{name}`, `{time}`, `{date}`, `{lang}`. Saved on the device, listed, deletable, and installable from a pack. A reply template cannot read files or reach the network, which is exactly why making this easy is safe. Trigger collisions are reported instead of letting one plugin look broken.

### Added: theme, background and pairing niceties
- **Follow the device's light/dark setting.** Your own theme is stored separately and never overwritten, so turning the switch off always brings back exactly what you had.
- **Remember the previous theme** is therefore free — no history log, one setting.
- **Background mode** (on by default): timers keep counting, hands-free stays armed, and coming back reports whatever came due. The note says plainly that the OS may still suspend a page.
- **Importing a bundle can copy the theme “and everything”** — appearance, language and voice settings, listed explicitly. Permissions, API keys and the PIN are deliberately excluded: a bundle from another device must never be able to widen this one.
- **Live speak & translate**: speak in one language, hear it in another, phrase by phrase, with the microphone open only while it is on.

### Fixed
- **The menu button only ever opened.** On a wide screen the drawer class did nothing, so the button looked broken; the same press now closes the sidebar at every width.
- A Kannada or Hindi timer was set to **double** the length asked for, because the brain passed both minutes and seconds to a tool that adds them.
- `parseTranslate` could not parse a two-word language name (“Haitian Creole”), which the language list now contains.
- The Device access card was blank on load: its first render ran before settings existed and nothing repainted it.
- Picking a voice left the rate and pitch sliders showing stale numbers, so the next drag started from a value that was no longer in effect.

### Verification
- **345 tests** (`npm run verify`), including new suites for the multilingual brain (16), attachments (15), self-upgrade and daily learning (13), plugins (9), timers/report/best-site (13), voice presets (13) and device-theme following (5).
- **Every control was clicked in a real browser, twelve times over**: a sweep of all ~220 buttons, inputs, selects and textareas per pass, checking that each reacts without throwing, that checkboxes and selects return to their prior state, that the file inputs work, and that the seven destructive or consent-gated controls really do ask first. Two rounds of six passes: **zero failures, zero uncaught errors.**

## A name, 45 languages, and a UI you can actually open

### Fixed: every view except the chat was unreachable
The chat section carried a bare `#view-chat { display: flex }` rule. An id selector outranks the class-based `.view { display: none }`, so the chat view stayed painted underneath every other view and pushed them below the fold — clicking Settings, Tools or Voice changed the classes and looked like nothing happened. `#view-chat.active` fixes it. Nothing in the test suite could have caught this (no test loads app.js), which is why the fix was verified in a real browser: all eleven views now render, and the duplicate-id sweep across the document is clean.

### Added: the name it answers to (`js/wake.js`)
- **Say its name and ask in one breath** — «Hey Aevion, what is 2+2», «Hayy Aevion tell me a joke», «Yo Aevion open youtube» all run the request immediately. The name and greeting are stripped from the request, so the brain is never asked to parse its own name.
- **The name alone works too** — it answers with a spoken cue ("Yes?") and takes your next sentence as the request.
- **After a reply, keep talking** — a short follow-up window takes the next sentence with no name needed. Talking over the reply stops it, and the interruption becomes the new request unless it is a stop word.
- **Any nickname** — the name is a setting, so rename it to Nova and it answers to Nova. Matching tolerates the ways recognizers mangle names (a scaled edit distance plus a phonetic-neighbour table) and allows a filler between greeting and name ("hey um aevion …") without firing on a mere mention in the middle of a sentence.
- **Off by default and honest about why** — the microphone is only opened after the permission check, repeatedly failing engines back off instead of hot-looping, three idle minutes stop it, hiding the page pauses it, `not-allowed` turns it off, and a reload closes the mic and clears the flag instead of leaving the switch lit over a dead microphone.

### Added: one source of truth for languages (`Aevion.languages`)
- **45 languages**, each with a real BCP-47 region tag — including ಕನ್ನಡ Kannada, മലയാളം Malayalam, ગુજરાતી Gujarati, ਪੰਜਾਬੀ Punjabi, ଓଡ଼ିଆ Odia and অসমীয়া Assamese alongside the Hindi/Tamil/Telugu/Bengali/Marathi/Urdu the app already offered.
- The app-language dropdown, the speech-language picker, the recognizer, TTS, the voice filter and the translate skill all read that one table, so a language added there works everywhere. `Aevion.speechTag('hi')` → `hi-IN`, and an unlisted tag is passed through rather than silently swapped.
- The voice controls moved to the **🎤 Voice** tab; Settings links to it. The two switch elements that drove the same microphone from different screens are gone, along with the dead `#wakeNote` selector and the duplicate ids.

### Fixed (found while wiring the above)
- `voice.start()` threw synchronously on a device with no speech engine, so `start().catch(...)` could not catch it. It always rejects now.
- The permission manager threw a `TypeError` from `navigator.mediaDevices` on browsers without it; a missing media API is now an honest `denied`.
- Speech rate, pitch, recognition language and interim feedback were written to settings and never read. All four now reach the engines, out-of-range values are clamped, and `voice:done` fires when speech ends so the wake loop knows the reply is over.
- A language was handed to the recognizer as a bare code (`hi`), which engines guess at; all tags are region-qualified now.

### Verification
- `tests/wake.test.mjs` (36) drives the real state machine with a fake recognizer: matching, nickname, the name-only window, the follow-up window, barge-in, backoff, idle stop, pause/resume — no audio hardware.
- `tests/voice.test.mjs` (25) covers the language table, the tag expansion, the permission gate, TTS settings, the Android plugin path and the error text.
- `npm run verify`: 231 tests, static checks green.

## Custom themes, device access, and a bug that hid every screen

### Fixed: the chat view was painted under the whole app
`#view-chat { display: flex }` is an id rule, so it beat `.view { display: none }`. The chat section stayed visible beneath every other view and pushed them below the fold — clicking Settings, Tools or Voice changed the classes and looked like a dead button. `#view-chat.active` fixes it, and all eleven views now render. No unit test could have caught this (nothing loads `app.js`), which is why it was found and verified in a real browser.

### Fixed: a load-time crash that killed the app dead
`renderDeviceAccess()` ran before `boot()`, when `Aevion.settings` is still null, and the resulting exception stopped `app.js` from ever registering its startup handler: no boot, no views, no controls. It now guards for the pre-boot state like `renderPerms()` already did. Found in the browser console, not by the suite.

### Added: full theme customization (`js/theme.js`)
- **Twelve knobs over six presets** — 8 colours (accent, second accent, background, raised surface, panels, borders, text, secondary text) plus corner radius, text size, panel blur and glow. A change is one CSS variable, applied instantly, stored on the device, and independent of which preset you are on.
- **Per-knob reset.** Clearing one knob removes the inline value so the preset shows through again; “Reset custom changes” clears all of them. The state line says how many changes are live, and each slider shows whether you are seeing your value or the theme's.
- **Font size really scales.** All 34 `font-size` declarations in `style.css` are now `calc(Npx * var(--fs-scale))`, and panel blur is `var(--blur)`, so those knobs move the UI rather than just setting an unused variable.
- **Glow follows the accent**, via `color-mix(in srgb, var(--accent) N%, transparent)` — a custom accent glows in its own colour. Browsers without `color-mix()` keep the preset glow.
- **Export / import as one line** (`theme=midnight;accent=#ff0055;radius=2`). Validation is strict because these values become CSS: colours must be plain hex/`rgb()`/`hsl()`, numbers are clamped to their range, and anything carrying a URL, an expression or a second declaration is refused *by name* so the user can see what was rejected.
- `tests/theme.test.mjs` (15) covers validation, apply/reset, the glow derivation, export/import round-trips, hostile input, and that the engine still works before boot.

### Added: one switch for device access
- Asks for every permission this device can actually give, one at a time, and reports the result per permission — granted, refused, or unavailable on this device. "Unavailable" is a real outcome, so a device with no notification API is never credited with one.
- **It is a shortcut, never a bypass.** `tests/device.test.mjs` asserts the property directly: with everything granted and the switch on, `open.url`, `web.search`, `data.export` and `memory.forget` still refuse without a fresh confirmation, and an approval never carries over to the next call.
- **One tap revokes everything**, including permissions a previous session left behind, and the grant and the revoke are both written to the tool audit log.
- Capabilities only the Android shell can offer (contacts, files, calendar) are labelled “needs the Aevion app” instead of being marked granted — in the report, in `Aevion.perms.granted()`, and in the tool refusal text.
- Three new tools make the switch mean something: `device.access` (read — what may Aevion use here?), `device.notify` (sensitive, needs notifications) and `device.location` (sensitive, needs location). 25 tools → 28.

### Added: checks that stop dead controls coming back
- `tools/check.mjs` now fails if any `<button>`, `<input>`, `<select>` or `<textarea>` in `index.html` is not referenced by the code. Verified it has teeth by adding an unwired button and watching it fail.
- The static checks caught the theme work immediately: a `#setAccent` selector left pointing at an element that no longer exists, and the new module missing from the service-worker cache.

### Verification
231 → **265 tests**, static checks green.

## 0.6.0 — a verifiable core: providers, tools, memory, tests

This release changes how the project is *built* as much as what it does. Aevion had ~3,000 lines of shipped code and **zero** tests; it now has a verification loop that runs in seconds and gates every change.

### Verification (new — the reason to trust the rest)
- **`tests/` + `tests/harness.mjs`** — a headless browser shim (localStorage with a real quota, a recording `fetch`, a real event bus, WebCrypto, btoa/atob, a recording `window.open`) that evaluates the *actual* files `index.html` loads, in the same order, inside a Node VM. The harness reads the script tags from `index.html`, so it can never drift from what the page ships, and a new module is picked up automatically. **167 tests / 453 assertions** across core, brain, skills, markdown, providers, tools, memory and secrets.
- **`tools/check.mjs`** — static integrity, zero dependencies: every asset the page loads exists, no orphan module, every `$('#id')` in `app.js` resolves to a real element, every nav item has a view, every emitted event has a listener, asset versions agree across `index.html`/`sw.js`/`core.js`/`package.json`/CI/verifier, the Android manifest keeps `RECORD_AUDIO` + the speech `<queries>`, `registerPlugin` still precedes `super.onCreate`, no credentials committed, and the promised languages/providers/tiers/layers really exist.
- **`npm run verify`** = `check` + `test`. Both are already wired into the APK workflow.
- **`tools/dev-server.mjs`** — zero-dependency static server for local preview (`node tools/dev-server.mjs`), so non-Windows users are not stuck with `serve.ps1`.
- The checks earned their keep immediately: they caught a `%` operator the error message promised but the validator rejected, a dead `From memory:` branch that could never match, an over-strict streaming guard, and an `open.url` tool that silently rewrote `javascript:` URLs instead of refusing them.

### AI providers (new `js/providers.js`)
- **Nine adapters behind one interface** — `Aevion.providers.chat(messages)`: OpenAI, Groq, Ollama, LM Studio / llama.cpp / vLLM, any other OpenAI-compatible endpoint, Anthropic (Messages API, correct `x-api-key` + `anthropic-version` + browser-access header, system prompt lifted out of the message list), Google Gemini (`generateContent` and SSE streaming), the in-browser WebGPU model, and an **offline mock provider** for testing with nothing configured.
- **Per-provider configuration**: each provider keeps its own endpoint/model, so switching back and forth never wipes what you typed. The old flat `aiUrl`/`aiModel`/`aiKey` settings migrate automatically and are then cleared.
- **Streaming** where the provider supports it (SSE parsed into `onToken` deltas), with a fallback to the JSON body when a gateway answers with empty SSE envelopes.
- **Fallback is a privacy boundary, not a convenience**: a failing provider may only hand over to another of the *same trust class* (cloud → cloud/local, loopback → loopback/local, local → local). A prompt typed for one company is never silently rerouted to a different one. `settings.aiFallback` turns it off entirely.
- **Honest errors**: HTTP 401/404/429/5xx, unreachable hosts, empty replies and missing configuration each produce a message that says what to do; `Test connection` in Settings performs a real round trip and reports the measured latency.
- `js/online.js` is now a thin compatibility shim that owns only the persona prompt — and that prompt now includes **only the memories relevant to the current message**, not the whole store.

### Tools with real permission tiers (new `js/tools.js`)
- 25 built-in tools across four tiers: **read** (always allowed) → **safe** (local, user-asked) → **sensitive** (needs its permission) → **confirm** (irreversible or leaves the device — asks *every single time*).
- `Aevion.tools.run()` refuses with a machine-readable code (`permission` / `confirm` / `disabled` / `network` / `failed`) instead of half-doing something; tier-3 tools raise a confirmation request and the UI shows a modal. An approval never carries over to the next call.
- A **local audit log** records every attempt, including refusals, so the user can see exactly what ran.
- Tools can be switched off individually, and the Tools view shows each tool's tier, permissions, network use and current status.
- `open.url` accepts only `https:` — every other scheme is refused rather than rewritten.

### Layered memory (new `js/memory.js`)
- Five separate layers: **session** (RAM only), **history**, **longterm** (user-saved), **prefs** (inferred, inert until approved), **temp** (TTL).
- **Inferred preferences are never assumed**: Aevion notices "I prefer…"/"I always…" in passing, stores it unapproved, excludes it from recall entirely, and shows it in the Memory view for a yes/no. Nothing inferred is ever used silently.
- **Scored retrieval** (token overlap + phrase bonus + recency + layer weight, hard caps per layer) with a **"Preview recall"** button so the user can see exactly what would be offered as context.
- The old flat `memory` array migrates into `longterm` on first boot, de-duplicated.

### Credentials (new `Aevion.secrets` vault in `core.js`)
- API keys live outside `settings` and outside the per-provider config, and are **excluded from every backup and sync bundle** (`store.dumpSafe()`).
- Setting a PIN encrypts them at rest with **AES-GCM under a PBKDF2-SHA256 key derived from that PIN** (150k iterations, per-vault salt, fresh IV per write). A locked session cannot read them, and the UI says so honestly; without a PIN the UI states plainly that keys are stored unencrypted.

### UI
- New **Tools** view (tier legend, per-tool on/off, runner, audit log) and **Memory** view (layers, approve/reject queue, recall preview, per-layer clear, export).
- Settings → Privacy now drives the provider registry, with hints, per-provider fields, a fallback switch, `Test connection` and a credentials-at-rest line.
- A single-purpose confirmation modal for tier-3 tools.

### Performance
- **The 6.6 MB WebLLM engine is no longer precached at install.** It moved to `LAZY_ASSETS` and is fetched once, cache-first, only when a model is actually used — visitors no longer download it just by opening the app.
- The accent colour picker coalesces a drag into one storage write instead of one per input event.

### Fixed (found by the new checks, not by hand)
- `what is 2+2?` reached the chat fallback instead of the calculator (the purity test now strips conversational dressing first).
- `%` was rejected by the maths validator although its own error message advertised it.
- `From memory:` in the offline fallback could never match anything (it searched for a `|`-joined literal).
- `canStream()` refused to render markdown for *any* reply containing a fence, even a closed one.

## Tooling — the native wrapper is versioned (app version unchanged: 0.5.0)
- **`android-wrapper/` is now in git**: the Capacitor Android project (`android/`), `capacitor.config.json`, the npm manifests, `SpeechPlugin.java`, `MainActivity.java`, the manifest, icons, and all four helper scripts. Until now the voice code existed in exactly one place on one disk, outside any repo and outside OneDrive — one bad folder deletion from being gone.
- **Generated things stay out**: `node_modules/`, `www/`, `android/build/`, `android/app/build/`, `android/.gradle/` and `local.properties` are gitignored (Capacitor's own `android/.gitignore` handles the Android side). ~480 KB of actual source, 63 files.
- **Scripts are now location-independent**: `update-and-rebuild.bat` resolves the web app as its sibling `../aevion` (with an absolute fallback), `build-apk.ps1` derives `android/` from `$PSScriptRoot` and falls back to `JAVA_HOME`/`ANDROID_HOME`, and `verify-apk.ps1` locates both the APK and `aapt2` itself. The same files now work from the repo copy *or* the build folder — copy them into either and they behave.
- **`sync-wrapper.bat`**: two-way sync of the hand-written files between the repo copy and the build folder (robocopy `/XO`, newer file wins), so an edit made in either place can't drift or get lost. Never touches generated folders.
- **`verify-apk.ps1` grew up**: 12 checks now, including that the packaged `core.js` actually contains the event-payload fix — the kind of regression a passing build would happily hide.
- A fresh clone can rebuild the APK without `npx cap add android`, which would otherwise regenerate a default project and drop the plugin, manifest customisations and icons.

## 0.5.0 — voice that works in the Android app
- **Native speech plugin** (`android/app/src/main/java/com/aevion/app/SpeechPlugin.java`): a local Capacitor plugin exposing Android's own `SpeechRecognizer` + `TextToSpeech`. It exists because the Web Speech API is **not implemented in Android WebView**, so the mic button could never work inside the APK. Reachable from the web app as `window.Capacitor.Plugins.Speech`; registered in `MainActivity.onCreate` before the bridge is built.
- **`voice.js` picks its engine automatically**: native plugin when present, Web Speech API otherwise. Same public API either way (`start`, `stop`, `speak`, `voices`), so nothing above it changed.
- **Android 11+ package visibility**: added the `<queries>` entry for `android.speech.RecognitionService` — without it `SpeechRecognizer.isRecognitionAvailable()` reports *false* and voice silently looks "unsupported".
- **Permission flow reuses the Aevion permission manager**; the plugin falls back to Android's runtime dialog via `@PermissionCallback`, and Capacitor's `BridgeWebChromeClient` already routes WebView mic requests to the same OS dialog.
- **Live transcript + real error messages**: partial results now stream into the composer while you speak, and failure codes are translated to human text (`no-match` → "I didn't catch that — try again") instead of failing silently.
- **Fixed a latent event-bus bug**: `Aevion.on()` handed handlers the raw `CustomEvent`, but every payload handler treated the argument as the value — so voice input (in the browser too, not just the APK) sent the literal string `"[object CustomEvent]"`. Payloads are now unwrapped in `core.js`.
- **Crash guard**: `voices()` no longer assumes `speechSynthesis` exists — it is absent in Android WebView and threw when Settings rendered.
- Dev tooling: `verify-apk.ps1` (static APK checks: plugin classes in the dex, manifest queries, asset versions) and a fixed `update-and-rebuild.bat` that uses the portable Node/JDK/SDK paths instead of `PATH`.

## 0.4.1 — rich chat rendering
- **New module `js/markdown.js`** (zero dependencies, ~350 lines): headings, paragraphs, **bold**/*italic*/~~strike~~, inline code, links + autolinks, bullet/numbered lists with nesting, blockquotes, tables (with `:---:` alignment), horizontal rules and fenced code blocks.
- **Syntax highlighting** for 20+ languages — JavaScript/TypeScript, Python, Java, C/C++/C#, Go, Rust, PHP, Ruby, Kotlin, Swift, HTML/XML, CSS, JSON, YAML, Bash, SQL, Markdown — via one combined regex per language (ordered comment → string → number → keyword → function → type → operator rules).
- **Code block chrome**: language label, per-block **Copy** button with `navigator.clipboard` + `execCommand` fallback and “Copied ✓” feedback (event delegation, so restored history blocks work too).
- **XSS-safe by construction**: every source character is HTML-escaped *before* markup is generated; only Aevion's own tags are emitted; link targets are restricted to `http(s)://`, `mailto:` and `#`.
- **Streaming-aware**: replies repaint as markdown while the in-browser model streams tokens, but never mid-code-fence (avoids thrashing); the final pass always fully renders.
- **Speech cleanup**: `md.toPlain()` strips markdown before TTS, so Aevion says “(code block)” instead of reading backticks and asterisks.
- Chat replies and restored history render markdown; your own messages stay literal so what you typed is what you see.
- New code/syntax colour palette in `themes.css` with a dedicated light-theme variant; assets bumped to `?v=042`, cache `aevion-v0.4.1`.

## 0.4.0 — in-browser AI
- **WebLLM integration**: run Llama 3.2 / Qwen 2.5 / Gemma 2 (1–3B) fully in the browser on your GPU via WebGPU. No server, no API keys, works offline after the one-time model download (~1–3 GB, cached by the browser).
- **GPU capability detection**: probes `shader-f16`; q4f32 models (run on every WebGPU GPU) are default, q4f16 variants offered only on capable GPUs — avoids WGSL `enable f16` compile failures on older drivers.
- Engine vendored at `vendor/webllm.esm.js` (Apache-2.0, @mlc-ai/web-llm 0.2.85) — zero CDN dependency.
- New Settings card: capability check, model picker, download progress, load/unload, per-model cache tracking.
- Chat pipeline now: **in-browser model → online AI (opt-in) → local brain**, with graceful fallback and error notices at each hop.
- Streaming token rendering in the chat view (throttled to 60 ms).
- Service worker caches the engine + module; versioned assets bumped to `?v=040`.

## 0.3.0 — first full build

- **Modular core**: `core.js` (store/bus/perms/memory/hash), `brain.js` (intent routing + local NLU), `skills.js` (math/translate/summarize/quiz/code), `voice.js` (STT/TTS), `online.js` (gated OpenAI-compatible connector), `app.js` (UI).
- **Assistant view**: local chat, commands, memory ("remember: …", recall), math, time/date, jokes, privacy Q&A.
- **Online AI (opt-in)**: Ollama or any OpenAI-compatible endpoint, persona system prompt, graceful local fallback on error.
- **Voice**: tap-to-talk STT (permission-gated) + TTS replies with voice picker.
- **Translation**: "translate X to Y" + 🌐 toggle mode (opt-in).
- **Studio**: quiz generator, offline extractive summarizer, flashcard decks with review, pomodoro, 15-language code notes, code profiler.
- **Organizer**: tasks with due dates + notes.
- **Files**: private in-browser vault (≤2 MB per file, upload/download/delete).
- **Automations**: on-launch & manual routines running through the brain.
- **Devices**: password-based pairing, .aevion sync bundles, device list.
- **Plugins**: registry + hello-world sample with /hello and /fortune.
- **Security**: permission manager (real browser APIs), SHA-256 PIN lock, full export, factory reset.
- **PWA**: manifest, service worker, offline install; PC launcher `serve.bat`/`serve.ps1` (zero dependencies).
- **Docs**: README, ARCHITECTURE, PRIVACY, PLUGINS, ROADMAP, ANDROID-APK, CHANGELOG.

## Upgrade notes

- Storage is localStorage (`aevion:*` keys); the IndexedDB engine will migrate these keys automatically when it lands.
- To bump the app for installed clients: change `CACHE_VERSION` in `sw.js`.
