package com.aevion.app;

import android.app.PendingIntent;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.content.pm.SigningInfo;
import android.net.Uri;
import android.os.Build;
import android.os.StatFs;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Locale;

/**
 * Aevion Update — install a new signed build of Aevion over this one.
 *
 * What this is for: the same update flow any app store performs. The web
 * layer (js/update.js) checks update.json on aevion.app, downloads the
 * signed APK, and verifies it against the published SHA-256 — all before
 * this plugin is ever called. This plugin is the last mile: it re-verifies
 * the same digest in Java (two languages, two gates), writes the bytes to
 * this app's own internal cache, and hands the file to Android's
 * PackageInstaller. The system then shows ITS OWN dialog, and only a yes
 * there replaces the app — in place, same package, same signing key —
 * leaving every chat, memory and setting untouched.
 *
 * Nothing here can install anything silently: the session is committed
 * WITHOUT the UPDATE_PACKAGES_WITHOUT_USER_ACTION permission, so Android
 * always asks the user. The manifest carries REQUEST_INSTALL_PACKAGES
 * ("install unknown apps"), which the user grants in system settings —
 * a deliberate, visible, one-time act, never a background step.
 *
 * API (reachable as window.Capacitor.Plugins.Update):
 *   meta()  -> { versionCode: 6009, versionName: "0.6.9" }
 *   install({ base64, expectedSha256, expectedVersionCode, sizeBytes })
 *           -> { ok: true, reason }
 *            | { ok: false, code, reason }   code is one of
 *              download | checksum | storage | identity | signature |
 *              downgrade | install
 *
 * Before a single byte of a session is written, the staged file is asked
 * what it actually is: which package it declares, which version, and which
 * certificate signed it. All three must answer the same way the installed
 * app would — same applicationId, a higher versionCode, and the SAME
 * signing certificate. Android would enforce the last two itself, but then
 * the user would meet a cryptic installer error; asking first turns it into
 * a sentence. A file that fails any check is deleted, not kept around.
 *
 * Downgrades are refused here as well as by the platform: versionCode must
 * strictly increase, which is what makes an update an update.
 */
@CapacitorPlugin(name = "Update")
public class UpdatePlugin extends Plugin {

    /** The real package versionCode/versionName — the number Gradle stamped
     *  into the APK, so the web comparison runs against build truth. */
    @PluginMethod
    public void meta(PluginCall call) {
        try {
            PackageManager pm = getContext().getPackageManager();
            PackageInfo p = pm.getPackageInfo(getContext().getPackageName(), 0);
            long vc = (Build.VERSION.SDK_INT >= 28) ? p.getLongVersionCode() : p.versionCode;
            JSObject r = new JSObject();
            r.put("versionCode", vc);
            r.put("versionName", p.versionName == null ? "" : p.versionName);
            call.resolve(r);
        } catch (Exception e) {
            JSObject r = new JSObject();
            r.put("versionCode", 0);
            r.put("versionName", "");
            r.put("error", e.getMessage() == null ? "could not read package info" : e.getMessage());
            call.resolve(r);
        }
    }

    /** Install an APK the web layer already downloaded and checksum-verified.
     *  base64 carries the bytes (a JS File object cannot cross the bridge);
     *  expectedSha256 must match the bytes AGAIN, in Java, before anything
     *  is written — a mismatch refuses the whole thing. */
    @PluginMethod
    public void install(PluginCall call) {
        String b64 = call.getString("base64");
        String expected = call.getString("expectedSha256");
        Integer expectVc = call.getInt("expectedVersionCode");

        if (b64 == null || b64.length() == 0) {
            JSObject r = new JSObject();
            r.put("ok", false);
            r.put("code", "download");
            r.put("reason", "No APK arrived — download it again from Settings → App updates.");
            call.resolve(r);
            return;
        }
        if (expected == null || expected.length() != 64) {
            JSObject r = new JSObject();
            r.put("ok", false);
            r.put("code", "checksum");
            r.put("reason", "The update arrived without a checksum to verify against — refusing it.");
            call.resolve(r);
            return;
        }

        byte[] bytes;
        try {
            bytes = android.util.Base64.decode(b64, android.util.Base64.DEFAULT);
        } catch (IllegalArgumentException e) {
            JSObject r = new JSObject();
            r.put("ok", false);
            r.put("code", "download");
            r.put("reason", "The downloaded file could not be decoded — refusing it.");
            call.resolve(r);
            return;
        }
        if (bytes.length < 1024) {
            JSObject r = new JSObject();
            r.put("ok", false);
            r.put("code", "download");
            r.put("reason", "The download is far too small to be an APK — refusing it.");
            call.resolve(r);
            return;
        }

        /* Gate two of two: recompute the digest over the bytes that actually
           reached Java. If it differs from what update.json published, the
           file is not the one the manifest described — stop here. */
        String actual = sha256Hex(bytes);
        if (actual == null || !actual.equalsIgnoreCase(expected)) {
            JSObject r = new JSObject();
            r.put("ok", false);
            r.put("code", "checksum");
            r.put("reason", "The downloaded file does not match its published checksum — refusing to install it.");
            call.resolve(r);
            return;
        }

        /* Storage is checked before a byte is written, because the failure
           that matters is "the phone is full", not "the write half
           happened". The APK is staged in the app's own cache, and Android
           keeps a reserve it will not let apps eat into, so ask for the
           file's size plus a margin. */
        long free = freeCacheBytes();
        long needed = bytes.length + (bytes.length / 2) + (2L * 1024 * 1024);
        if (free < needed) {
            JSObject r = new JSObject();
            r.put("ok", false);
            r.put("code", "storage");
            r.put("reason", "Not enough free storage for the update — it needs about "
                    + mb(needed) + " MB and this device has " + mb(free) + " MB spare. Free some space and try again.");
            call.resolve(r);
            return;
        }

        File apk = writeApk(bytes);
        if (apk == null) {
            JSObject r = new JSObject();
            r.put("ok", false);
            r.put("code", "storage");
            r.put("reason", "Could not stage the downloaded update inside the app's own storage.");
            call.resolve(r);
            return;
        }

        /* What is this file, really? Ask it before offering it to Android:
           a genuine update is the same applicationId, a strictly higher
           versionCode, and the same signing certificate. Android enforces
           the last two on its own, but pre-checking turns "Install failed"
           into a sentence a person can act on — and a file that fails here
           is deleted rather than left in the cache. */
        String identity = verifyUpdateApk(apk, expectVc);
        if (identity != null) {
            //noinspection ResultOfMethodCallIgnored
            apk.delete();
            JSObject r = new JSObject();
            r.put("ok", false);
            r.put("code", identity);
            r.put("reason", identityReason(identity));
            call.resolve(r);
            return;
        }

        try {
            installBySession(apk);
            JSObject r = new JSObject();
            r.put("ok", true);
            r.put("reason", "Handed to Android — approve the system install dialog. The app restarts into the new build; your data stays.");
            call.resolve(r);
            return;
        } catch (Exception sessionFailed) {
            /* The session path needs "install unknown apps" to be granted
               system-wide. If that (or anything else) fails, fall back to
               the classic installer intent via FileProvider — the user
               still sees and approves everything. */
            try {
                installByViewIntent(apk);
                JSObject r = new JSObject();
                r.put("ok", true);
                r.put("reason", "Opened the system installer — approve it there. Your data stays.");
                call.resolve(r);
                return;
            } catch (Exception viewFailed) {
                JSObject r = new JSObject();
                r.put("ok", false);
                r.put("code", "install");
                r.put("reason", "The system installer refused: "
                        + first(sessionFailed.getMessage(), viewFailed.getMessage()));
                call.resolve(r);
            }
        }
    }

    /* ---------- the PackageInstaller session path ---------- */

    private void installBySession(File apk) throws Exception {
        PackageInstaller pi = getContext().getPackageManager().getPackageInstaller();

        PackageInstaller.SessionParams params =
                new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);

        int sessionId = pi.createSession(params);
        PackageInstaller.Session session = pi.openSession(sessionId);
        try {
            InputStream in = new FileInputStream(apk);
            OutputStream out = session.openWrite("aevion-update", 0, apk.length());
            try {
                byte[] buf = new byte[65536];
                int n;
                while ((n = in.read(buf)) >= 0) out.write(buf, 0, n);
                session.fsync(out);
            } finally {
                try { out.close(); } catch (Exception ignore) { }
                try { in.close(); } catch (Exception ignore) { }
            }

            /* The system reports progress to this receiver. The FIRST thing it
               sends is "waiting for the user" — the receiver opens Android's
               own install dialog. That dialog IS the consent step; without the
               user's tap there, nothing is ever installed. */
            Intent status = new Intent(getContext(), UpdateStatusReceiver.class);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= 31) flags |= PendingIntent.FLAG_MUTABLE;
            PendingIntent sender = PendingIntent.getBroadcast(getContext(), sessionId, status, flags);

            session.commit(sender.getIntentSender());
        } finally {
            session.close();
        }
    }

    /* ---------- the ACTION_VIEW fallback ---------- */

    private void installByViewIntent(File apk) throws Exception {
        Uri uri = FileProvider.getUriForFile(
                getContext(), getContext().getPackageName() + ".fileprovider", apk);
        Intent view = new Intent(Intent.ACTION_VIEW);
        view.setDataAndType(uri, "application/vnd.android.package-archive");
        view.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(view);
    }

    /* ---------- helpers ---------- */

    /** Stages the bytes inside this app's private cache — no storage
     *  permission, invisible to other apps, wiped with the app. */
    private File writeApk(byte[] bytes) {
        try {
            File dir = new File(getContext().getCacheDir(), "update");
            if (!dir.exists() && !dir.mkdirs()) return null;
            File apk = new File(dir, "aevion-update.apk");
            FileOutputStream fos = new FileOutputStream(apk);
            try {
                fos.write(bytes);
                fos.getFD().sync();
            } finally {
                fos.close();
            }
            return apk;
        } catch (Exception e) {
            return null;
        }
    }

    /* ---------- is this file actually an update for THIS app? ---------- */

    /** Returns null when the APK is a legitimate update, or a failure code
     *  (identity / signature / downgrade) when it is not. */
    private String verifyUpdateApk(File apk, Integer expectedVersionCode) {
        try {
            PackageManager pm = getContext().getPackageManager();
            int flags = (Build.VERSION.SDK_INT >= 28)
                    ? PackageManager.GET_SIGNING_CERTIFICATES
                    : PackageManager.GET_SIGNATURES;

            PackageInfo archive = pm.getPackageArchiveInfo(apk.getAbsolutePath(), flags);
            if (archive == null) return "identity";

            /* 1. Same application. A different package name would install a
                  SECOND app beside Aevion instead of replacing it — the exact
                  thing an update must never do. */
            if (!getContext().getPackageName().equals(archive.packageName)) return "identity";

            /* 2. Newer, and never older. */
            PackageInfo mine = pm.getPackageInfo(getContext().getPackageName(), 0);
            long incoming = (Build.VERSION.SDK_INT >= 28)
                    ? archive.getLongVersionCode() : archive.versionCode;
            long installed = (Build.VERSION.SDK_INT >= 28)
                    ? mine.getLongVersionCode() : mine.versionCode;
            if (expectedVersionCode != null && expectedVersionCode > 0
                    && incoming != (long) expectedVersionCode) {
                // The manifest promised one version and the file is another.
                return "identity";
            }
            if (incoming <= installed) return "downgrade";

            /* 3. Signed by the same key. This is the check that makes a
                  substituted APK useless: without the private key, nothing
                  can wear this certificate, so nothing can replace the app
                  and inherit its data. */
            String archiveSigners = signerDigests(archive);
            String installedSigners = signerDigests(mine);
            if (archiveSigners == null || installedSigners == null) return "signature";
            if (!archiveSigners.equals(installedSigners)) return "signature";

            return null;
        } catch (Exception e) {
            return "identity";
        }
    }

    /** Every certificate that signed a package, as sorted SHA-256 digests.
     *  Sorted and joined so two packages can be compared without depending
     *  on the order the platform happened to list their signers in. */
    private static String signerDigests(PackageInfo info) {
        Signature[] sigs = null;
        if (Build.VERSION.SDK_INT >= 28 && info.signingInfo != null) {
            SigningInfo si = info.signingInfo;
            sigs = si.hasMultipleSigners()
                    ? si.getApkContentsSigners()
                    : si.getSigningCertificateHistory();
        }
        if (sigs == null) sigs = info.signatures;
        if (sigs == null || sigs.length == 0) return null;

        String[] digests = new String[sigs.length];
        for (int i = 0; i < sigs.length; i++) digests[i] = sha256Hex(sigs[i].toByteArray());
        Arrays.sort(digests);
        StringBuilder sb = new StringBuilder();
        for (String d : digests) sb.append(d).append(';');
        return sb.toString();
    }

    private static String identityReason(String code) {
        if ("signature".equals(code)) {
            return "That file is not signed by the key that signed Aevion on this device, "
                    + "so Android would refuse it — and installing it would mean handing this "
                    + "app's data to someone else's build. Refused.";
        }
        if ("downgrade".equals(code)) {
            return "That file is not newer than the version already installed, and Android "
                    + "refuses backwards installs. Refused.";
        }
        return "That file is not an Aevion update build — its package or version is not the "
                + "one the update manifest described. Refused, and the file was deleted.";
    }

    /** Free bytes in the app's private cache. Android reserves a slice of
     *  internal storage for itself, so this is already the honest number. */
    private long freeCacheBytes() {
        try {
            File dir = getContext().getCacheDir();
            StatFs fs = new StatFs(dir.getAbsolutePath());
            return fs.getAvailableBytes();
        } catch (Exception e) {
            return Long.MAX_VALUE;   // never block an update on a failed probe
        }
    }

    private static String mb(long bytes) {
        return String.format(Locale.US, "%.1f", bytes / 1048576.0);
    }

    private static String sha256Hex(byte[] bytes) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] d = md.digest(bytes);
            StringBuilder sb = new StringBuilder(d.length * 2);
            for (byte b : d) sb.append(String.format(Locale.US, "%02x", b));
            return sb.toString();
        } catch (Exception e) {
            return null;
        }
    }

    private static String first(String a, String b) {
        if (a != null && !a.isEmpty()) return a;
        if (b != null && !b.isEmpty()) return b;
        return "the install did not happen";
    }
}
