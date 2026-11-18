import Combine
import PDFKit
import SwiftUI

@MainActor
final class PDFAnnotator: ObservableObject {
    enum Tool: String, CaseIterable {
        case highlight, underline, strikeOut, freeText, ink, eraser

        var title: String {
            switch self {
            case .highlight: String(localized: "螢光筆", bundle: AppLanguage.bundle)
            case .underline: String(localized: "底線", bundle: AppLanguage.bundle)
            case .strikeOut: String(localized: "刪除線", bundle: AppLanguage.bundle)
            case .freeText: String(localized: "文字框", bundle: AppLanguage.bundle)
            case .ink: String(localized: "手繪", bundle: AppLanguage.bundle)
            case .eraser: String(localized: "橡皮擦", bundle: AppLanguage.bundle)
            }
        }

        var symbol: String {
            switch self {
            case .highlight: "highlighter"
            case .underline: "underline"
            case .strikeOut: "strikethrough"
            case .freeText: "textbox"
            case .ink: "pencil.tip"
            case .eraser: "eraser"
            }
        }

        var markup: PDFAnnotationSubtype? {
            switch self {
            case .highlight: .highlight
            case .underline: .underline
            case .strikeOut: .strikeOut
            default: nil
            }
        }
    }

    weak var pdfView: FitPDFView?
    @Published var active = false {
        didSet { if !active { tool = nil }; selectionTask?.cancel() }
    }
    @Published var tool: Tool? {
        didSet { selectionTask?.cancel(); pdfView?.configureAnnotationGestures() }
    }
    @Published var color = min(3, max(0, UserDefaults.standard.integer(forKey: "pdfAnnotColor"))) {
        didSet { UserDefaults.standard.set(color, forKey: "pdfAnnotColor") }
    }
    @Published private(set) var dirty = false {
        didSet { if dirty != oldValue { onDirtyChanged?(dirty) } }
    }
    @Published private(set) var saving = false
    @Published private(set) var document: PDFDocument?
    @Published private(set) var hash: String?
    @Published private(set) var annotationCount = 0
    @Published var textPrompt = false
    @Published var text = ""
    private(set) var editable = false
    var onDirtyChanged: ((Bool) -> Void)?
    private var undoStack: [() -> Void] = []
    private var selectionTask: Task<Void, Never>?
    private var original: Data?
    private var api: API?
    private var project = ""
    private var path = ""
    private var textPoint: (PDFPage, CGPoint)?
    private var inkPage: PDFPage?
    private var inkAnnotation: PDFAnnotation?
    private var inkPoints: [CGPoint] = []
    private var restorePage = 0

    static let colors: [UIColor] = [
        UIColor(red: 1, green: 0.85, blue: 0, alpha: 1),
        UIColor(red: 0.2, green: 0.8, blue: 0.3, alpha: 1),
        UIColor(red: 0.2, green: 0.5, blue: 1, alpha: 1),
        UIColor(red: 1, green: 0.4, blue: 0.7, alpha: 1)
    ]
    static var colorNames: [String] {
        [String(localized: "黃色", bundle: AppLanguage.bundle), String(localized: "綠色", bundle: AppLanguage.bundle),
         String(localized: "藍色", bundle: AppLanguage.bundle), String(localized: "粉紅色", bundle: AppLanguage.bundle)]
    }
    var selectedColor: UIColor { Self.colors[min(3, max(0, color))] }
    var canUndo: Bool { !undoStack.isEmpty && !saving }
    var pageIndex: Int {
        guard let page = pdfView?.currentPage, let document else { return restorePage }
        let index = document.index(for: page)
        return index == NSNotFound ? 0 : index
    }

    func configure(api: API, project: String, path: String) {
        self.api = api
        self.project = project
        self.path = path
    }

    func load(data: Data, hash: String?, editable: Bool) {
        guard !dirty, !saving else { return }
        self.editable = editable
        self.hash = hash
        original = data
        replaceDocument(data)
        if !editable { active = false }
    }

    private func replaceDocument(_ data: Data) {
        selectionTask?.cancel()
        restorePage = pageIndex
        document = PDFDocument(data: data)
        attachDocument()
        updateCount()
    }

    func attach(to view: FitPDFView) {
        pdfView = view
        view.annotator = self
        attachDocument()
    }

    func attachDocument() {
        guard let view = pdfView, view.document !== document else { return }
        view.document = document
        view.layoutIfNeeded()
        if let document, let page = document.page(at: min(restorePage, max(0, document.pageCount - 1))) { view.go(to: page) }
        view.report()
    }

    private func prepare(_ annotation: PDFAnnotation) {
        annotation.userName = "Agent Steward"
        annotation.modificationDate = Date()
    }

    private func record(_ undo: @escaping () -> Void) {
        undoStack.append(undo)
        dirty = true
        updateCount()
    }

    private func add(_ annotation: PDFAnnotation, to page: PDFPage) {
        prepare(annotation)
        page.addAnnotation(annotation)
        record { page.removeAnnotation(annotation) }
    }

    private func updateCount() {
        annotationCount = (0..<(document?.pageCount ?? 0)).reduce(0) { $0 + (document?.page(at: $1)?.annotations.count ?? 0) }
        pdfView?.setNeedsDisplay()
        pdfView?.documentView?.setNeedsDisplay()
        pdfView?.report()
    }

    func undo() {
        guard !saving, let undo = undoStack.popLast() else { return }
        selectionTask?.cancel()
        undo()
        dirty = !undoStack.isEmpty
        updateCount()
    }

    func discard() {
        selectionTask?.cancel()
        cancelInk()
        undoStack.removeAll()
        dirty = false
        textPrompt = false
        textPoint = nil
        active = false
        if let original { replaceDocument(original) }
    }

    func selectionChanged() {
        selectionTask?.cancel()
        guard editable, active, !saving, tool?.markup != nil else { return }
        selectionTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(500))
            guard !Task.isCancelled, let self, let markup = self.tool?.markup else { return }
            if self.pdfView?.hasActiveGesture == true { self.selectionChanged(); return }
            self.applySelection(markup)
        }
    }

    func applySelection(_ subtype: PDFAnnotationSubtype) {
        guard editable, !saving, let view = pdfView, let selection = view.currentSelection,
              !(selection.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        selectionTask?.cancel()
        for line in selection.selectionsByLine() {
            guard let page = line.pages.first else { continue }
            let bounds = line.bounds(for: page)
            guard !bounds.isEmpty, !bounds.isInfinite, !bounds.isNull else { continue }
            let annotation = PDFAnnotation(bounds: bounds, forType: subtype, withProperties: nil)
            annotation.color = selectedColor.withAlphaComponent(subtype == .highlight ? 0.4 : 1)
            add(annotation, to: page)
        }
        view.clearSelection()
    }

    func tap(at location: CGPoint) {
        guard editable, active, !saving, let view = pdfView,
              let page = view.page(for: location, nearest: false) else { return }
        let point = view.convert(location, to: page)
        switch tool {
        case .freeText:
            textPoint = (page, point)
            text = ""
            textPrompt = true
        case .eraser:
            guard let annotation = page.annotation(at: point),
                  ["Highlight", "Underline", "StrikeOut", "FreeText", "Ink", "Square", "Circle", "Line", "Stamp"].contains(annotation.type ?? "") else { return }
            page.removeAnnotation(annotation)
            record { page.addAnnotation(annotation) }
        default: break
        }
    }

    func addText() {
        defer { textPoint = nil; text = "" }
        guard editable, !saving, let (page, point) = textPoint,
              !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        let font = UIFont.systemFont(ofSize: 12)
        let size = (text as NSString).size(withAttributes: [.font: font])
        let annotation = PDFAnnotation(bounds: CGRect(x: point.x, y: point.y - size.height - 8, width: ceil(size.width) + 8, height: ceil(size.height) + 8), forType: .freeText, withProperties: nil)
        annotation.font = font
        annotation.fontColor = selectedColor
        annotation.color = .clear
        annotation.contents = text
        add(annotation, to: page)
    }

    func ink(_ gesture: UIPanGestureRecognizer) {
        guard editable, active, tool == .ink, !saving, let view = pdfView else { cancelInk(); return }
        let location = gesture.location(in: view)
        switch gesture.state {
        case .began:
            cancelInk()
            guard let page = view.page(for: location, nearest: true) else { return }
            inkPage = page
            inkPoints = [view.convert(location, to: page)]
        case .changed, .ended:
            guard let page = inkPage else { return }
            inkPoints.append(view.convert(location, to: page))
            if let inkAnnotation { page.removeAnnotation(inkAnnotation) }
            let annotation = PDFAnnotation(bounds: page.bounds(for: .mediaBox), forType: .ink, withProperties: nil)
            annotation.color = selectedColor
            let border = PDFBorder()
            border.lineWidth = 2
            annotation.border = border
            let path = UIBezierPath()
            if let first = inkPoints.first { path.move(to: first) }
            for point in inkPoints.dropFirst() { path.addLine(to: point) }
            annotation.add(path)
            prepare(annotation)
            page.addAnnotation(annotation)
            inkAnnotation = annotation
            view.documentView?.setNeedsDisplay()
            if gesture.state == .ended {
                record { page.removeAnnotation(annotation) }
                inkAnnotation = nil
                inkPage = nil
                inkPoints = []
            }
        case .cancelled, .failed: cancelInk()
        default: break
        }
    }

    func cancelInk() {
        if let inkPage, let inkAnnotation { inkPage.removeAnnotation(inkAnnotation) }
        inkPage = nil
        inkAnnotation = nil
        inkPoints = []
        pdfView?.documentView?.setNeedsDisplay()
    }

    func save(force: Bool = false) async throws {
        guard editable, dirty else { return }
        guard !saving else { throw APIError.server(0, String(localized: "存檔中…", bundle: AppLanguage.bundle)) }
        selectionTask?.cancel()
        cancelInk()
        guard let api, let data = document?.dataRepresentation() else {
            throw APIError.server(0, String(localized: "PDF 尚未載入完成", bundle: AppLanguage.bundle))
        }
        saving = true
        defer { saving = false }
        let hash = try await api.savePdf(project: project, path: path, data: data, baseHash: self.hash, force: force)
        self.hash = hash
        original = data
        undoStack.removeAll()
        dirty = false
        let raw = try await api.rawFile(project: project, path: path)
        original = raw
        replaceDocument(raw)
    }
}

struct PDFAnnotationToolbar: View {
    @ObservedObject var annotator: PDFAnnotator
    let save: () -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                ForEach(PDFAnnotator.Tool.allCases, id: \.self) { tool in
                    Button { annotator.tool = annotator.tool == tool ? nil : tool } label: {
                        Image(systemName: tool.symbol).frame(width: 34, height: 34)
                            .background(annotator.tool == tool ? Theme.accent.opacity(0.2) : .clear, in: RoundedRectangle(cornerRadius: 8))
                    }
                    .accessibilityLabel(tool.title)
                    .accessibilityIdentifier("pdf-tool-\(tool.rawValue)")
                    .accessibilityAddTraits(annotator.tool == tool ? .isSelected : [])
                }
                Divider().frame(height: 26)
                ForEach(0..<4) { i in
                    Button { annotator.color = i } label: {
                        Circle().fill(Color(uiColor: PDFAnnotator.colors[i])).frame(width: 24, height: 24)
                            .padding(4).overlay(Circle().stroke(annotator.color == i ? Color.primary : .clear, lineWidth: 2))
                    }
                    .accessibilityLabel(PDFAnnotator.colorNames[i])
                    .accessibilityIdentifier("pdf-color-\(i)")
                    .accessibilityAddTraits(annotator.color == i ? .isSelected : [])
                }
                Button { annotator.undo() } label: { Image(systemName: "arrow.uturn.backward").frame(width: 34, height: 34) }
                    .accessibilityLabel("復原").accessibilityIdentifier("pdf-undo").disabled(!annotator.canUndo)
                Button(action: save) {
                    Label("存檔", systemImage: annotator.dirty ? "square.and.arrow.down.fill" : "square.and.arrow.down")
                        .padding(8).background(annotator.dirty ? Theme.accent.opacity(0.2) : .clear, in: RoundedRectangle(cornerRadius: 8))
                }
                .accessibilityIdentifier("pdf-save").disabled(!annotator.dirty || annotator.saving)
                if annotator.saving { ProgressView() }
                Button("完成") { annotator.active = false }
                    .accessibilityLabel("結束標註").accessibilityIdentifier("pdf-done")
            }
            // 右邊留出懸浮球的位置，最後幾個按鈕捲到底時不會被蓋住
            .padding(.leading, 12).padding(.trailing, 84).padding(.vertical, 8)
        }
        .buttonStyle(.borderless)
        .disabled(annotator.saving)
        .background(.bar)
        .accessibilityIdentifier("pdf-tools")
    }
}

/// 覆蓋層不接收觸碰;單指手勢由 PDFView 收集，雙指仍交給原本的捲動和縮放。
final class PDFInkOverlay: UIView, UIGestureRecognizerDelegate {
    weak var annotator: PDFAnnotator?
    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool { false }
    @objc func pan(_ gesture: UIPanGestureRecognizer) { annotator?.ink(gesture) }
    override func gestureRecognizerShouldBegin(_ gesture: UIGestureRecognizer) -> Bool { gesture.numberOfTouches == 1 }
    func gestureRecognizer(_ gesture: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
        other is UIPinchGestureRecognizer || other.numberOfTouches > 1
    }
}
