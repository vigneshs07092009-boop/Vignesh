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
        super.onCreate(savedInstanceState);
    }
}
