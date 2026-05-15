package ai.ellul.plugins.proot

import android.content.Context
import android.util.Log
import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit

class ProotManager(private val context: Context) {

    companion object {
        const val TAG = "ProotManager"
        private const val MAX_LOG_BYTES = 10L * 1024 * 1024
    }

    private var prootProcess: Process? = null
    private val appDir: File = context.filesDir
    private val rootfsDir = File(appDir, "rootfs")
    private val vaultDir = File(appDir, "vault")
    private val projectsDir: File =
        File(context.getExternalFilesDir(null) ?: appDir, "projects")
    private val prootBin = File(appDir, "proot")
    private val logDir = File(appDir, "logs")

    fun extractProotBinary() {
        if (prootBin.exists() && prootBin.canExecute()) return

        try {
            context.assets.open("proot/arm64-v8a/proot").use { input ->
                prootBin.outputStream().use { output ->
                    input.copyTo(output)
                }
            }
            prootBin.setExecutable(true, false)
            Log.i(TAG, "Extracted proot binary to ${prootBin.absolutePath}")
        } catch (e: IOException) {
            throw RuntimeException(
                "proot binary not found in plugin assets — " +
                    "build with scripts/build-proot-arm64.sh first",
                e
            )
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

        vaultDir.mkdirs()
        projectsDir.mkdirs()
        logDir.mkdirs()

        val cmd = buildProotCommand()
        val env = buildEnvironment()

        Log.i(TAG, "Starting proot: ${cmd.joinToString(" ")}")

        val pb = ProcessBuilder(cmd)
        pb.environment().putAll(env)
        pb.redirectErrorStream(false)

        prootProcess = pb.start()
        startLogStreaming(prootProcess!!)

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

        Thread({
            try {
                stdoutLog.bufferedWriter().use { writer ->
                    process.inputStream.bufferedReader().forEachLine { line ->
                        Log.d("proot-out", line)
                        writer.write(line)
                        writer.newLine()
                        writer.flush()
                        rotateIfNeeded(stdoutLog)
                    }
                }
            } catch (_: IOException) {
            }
        }, "proot-stdout").apply { isDaemon = true; start() }

        Thread({
            try {
                stderrLog.bufferedWriter().use { writer ->
                    process.errorStream.bufferedReader().forEachLine { line ->
                        Log.w("proot-err", line)
                        writer.write(line)
                        writer.newLine()
                        writer.flush()
                        rotateIfNeeded(stderrLog)
                    }
                }
            } catch (_: IOException) {
            }
        }, "proot-stderr").apply { isDaemon = true; start() }
    }

    private fun rotateIfNeeded(file: File) {
        if (file.length() > MAX_LOG_BYTES) {
            val backup = File(file.parentFile, "${file.name}.1")
            backup.delete()
            file.renameTo(backup)
        }
    }
}
