package ai.ellul.plugins.proot

import android.util.Log
import java.io.BufferedReader
import java.io.File
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.InetSocketAddress
import java.net.Socket

object EngineRpc {
    private const val TAG = "EngineRpc"
    private const val PORT = 7710
    private const val CONNECT_TIMEOUT_MS = 5000
    private const val READ_TIMEOUT_MS = 10000
    private const val MAX_RETRIES = 2
    private const val RETRY_DELAY_MS = 500L

    fun call(
        rootfsDir: File,
        method: String,
        params: org.json.JSONObject = org.json.JSONObject(),
    ): org.json.JSONObject {
        var lastException: Exception? = null
        for (attempt in 0..MAX_RETRIES) {
            if (attempt > 0) Thread.sleep(RETRY_DELAY_MS * attempt)
            try {
                return callOnce(rootfsDir, method, params)
            } catch (e: Exception) {
                lastException = e
                if (e.message?.contains("unauthorized") == true) throw e
                Log.w(TAG, "$method attempt ${attempt + 1} failed: ${e.message}")
            }
        }
        throw lastException!!
    }

    fun callBestEffort(
        rootfsDir: File,
        method: String,
        params: org.json.JSONObject = org.json.JSONObject(),
    ): Exception? {
        return try {
            call(rootfsDir, method, params)
            null
        } catch (e: Exception) {
            Log.w(TAG, "$method best-effort failed after retries: ${e.message}")
            e
        }
    }

    private fun callOnce(
        rootfsDir: File,
        method: String,
        params: org.json.JSONObject,
    ): org.json.JSONObject {
        val secretFile = File(rootfsDir, "tmp/ellul-engine-secret")
        val secret = if (secretFile.exists()) secretFile.readText().trim() else ""

        val request = org.json.JSONObject().apply {
            put("jsonrpc", "2.0")
            put("id", 1)
            put("method", method)
            put("params", params)
            put("auth", secret)
        }

        val socket = Socket()
        socket.connect(InetSocketAddress("127.0.0.1", PORT), CONNECT_TIMEOUT_MS)
        socket.soTimeout = READ_TIMEOUT_MS

        try {
            val writer = OutputStreamWriter(socket.getOutputStream(), Charsets.UTF_8)
            val reader = BufferedReader(InputStreamReader(socket.getInputStream(), Charsets.UTF_8))

            writer.write(request.toString() + "\n")
            writer.flush()

            val line = reader.readLine() ?: throw Exception("no response from engine")
            val response = org.json.JSONObject(line)

            if (response.has("error") && !response.isNull("error")) {
                val error = response.getJSONObject("error")
                throw Exception(error.getString("message"))
            }

            return when (val result = response.opt("result")) {
                is org.json.JSONObject -> result
                null -> org.json.JSONObject()
                else -> org.json.JSONObject().put("value", result)
            }
        } finally {
            socket.close()
        }
    }
}
