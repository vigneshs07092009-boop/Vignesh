# Aevion Android wrapper

The native shell that turns the web app in `../aevion` into **Aevion.apk**.

`../aevion` stays the single source of truth for everything the user sees — UI, brain, skills, voice logic. This folder only holds what a browser cannot provide: the Android project, the build tooling, and `SpeechPlugin.java`.

```
android-wrapper/
├── android/                       Capacitor Android project (Gradle, manifest, sources)
│   ├── app/src/main/
│   │   ├── AndroidManifest.xml    permissions + <queries> for speech
│   │   ├── java/com/aevion/app/
│   │   │   ├── SpeechPlugin.java         ← native speech recognition + TTS
│   │   │   ├── AppsPlugin.java           ← list/launch installed apps (read-only)
│   │   │   ├── UpdatePlugin.java         ← in-place self-update (PackageInstaller)
│   │   │   ├── UpdateStatusReceiver.java ← surfaces Android's install dialog
│   │   │   └── MainActivity.java         registers every plugin
│   │   └── res/                   icons, splash, styles, FileProvider paths
│   └── gradle/ gradlew*           Gradle wrapper
├── capacitor.config.json          appId com.aevion.app, webDir www
├── package.json / package-lock.json   @capacitor/* 8.5.2
├── update-and-rebuild.bat         one click: web app → sync → build → Aevion.apk
├── build-apk.ps1                  Gradle assembleDebug with JAVA_HOME/ANDROID_HOME set
├── verify-apk.ps1                 28 static checks on the built APK
├── install-to-phone.ps1           adb install -r (in place) + proves the update
└── sync-wrapper.bat               keeps this folder and your build folder identical
```

**Not in git on purpose:** `node_modules/`, `www/`, `android/build/`, `android/app/build/`, `android/.gradle/` (all generated or downloaded) and `local.properties` (contains *your* SDK path — `build-apk.ps1` supplies it from the environment instead). `android/.gitignore` covers the Android side; the root `.gitignore` covers the rest.

## Why SpeechPlugin.java exists

The Web Speech API that Aevion uses in Chrome **is not implemented in Android WebView**. No JavaScript can fix that, so the APK needs Java: `SpeechPlugin.java` is a local Capacitor plugin that drives Android's own `SpeechRecognizer` and `TextToSpeech`.

`js/voice.js` detects it at load (`window.Capacitor.Plugins.Speech`) and uses it when present, falling back to the Web Speech API everywhere else. One public API either way: `start`, `stop`, `speak`, `voices`, `errorText`.

```
available()               -> { available, tts }
checkPermissions()        -> { microphone }
requestPermissions()      -> { microphone }
start({language, partialResults})   resolves, then emits events
stop()
speak({text, language})
stopSpeaking()

events: speechReady {} · speechResult {text, isFinal} · speechEnd {text}
        speechError {error} · speechSpoken {}
```

### Five things that will bite you when editing it

1. `registerPlugin(SpeechPlugin.class)` must run **before** `super.onCreate()` in `MainActivity` — the Capacitor bridge is built inside `super.onCreate()` from the plugin list. Register it after and the plugin silently does not exist.
2. `SpeechRecognizer` must be created and driven on the **main thread** (`getActivity().runOnUiThread`). Capacitor runs plugin methods on a background thread.
3. Android 11+ hides other packages by default. Without the `<queries>` entry for `android.speech.RecognitionService` in the manifest, `isRecognitionAvailable()` returns **false** and the app claims there is no speech service.
4. A `@PermissionCallback` method is looked up **by name** and must match the third argument of `requestPermissionForAlias(...)`. Rename one and the permission flow dies with "no PermissionCallback method registered".
5. Guard late callbacks: aborting a session fires `onError(ERROR_CLIENT)`. The `listening` flag is set false *before* `cancel()` so the UI never sees a phantom error.

Fuller notes: [`../docs/ANDROID-APK.md`](../docs/ANDROID-APK.md).

## Rebuilding the APK

### On this PC

Double-click **`update-and-rebuild.bat`** (here, or in your build folder `C:\Users\vigne\aevion-android` — both work). It copies `../aevion` into `www/`, runs `cap sync`, builds, and drops the result at:

```
C:\Users\vigne\OneDrive\Documents\Aevion.apk
```

On the first run in a folder it has not been used in before, the script installs Capacitor itself (`npm install`, ~40 s, needs internet) and then builds. `node_modules/`, `www/` and the Gradle output folders are all gitignored, so they never appear in `git status`.

Then check it actually contains what you think:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File verify-apk.ps1
```

It verifies the plugin classes are really in `classes.dex`, the manifest permissions and `<queries>` entry, `REQUEST_INSTALL_PACKAGES`, the consent and checksum gates inside `update.js`, and that the packaged web assets are the current version — a build that silently drops the plugin or a safety gate is otherwise invisible until you talk to your phone.

Then put it on the phone **without losing any data**:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File install-to-phone.ps1
```

It waits for a USB-connected phone, runs `adb install -r` (replace, keeps app data), then prints `firstInstallTime` and `lastUpdateTime` — an unchanged `firstInstallTime` is the proof it replaced in place rather than uninstall-and-reinstall. Add `-Wait 300` to hold for the phone, or `-Log` to tail the app's log afterwards. The manual equivalent is `adb install -r "C:\Users\vigne\OneDrive\Documents\Aevion.apk"`.

Node, JDK 21 and the Android SDK live in `C:\Users\vigne\aevion-tools` (outside your system `PATH`). All three scripts read their paths from the config block at the top — edit those lines if you move the toolchain. `build-apk.ps1` falls back to `JAVA_HOME`/`ANDROID_HOME` if the portable copies are missing, so it also works on a machine with a normal Android Studio install.

### From scratch on another machine

1. Install **Node.js LTS**, **JDK 17+** and the **Android SDK** (command-line tools are enough).
2. Clone the repo and copy the web app in:

```bash
cd android-wrapper
npm install
mkdir www && cp -r ../aevion/. www/         # PowerShell: robocopy ..\aevion www /E /XF serve.ps1 serve.bat
npx cap sync android
```

3. Build:

```bash
cd android
./gradlew assembleDebug                     # Windows: .\gradlew.bat assembleDebug
```

The APK lands in `android/app/build/outputs/apk/debug/app-debug.apk`.

The committed `android/` folder already contains the plugin, the manifest customisations and the icons — you do **not** need `npx cap add android` (which would regenerate a default project and lose all of it).

## Two copies, kept honest

Your live build folder is `C:\Users\vigne\aevion-android`; this folder is the versioned copy. They are the same project, so edit whichever you are working in and run:

```
sync-wrapper.bat
```

It copies the hand-written files (`java/**`, `AndroidManifest.xml`, `capacitor.config.json`, the three scripts) in **both** directions and keeps the newer file in each pair — so a Java edit made in either place ends up in both, then `git status` shows you what to commit. Generated folders (`node_modules`, `www`, `build`) are never touched.

## Release builds

The daily driver is the **release** build signed with the project key (`Aevion-keystore/aevion-release.jks`, alias `aevion`), because the self-updater refuses an APK signed with a different key than the installed app — that is Android protecting your data, not a bug. `build-release.ps1` in the build folder builds it, publishes `Documents\Aevion.apk`, and writes `downloads\Aevion-<ver>.apk` + `downloads\update.json` into the repo for the updater to find. Debug-signed APKs (`build-apk.ps1`) are fine for trying things out, but installing one over a release build, or vice versa, will be refused as a signature mismatch. For the Play Store you additionally need an AAB:

```bash
keytool -genkey -v -keystore aevion-release.jks -alias aevion -keyalg RSA -keysize 2048 -validity 10000
cd android && ./gradlew bundleRelease        # needs signingConfig in app/build.gradle
```

Keep the keystore **out** of git (and back it up — losing it means you can never update that Play listing). Google will also require a privacy policy; `../docs/PRIVACY.md` is the template.
