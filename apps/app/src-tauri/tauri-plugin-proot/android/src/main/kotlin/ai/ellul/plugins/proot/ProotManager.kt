package ai.ellul.plugins.proot

import android.content.Context
import android.os.StatFs
import android.util.Log
import java.io.BufferedReader
import java.io.BufferedWriter
import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit

class ProotManager(private val context: Context) {

    companion object {
        const val TAG = "ProotManager"
        private const val MAX_LOG_BYTES = 10L * 1024 * 1024
        private const val MIN_RUNTIME_SPACE_BYTES = 512L * 1024 * 1024
    }

    @Volatile
    private var prootProcess: Process? = null
    private var stdoutThread: Thread? = null
    private var stderrThread: Thread? = null
    private val appDir: File = context.filesDir
    private val rootfsDir = File(appDir, "rootfs")
    private val vaultDir = File(appDir, "vault")
    private val projectsDir: File =
        File(context.getExternalFilesDir(null) ?: appDir, "projects")
    private val prootBin = File(appDir, "proot")
    private val logDir = File(appDir, "logs")

    fun extractProotBinary() {
        val versionFile = File(appDir, "proot.version")
        val currentVersion = getAppVersionCode()

        if (prootBin.exists() && prootBin.canExecute() && versionFile.exists()) {
            if (versionFile.readText().trim() == currentVersion) return
            Log.i(TAG, "APK updated — re-extracting proot binary")
        }

        try {
            context.assets.open("proot/arm64-v8a/proot").use { input ->
                prootBin.outputStream().use { output ->
                    input.copyTo(output)
                }
            }
            prootBin.setExecutable(true, true)
            versionFile.writeText(currentVersion)
            Log.i(TAG, "Extracted proot binary (version $currentVersion)")
        } catch (e: IOException) {
            throw RuntimeException(
                "proot binary not found in plugin assets — " +
                    "build with scripts/build-proot-arm64.sh first",
                e
            )
        }
    }

    private fun getAppVersionCode(): String {
        return try {
            val info = context.packageManager.getPackageInfo(context.packageName, 0)
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.P) {
                info.longVersionCode.toString()
            } else {
                @Suppress("DEPRECATION")
                info.versionCode.toString()
            }
        } catch (_: Exception) {
            "unknown"
        }
    }

    fun start() {
        if (isRunning()) {
            Log.w(TAG, "proot already running")
            return
        }

        extractProotBinary()

        if (!rootfsDir.exists()) {
            throw IllegalStateException(
                "rootfs not found at ${rootfsDir.absolutePath} — " +
                    "run setup first"
            )
        }

        val available = StatFs(appDir.path).availableBytes
        if (available < MIN_RUNTIME_SPACE_BYTES) {
            val availableMB = available / (1024 * 1024)
            throw IllegalStateException(
                "Not enough storage to start workspace. Need 512MB free, have ${availableMB}MB."
            )
        }

        vaultDir.mkdirs()
        projectsDir.mkdirs()
        logDir.mkdirs()

        ShieldVaultKeyStore.writeToVault(context, vaultDir)

        val cmd = buildProotCommand()
        val env = buildEnvironment()

        Log.i(TAG, "Starting proot: ${cmd.joinToString(" ")}")

        val pb = ProcessBuilder(cmd)
        pb.environment().putAll(env)
        pb.redirectErrorStream(false)

        val proc = pb.start()
        prootProcess = proc
        startLogStreaming(proc)

        Log.i(TAG, "proot process started (pid viewable in logcat)")
    }

    fun stop() {
        val proc = prootProcess ?: return

        Log.i(TAG, "Stopping proot")
        proc.destroy()

        try {
            val exited = proc.waitFor(10, TimeUnit.SECONDS)
            if (!exited) {
                Log.w(TAG, "proot did not exit gracefully — force killing")
                proc.destroyForcibly()
                proc.waitFor(5, TimeUnit.SECONDS)
            }
        } catch (_: InterruptedException) {
            proc.destroyForcibly()
        }

        stdoutThread?.interrupt()
        stderrThread?.interrupt()
        stdoutThread = null
        stderrThread = null
        prootProcess = null
        Log.i(TAG, "proot stopped")
    }

    fun isRunning(): Boolean = prootProcess?.isAlive == true

    private fun buildProotCommand(): List<String> = listOf(
        prootBin.absolutePath,
        "--rootfs=${rootfsDir.absolutePath}",
        "--bind=/dev",
        "--bind=/proc",
        "--bind=/sys",
        "--bind=${vaultDir.absolutePath}:/root/ellul-vault",
        "--bind=${projectsDir.absolutePath}:/home/dev/projects",
        "-w", "/home/dev",
        "-0",
        "/usr/local/bin/ellul-engine-android"
    )

    private fun buildEnvironment(): Map<String, String> = mapOf(
        "HOME" to "/home/dev",
        "USER" to "dev",
        "PATH" to "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "LANG" to "C.UTF-8",
        "TERM" to "xterm-256color",
        "NODE_ENV" to "production",
        "ELLUL_PLATFORM" to "android",
        "ELLUL_HIGH_PORTS" to "1",
    )

    private fun startLogStreaming(process: Process) {
        val stdoutLog = File(logDir, "proot-stdout.log")
        val stderrLog = File(logDir, "proot-stderr.log")

        stdoutThread = Thread({
            streamToFile(process.inputStream.bufferedReader(), stdoutLog) { line ->
                Log.d("proot-out", line)
            }
        }, "proot-stdout").apply { isDaemon = true; start() }

        stderrThread = Thread({
            streamToFile(process.errorStream.bufferedReader(), stderrLog) { line ->
                Log.w("proot-err", line)
            }
        }, "proot-stderr").apply { isDaemon = true; start() }
    }

    private fun streamToFile(
        reader: BufferedReader,
        logFile: File,
        logcat: (String) -> Unit
    ) {
        try {
            var writer: BufferedWriter = logFile.bufferedWriter()
            var bytesWritten: Long = logFile.length()
            try {
                reader.forEachLine { line ->
                    if (Thread.interrupted()) throw InterruptedException()
                    logcat(line)
                    writer.write(line)
                    writer.newLine()
                    writer.flush()
                    bytesWritten += line.toByteArray().size + 1

                    if (bytesWritten > MAX_LOG_BYTES) {
                        writer.close()
                        val backup = File(logFile.parentFile, "${logFile.name}.1")
                        backup.delete()
                        logFile.renameTo(backup)
                        writer = logFile.bufferedWriter()
                        bytesWritten = 0
                    }
                }
            } finally {
                writer.close()
            }
        } catch (_: IOException) {
        } catch (_: InterruptedException) {
        }
    }
}
