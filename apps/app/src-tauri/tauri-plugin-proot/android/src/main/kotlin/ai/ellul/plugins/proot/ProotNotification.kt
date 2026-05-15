package ai.ellul.plugins.proot

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build

object ProotNotification {

    const val CHANNEL_ID = "ellul_workspace"
    const val NOTIFICATION_ID = 1001

    fun createChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return

        val channel = NotificationChannel(
            CHANNEL_ID,
            "Workspace",
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "ellul workspace service status"
            setShowBadge(false)
        }

        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.createNotificationChannel(channel)
    }

    fun build(context: Context, text: String): Notification {
        val contentIntent = context.packageManager.getLaunchIntentForPackage(context.packageName)
        val contentPending = PendingIntent.getActivity(
            context,
            0,
            contentIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val stopIntent = Intent(context, ProotService::class.java).apply {
            action = ProotService.ACTION_STOP
        }
        val stopPending = PendingIntent.getService(
            context,
            1,
            stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(context, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(context)
        }

        return builder
            .setContentTitle("ellul")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_menu_manage)
            .setContentIntent(contentPending)
            .addAction(
                Notification.Action.Builder(
                    null,
                    "Stop",
                    stopPending
                ).build()
            )
            .setOngoing(true)
            .build()
    }

    fun update(context: Context, text: String) {
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(NOTIFICATION_ID, build(context, text))
    }
}
