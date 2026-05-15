package ai.ellul.plugins.shield

import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import app.tauri.plugin.JSObject

/**
 * Android secure storage backend for tauri-plugin-shield.
 *
 * Uses EncryptedSharedPreferences backed by a MasterKey in the Android
 * Keystore (hardware-backed TEE/StrongBox where available). This is the
 * Android equivalent of macOS Keychain / iOS Keychain that the `keyring`
 * crate uses on Apple platforms.
 *
 * The MasterKey uses AES256-GCM with the Android Keystore as provider,
 * meaning the key material never leaves hardware on devices that support it.
 */
@TauriPlugin
class ShieldPlugin(private val activity: android.app.Activity) : Plugin(activity) {

    private val prefs: SharedPreferences by lazy {
        val spec = KeyGenParameterSpec.Builder(
            MasterKey.DEFAULT_MASTER_KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build()

        val masterKey = MasterKey.Builder(activity)
            .setKeyGenParameterSpec(spec)
            .build()

        EncryptedSharedPreferences.create(
            activity,
            "ai.ellul.shield.secure",
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    }

    @Command
    fun secureStore(invoke: Invoke) {
        val args = invoke.parseArgs(JSObject::class.java)
        val key = args?.getString("key")
        val data = args?.getString("data")
        if (key.isNullOrEmpty() || data == null) {
            invoke.reject("Missing key or data argument")
            return
        }

        try {
            prefs.edit().putString(key, data).apply()
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject("Secure store failed: ${e.message}")
        }
    }

    @Command
    fun secureLoad(invoke: Invoke) {
        val args = invoke.parseArgs(JSObject::class.java)
        val key = args?.getString("key")
        if (key.isNullOrEmpty()) {
            invoke.reject("Missing key argument")
            return
        }

        try {
            val data = prefs.getString(key, null)
            val result = JSObject()
            if (data != null) {
                result.put("data", data)
            } else {
                result.put("data", JSObject.NULL)
            }
            invoke.resolve(result)
        } catch (e: Exception) {
            invoke.reject("Secure load failed: ${e.message}")
        }
    }

    @Command
    fun secureRemove(invoke: Invoke) {
        val args = invoke.parseArgs(JSObject::class.java)
        val key = args?.getString("key")
        if (key.isNullOrEmpty()) {
            invoke.reject("Missing key argument")
            return
        }

        try {
            prefs.edit().remove(key).apply()
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject("Secure remove failed: ${e.message}")
        }
    }

    @Command
    fun secureClear(invoke: Invoke) {
        val args = invoke.parseArgs(JSObject::class.java)
        val prefix = args?.getString("prefix") ?: ""

        try {
            val edit = prefs.edit()
            if (prefix.isNotEmpty()) {
                prefs.all.keys.filter { it.startsWith(prefix) }.forEach { edit.remove(it) }
            } else {
                edit.clear()
            }
            edit.apply()
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject("Secure clear failed: ${e.message}")
        }
    }
}
