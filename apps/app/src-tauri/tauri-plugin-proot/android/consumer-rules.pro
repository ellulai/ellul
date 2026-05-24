# Tauri JNI bridge — called from Rust via run_mobile_plugin
-keep class ai.ellul.plugins.proot.ProotPlugin { *; }

# Android manifest components
-keep class ai.ellul.plugins.proot.ProotService { *; }

# Data classes crossing JNI/JSON boundary
-keep class ai.ellul.plugins.proot.UpdateInfo { <fields>; }
-keep class ai.ellul.plugins.proot.UpdateProgress { <fields>; }
-keep class ai.ellul.plugins.proot.UpdateStage { *; }
-keep class ai.ellul.plugins.proot.SetupStage { *; }
-keep class ai.ellul.plugins.proot.ProotService$ServiceStatusData { <fields>; }
-keep class ai.ellul.plugins.proot.ProotService$BatteryState { *; }
-keep class ai.ellul.plugins.proot.PowerController$BatteryAction { *; }

# BroadcastReceiver — dynamically registered
-keep class ai.ellul.plugins.proot.NetworkChangeReceiver { *; }

# BouncyCastle PQC — Security.addProvider() + KeyFactory/Signature.getInstance() use reflection
-keep class org.bouncycastle.pqc.jcajce.provider.** { *; }
-keep class org.bouncycastle.pqc.crypto.mldsa.** { *; }
-keep class org.bouncycastle.pqc.crypto.crystals.dilithium.** { *; }
-dontwarn org.bouncycastle.**

# zstd-jni — JNI native bridge
-keepclasseswithmembernames class com.github.luben.zstd.** { native <methods>; }
-keep class com.github.luben.zstd.ZstdInputStream { *; }
-keep class com.github.luben.zstd.ZstdOutputStream { *; }

# Apache Commons Compress — tar parsing + ServiceLoader codec discovery
-keep class org.apache.commons.compress.archivers.tar.TarArchiveInputStream { *; }
-keep class org.apache.commons.compress.archivers.tar.TarArchiveEntry { *; }
-keep class org.apache.commons.compress.compressors.CompressorStreamFactory { *; }
# Optional codecs referenced by Commons Compress but not bundled
-dontwarn org.tukaani.xz.**
-dontwarn org.brotli.dec.**
