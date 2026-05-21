package ai.ellul.plugins.proot

import android.content.Context
import android.os.Build
import android.os.StatFs
import android.util.Base64
import android.util.Log
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream
import com.github.luben.zstd.ZstdInputStream
import org.bouncycastle.pqc.crypto.mldsa.MLDSAParameters
import org.bouncycastle.pqc.crypto.mldsa.MLDSAPublicKeyParameters
import org.bouncycastle.pqc.crypto.mldsa.MLDSASigner
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.RandomAccessFile
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

data class RootfsManifest(
    val version: String,
    val sha256: String,
    val size: Long,
)

class SetupException(
    message: String,
    val stage: SetupStage? = null,
    cause: Throwable? = null,
) : Exception(message, cause)

class SetupManager(private val context: Context) {

    companion object {
        private const val TAG = "SetupManager"
        private const val CDN_BASE = "https://cache.ellul.ai/android"
        private const val BUFFER_SIZE = 128 * 1024
        private const val CONNECT_TIMEOUT = 30_000
        private const val READ_TIMEOUT = 60_000
        private const val MANIFEST_CONNECT_TIMEOUT = 15_000
        private const val MANIFEST_READ_TIMEOUT = 30_000
        private const val MAX_RETRIES = 3
        private const val RETRY_BASE_MS = 1_000L
        private const val RETRY_MAX_MS = 30_000L
        private const val REQUIRED_SPACE_BYTES = 3_221_225_472L
        private const val MAX_PATH_BYTES = 255
        private const val MAX_EXTRACTED_BYTES = 4L * 1024 * 1024 * 1024
        private const val ZSTD_EXPANSION_FACTOR = 3L
        private const val PROGRESS_THROTTLE_MS = 100L
        private const val ML_DSA_65_PK_BYTES = 1_952
        private const val ML_DSA_65_SIG_BYTES = 3_309
        private const val MAX_JWS_BYTES = 32_768

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

            val manifest = fetchSignedManifest()

            if (isSetupComplete() && getInstalledVersion() == manifest.version) {
                onProgress(SetupProgress(SetupStage.COMPLETE, 100, 0, 0))
                return
            }

            val archiveFile = downloadRootfs(manifest.version, onProgress)

            if (archiveFile.length() != manifest.size) {
                archiveFile.delete()
                throw SetupException(
                    "Download size mismatch: expected ${manifest.size}, got ${archiveFile.length()}",
                    SetupStage.DOWNLOADING
                )
            }

            verifyChecksum(manifest.sha256, archiveFile, onProgress)
            checkDiskSpace()
            extractRootfs(archiveFile, onProgress)
            initializeVault(onProgress)

            writeVersionMarker(manifest.version)

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

    // ── Signed manifest ──────────────────────────────────────────────────

    private fun fetchSignedManifest(): RootfsManifest {
        checkInterrupted()

        val signingKeyB64 = BuildConfig.PLATFORM_SIGNING_KEY
        if (signingKeyB64.isEmpty()) {
            throw SetupException("Platform signing key not configured", SetupStage.DOWNLOADING)
        }

        val conn = URL("$CDN_BASE/rootfs-manifest.jws").openConnection() as HttpURLConnection
        try {
            conn.connectTimeout = MANIFEST_CONNECT_TIMEOUT
            conn.readTimeout = MANIFEST_READ_TIMEOUT
            conn.instanceFollowRedirects = true

            if (conn.responseCode != 200) {
                throw SetupException(
                    "Failed to fetch manifest: HTTP ${conn.responseCode}",
                    SetupStage.DOWNLOADING
                )
            }

            val jws = conn.inputStream.bufferedReader().readText().trim()
            if (jws.toByteArray(Charsets.UTF_8).size > MAX_JWS_BYTES) {
                throw SetupException("Manifest exceeds size limit", SetupStage.DOWNLOADING)
            }

            return verifyAndParseJws(jws, signingKeyB64)
        } catch (e: SetupException) {
            throw e
        } catch (e: Exception) {
            throw SetupException(
                "Failed to fetch manifest: ${e.message}",
                SetupStage.DOWNLOADING,
                e
            )
        } finally {
            conn.disconnect()
        }
    }

    private fun verifyAndParseJws(jws: String, signingKeyB64: String): RootfsManifest {
        val parts = jws.split(".")
        if (parts.size != 3) {
            throw SetupException("Invalid manifest: expected 3-part JWS", SetupStage.DOWNLOADING)
        }

        val header = JSONObject(String(base64UrlDecode(parts[0]), Charsets.UTF_8))
        if (header.optString("alg") != "MLDSA65") {
            throw SetupException(
                "Unsupported manifest algorithm: ${header.optString("alg")}",
                SetupStage.DOWNLOADING
            )
        }
        if (header.optString("typ") != "rootfs-manifest+jws") {
            throw SetupException(
                "Wrong manifest type: ${header.optString("typ")}",
                SetupStage.DOWNLOADING
            )
        }

        val sigBytes = base64UrlDecode(parts[2])
        if (sigBytes.size != ML_DSA_65_SIG_BYTES) {
            throw SetupException(
                "Invalid signature: ${sigBytes.size} bytes (expected $ML_DSA_65_SIG_BYTES)",
                SetupStage.DOWNLOADING
            )
        }

        val pkBytes = Base64.decode(signingKeyB64, Base64.DEFAULT)
        if (pkBytes.size != ML_DSA_65_PK_BYTES) {
            throw SetupException(
                "Invalid signing key: ${pkBytes.size} bytes (expected $ML_DSA_65_PK_BYTES)",
                SetupStage.DOWNLOADING
            )
        }

        val signingInput = "${parts[0]}.${parts[1]}".toByteArray(Charsets.UTF_8)
        val pubKey = MLDSAPublicKeyParameters(MLDSAParameters.ml_dsa_65, pkBytes)
        val verifier = MLDSASigner()
        verifier.init(false, pubKey)
        verifier.update(signingInput, 0, signingInput.size)
        if (!verifier.verifySignature(sigBytes)) {
            throw SetupException(
                "Manifest signature verification failed — possible tampering",
                SetupStage.DOWNLOADING
            )
        }

        Log.i(TAG, "Manifest ML-DSA-65 signature verified")

        val payload = JSONObject(String(base64UrlDecode(parts[1]), Charsets.UTF_8))
        val version = payload.optString("version", "")
        val sha256 = payload.optString("sha256", "")
        val size = payload.optLong("size", -1)

        if (version.isEmpty()) {
            throw SetupException("Manifest missing version", SetupStage.DOWNLOADING)
        }
        if (!sha256.matches(Regex("^[0-9a-f]{64}$"))) {
            throw SetupException("Manifest has invalid sha256", SetupStage.DOWNLOADING)
        }
        if (size <= 0) {
            throw SetupException("Manifest has invalid size", SetupStage.DOWNLOADING)
        }

        return RootfsManifest(version = version, sha256 = sha256, size = size)
    }

    private fun base64UrlDecode(input: String): ByteArray {
        return Base64.decode(input, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
    }

    // ── Download ─────────────────────────────────────────────────────────

    private fun downloadRootfs(
        version: String,
        onProgress: (SetupProgress) -> Unit,
    ): File {
        downloadDir.mkdirs()
        val dest = File(downloadDir, "rootfs.tar.zst")
        val url = "$CDN_BASE/ellul-rootfs-$version-arm64.tar.zst"

        var lastError: Exception? = null
        for (attempt in 1..MAX_RETRIES) {
            checkInterrupted()
            try {
                doDownload(url, dest, onProgress)
                return dest
            } catch (e: Exception) {
                lastError = e
                Log.w(TAG, "Download attempt $attempt/$MAX_RETRIES failed: ${e.message}")
                if (attempt < MAX_RETRIES) {
                    val backoff = retryDelay(attempt)
                    Log.i(TAG, "Retrying in ${backoff}ms")
                    Thread.sleep(backoff)
                }
            }
        }

        dest.delete()
        throw SetupException(
            "Download failed after $MAX_RETRIES attempts: ${lastError?.message}",
            SetupStage.DOWNLOADING,
            lastError
        )
    }

    private fun retryDelay(attempt: Int): Long {
        val exponential = RETRY_BASE_MS * (1L shl (attempt - 1))
        val capped = minOf(exponential, RETRY_MAX_MS)
        val jitter = (Math.random() * capped * 0.3).toLong()
        return capped + jitter
    }

    private fun doDownload(
        url: String,
        dest: File,
        onProgress: (SetupProgress) -> Unit,
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

            val code = conn.responseCode

            if (code == 416) {
                val total = headContentLength(url)
                if (total > 0 && dest.length() >= total) {
                    onProgress(SetupProgress(SetupStage.DOWNLOADING, 100, dest.length(), dest.length()))
                    return
                }
                dest.delete()
                throw SetupException("Range request rejected and file size mismatch", SetupStage.DOWNLOADING)
            }

            val resuming = code == 206
            if (code != 200 && code != 206) {
                throw SetupException(
                    "Download failed: HTTP $code from $url",
                    SetupStage.DOWNLOADING
                )
            }

            val contentLength = conn.contentLengthLong
            val total = if (resuming) existingBytes + contentLength else contentLength
            var downloaded = if (resuming) existingBytes else 0L
            val buf = ByteArray(BUFFER_SIZE)
            var lastEmit = 0L

            if (!resuming && existingBytes > 0) {
                dest.delete()
            }

            val raf = RandomAccessFile(dest, "rw")
            try {
                if (resuming) raf.seek(existingBytes)
                conn.inputStream.use { input ->
                    while (true) {
                        checkInterrupted()
                        val n = input.read(buf)
                        if (n == -1) break
                        raf.write(buf, 0, n)
                        downloaded += n

                        val now = System.currentTimeMillis()
                        if (now - lastEmit >= PROGRESS_THROTTLE_MS) {
                            lastEmit = now
                            val pct = if (total > 0) (downloaded * 100 / total).toInt().coerceIn(0, 100) else 0
                            onProgress(SetupProgress(SetupStage.DOWNLOADING, pct, downloaded, total))
                        }
                    }
                }
            } finally {
                raf.close()
            }

            onProgress(SetupProgress(SetupStage.DOWNLOADING, 100, downloaded, total))
        } finally {
            conn.disconnect()
        }
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

    // ── Verification ─────────────────────────────────────────────────────

    private fun verifyChecksum(
        expectedSha256: String,
        archiveFile: File,
        onProgress: (SetupProgress) -> Unit,
    ) {
        checkInterrupted()
        val digest = MessageDigest.getInstance("SHA-256")
        val total = archiveFile.length()
        var hashed = 0L
        val buf = ByteArray(BUFFER_SIZE)
        var lastEmit = 0L

        FileInputStream(archiveFile).use { input ->
            while (true) {
                checkInterrupted()
                val n = input.read(buf)
                if (n == -1) break
                digest.update(buf, 0, n)
                hashed += n

                val now = System.currentTimeMillis()
                if (now - lastEmit >= PROGRESS_THROTTLE_MS) {
                    lastEmit = now
                    val pct = if (total > 0) (hashed * 100 / total).toInt().coerceIn(0, 100) else 0
                    onProgress(SetupProgress(SetupStage.VERIFYING, pct, hashed, total))
                }
            }
        }

        onProgress(SetupProgress(SetupStage.VERIFYING, 100, total, total))

        val actual = digest.digest().joinToString("") { "%02x".format(it) }
        if (!actual.equals(expectedSha256, ignoreCase = true)) {
            archiveFile.delete()
            throw SetupException(
                "Integrity check failed: expected $expectedSha256, got $actual",
                SetupStage.VERIFYING
            )
        }
    }

    // ── Extraction ───────────────────────────────────────────────────────

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
        var lastEmit = 0L

        try {
            FileInputStream(archiveFile).use { fileIn ->
                ZstdInputStream(fileIn).use { zstdIn ->
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

    private fun validateSymlinkTarget(entryName: String, linkTarget: String) {
        if (linkTarget.contains("..")) {
            throw SetupException(
                "Rejected symlink with traversal target: $entryName -> $linkTarget",
                SetupStage.EXTRACTING
            )
        }
        if (linkTarget.startsWith("/")) {
            val normalized = File(linkTarget).path
            val forbidden = listOf("/data/", "/sdcard/", "/storage/", "/proc/", "/sys/")
            for (prefix in forbidden) {
                if (normalized.startsWith(prefix)) {
                    throw SetupException(
                        "Rejected symlink escaping rootfs: $entryName -> $linkTarget",
                        SetupStage.EXTRACTING
                    )
                }
            }
        }
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
        File(vaultDir, "etc/ellul/console-origin").writeText("https://localhost:8443")
        File(vaultDir, "etc/ellul/platform-zone").writeText("localhost")
        File(vaultDir, "etc/ellul/app-zone").writeText("localhost")
        File(vaultDir, "etc/ellul/allowed-origins").writeText("https://localhost:8443")
        File(vaultDir, "etc/ellul/dev-domain").writeText("localhost")
        File(vaultDir, "etc/ellul/preview-origins.json").writeText("""{"origins":["https://localhost:8443"],"patterns":[]}""")

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
