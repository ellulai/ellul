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

data class SetupState(
    val phase: String,
    val progress: Int,
    val error: String?,
)

class SetupManager(private val context: Context) {

    companion object {
        private const val TAG = "SetupManager"
        private const val BUFFER_SIZE = 128 * 1024
        private const val REQUIRED_SPACE_BYTES = 3_221_225_472L
        private const val MAX_PATH_BYTES = 255
        private const val MAX_EXTRACTED_BYTES = 4L * 1024 * 1024 * 1024
        private const val ZSTD_EXPANSION_FACTOR = 3L
        private const val PROGRESS_THROTTLE_MS = 100L
        private const val STATE_WRITE_THROTTLE_MS = 2000L
        private const val BUNDLED_ASSET = "rootfs.tar.zst"

        private val setupRunning = AtomicBoolean(false)
    }

    private val appDir: File = context.filesDir
    private val rootfsDir = File(appDir, "rootfs")
    private val vaultDir = File(appDir, "vault")
    private val versionFile = File(appDir, "rootfs-version")
    private val setupStateFile = File(appDir, "setup-state.json")
    private var lastStateWrite = 0L

    fun isSetupComplete(): Boolean {
        val rootfsExists = rootfsDir.exists()
        val engineExists = File(rootfsDir, "usr/local/bin/ellul-engine-android").exists()
        val nodeExists = File(rootfsDir, "usr/bin/node").exists() || File(rootfsDir, "usr/local/bin/node").exists()
        val versionExists = versionFile.exists()
        val versionNonEmpty = versionExists && versionFile.readText().trim().isNotEmpty()
        val complete = rootfsExists && engineExists && nodeExists && versionExists && versionNonEmpty
        if (!complete) {
            Log.d(TAG, "isSetupComplete=false: rootfs=$rootfsExists engine=$engineExists node=$nodeExists version=$versionExists versionNonEmpty=$versionNonEmpty")
        }
        return complete
    }

    fun getInstalledVersion(): String? {
        if (!versionFile.exists()) return null
        return versionFile.readText().trim().ifEmpty { null }
    }

    fun getSetupState(): SetupState {
        if (isSetupComplete()) return SetupState("complete", 100, null)
        if (setupRunning.get()) {
            return try {
                val json = org.json.JSONObject(setupStateFile.readText())
                SetupState(
                    phase = json.optString("phase", "extracting"),
                    progress = json.optInt("progress", 0),
                    error = if (json.has("error")) json.getString("error") else null,
                )
            } catch (_: Exception) {
                SetupState("extracting", 0, null)
            }
        }
        if (!setupStateFile.exists()) return SetupState("idle", 0, null)
        return try {
            val json = org.json.JSONObject(setupStateFile.readText())
            SetupState(
                phase = json.optString("phase", "idle"),
                progress = json.optInt("progress", 0),
                error = if (json.has("error")) json.getString("error") else null,
            )
        } catch (_: Exception) {
            SetupState("idle", 0, null)
        }
    }

    private fun writeState(phase: String, progress: Int, error: String? = null, force: Boolean = false) {
        val now = System.currentTimeMillis()
        if (!force && now - lastStateWrite < STATE_WRITE_THROTTLE_MS) return
        lastStateWrite = now
        try {
            val json = org.json.JSONObject().apply {
                put("phase", phase)
                put("progress", progress)
                if (error != null) put("error", error)
                put("ts", now)
            }
            val tmp = File(appDir, "setup-state.tmp")
            tmp.writeText(json.toString())
            if (!tmp.renameTo(setupStateFile)) {
                tmp.delete()
            }
        } catch (e: Exception) {
            Log.w(TAG, "Failed to write setup state", e)
        }
    }

    fun resetSetup() {
        if (setupRunning.get()) {
            Log.w(TAG, "resetSetup: setup is running, refusing reset")
            return
        }
        Log.i(TAG, "resetSetup: cleaning up rootfs=${rootfsDir.exists()} version=${versionFile.exists()} state=${setupStateFile.exists()}")
        if (rootfsDir.exists()) rootfsDir.deleteRecursively()
        versionFile.delete()
        setupStateFile.delete()
    }

    fun setup(onProgress: (SetupProgress) -> Unit) {
        if (!setupRunning.compareAndSet(false, true)) {
            Log.w(TAG, "setup: already running, refusing concurrent setup")
            throw SetupException("Setup already in progress")
        }

        val setupStartMs = System.currentTimeMillis()
        try {
            val bundledVersion = BuildConfig.BUNDLED_ROOTFS_VERSION
            Log.i(TAG, "setup: bundledVersion='$bundledVersion' appDir=${appDir.absolutePath}")
            if (bundledVersion.isEmpty()) {
                throw SetupException("No bundled rootfs in this build", SetupStage.DOWNLOADING)
            }

            if (isSetupComplete() && getInstalledVersion() == bundledVersion) {
                Log.d(TAG, "setup: already complete, version=$bundledVersion")
                onProgress(SetupProgress(SetupStage.COMPLETE, 100, 0, 0))
                return
            }

            checkDiskSpace()

            Log.i(TAG, "setup: starting extraction of v$bundledVersion")
            writeState("extracting", 0, force = true)
            onProgress(SetupProgress(SetupStage.EXTRACTING, 0, 0, 0))

            val extractStartMs = System.currentTimeMillis()
            extractFromAssets(onProgress)
            val extractDurationMs = System.currentTimeMillis() - extractStartMs
            Log.i(TAG, "setup: extraction complete in ${extractDurationMs}ms")

            Log.i(TAG, "setup: initializing vault")
            writeState("initializing", 0, force = true)
            initializeVault(onProgress)
            writeVersionMarker(bundledVersion)

            val totalDurationMs = System.currentTimeMillis() - setupStartMs
            Log.i(TAG, "setup: complete in ${totalDurationMs}ms, version=$bundledVersion")
            writeState("complete", 100, force = true)
            onProgress(SetupProgress(SetupStage.COMPLETE, 100, 0, 0))
        } catch (e: SetupException) {
            val elapsed = System.currentTimeMillis() - setupStartMs
            Log.e(TAG, "setup: failed after ${elapsed}ms at stage=${e.stage}: ${e.message}", e)
            writeState("failed", 0, e.message, force = true)
            throw e
        } catch (e: Exception) {
            val elapsed = System.currentTimeMillis() - setupStartMs
            Log.e(TAG, "setup: unexpected failure after ${elapsed}ms: ${e.message}", e)
            writeState("failed", 0, e.message, force = true)
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
        val availableMB = available / (1024 * 1024)
        Log.d(TAG, "checkDiskSpace: ${availableMB}MB available, need ${REQUIRED_SPACE_BYTES / (1024 * 1024)}MB")
        if (available < REQUIRED_SPACE_BYTES) {
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
        } catch (e: Exception) {
            Log.d(TAG, "extractFromAssets: openFd failed (compressed asset), falling back to stream: ${e.message}")
            0L
        }
        val estimatedTotal = if (assetSize > 0) assetSize * ZSTD_EXPANSION_FACTOR else 0L
        Log.i(TAG, "extractFromAssets: assetSize=${assetSize}B estimatedTotal=${estimatedTotal}B")

        try {
            context.assets.open(BUNDLED_ASSET).use { assetStream ->
                extractRootfs(assetStream, estimatedTotal, onProgress)
            }
        } catch (e: java.io.FileNotFoundException) {
            Log.e(TAG, "extractFromAssets: bundled asset '$BUNDLED_ASSET' not found in APK", e)
            throw SetupException("Installation package missing from app. Please reinstall the app.", SetupStage.EXTRACTING, e)
        }
    }

    @Suppress("NewApi")
    private fun extractRootfs(
        inputStream: InputStream,
        estimatedTotal: Long,
        onProgress: (SetupProgress) -> Unit,
    ) {
        if (rootfsDir.exists()) {
            Log.d(TAG, "extractRootfs: removing existing rootfs dir")
            rootfsDir.deleteRecursively()
        }
        rootfsDir.mkdirs()

        var extracted = 0L
        var entryCount = 0
        val rootfsCanonical = rootfsDir.canonicalPath
        var lastEmit = 0L
        var lastLogMs = 0L

        try {
            Log.d(TAG, "extractRootfs: opening zstd+tar stream")
            ZstdInputStream(inputStream).use { zstdIn ->
                TarArchiveInputStream(zstdIn).use { tar ->
                    generateSequence { tar.nextEntry }.forEach { entry ->
                        entryCount++
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
                            writeState("extracting", pct)
                            onProgress(
                                SetupProgress(SetupStage.EXTRACTING, pct, extracted, estimatedTotal)
                            )
                            if (now - lastLogMs >= 10_000L) {
                                lastLogMs = now
                                Log.d(TAG, "extractRootfs: ${entryCount} entries, ${extracted / (1024 * 1024)}MB extracted, ${pct}%")
                            }
                        }
                    }
                }
            }
            Log.i(TAG, "extractRootfs: stream complete — ${entryCount} entries, ${extracted / (1024 * 1024)}MB total")
        } catch (e: SetupException) {
            Log.e(TAG, "extractRootfs: setup exception at entry $entryCount, ${extracted / (1024 * 1024)}MB extracted", e)
            rootfsDir.deleteRecursively()
            throw e
        } catch (e: Exception) {
            Log.e(TAG, "extractRootfs: unexpected exception at entry $entryCount, ${extracted / (1024 * 1024)}MB extracted", e)
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

        if (File(vaultDir, "etc/ellul/jwt-secret").exists()) {
            Log.d(TAG, "initializeVault: vault already initialized, skipping")
            return
        }
        Log.d(TAG, "initializeVault: creating vault at ${vaultDir.absolutePath}")

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
        File(vaultDir, "etc/ellul/github-app-client-id").writeText("Ov23li7SC1uOYjjxAr7a")

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
