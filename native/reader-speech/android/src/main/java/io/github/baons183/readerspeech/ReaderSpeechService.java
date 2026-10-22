package io.github.baons183.readerspeech;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

/** Dịch vụ chạy nền giữ cho giọng đọc tiếp tục khi tắt màn hình, kèm nút điều khiển trên thông báo. */
public class ReaderSpeechService extends Service {

    private static final String CHANNEL_ID = "reader_speech";
    private static final int NOTIFICATION_ID = 4107;
    private static final String ACTION_TOGGLE = "io.github.baons183.readerspeech.TOGGLE";
    private static final String ACTION_NEXT = "io.github.baons183.readerspeech.NEXT";
    private static final String ACTION_PREVIOUS = "io.github.baons183.readerspeech.PREVIOUS";
    private static final String ACTION_STOP = "io.github.baons183.readerspeech.STOP";

    private static ReaderSpeechService running;

    static void start(Context context) {
        ContextCompat.startForegroundService(context, new Intent(context, ReaderSpeechService.class));
    }

    static void stop(Context context) {
        if (running != null) {
            ServiceCompat.stopForeground(running, ServiceCompat.STOP_FOREGROUND_REMOVE);
            running.stopSelf();
        }
    }

    static void refresh() {
        if (running == null) return;
        NotificationManager manager = (NotificationManager) running.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) manager.notify(NOTIFICATION_ID, running.buildNotification());
    }

    @Override
    public void onCreate() {
        super.onCreate();
        running = this;
        createChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK : 0;
        ServiceCompat.startForeground(this, NOTIFICATION_ID, buildNotification(), type);
        String action = intent != null ? intent.getAction() : null;
        if (action != null) {
            SpeechEngine engine = SpeechEngine.get(this);
            switch (action) {
                case ACTION_TOGGLE:
                    engine.togglePause();
                    break;
                case ACTION_NEXT:
                    engine.skipChapter(1);
                    break;
                case ACTION_PREVIOUS:
                    engine.skipChapter(-1);
                    break;
                case ACTION_STOP:
                    engine.stop();
                    break;
                default:
                    break;
            }
        }
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        if (running == this) running = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "Nghe sách", NotificationManager.IMPORTANCE_LOW);
        channel.setShowBadge(false);
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.createNotificationChannel(channel);
    }

    private PendingIntent actionIntent(String action, int requestCode) {
        Intent intent = new Intent(this, ReaderSpeechService.class).setAction(action);
        return PendingIntent.getService(this, requestCode, intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private Notification buildNotification() {
        SpeechEngine engine = SpeechEngine.get(this);
        boolean playing = "playing".equals(engine.getState());
        Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent contentIntent = launch == null
            ? null
            : PendingIntent.getActivity(this, 0, launch, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        String title = engine.getChapterTitle();
        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentTitle(title.isEmpty() ? "Đang đọc sách" : title)
            .setContentText(engine.getBookTitle())
            .setContentIntent(contentIntent)
            .setOngoing(playing)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
            .addAction(android.R.drawable.ic_media_previous, "Chương trước", actionIntent(ACTION_PREVIOUS, 1))
            .addAction(
                playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
                playing ? "Tạm dừng" : "Tiếp tục",
                actionIntent(ACTION_TOGGLE, 2)
            )
            .addAction(android.R.drawable.ic_media_next, "Chương sau", actionIntent(ACTION_NEXT, 3))
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Dừng", actionIntent(ACTION_STOP, 4))
            .build();
    }
}
