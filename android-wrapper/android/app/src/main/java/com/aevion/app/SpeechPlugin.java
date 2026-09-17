package com.aevion.app;

import android.Manifest;
import android.content.Intent;
import android.os.Bundle;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.ArrayList;
import java.util.Locale;

/**
 * Aevion Speech — native voice for the Android app.
 *
 * Why this exists: the Web Speech API that Aevion uses in the browser
 * (SpeechRecognition) is not implemented in Android WebView, so the mic
 * button could never work inside the APK. This plugin talks to Android's
 * own on-device speech services instead, and it uses the same permission
 * gate as the web app: nothing listens until the user taps the mic.
 *
 * API (reachable as window.Capacitor.Plugins.Speech):
 *   available()            -> { available, tts }
 *   checkPermissions()     -> { microphone }
 *   requestPermissions()   -> { microphone }
 *   start({language, partialResults}) -> resolves, then emits events
 *   stop()                 -> stops listening
 *   speak({text, language})-> speaks text out loud
 *   stopSpeaking()         -> stops speech output
 *
 * Events: speechReady {} · speechResult {text, isFinal} · speechEnd {text}
 *         speechError {error} · speechSpoken {}
 */
@CapacitorPlugin(name = "Speech", permissions = { @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO }) })
public class SpeechPlugin extends Plugin {

    private SpeechRecognizer recognizer;
    private TextToSpeech tts;
    private boolean listening = false;
    private boolean ttsReady = false;
    private String pendingSpeakText;

    /* ================= microphone ================= */

    @PluginMethod
    public void available(PluginCall call) {
        JSObject result = new JSObject();
        result.put("available", SpeechRecognizer.isRecognitionAvailable(getContext()));
        result.put("tts", ttsReady);
        call.resolve(result);
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            // asks Android for RECORD_AUDIO, then calls micPermission(...) below
            requestPermissionForAlias("microphone", call, "micPermission");
            return;
        }
        beginListening(call);
    }

    @PermissionCallback
    public void micPermission(PluginCall call) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) {
            beginListening(call);
        } else {
            call.reject("Microphone permission denied");
        }
    }

    private void beginListening(PluginCall call) {
        if (!SpeechRecognizer.isRecognitionAvailable(getContext())) {
            call.reject("No speech recognition service on this device. Install or enable Google voice input in Android settings.");
            return;
        }

        final String language = call.getString("language", "en-US");
        final Boolean partial = call.getBoolean("partialResults", true);

        // SpeechRecognizer must be created and driven from the main thread.
        getActivity().runOnUiThread(() -> {
            try {
                destroyRecognizer();
                recognizer = SpeechRecognizer.createSpeechRecognizer(getContext());
                recognizer.setRecognitionListener(listener);

                Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
                intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
                intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, language);
                intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, partial);
                intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3);
                intent.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, getContext().getPackageName());

                listening = true;
                recognizer.startListening(intent);
                call.resolve();
            } catch (Exception e) {
                listening = false;
                call.reject("Could not start speech recognition: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (recognizer != null && listening) {
                try {
                    recognizer.stopListening();
                } catch (Exception ignored) {
                }
            }
            listening = false;
            call.resolve();
        });
    }

    private final RecognitionListener listener = new RecognitionListener() {
        @Override
        public void onReadyForSpeech(Bundle params) {
            notifyListeners("speechReady", new JSObject());
        }

        @Override
        public void onBeginningOfSpeech() {}

        @Override
        public void onRmsChanged(float rmsdB) {}

        @Override
        public void onBufferReceived(byte[] buffer) {}

        @Override
        public void onEndOfSpeech() {}

        @Override
        public void onPartialResults(Bundle partialResults) {
            if (!listening) return;
            emitResult(firstMatch(partialResults), false);
        }

        @Override
        public void onResults(Bundle results) {
            if (!listening) return;
            String text = firstMatch(results);
            listening = false;
            emitResult(text, true);
            emitEnd(text);
        }

        @Override
        public void onError(int error) {
            // late callbacks from a finished/aborted session are not user-visible
            if (!listening) return;
            listening = false;
            JSObject data = new JSObject();
            data.put("error", errorName(error));
            notifyListeners("speechError", data);
            emitEnd("");
        }

        @Override
        public void onEvent(int eventType, Bundle params) {}
    };

    private static String firstMatch(Bundle bundle) {
        if (bundle == null) return "";
        ArrayList<String> matches = bundle.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        if (matches == null || matches.isEmpty()) return "";
        return matches.get(0);
    }

    private void emitResult(String text, boolean isFinal) {
        JSObject data = new JSObject();
        data.put("text", text == null ? "" : text);
        data.put("isFinal", isFinal);
        notifyListeners("speechResult", data);
    }

    private void emitEnd(String text) {
        JSObject data = new JSObject();
        data.put("text", text == null ? "" : text);
        notifyListeners("speechEnd", data);
    }

    private static String errorName(int error) {
        switch (error) {
            case SpeechRecognizer.ERROR_AUDIO:
                return "audio";
            case SpeechRecognizer.ERROR_CLIENT:
                return "client";
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS:
                return "permission";
            case SpeechRecognizer.ERROR_NETWORK:
                return "network";
            case SpeechRecognizer.ERROR_NETWORK_TIMEOUT:
                return "network-timeout";
            case SpeechRecognizer.ERROR_NO_MATCH:
                return "no-match";
            case SpeechRecognizer.ERROR_RECOGNIZER_BUSY:
                return "busy";
            case SpeechRecognizer.ERROR_SERVER:
                return "server";
            case SpeechRecognizer.ERROR_SPEECH_TIMEOUT:
                return "timeout";
            default:
                return "unknown";
        }
    }

    private void destroyRecognizer() {
        if (recognizer == null) return;
        listening = false; // ignore cancel()'s error callback
        try {
            recognizer.cancel();
        } catch (Exception ignored) {
        }
        try {
            recognizer.destroy();
        } catch (Exception ignored) {
        }
        recognizer = null;
    }

    /* ================= speech out ================= */

    @PluginMethod
    public void speak(PluginCall call) {
        final String text = call.getString("text", "");
        final String language = call.getString("language", "en-US");
        if (text == null || text.trim().isEmpty()) {
            call.resolve();
            return;
        }
        getActivity().runOnUiThread(() -> {
            if (tts == null) {
                // first call: engine boots asynchronously, speak once it is ready
                pendingSpeakText = text;
                ensureTts(language);
                call.resolve();
                return;
            }
            speakNow(text, language);
            call.resolve();
        });
    }

    @PluginMethod
    public void stopSpeaking(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (tts != null) {
                try {
                    tts.stop();
                } catch (Exception ignored) {
                }
            }
            pendingSpeakText = null;
            call.resolve();
        });
    }

    private void ensureTts(final String language) {
        if (tts != null) return;
        tts = new TextToSpeech(getContext(), status -> {
            ttsReady = (status == TextToSpeech.SUCCESS);
            if (!ttsReady || tts == null) return;
            tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override
                public void onStart(String utteranceId) {}

                @Override
                public void onDone(String utteranceId) {
                    notifyListeners("speechSpoken", new JSObject());
                }

                @Override
                public void onError(String utteranceId) {
                    JSObject data = new JSObject();
                    data.put("error", "tts");
                    notifyListeners("speechError", data);
                }

                @Override
                public void onError(String utteranceId, int errorCode) {
                    onError(utteranceId);
                }
            });
            if (pendingSpeakText != null) {
                String queued = pendingSpeakText;
                pendingSpeakText = null;
                speakNow(queued, language);
            }
        });
    }

    private void speakNow(String text, String language) {
        if (tts == null) return;
        try {
            Locale locale = Locale.forLanguageTag(language.replace('_', '-'));
            int result = tts.setLanguage(locale);
            if (result == TextToSpeech.LANG_MISSING_DATA || result == TextToSpeech.LANG_NOT_SUPPORTED) {
                tts.setLanguage(Locale.US);
            }
            tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "aevion");
        } catch (Exception e) {
            JSObject data = new JSObject();
            data.put("error", "tts: " + e.getMessage());
            notifyListeners("speechError", data);
        }
    }

    /* ================= lifecycle ================= */

    @Override
    protected void handleOnDestroy() {
        destroyRecognizer();
        if (tts != null) {
            try {
                tts.stop();
                tts.shutdown();
            } catch (Exception ignored) {
            }
            tts = null;
        }
        ttsReady = false;
    }
}
