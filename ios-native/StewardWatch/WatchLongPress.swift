import SwiftUI
import WatchKit
import AVFoundation
import Combine

extension View {
    func watchLongPress(_ action: @escaping () -> Void) -> some View {
        simultaneousGesture(
            LongPressGesture(minimumDuration: 0.5).onEnded { _ in
                WKInterfaceDevice.current().play(.click)
                action()
            }
        )
    }
}

@MainActor
final class WatchSpeaker: NSObject, ObservableObject, AVSpeechSynthesizerDelegate {
    static let shared = WatchSpeaker()

    @Published private(set) var isSpeaking = false
    private let synthesizer = AVSpeechSynthesizer()

    private override init() {
        super.init()
        synthesizer.delegate = self
    }

    func speak(_ text: String) {
        stop()
        let plainText = WatchMarkdown.hidingCode(in: text)
            .replacingOccurrences(of: "[*`#>]", with: "", options: .regularExpression)
        let containsCJK = plainText.unicodeScalars.contains {
            (0x2E80...0x9FFF).contains($0.value) || (0xAC00...0xD7AF).contains($0.value)
                || (0xF900...0xFAFF).contains($0.value) || (0x20000...0x323AF).contains($0.value)
        }
        let utterance = AVSpeechUtterance(string: plainText)
        utterance.voice = AVSpeechSynthesisVoice(language: containsCJK ? "zh-TW" : "en-US")
        synthesizer.speak(utterance)
    }

    func stop() {
        synthesizer.stopSpeaking(at: .immediate)
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
        Task { @MainActor in self.isSpeaking = self.synthesizer.isSpeaking }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor in self.isSpeaking = self.synthesizer.isSpeaking }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        Task { @MainActor in self.isSpeaking = self.synthesizer.isSpeaking }
    }
}

@MainActor
enum WatchHandoff {
    static func activity(url: String) -> NSUserActivity {
        let activity = NSUserActivity(activityType: "io.github.haogithub0216.agentsteward.native.open")
        activity.userInfo = ["url": url]
        activity.isEligibleForHandoff = true
        return activity
    }

    @MainActor
    final class Session: ObservableObject {
        @Published private(set) var showsHint = false
        private var current: NSUserActivity?
        private var expiration: Task<Void, Never>?

        func open(_ url: String) {
            stop()
            let activity = WatchHandoff.activity(url: url)
            current = activity
            activity.becomeCurrent()
            showsHint = true
        }

        func menuClosed() {
            guard current != nil else { return }
            expiration?.cancel()
            expiration = Task { @MainActor [weak self] in
                do { try await Task.sleep(for: .seconds(60)) }
                catch { return }
                self?.stop()
            }
        }

        func stop() {
            expiration?.cancel()
            expiration = nil
            current?.invalidate()
            current = nil
            if showsHint { showsHint = false }
        }
    }
}
