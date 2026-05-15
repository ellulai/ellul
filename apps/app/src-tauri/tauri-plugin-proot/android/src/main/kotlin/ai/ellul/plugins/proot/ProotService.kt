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
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

class ProotService : Service() {

    companion object {
        const val TAG = "ProotService"
        const val ACTION_START = "ai.ellul.plugins.proot.ACTION_START"
        const val ACTION_STOP = "ai.ellul.plugins.proot.ACTION_STOP"
        const val ACTION_RESTART = "ai.ellul.plugins.proot.ACTION_RESTART"

        @Volatile
        var isRunning = false
            private set

        @Volatile
        var uptimeSecs: Long = 0
            private set

        @Volatile
        var serviceStatuses: List<ServiceStatusData> = emptyList()
            private set
    }

    data class ServiceStatusData(val name: String, val healthy: Boolean)

    private val binder = LocalBinder()
    private var manager: ProotManager? = null
    private val executor = Executors.newSingleThreadScheduledExecutor()
    private var healthFuture: ScheduledFuture<*>? = null
    private var startTime: Long = 0
    private val powerController = PowerController()

    inner class LocalBinder : Binder() {
        fun getService(): ProotService = this@ProotService
    }

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> stopWorkspace()
            ACTION_RESTART -> {
                stopWorkspace()
                startWorkspace()
            }
            else -> startWorkspace()
        }
        return START_STICKY
    }

    @Synchronized
    private fun startWorkspace() {
        if (isRunning) return

        ProotNotification.createChannel(this)
        startForeground(
            ProotNotification.NOTIFICATION_ID,
            ProotNotification.build(this, "Starting workspace...")
        )

        powerController.acquireWakeLock(this)
        startTime = System.currentTimeMillis()

        executor.submit {
            try {
                val mgr = ProotManager(this)
                mgr.start()
                manager = mgr
                isRunning = true

                var attempts = 0
                val maxAttempts = 120
                var allHealthy = false

                while (attempts < maxAttempts && !allHealthy) {
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
                } else {
                    val unhealthy = serviceStatuses
                        .filter { !it.healthy }
                        .joinToString(", ") { it.name }
                    ProotNotification.update(
                        this@ProotService,
                        "Workspace started (unhealthy: $unhealthy)"
                    )
                    Log.w(TAG, "Startup timed out — unhealthy: $unhealthy")
                }

                healthFuture = executor.scheduleAtFixedRate({
                    try {
                        uptimeSecs = (System.currentTimeMillis() - startTime) / 1000
                        serviceStatuses = checkHealthSync()

                        if (!mgr.isRunning()) {
                            Log.w(TAG, "proot process died — restarting")
                            ProotNotification.update(
                                this@ProotService,
                                "Restarting workspace..."
                            )
                            mgr.start()
                        }
                    } catch (e: Exception) {
                        Log.e(TAG, "Health loop error", e)
                    }
                }, 10, 10, TimeUnit.SECONDS)
            } catch (e: Exception) {
                Log.e(TAG, "Failed to start workspace", e)
                ProotNotification.update(
                    this@ProotService,
                    "Workspace failed: ${e.message}"
                )
                isRunning = false
            }
        }
    }

    private fun stopWorkspace() {
        healthFuture?.cancel(false)
        healthFuture = null

        manager?.stop()
        manager = null

        isRunning = false
        uptimeSecs = 0
        serviceStatuses = emptyList()

        powerController.releaseWakeLock()
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun checkHealthSync(): List<ServiceStatusData> {
        data class Svc(val name: String, val port: Int, val httpPath: String?)

        val services = listOf(
            Svc("sovereign-shield", 3005, "/_auth/health"),
            Svc("file-api", 3002, "/health"),
            Svc("agent-bridge", 7700, null),
            Svc("caddy", 8443, null),
            Svc("term-proxy", 7701, null),
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
        return try {
            val conn = URL("http://127.0.0.1:$port$path").openConnection() as HttpURLConnection
            conn.connectTimeout = 3000
            conn.readTimeout = 3000
            conn.requestMethod = "GET"
            val code = conn.responseCode
            conn.disconnect()
            code == 200
        } catch (_: Exception) {
            false
        }
    }

    override fun onDestroy() {
        stopWorkspace()
        executor.shutdownNow()
        super.onDestroy()
    }
}
