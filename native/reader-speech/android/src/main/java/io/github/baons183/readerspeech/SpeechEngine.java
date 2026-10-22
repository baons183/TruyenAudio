package io.github.baons183.readerspeech;

import android.content.Context;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;
import java.text.BreakIterator;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Bộ máy đọc dùng chung cho plugin và dịch vụ chạy nền.
 * Giữ danh sách chương phía native để tự đọc tiếp khi tắt màn hình.
 */
public class SpeechEngine implements TextToSpeech.OnInitListener {

    public interface Listener {
        void onChapterChange(int index, String title);

        void onState(String state);
    }

    public static class Chapter {
        final int index;
        final String title;
        final String text;

        public Chapter(int index, String title, String text) {
            this.index = index;
            this.title = title;
            this.text = text;
        }
    }

    private static SpeechEngine instance;

    public static synchronized SpeechEngine get(Context context) {
        if (instance == null) {
            instance = new SpeechEngine(context.getApplicationContext());
        }
        return instance;
    }

    private final Context context;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final TextToSpeech tts;
    private final List<Runnable> pendingInit = new ArrayList<>();
    private boolean initDone = false;
    private boolean ready = false;

    private final List<Chapter> chapters = new ArrayList<>();
    private int chapterPos = 0;
    private List<String> chunks = new ArrayList<>();
    private int chunkIndex = 0;
    private int generation = 0;
    private String currentUtteranceId = null;
    private String voiceName = null;
    private Voice selectedVoice = null;
    private float rate = 1f;
    private float volume = 1f;
    private String bookTitle = "";
    private String state = "stopped";
    private Listener listener;

    private SpeechEngine(Context context) {
        this.context = context;
        this.tts = new TextToSpeech(context, this);
    }

    @Override
    public void onInit(int status) {
        main.post(() -> {
            ready = status == TextToSpeech.SUCCESS;
            initDone = true;
            if (ready) {
                tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                    @Override
                    public void onStart(String utteranceId) {}

                    @Override
                    public void onDone(String utteranceId) {
                        main.post(() -> onChunkDone(utteranceId));
                    }

                    @Override
                    public void onError(String utteranceId) {
                        main.post(() -> onChunkDone(utteranceId));
                    }
                });
            }
            List<Runnable> waiting = new ArrayList<>(pendingInit);
            pendingInit.clear();
            for (Runnable runnable : waiting) runnable.run();
        });
    }

    /** Chạy trên luồng chính, sau khi bộ đọc đã khởi tạo xong. */
    public void whenReady(Runnable runnable) {
        main.post(() -> {
            if (initDone) runnable.run();
            else pendingInit.add(runnable);
        });
    }

    public boolean isReady() {
        return ready;
    }

    public void setListener(Listener listener) {
        this.listener = listener;
    }

    public String getState() {
        return state;
    }

    public String getBookTitle() {
        return bookTitle;
    }

    public String getChapterTitle() {
        if (chapterPos >= 0 && chapterPos < chapters.size()) return chapters.get(chapterPos).title;
        return "";
    }

    public Set<Voice> getVoices() {
        try {
            return ready ? tts.getVoices() : null;
        } catch (Exception error) {
            return null;
        }
    }

    // --- Điều khiển (gọi trên luồng chính) ---

    public void start(List<Chapter> list, int startChapter, String voice, float newRate, float newVolume, String title) {
        chapters.clear();
        chapters.addAll(list);
        chapterPos = Math.max(0, Math.min(startChapter, chapters.size() - 1));
        bookTitle = title == null ? "" : title;
        rate = newRate;
        volume = newVolume;
        selectVoice(voice);
        ReaderSpeechService.start(context);
        beginChapter();
    }

    public void appendChapters(List<Chapter> list) {
        chapters.addAll(list);
    }

    public void prependChapters(List<Chapter> list) {
        chapters.addAll(0, list);
        chapterPos += list.size();
    }

    public void pause() {
        if (!"playing".equals(state)) return;
        generation++;
        currentUtteranceId = null;
        tts.stop();
        setState("paused");
    }

    public void resume() {
        if (!"paused".equals(state)) return;
        speakCurrentChunk();
    }

    public void togglePause() {
        if ("playing".equals(state)) pause();
        else resume();
    }

    public void stop() {
        generation++;
        currentUtteranceId = null;
        tts.stop();
        chapters.clear();
        chunks = new ArrayList<>();
        setState("stopped");
        ReaderSpeechService.stop(context);
    }

    public void skipChapter(int offset) {
        if (chapters.isEmpty()) return;
        int target = chapterPos + offset;
        if (target < 0 || target >= chapters.size()) return;
        generation++;
        currentUtteranceId = null;
        tts.stop();
        chapterPos = target;
        beginChapter();
    }

    public void setOptions(Float newRate, Float newVolume, String voice) {
        if (newRate != null) rate = newRate;
        if (newVolume != null) volume = newVolume;
        if (voice != null) selectVoice(voice);
    }

    // --- Đọc ---

    private void selectVoice(String voice) {
        voiceName = voice;
        selectedVoice = null;
        Set<Voice> voices = getVoices();
        if (voice == null || voices == null) return;
        for (Voice item : voices) {
            if (item.getName().equals(voice)) {
                selectedVoice = item;
                break;
            }
        }
    }

    private void beginChapter() {
        while (chapterPos < chapters.size()) {
            Chapter chapter = chapters.get(chapterPos);
            chunks = splitIntoChunks(chapter.text, 400);
            chunkIndex = 0;
            if (!chunks.isEmpty()) {
                if (listener != null) listener.onChapterChange(chapter.index, chapter.title);
                speakCurrentChunk();
                return;
            }
            chapterPos++;
        }
        finishBook();
    }

    private void speakCurrentChunk() {
        if (!ready) {
            setState("stopped");
            return;
        }
        if (chunkIndex >= chunks.size()) {
            chapterPos++;
            beginChapter();
            return;
        }
        if (selectedVoice != null) {
            tts.setVoice(selectedVoice);
        } else {
            tts.setLanguage(new Locale("vi", "VN"));
        }
        tts.setSpeechRate(rate);
        Bundle params = new Bundle();
        params.putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, volume);
        currentUtteranceId = "g" + generation + "-" + chunkIndex;
        tts.speak(chunks.get(chunkIndex), TextToSpeech.QUEUE_FLUSH, params, currentUtteranceId);
        setState("playing");
    }

    private void onChunkDone(String utteranceId) {
        if (utteranceId == null || !utteranceId.equals(currentUtteranceId)) return;
        chunkIndex++;
        speakCurrentChunk();
    }

    private void finishBook() {
        currentUtteranceId = null;
        chunks = new ArrayList<>();
        setState("finished");
        ReaderSpeechService.stop(context);
    }

    private void setState(String newState) {
        state = newState;
        ReaderSpeechService.refresh();
        if (listener != null) listener.onState(newState);
    }

    static List<String> splitIntoChunks(String text, int maxLength) {
        List<String> result = new ArrayList<>();
        if (text == null) return result;
        BreakIterator iterator = BreakIterator.getSentenceInstance(new Locale("vi", "VN"));
        iterator.setText(text);
        StringBuilder current = new StringBuilder();
        int start = iterator.first();
        for (int end = iterator.next(); end != BreakIterator.DONE; start = end, end = iterator.next()) {
            String sentence = text.substring(start, end).trim();
            if (sentence.isEmpty()) continue;
            if (current.length() > 0 && current.length() + sentence.length() + 1 > maxLength) {
                result.add(current.toString());
                current.setLength(0);
            }
            if (current.length() > 0) current.append(' ');
            current.append(sentence);
        }
        if (current.length() > 0) result.add(current.toString());
        return result;
    }
}
