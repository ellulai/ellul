package ai.ellul.plugins.proot

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.SharedPreferences
import android.net.Uri
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import java.util.concurrent.Executor

class PowerController {

    companion object {
        const val TAG = "PowerController"
        private const val WAKE_LOCK_TAG = "ellul:workspace"
        private const val CRITICAL_BATTERY_PCT = 5
        private const val LOW_BATTERY_PCT = 15
        private const val PREFS_NAME = "ai.ellul.proot.power"
    }

    enum class BatteryAction { NONE, STOP_TUNNEL, STOP_WORKSPACE }

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
    private var callbackExecutor: Executor? = null
    private var prefs: SharedPreferences? = null

    var wasStoppedForBattery: Boolean
        get() = prefs?.getBoolean("stopped_for_battery", false) ?: false
        private set(value) {
            prefs?.edit()?.putBoolean("stopped_for_battery", value)?.apply()
        }

    var tunnelStoppedForBattery: Boolean
        get() = prefs?.getBoolean("tunnel_stopped_for_battery", false) ?: false
        private set(value) {
            prefs?.edit()?.putBoolean("tunnel_stopped_for_battery", value)?.apply()
        }

    fun init(context: Context) {
        prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    }

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

    fun requestBatteryOptimizationExemption(activity: android.app.Activity) {
        val pm = activity.getSystemService(Context.POWER_SERVICE) as PowerManager
        if (!pm.isIgnoringBatteryOptimizations(activity.packageName)) {
            val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                data = Uri.parse("package:${activity.packageName}")
            }
            activity.startActivity(intent)
        }
    }

    fun startBatteryMonitoring(context: Context, cb: BatteryCallback, executor: Executor? = null) {
        if (batteryReceiver != null) return
        this.callback = cb
        this.callbackExecutor = executor
        if (prefs == null) init(context)

        batteryReceiver = object : BroadcastReceiver() {
            override fun onReceive(ctx: Context, intent: Intent) {
                val exec = callbackExecutor
                if (exec != null) {
                    exec.execute { dispatchBroadcast(ctx, intent) }
                } else {
                    dispatchBroadcast(ctx, intent)
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
        callbackExecutor = null
        Log.i(TAG, "Battery monitoring stopped")
    }

    fun pollBattery(context: Context): BatteryAction {
        val level = getBatteryLevel(context)
        val charging = isCharging(context)

        if (charging) return BatteryAction.NONE

        if (isPowerSaveMode(context) || level <= CRITICAL_BATTERY_PCT) {
            wasStoppedForBattery = true
            return BatteryAction.STOP_WORKSPACE
        }

        if (level <= LOW_BATTERY_PCT) {
            tunnelStoppedForBattery = true
            return BatteryAction.STOP_TUNNEL
        }

        return BatteryAction.NONE
    }

    fun getBatteryLevel(context: Context): Int {
        val bm = context.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
        return bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
    }

    fun isCharging(context: Context): Boolean {
        val bm = context.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
        return bm.isCharging
    }

    fun isPowerSaveMode(context: Context): Boolean {
        val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
        return pm.isPowerSaveMode
    }

    fun clearBatteryFlags() {
        wasStoppedForBattery = false
        tunnelStoppedForBattery = false
    }

    private fun dispatchBroadcast(context: Context, intent: Intent) {
        when (intent.action) {
            Intent.ACTION_BATTERY_LOW -> handleBatteryLow(context)
            Intent.ACTION_BATTERY_OKAY -> handleBatteryOkay()
            Intent.ACTION_POWER_CONNECTED -> handlePowerConnected()
            Intent.ACTION_POWER_DISCONNECTED -> handlePowerDisconnected(context)
        }
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
