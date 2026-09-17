# Building the Aevion Android APK

Aevion ships as a PWA (installable from Chrome — that's the fastest path). When you want a **real APK** with a native shell, wrap the exact same code with Capacitor. One-time setup on a PC:

## 1. Install the toolchain (one time)

1. **Node.js LTS** — https://nodejs.org
2. **Android Studio** — https://developer.android.com/studio (installs the SDK)
3. JDK 17 comes bundled with recent Android Studio.

## 2. Create the wrapper project

```bash
mkdir aevion-android && cd aevion-android
npm init -y
npm i @capacitor/core @capacitor/cli @capacitor/android
npx cap init Aevion com.aevion.app --web-dir=www
```

## 3. Copy the app in

```bash
mkdir www
# copy EVERYTHING from the repo's aevion/ folder into www/
xcopy /E /I path\to\Vignesh\aevion www
```

Edit `capacitor.config.json`:

```json
{
  "appId": "com.aevion.app",
  "appName": "Aevion",
  "webDir": "www",
  "server": { "androidScheme": "https" }
}
```

## 4. Build

```bash
npx cap add android
npx cap sync
npx cap open android   # opens Android Studio → Build > Build APK(s)
```

The APK lands in `android/app/build/outputs/apk/debug/app-debug.apk`.
Sideloading: enable "Install unknown apps" for your file manager, open the APK, done.

## 5. Permissions in the APK

Add only what you use to `android/app/src/main/AndroidManifest.xml` — e.g. `RECORD_AUDIO` (voice), `INTERNET` (only if you enable online features). Aevion's permission manager surfaces the Android runtime dialogs at first use, per Google Play policy. Nothing is bypassed.

## Play Store later?

Same project: generate an upload key (`keytool`), build an AAB (`bundleRelease`), enroll in Play Console. Note Google may require a privacy policy — docs/PRIVACY.md is your template.

## Notes

- Update the app = copy new `aevion/` files into `www/`, run `npx cap sync`, rebuild.
- The service worker keeps working inside the WebView for instant loads.

## Native voice (why the mic needs Java)

The Web Speech API that Aevion uses in a browser **does not exist in Android WebView**, so voice input inside the APK cannot come from JavaScript. `SpeechPlugin.java` is a small local Capacitor plugin that calls Android's own `SpeechRecognizer` and `TextToSpeech` instead.

```
android/app/src/main/java/com/aevion/app/SpeechPlugin.java   <- the plugin
android/app/src/main/java/com/aevion/app/MainActivity.java   <- registers it
android/app/src/main/AndroidManifest.xml                    <- RECORD_AUDIO + <queries>
```

Things that bite when editing it:

- `registerPlugin(SpeechPlugin.class)` must run **before** `super.onCreate()` — that is where the bridge is built from the plugin list.
- `SpeechRecognizer` must be created and driven from the **main thread** (`getActivity().runOnUiThread`).
- Android 11+ hides other packages by default: the `<queries><intent><action android:name="android.speech.RecognitionService"/></intent></queries>` entry is what keeps `isRecognitionAvailable()` honest.
- A `@PermissionCallback` method is looked up **by name** and must match the third argument of `requestPermissionForAlias(...)`.
- Late callbacks from a cancelled session are dropped by checking a `listening` flag first, otherwise aborting a session fires a bogus "error" at the UI.

Speech recognition on Android is usually **online** (Google's service) unless the device has an offline language pack installed — device-dependent, not something Aevion can force.

## Rebuilding on this PC

The toolchain is installed **outside** your system PATH, so use the wrapper rather than calling `npx` yourself:

```
C:\Users\vigne\aevion-android\update-and-rebuild.bat    # copy web app -> cap sync -> build -> Aevion.apk
C:\Users\vigne\aevion-android\verify-apk.ps1            # proves the APK contains the plugin + current assets
```

`update-and-rebuild.bat` expects the portable Node/JDK/SDK at `C:\Users\vigne\aevion-tools` (edit the `NODE=`/`JDK=`/`SDK=` lines if you move them) and deliberately runs a non-interactive PowerShell detach for Gradle (see `build-apk.ps1`) because a long Gradle run outlives a normal terminal window. `verify-apk.ps1` fails loudly if a build silently drops the plugin classes, the manifest queries, or the versioned web assets.
