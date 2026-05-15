package ai.ellul.plugins.proot

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.BatteryManager
import android.os.PowerManager
import android.provider.Settings
import android.util.Log

class PowerController {

    companion object {
        const val TAG = "PowerController"
        private const val WAKE_LOCK_TAG = "ellul:workspace"
    }

    private var wakeLock: PowerManager.WakeLock? = null

    fun acquireWakeLock(context: Context) {
        if (wakeLock?.isHeld == true) return

        val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
        @Suppress("DEPRECATION")
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKE_LOCK_TAG).apply {
            acquire(24 * 60 * 60 * 1000L)
        }
        Log.i(TAG, "Wake lock acquired")
    }

    fun releaseWakeLock() {
        val lock = wakeLock ?: return
        if (lock.isHeld) {
            lock.release()
            Log.i(TAG, "Wake lock released")
        }
        wakeLock = null
    }

    fun requestBatteryOptimizationExemption(activity: Activity) {
        val pm = activity.getSystemService(Context.POWER_SERVICE) as PowerManager
        if (!pm.isIgnoringBatteryOptimizations(activity.packageName)) {
            val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                data = Uri.parse("package:${activity.packageName}")
            }
            activity.startActivity(intent)
        }
    }

    fun isBatteryLow(context: Context): Boolean {
        val filter = IntentFilter(Intent.ACTION_BATTERY_CHANGED)
        @Suppress("DEPRECATION")
        val status = context.registerReceiver(null, filter) ?: return false

        val level = status.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
        val scale = status.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
        val plugged = status.getIntExtra(BatteryManager.EXTRA_PLUGGED, -1)

        if (level < 0 || scale <= 0) return false

        val pct = level * 100 / scale
        val charging = plugged != 0

        return pct < 5 && !charging
    }
}
