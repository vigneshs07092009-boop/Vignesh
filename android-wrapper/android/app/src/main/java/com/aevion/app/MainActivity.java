package com.aevion.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Local plugin: gives the WebView native speech recognition + TTS,
        // which Android WebView does not provide otherwise.
        // Must be registered before super.onCreate() — that is where the
        // Capacitor bridge is built from the registered plugin list.
        registerPlugin(SpeechPlugin.class);
        // Local plugin: the installed-app list and starting an app by name.
        // A web page cannot see the apps on the device, so this half of
        // “plug Aevion into whatever I install” only exists in the APK;
        // js/apps.js answers honestly when it is missing.
        registerPlugin(AppsPlugin.class);
        // Local plugin: the in-place self-update — hands a checksum-verified
        // APK to Android's PackageInstaller so a new signed build replaces
        // this one without uninstalling, keeping all app data. The system's
        // own dialog is the consent step; nothing installs silently.
        registerPlugin(UpdatePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
