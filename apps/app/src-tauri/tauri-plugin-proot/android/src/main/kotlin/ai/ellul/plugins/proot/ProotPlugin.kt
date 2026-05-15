package ai.ellul.plugins.proot

import android.content.Intent
import android.os.Build
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@TauriPlugin
class ProotPlugin(private val activity: android.app.Activity) : Plugin(activity) {

    @Command
    fun startWorkspace(invoke: Invoke) {
        try {
            val setupManager = SetupManager(activity)
            if (!setupManager.isSetupComplete()) {
                invoke.reject("Setup not complete")
                return
            }

            val intent = Intent(activity, ProotService::class.java).apply {
                action = ProotService.ACTION_START
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                activity.startForegroundService(intent)
            } else {
                activity.startService(intent)
            }
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject("Failed to start workspace: ${e.message}")
        }
    }

    @Command
    fun stopWorkspace(invoke: Invoke) {
        try {
            val intent = Intent(activity, ProotService::class.java).apply {
                action = ProotService.ACTION_STOP
            }
            activity.startService(intent)
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject("Failed to stop workspace: ${e.message}")
        }
    }

    @Command
    fun getStatus(invoke: Invoke) {
        try {
            val result = JSObject()
            result.put("running", ProotService.isRunning)
            result.put("uptime_secs", ProotService.uptimeSecs)

            val services = org.json.JSONArray()
            for (svc in ProotService.serviceStatuses) {
                val obj = JSObject()
                obj.put("name", svc.name)
                obj.put("healthy", svc.healthy)
                services.put(obj)
            }
            result.put("services", services)

            invoke.resolve(result)
        } catch (e: Exception) {
            invoke.reject("Failed to get status: ${e.message}")
        }
    }

    @Command
    fun isSetupComplete(invoke: Invoke) {
        try {
            val setupManager = SetupManager(activity)
            val result = JSObject()
            result.put("complete", setupManager.isSetupComplete())
            val version = setupManager.getInstalledVersion()
            if (version != null) {
                result.put("version", version)
            } else {
                result.put("version", JSObject.NULL)
            }
            invoke.resolve(result)
        } catch (e: Exception) {
            invoke.reject("Failed to check setup status: ${e.message}")
        }
    }

    @Command
    fun setupRootfs(invoke: Invoke) {
        Thread {
            try {
                val setupManager = SetupManager(activity)
                setupManager.setup { progress ->
                    val payload = JSObject().apply {
                        put("stage", progress.stage.name)
                        put("percent", progress.percent)
                        put("bytesProcessed", progress.bytesProcessed)
                        put("bytesTotal", progress.bytesTotal)
                    }
                    trigger("setup-progress", payload)
                }
                invoke.resolve()
            } catch (e: Exception) {
                val payload = JSObject().apply {
                    put("stage", SetupStage.FAILED.name)
                    put("percent", 0)
                    put("bytesProcessed", 0)
                    put("bytesTotal", 0)
                }
                trigger("setup-progress", payload)
                invoke.reject(e.message ?: "Setup failed")
            }
        }.start()
    }
}
