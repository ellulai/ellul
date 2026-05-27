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

    @Volatile
    private var activeUpdateManager: UpdateManager? = null

    @Command
    fun startWorkspace(invoke: Invoke) {
        try {
            val setupManager = SetupManager(activity)
            if (!setupManager.isSetupComplete()) {
                android.util.Log.w("ProotPlugin", "startWorkspace: setup not complete")
                invoke.reject("Setup not complete")
                return
            }

            android.util.Log.i("ProotPlugin", "startWorkspace: launching ProotService")
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
            android.util.Log.e("ProotPlugin", "startWorkspace: failed", e)
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

    private val cookieJar = java.util.concurrent.ConcurrentHashMap<String, String>()

    init {
        java.net.CookieHandler.setDefault(null)
    }

    private fun parseSetCookies(headers: Map<String, List<String>>?) {
        headers?.entries
            ?.filter { it.key?.equals("Set-Cookie", ignoreCase = true) == true }
            ?.flatMap { it.value }
            ?.forEach { header ->
                val eqIdx = header.indexOf('=')
                if (eqIdx <= 0) return@forEach
                val name = header.substring(0, eqIdx).trim()
                val rest = header.substring(eqIdx + 1)
                val semiIdx = rest.indexOf(';')
                val value = (if (semiIdx >= 0) rest.substring(0, semiIdx) else rest).trim()
                if (value.isEmpty()) {
                    cookieJar.remove(name)
                } else {
                    cookieJar[name] = value
                }
            }
    }

    private fun buildCookieHeader(): String? {
        if (cookieJar.isEmpty()) return null
        return cookieJar.entries.joinToString("; ") { "${it.key}=${it.value}" }
    }

    @Command
    fun prootFetch(invoke: Invoke) {
        Thread({
            try {
                val args = invoke.getArgs()
                val method = args.getString("method", "GET") ?: "GET"
                val path = args.getString("path", "/") ?: "/"
                val body = if (args.isNull("body")) null else args.getString("body")
                val port = args.getInteger("port", 8443)

                java.net.CookieHandler.setDefault(null)
                val url = java.net.URL("http://127.0.0.1:$port$path")
                val conn = url.openConnection() as java.net.HttpURLConnection
                conn.connectTimeout = 15000
                conn.readTimeout = 30000
                conn.requestMethod = method.uppercase()
                conn.useCaches = false
                conn.setRequestProperty("Accept", "application/json")
                conn.setRequestProperty("Connection", "close")
                val mergedCookies = mutableMapOf<String, String>()
                cookieJar.forEach { (k, v) -> mergedCookies[k] = v }
                try {
                    val cm = android.webkit.CookieManager.getInstance()
                    for (cookieUrl in arrayOf(url.toString(), "http://localhost:$port$path")) {
                        cm.getCookie(cookieUrl)?.split(";")?.forEach { c ->
                            val t = c.trim()
                            val eq = t.indexOf('=')
                            if (eq > 0) mergedCookies[t.substring(0, eq).trim()] = t.substring(eq + 1).trim()
                        }
                    }
                } catch (_: Exception) {}
                if (mergedCookies.isNotEmpty()) {
                    conn.setRequestProperty("Cookie", mergedCookies.entries.joinToString("; ") { "${it.key}=${it.value}" })
                }

                if (body != null && method.uppercase() != "GET") {
                    conn.doOutput = true
                    conn.setRequestProperty("Content-Type", "application/json")
                    conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
                }

                val status = conn.responseCode
                parseSetCookies(conn.headerFields)
                try {
                    val cm = android.webkit.CookieManager.getInstance()
                    conn.headerFields?.entries
                        ?.filter { it.key?.equals("Set-Cookie", ignoreCase = true) == true }
                        ?.flatMap { it.value }
                        ?.forEach { h ->
                            for (domain in arrayOf("http://127.0.0.1:$port", "http://localhost:$port")) {
                                cm.setCookie(domain, h)
                            }
                        }
                    cm.flush()
                } catch (_: Exception) {}

                val contentType = conn.contentType ?: "application/json"
                val responseBody = try {
                    (if (status in 200..399) conn.inputStream else conn.errorStream)
                        ?.bufferedReader()?.readText() ?: ""
                } catch (_: Exception) { "" }
                conn.disconnect()

                val bodySnippet = if (responseBody.length > 200) responseBody.substring(0, 200) else responseBody
                android.util.Log.d("proot-fetch", "$method :$port$path → $status $bodySnippet")

                val result = JSObject()
                result.put("status", status)
                result.put("body", responseBody)
                result.put("content_type", contentType)
                invoke.resolve(result)
            } catch (e: Exception) {
                invoke.reject("proot_fetch failed: ${e.message}")
            }
        }, "proot-fetch").start()
    }

    @Command
    fun bootstrapAuth(invoke: Invoke) {
        Thread({
            try {
                java.net.CookieHandler.setDefault(null)
                val base = "http://127.0.0.1:8443"

                val tokenConn = (java.net.URL("$base/_auth/byos/token").openConnection() as java.net.HttpURLConnection).apply {
                    requestMethod = "POST"; connectTimeout = 10_000; readTimeout = 10_000
                    setRequestProperty("Accept", "application/json")
                }
                if (tokenConn.responseCode != 200) {
                    tokenConn.disconnect()
                    invoke.reject("BYOS token failed: HTTP ${tokenConn.responseCode}")
                    return@Thread
                }
                val jwt = org.json.JSONObject(tokenConn.inputStream.bufferedReader().readText()).getString("token")
                tokenConn.disconnect()

                val loginConn = (java.net.URL("$base/_auth/tauri/token-login").openConnection() as java.net.HttpURLConnection).apply {
                    requestMethod = "POST"; connectTimeout = 10_000; readTimeout = 10_000
                    setRequestProperty("Authorization", "Bearer $jwt")
                    setRequestProperty("Content-Type", "application/json")
                }
                if (loginConn.responseCode != 200) {
                    loginConn.disconnect()
                    invoke.reject("Token login failed: HTTP ${loginConn.responseCode}")
                    return@Thread
                }
                val sessionId = org.json.JSONObject(loginConn.inputStream.bufferedReader().readText()).getString("sessionId")
                loginConn.disconnect()
                cookieJar["shield_session"] = sessionId

                val codeConn = (java.net.URL("$base/_auth/code/session").openConnection() as java.net.HttpURLConnection).apply {
                    requestMethod = "POST"; connectTimeout = 10_000; readTimeout = 10_000
                    setRequestProperty("Cookie", "shield_session=$sessionId")
                    setRequestProperty("Content-Type", "application/json")
                    setRequestProperty("Accept", "application/json")
                }
                if (codeConn.responseCode != 200) {
                    codeConn.disconnect()
                    invoke.reject("Code session failed: HTTP ${codeConn.responseCode}")
                    return@Thread
                }
                val codeSessionId = org.json.JSONObject(codeConn.inputStream.bufferedReader().readText()).getString("codeSessionId")
                codeConn.disconnect()
                cookieJar["code_session"] = codeSessionId

                val cm = android.webkit.CookieManager.getInstance()
                cm.setAcceptCookie(true)
                for (domain in arrayOf(base, "http://localhost:8443")) {
                    cm.setCookie(domain, "shield_session=$sessionId; Path=/; SameSite=Lax")
                    cm.setCookie(domain, "code_session=$codeSessionId; Path=/; SameSite=Lax")
                }
                cm.flush()

                val result = JSObject()
                result.put("sessionId", sessionId)
                invoke.resolve(result)
            } catch (e: Exception) {
                invoke.reject("Bootstrap auth failed: ${e.message}")
            }
        }, "proot-bootstrap-auth").start()
    }

    @Command
    fun isSetupComplete(invoke: Invoke) {
        try {
            val setupManager = SetupManager(activity)
            val state = setupManager.getSetupState()
            val complete = setupManager.isSetupComplete()
            android.util.Log.d("ProotPlugin", "isSetupComplete: complete=$complete phase=${state.phase} progress=${state.progress} error=${state.error}")
            val result = JSObject()
            result.put("complete", complete)
            val version = setupManager.getInstalledVersion()
            if (version != null) {
                result.put("version", version)
            } else {
                result.put("version", org.json.JSONObject.NULL)
            }
            result.put("phase", state.phase)
            result.put("progress", state.progress)
            if (state.error != null) {
                result.put("error", state.error)
            } else {
                result.put("error", org.json.JSONObject.NULL)
            }
            invoke.resolve(result)
        } catch (e: Exception) {
            android.util.Log.e("ProotPlugin", "isSetupComplete: failed", e)
            invoke.reject("Failed to check setup status: ${e.message}")
        }
    }

    @Command
    fun resetSetup(invoke: Invoke) {
        try {
            android.util.Log.i("ProotPlugin", "resetSetup: cleaning up failed setup")
            val setupManager = SetupManager(activity)
            setupManager.resetSetup()
            invoke.resolve()
        } catch (e: Exception) {
            android.util.Log.e("ProotPlugin", "resetSetup: failed", e)
            invoke.reject("Failed to reset setup: ${e.message}")
        }
    }

    @Command
    fun setupRootfs(invoke: Invoke) {
        android.util.Log.i("ProotPlugin", "setupRootfs: starting setup thread")
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
                android.util.Log.i("ProotPlugin", "setupRootfs: setup complete, resolving invoke")
                invoke.resolve()
            } catch (e: Exception) {
                android.util.Log.e("ProotPlugin", "setupRootfs: setup failed", e)
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
        Thread({
            try {
                val token = securePrefs.getString("ellul_auth_token", null)
                if (token.isNullOrEmpty()) {
                    invoke.reject("no_auth_token")
                    return@Thread
                }

                if (!ProotService.isRunning) {
                    invoke.reject("engine_not_running")
                    return@Thread
                }

                val args = invoke.parseArgs(JSObject::class.java)
                val subdomain = args?.getString("subdomain")
                    ?: tunnelPrefs.getString("subdomain", null)

                if (subdomain != null) {
                    tunnelPrefs.edit().putString("subdomain", subdomain).apply()
                }

                val params = org.json.JSONObject().apply {
                    put("token", token)
                    if (subdomain != null) put("subdomain", subdomain)
                }
                val response = EngineRpc.call(rootfsDir, "tunnel.start", params)

                val result = JSObject()
                for (key in response.keys()) {
                    result.put(key, response.get(key))
                }
                invoke.resolve(result)
            } catch (e: Exception) {
                invoke.reject("Failed to start tunnel: ${e.message}")
            }
        }, "ellul-tunnel-start").start()
    }

    @Command
    fun tunnelStop(invoke: Invoke) {
        Thread({
            try {
                EngineRpc.call(rootfsDir, "tunnel.stop")
                invoke.resolve()
            } catch (e: Exception) {
                invoke.reject("Failed to stop tunnel: ${e.message}")
            }
        }, "ellul-tunnel-stop").start()
    }

    @Command
    fun tunnelStatus(invoke: Invoke) {
        Thread({
            try {
                val statusFile = File(rootfsDir, "tmp/ellul-tunnel-status.json")
                if (!statusFile.exists()) {
                    val result = JSObject().apply {
                        put("running", false)
                        put("connected", false)
                        put("subdomain", org.json.JSONObject.NULL)
                        put("url", org.json.JSONObject.NULL)
                        put("stats", org.json.JSONObject.NULL)
                        put("error", org.json.JSONObject.NULL)
                    }
                    invoke.resolve(result)
                    return@Thread
                }

                val raw = statusFile.readText().trim()
                val data = org.json.JSONObject(raw)
                val result = JSObject()

                if (data.optBoolean("needsToken", false)) {
                    result.put("running", false)
                    result.put("connected", false)
                    result.put("subdomain", data.optString("subdomain", "") ?: org.json.JSONObject.NULL)
                    result.put("url", org.json.JSONObject.NULL)
                    result.put("stats", org.json.JSONObject.NULL)
                    result.put("error", "needs_token")
                    invoke.resolve(result)
                    return@Thread
                }

                if (data.has("error")) {
                    result.put("running", true)
                    result.put("connected", false)
                    result.put("subdomain", org.json.JSONObject.NULL)
                    result.put("url", org.json.JSONObject.NULL)
                    result.put("stats", org.json.JSONObject.NULL)
                    result.put("error", data.getString("error"))
                    invoke.resolve(result)
                    return@Thread
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
                result.put("error", if (stale) "status_stale" else org.json.JSONObject.NULL)

                invoke.resolve(result)
            } catch (e: Exception) {
                invoke.reject("Failed to get tunnel status: ${e.message}")
            }
        }, "ellul-tunnel-status").start()
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
                put("subdomain", tunnelPrefs.getString("subdomain", null) ?: org.json.JSONObject.NULL)
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

        val configFile = File(rootfsDir, "root/ellul-vault/etc/ellul/tunnel-config.json")
        if (enabled) {
            val subdomain = tunnelPrefs.getString("subdomain", null)
            configFile.parentFile?.mkdirs()
            val config = org.json.JSONObject().apply {
                put("autoExpose", true)
                if (subdomain != null) put("subdomain", subdomain)
            }
            configFile.writeText(config.toString())
        } else {
            if (configFile.exists()) configFile.delete()
        }

        invoke.resolve()
    }

    @Command
    fun updateCheck(invoke: Invoke) {
        Thread({
            try {
                val updateMgr = UpdateManager(activity)
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
            val updateMgr = UpdateManager(activity)
            activeUpdateManager = updateMgr
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

                updateMgr.prepare(info) { progress ->
                    val payload = JSObject().apply {
                        put("stage", progress.stage.name)
                        put("percent", progress.percent)
                        put("bytesProcessed", progress.bytesProcessed)
                        put("bytesTotal", progress.bytesTotal)
                    }
                    trigger("update-progress", payload)
                }

                emitProgress(UpdateStage.STOPPING, 0)
                val wasRunning = ProotService.isRunning
                if (wasRunning) {
                    activity.startService(
                        Intent(activity, ProotService::class.java).apply {
                            action = ProotService.ACTION_STOP
                        }
                    )
                    var waitMs = 0
                    while (ProotService.isRunning && waitMs < 30_000) {
                        Thread.sleep(500)
                        waitMs += 500
                    }
                    if (ProotService.isRunning) {
                        throw UpdateException("Workspace did not stop in time", UpdateStage.STOPPING)
                    }
                }

                emitProgress(UpdateStage.SWAPPING, 0)
                updateMgr.swap()

                emitProgress(UpdateStage.STARTING, 0)
                val startIntent = Intent(activity, ProotService::class.java).apply {
                    action = ProotService.ACTION_START
                }
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    activity.startForegroundService(startIntent)
                } else {
                    activity.startService(startIntent)
                }

                emitProgress(UpdateStage.HEALTH_CHECK, 0)
                var healthWaitMs = 0
                var allHealthy = false
                while (healthWaitMs < 120_000 && !allHealthy) {
                    Thread.sleep(2_000)
                    healthWaitMs += 2_000
                    if (!ProotService.isRunning) continue
                    val statuses = ProotService.serviceStatuses
                    allHealthy = statuses.isNotEmpty() && statuses.all { it.healthy }
                    val pct = if (allHealthy) 100 else (healthWaitMs * 100 / 120_000).coerceIn(0, 99)
                    emitProgress(UpdateStage.HEALTH_CHECK, pct)
                }

                if (allHealthy) {
                    updateMgr.confirmUpdate()
                    updateMgr.cleanup()
                    emitProgress(UpdateStage.COMPLETE, 100)
                    invoke.resolve()
                } else {
                    emitProgress(UpdateStage.ROLLING_BACK, 0)
                    activity.startService(
                        Intent(activity, ProotService::class.java).apply {
                            action = ProotService.ACTION_STOP
                        }
                    )
                    var stopWait = 0
                    while (ProotService.isRunning && stopWait < 30_000) {
                        Thread.sleep(500)
                        stopWait += 500
                    }
                    updateMgr.rollback()

                    val restartIntent = Intent(activity, ProotService::class.java).apply {
                        action = ProotService.ACTION_START
                    }
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        activity.startForegroundService(restartIntent)
                    } else {
                        activity.startService(restartIntent)
                    }
                    invoke.reject("Update failed health check — rolled back to previous version")
                }
            } catch (e: UpdateException) {
                emitProgress(e.stage ?: UpdateStage.FAILED, 0)
                invoke.reject(e.message ?: "Update failed")
            } catch (e: Exception) {
                emitProgress(UpdateStage.FAILED, 0)
                invoke.reject("Update failed: ${e.message}")
            } finally {
                activeUpdateManager = null
            }
        }, "ellul-update-apply").start()
    }

    @Command
    fun updateCancel(invoke: Invoke) {
        try {
            activeUpdateManager?.cancelUpdate()
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject("Failed to cancel update: ${e.message}")
        }
    }

    private fun emitProgress(stage: UpdateStage, percent: Int) {
        trigger("update-progress", JSObject().apply {
            put("stage", stage.name)
            put("percent", percent)
            put("bytesProcessed", 0)
            put("bytesTotal", 0)
        })
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

}
