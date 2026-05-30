package ai.ellul.plugins.proot

import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.InputStream
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.atomic.AtomicInteger

/**
 * Native Adapter Runtime Host — the cloud-parity control plane for running AI
 * adapters on Android WITHOUT proot.
 *
 * Why: proot (a ptrace syscall emulator) breaks getcwd in the app's seccomp
 * context and can't run io_uring (Bun). Running the adapters natively avoids
 * both, but native binaries lose the environment proot synthesized from the
 * rootfs (paths under /home/dev, /etc/resolv.conf, /etc/ssl). This Host
 * re-provides that environment explicitly, the way a cloud runtime gives a
 * workload its sandboxed view:
 *
 *   - launch:  static musl binaries (codex) exec directly; glibc binaries and
 *              node scripts run via the rootfs's ld-linux loader + library path.
 *   - paths:   guest paths (/home/dev/...) are translated to real rootfs paths
 *              (/data/.../rootfs/home/dev/...) for cmd/cwd/args/env.
 *   - DNS:     routed through NativeEgressProxy (resolves via Android netd).
 *   - TLS:     SSL_CERT_FILE/DIR point at the rootfs CA bundle.
 *   - stdio:   a per-spawn 127.0.0.1 TCP proxy pipes the child's stdin/stdout to
 *              the bridge — byte-identical to the engine's adapter.spawn proxy,
 *              so the bridge's existing AndroidEngineChildProcessSpawner talks to
 *              this Host unchanged (just a different port).
 *
 * RPC (newline-delimited JSON, mirrors engine adapter.spawn on 7710):
 *   -> {"id":N,"auth":SECRET,"method":"adapter.spawn",
 *       "params":{"cmd":..,"args":[..],"env":{..},"cwd":..}}
 *   <- {"id":N,"result":{"ok":true,"pid":P,"proxyPort":PP}}
 *
 * Robustness: every loop/handler is a daemon thread wrapped in catch(Throwable);
 * a failure degrades to an RPC error or a dead listener — it never crashes the
 * app or touches provisioning/the rootfs download.
 */
class NativeAdapterRuntime(
    private val rootfsDir: File,
    private val appDir: File,
) {
    companion object {
        private const val TAG = "NativeAdapterRuntime"
        const val RPC_PORT = 7720
    }

    private val secretFile = File(rootfsDir, "tmp/ellul-engine-secret")
    private val spawnId = AtomicInteger(0)
    @Volatile private var rpcServer: ServerSocket? = null
    @Volatile private var started = false

    fun start() {
        synchronized(this) { if (started) return; started = true } // one Host per app process
        try {
            NativeEgressProxy.ensureStarted()
            Thread({ rpcLoop() }, "nar-rpc").apply { isDaemon = true; start() }
        } catch (e: Throwable) {
            Log.e(TAG, "start: ${e.message}")
        }
    }

    // ── RPC ─────────────────────────────────────────────────────────────────

    private fun rpcLoop() {
        // Bind with retry: on app restart the previous instance may still hold
        // the port briefly (TIME_WAIT / not-yet-reaped) — retry rather than
        // leaving the Host down.
        var ss: ServerSocket? = null
        for (attempt in 1..30) {
            try {
                val s = ServerSocket()
                s.reuseAddress = true
                s.bind(InetSocketAddress("127.0.0.1", RPC_PORT))
                ss = s; break
            } catch (e: Throwable) {
                if (attempt == 1 || attempt % 10 == 0) Log.w(TAG, "bind attempt $attempt: ${e.message}")
                try { Thread.sleep(500) } catch (_: Throwable) {}
            }
        }
        if (ss == null) { Log.e(TAG, "could not bind $RPC_PORT after retries"); return }
        try {
            rpcServer = ss
            Log.i(TAG, "RPC listening on 127.0.0.1:$RPC_PORT")
            while (!ss.isClosed) {
                try {
                    val c = ss.accept()
                    Thread({ handleRpc(c) }, "nar-rpc-${spawnId.incrementAndGet()}")
                        .apply { isDaemon = true; start() }
                } catch (e: Throwable) {
                    if (ss.isClosed) break
                    Log.w(TAG, "accept: ${e.message}")
                }
            }
        } catch (e: Throwable) {
            Log.e(TAG, "rpcLoop: ${e.message}")
        }
    }

    private fun handleRpc(client: Socket) {
        try {
            val line = readLine(client.getInputStream()) ?: run { client.close(); return }
            val req = JSONObject(line)
            val id = req.opt("id")
            if (req.optString("auth") != readSecret()) {
                writeResult(client, id, JSONObject().put("error", "unauthorized"), isError = true)
                client.close(); return
            }
            when (req.optString("method")) {
                "adapter.spawn" -> handleSpawn(client, id, req.optJSONObject("params") ?: JSONObject())
                "ping" -> { writeResult(client, id, JSONObject().put("ok", true)); client.close() }
                else -> { writeResult(client, id, JSONObject().put("error", "unknown method"), isError = true); client.close() }
            }
        } catch (e: Throwable) {
            Log.w(TAG, "handleRpc: ${e.message}")
            runCatching { client.close() }
        }
    }

    // ── adapter.spawn ─────────────────────────────────────────────────────────

    private fun handleSpawn(rpc: Socket, id: Any?, params: JSONObject) {
        try {
            val cmd = params.optString("cmd")
            if (cmd.isEmpty()) { writeResult(rpc, id, JSONObject().put("error", "cmd required"), isError = true); rpc.close(); return }
            val args = params.optJSONArray("args").toStringList()
            val envIn = params.optJSONObject("env").toStringMap()
            val cwdIn = params.optString("cwd", "")

            val launch = buildNativeCommand(cmd, args)
            val env = buildEnv(envIn)
            val realCwd = if (cwdIn.isNotEmpty()) toReal(cwdIn) else File(rootfsDir, "home/dev").absolutePath

            Log.i(TAG, "spawn: ${launch.take(3).joinToString(" ")} … cwd=$realCwd")

            val pb = ProcessBuilder(launch)
            pb.environment().clear()
            pb.environment().putAll(env)
            File(realCwd).let { if (it.isDirectory) pb.directory(it) }
            pb.redirectErrorStream(false)
            val child = pb.start()
            val pid = pidOf(child)

            // Drain stderr → log (must NOT go on the stdio socket; it corrupts JSON-RPC).
            Thread({ drainToLog(child.errorStream, pid) }, "nar-stderr-$pid").apply { isDaemon = true; start() }

            // Per-spawn stdio proxy.
            val proxy = ServerSocket()
            proxy.reuseAddress = true
            proxy.bind(InetSocketAddress("127.0.0.1", 0))
            val proxyPort = proxy.localPort
            Thread({ serveStdioProxy(proxy, child, pid) }, "nar-proxy-$pid").apply { isDaemon = true; start() }

            // Close the proxy listener when the child dies.
            Thread({
                try { child.waitFor() } catch (_: Throwable) {}
                Log.i(TAG, "spawn: pid=$pid exited code=${runCatching { child.exitValue() }.getOrNull()} proxy=$proxyPort")
                runCatching { proxy.close() }
            }, "nar-wait-$pid").apply { isDaemon = true; start() }

            writeResult(rpc, id, JSONObject().put("ok", true).put("pid", pid).put("proxyPort", proxyPort))
            rpc.close()
        } catch (e: Throwable) {
            Log.e(TAG, "handleSpawn: ${e.message}")
            runCatching { writeResult(rpc, id, JSONObject().put("error", e.message ?: "spawn failed"), isError = true) }
            runCatching { rpc.close() }
        }
    }

    /** The bridge connects here; pipe stdin/stdout with the engine's exact semantics. */
    private fun serveStdioProxy(proxy: ServerSocket, child: Process, pid: Int) {
        try {
            proxy.use {
                val sock = it.accept()
                sock.tcpNoDelay = true
                // socket -> child stdin. end:false — never EOF a persistent server's stdin.
                val toStdin = Thread({
                    try {
                        val inp = sock.getInputStream(); val out = child.outputStream
                        val b = ByteArray(32768)
                        while (true) { val n = inp.read(b); if (n < 0) { Log.i(TAG, "proxy[$pid]: c2s socket EOF (bridge half-closed write)"); break }; out.write(b, 0, n); out.flush() }
                    } catch (e: Throwable) { Log.i(TAG, "proxy[$pid]: c2s error: ${e.message}") }
                    // Intentionally do NOT close child.outputStream here.
                }, "nar-c2s-$pid").apply { isDaemon = true; start() }
                // child stdout -> socket.
                var endReason = "?"
                try {
                    val inp = child.inputStream; val out = sock.getOutputStream()
                    val b = ByteArray(32768)
                    while (true) { val n = inp.read(b); if (n < 0) { endReason = "codex stdout EOF"; break }; out.write(b, 0, n); out.flush() }
                } catch (e: Throwable) { endReason = "s2c socket write error: ${e.message}" }
                Log.i(TAG, "proxy[$pid]: s2c ended — $endReason (childAlive=${child.isAlive})")
                runCatching { sock.shutdownOutput() }
                runCatching { sock.close() }
                toStdin.join(1000)
            }
        } catch (e: Throwable) {
            Log.i(TAG, "proxy[$pid]: listener closed: ${e.message}")
        } finally {
            // Socket teardown means the bridge is done with this child → terminate it.
            val wasAlive = child.isAlive
            runCatching { if (child.isAlive) child.destroy() }
            Log.i(TAG, "proxy[$pid]: finalizer destroyed child (wasAlive=$wasAlive)")
        }
    }

    // ── launch resolution ──────────────────────────────────────────────────

    private fun buildNativeCommand(cmd: String, args: List<String>): List<String> {
        val realCmd = toReal(cmd)
        val translatedArgs = args.map { translateArg(it) }
        val head = readHead(File(realCmd))
        return when {
            head.startsWith("#!/usr/bin/env node") || head.startsWith("#!/usr/bin/node") ->
                viaLoader(toReal("/usr/bin/node"), listOf(realCmd) + translatedArgs)
            head.startsWith("#!/bin/bash") || head.startsWith("#!/usr/bin/env bash") ->
                viaLoader(toReal("/bin/bash"), listOf(realCmd) + translatedArgs)
            isDynamic(File(realCmd)) ->
                viaLoader(realCmd, translatedArgs)
            else -> // static (musl) binary — e.g. codex
                listOf(realCmd) + translatedArgs
        }
    }

    /** Run a glibc binary via the rootfs ld-linux loader + library path. */
    private fun viaLoader(realBinary: String, args: List<String>): List<String> {
        val loader = File(rootfsDir, "lib/ld-linux-aarch64.so.1").absolutePath
        if (!File(loader).exists()) return listOf(realBinary) + args // fallback: try direct
        val libPath = listOf("lib/aarch64-linux-gnu", "usr/lib/aarch64-linux-gnu", "usr/lib", "lib")
            .joinToString(":") { File(rootfsDir, it).absolutePath }
        return listOf(loader, "--library-path", libPath, realBinary) + args
    }

    private fun readHead(f: File): String = try {
        f.inputStream().use { val b = ByteArray(256); val n = it.read(b); if (n > 0) String(b, 0, n, Charsets.ISO_8859_1) else "" }
    } catch (e: Throwable) { "" }

    /** Dynamic (glibc) binaries name the ld-linux interpreter; static (musl) don't. */
    private fun isDynamic(f: File): Boolean = try {
        f.inputStream().use { ins ->
            val b = ByteArray(65536); val n = ins.read(b)
            if (n <= 0) false else String(b, 0, n, Charsets.ISO_8859_1).contains("ld-linux-aarch64")
        }
    } catch (e: Throwable) { false }

    // ── path + env translation ───────────────────────────────────────────────

    private val guestPrefixes = listOf("/home", "/root", "/tmp", "/opt", "/usr", "/etc", "/var", "/bin", "/sbin", "/lib")

    private fun toReal(guestPath: String): String {
        if (guestPath.isEmpty() || !guestPath.startsWith("/")) return guestPath
        val root = rootfsDir.absolutePath
        if (guestPath.startsWith(root)) return guestPath
        return root + guestPath
    }

    /** Translate an arg only if it is clearly an absolute guest path. */
    private fun translateArg(arg: String): String =
        if (arg.startsWith("/") && guestPrefixes.any { arg == it || arg.startsWith("$it/") }) toReal(arg) else arg

    private fun buildEnv(spawnEnv: Map<String, String>): Map<String, String> {
        val e = HashMap<String, String>()
        e["PATH"] = "/usr/local/bin:/usr/bin:/bin:/system/bin"
        e["USER"] = "dev"
        e["TMPDIR"] = File(appDir, "tmp").absolutePath
        // Caller-supplied env, translating clear guest paths to real ones.
        for ((k, v) in spawnEnv) {
            e[k] = if (v.startsWith("/") && guestPrefixes.any { v == it || v.startsWith("$it/") }) toReal(v) else v
        }
        // Native-environment essentials (proot used to synthesize these).
        val home = File(rootfsDir, "home/dev").absolutePath
        e["HOME"] = home
        e.putIfAbsent("CODEX_HOME", File(rootfsDir, "home/dev/.codex").absolutePath)
        e["SSL_CERT_FILE"] = File(rootfsDir, "etc/ssl/certs/ca-certificates.crt").absolutePath
        e["SSL_CERT_DIR"] = File(rootfsDir, "etc/ssl/certs").absolutePath
        val egress = NativeEgressProxy.ensureStarted()
        if (egress > 0) {
            val p = "http://127.0.0.1:$egress"
            for (k in listOf("HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "all_proxy")) e[k] = p
        }
        return e
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    private fun readSecret(): String = try { secretFile.readText().trim() } catch (e: Throwable) { "" }

    private fun pidOf(p: Process): Int = try { p.javaClass.getMethod("pid").invoke(p).toString().toIntOrNull() ?: -1 } catch (e: Throwable) { -1 }

    private fun drainToLog(stream: InputStream, pid: Int) {
        try {
            stream.bufferedReader().forEachLine { Log.d("nar-child-$pid", it) }
        } catch (e: Throwable) {}
    }

    private fun readLine(input: InputStream): String? {
        val sb = StringBuilder()
        val one = ByteArray(1)
        while (true) {
            val n = input.read(one)
            if (n <= 0) return if (sb.isEmpty()) null else sb.toString()
            val c = (one[0].toInt() and 0xFF).toChar()
            if (c == '\n') return sb.toString()
            sb.append(c)
            if (sb.length > 1_048_576) return sb.toString()
        }
    }

    private fun writeResult(sock: Socket, id: Any?, payload: JSONObject, isError: Boolean = false) {
        val resp = JSONObject().put("id", id ?: JSONObject.NULL)
        if (isError) resp.put("error", payload.opt("error") ?: payload) else resp.put("result", payload)
        sock.getOutputStream().apply { write((resp.toString() + "\n").toByteArray()); flush() }
    }

    private fun JSONArray?.toStringList(): List<String> {
        if (this == null) return emptyList()
        return (0 until length()).map { optString(it) }
    }

    private fun JSONObject?.toStringMap(): Map<String, String> {
        if (this == null) return emptyMap()
        val m = HashMap<String, String>()
        val keys = keys()
        while (keys.hasNext()) { val k = keys.next(); m[k] = optString(k) }
        return m
    }
}
