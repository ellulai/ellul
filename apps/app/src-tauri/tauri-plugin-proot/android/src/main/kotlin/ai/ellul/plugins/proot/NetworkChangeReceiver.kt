package ai.ellul.plugins.proot

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.util.Log

class NetworkChangeReceiver(private val context: Context) {

    companion object {
        const val TAG = "NetworkChangeReceiver"
        private const val DEBOUNCE_MS = 2_000L
    }

    private var callback: ConnectivityManager.NetworkCallback? = null
    private var lastReconnectTime = 0L
    private var onReconnect: (() -> Unit)? = null

    fun register(onReconnect: () -> Unit) {
        this.onReconnect = onReconnect
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val request = NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build()

        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                triggerReconnect("network available")
            }

            override fun onLost(network: Network) {
                Log.i(TAG, "Network lost — tunnel will reconnect when network returns")
            }

            override fun onCapabilitiesChanged(
                network: Network,
                networkCapabilities: NetworkCapabilities
            ) {
                triggerReconnect("capabilities changed")
            }
        }

        cm.registerNetworkCallback(request, cb)
        callback = cb
        Log.i(TAG, "Registered network callback")
    }

    fun unregister() {
        val cb = callback ?: return
        try {
            val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
            cm.unregisterNetworkCallback(cb)
        } catch (e: Exception) {
            Log.w(TAG, "Failed to unregister network callback: ${e.message}")
        }
        callback = null
        onReconnect = null
        Log.i(TAG, "Unregistered network callback")
    }

    private fun triggerReconnect(reason: String) {
        val now = System.currentTimeMillis()
        if (now - lastReconnectTime < DEBOUNCE_MS) return
        lastReconnectTime = now
        Log.i(TAG, "Triggering tunnel reconnect: $reason")
        onReconnect?.invoke()
    }
}
