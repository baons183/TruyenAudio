package io.github.baons183.readerspeech;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.speech.tts.Voice;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

@CapacitorPlugin(name = "ReaderSpeech")
public class ReaderSpeechPlugin extends Plugin {

    private SpeechEngine engine;

    @Override
    public void load() {
        engine = SpeechEngine.get(getContext());
        engine.setListener(new SpeechEngine.Listener() {
            @Override
            public void onChapterChange(int index, String title) {
                JSObject data = new JSObject();
                data.put("index", index);
                data.put("title", title);
                notifyListeners("chapterChange", data);
            }

            @Override
            public void onState(String state) {
                JSObject data = new JSObject();
                data.put("state", state);
                notifyListeners("state", data);
            }
        });
    }

    @PluginMethod
    public void getVoices(PluginCall call) {
        engine.whenReady(() -> {
            JSArray list = new JSArray();
            Set<Voice> voices = engine.getVoices();
            if (voices != null) {
                for (Voice voice : voices) {
                    JSObject item = new JSObject();
                    item.put("id", voice.getName());
                    item.put("name", voice.getName());
                    item.put("lang", voice.getLocale().toLanguageTag());
                    item.put("quality", voice.getQuality());
                    item.put("network", voice.isNetworkConnectionRequired());
                    list.put(item);
                }
            }
            JSObject result = new JSObject();
            result.put("voices", list);
            call.resolve(result);
        });
    }

    @PluginMethod
    public void start(PluginCall call) {
        List<SpeechEngine.Chapter> chapters = parseChapters(call.getArray("chapters"));
        if (chapters.isEmpty()) {
            call.reject("Không có nội dung để đọc.");
            return;
        }
        requestNotificationPermission();
        int startChapter = call.getInt("startChapter", 0);
        String voiceId = call.getString("voiceId");
        float rate = call.getFloat("rate", 1f);
        float volume = call.getFloat("volume", 1f);
        String bookTitle = call.getString("bookTitle", "");
        engine.whenReady(() -> {
            if (!engine.isReady()) {
                call.reject("Máy chưa có bộ đọc văn bản (Text-to-speech).");
                return;
            }
            engine.start(chapters, startChapter, voiceId, rate, volume, bookTitle);
            call.resolve();
        });
    }

    @PluginMethod
    public void appendChapters(PluginCall call) {
        List<SpeechEngine.Chapter> chapters = parseChapters(call.getArray("chapters"));
        engine.whenReady(() -> {
            engine.appendChapters(chapters);
            call.resolve();
        });
    }

    @PluginMethod
    public void prependChapters(PluginCall call) {
        List<SpeechEngine.Chapter> chapters = parseChapters(call.getArray("chapters"));
        engine.whenReady(() -> {
            engine.prependChapters(chapters);
            call.resolve();
        });
    }

    @PluginMethod
    public void pause(PluginCall call) {
        engine.whenReady(() -> {
            engine.pause();
            call.resolve();
        });
    }

    @PluginMethod
    public void resume(PluginCall call) {
        engine.whenReady(() -> {
            engine.resume();
            call.resolve();
        });
    }

    @PluginMethod
    public void stop(PluginCall call) {
        engine.whenReady(() -> {
            engine.stop();
            call.resolve();
        });
    }

    @PluginMethod
    public void next(PluginCall call) {
        engine.whenReady(() -> {
            engine.skipChapter(1);
            call.resolve();
        });
    }

    @PluginMethod
    public void previous(PluginCall call) {
        engine.whenReady(() -> {
            engine.skipChapter(-1);
            call.resolve();
        });
    }

    @PluginMethod
    public void setOptions(PluginCall call) {
        Float rate = call.getFloat("rate");
        Float volume = call.getFloat("volume");
        String voiceId = call.getString("voiceId");
        engine.whenReady(() -> {
            engine.setOptions(rate, volume, voiceId);
            call.resolve();
        });
    }

    private void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT < 33 || getActivity() == null) return;
        String permission = Manifest.permission.POST_NOTIFICATIONS;
        if (ContextCompat.checkSelfPermission(getContext(), permission) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(getActivity(), new String[] { permission }, 4107);
        }
    }

    private List<SpeechEngine.Chapter> parseChapters(JSONArray array) {
        List<SpeechEngine.Chapter> result = new ArrayList<>();
        if (array == null) return result;
        for (int i = 0; i < array.length(); i++) {
            JSONObject item = array.optJSONObject(i);
            if (item == null || !item.has("index")) continue;
            result.add(new SpeechEngine.Chapter(item.optInt("index"), item.optString("title", ""), item.optString("text", "")));
        }
        return result;
    }
}
