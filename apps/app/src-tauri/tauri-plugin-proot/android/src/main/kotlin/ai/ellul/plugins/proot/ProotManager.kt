package ai.ellul.plugins.proot

import android.content.Context
import android.os.StatFs
import android.util.Log
import java.io.BufferedReader
import java.io.BufferedWriter
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.util.concurrent.TimeUnit
import java.util.zip.ZipFile

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
    private var prootBin = File(nativeLibDir, "libproot.so")
    private val libDir = File(appDir, "lib")
    private val logDir = File(appDir, "logs")
    private val nativeRuntime = NativeAdapterRuntime(rootfsDir, appDir)

    fun extractProotBinary() {
        if (prootBin.exists() && prootBin.canExecute()) {
            Log.i(TAG, "Using proot from nativeLibraryDir: ${prootBin.absolutePath}")
            ensureLibSymlinks()
            return
        }
        val fallback = File(appDir, "libproot.so")
        if (fallback.exists() && fallback.canExecute()) {
            Log.i(TAG, "Using proot from filesDir fallback: ${fallback.absolutePath}")
            prootBin = fallback
            ensureLibSymlinks()
            return
        }
        val apkPath = context.applicationInfo.sourceDir
        try {
            ZipFile(apkPath).use { zip ->
                val entry = zip.getEntry("lib/arm64-v8a/libproot.so")
                    ?: throw RuntimeException("libproot.so not found in APK")
                zip.getInputStream(entry).use { input ->
                    FileOutputStream(fallback).use { output -> input.copyTo(output) }
                }
            }
            fallback.setExecutable(true)
            prootBin = fallback
            Log.i(TAG, "Extracted proot from APK to ${fallback.absolutePath}")
            ensureLibSymlinks()
        } catch (e: Exception) {
            throw RuntimeException(
                "proot binary not found at ${File(nativeLibDir, "libproot.so").absolutePath} " +
                    "and APK extraction failed: ${e.message}"
            )
        }
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

        // Vault subdirs that proot's mkdirat can't create through bind mounts
        val vaultSubdirs = listOf(
            "etc/ellul/agent-bridge",
            "etc/ellul/shield-data",
            "etc/ellul/secrets",
            "etc/caddy/agents.d",
            "etc/caddy/app-routes.d",
            "var/log/ellul",
            "var/log/caddy",
            "var/lib/ellul-shielded/guardrail-rules/global",
            "var/lib/ellul-shielded/shield-data",
            "var/lib/postgresql",
            "run/shield",
        )
        for (sub in vaultSubdirs) {
            File(vaultDir, sub).mkdirs()
        }

        // Rootfs dirs that need to exist before proot starts
        val rootfsDirs = listOf(
            "home/dev/.local/share",
            "home/dev/.cache/opencode-bun",
            "home/dev/.ellul",
            "run/caddy",
            "tmp",
            "etc/ellul-bootstrap",
        )
        for (sub in rootfsDirs) {
            File(rootfsDir, sub).mkdirs()
        }

        ShieldVaultKeyStore.writeToVault(context, vaultDir)
        linkGlobalNodeModules()

        val cmd = buildProotCommand()
        val env = buildEnvironment()

        Log.i(TAG, "Starting proot: ${cmd.joinToString(" ")}")
        Log.d(TAG, "Proot env: ${env.entries.joinToString(", ") { "${it.key}=${it.value}" }}")

        val pb = ProcessBuilder(cmd)
        pb.environment().putAll(env)
        pb.redirectErrorStream(false)

        val proc = pb.start()
        prootProcess = proc
        startLogStreaming(proc)

        Log.i(TAG, "proot process started (pid viewable in logcat)")

        // Native Adapter Runtime Host — control plane for running adapters
        // natively (outside proot), bypassing proot's getcwd/io_uring limits.
        // Guarded: never throws into start(); never touches provisioning.
        try { nativeRuntime.start() } catch (e: Throwable) { Log.e(TAG, "nativeRuntime.start: ${e.message}") }
    }

    private fun verifyNativeCodex() {
        Thread {
            try {
                Thread.sleep(15_000) // let startup/provisioning settle (avoid mem pressure)
                val memAvailKb = try {
                    File("/proc/meminfo").readLines()
                        .firstOrNull { it.startsWith("MemAvailable") }
                        ?.filter { it.isDigit() }?.toLongOrNull() ?: 0L
                } catch (e: Throwable) { 0L }
                if (memAvailKb in 1 until 220_000) {
                    Log.w(TAG, "verifyNativeCodex: low mem ${memAvailKb}kB — skipping (safety)")
                    return@Thread
                }
                val codex = File(rootfsDir,
                    "usr/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-arm64/vendor/aarch64-unknown-linux-musl/bin/codex")
                val home = File(rootfsDir, "home/dev")
                val logFile = File(logDir, "native-codex-verify.log")
                if (!codex.exists()) {
                    Log.w(TAG, "verifyNativeCodex: codex binary missing at ${codex.absolutePath}")
                    return@Thread
                }
                val egressPort = NativeEgressProxy.ensureStarted()
                Log.i(TAG, "verifyNativeCodex: launching native codex (no proot), mem=${memAvailKb}kB egress=$egressPort")
                val pb = ProcessBuilder(
                    codex.absolutePath, "exec", "-m", "gpt-5.5",
                    "--skip-git-repo-check", "reply with only the word pineapple",
                )
                pb.environment().apply {
                    put("HOME", home.absolutePath)
                    put("CODEX_HOME", File(home, ".codex").absolutePath)
                    put("USER", "dev")
                    put("PATH", "/usr/local/bin:/usr/bin:/bin:/system/bin")
                    put("TMPDIR", "${appDir.absolutePath}/tmp")
                    // TLS trust store: native musl has no Android cert store; point at the rootfs CA bundle.
                    put("SSL_CERT_FILE", File(rootfsDir, "etc/ssl/certs/ca-certificates.crt").absolutePath)
                    put("SSL_CERT_DIR", File(rootfsDir, "etc/ssl/certs").absolutePath)
                    if (egressPort > 0) {
                        val proxy = "http://127.0.0.1:$egressPort"
                        put("HTTPS_PROXY", proxy); put("https_proxy", proxy)
                        put("HTTP_PROXY", proxy); put("http_proxy", proxy)
                        put("ALL_PROXY", proxy); put("all_proxy", proxy)
                    }
                }
                if (home.isDirectory) pb.directory(home)
                pb.redirectErrorStream(true)
                pb.redirectOutput(logFile)
                pb.redirectInput(File("/dev/null"))
                val proc = pb.start()
                val done = proc.waitFor(90, TimeUnit.SECONDS)
                if (!done) { try { proc.destroyForcibly() } catch (e: Throwable) {} }
                Log.i(TAG, "verifyNativeCodex: done=$done exit=${if (done) proc.exitValue() else -1} log=${logFile.absolutePath}")
            } catch (e: Throwable) {
                Log.e(TAG, "verifyNativeCodex: ${e.message}")
            }
        }.apply { isDaemon = true; name = "native-codex-verify"; start() }
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

    // OpenCode (Bun binary) cannot run on Android — seccomp blocks io_uring
    // in ALL app-spawned processes. The agent-bridge's opencode adapter uses
    // external server mode (OPENCODE_EXTERNAL_SERVER_URL) instead. Other
    // adapters (codex, cursor, claude) use Node.js/native binaries that work
    // inside proot via the engine's adapter.spawn TCP stdio proxy.

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
        // Spoof an old kernel so glibc/coreutils/Rust-std (swc) take the legacy
        // syscall path (openat/fstatat/faccessat) this proot handles, instead of
        // openat2/statx/faccessat2 which ENOSYS in the app's zygote-seccomp context.
        "--kernel-release=4.19.0",
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
        "TMPDIR" to "/tmp",
        "NODE_ENV" to "production",
        "ELLUL_PLATFORM" to "android",
        "ELLUL_HIGH_PORTS" to "1",
        "LD_LIBRARY_PATH" to "$nativeLibDir:${libDir.absolutePath}",
        "PROOT_LOADER" to "$nativeLibDir/libproot-loader.so",
        "PROOT_TMP_DIR" to "${appDir.absolutePath}/tmp",
        // PROOT_NO_SECCOMP intentionally NOT set: proot's seccomp-bpf acceleration
        // must be ON so its chdir/getcwd cancellation works. proot cancels those
        // syscalls via an avoider syscall; only with accel on does proot's
        // SIGSYS-suppression fire and let the exit handler post the emulated cwd.
        // With PROOT_NO_SECCOMP=1, chdir() returns ENOSYS and preview/relative
        // paths break (next can't find app/). Verified on-device 2026-05-30:
        // accel ON → engine boots healthy, chdir works, `next dev` serves.
        "UV_USE_IO_URING" to "0",
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
