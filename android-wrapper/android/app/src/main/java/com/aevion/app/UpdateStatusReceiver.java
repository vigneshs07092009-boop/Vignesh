package com.aevion.app;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.widget.Toast;

/**
 * Receives Android's status callbacks for an in-place update session and
 * opens the system install dialog (the user-consent step).
 *
 * When the app that started a PackageInstaller session is the app being
 * replaced, the system cannot pop its confirmation dialog on its own — it
 * sends STATUS_PENDING_USER_ACTION to this receiver instead, carrying an
 * intent that IS the dialog. Starting that intent is what shows the
 * "Install this app update?" screen the user approves in. Nothing is
 * installed unless they tap yes there; this receiver has no power to
 * bypass it, by design.
 *
 * Every other status is reported honestly as a toast, including the
 * failure codes — a failed update must never look like a succeeded one.
 */
public class UpdateStatusReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        switch (status) {
            case PackageInstaller.STATUS_PENDING_USER_ACTION: {
                // The dialog intent: start it and Android asks the user.
                Intent confirm = intent.getParcelableExtra(Intent.EXTRA_INTENT);
                if (confirm != null) {
                    confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    try {
                        context.startActivity(confirm);
                    } catch (Exception e) {
                        toast(context, "Could not open the install dialog — try Settings → App updates again.");
                    }
                } else {
                    toast(context, "The installer did not return a confirmation dialog.");
                }
                break;
            }
            case PackageInstaller.STATUS_SUCCESS:
                toast(context, "✅ Aevion updated in place — your data stayed.");
                break;
            case PackageInstaller.STATUS_FAILURE_ABORTED:
                toast(context, "Update cancelled — nothing was changed.");
                break;
            case PackageInstaller.STATUS_FAILURE_BLOCKED:
                toast(context, "The update was blocked by the device (e.g. an admin policy).");
                break;
            case PackageInstaller.STATUS_FAILURE_CONFLICT:
                toast(context, "The update conflicts with another installed package.");
                break;
            case PackageInstaller.STATUS_FAILURE_INCOMPATIBLE:
                toast(context, "The update is not compatible with this device.");
                break;
            case PackageInstaller.STATUS_FAILURE_INVALID:
                toast(context, "The update file was rejected as invalid — it will be re-downloaded.");
                break;
            case PackageInstaller.STATUS_FAILURE_STORAGE:
                toast(context, "Not enough storage to install the update.");
                break;
            default: {
                String msg = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
                toast(context, "Update failed" + (msg == null ? "." : ": " + msg));
                break;
            }
        }
    }

    private static void toast(Context c, String msg) {
        try {
            Toast.makeText(c, msg, Toast.LENGTH_LONG).show();
        } catch (Exception ignore) {
            // a toast must never be the thing that crashes an update
        }
    }
}
