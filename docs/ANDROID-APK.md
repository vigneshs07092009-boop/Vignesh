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
