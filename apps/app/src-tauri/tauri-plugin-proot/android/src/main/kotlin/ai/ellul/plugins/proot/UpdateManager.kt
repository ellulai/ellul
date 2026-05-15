package ai.ellul.plugins.proot

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.StatFs
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
)

data class UpdateProgress(
    val stage: UpdateStage,
    val percent: Int,
    val bytesProcessed: Long,
    val bytesTotal: Long,
)

enum class UpdateStage {
    CHECKING, DOWNLOADING, VERIFYING, STOPPING, EXTRACTING, STARTING, COMPLETE, FAILED
}

class UpdateException(
    message: String,
    val stage: UpdateStage? = null,
    cause: Throwable? = null,
) : Exception(message, cause)

class UpdateManager(
    private val context: Context,
    private val prootManager: ProotManager,
) {

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

        private val updateRunning = AtomicBoolean(false)
    }

    private val appDir: File = context.filesDir
    private val rootfsDir = File(appDir, "rootfs")
    private val versionFile = File(appDir, "rootfs-version")
    private val downloadDir = File(context.cacheDir, "rootfs-update")
    private val prefs = context.getSharedPreferences("proot_update", Context.MODE_PRIVATE)

    fun getCurrentVersion(): String? {
        if (!versionFile.exists()) return null
        return versionFile.readText().trim().ifEmpty { null }
    }

    fun checkForUpdate(): UpdateInfo? {
        val currentVersion = getCurrentVersion() ?: return null

        if (!shouldCheck()) return null

        val remote = fetchLatestManifest() ?: return null
        prefs.edit().putLong("last_check_ts", System.currentTimeMillis()).apply()

        if (compareVersions(remote.version, currentVersion) > 0) return remote
        return null
    }

    fun forceCheck(): UpdateInfo? {
        val currentVersion = getCurrentVersion() ?: return null
        val remote = fetchLatestManifest() ?: return null
        prefs.edit().putLong("last_check_ts", System.currentTimeMillis()).apply()
        if (compareVersions(remote.version, currentVersion) > 0) return remote
        return null
    }

    fun applyUpdate(info: UpdateInfo, onProgress: (UpdateProgress) -> Unit) {
        if (!updateRunning.compareAndSet(false, true)) {
            throw UpdateException("Update already in progress")
        }

        try {
            onProgress(UpdateProgress(UpdateStage.CHECKING, 0, 0, info.size))

            if (!isWifiConnected() && !prefs.getBoolean("allow_metered_update", false)) {
                throw UpdateException(
                    "WiFi recommended for rootfs updates. Enable metered updates in settings to proceed.",
                    UpdateStage.CHECKING
                )
            }

            checkStorageSpace(info.size)

            onProgress(UpdateProgress(UpdateStage.DOWNLOADING, 0, 0, info.size))
            val archiveFile = downloadWithResume(info, onProgress)

            onProgress(UpdateProgress(UpdateStage.VERIFYING, 0, 0, info.size))
            verifySha256(archiveFile, info.sha256)
            onProgress(UpdateProgress(UpdateStage.VERIFYING, 100, info.size, info.size))

            onProgress(UpdateProgress(UpdateStage.STOPPING, 0, 0, 0))
            prootManager.stop()
            Thread.sleep(2000)
            onProgress(UpdateProgress(UpdateStage.STOPPING, 100, 0, 0))

            onProgress(UpdateProgress(UpdateStage.EXTRACTING, 0, 0, info.size))
            extractRootfs(archiveFile, onProgress)

            writeVersionMarker(info.version)
            downloadDir.deleteRecursively()

            onProgress(UpdateProgress(UpdateStage.STARTING, 0, 0, 0))
            prootManager.start()

            onProgress(UpdateProgress(UpdateStage.COMPLETE, 100, 0, 0))
            Log.i(TAG, "Update to ${info.version} complete")
        } catch (e: UpdateException) {
            throw e
        } catch (e: Exception) {
            throw UpdateException("Update failed: ${e.message}", cause = e)
        } finally {
            updateRunning.set(false)
        }
    }

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

    private fun fetchLatestManifest(): UpdateInfo? {
        var conn: HttpURLConnection? = null
        return try {
            conn = URL("$CDN_BASE/latest.json").openConnection() as HttpURLConnection
            conn.connectTimeout = 15_000
            conn.readTimeout = 15_000
            conn.instanceFollowRedirects = true

            if (conn.responseCode != 200) {
                Log.w(TAG, "Failed to fetch update manifest: HTTP ${conn.responseCode}")
                return null
            }

            val body = conn.inputStream.bufferedReader().readText()
            val json = JSONObject(body)

            UpdateInfo(
                version = json.getString("version"),
                sha256 = json.getString("sha256"),
                url = json.getString("url"),
                size = json.getLong("size"),
                changelog = json.optString("changelog", ""),
            )
        } catch (e: Exception) {
            Log.w(TAG, "Failed to check for updates: ${e.message}")
            null
        } finally {
            conn?.disconnect()
        }
    }

    private fun checkStorageSpace(downloadSize: Long) {
        val needed = downloadSize * 3
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

    private fun downloadWithResume(
        info: UpdateInfo,
        onProgress: (UpdateProgress) -> Unit,
    ): File {
        downloadDir.mkdirs()
        val dest = File(downloadDir, "rootfs-${info.version}.tar.zst")

        var lastError: Exception? = null
        for (attempt in 1..MAX_RETRIES) {
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
                val raf = RandomAccessFile(dest, "rw")
                raf.use {
                    raf.seek(startOffset)
                    val buf = ByteArray(BUFFER_SIZE)
                    var total = startOffset
                    var lastProgressTime = 0L

                    while (true) {
                        val n = input.read(buf)
                        if (n == -1) break
                        raf.write(buf, 0, n)
                        total += n

                        val now = System.currentTimeMillis()
                        if (now - lastProgressTime >= PROGRESS_THROTTLE_MS) {
                            lastProgressTime = now
                            val pct = if (totalSize > 0) ((total * 100) / totalSize).toInt() else 0
                            onProgress(
                                UpdateProgress(UpdateStage.DOWNLOADING, pct, total, totalSize)
                            )
                        }
                    }
                }
            }
        } finally {
            conn.disconnect()
        }
    }

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

    private fun extractRootfs(archiveFile: File, onProgress: (UpdateProgress) -> Unit) {
        if (rootfsDir.exists()) {
            rootfsDir.deleteRecursively()
        }
        rootfsDir.mkdirs()

        var extractedBytes = 0L
        val archiveSize = archiveFile.length()
        var lastProgressTime = 0L

        FileInputStream(archiveFile).use { fis ->
            ZstdInputStream(fis).use { zstd ->
                TarArchiveInputStream(zstd).use { tar ->
                    while (true) {
                        val entry = tar.nextEntry ?: break

                        if (extractedBytes > MAX_EXTRACTED_BYTES) {
                            throw UpdateException(
                                "Rootfs extraction exceeded safety limit",
                                UpdateStage.EXTRACTING
                            )
                        }

                        val dest = File(rootfsDir, entry.name)
                        val canonical = dest.canonicalPath
                        if (!canonical.startsWith(rootfsDir.canonicalPath + File.separator)
                            && canonical != rootfsDir.canonicalPath
                        ) {
                            continue
                        }

                        if (entry.isDirectory) {
                            dest.mkdirs()
                        } else if (entry.isSymbolicLink) {
                            val link = java.nio.file.Paths.get(dest.absolutePath)
                            link.parent?.toFile()?.mkdirs()
                            try {
                                java.nio.file.Files.createSymbolicLink(
                                    link,
                                    java.nio.file.Paths.get(entry.linkName)
                                )
                            } catch (_: Exception) {
                            }
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
                                ((extractedBytes * 30) / (archiveSize * 3) + 70)
                                    .coerceIn(0, 100).toInt()
                            } else 0
                            onProgress(
                                UpdateProgress(UpdateStage.EXTRACTING, pct, extractedBytes, 0)
                            )
                        }
                    }
                }
            }
        }
    }

    private fun writeVersionMarker(version: String) {
        val markerInRootfs = File(rootfsDir, ".ellul-rootfs-version")
        markerInRootfs.writeText(version)

        val tmp = File(appDir, "rootfs-version.tmp")
        tmp.writeText(version)
        if (!tmp.renameTo(versionFile)) {
            tmp.delete()
            throw UpdateException("Failed to write version marker", UpdateStage.EXTRACTING)
        }
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
