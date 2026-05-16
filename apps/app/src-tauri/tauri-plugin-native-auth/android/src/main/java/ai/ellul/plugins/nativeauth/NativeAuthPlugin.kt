package ai.ellul.plugins.nativeauth

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import androidx.browser.customtabs.CustomTabsIntent
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import app.tauri.plugin.JSObject
import com.google.firebase.messaging.FirebaseMessaging

@TauriPlugin
class NativeAuthPlugin(private val activity: Activity) : Plugin(activity) {

    /**
     * Apple Sign In is not available on Android.
     * The frontend should not call this on Android.
     */
    @Command
    fun signInApple(invoke: Invoke) {
        invoke.reject("Apple Sign In is not available on Android")
    }

    /**
     * Open OAuth URL in Chrome Custom Tabs.
     * This is the proper way to handle OAuth on Android --
     * Custom Tabs share cookies with Chrome, provide a native feel,
     * and Google explicitly requires this for their OAuth.
     */
    @Command
    fun openOauthBrowser(invoke: Invoke) {
        val url = invoke.parseArgs(String::class.java)
        if (url.isNullOrEmpty()) {
            invoke.reject("Missing url argument")
            return
        }

        try {
            val customTabsIntent = CustomTabsIntent.Builder()
                .setShowTitle(true)
                .build()

            customTabsIntent.launchUrl(activity, Uri.parse(url))
            invoke.resolve()
        } catch (e: Exception) {
            // Fallback to regular browser if Custom Tabs unavailable
            try {
                val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
                activity.startActivity(intent)
                invoke.resolve()
            } catch (e2: Exception) {
                invoke.reject("Failed to open browser: ${e2.message}")
            }
        }
    }

    /**
     * Trigger haptic feedback using the device vibrator.
     * Intensity levels: light, medium, heavy.
     */
    @Command
    fun hapticFeedback(invoke: Invoke) {
        val args = invoke.parseArgs(JSObject::class.java)
        val intensity = args?.getString("intensity")
        if (intensity.isNullOrEmpty()) {
            invoke.reject("Missing intensity argument")
            return
        }

        try {
            val vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val vibratorManager = activity.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager
                vibratorManager.defaultVibrator
            } else {
                @Suppress("DEPRECATION")
                activity.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
            }

            if (!vibrator.hasVibrator()) {
                // Device has no vibrator — silently succeed
                invoke.resolve()
                return
            }

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val (duration, amplitude) = when (intensity) {
                    "light" -> Pair(30L, 80)
                    "medium" -> Pair(50L, 150)
                    "heavy" -> Pair(100L, 255)
                    else -> {
                        invoke.reject("Invalid intensity: $intensity. Must be light, medium, or heavy")
                        return
                    }
                }
                vibrator.vibrate(VibrationEffect.createOneShot(duration, amplitude))
            } else {
                // Pre-Oreo fallback: duration-only vibration
                @Suppress("DEPRECATION")
                val duration = when (intensity) {
                    "light" -> 30L
                    "medium" -> 50L
                    "heavy" -> 100L
                    else -> {
                        invoke.reject("Invalid intensity: $intensity. Must be light, medium, or heavy")
                        return
                    }
                }
                @Suppress("DEPRECATION")
                vibrator.vibrate(duration)
            }

            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject("Haptic feedback failed: ${e.message}")
        }
    }

    /**
     * Copy text to the system clipboard.
     */
    @Command
    fun copyToClipboard(invoke: Invoke) {
        val args = invoke.parseArgs(JSObject::class.java)
        val text = args?.getString("text")
        if (text.isNullOrEmpty()) {
            invoke.reject("Missing text argument")
            return
        }

        val label = args.getString("label") ?: "ellul.ai"

        try {
            val clipboard = activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            val clip = ClipData.newPlainText(label, text)
            clipboard.setPrimaryClip(clip)
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject("Clipboard operation failed: ${e.message}")
        }
    }

    /**
     * Share content via the system share sheet.
     */
    @Command
    fun share(invoke: Invoke) {
        val args = invoke.parseArgs(JSObject::class.java)
        val text = args?.getString("text")
        val title = args?.getString("title")
        val url = args?.getString("url")

        // Build the share text: combine text and url if both provided
        val shareText = listOfNotNull(text, url).joinToString("\n")
        if (shareText.isEmpty()) {
            invoke.reject("Nothing to share: provide text or url")
            return
        }

        try {
            val sendIntent = Intent().apply {
                action = Intent.ACTION_SEND
                putExtra(Intent.EXTRA_TEXT, shareText)
                if (!title.isNullOrEmpty()) {
                    putExtra(Intent.EXTRA_SUBJECT, title)
                }
                type = "text/plain"
            }

            val chooser = Intent.createChooser(sendIntent, title ?: "Share")
            activity.startActivity(chooser)
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject("Share failed: ${e.message}")
        }
    }

    /**
     * Register for FCM push notifications and return the device token.
     * Uses Firebase Cloud Messaging to get the registration token.
     */
    @Command
    fun registerPush(invoke: Invoke) {
        try {
            FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
                if (!task.isSuccessful) {
                    invoke.reject("FCM token retrieval failed: ${task.exception?.message}")
                    return@addOnCompleteListener
                }

                val token = task.result
                if (token != null) {
                    val result = JSObject()
                    result.put("token", token)
                    invoke.resolve(result)
                } else {
                    invoke.reject("FCM token is null")
                }
            }
        } catch (e: Exception) {
            invoke.reject("Push registration failed: ${e.message}")
        }
    }
}
