package ai.ellul.plugins.proot

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import android.util.Log

class PowerController {

    companion object {
        const val TAG = "PowerController"
        private const val WAKE_LOCK_TAG = "ellul:workspace"
        private const val CRITICAL_BATTERY_PCT = 5
        private const val LOW_BATTERY_PCT = 15
    }

    interface BatteryCallback {
        fun onCriticalBattery(level: Int)
        fun onLowBattery(level: Int)
        fun onBatteryOkay()
        fun onPowerConnected()
        fun onPowerDisconnected()
    }

    private var wakeLock: PowerManager.WakeLock? = null
    private var batteryReceiver: BroadcastReceiver? = null
    private var callback: BatteryCallback? = null

    @Volatile
    var wasStoppedForBattery = false
        private set

    @Volatile
    var tunnelStoppedForBattery = false
        private set

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

    fun startBatteryMonitoring(context: Context, callback: BatteryCallback) {
        if (batteryReceiver != null) return
        this.callback = callback

        batteryReceiver = object : BroadcastReceiver() {
            override fun onReceive(ctx: Context, intent: Intent) {
                when (intent.action) {
                    Intent.ACTION_BATTERY_LOW -> handleBatteryLow(ctx)
                    Intent.ACTION_BATTERY_OKAY -> handleBatteryOkay()
                    Intent.ACTION_POWER_CONNECTED -> handlePowerConnected()
                    Intent.ACTION_POWER_DISCONNECTED -> handlePowerDisconnected(ctx)
                }
            }
        }

        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_BATTERY_LOW)
            addAction(Intent.ACTION_BATTERY_OKAY)
            addAction(Intent.ACTION_POWER_CONNECTED)
            addAction(Intent.ACTION_POWER_DISCONNECTED)
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            context.registerReceiver(batteryReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            context.registerReceiver(batteryReceiver, filter)
        }
        Log.i(TAG, "Battery monitoring started")
    }

    fun stopBatteryMonitoring(context: Context) {
        val receiver = batteryReceiver ?: return
        try {
            context.unregisterReceiver(receiver)
        } catch (e: Exception) {
            Log.w(TAG, "Failed to unregister battery receiver: ${e.message}")
        }
        batteryReceiver = null
        callback = null
        Log.i(TAG, "Battery monitoring stopped")
    }

    fun getBatteryLevel(context: Context): Int {
        val bm = context.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
        return bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
    }

    fun isCharging(context: Context): Boolean {
        val bm = context.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
        return bm.isCharging
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

        return pct < CRITICAL_BATTERY_PCT && !charging
    }

    fun clearBatteryFlags() {
        wasStoppedForBattery = false
        tunnelStoppedForBattery = false
    }

    private fun handleBatteryLow(context: Context) {
        val level = getBatteryLevel(context)
        Log.w(TAG, "Battery low: $level%")

        if (level <= CRITICAL_BATTERY_PCT) {
            wasStoppedForBattery = true
            callback?.onCriticalBattery(level)
        } else if (level <= LOW_BATTERY_PCT) {
            tunnelStoppedForBattery = true
            callback?.onLowBattery(level)
        }
    }

    private fun handleBatteryOkay() {
        Log.i(TAG, "Battery okay")
        tunnelStoppedForBattery = false
        callback?.onBatteryOkay()
    }

    private fun handlePowerConnected() {
        Log.i(TAG, "Power connected")
        callback?.onPowerConnected()
    }

    private fun handlePowerDisconnected(context: Context) {
        val level = getBatteryLevel(context)
        Log.i(TAG, "Power disconnected (battery: $level%)")
        callback?.onPowerDisconnected()
    }
}
