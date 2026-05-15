package ai.ellul.plugins.proot

import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File

@TauriPlugin
class ProotPlugin(private val activity: android.app.Activity) : Plugin(activity) {

    private val securePrefs: SharedPreferences by lazy {
        val spec = KeyGenParameterSpec.Builder(
            MasterKey.DEFAULT_MASTER_KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build()

        val masterKey = MasterKey.Builder(activity)
            .setKeyGenParameterSpec(spec)
            .build()

        EncryptedSharedPreferences.create(
            activity,
            "ai.ellul.proot.secure",
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    }

    private val tunnelPrefs: SharedPreferences by lazy {
        activity.getSharedPreferences("ai.ellul.proot.tunnel", Context.MODE_PRIVATE)
    }

    private val rootfsDir: File
        get() = File(activity.filesDir, "rootfs")

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
        Thread({
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
        }, "ellul-setup").start()
    }

    @Command
    fun tunnelStart(invoke: Invoke) {
        try {
            val token = securePrefs.getString("ellul_auth_token", null)
            if (token.isNullOrEmpty()) {
                invoke.reject("no_auth_token")
                return
            }

            if (!ProotService.isRunning) {
                invoke.reject("engine_not_running")
                return
            }

            val args = invoke.parseArgs(JSObject::class.java)
            val subdomain = args?.getString("subdomain")
                ?: tunnelPrefs.getString("subdomain", null)

            if (subdomain != null) {
                tunnelPrefs.edit().putString("subdomain", subdomain).apply()
            }

            val cmdFile = File(rootfsDir, "tmp/ellul-tunnel-cmd")
            val cmd = org.json.JSONObject().apply {
                put("cmd", "tunnel_start")
                put("token", token)
                if (subdomain != null) put("subdomain", subdomain)
            }
            cmdFile.parentFile?.mkdirs()
            cmdFile.writeText(cmd.toString())

            val result = waitForTunnelResult()
            invoke.resolve(result)
        } catch (e: Exception) {
            invoke.reject("Failed to start tunnel: ${e.message}")
        }
    }

    @Command
    fun tunnelStop(invoke: Invoke) {
        try {
            val cmdFile = File(rootfsDir, "tmp/ellul-tunnel-cmd")
            val cmd = org.json.JSONObject().apply {
                put("cmd", "tunnel_stop")
            }
            cmdFile.parentFile?.mkdirs()
            cmdFile.writeText(cmd.toString())

            waitForTunnelResult()
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject("Failed to stop tunnel: ${e.message}")
        }
    }

    @Command
    fun tunnelStatus(invoke: Invoke) {
        try {
            val statusFile = File(rootfsDir, "tmp/ellul-tunnel-status.json")
            if (!statusFile.exists()) {
                val result = JSObject().apply {
                    put("running", false)
                    put("connected", false)
                    put("subdomain", JSObject.NULL)
                    put("url", JSObject.NULL)
                    put("stats", JSObject.NULL)
                    put("error", JSObject.NULL)
                }
                invoke.resolve(result)
                return
            }

            val raw = statusFile.readText().trim()
            val data = org.json.JSONObject(raw)
            val result = JSObject()

            if (data.has("error")) {
                result.put("running", true)
                result.put("connected", false)
                result.put("subdomain", JSObject.NULL)
                result.put("url", JSObject.NULL)
                result.put("stats", JSObject.NULL)
                result.put("error", data.getString("error"))
                invoke.resolve(result)
                return
            }

            val ts = data.optLong("ts", 0)
            val stale = ts > 0 && System.currentTimeMillis() - ts > 30_000

            result.put("running", true)
            result.put("connected", !stale && data.optBoolean("connected", false))
            result.put("subdomain", data.optString("subdomain", ""))
            result.put("url", data.optString("url", ""))

            val stats = JSObject().apply {
                put("requests", data.optLong("requests", 0))
                put("bytesUp", data.optLong("bytesUp", 0))
                put("bytesDown", data.optLong("bytesDown", 0))
                put("uptime", data.optLong("uptime", 0))
            }
            result.put("stats", stats)
            result.put("error", if (stale) "status_stale" else JSObject.NULL)

            invoke.resolve(result)
        } catch (e: Exception) {
            invoke.reject("Failed to get tunnel status: ${e.message}")
        }
    }

    @Command
    fun tunnelSetAuth(invoke: Invoke) {
        val args = invoke.parseArgs(JSObject::class.java)
        val token = args?.getString("token")
        if (token.isNullOrEmpty()) {
            invoke.reject("Missing token argument")
            return
        }
        try {
            securePrefs.edit().putString("ellul_auth_token", token).apply()
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject("Failed to store token: ${e.message}")
        }
    }

    @Command
    fun tunnelSetSubdomain(invoke: Invoke) {
        val args = invoke.parseArgs(JSObject::class.java)
        val subdomain = args?.getString("subdomain") ?: ""
        tunnelPrefs.edit().putString("subdomain", subdomain).apply()
        invoke.resolve()
    }

    @Command
    fun tunnelGetConfig(invoke: Invoke) {
        try {
            val result = JSObject().apply {
                put("hasToken", securePrefs.getString("ellul_auth_token", null) != null)
                put("subdomain", tunnelPrefs.getString("subdomain", null) ?: JSObject.NULL)
                put("autoExpose", tunnelPrefs.getBoolean("autoExpose", false))
            }
            invoke.resolve(result)
        } catch (e: Exception) {
            invoke.reject("Failed to get tunnel config: ${e.message}")
        }
    }

    @Command
    fun tunnelSetAutoExpose(invoke: Invoke) {
        val args = invoke.parseArgs(JSObject::class.java)
        val enabled = args?.getBoolean("enabled") ?: false
        tunnelPrefs.edit().putBoolean("autoExpose", enabled).apply()

        if (enabled) {
            val token = securePrefs.getString("ellul_auth_token", null)
            val subdomain = tunnelPrefs.getString("subdomain", null)
            if (token != null) {
                val configFile = File(rootfsDir, "root/ellul-vault/etc/ellul/tunnel-config.json")
                configFile.parentFile?.mkdirs()
                val config = org.json.JSONObject().apply {
                    put("autoExpose", true)
                    put("token", token)
                    if (subdomain != null) put("subdomain", subdomain)
                }
                configFile.writeText(config.toString())
            }
        } else {
            val configFile = File(rootfsDir, "root/ellul-vault/etc/ellul/tunnel-config.json")
            if (configFile.exists()) configFile.delete()
        }

        invoke.resolve()
    }

    @Command
    fun updateCheck(invoke: Invoke) {
        Thread({
            try {
                val mgr = ProotManager(activity)
                val updateMgr = UpdateManager(activity, mgr)
                val info = updateMgr.forceCheck()
                if (info != null) {
                    val result = JSObject().apply {
                        put("available", true)
                        put("version", info.version)
                        put("sha256", info.sha256)
                        put("url", info.url)
                        put("size", info.size)
                        put("changelog", info.changelog)
                        put("currentVersion", updateMgr.getCurrentVersion() ?: "")
                    }
                    invoke.resolve(result)
                } else {
                    val result = JSObject().apply {
                        put("available", false)
                        put("currentVersion", updateMgr.getCurrentVersion() ?: "")
                    }
                    invoke.resolve(result)
                }
            } catch (e: Exception) {
                invoke.reject("Update check failed: ${e.message}")
            }
        }, "ellul-update-check").start()
    }

    @Command
    fun updateApply(invoke: Invoke) {
        Thread({
            try {
                val args = invoke.parseArgs(JSObject::class.java)
                val version = args?.getString("version")
                    ?: run { invoke.reject("Missing version"); return@Thread }
                val sha256 = args.getString("sha256")
                    ?: run { invoke.reject("Missing sha256"); return@Thread }
                val url = args.getString("url")
                    ?: run { invoke.reject("Missing url"); return@Thread }
                val size = args.optLong("size", 0L)
                val changelog = args.optString("changelog", "")

                val info = UpdateInfo(
                    version = version,
                    sha256 = sha256,
                    url = url,
                    size = size,
                    changelog = changelog,
                )

                val mgr = ProotManager(activity)
                val updateMgr = UpdateManager(activity, mgr)
                updateMgr.applyUpdate(info) { progress ->
                    val payload = JSObject().apply {
                        put("stage", progress.stage.name)
                        put("percent", progress.percent)
                        put("bytesProcessed", progress.bytesProcessed)
                        put("bytesTotal", progress.bytesTotal)
                    }
                    trigger("update-progress", payload)
                }
                invoke.resolve()
            } catch (e: UpdateException) {
                val payload = JSObject().apply {
                    put("stage", (e.stage ?: UpdateStage.FAILED).name)
                    put("percent", 0)
                    put("bytesProcessed", 0)
                    put("bytesTotal", 0)
                }
                trigger("update-progress", payload)
                invoke.reject(e.message ?: "Update failed")
            } catch (e: Exception) {
                invoke.reject("Update failed: ${e.message}")
            }
        }, "ellul-update-apply").start()
    }

    @Command
    fun migrationExportFile(invoke: Invoke) {
        try {
            val exportFile = File(rootfsDir, "tmp/ellul-migration-export.ellul")
            if (!exportFile.exists()) {
                invoke.reject("No export file found. Run export from workspace settings first.")
                return
            }

            val externalDir = activity.getExternalFilesDir(null)
                ?: run { invoke.reject("External storage not available"); return }
            val destFile = File(externalDir, "ellul-workspace-export.ellul")
            exportFile.copyTo(destFile, overwrite = true)

            val result = JSObject().apply {
                put("path", destFile.absolutePath)
                put("size", destFile.length())
            }
            invoke.resolve(result)
        } catch (e: Exception) {
            invoke.reject("Failed to export migration file: ${e.message}")
        }
    }

    @Command
    fun updateGetSettings(invoke: Invoke) {
        try {
            val prefs = activity.getSharedPreferences("proot_update", Context.MODE_PRIVATE)
            val result = JSObject().apply {
                put("autoUpdateServices", prefs.getBoolean("auto_update_services", true))
                put("autoUpdateRuntime", prefs.getBoolean("auto_update_runtime", false))
                put("allowMeteredUpdate", prefs.getBoolean("allow_metered_update", false))
            }
            invoke.resolve(result)
        } catch (e: Exception) {
            invoke.reject("Failed to get update settings: ${e.message}")
        }
    }

    @Command
    fun updateSetSettings(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(JSObject::class.java) ?: JSObject()
            val prefs = activity.getSharedPreferences("proot_update", Context.MODE_PRIVATE)
            val editor = prefs.edit()

            if (args.has("autoUpdateServices")) {
                editor.putBoolean("auto_update_services", args.getBoolean("autoUpdateServices"))
            }
            if (args.has("autoUpdateRuntime")) {
                editor.putBoolean("auto_update_runtime", args.getBoolean("autoUpdateRuntime"))
            }
            if (args.has("allowMeteredUpdate")) {
                editor.putBoolean("allow_metered_update", args.getBoolean("allowMeteredUpdate"))
            }
            editor.apply()
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject("Failed to update settings: ${e.message}")
        }
    }

    private fun waitForTunnelResult(): JSObject {
        val resultFile = File(rootfsDir, "tmp/ellul-tunnel-result")
        val deadline = System.currentTimeMillis() + 5_000
        while (System.currentTimeMillis() < deadline) {
            if (resultFile.exists()) {
                val raw = resultFile.readText().trim()
                resultFile.delete()
                return if (raw.isNotEmpty()) {
                    val json = org.json.JSONObject(raw)
                    val result = JSObject()
                    for (key in json.keys()) {
                        result.put(key, json.get(key))
                    }
                    result
                } else {
                    JSObject().apply { put("ok", true) }
                }
            }
            Thread.sleep(100)
        }
        return JSObject().apply { put("ok", true) }
    }
}
