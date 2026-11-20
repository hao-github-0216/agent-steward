import SwiftUI

struct FloatingChatWindow: View {
    @Environment(AppModel.self) private var model
    @State private var windowFrame: CGRect?
    @State private var dragStart: CGRect?
    @State private var keyboardFrame: CGRect = .null

    private var visible: Bool { model.showChat && model.chatFloating }

    var body: some View {
        GeometryReader { geometry in
            let bounds = CGRect(
                x: geometry.safeAreaInsets.leading,
                y: geometry.safeAreaInsets.top,
                width: max(0, geometry.size.width - geometry.safeAreaInsets.leading - geometry.safeAreaInsets.trailing),
                height: max(0, geometry.size.height - geometry.safeAreaInsets.top - geometry.safeAreaInsets.bottom)
            )
            let frame = clamped(windowFrame ?? defaultFrame(in: bounds), to: bounds)
            let displayedFrame = avoidingKeyboard(frame, in: bounds)
            Group {
                if visible {
                    window(frame: displayedFrame, bounds: bounds)
                        .position(x: displayedFrame.midX, y: displayedFrame.midY)
                        .transition(.opacity.combined(with: .scale(scale: 0.97)))
                }
            }
            .animation(.easeInOut(duration: 0.18), value: visible)
            .onChange(of: bounds, initial: true) { _, value in
                windowFrame = clamped(windowFrame ?? savedFrame() ?? defaultFrame(in: value), to: value)
                dragStart = nil
            }
            .onChange(of: visible) { _, shown in
                if shown {
                    windowFrame = clamped(savedFrame() ?? windowFrame ?? defaultFrame(in: bounds), to: bounds)
                }
                dragStart = nil
            }
            .background {
                ChatKeyboardFrameReader { keyboardFrame = $0 }
                    .allowsHitTesting(false)
            }
        }
        .coordinateSpace(name: "chat-window-space")
        .ignoresSafeArea(.keyboard)
    }

    private func window(frame: CGRect, bounds: CGRect) -> some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Text("問管家 · \(model.current?.name ?? "")")
                    .font(.headline)
                    .lineLimit(1)
                Spacer(minLength: 0)
                Button { model.showChat = false } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 14, weight: .semibold))
                        .frame(width: 36, height: 36)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("關閉")
                .accessibilityIdentifier("chat-window-close")
            }
            .padding(.leading, 16)
            .padding(.trailing, 8)
            .frame(height: 44)
            .contentShape(Rectangle())
            .gesture(drag(in: bounds))
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("chat-window-titlebar")
            Divider()
            ChatPanel()
        }
        .frame(width: frame.width, height: frame.height)
        .background(Color(.systemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 16))
        .overlay {
            RoundedRectangle(cornerRadius: 16)
                .strokeBorder(Color.primary.opacity(0.15), lineWidth: 1)
                .allowsHitTesting(false)
        }
        .overlay(alignment: .bottomTrailing) {
            Path { path in
                path.move(to: CGPoint(x: 2, y: 12))
                path.addLine(to: CGPoint(x: 12, y: 2))
                path.move(to: CGPoint(x: 7, y: 12))
                path.addLine(to: CGPoint(x: 12, y: 7))
            }
            .stroke(Color.secondary, style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
            .frame(width: 12, height: 12)
            .padding(5)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
        }
        .overlay {
            ForEach(ChatResizeEdge.allCases, id: \.self) { edge in
                let handle = edge.handle(in: frame.size)
                Color.clear
                    .frame(width: handle.width, height: handle.height)
                    .contentShape(Rectangle())
                    .gesture(resize(edge, in: bounds))
                    .accessibilityElement()
                    .accessibilityLabel("調整視窗大小")
                    .accessibilityIdentifier("chat-resize-\(edge.rawValue)")
                    .position(x: handle.midX, y: handle.midY)
            }
        }
        .shadow(color: .black.opacity(0.2), radius: 18, y: 6)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("chat-window")
    }

    private func drag(in bounds: CGRect) -> some Gesture {
        DragGesture(minimumDistance: 4, coordinateSpace: .named("chat-window-space"))
            .onChanged { value in
                let start = dragStart ?? windowFrame ?? defaultFrame(in: bounds)
                dragStart = start
                windowFrame = clamped(start.offsetBy(dx: value.translation.width, dy: value.translation.height), to: bounds)
            }
            .onEnded { _ in finishDrag() }
    }

    private func resize(_ edge: ChatResizeEdge, in bounds: CGRect) -> some Gesture {
        DragGesture(minimumDistance: 1, coordinateSpace: .named("chat-window-space"))
            .onChanged { value in
                let start = dragStart ?? windowFrame ?? defaultFrame(in: bounds)
                dragStart = start
                let minWidth = min(320, bounds.width), minHeight = min(360, bounds.height)
                var left = start.minX, right = start.maxX, top = start.minY, bottom = start.maxY
                if edge.west { left = min(max(start.minX + value.translation.width, bounds.minX), right - minWidth) }
                if edge.east { right = max(min(start.maxX + value.translation.width, bounds.maxX), left + minWidth) }
                if edge.north { top = min(max(start.minY + value.translation.height, bounds.minY), bottom - minHeight) }
                if edge.south { bottom = max(min(start.maxY + value.translation.height, bounds.maxY), top + minHeight) }
                windowFrame = clamped(CGRect(x: left, y: top, width: right - left, height: bottom - top), to: bounds)
            }
            .onEnded { _ in finishDrag() }
    }

    private func finishDrag() {
        dragStart = nil
        guard let frame = windowFrame else { return }
        UserDefaults.standard.set([Double(frame.minX), Double(frame.minY), Double(frame.width), Double(frame.height)], forKey: "chatWindowFrame")
    }

    private func savedFrame() -> CGRect? {
        guard let values = UserDefaults.standard.array(forKey: "chatWindowFrame") as? [Double],
              values.count == 4, values.allSatisfy(\.isFinite), values[2] > 0, values[3] > 0 else { return nil }
        return CGRect(x: values[0], y: values[1], width: values[2], height: values[3])
    }

    private func defaultFrame(in bounds: CGRect) -> CGRect {
        let width = min(420, bounds.width)
        let height = min(bounds.height, max(360, min(640, bounds.height - 160)))
        return clamped(CGRect(x: bounds.maxX - width - 16, y: bounds.maxY - height - 96, width: width, height: height), to: bounds)
    }

    private func clamped(_ frame: CGRect, to bounds: CGRect) -> CGRect {
        let width = min(bounds.width, max(min(320, bounds.width), frame.width))
        let height = min(bounds.height, max(min(360, bounds.height), frame.height))
        return CGRect(x: min(max(frame.minX, bounds.minX), bounds.maxX - width),
                      y: min(max(frame.minY, bounds.minY), bounds.maxY - height), width: width, height: height)
    }

    /// 鍵盤只改畫面上的位置和大小，不覆寫使用者記住的視窗範圍。
    private func avoidingKeyboard(_ frame: CGRect, in bounds: CGRect) -> CGRect {
        guard frame.intersects(keyboardFrame), keyboardFrame.minY < bounds.maxY else { return frame }
        let aboveKeyboard = CGRect(x: bounds.minX, y: bounds.minY, width: bounds.width,
                                   height: max(0, keyboardFrame.minY - bounds.minY - 8))
        return clamped(frame, to: aboveKeyboard)
    }
}

private enum ChatResizeEdge: String, CaseIterable {
    case n, s, e, w, ne, nw, se, sw

    var north: Bool { self == .n || self == .ne || self == .nw }
    var south: Bool { self == .s || self == .se || self == .sw }
    var east: Bool { self == .e || self == .ne || self == .se }
    var west: Bool { self == .w || self == .nw || self == .sw }

    func handle(in size: CGSize) -> CGRect {
        if (north || south) && (east || west) {
            return CGRect(x: west ? 0 : size.width - 20, y: north ? 0 : size.height - 20, width: 20, height: 20)
        }
        if north || south {
            return CGRect(x: 20, y: north ? 0 : size.height - 8, width: max(0, size.width - 40), height: 8)
        }
        return CGRect(x: west ? 0 : size.width - 8, y: 20, width: 8, height: max(0, size.height - 40))
    }
}

private struct ChatKeyboardFrameReader: UIViewRepresentable {
    let onChange: (CGRect) -> Void

    func makeUIView(context: Context) -> ChatKeyboardView {
        let view = ChatKeyboardView()
        view.onChange = onChange
        return view
    }

    func updateUIView(_ uiView: ChatKeyboardView, context: Context) {
        uiView.onChange = onChange
    }
}

private final class ChatKeyboardView: UIView {
    var onChange: ((CGRect) -> Void)?
    private var screenFrame: CGRect = .null

    init() {
        super.init(frame: .zero)
        NotificationCenter.default.addObserver(self, selector: #selector(keyboardChanged(_:)), name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(keyboardChanged(_:)), name: UIResponder.keyboardWillHideNotification, object: nil)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func layoutSubviews() {
        super.layoutSubviews()
        reportFrame()
    }

    @objc private func keyboardChanged(_ notification: Notification) {
        screenFrame = notification.name == UIResponder.keyboardWillHideNotification ? .null :
            (notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect ?? .null)
        reportFrame()
    }

    private func reportFrame() {
        guard let window else { return }
        let frame = screenFrame.isNull ? CGRect.null : convert(screenFrame, from: window.screen.coordinateSpace)
        let intersection = bounds.intersection(frame)
        DispatchQueue.main.async { [weak self] in self?.onChange?(intersection) }
    }
}
