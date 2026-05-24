package ai.ellul.plugins.proot

import android.app.Service
import android.content.Intent
import android.os.Binder
import android.os.IBinder
import android.util.Log
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URL
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

class ProotService : Service() {

    companion object {
        const val TAG = "ProotService"
        const val ACTION_START = "ai.ellul.plugins.proot.ACTION_START"
        const val ACTION_STOP = "ai.ellul.plugins.proot.ACTION_STOP"
        const val ACTION_RESTART = "ai.ellul.plugins.proot.ACTION_RESTART"
        private const val MAX_RESTARTS = 5
        private const val RESTART_WINDOW_MS = 5L * 60 * 1000

        @Volatile
        var isRunning = false
            private set

        @Volatile
        var uptimeSecs: Long = 0
            private set

        @Volatile
        var serviceStatuses: List<ServiceStatusData> = emptyList()
            private set

        @Volatile
        var batteryState: BatteryState = BatteryState.NORMAL
            private set
    }

    enum class BatteryState { NORMAL, LOW_TUNNEL_STOPPED, CRITICAL_STOPPED }

    data class ServiceStatusData(val name: String, val healthy: Boolean)

    private val binder = LocalBinder()
    private var manager: ProotManager? = null
    private val startupExecutor = Executors.newSingleThreadExecutor()
    private val healthExecutor = Executors.newSingleThreadScheduledExecutor()
    private var startupFuture: Future<*>? = null
    private var healthFuture: ScheduledFuture<*>? = null
    private var startTime: Long = 0
    private var restartCount = 0
    private var restartWindowStart: Long = 0
    private val powerController = PowerController()
    private var networkReceiver: NetworkChangeReceiver? = null

    inner class LocalBinder : Binder() {
        fun getService(): ProotService = this@ProotService
    }

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        ProotNotification.createChannel(this)
        startForeground(
            ProotNotification.NOTIFICATION_ID,
            ProotNotification.build(this, "Initializing...")
        )

        when (intent?.action) {
            ACTION_STOP -> stopWorkspace()
            ACTION_RESTART -> {
                stopWorkspaceInternal()
                startWorkspace()
            }
            else -> startWorkspace()
        }
        return START_STICKY
    }

    private val batteryCallback = object : PowerController.BatteryCallback {
        override fun onCriticalBattery(level: Int) {
            Log.w(TAG, "Critical battery ($level%) — stopping workspace")
            batteryState = BatteryState.CRITICAL_STOPPED
            ProotNotification.update(
                this@ProotService,
                "Workspace stopped — battery critical ($level%)"
            )
            stopWorkspaceInternal()
        }

        override fun onLowBattery(level: Int) {
            Log.w(TAG, "Low battery ($level%) — stopping tunnel to save power")
            batteryState = BatteryState.LOW_TUNNEL_STOPPED
            stopTunnel("Battery low ($level%)")
            ProotNotification.update(
                this@ProotService,
                "Tunnel stopped — battery low ($level%)"
            )
        }

        override fun onBatteryOkay() {
            if (batteryState == BatteryState.LOW_TUNNEL_STOPPED) {
                batteryState = BatteryState.NORMAL
                ProotNotification.update(this@ProotService, "Workspace running")
            }
        }

        override fun onPowerConnected() {
            if (powerController.wasStoppedForBattery && !isRunning) {
                Log.i(TAG, "Power connected — auto-restarting workspace")
                batteryState = BatteryState.NORMAL
                powerController.clearBatteryFlags()
                startWorkspace()
            } else if (batteryState == BatteryState.LOW_TUNNEL_STOPPED) {
                batteryState = BatteryState.NORMAL
                ProotNotification.update(this@ProotService, "Workspace running")
            }
        }

        override fun onPowerDisconnected() {
            // No action — wait for actual low battery events
        }
    }

    @Synchronized
    private fun startWorkspace() {
        if (isRunning) return

        val setupManager = SetupManager(this)
        if (!setupManager.isSetupComplete()) {
            Log.e(TAG, "Cannot start workspace: setup not complete")
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return
        }

        powerController.init(this)
        try {
            UpdateManager(this).recoverIfNeeded()
        } catch (e: Exception) {
            Log.e(TAG, "Update recovery failed (non-fatal)", e)
        }

        powerController.acquireWakeLock(this)
        powerController.startBatteryMonitoring(this, batteryCallback, startupExecutor)
        startTime = System.currentTimeMillis()

        startupFuture = startupExecutor.submit {
            try {
                val mgr = ProotManager(this)
                mgr.start()

                synchronized(this@ProotService) {
                    if (startupFuture?.isCancelled == true) {
                        mgr.stop()
                        return@submit
                    }
                    manager = mgr
                    isRunning = true
                }

                var attempts = 0
                val maxAttempts = 120
                var allHealthy = false

                while (attempts < maxAttempts && !allHealthy && !Thread.interrupted()) {
                    Thread.sleep(1000)
                    attempts++

                    val statuses = checkHealthSync()
                    serviceStatuses = statuses
                    val healthyCount = statuses.count { it.healthy }

                    ProotNotification.update(
                        this@ProotService,
                        "Starting... ($healthyCount/${statuses.size} services)"
                    )

                    allHealthy = statuses.all { it.healthy }
                }

                if (allHealthy) {
                    ProotNotification.update(this@ProotService, "Workspace running")
                    Log.i(TAG, "All services healthy after $attempts seconds")
                    registerNetworkCallback()
                } else if (!Thread.interrupted()) {
                    val unhealthy = serviceStatuses
                        .filter { !it.healthy }
                        .joinToString(", ") { it.name }
                    ProotNotification.update(
                        this@ProotService,
                        "Workspace started (unhealthy: $unhealthy)"
                    )
                    Log.w(TAG, "Startup timed out — unhealthy: $unhealthy")
                }

                restartCount = 0
                restartWindowStart = System.currentTimeMillis()

                healthFuture = healthExecutor.scheduleAtFixedRate({
                    try {
                        uptimeSecs = (System.currentTimeMillis() - startTime) / 1000
                        serviceStatuses = checkHealthSync()

                        when (powerController.pollBattery(this@ProotService)) {
                            PowerController.BatteryAction.STOP_WORKSPACE -> {
                                Log.w(TAG, "Health loop: critical battery — stopping")
                                batteryState = BatteryState.CRITICAL_STOPPED
                                ProotNotification.update(
                                    this@ProotService,
                                    "Workspace stopped — battery critical"
                                )
                                stopWorkspaceInternal()
                                healthFuture?.cancel(false)
                                return@scheduleAtFixedRate
                            }
                            PowerController.BatteryAction.STOP_TUNNEL -> {
                                if (batteryState == BatteryState.NORMAL) {
                                    val level = powerController.getBatteryLevel(this@ProotService)
                                    batteryState = BatteryState.LOW_TUNNEL_STOPPED
                                    stopTunnel("Battery low ($level%)")
                                    ProotNotification.update(
                                        this@ProotService,
                                        "Tunnel stopped — battery low ($level%)"
                                    )
                                }
                            }
                            PowerController.BatteryAction.NONE -> {}
                        }

                        val mgr = manager
                        if (mgr != null && !mgr.isRunning()) {
                            val now = System.currentTimeMillis()
                            if (now - restartWindowStart > RESTART_WINDOW_MS) {
                                restartCount = 0
                                restartWindowStart = now
                            }

                            if (restartCount >= MAX_RESTARTS) {
                                Log.e(TAG, "proot exceeded $MAX_RESTARTS restarts in ${RESTART_WINDOW_MS / 1000}s — stopped")
                                ProotNotification.update(
                                    this@ProotService,
                                    "Workspace crashed — tap to restart"
                                )
                                healthFuture?.cancel(false)
                                return@scheduleAtFixedRate
                            }

                            restartCount++
                            val backoffMs = minOf(1000L * (1L shl (restartCount - 1)), 30_000L)
                            Log.w(TAG, "proot died — restart $restartCount/$MAX_RESTARTS (backoff ${backoffMs}ms)")
                            ProotNotification.update(
                                this@ProotService,
                                "Restarting workspace ($restartCount/$MAX_RESTARTS)..."
                            )
                            Thread.sleep(backoffMs)
                            mgr.start()
                        }
                    } catch (e: Exception) {
                        Log.e(TAG, "Health loop error", e)
                    }
                }, 10, 10, TimeUnit.SECONDS)
            } catch (_: InterruptedException) {
                Log.i(TAG, "Startup interrupted")
            } catch (e: Exception) {
                Log.e(TAG, "Failed to start workspace", e)
                ProotNotification.update(
                    this@ProotService,
                    "Workspace failed: ${e.message}"
                )
                synchronized(this@ProotService) {
                    isRunning = false
                    manager?.stop()
                    manager = null
                }
                powerController.releaseWakeLock()
            }
        }
    }

    @Synchronized
    fun stopWorkspace() {
        stopWorkspaceInternal()
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    @Synchronized
    private fun stopWorkspaceInternal() {
        unregisterNetworkCallback()
        powerController.stopBatteryMonitoring(this)

        startupFuture?.cancel(true)
        startupFuture = null

        healthFuture?.cancel(false)
        healthFuture = null

        manager?.stop()
        manager = null

        isRunning = false
        uptimeSecs = 0
        serviceStatuses = emptyList()

        powerController.releaseWakeLock()
    }

    private fun stopTunnel(reason: String) {
        val rootfsDir = java.io.File(filesDir, "rootfs")
        val err = EngineRpc.callBestEffort(rootfsDir, "tunnel.stop")
        if (err != null) {
            Log.w(TAG, "Failed to stop tunnel ($reason): ${err.message}")
            ProotNotification.update(this, "Tunnel stop failed — ${err.message}")
        } else {
            Log.i(TAG, "Stopped tunnel: $reason")
        }
    }

    private fun checkHealthSync(): List<ServiceStatusData> {
        data class Svc(val name: String, val port: Int, val httpPath: String?)

        val services = listOf(
            Svc("sovereign-shield", 3005, "/health"),
            Svc("file-api", 3002, "/health"),
            Svc("agent-bridge", 7700, null),
            Svc("caddy", 8443, null),
        )

        return services.map { svc ->
            val healthy = try {
                if (svc.httpPath != null) {
                    checkHttpHealth(svc.port, svc.httpPath)
                } else {
                    checkTcpHealth(svc.port)
                }
            } catch (_: Exception) {
                false
            }
            ServiceStatusData(svc.name, healthy)
        }
    }

    private fun checkTcpHealth(port: Int): Boolean {
        return try {
            Socket().use { sock ->
                sock.connect(InetSocketAddress("127.0.0.1", port), 3000)
            }
            true
        } catch (_: Exception) {
            false
        }
    }

    private fun checkHttpHealth(port: Int, path: String): Boolean {
        var conn: HttpURLConnection? = null
        return try {
            conn = URL("http://127.0.0.1:$port$path").openConnection() as HttpURLConnection
            conn.connectTimeout = 3000
            conn.readTimeout = 3000
            conn.requestMethod = "GET"
            conn.responseCode in 200..499
        } catch (_: Exception) {
            false
        } finally {
            try { conn?.errorStream?.close() } catch (_: Exception) {}
            conn?.disconnect()
        }
    }

    private fun registerNetworkCallback() {
        if (networkReceiver != null) return
        val receiver = NetworkChangeReceiver(this)
        receiver.register { reconnectTunnel() }
        networkReceiver = receiver
    }

    private fun unregisterNetworkCallback() {
        networkReceiver?.unregister()
        networkReceiver = null
    }

    private fun reconnectTunnel() {
        val rootfsDir = java.io.File(filesDir, "rootfs")
        val err = EngineRpc.callBestEffort(rootfsDir, "tunnel.reconnect")
        if (err != null) {
            Log.w(TAG, "Failed to send tunnel reconnect: ${err.message}")
        } else {
            Log.i(TAG, "Sent tunnel reconnect command")
        }
    }

    override fun onDestroy() {
        stopWorkspaceInternal()
        startupExecutor.shutdownNow()
        healthExecutor.shutdownNow()
        super.onDestroy()
    }
}
