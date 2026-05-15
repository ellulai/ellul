package ai.ellul.plugins.proot

import android.content.Intent
import android.os.Build
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File

@TauriPlugin
class ProotPlugin(private val activity: android.app.Activity) : Plugin(activity) {

    @Command
    fun startWorkspace(invoke: Invoke) {
        try {
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
            val rootfsDir = File(activity.filesDir, "rootfs")
            val versionFile = File(rootfsDir, ".ellul-rootfs-version")

            val result = JSObject()
            result.put("complete", rootfsDir.exists() && versionFile.exists())
            if (versionFile.exists()) {
                result.put("version", versionFile.readText().trim())
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
        try {
            val rootfsDir = File(activity.filesDir, "rootfs")
            if (rootfsDir.exists()) {
                invoke.resolve()
                return
            }
            // Phase 3 implements download/verify/extract; for now report not set up
            invoke.reject("Rootfs not present — download not yet implemented (Phase 3)")
        } catch (e: Exception) {
            invoke.reject("Setup failed: ${e.message}")
        }
    }
}
