package ai.ellul.plugins.proot

import android.util.Log
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.atomic.AtomicInteger

/**
 * Native Adapter Runtime — egress proxy.
 *
 * Adapters running natively (outside proot) have no usable resolver: Android's
 * /etc is read-only and has no resolv.conf, and musl/glibc DNS does not consult
 * Android's netd. So a native codex/cursor's getaddrinfo() returns EAI_AGAIN.
 *
 * This is the single DNS-resolving egress point — the device's NAT-gateway
 * equivalent in the cloud-parity architecture. It is a local HTTP CONNECT proxy
 * that resolves hostnames via Android's *system* resolver (java.net, backed by
 * netd) and tunnels raw TLS/WSS through. Native adapters route their HTTPS/WSS
 * through it via HTTPS_PROXY/ALL_PROXY (codex/reqwest honor these).
 *
 * Robustness contract (the app must never crash because of this): every loop
 * and connection runs on a daemon thread wrapped in catch(Throwable); a failure
 * to start degrades to port=-1 (caller simply doesn't set the proxy env).
 */
object NativeEgressProxy {
    private const val TAG = "NativeEgressProxy"

    @Volatile private var port: Int = -1
    @Volatile private var server: ServerSocket? = null
    private val connId = AtomicInteger(0)

    /** Idempotent. Returns the listening port, or -1 if it could not start. */
    fun ensureStarted(): Int {
        val s = server
        if (port > 0 && s != null && !s.isClosed) return port
        synchronized(this) {
            val s2 = server
            if (port > 0 && s2 != null && !s2.isClosed) return port
            try {
                val ss = ServerSocket()
                ss.reuseAddress = true
                ss.bind(InetSocketAddress("127.0.0.1", 0)) // ephemeral
                server = ss
                port = ss.localPort
                Thread({ acceptLoop(ss) }, "native-egress-accept").apply { isDaemon = true; start() }
                Log.i(TAG, "egress proxy listening on 127.0.0.1:$port")
            } catch (e: Throwable) {
                Log.e(TAG, "failed to start: ${e.message}")
                port = -1
            }
        }
        return port
    }

    private fun acceptLoop(ss: ServerSocket) {
        while (!ss.isClosed) {
            try {
                val client = ss.accept()
                Thread({ handle(client) }, "native-egress-${connId.incrementAndGet()}")
                    .apply { isDaemon = true; start() }
            } catch (e: Throwable) {
                if (ss.isClosed) break
                Log.w(TAG, "accept: ${e.message}")
            }
        }
    }

    private fun handle(client: Socket) {
        var upstream: Socket? = null
        try {
            client.tcpNoDelay = true
            val input = client.getInputStream()
            // Read request line + headers up to the blank line (bounded).
            val sb = StringBuilder()
            val one = ByteArray(1)
            while (true) {
                val n = input.read(one)
                if (n <= 0) { client.close(); return }
                sb.append((one[0].toInt() and 0xFF).toChar())
                if (sb.length >= 4 && sb.endsWith("\r\n\r\n")) break
                if (sb.length > 32768) { client.close(); return }
            }
            val requestLine = sb.toString().substringBefore("\r\n")
            val parts = requestLine.split(" ")
            if (parts.size < 2 || !parts[0].equals("CONNECT", ignoreCase = true)) {
                runCatching {
                    client.getOutputStream().write("HTTP/1.1 405 Method Not Allowed\r\n\r\n".toByteArray())
                }
                client.close(); return
            }
            val hostPort = parts[1]
            val host = hostPort.substringBeforeLast(":")
            val dstPort = hostPort.substringAfterLast(":", "443").toIntOrNull() ?: 443

            upstream = Socket()
            upstream.tcpNoDelay = true
            // System resolver (netd) does the DNS here — the whole point.
            upstream.connect(InetSocketAddress(host, dstPort), 15000)

            client.getOutputStream().apply {
                write("HTTP/1.1 200 Connection Established\r\n\r\n".toByteArray()); flush()
            }

            val up = upstream
            val pumpUp = Thread({ pipe(client, up) }, "egress-c2s").apply { isDaemon = true; start() }
            pipe(up, client) // server -> client on this thread
            pumpUp.join(3000)
        } catch (e: Throwable) {
            Log.w(TAG, "tunnel ${'$'}{e.javaClass.simpleName}: ${e.message}")
        } finally {
            runCatching { client.close() }
            runCatching { upstream?.close() }
        }
    }

    private fun pipe(from: Socket, to: Socket) {
        try {
            val inp = from.getInputStream()
            val out = to.getOutputStream()
            val b = ByteArray(32768)
            while (true) {
                val n = inp.read(b)
                if (n < 0) break
                out.write(b, 0, n)
                out.flush()
            }
        } catch (e: Throwable) {
            // peer closed / reset — normal at tunnel teardown
        } finally {
            runCatching { to.shutdownOutput() }
        }
    }
}
