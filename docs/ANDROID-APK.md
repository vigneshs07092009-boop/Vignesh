# Building the Aevion Android APK

Aevion ships as a PWA first (installable from Chrome — the fastest path, no toolchain at all). This guide is for the **real APK**, which wraps the exact same code in a native Android shell.

The wrapper is committed in this repo at **[`android-wrapper/`](../android-wrapper/README.md)**. That folder is the source of truth for everything a browser cannot provide: the Android project, the build scripts, and `SpeechPlugin.java`.

## 1. Install the toolchain (once per machine)

1. **Node.js LTS** — https://nodejs.org
2. **JDK 17+** — bundled with recent Android Studio, or [Eclipse Temurin](https://adoptium.net)
3. **Android SDK** — Android Studio, or just the command-line tools

Nothing needs to be on your `PATH` — the build script points at the toolchain explicitly.

## 2. Get the project

```bash
git clone <your repo> && cd Vignesh/android-wrapper
npm install
```

The committed `android/` folder already contains the plugin, the manifest customisations and the icons. **Do not run `npx cap add android`** — it regenerates a default project and silently drops all of that.

## 3. Copy the web app in and build

```bash
mkdir -p www && cp -r ../aevion/. www/     # PowerShell: robocopy ..\aevion www /E /XF serve.ps1 serve.bat
cd android && ./gradlew assembleDebug      # Windows: .\gradlew.bat assembleDebug
```

The APK lands in `android/app/build/outputs/apk/debug/app-debug.apk`.

Sideloading: copy it to the phone, tap it, and allow **"Install unknown apps"** for that file manager. That prompt is normal for anything outside the Play Store.

`www/` is a build input, not source — it is a copy of `aevion/`, gitignored, and refreshed by the rebuild script.

## 4. Native voice (why the mic needs Java)

The Web Speech API that Aevion uses in a browser **is not implemented in Android WebView**, so voice input inside the APK cannot come from JavaScript. `SpeechPlugin.java` is a local Capacitor plugin that drives Android's own `SpeechRecognizer` and `TextToSpeech` instead; `js/voice.js` detects `window.Capacitor.Plugins.Speech` at load and uses it, falling back to the Web Speech API everywhere else.

```
android/app/src/main/java/com/aevion/app/SpeechPlugin.java   <- the plugin
android/app/src/main/java/com/aevion/app/MainActivity.java   <- registers it
android/app/src/main/AndroidManifest.xml                     <- RECORD_AUDIO + <queries>
```

Things that bite when editing it:

- `registerPlugin(SpeechPlugin.class)` must run **before** `super.onCreate()` — that is where the Capacitor bridge is built from the plugin list. Register it after, and the plugin silently does not exist.
- `SpeechRecognizer` must be created and driven from the **main thread** (`getActivity().runOnUiThread`); Capacitor runs plugin methods on a background thread.
- Android 11+ hides other packages by default: the `<queries><intent><action android:name="android.speech.RecognitionService"/></intent></queries>` entry is what keeps `isRecognitionAvailable()` honest. Without it the app claims there is no speech service.
- A `@PermissionCallback` method is looked up **by name** and must match the third argument of `requestPermissionForAlias(...)`.
- Guard late callbacks: aborting a session fires `onError(ERROR_CLIENT)`, so set the `listening` flag false *before* `cancel()` or the UI sees a phantom error.

Speech recognition on Android is usually **online** (Google's service) unless the device has an offline language pack installed — device-dependent, not something Aevion can force.

## 5. Rebuilding

### In the cloud (every push)

A **GitHub Actions workflow** builds the APK automatically on every push to `main` (and on PRs touching `main`, plus manual), so the latest APK is always downloadable without your PC's toolchain.

👉 **`.github/workflows/build-apk.yml`** — the workflow.

What it does on each run:
1. Checks out the repo.
2. Installs the Capacitor toolchain into `android-wrapper/.
3. Copies the `aevion/` web app into `www/`.
4. Syncs the Capacitor native project.
5. Builds the APK using the repo's Gradle wrapper (never the runner's global Gradle).
6. Uploads **Aevion-debug.apk** as a downloadable artifact (kept 90 days).
7. Runs a verification step that scans `classes.dex` for `SpeechPlugin` and checks the manifest for `RECORD_AUDIO` and the speech `<queries>` entry — if the plugin silently dropped, the run fails before you spend time downloading.

To get the APK:
- Go to the repo's **Actions** tab, click the latest **Build APK** run.
- Under **Artifacts**, click **Aevion-debug** to download the `.zip`.
- Unzip it — `app-debug.apk` inside is the APK to install on your phone.

The workflow runs on the GitHub-hosted `ubuntu-latest` runner, which already ships **Node 20, JDK 17 and the Android SDK** — nothing extra to install. Nothing lives in your cloud except the build result.

### On this PC

The toolchain lives outside your system `PATH`, so use the wrapper rather than calling `npx` yourself. Both copies work — the repo copy and the build folder `C:\Users\vigne\aevion-android`:

```
android-wrapper\update-and-rebuild.bat   # copy web app -> cap sync -> build -> Aevion.apk
android-wrapper\verify-apk.ps1           # proves the APK contains the plugin + current assets
android-wrapper\sync-wrapper.bat         # keep the two copies identical (newer file wins)
```

All three derive their own location (`%~dp0` / `$PSScriptRoot`), and `update-and-rebuild.bat` finds the web app as its sibling `..\aevion`, so the same files work from either folder. The scripts read Node/JDK/SDK from a config block at the top; edit those lines if you move the toolchain. `build-apk.ps1` falls back to `JAVA_HOME`/`ANDROID_HOME` if the portable copies are missing.

`verify-apk.ps1` runs 12 static checks on the built APK — plugin classes present in `classes.dex`, `RECORD_AUDIO` and the `<queries>` entry, current web assets. A build that silently drops the plugin is otherwise invisible until you try to talk to your phone.

### Two copies, one source of truth

Your build folder and the repo copy are the same project. Edit whichever you're working in, then run `sync-wrapper.bat`: it copies the hand-written files (`java/**`, `AndroidManifest.xml`, `capacitor.config.json`, the scripts) in **both** directions, keeps the newer file in each pair, and prints what `git status` wants to commit. Generated folders are never touched.

## 6. Permissions in the APK

Add only what you use to `android/app/src/main/AndroidManifest.xml`:

- `RECORD_AUDIO` + `MODIFY_AUDIO_SETTINGS` — voice input (Android's recognizer also needs its own service visible via `<queries>`)
- `INTERNET` — only needed if you enable online features

Aevion's permission manager surfaces the Android runtime dialogs at first use, and Capacitor's `BridgeWebChromeClient` routes WebView mic requests through the same OS dialog. Nothing is bypassed, and nothing listens until you tap the mic.

## 7. Play Store later?

Generate an upload key, build an AAB, enroll in Play Console:

```bash
keytool -genkey -v -keystore aevion-release.jks -alias aevion -keyalg RSA -keysize 2048 -validity 10000
cd android && ./gradlew bundleRelease     # needs signingConfig in app/build.gradle
```

Keep the keystore **out** of git and back it up — losing it means you can never update that Play listing. Google will also require a privacy policy; `docs/PRIVACY.md` is the template.

## Notes

- Update the app = copy new `aevion/` files into `www/`, run `cap sync`, rebuild (that is exactly what `update-and-rebuild.bat` does).
- The service worker keeps working inside the WebView for instant loads.
- Model weights are **not** in the APK. The in-browser AI downloads its ~1 GB once, per device, into the WebView's cache — Android Chrome/WebView 121+ has the WebGPU it needs.
