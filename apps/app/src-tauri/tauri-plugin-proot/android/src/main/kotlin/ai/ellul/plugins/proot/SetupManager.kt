package ai.ellul.plugins.proot

import android.content.Context
import android.os.Build
import android.os.StatFs
import android.util.Log
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream
import com.github.luben.zstd.ZstdInputStream
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.nio.file.Files
import java.nio.file.Paths
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
        private const val BUFFER_SIZE = 128 * 1024
        private const val REQUIRED_SPACE_BYTES = 3_221_225_472L
        private const val MAX_PATH_BYTES = 255
        private const val MAX_EXTRACTED_BYTES = 4L * 1024 * 1024 * 1024
        private const val ZSTD_EXPANSION_FACTOR = 3L
        private const val PROGRESS_THROTTLE_MS = 100L
        private const val BUNDLED_ASSET = "rootfs.tar.zst"

        private val setupRunning = AtomicBoolean(false)
    }

    private val appDir: File = context.filesDir
    private val rootfsDir = File(appDir, "rootfs")
    private val vaultDir = File(appDir, "vault")
    private val versionFile = File(appDir, "rootfs-version")

    fun isSetupComplete(): Boolean {
        return rootfsDir.exists()
            && File(rootfsDir, "usr/local/bin/ellul-engine-android").exists()
            && (File(rootfsDir, "usr/bin/node").exists() || File(rootfsDir, "usr/local/bin/node").exists())
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
            val bundledVersion = BuildConfig.BUNDLED_ROOTFS_VERSION
            if (bundledVersion.isEmpty()) {
                throw SetupException("No bundled rootfs in this build", SetupStage.DOWNLOADING)
            }

            if (isSetupComplete() && getInstalledVersion() == bundledVersion) {
                Log.d(TAG, "setup already complete, version=$bundledVersion")
                onProgress(SetupProgress(SetupStage.COMPLETE, 100, 0, 0))
                return
            }

            checkDiskSpace()

            Log.i(TAG, "extracting bundled rootfs v$bundledVersion")
            onProgress(SetupProgress(SetupStage.EXTRACTING, 0, 0, 0))

            extractFromAssets(onProgress)
            initializeVault(onProgress)
            writeVersionMarker(bundledVersion)

            onProgress(SetupProgress(SetupStage.COMPLETE, 100, 0, 0))
        } catch (e: SetupException) {
            throw e
        } catch (e: Exception) {
            throw SetupException("Setup failed: ${e.message}", cause = e)
        } finally {
            setupRunning.set(false)
        }
    }

    private fun writeVersionMarker(version: String) {
        val tmp = File(appDir, "rootfs-version.tmp")
        tmp.writeText(version)
        if (!tmp.renameTo(versionFile)) {
            tmp.delete()
            throw SetupException("Failed to write version marker", SetupStage.INITIALIZING)
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

    // ── Extraction from bundled APK asset ────────────────────────────────

    private fun extractFromAssets(onProgress: (SetupProgress) -> Unit) {
        val assetSize = try {
            context.assets.openFd(BUNDLED_ASSET).length
        } catch (_: Exception) { 0L }
        val estimatedTotal = if (assetSize > 0) assetSize * ZSTD_EXPANSION_FACTOR else 0L

        context.assets.open(BUNDLED_ASSET).use { assetStream ->
            extractRootfs(assetStream, estimatedTotal, onProgress)
        }
    }

    @Suppress("NewApi")
    private fun extractRootfs(
        inputStream: InputStream,
        estimatedTotal: Long,
        onProgress: (SetupProgress) -> Unit,
    ) {
        if (rootfsDir.exists()) rootfsDir.deleteRecursively()
        rootfsDir.mkdirs()

        var extracted = 0L
        val rootfsCanonical = rootfsDir.canonicalPath
        var lastEmit = 0L

        try {
            ZstdInputStream(inputStream).use { zstdIn ->
                TarArchiveInputStream(zstdIn).use { tar ->
                    generateSequence { tar.nextEntry }.forEach { entry ->
                        checkInterrupted()
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
                                validateSymlinkTarget(name, entry.linkName)
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

                                        if (extracted > MAX_EXTRACTED_BYTES) {
                                            throw SetupException(
                                                "Extraction exceeded ${MAX_EXTRACTED_BYTES / (1024 * 1024 * 1024)}GB limit",
                                                SetupStage.EXTRACTING
                                            )
                                        }
                                    }
                                }
                                applyPermissions(outFile, entry.mode)
                            }
                        }

                        val now = System.currentTimeMillis()
                        if (now - lastEmit >= PROGRESS_THROTTLE_MS) {
                            lastEmit = now
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

        if (!File(rootfsDir, "usr/local/bin/node").exists() && File(rootfsDir, "usr/bin/node").exists()) {
            File(rootfsDir, "usr/local/bin").mkdirs()
            java.nio.file.Files.createSymbolicLink(
                File(rootfsDir, "usr/local/bin/node").toPath(),
                java.nio.file.Paths.get("../../bin/node")
            )
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

    private fun validateSymlinkTarget(entryName: String, linkTarget: String) {
    }

    private fun applyPermissions(file: File, mode: Int) {
        file.setReadable((mode and 0x124) != 0, false)
        file.setWritable((mode and 0x92) != 0, true)
        file.setExecutable((mode and 0x49) != 0, false)
    }

    // ── Vault initialization ─────────────────────────────────────────────

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
        File(vaultDir, "etc/ellul/rp-id").writeText("localhost")
        File(vaultDir, "etc/ellul/console-origin").writeText("http://localhost:8443")
        File(vaultDir, "etc/ellul/platform-zone").writeText("localhost")
        File(vaultDir, "etc/ellul/app-zone").writeText("localhost")
        File(vaultDir, "etc/ellul/allowed-origins").writeText("http://localhost:8443")
        File(vaultDir, "etc/ellul/dev-domain").writeText("localhost")
        File(vaultDir, "etc/ellul/preview-origins.json").writeText("""{"origins":["http://localhost:8443"],"patterns":[]}""")

        val vaultKey = ByteArray(32).also { SecureRandom().nextBytes(it) }
        val vaultKeyHex = vaultKey.joinToString("") { "%02x".format(it) }
        ShieldVaultKeyStore.store(context, vaultKeyHex)
    }

    private fun checkInterrupted() {
        if (Thread.interrupted()) {
            throw SetupException("Setup cancelled", SetupStage.FAILED)
        }
    }
}
