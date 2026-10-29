// 上傳這台裝置上的檔案到專案(跟網頁程式碼頁的「⇪ 上傳」一樣):
//   從「檔案」挑檔案或整個資料夾、從照片挑、拍照;iPad 也可以把檔案從「檔案」拖進檔案清單。
//   一個檔案一個 PUT;同名檔案問要覆蓋還是略過(覆蓋時舊檔先移到電腦的垃圾桶);單檔上限 500 MB。
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// 一個要上傳的檔案:local 是這台裝置上的檔案,rel 是放進專案的相對路徑(上傳資料夾時含子資料夾)
struct UploadItem: Sendable {
    var local: URL
    var rel: String
    /// 別的 app 的檔案(從「檔案」挑的):上傳前先協調讀取(iCloud 還沒下載的會先下載)、複製一份到暫存
    var external = false
}

@MainActor @Observable
final class UploadCenter {
    static let limit = 500 * 1024 * 1024

    enum Choice { case overwrite, skip, overwriteAll, skipAll, cancel }
    struct Conflict: Identifiable {
        let id = UUID()
        let path: String
        let remaining: Int
    }

    private(set) var running = false
    private(set) var status = ""
    private(set) var fraction = 0.0
    var conflict: Conflict?
    /// 傳完的結果(幾秒後自己消失)
    private(set) var finished: String?
    /// 傳完 +1:檔案清單和 Git 重新整理
    private(set) var refresh = 0
    private var resume: CheckedContinuation<Choice, Never>?
    /// 第幾次問同名檔案(關掉對話框的延後取消只取消同一次)
    private var askSeq = 0
    /// 從「檔案」挑的:讀取權限要保留到傳完
    private var scoped: [URL] = []
    /// 照片、拍照、拖進來的暫存檔:整批傳完再刪
    private var temps: [URL] = []

    func resolve(_ c: Choice) {
        let r = resume
        resume = nil
        conflict = nil
        r?.resume(returning: c)
    }

    /// 同名檔案的對話框被關掉(點外面、往下滑):當成停止上傳。
    /// 延後一輪再看:按了按鈕的話按鈕那邊已經處理好,這裡就什麼都不做(不靠 SwiftUI 先叫誰)
    func dismissConflict() {
        let seq = askSeq
        Task { @MainActor in
            if resume != nil, askSeq == seq { resolve(.cancel) }
        }
    }

    func notice(_ msg: String) { show(msg) }

    // MARK: 收集要上傳的檔案

    /// 從「檔案」挑的(檔案或資料夾)
    func importPicked(_ urls: [URL]) async -> [UploadItem] {
        var items: [UploadItem] = []
        for url in urls {
            if url.startAccessingSecurityScopedResource() { scoped.append(url) }
            items += await Task.detached { Self.walk(url, external: true) }.value
        }
        return items
    }

    /// 從照片挑的(照片轉成 JPEG、影片轉成 H.264:電腦和 agent 都讀得了)
    func importPhotos(_ picks: [PhotosPickerItem]) async -> [UploadItem] {
        var out: [UploadItem] = []
        let stamp = Self.stamp()
        for (i, p) in picks.enumerated() {
            guard let f = try? await p.loadTransferable(type: PickedFile.self) else { continue }
            temps.append(f.url.deletingLastPathComponent())
            var name = f.url.lastPathComponent
            // 系統給的是一串亂碼名稱時改成 IMG_日期_時間
            if name.filter({ $0 == "-" }).count >= 4 || name.hasPrefix(".") {
                let ext = f.url.pathExtension.isEmpty ? "jpg" : f.url.pathExtension.lowercased()
                name = picks.count > 1 ? "IMG_\(stamp)_\(i + 1).\(ext)" : "IMG_\(stamp).\(ext)"
            }
            out.append(UploadItem(local: f.url, rel: name))
        }
        return out
    }

    /// 剛拍的照片
    func importPhoto(_ image: UIImage) -> [UploadItem] {
        guard let data = image.jpegData(compressionQuality: 0.85), let dir = try? Self.tempDir() else { return [] }
        temps.append(dir)
        let url = dir.appendingPathComponent("IMG_\(Self.stamp()).jpg")
        guard (try? data.write(to: url)) != nil else { return [] }
        return [UploadItem(local: url, rel: url.lastPathComponent)]
    }

    /// iPad 從「檔案」拖進來的(檔案或資料夾)
    func importDropped(_ providers: [NSItemProvider]) async -> [UploadItem] {
        var out: [UploadItem] = []
        for p in providers {
            let type: UTType = p.hasItemConformingToTypeIdentifier(UTType.folder.identifier) ? .folder : .item
            guard let url = await Self.load(p, type: type) else { continue }
            temps.append(url.deletingLastPathComponent())
            out += await Task.detached { Self.walk(url, external: false) }.value
        }
        return out
    }

    // MARK: 上傳

    func upload(_ items: [UploadItem], to base: String, project: String, api: API, still: @escaping @MainActor () -> Bool) async {
        guard !running else { show("還有檔案在上傳,等它傳完"); return }
        guard !items.isEmpty else { cleanup(); return }
        running = true
        finished = nil
        var ok = 0, skipped = 0, failed = 0, tooBig = 0
        var lastErr = ""
        var policy: Choice?
        for (i, it) in items.enumerated() {
            guard still() else { break } // 換專案就停(跟網頁一樣)
            let path = base.isEmpty ? it.rel : "\(base)/\(it.rel)"
            status = "\(i + 1)/\(items.count) · \(it.rel)"
            fraction = 0
            switch await one(it, path: path, remaining: items.count - i - 1, project: project, api: api, policy: &policy) {
            case .ok: ok += 1
            case .skipped: skipped += 1
            case .tooBig: tooBig += 1
            case .failed(let e): failed += 1; lastErr = e
            case .cancel: break
            }
            if policy == .cancel { break }
        }
        cleanup()
        running = false
        var msg = ok > 0 || skipped + failed + tooBig == 0 ? "已上傳 \(ok) 個檔案" : "沒有上傳檔案"
        if skipped > 0 { msg += ",略過 \(skipped) 個" }
        if tooBig > 0 { msg += ",\(tooBig) 個超過 500 MB 沒傳" }
        if failed > 0 { msg += ",失敗 \(failed) 個(\(lastErr))" }
        show(msg)
        refresh += 1
        UINotificationFeedbackGenerator().notificationOccurred(failed > 0 ? .error : .success)
    }

    private enum Outcome { case ok, skipped, tooBig, failed(String), cancel }

    private func one(_ it: UploadItem, path: String, remaining: Int, project: String, api: API, policy: inout Choice?) async -> Outcome {
        var file = it.local
        var staged: URL?
        defer { if let staged { try? FileManager.default.removeItem(at: staged.deletingLastPathComponent()) } }
        do {
            if it.external {
                let src = it.local
                file = try await Task.detached { try Self.stage(src) }.value
                staged = file
            }
            let size = (try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
            if size > Self.limit { return .tooBig }
            let progress: @Sendable (Double) -> Void = { f in Task { @MainActor [weak self] in self?.fraction = f } }
            if try await api.upload(project: project, path: path, file: file, overwrite: policy == .overwriteAll, progress: progress) == .ok { return .ok }
            // 已經有同名的檔案
            var choice: Choice
            if let policy { choice = policy } else { choice = await ask(path, remaining: remaining) }
            if choice == .overwriteAll { policy = .overwriteAll; choice = .overwrite }
            if choice == .skipAll { policy = .skipAll; choice = .skip }
            if choice == .cancel { policy = .cancel; return .cancel }
            if choice == .skip { return .skipped }
            _ = try await api.upload(project: project, path: path, file: file, overwrite: true, progress: progress)
            return .ok
        } catch {
            return .failed(error.localizedDescription)
        }
    }

    private func ask(_ path: String, remaining: Int) async -> Choice {
        await withCheckedContinuation { c in
            askSeq += 1
            resume = c
            conflict = Conflict(path: path, remaining: remaining)
        }
    }

    private func show(_ msg: String) {
        finished = msg
        Task {
            try? await Task.sleep(for: .seconds(4))
            if finished == msg { finished = nil }
        }
    }

    private func cleanup() {
        for u in scoped { u.stopAccessingSecurityScopedResource() }
        scoped = []
        for d in temps { try? FileManager.default.removeItem(at: d) }
        temps = []
    }

    // MARK: 檔案處理(背景執行)

    /// 資料夾 → 裡面所有檔案(相對路徑以資料夾名稱開頭);檔案 → 自己
    nonisolated static func walk(_ url: URL, external: Bool) -> [UploadItem] {
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir), isDir.boolValue else {
            return [UploadItem(local: url, rel: url.lastPathComponent, external: external)]
        }
        let name = url.lastPathComponent
        var out: [UploadItem] = []
        for sub in ((try? FileManager.default.subpathsOfDirectory(atPath: url.path)) ?? []).sorted() {
            var f = url.appendingPathComponent(sub)
            var rel = "\(name)/\(sub)"
            var d: ObjCBool = false
            guard FileManager.default.fileExists(atPath: f.path, isDirectory: &d), !d.boolValue else { continue }
            let last = f.lastPathComponent
            if last == ".DS_Store" { continue }
            // iCloud 還沒下載的檔案在資料夾裡是「.檔名.icloud」:換回真正的檔名,讀的時候會先下載
            if last.hasPrefix("."), last.hasSuffix(".icloud") {
                let real = String(last.dropFirst().dropLast(7))
                f = f.deletingLastPathComponent().appendingPathComponent(real)
                rel = (rel as NSString).deletingLastPathComponent.isEmpty ? real : "\((rel as NSString).deletingLastPathComponent)/\(real)"
            }
            out.append(UploadItem(local: f, rel: rel, external: external))
        }
        return out
    }

    /// 別的 app 的檔案:協調讀取(iCloud 上還沒下載的會先下載)並複製到暫存資料夾
    nonisolated static func stage(_ url: URL) throws -> URL {
        let dir = try tempDir()
        let dst = dir.appendingPathComponent(url.lastPathComponent)
        var coordErr: NSError?
        var copyErr: Error?
        NSFileCoordinator().coordinate(readingItemAt: url, options: [.withoutChanges], error: &coordErr) { u in
            do { try FileManager.default.copyItem(at: u, to: dst) } catch { copyErr = error }
        }
        if let e = coordErr ?? copyErr { throw e }
        return dst
    }

    /// 拖進來的東西:系統給的暫存檔在回呼結束就會刪,先複製一份
    nonisolated static func load(_ p: NSItemProvider, type: UTType) async -> URL? {
        await withCheckedContinuation { c in
            _ = p.loadFileRepresentation(for: type, openInPlace: false) { url, _, _ in
                guard let url, let dir = try? tempDir() else { c.resume(returning: nil); return }
                let dst = dir.appendingPathComponent(url.lastPathComponent)
                c.resume(returning: (try? FileManager.default.copyItem(at: url, to: dst)) != nil ? dst : nil)
            }
        }
    }

    nonisolated static func tempDir() throws -> URL {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("upload-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    nonisolated static func stamp() -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyyMMdd_HHmmss"
        return f.string(from: .now)
    }
}

/// 從照片挑的檔案(系統給的暫存檔會被刪,先複製一份)
struct PickedFile: Transferable {
    let url: URL

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .movie) { try PickedFile(copying: $0.file) }
        FileRepresentation(importedContentType: .image) { try PickedFile(copying: $0.file) }
        FileRepresentation(importedContentType: .data) { try PickedFile(copying: $0.file) }
    }

    init(copying src: URL) throws {
        let dst = try UploadCenter.tempDir().appendingPathComponent(src.lastPathComponent)
        try FileManager.default.copyItem(at: src, to: dst)
        url = dst
    }
}

/// 上傳中的進度、傳完的結果(程式碼頁下方)
struct UploadStatusBar: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let u = model.uploads
        if u.running || u.finished != nil {
            VStack(alignment: .leading, spacing: 6) {
                if u.running {
                    Label("上傳中 \(u.status)", systemImage: "arrow.up.circle").lineLimit(1)
                    ProgressView(value: u.fraction)
                } else if let f = u.finished {
                    Label(f, systemImage: f.contains("失敗") ? "exclamationmark.triangle" : "checkmark.circle")
                }
            }
            .font(.footnote)
            .padding(12)
            .frame(maxWidth: 440, alignment: .leading)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
            .padding(.horizontal)
            .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }
}

/// 同名檔案:覆蓋 / 略過 / 之後全部…(跟網頁一樣)
struct UploadConflictDialog: ViewModifier {
    @Environment(AppModel.self) private var model

    func body(content: Content) -> some View {
        let u = model.uploads
        content.confirmationDialog("已經有同名的檔案", isPresented: Binding(get: { u.conflict != nil }, set: { if !$0 { u.dismissConflict() } }), titleVisibility: .visible, presenting: u.conflict) { c in
            Button("覆蓋") { u.resolve(.overwrite) }
            Button("略過") { u.resolve(.skip) }
            if c.remaining > 0 {
                Button("之後全部覆蓋") { u.resolve(.overwriteAll) }
                Button("之後全部略過") { u.resolve(.skipAll) }
            }
            Button("停止上傳", role: .cancel) { u.resolve(.cancel) }
        } message: { c in
            Text("「\(c.path)」已經存在。覆蓋的話,舊的檔案會先移到電腦的垃圾桶。")
        }
    }
}
