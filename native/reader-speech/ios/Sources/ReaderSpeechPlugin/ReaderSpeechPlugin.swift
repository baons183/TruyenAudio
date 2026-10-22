import Foundation
import UIKit
import Capacitor
import AVFoundation
import MediaPlayer

/// Đọc sách bằng giọng của iOS ngay cả khi máy gạt im lặng hoặc khóa màn hình.
/// Danh sách chương được giữ ở phía native để tự chuyển chương khi app chạy nền.
@objc(ReaderSpeechPlugin)
public class ReaderSpeechPlugin: CAPPlugin, CAPBridgedPlugin, AVSpeechSynthesizerDelegate {
    public let identifier = "ReaderSpeechPlugin"
    public let jsName = "ReaderSpeech"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getVoices", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "appendChapters", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "prependChapters", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pause", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resume", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "next", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "previous", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setOptions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setBrightness", returnType: CAPPluginReturnPromise)
    ]

    private struct Chapter {
        let index: Int
        let title: String
        let text: String
    }

    private let synthesizer = AVSpeechSynthesizer()
    private var chapters: [Chapter] = []
    private var chapterPos = 0
    private var chunks: [String] = []
    private var chunkIndex = 0
    private var currentUtterance: AVSpeechUtterance?
    private var voiceId: String?
    private var rate: Float = 1
    private var volume: Float = 1
    private var bookTitle = ""
    private var state = "stopped"
    private var remoteConfigured = false
    // Độ sáng iOS áp dụng cho cả hệ thống, nên trả lại độ sáng gốc khi rời app.
    private var originalBrightness: CGFloat?
    private var appBrightness: CGFloat?

    override public func load() {
        synthesizer.delegate = self
        synthesizer.usesApplicationAudioSession = true
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleInterruption(_:)),
            name: AVAudioSession.interruptionNotification,
            object: AVAudioSession.sharedInstance()
        )
        NotificationCenter.default.addObserver(self, selector: #selector(appWillResignActive), name: UIApplication.willResignActiveNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(appDidBecomeActive), name: UIApplication.didBecomeActiveNotification, object: nil)
    }

    @objc func setBrightness(_ call: CAPPluginCall) {
        let value = call.getDouble("value") ?? -1
        DispatchQueue.main.async {
            if value < 0 {
                if let original = self.originalBrightness { UIScreen.main.brightness = original }
                self.originalBrightness = nil
                self.appBrightness = nil
            } else {
                if self.originalBrightness == nil { self.originalBrightness = UIScreen.main.brightness }
                let brightness = CGFloat(min(max(value, 0.01), 1))
                self.appBrightness = brightness
                UIScreen.main.brightness = brightness
            }
            call.resolve()
        }
    }

    @objc private func appWillResignActive() {
        guard appBrightness != nil, let original = originalBrightness else { return }
        UIScreen.main.brightness = original
    }

    @objc private func appDidBecomeActive() {
        guard let brightness = appBrightness else { return }
        originalBrightness = UIScreen.main.brightness
        UIScreen.main.brightness = brightness
    }

    // MARK: - Plugin methods

    @objc func getVoices(_ call: CAPPluginCall) {
        let voices = AVSpeechSynthesisVoice.speechVoices().map { voice -> [String: Any] in
            return [
                "id": voice.identifier,
                "name": voice.name,
                "lang": voice.language,
                "quality": voice.quality.rawValue
            ]
        }
        call.resolve(["voices": voices])
    }

    @objc func start(_ call: CAPPluginCall) {
        let list = parseChapters(call.options["chapters"])
        guard !list.isEmpty else {
            call.reject("Không có nội dung để đọc.")
            return
        }
        let startChapter = intValue(call.options["startChapter"]) ?? 0
        let voice = call.getString("voiceId")
        let newRate = call.getFloat("rate") ?? 1
        let newVolume = call.getFloat("volume") ?? 1
        let title = call.getString("bookTitle") ?? ""
        DispatchQueue.main.async {
            self.chapters = list
            self.chapterPos = max(0, min(startChapter, list.count - 1))
            self.voiceId = voice
            self.rate = newRate
            self.volume = newVolume
            self.bookTitle = title
            self.activateAudioSession()
            self.configureRemoteCommands()
            self.beginChapter()
            call.resolve()
        }
    }

    @objc func appendChapters(_ call: CAPPluginCall) {
        let list = parseChapters(call.options["chapters"])
        DispatchQueue.main.async {
            self.chapters.append(contentsOf: list)
            call.resolve()
        }
    }

    @objc func prependChapters(_ call: CAPPluginCall) {
        let list = parseChapters(call.options["chapters"])
        DispatchQueue.main.async {
            self.chapters.insert(contentsOf: list, at: 0)
            self.chapterPos += list.count
            call.resolve()
        }
    }

    @objc func pause(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.pausePlayback()
            call.resolve()
        }
    }

    @objc func resume(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.resumePlayback()
            call.resolve()
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.stopPlayback()
            call.resolve()
        }
    }

    @objc func next(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.skipChapter(1)
            call.resolve()
        }
    }

    @objc func previous(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.skipChapter(-1)
            call.resolve()
        }
    }

    @objc func setOptions(_ call: CAPPluginCall) {
        let newRate = call.getFloat("rate")
        let newVolume = call.getFloat("volume")
        let voice = call.getString("voiceId")
        DispatchQueue.main.async {
            if let newRate = newRate { self.rate = newRate }
            if let newVolume = newVolume { self.volume = newVolume }
            if let voice = voice { self.voiceId = voice }
            call.resolve()
        }
    }

    // MARK: - Playback

    private func beginChapter() {
        while chapterPos < chapters.count {
            let chapter = chapters[chapterPos]
            chunks = splitIntoChunks(chapter.text)
            chunkIndex = 0
            if !chunks.isEmpty {
                notifyListeners("chapterChange", data: ["index": chapter.index, "title": chapter.title])
                speakCurrentChunk()
                return
            }
            chapterPos += 1
        }
        finishBook()
    }

    private func speakCurrentChunk() {
        guard chunkIndex < chunks.count else {
            chapterPos += 1
            beginChapter()
            return
        }
        let utterance = AVSpeechUtterance(string: chunks[chunkIndex])
        if let voiceId = voiceId, let voice = AVSpeechSynthesisVoice(identifier: voiceId) {
            utterance.voice = voice
        } else {
            utterance.voice = AVSpeechSynthesisVoice(language: "vi-VN")
        }
        utterance.rate = min(max(rate * AVSpeechUtteranceDefaultSpeechRate, AVSpeechUtteranceMinimumSpeechRate), AVSpeechUtteranceMaximumSpeechRate)
        utterance.volume = volume
        currentUtterance = utterance
        synthesizer.speak(utterance)
        setState("playing")
    }

    private func pausePlayback() {
        guard state == "playing" else { return }
        if synthesizer.isSpeaking {
            synthesizer.pauseSpeaking(at: .word)
        }
        setState("paused")
    }

    private func resumePlayback() {
        guard state == "paused" else { return }
        activateAudioSession()
        if synthesizer.isPaused {
            synthesizer.continueSpeaking()
            setState("playing")
        } else {
            speakCurrentChunk()
        }
    }

    private func stopPlayback() {
        currentUtterance = nil
        synthesizer.stopSpeaking(at: .immediate)
        chapters = []
        chunks = []
        setState("stopped")
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func skipChapter(_ offset: Int) {
        guard !chapters.isEmpty else { return }
        let target = chapterPos + offset
        guard target >= 0 && target < chapters.count else { return }
        currentUtterance = nil
        synthesizer.stopSpeaking(at: .immediate)
        chapterPos = target
        beginChapter()
    }

    private func finishBook() {
        currentUtterance = nil
        chunks = []
        setState("finished")
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    }

    private func setState(_ newState: String) {
        state = newState
        updateNowPlaying()
        notifyListeners("state", data: ["state": newState])
    }

    // MARK: - AVSpeechSynthesizerDelegate

    public func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        DispatchQueue.main.async {
            guard utterance === self.currentUtterance else { return }
            self.chunkIndex += 1
            self.speakCurrentChunk()
        }
    }

    // MARK: - Audio session & lock screen

    private func activateAudioSession() {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playback, mode: .spokenAudio, options: [])
            try session.setActive(true)
        } catch {
            CAPLog.print("ReaderSpeech: không thể bật phiên âm thanh: \(error)")
        }
    }

    @objc private func handleInterruption(_ notification: Notification) {
        guard let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
        DispatchQueue.main.async {
            if type == .began {
                self.pausePlayback()
            }
        }
    }

    private func configureRemoteCommands() {
        guard !remoteConfigured else { return }
        remoteConfigured = true
        let center = MPRemoteCommandCenter.shared()
        center.playCommand.addTarget { [weak self] _ in
            self?.resumePlayback()
            return .success
        }
        center.pauseCommand.addTarget { [weak self] _ in
            self?.pausePlayback()
            return .success
        }
        center.togglePlayPauseCommand.addTarget { [weak self] _ in
            guard let self = self else { return .commandFailed }
            if self.state == "playing" { self.pausePlayback() } else { self.resumePlayback() }
            return .success
        }
        center.nextTrackCommand.addTarget { [weak self] _ in
            self?.skipChapter(1)
            return .success
        }
        center.previousTrackCommand.addTarget { [weak self] _ in
            self?.skipChapter(-1)
            return .success
        }
        center.skipForwardCommand.isEnabled = false
        center.skipBackwardCommand.isEnabled = false
        center.changePlaybackPositionCommand.isEnabled = false
    }

    private func updateNowPlaying() {
        guard state == "playing" || state == "paused", chapterPos < chapters.count else { return }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = [
            MPMediaItemPropertyTitle: chapters[chapterPos].title,
            MPMediaItemPropertyArtist: bookTitle,
            MPNowPlayingInfoPropertyPlaybackRate: state == "playing" ? 1.0 : 0.0
        ]
    }

    // MARK: - Helpers

    private func intValue(_ value: Any?) -> Int? {
        if let number = value as? NSNumber { return number.intValue }
        if let number = value as? Int { return number }
        if let number = value as? Double { return Int(number) }
        return nil
    }

    private func parseChapters(_ value: Any?) -> [Chapter] {
        guard let items = value as? [Any] else { return [] }
        return items.compactMap { item in
            guard let object = item as? [String: Any],
                  let index = intValue(object["index"]),
                  let text = object["text"] as? String else { return nil }
            return Chapter(index: index, title: object["title"] as? String ?? "", text: text)
        }
    }

    private func splitIntoChunks(_ text: String, maxLength: Int = 400) -> [String] {
        var chunks: [String] = []
        var current = ""
        text.enumerateSubstrings(in: text.startIndex..<text.endIndex, options: .bySentences) { sentence, _, _, _ in
            guard let sentence = sentence?.trimmingCharacters(in: .whitespacesAndNewlines), !sentence.isEmpty else { return }
            if !current.isEmpty && current.count + sentence.count + 1 > maxLength {
                chunks.append(current)
                current = sentence
            } else {
                current = current.isEmpty ? sentence : current + " " + sentence
            }
        }
        if !current.isEmpty { chunks.append(current) }
        return chunks
    }
}
