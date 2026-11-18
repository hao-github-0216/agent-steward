import PDFKit
import QuickLook
import SwiftUI

@MainActor
final class PDFMarkupSession: ObservableObject {
    @Published var previewURL: URL?
    @Published private(set) var saving = false
    private(set) var editedData: Data?
    private var baseHash: String?
    private var directory: URL?

    var blocksReload: Bool { previewURL != nil || saving || editedData != nil }

    func begin(data: Data, path: String, hash: String?) throws {
        discard()
        baseHash = hash
        #if DEBUG
        if UserDefaults.standard.bool(forKey: "pdfMarkupTestEdit") {
            guard let document = PDFDocument(data: data), let page = document.page(at: 0) else {
                throw APIError.server(0, String(localized: "PDF 尚未載入完成", bundle: AppLanguage.bundle))
            }
            let annotation = PDFAnnotation(bounds: CGRect(x: 100, y: 100, width: 100, height: 50), forType: .ink, withProperties: nil)
            let stroke = UIBezierPath()
            stroke.move(to: .zero)
            stroke.addLine(to: CGPoint(x: 100, y: 50))
            annotation.add(stroke)
            annotation.color = .systemBlue
            page.addAnnotation(annotation)
            guard let result = document.dataRepresentation() else {
                throw APIError.server(0, String(localized: "存檔失敗", bundle: AppLanguage.bundle))
            }
            editedData = result
            return
        }
        #endif
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        directory = folder
        let url = folder.appendingPathComponent((path as NSString).lastPathComponent)
        do {
            try data.write(to: url, options: .atomic)
            previewURL = url
        } catch {
            discard()
            throw error
        }
    }

    func update(from url: URL) throws {
        editedData = try Data(contentsOf: url)
    }

    func save(api: API, project: String, path: String, force: Bool = false) async throws -> (hash: String?, data: Data)? {
        guard let editedData else { discard(); return nil }
        guard !saving else { return nil }
        saving = true
        defer { saving = false }
        let hash = try await api.savePdf(project: project, path: path, data: editedData, baseHash: baseHash, force: force)
        // 存檔後重新讀取電腦上的 PDF，下一次編輯以這份內容為準。
        let raw = try await api.rawFile(project: project, path: path)
        discard()
        return (hash, raw)
    }

    func discard() {
        previewURL = nil
        editedData = nil
        baseHash = nil
        if let directory { try? FileManager.default.removeItem(at: directory) }
        directory = nil
    }

    deinit {
        if let directory { try? FileManager.default.removeItem(at: directory) }
    }
}

struct PDFMarkupPreview: UIViewControllerRepresentable {
    let url: URL
    let onUpdate: (URL) -> Void
    let onDismiss: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIViewController(context: Context) -> UINavigationController {
        let preview = QLPreviewController()
        preview.dataSource = context.coordinator
        preview.delegate = context.coordinator
        preview.navigationItem.leftBarButtonItem = UIBarButtonItem(barButtonSystemItem: .done, target: context.coordinator, action: #selector(Coordinator.done))
        context.coordinator.preview = preview
        return UINavigationController(rootViewController: preview)
    }

    func updateUIViewController(_ controller: UINavigationController, context: Context) {}

    final class Coordinator: NSObject, QLPreviewControllerDataSource, QLPreviewControllerDelegate {
        let parent: PDFMarkupPreview
        weak var preview: QLPreviewController?
        private var dismissed = false

        init(_ parent: PDFMarkupPreview) { self.parent = parent }

        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }

        func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
            parent.url as NSURL
        }

        func previewController(_ controller: QLPreviewController, editingModeFor previewItem: QLPreviewItem) -> QLPreviewItemEditingMode {
            .updateContents
        }

        func previewController(_ controller: QLPreviewController, didUpdateContentsOf previewItem: QLPreviewItem) {
            parent.onUpdate(previewItem.previewItemURL ?? parent.url)
        }

        func previewController(_ controller: QLPreviewController, didSaveEditedCopyOf previewItem: QLPreviewItem, at modifiedContentsURL: URL) {
            parent.onUpdate(modifiedContentsURL)
        }

        func previewControllerDidDismiss(_ controller: QLPreviewController) {
            guard !dismissed else { return }
            dismissed = true
            parent.onDismiss()
        }

        @objc func done() {
            if let preview { previewControllerDidDismiss(preview) }
        }
    }
}
