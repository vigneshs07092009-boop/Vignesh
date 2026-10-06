package com.aevion.app;

import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.Collections;
import java.util.Comparator;
import java.util.List;

/**
 * Aevion Apps — the installed-app list, for the Android app only.
 *
 * What this is for: “if I install an app, plug Aevion into it”. A web page
 * cannot see the apps on the device — no browser exposes them — so the list
 * and the launch both have to come from Android. js/apps.js talks to this
 * plugin and, when it is not there (a plain browser tab, the PWA), says so
 * in one sentence instead of failing.
 *
 * API (reachable as window.Capacitor.Plugins.Apps):
 *   listInstalled()        -> { apps: [{ label, package }] }
 *   open({ package })      -> { opened: true } | { opened: false, why }
 *
 * Nothing here reads the user's files, contacts or history: it asks the
 * PackageManager which apps have a launcher icon, which is public
 * information on the device. Launching an app is what the user asked for by
 * naming it — the permission model stays in the web app, where every such
 * action is a confirm-tier tool. The manifest carries the Android 11+
 * <queries> entry that makes this list visible at all.
 */
@CapacitorPlugin(name = "Apps")
public class AppsPlugin extends Plugin {

    /** Every app with a launcher icon: the ones a person would recognise. */
    @PluginMethod
    public void listInstalled(PluginCall call) {
        try {
            Intent main = new Intent(Intent.ACTION_MAIN, null);
            main.addCategory(Intent.CATEGORY_LAUNCHER);
            PackageManager pm = getContext().getPackageManager();
            List<ResolveInfo> found = pm.queryIntentActivities(main, 0);

            // one row per app, not per activity: some apps publish several
            java.util.LinkedHashMap<String, String> byPackage = new java.util.LinkedHashMap<>();
            for (ResolveInfo r : found) {
                if (r.activityInfo == null) continue;
                String pkg = r.activityInfo.packageName;
                if (pkg == null || pkg.equals(getContext().getPackageName())) continue;   // not Aevion itself
                CharSequence label = r.loadLabel(pm);
                String name = label == null ? pkg : label.toString().trim();
                if (name.isEmpty()) name = pkg;
                if (!byPackage.containsKey(pkg)) byPackage.put(pkg, name);
            }

            java.util.ArrayList<String[]> rows = new java.util.ArrayList<>();
            for (java.util.Map.Entry<String, String> e : byPackage.entrySet()) {
                rows.add(new String[] { e.getValue(), e.getKey() });
            }
            Collections.sort(rows, new Comparator<String[]>() {
                @Override public int compare(String[] a, String[] b) {
                    return a[0].compareToIgnoreCase(b[0]);
                }
            });

            JSArray apps = new JSArray();
            for (String[] row : rows) {
                JSObject o = new JSObject();
                o.put("label", row[0]);
                o.put("package", row[1]);
                apps.put(o);
            }
            JSObject ret = new JSObject();
            ret.put("apps", apps);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("The app list could not be read: " + e.getMessage());
        }
    }

    /** Start an app by package name. Answers whether it really started. */
    @PluginMethod
    public void open(PluginCall call) {
        String pkg = call.getString("package");
        if (pkg == null || pkg.trim().isEmpty()) {
            JSObject no = new JSObject();
            no.put("opened", false);
            no.put("why", "No app was named.");
            call.resolve(no);
            return;
        }
        pkg = pkg.trim();
        try {
            Intent launch = getContext().getPackageManager().getLaunchIntentForPackage(pkg);
            if (launch == null) {
                JSObject no = new JSObject();
                no.put("opened", false);
                no.put("why", "Android has no app installed with the package " + pkg + ".");
                call.resolve(no);
                return;
            }
            launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(launch);
            JSObject yes = new JSObject();
            yes.put("opened", true);
            yes.put("package", pkg);
            call.resolve(yes);
        } catch (Exception e) {
            JSObject no = new JSObject();
            no.put("opened", false);
            no.put("why", "Android would not start " + pkg + " (" + e.getMessage() + ").");
            call.resolve(no);
        }
    }
}
