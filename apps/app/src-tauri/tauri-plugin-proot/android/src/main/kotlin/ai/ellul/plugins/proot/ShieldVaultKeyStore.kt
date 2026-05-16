package ai.ellul.plugins.proot

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import java.io.File

/**
 * Stores the shield vault encryption key in Android Keystore-backed
 * EncryptedSharedPreferences. The key encrypts auth-secrets.json inside
 * proot so that the agent process (which shares a UID with Shield)
 * cannot read HMAC signing keys from the filesystem.
 */
object ShieldVaultKeyStore {

    private const val TAG = "ShieldVaultKeyStore"
    private const val PREFS_NAME = "ai.ellul.proot.secure"
    private const val KEY_NAME = "shield_vault_key"

    private fun prefs(context: Context) = EncryptedSharedPreferences.create(
        context,
        PREFS_NAME,
        MasterKey.Builder(context)
            .setKeyGenParameterSpec(
                KeyGenParameterSpec.Builder(
                    MasterKey.DEFAULT_MASTER_KEY_ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
                )
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build()
            )
            .build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

    fun store(context: Context, hexKey: String) {
        prefs(context).edit().putString(KEY_NAME, hexKey).apply()
        Log.i(TAG, "Shield vault key stored in Android Keystore")
    }

    /**
     * Write the vault key to a file inside the vault directory so the
     * engine (running inside proot) can read it at startup. The engine
     * deletes the file immediately after reading.
     *
     * @return true if the key was written, false if no key exists yet
     */
    fun writeToVault(context: Context, vaultDir: File): Boolean {
        val key = prefs(context).getString(KEY_NAME, null) ?: return false
        val keyDir = File(vaultDir, "run/shield")
        keyDir.mkdirs()
        File(keyDir, "vault-key").writeText(key)
        Log.i(TAG, "Shield vault key written for engine")
        return true
    }
}
