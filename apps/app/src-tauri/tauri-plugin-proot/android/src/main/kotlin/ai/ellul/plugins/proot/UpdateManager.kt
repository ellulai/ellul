package ai.ellul.plugins.proot

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.StatFs
import android.provider.Settings
import android.util.Log
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream
import com.github.luben.zstd.ZstdInputStream
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicBoolean

data class UpdateInfo(
    val version: String,
    val sha256: String,
    val url: String,
    val size: Long,
    val changelog: String,
    val rolloutPercent: Int = 100,
)

data class UpdateProgress(
    val stage: UpdateStage,
    val percent: Int,
    val bytesProcessed: Long,
    val bytesTotal: Long,
)

enum class UpdateStage {
    CHECKING, DOWNLOADING, VERIFYING, STOPPING, EXTRACTING,
    SWAPPING, STARTING, HEALTH_CHECK, ROLLING_BACK, COMPLETE, FAILED
}

class UpdateException(
    message: String,
    val stage: UpdateStage? = null,
    cause: Throwable? = null,
) : Exception(message, cause)

class UpdateManager(private val context: Context) {

    companion object {
        private const val TAG = "UpdateManager"
        private const val CDN_BASE = "https://cdn.ellul.ai/android"
        private const val BUFFER_SIZE = 128 * 1024
        private const val CONNECT_TIMEOUT = 30_000
        private const val READ_TIMEOUT = 60_000
        private const val MAX_RETRIES = 3
        private const val RETRY_BASE_MS = 1_000L
        private const val RETRY_MAX_MS = 30_000L
        private const val MAX_EXTRACTED_BYTES = 4L * 1024 * 1024 * 1024
        private const val PROGRESS_THROTTLE_MS = 100L
        private const val CHECK_INTERVAL_MS = 24L * 60 * 60 * 1000
        private const val STATE_IDLE = "IDLE"
        private const val STATE_STAGING = "STAGING"
        private const val STATE_SWAPPED = "SWAPPED"
        private const val STATE_VERIFIED = "VERIFIED"
    }

    private val appDir: File = context.filesDir
    private val rootfsDir = File(appDir, "rootfs")
    private val stagingDir = File(appDir, "rootfs-staging")
    private val rollbackDir = File(appDir, "rootfs-rollback")
    private val failedDir = File(appDir, "rootfs-failed")
    private val versionFile = File(appDir, "rootfs-version")
    private val stateFile = File(appDir, "update-state.json")
    private val downloadDir = File(context.cacheDir, "rootfs-update")
    private val prefs = context.getSharedPreferences("proot_update", Context.MODE_PRIVATE)
    private val cancelled = AtomicBoolean(false)

    // ── Public API ──────────────────────────────────────────────────

    fun getCurrentVersion(): String? {
        if (!versionFile.exists()) return null
        return versionFile.readText().trim().ifEmpty { null }
    }

    fun checkForUpdate(): UpdateInfo? {
        val currentVersion = getCurrentVersion() ?: return null
        if (!shouldCheck()) return null
        return doCheck(currentVersion, respectRollout = true)
    }

    fun forceCheck(): UpdateInfo? {
        val currentVersion = getCurrentVersion() ?: return null
        return doCheck(currentVersion, respectRollout = false)
    }

    fun prepare(info: UpdateInfo, onProgress: (UpdateProgress) -> Unit) {
        cancelled.set(false)

        checkCancelled()
        checkStorageSpace(info.size)

        if (!isWifiConnected() && !prefs.getBoolean("allow_metered_update", false)) {
            throw UpdateException(
                "WiFi recommended for rootfs updates. Enable metered updates in settings to proceed.",
                UpdateStage.CHECKING
            )
        }

        onProgress(UpdateProgress(UpdateStage.DOWNLOADING, 0, 0, info.size))
        val archiveFile = downloadWithResume(info, onProgress)

        checkCancelled()
        onProgress(UpdateProgress(UpdateStage.VERIFYING, 0, 0, info.size))
        verifySha256(archiveFile, info.sha256)
        onProgress(UpdateProgress(UpdateStage.VERIFYING, 100, info.size, info.size))

        checkCancelled()
        writeState(STATE_STAGING, info.version)
        cleanDir(stagingDir)
        stagingDir.mkdirs()

        onProgress(UpdateProgress(UpdateStage.EXTRACTING, 0, 0, info.size))
        extractRootfs(archiveFile, stagingDir, onProgress)

        checkCancelled()
        validateStagingIntegrity()
        writeVersionInRootfs(stagingDir, info.version)

        downloadDir.deleteRecursively()
        Log.i(TAG, "Prepare complete for v${info.version}")
    }

    fun swap() {
        cleanDir(failedDir)

        if (rollbackDir.exists()) {
            rollbackDir.deleteRecursively()
        }

        if (!rootfsDir.renameTo(rollbackDir)) {
            throw UpdateException("Failed to move current rootfs to rollback", UpdateStage.SWAPPING)
        }

        if (!stagingDir.renameTo(rootfsDir)) {
            rollbackDir.renameTo(rootfsDir)
            throw UpdateException("Failed to promote staging rootfs", UpdateStage.SWAPPING)
        }

        writeState(STATE_SWAPPED, "")
        writeVersionMarker()
        Log.i(TAG, "Rootfs swap complete")
    }

    fun confirmUpdate() {
        writeState(STATE_VERIFIED, "")
        Log.i(TAG, "Update verified healthy")
    }

    fun rollback() {
        Log.w(TAG, "Rolling back rootfs update")

        if (rootfsDir.exists()) {
            rootfsDir.renameTo(failedDir)
        }

        if (rollbackDir.exists()) {
            if (!rollbackDir.renameTo(rootfsDir)) {
                throw UpdateException("Rollback rename failed", UpdateStage.ROLLING_BACK)
            }
        }

        writeVersionMarker()
        clearState()
        Log.i(TAG, "Rollback complete")
    }

    fun cleanup() {
        rollbackDir.deleteRecursively()
        failedDir.deleteRecursively()
        stagingDir.deleteRecursively()
        downloadDir.deleteRecursively()
        clearState()
        Log.i(TAG, "Update cleanup complete")
    }

    fun cancelUpdate() {
        cancelled.set(true)
    }

    fun recoverIfNeeded() {
        val state = readState()
        if (state == null || state == STATE_IDLE) {
            cleanOrphanedDirs()
            return
        }

        Log.w(TAG, "Recovering from interrupted update (state=$state)")

        when (state) {
            STATE_STAGING -> {
                stagingDir.deleteRecursively()
                downloadDir.deleteRecursively()
                clearState()
                Log.i(TAG, "Cleaned up interrupted staging")
            }
            STATE_SWAPPED -> {
                if (rollbackDir.exists()) {
                    rollback()
                    Log.w(TAG, "Rolled back after crash during unverified update")
                } else {
                    clearState()
                }
            }
            STATE_VERIFIED -> {
                cleanup()
                Log.i(TAG, "Cleaned up after verified update")
            }
            else -> clearState()
        }
    }

    // ── Settings ────────────────────────────────────────────────────

    fun setAutoUpdateServices(enabled: Boolean) {
        prefs.edit().putBoolean("auto_update_services", enabled).apply()
    }

    fun isAutoUpdateServicesEnabled(): Boolean =
        prefs.getBoolean("auto_update_services", true)

    fun setAutoUpdateRuntime(enabled: Boolean) {
        prefs.edit().putBoolean("auto_update_runtime", enabled).apply()
    }

    fun isAutoUpdateRuntimeEnabled(): Boolean =
        prefs.getBoolean("auto_update_runtime", false)

    fun setAllowMeteredUpdate(allowed: Boolean) {
        prefs.edit().putBoolean("allow_metered_update", allowed).apply()
    }

    // ── Manifest fetch + verify ─────────────────────────────────────

    private fun doCheck(currentVersion: String, respectRollout: Boolean): UpdateInfo? {
        val remote = fetchAndVerifyManifest() ?: return null
        prefs.edit().putLong("last_check_ts", System.currentTimeMillis()).apply()

        if (compareVersions(remote.version, currentVersion) <= 0) return null

        if (respectRollout && remote.rolloutPercent < 100) {
            if (!isEligibleForRollout(remote.version, remote.rolloutPercent)) {
                Log.d(TAG, "Device not in rollout bucket for v${remote.version} (${remote.rolloutPercent}%)")
                return null
            }
        }

        return remote
    }

    private fun fetchAndVerifyManifest(): UpdateInfo? {
        var conn: HttpURLConnection? = null
        return try {
            conn = URL("$CDN_BASE/latest.json").openConnection() as HttpURLConnection
            conn.connectTimeout = 15_000
            conn.readTimeout = 15_000
            conn.instanceFollowRedirects = true

            if (conn.responseCode != 200) return null

            val body = conn.inputStream.bufferedReader().readText()
            parseManifest(body)
        } catch (e: Exception) {
            Log.w(TAG, "Failed to fetch manifest: ${e.message}")
            null
        } finally {
            conn?.disconnect()
        }
    }

    private fun parseManifest(json: String): UpdateInfo {
        val obj = JSONObject(json)
        return UpdateInfo(
            version = obj.getString("version"),
            sha256 = obj.getString("sha256"),
            url = obj.getString("url"),
            size = obj.getLong("size"),
            changelog = obj.optString("changelog", ""),
            rolloutPercent = obj.optInt("rolloutPercent", 100),
        )
    }

    // ── Storage ─────────────────────────────────────────────────────

    private fun checkStorageSpace(downloadSize: Long) {
        val needed = downloadSize * 4
        val stat = StatFs(appDir.path)
        val available = stat.availableBytes
        if (available < needed) {
            val needMB = needed / (1024 * 1024)
            val haveMB = available / (1024 * 1024)
            throw UpdateException(
                "Not enough storage. Need ${needMB}MB free, have ${haveMB}MB.",
                UpdateStage.CHECKING
            )
        }
    }

    // ── Download with resume ────────────────────────────────────────

    private fun downloadWithResume(
        info: UpdateInfo,
        onProgress: (UpdateProgress) -> Unit,
    ): File {
        downloadDir.mkdirs()
        val dest = File(downloadDir, "rootfs-${info.version}.tar.zst")

        var lastError: Exception? = null
        for (attempt in 1..MAX_RETRIES) {
            checkCancelled()
            try {
                doDownload(info.url, dest, info.size, onProgress)
                return dest
            } catch (e: Exception) {
                lastError = e
                Log.w(TAG, "Download attempt $attempt/$MAX_RETRIES failed: ${e.message}")
                if (attempt < MAX_RETRIES) {
                    val backoff = minOf(RETRY_BASE_MS * (1L shl (attempt - 1)), RETRY_MAX_MS)
                    Thread.sleep(backoff)
                }
            }
        }

        dest.delete()
        throw UpdateException(
            "Download failed after $MAX_RETRIES attempts: ${lastError?.message}",
            UpdateStage.DOWNLOADING,
            lastError
        )
    }

    private fun doDownload(
        url: String,
        dest: File,
        totalSize: Long,
        onProgress: (UpdateProgress) -> Unit,
    ) {
        val existingBytes = if (dest.exists()) dest.length() else 0L

        val conn = URL(url).openConnection() as HttpURLConnection
        try {
            conn.connectTimeout = CONNECT_TIMEOUT
            conn.readTimeout = READ_TIMEOUT
            conn.instanceFollowRedirects = true

            if (existingBytes > 0) {
                conn.setRequestProperty("Range", "bytes=$existingBytes-")
            }

            val responseCode = conn.responseCode
            val resuming = responseCode == 206 && existingBytes > 0

            if (responseCode != 200 && responseCode != 206) {
                throw UpdateException("Download failed: HTTP $responseCode", UpdateStage.DOWNLOADING)
            }

            if (responseCode == 200 && existingBytes > 0) {
                dest.delete()
            }

            val startOffset = if (resuming) existingBytes else 0L

            conn.inputStream.use { input ->
                RandomAccessFile(dest, "rw").use { raf ->
                    raf.seek(startOffset)
                    val buf = ByteArray(BUFFER_SIZE)
                    var total = startOffset
                    var lastProgressTime = 0L

                    while (true) {
                        checkCancelled()
                        val n = input.read(buf)
                        if (n == -1) break
                        raf.write(buf, 0, n)
                        total += n

                        val now = System.currentTimeMillis()
                        if (now - lastProgressTime >= PROGRESS_THROTTLE_MS) {
                            lastProgressTime = now
                            val pct = if (totalSize > 0) ((total * 100) / totalSize).toInt() else 0
                            onProgress(UpdateProgress(UpdateStage.DOWNLOADING, pct, total, totalSize))
                        }
                    }
                }
            }
        } finally {
            conn.disconnect()
        }
    }

    // ── Verification ────────────────────────────────────────────────

    private fun verifySha256(file: File, expected: String) {
        val digest = MessageDigest.getInstance("SHA-256")
        val buf = ByteArray(BUFFER_SIZE)

        FileInputStream(file).use { fis ->
            while (true) {
                val n = fis.read(buf)
                if (n == -1) break
                digest.update(buf, 0, n)
            }
        }

        val actual = digest.digest().joinToString("") { "%02x".format(it) }
        if (!actual.equals(expected, ignoreCase = true)) {
            file.delete()
            throw UpdateException(
                "Download corrupted — SHA-256 mismatch. Please retry.",
                UpdateStage.VERIFYING
            )
        }
    }

    // ── Extraction ──────────────────────────────────────────────────

    private fun extractRootfs(
        archiveFile: File,
        targetDir: File,
        onProgress: (UpdateProgress) -> Unit,
    ) {
        var extractedBytes = 0L
        val archiveSize = archiveFile.length()
        var lastProgressTime = 0L

        FileInputStream(archiveFile).use { fis ->
            ZstdInputStream(fis).use { zstd ->
                TarArchiveInputStream(zstd).use { tar ->
                    while (true) {
                        val entry = tar.nextEntry ?: break
                        checkCancelled()

                        if (extractedBytes > MAX_EXTRACTED_BYTES) {
                            throw UpdateException("Rootfs extraction exceeded safety limit", UpdateStage.EXTRACTING)
                        }

                        val dest = File(targetDir, entry.name)
                        if (!isPathSafe(targetDir, dest)) continue

                        if (entry.isDirectory) {
                            dest.mkdirs()
                        } else if (entry.isSymbolicLink) {
                            if (!isSymlinkTargetSafe(targetDir, dest, entry.linkName)) {
                                Log.w(TAG, "Rejected unsafe symlink: ${entry.name} -> ${entry.linkName}")
                                continue
                            }
                            val link = java.nio.file.Paths.get(dest.absolutePath)
                            link.parent?.toFile()?.mkdirs()
                            try {
                                java.nio.file.Files.deleteIfExists(link)
                                java.nio.file.Files.createSymbolicLink(link, java.nio.file.Paths.get(entry.linkName))
                            } catch (_: Exception) {}
                        } else {
                            dest.parentFile?.mkdirs()
                            FileOutputStream(dest).use { fos ->
                                val buf = ByteArray(BUFFER_SIZE)
                                while (true) {
                                    val n = tar.read(buf)
                                    if (n == -1) break
                                    fos.write(buf, 0, n)
                                    extractedBytes += n
                                }
                            }

                            val mode = entry.mode
                            if (mode and 0b001_001_001 != 0) {
                                dest.setExecutable(true, false)
                            }
                        }

                        val now = System.currentTimeMillis()
                        if (now - lastProgressTime >= PROGRESS_THROTTLE_MS) {
                            lastProgressTime = now
                            val pct = if (archiveSize > 0) {
                                ((extractedBytes * 30) / (archiveSize * 3) + 70).coerceIn(0, 100).toInt()
                            } else 0
                            onProgress(UpdateProgress(UpdateStage.EXTRACTING, pct, extractedBytes, 0))
                        }
                    }
                }
            }
        }
    }

    private fun isPathSafe(rootfs: File, dest: File): Boolean {
        val canonical = dest.canonicalPath
        return canonical.startsWith(rootfs.canonicalPath + File.separator)
            || canonical == rootfs.canonicalPath
    }

    private fun isSymlinkTargetSafe(rootfs: File, linkFile: File, target: String): Boolean {
        val targetPath = if (target.startsWith("/")) {
            File(rootfs, target)
        } else {
            File(linkFile.parentFile ?: rootfs, target)
        }
        return try {
            val canonical = targetPath.canonicalPath
            canonical.startsWith(rootfs.canonicalPath + File.separator)
                || canonical == rootfs.canonicalPath
        } catch (_: Exception) {
            false
        }
    }

    // ── Staging validation ──────────────────────────────────────────

    private fun validateStagingIntegrity() {
        val required = listOf(
            "usr/local/bin/ellul-engine-android",
            "usr/bin/node",
            "usr/local/bin/caddy",
            "home/dev",
        )

        for (path in required) {
            if (!File(stagingDir, path).exists()) {
                stagingDir.deleteRecursively()
                throw UpdateException(
                    "Extracted rootfs missing required file: $path",
                    UpdateStage.EXTRACTING
                )
            }
        }
    }

    private fun writeVersionInRootfs(dir: File, version: String) {
        File(dir, ".ellul-rootfs-version").writeText(version)
    }

    private fun writeVersionMarker() {
        val version = File(rootfsDir, ".ellul-rootfs-version").let { f ->
            if (f.exists()) f.readText().trim() else return
        }
        val tmp = File(appDir, "rootfs-version.tmp")
        tmp.writeText(version)
        if (!tmp.renameTo(versionFile)) {
            tmp.delete()
        }
    }

    // ── State machine ───────────────────────────────────────────────

    private fun writeState(state: String, version: String) {
        val json = JSONObject().apply {
            put("state", state)
            put("version", version)
            put("timestamp", System.currentTimeMillis())
        }
        stateFile.writeText(json.toString())
    }

    private fun readState(): String? {
        if (!stateFile.exists()) return null
        return try {
            JSONObject(stateFile.readText()).optString("state", null)
        } catch (_: Exception) {
            null
        }
    }

    private fun clearState() {
        stateFile.delete()
    }

    private fun cleanOrphanedDirs() {
        if (stagingDir.exists() && rootfsDir.exists()) {
            stagingDir.deleteRecursively()
        }
        if (rollbackDir.exists() && rootfsDir.exists()) {
            rollbackDir.deleteRecursively()
        }
        if (!rootfsDir.exists() && rollbackDir.exists()) {
            rollbackDir.renameTo(rootfsDir)
        }
        failedDir.deleteRecursively()
    }

    // ── Staged rollout ──────────────────────────────────────────────

    private fun isEligibleForRollout(version: String, rolloutPercent: Int): Boolean {
        if (rolloutPercent >= 100) return true
        if (rolloutPercent <= 0) return false

        val deviceId = Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID) ?: ""
        val input = "$deviceId:$version"
        val hash = MessageDigest.getInstance("SHA-256").digest(input.toByteArray())
        val bucket = ((hash[0].toLong() and 0xFF) * 256 + (hash[1].toLong() and 0xFF)) % 100
        return bucket < rolloutPercent
    }

    // ── Helpers ─────────────────────────────────────────────────────

    private fun shouldCheck(): Boolean {
        val lastCheck = prefs.getLong("last_check_ts", 0)
        if (System.currentTimeMillis() - lastCheck < CHECK_INTERVAL_MS) return false
        return isWifiConnected()
    }

    private fun isWifiConnected(): Boolean {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val net = cm.activeNetwork ?: return false
        val caps = cm.getNetworkCapabilities(net) ?: return false
        return caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
            || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)
    }

    private fun checkCancelled() {
        if (cancelled.get()) throw UpdateException("Update cancelled", UpdateStage.CHECKING)
    }

    private fun cleanDir(dir: File) {
        if (dir.exists()) dir.deleteRecursively()
    }

    private fun compareVersions(a: String, b: String): Int {
        val pa = a.split(".").map { it.toIntOrNull() ?: 0 }
        val pb = b.split(".").map { it.toIntOrNull() ?: 0 }
        val len = maxOf(pa.size, pb.size)
        for (i in 0 until len) {
            val va = pa.getOrElse(i) { 0 }
            val vb = pb.getOrElse(i) { 0 }
            if (va != vb) return va.compareTo(vb)
        }
        return 0
    }
}
