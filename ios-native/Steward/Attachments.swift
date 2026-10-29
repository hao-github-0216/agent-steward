// 問管家的附件:圖片(相簿、拍照)、專案檔案(Mac 上專案裡的檔案,管家自己讀)、iPhone 上的文字檔(內容直接送)
import SwiftUI
import UIKit

struct Attachment: Identifiable, Hashable {
    enum Kind: Hashable {
        /// base64(不含 data: 前綴)、MIME、160px 縮圖(data URL,存進對話紀錄)
        case image(data: String, mime: String, thumb: String)
        /// 專案裡的相對路徑(管家自己讀磁碟)
        case projectFile(String)
        /// 程式碼頁正在編輯、還沒存的檔案:連內容一起送
        case editorFile(String, String)
        /// iPhone「檔案」App 裡的文字檔
        case phoneFile(name: String, content: String)
    }

    let id = UUID()
    let kind: Kind
    var preview: UIImage?

    var label: String {
        switch kind {
        case .image: "圖片"
        case .projectFile(let rel), .editorFile(let rel, _): (rel as NSString).lastPathComponent
        case .phoneFile(let name, _): name
        }
    }

    static let maxImages = 4
    static let maxFiles = 10

    /// 跟網頁一樣:長邊縮到 1600px(省 token),截圖類(有透明)維持 PNG,其他 JPEG;另做 160px 縮圖
    static func image(_ img: UIImage) -> Attachment? {
        let big = img.scaled(maxSide: 1600)
        let png = img.hasAlpha
        var data = png ? big.pngData() : big.jpegData(compressionQuality: 0.88)
        var mime = png ? "image/png" : "image/jpeg"
        if let d = data, d.count > 3_000_000 { data = big.jpegData(compressionQuality: 0.8); mime = "image/jpeg" }
        guard let data, let thumbData = img.scaled(maxSide: 160).jpegData(compressionQuality: 0.7) else { return nil }
        return Attachment(kind: .image(data: data.base64EncodedString(), mime: mime, thumb: "data:image/jpeg;base64,\(thumbData.base64EncodedString())"), preview: img.scaled(maxSide: 160))
    }

    /// iPhone 上的檔案:只收文字檔(UTF-8),太大(> 400KB)不收
    static func phoneFile(_ url: URL) throws -> Attachment {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let data = try Data(contentsOf: url)
        guard data.count <= 400_000 else { throw AttachError("「\(url.lastPathComponent)」太大(上限 400KB)") }
        guard let text = String(data: data, encoding: .utf8) else { throw AttachError("「\(url.lastPathComponent)」不是文字檔;圖片請用「照片」") }
        return Attachment(kind: .phoneFile(name: url.lastPathComponent, content: text))
    }
}

struct AttachError: LocalizedError {
    let msg: String
    init(_ msg: String) { self.msg = msg }
    var errorDescription: String? { msg }
}

extension UIImage {
    var hasAlpha: Bool {
        guard let a = cgImage?.alphaInfo else { return false }
        return a == .first || a == .last || a == .premultipliedFirst || a == .premultipliedLast
    }

    func scaled(maxSide: CGFloat) -> UIImage {
        let k = min(1, maxSide / max(size.width, size.height))
        guard k < 1 else { return self }
        let target = CGSize(width: max(1, (size.width * k).rounded()), height: max(1, (size.height * k).rounded()))
        let f = UIGraphicsImageRendererFormat.default()
        f.scale = 1
        return UIGraphicsImageRenderer(size: target, format: f).image { _ in draw(in: CGRect(origin: .zero, size: target)) }
    }
}

/// 從 data URL(對話紀錄裡的縮圖)還原成圖片
func imageFromDataURL(_ s: String) -> UIImage? {
    guard let comma = s.firstIndex(of: ","), let data = Data(base64Encoded: String(s[s.index(after: comma)...])) else { return nil }
    return UIImage(data: data)
}

/// 拍照(UIKit 的相機畫面)
struct CameraPicker: UIViewControllerRepresentable {
    let onPick: (UIImage) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let c = UIImagePickerController()
        c.sourceType = .camera
        c.delegate = context.coordinator
        return c
    }

    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}
    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraPicker
        init(_ p: CameraPicker) { parent = p }
        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let img = info[.originalImage] as? UIImage { parent.onPick(img) }
            parent.dismiss()
        }
        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { parent.dismiss() }
    }
}

/// 選專案裡的檔案:可以一層層點進資料夾,或直接搜尋檔名
struct ProjectFilePicker: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let project: Project
    let already: Set<String>
    let onDone: ([String]) -> Void
    @State private var picked: Set<String> = []
    @State private var query = ""
    @State private var results: [String] = []

    var body: some View {
        NavigationStack {
            Group {
                if query.trimmingCharacters(in: .whitespaces).isEmpty {
                    FolderList(project: project, dir: "", picked: $picked)
                } else {
                    List(results, id: \.self) { rel in
                        FileRow(name: (rel as NSString).lastPathComponent, detail: rel, selected: picked.contains(rel)) { toggle(rel) }
                    }
                    .overlay { if results.isEmpty { ContentUnavailableView.search(text: query) } }
                }
            }
            .searchable(text: $query, prompt: "找檔名")
            .task(id: query) {
                let q = query.trimmingCharacters(in: .whitespaces)
                guard !q.isEmpty else { results = []; return }
                try? await Task.sleep(for: .milliseconds(250))
                results = (try? await model.api?.findFiles(project: project.id, query: q)) ?? []
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(picked.isEmpty ? "加入" : "加入 \(picked.count) 個") { onDone(Array(picked)); dismiss() }
                        .disabled(picked.isEmpty)
                }
            }
        }
        .onAppear { picked = [] }
    }

    private func toggle(_ rel: String) {
        if picked.contains(rel) { picked.remove(rel) } else if picked.count + already.count < Attachment.maxFiles { picked.insert(rel) }
    }
}

private struct FolderList: View {
    @Environment(AppModel.self) private var model
    let project: Project
    let dir: String
    @Binding var picked: Set<String>
    @State private var entries: [FileEntry]?
    @State private var error: String?

    var body: some View {
        List {
            if let error { Text(error).foregroundStyle(.red) }
            ForEach(entries ?? []) { e in
                if e.isDir {
                    NavigationLink {
                        FolderList(project: project, dir: e.rel, picked: $picked)
                    } label: {
                        Label(e.name, systemImage: "folder").foregroundStyle(e.ignored == true ? .secondary : .primary)
                    }
                } else {
                    FileRow(name: e.name, detail: e.size.map { ByteCountFormatter.string(fromByteCount: Int64($0), countStyle: .file) }, selected: picked.contains(e.rel)) {
                        if picked.contains(e.rel) { picked.remove(e.rel) } else if picked.count < Attachment.maxFiles { picked.insert(e.rel) }
                    }
                }
            }
        }
        .overlay { if entries == nil && error == nil { ProgressView() } }
        .navigationTitle(dir.isEmpty ? project.name : (dir as NSString).lastPathComponent)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            do {
                let list = try await model.api?.tree(project: project.id, dir: dir) ?? []
                entries = list.sorted { ($0.isDir ? 0 : 1, $0.name.lowercased()) < ($1.isDir ? 0 : 1, $1.name.lowercased()) }
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}

private struct FileRow: View {
    let name: String
    let detail: String?
    let selected: Bool
    let toggle: () -> Void

    var body: some View {
        Button(action: toggle) {
            HStack {
                Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(selected ? Color.orange : Color.secondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(name).foregroundStyle(.primary)
                    if let detail { Text(detail).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
                }
            }
        }
    }
}
