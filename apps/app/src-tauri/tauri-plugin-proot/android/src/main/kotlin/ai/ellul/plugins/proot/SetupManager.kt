package ai.ellul.plugins.proot

import android.content.Context
import android.os.Build
import android.os.StatFs
import android.util.Log
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream
import com.github.luben.zstd.ZstdInputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.nio.file.Files
import java.nio.file.Paths
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.concurrent.atomic.AtomicBoolean

data class SetupProgress(
    val stage: SetupStage,
    val percent: Int,
    val bytesProcessed: Long,
    val bytesTotal: Long,
)

enum class SetupStage {
    DOWNLOADING, VERIFYING, EXTRACTING, INITIALIZING, COMPLETE, FAILED
}

class SetupException(
    message: String,
    val stage: SetupStage? = null,
    cause: Throwable? = null,
) : Exception(message, cause)

class SetupManager(private val context: Context) {

    companion object {
        private const val TAG = "SetupManager"
        private const val CDN_BASE = "https://cdn.ellul.ai/android"
        private const val BUFFER_SIZE = 128 * 1024
        private const val CONNECT_TIMEOUT = 30_000
        private const val READ_TIMEOUT = 60_000
        private const val VERSION_CONNECT_TIMEOUT = 15_000
        private const val VERSION_READ_TIMEOUT = 30_000
        private const val MAX_RETRIES = 3
        private const val RETRY_DELAY_MS = 5_000L
        private const val REQUIRED_SPACE_BYTES = 3_221_225_472L
        private const val MAX_PATH_BYTES = 255
        private const val ZSTD_EXPANSION_FACTOR = 3L

        private val setupRunning = AtomicBoolean(false)
    }

    private val appDir: File = context.filesDir
    private val rootfsDir = File(appDir, "rootfs")
    private val vaultDir = File(appDir, "vault")
    private val versionFile = File(appDir, "rootfs-version")
    private val downloadDir = File(appDir, "downloads")

    fun isSetupComplete(): Boolean {
        return rootfsDir.exists()
            && File(rootfsDir, "usr/local/bin/ellul-engine-android").exists()
            && File(rootfsDir, "usr/local/bin/node").exists()
            && versionFile.exists()
            && versionFile.readText().trim().isNotEmpty()
    }

    fun getInstalledVersion(): String? {
        if (!versionFile.exists()) return null
        return versionFile.readText().trim().ifEmpty { null }
    }

    fun setup(onProgress: (SetupProgress) -> Unit) {
        if (!setupRunning.compareAndSet(false, true)) {
            throw SetupException("Setup already in progress")
        }

        try {
            checkDiskSpace()

            val version = fetchLatestVersion()

            if (isSetupComplete() && getInstalledVersion() == version) {
                onProgress(SetupProgress(SetupStage.COMPLETE, 100, 0, 0))
                return
            }

            val archiveFile = downloadRootfs(version, onProgress)
            verifyChecksum(version, archiveFile, onProgress)
            checkDiskSpace()
            extractRootfs(archiveFile, onProgress)
            initializeVault(onProgress)

            versionFile.writeText(version)

            if (downloadDir.exists()) downloadDir.deleteRecursively()

            onProgress(SetupProgress(SetupStage.COMPLETE, 100, 0, 0))
        } catch (e: SetupException) {
            throw e
        } catch (e: Exception) {
            throw SetupException("Setup failed: ${e.message}", cause = e)
        } finally {
            setupRunning.set(false)
        }
    }

    private fun checkDiskSpace() {
        val stat = StatFs(appDir.path)
        val available = stat.availableBytes
        if (available < REQUIRED_SPACE_BYTES) {
            val availableMB = available / (1024 * 1024)
            throw SetupException(
                "Not enough storage. Need 3GB free, have ${availableMB}MB.",
                SetupStage.DOWNLOADING
            )
        }
    }

    private fun fetchLatestVersion(): String {
        val conn = URL("$CDN_BASE/latest-version.txt").openConnection() as HttpURLConnection
        try {
            conn.connectTimeout = VERSION_CONNECT_TIMEOUT
            conn.readTimeout = VERSION_READ_TIMEOUT
            conn.instanceFollowRedirects = true

            if (conn.responseCode != 200) {
                throw SetupException(
                    "Failed to check for updates: HTTP ${conn.responseCode}",
                    SetupStage.DOWNLOADING
                )
            }

            return conn.inputStream.bufferedReader().readText().trim()
        } catch (e: SetupException) {
            throw e
        } catch (e: Exception) {
            throw SetupException(
                "Failed to check for updates: ${e.message}",
                SetupStage.DOWNLOADING,
                e
            )
        } finally {
            conn.disconnect()
        }
    }

    private fun downloadRootfs(
        version: String,
        onProgress: (SetupProgress) -> Unit,
    ): File {
        downloadDir.mkdirs()
        val dest = File(downloadDir, "rootfs.tar.zst")
        val url = "$CDN_BASE/ellul-rootfs-$version-arm64.tar.zst"

        if (dest.exists()) {
            val expectedSize = headContentLength(url)
            if (expectedSize > 0 && dest.length() == expectedSize) {
                onProgress(SetupProgress(SetupStage.DOWNLOADING, 100, expectedSize, expectedSize))
                return dest
            }
        }

        var lastError: Exception? = null
        for (attempt in 1..MAX_RETRIES) {
            try {
                doDownload(url, dest, onProgress)
                return dest
            } catch (e: Exception) {
                lastError = e
                Log.w(TAG, "Download attempt $attempt/$MAX_RETRIES failed: ${e.message}")
                if (attempt < MAX_RETRIES) Thread.sleep(RETRY_DELAY_MS)
            }
        }

        dest.delete()
        throw SetupException(
            "Download failed after $MAX_RETRIES attempts: ${lastError?.message}",
            SetupStage.DOWNLOADING,
            lastError
        )
    }

    private fun headContentLength(url: String): Long {
        val conn = URL(url).openConnection() as HttpURLConnection
        return try {
            conn.requestMethod = "HEAD"
            conn.connectTimeout = CONNECT_TIMEOUT
            conn.readTimeout = READ_TIMEOUT
            conn.instanceFollowRedirects = true
            conn.contentLengthLong
        } catch (_: Exception) {
            -1
        } finally {
            conn.disconnect()
        }
    }

    private fun doDownload(
        url: String,
        dest: File,
        onProgress: (SetupProgress) -> Unit,
    ) {
        val conn = URL(url).openConnection() as HttpURLConnection
        try {
            conn.connectTimeout = CONNECT_TIMEOUT
            conn.readTimeout = READ_TIMEOUT
            conn.instanceFollowRedirects = true

            if (conn.responseCode != 200) {
                throw SetupException(
                    "Download failed: HTTP ${conn.responseCode} from $url",
                    SetupStage.DOWNLOADING
                )
            }

            val total = conn.contentLengthLong
            var downloaded = 0L
            val buf = ByteArray(BUFFER_SIZE)

            conn.inputStream.use { input ->
                FileOutputStream(dest).use { output ->
                    while (true) {
                        val n = input.read(buf)
                        if (n == -1) break
                        output.write(buf, 0, n)
                        downloaded += n
                        val pct = if (total > 0) (downloaded * 100 / total).toInt().coerceIn(0, 100) else 0
                        onProgress(SetupProgress(SetupStage.DOWNLOADING, pct, downloaded, total))
                    }
                }
            }
        } finally {
            conn.disconnect()
        }
    }

    private fun verifyChecksum(
        version: String,
        archiveFile: File,
        onProgress: (SetupProgress) -> Unit,
    ) {
        val expected = fetchChecksumHex(version)
        val digest = MessageDigest.getInstance("SHA-256")
        val total = archiveFile.length()
        var hashed = 0L
        val buf = ByteArray(BUFFER_SIZE)

        FileInputStream(archiveFile).use { input ->
            while (true) {
                val n = input.read(buf)
                if (n == -1) break
                digest.update(buf, 0, n)
                hashed += n
                val pct = if (total > 0) (hashed * 100 / total).toInt().coerceIn(0, 100) else 0
                onProgress(SetupProgress(SetupStage.VERIFYING, pct, hashed, total))
            }
        }

        val actual = digest.digest().joinToString("") { "%02x".format(it) }
        if (!actual.equals(expected, ignoreCase = true)) {
            archiveFile.delete()
            throw SetupException(
                "Integrity check failed: expected $expected, got $actual",
                SetupStage.VERIFYING
            )
        }
    }

    private fun fetchChecksumHex(version: String): String {
        val conn = URL("$CDN_BASE/ellul-rootfs-$version-arm64.sha256")
            .openConnection() as HttpURLConnection
        try {
            conn.connectTimeout = CONNECT_TIMEOUT
            conn.readTimeout = READ_TIMEOUT
            conn.instanceFollowRedirects = true

            if (conn.responseCode != 200) {
                throw SetupException(
                    "Failed to fetch checksum: HTTP ${conn.responseCode}",
                    SetupStage.VERIFYING
                )
            }

            return conn.inputStream.bufferedReader().readText().trim()
                .split("\\s+".toRegex()).first()
        } finally {
            conn.disconnect()
        }
    }

    @Suppress("NewApi")
    private fun extractRootfs(
        archiveFile: File,
        onProgress: (SetupProgress) -> Unit,
    ) {
        onProgress(SetupProgress(SetupStage.EXTRACTING, 0, 0, 0))

        if (rootfsDir.exists()) rootfsDir.deleteRecursively()
        rootfsDir.mkdirs()

        val estimatedTotal = archiveFile.length() * ZSTD_EXPANSION_FACTOR
        var extracted = 0L
        val rootfsCanonical = rootfsDir.canonicalPath

        try {
            FileInputStream(archiveFile).use { fileIn ->
                ZstdInputStream(fileIn).use { zstdIn ->
                    TarArchiveInputStream(zstdIn).use { tar ->
                        generateSequence { tar.nextEntry }.forEach { entry ->
                            val name = entry.name

                            if (name.contains("..") || name.startsWith("/")) {
                                throw SetupException(
                                    "Rejected unsafe archive entry: $name",
                                    SetupStage.EXTRACTING
                                )
                            }
                            if (name.toByteArray(Charsets.UTF_8).size > MAX_PATH_BYTES) {
                                throw SetupException(
                                    "Rejected archive entry exceeding $MAX_PATH_BYTES byte name limit",
                                    SetupStage.EXTRACTING
                                )
                            }

                            val outFile = File(rootfsDir, name)
                            if (!outFile.canonicalPath.startsWith(rootfsCanonical)) {
                                throw SetupException(
                                    "Rejected path traversal entry: $name",
                                    SetupStage.EXTRACTING
                                )
                            }

                            when {
                                entry.isDirectory -> {
                                    outFile.mkdirs()
                                    applyPermissions(outFile, entry.mode)
                                }
                                entry.isSymbolicLink -> {
                                    outFile.parentFile?.mkdirs()
                                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                                        Files.createSymbolicLink(
                                            outFile.toPath(),
                                            Paths.get(entry.linkName)
                                        )
                                    }
                                }
                                else -> {
                                    outFile.parentFile?.mkdirs()
                                    FileOutputStream(outFile).use { out ->
                                        val buf = ByteArray(BUFFER_SIZE)
                                        while (true) {
                                            val n = tar.read(buf)
                                            if (n == -1) break
                                            out.write(buf, 0, n)
                                            extracted += n
                                        }
                                    }
                                    applyPermissions(outFile, entry.mode)
                                }
                            }

                            val pct = if (estimatedTotal > 0) {
                                (extracted * 100 / estimatedTotal).toInt().coerceIn(0, 99)
                            } else 0
                            onProgress(
                                SetupProgress(SetupStage.EXTRACTING, pct, extracted, estimatedTotal)
                            )
                        }
                    }
                }
            }
        } catch (e: SetupException) {
            rootfsDir.deleteRecursively()
            throw e
        } catch (e: Exception) {
            rootfsDir.deleteRecursively()
            throw SetupException("Extraction failed: ${e.message}", SetupStage.EXTRACTING, e)
        }

        for (bin in listOf(
            "usr/local/bin/ellul-engine-android",
            "usr/local/bin/node",
            "usr/local/bin/caddy",
            "usr/bin/pg_ctl",
        )) {
            File(rootfsDir, bin).takeIf { it.exists() }?.setExecutable(true, false)
        }
    }

    private fun applyPermissions(file: File, mode: Int) {
        file.setReadable((mode and 0x124) != 0, false)
        file.setWritable((mode and 0x92) != 0, true)
        file.setExecutable((mode and 0x49) != 0, false)
    }

    private fun initializeVault(onProgress: (SetupProgress) -> Unit) {
        onProgress(SetupProgress(SetupStage.INITIALIZING, 0, 0, 0))

        if (File(vaultDir, "etc/ellul/jwt-secret").exists()) return

        for (dir in listOf(
            "etc/ellul",
            "etc/ellul/shield-data",
            "etc/ellul/heap-caps",
            "etc/caddy",
            "etc/iptables",
            "var/lib/ellul-shielded",
            "var/lib/postgresql/16/main",
            "var/log/ellul",
            "var/log/caddy",
            "opt/ellul/releases",
        )) {
            File(vaultDir, dir).mkdirs()
        }

        val secret = ByteArray(32).also { SecureRandom().nextBytes(it) }
        File(vaultDir, "etc/ellul/jwt-secret").writeText(
            secret.joinToString("") { "%02x".format(it) }
        )
        File(vaultDir, "etc/ellul/deployment-model").writeText("localhost")
        File(vaultDir, "etc/ellul/security-tier").writeText("standard")
        File(vaultDir, "etc/ellul/domain").writeText("localhost")
    }
}
