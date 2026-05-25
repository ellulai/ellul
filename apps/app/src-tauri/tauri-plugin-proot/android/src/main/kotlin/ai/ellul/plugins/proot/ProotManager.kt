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
    private val projectsDir: File = File(appDir, "projects")
    private val nativeLibDir = context.applicationInfo.nativeLibraryDir
    private val prootBin = File(nativeLibDir, "libproot.so")
    private val libDir = File(appDir, "lib")
    private val logDir = File(appDir, "logs")

    fun extractProotBinary() {
        if (prootBin.exists() && prootBin.canExecute()) {
            Log.i(TAG, "Using proot from nativeLibraryDir: ${prootBin.absolutePath}")
            ensureLibSymlinks()
            return
        }
        throw RuntimeException(
            "proot binary not found at ${prootBin.absolutePath} — " +
                "ensure libproot.so is in jniLibs/arm64-v8a/"
        )
    }

    private fun ensureLibSymlinks() {
        libDir.mkdirs()
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
        File(appDir, "tmp").mkdirs()

        ShieldVaultKeyStore.writeToVault(context, vaultDir)
        linkGlobalNodeModules()

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

    private fun linkGlobalNodeModules() {
        val globalModules = File(rootfsDir, "usr/lib/node_modules")
        if (!globalModules.exists()) return
        val services = listOf("sovereign-shield", "file-api", "agent-bridge")
        for (svc in services) {
            val nmLink = File(rootfsDir, "opt/ellul/releases/$svc/current/node_modules")
            if (nmLink.exists()) {
                if (!nmLink.delete()) continue
            }
            try {
                java.nio.file.Files.createSymbolicLink(
                    nmLink.toPath(),
                    java.nio.file.Path.of("/usr/lib/node_modules")
                )
            } catch (e: Exception) {
                Log.w(TAG, "node_modules link failed for $svc: ${e.message}")
            }
        }
    }

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
        "LD_LIBRARY_PATH" to "$nativeLibDir:${libDir.absolutePath}",
        "PROOT_LOADER" to "$nativeLibDir/libproot-loader.so",
        "PROOT_TMP_DIR" to "${appDir.absolutePath}/tmp",
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
