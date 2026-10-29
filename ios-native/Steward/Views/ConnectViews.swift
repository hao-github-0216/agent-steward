// 連線相關畫面:第一次填管家網址、輸入管理密碼、連不上
import SwiftUI

struct SetupView: View {
    @Environment(AppModel.self) private var model
    @State private var text = ""
    @State private var error: String?
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(spacing: 10) {
                        CatLogo().frame(width: 84, height: 84)
                        Text("專案管家").font(.title2.bold())
                        Text("連到你電腦上的專案管家")
                            .font(.subheadline).foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity)
                    .listRowBackground(Color.clear)
                }
                Section {
                    TextField("https://你的電腦.xxxx.ts.net:8793/", text: $text)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .focused($focused)
                        .submitLabel(.go)
                        .onSubmit(save)
                } header: {
                    Text("管家網址")
                } footer: {
                    Text(error ?? "在電腦的專案管家「設定 → 遠端存取」可以看到 Tailscale 網址。手機要先連上 Tailscale。")
                        .foregroundStyle(error == nil ? Color.secondary : Color.red)
                }
                Section {
                    Button("連線", action: save)
                        .frame(maxWidth: .infinity)
                        .disabled(text.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            .onAppear { text = model.server?.absoluteString ?? ""; focused = true }
        }
    }

    private func save() {
        guard let url = API.normalize(text) else {
            error = "網址看起來不對,例如 https://my-mac.tail1234.ts.net:8793/"
            return
        }
        error = nil
        model.setServer(url)
        Task { await model.connect() }
    }
}

struct LoginView: View {
    @Environment(AppModel.self) private var model
    let reason: String
    @State private var password = ""
    @State private var busy = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    SecureField("管理密碼", text: $password)
                        .submitLabel(.go)
                        .onSubmit(go)
                } header: {
                    Text("登入管家")
                } footer: {
                    Text(reason)
                }
                Section {
                    Button(action: go) {
                        if busy { ProgressView().frame(maxWidth: .infinity) } else { Text("登入").frame(maxWidth: .infinity) }
                    }
                    .disabled(password.isEmpty || busy)
                    Button("更換管家網址", role: .destructive) { model.forgetServer() }
                }
            }
            .navigationTitle(model.server?.host() ?? "管家")
        }
    }

    private func go() {
        busy = true
        Task {
            await model.login(password)
            busy = false
        }
    }
}

struct OfflineView: View {
    @Environment(AppModel.self) private var model
    let reason: String

    var body: some View {
        ContentUnavailableView {
            Label("連不上管家", systemImage: "wifi.exclamationmark")
        } description: {
            Text("\(reason)\n\n電腦有開著嗎?手機的 Tailscale 有連上嗎?")
        } actions: {
            Button("再試一次") { Task { await model.connect() } }
                .buttonStyle(.borderedProminent)
            Button("更換管家網址") { model.forgetServer() }
        }
    }
}

/// 管家的貓(跟網頁浮動球同一隻),用 SwiftUI 畫,不用圖片檔
struct CatLogo: View {
    var body: some View {
        Canvas { ctx, size in
            let s = min(size.width, size.height) / 64
            func p(_ x: Double, _ y: Double) -> CGPoint { CGPoint(x: x * s, y: y * s) }
            func tri(_ a: (Double, Double), _ b: (Double, Double), _ c: (Double, Double), _ color: Color) {
                var path = Path()
                path.move(to: p(a.0, a.1)); path.addLine(to: p(b.0, b.1)); path.addLine(to: p(c.0, c.1)); path.closeSubpath()
                ctx.fill(path, with: .color(color))
            }
            func oval(_ cx: Double, _ cy: Double, _ rx: Double, _ ry: Double, _ color: Color) {
                ctx.fill(Path(ellipseIn: CGRect(x: (cx - rx) * s, y: (cy - ry) * s, width: rx * 2 * s, height: ry * 2 * s)), with: .color(color))
            }
            let orange = Color(red: 0.965, green: 0.627, blue: 0.302)
            tri((11, 27), (13, 6), (28, 17), orange)
            tri((53, 27), (51, 6), (36, 17), orange)
            tri((15, 22), (16, 11), (24, 17), Color(red: 1, green: 0.70, blue: 0.76))
            tri((49, 22), (48, 11), (40, 17), Color(red: 1, green: 0.70, blue: 0.76))
            oval(32, 37, 24, 21, orange)
            oval(32, 44, 15, 11, Color(red: 1, green: 0.965, blue: 0.918))
            let eye = Color(red: 0.231, green: 0.165, blue: 0.125)
            oval(22.5, 35, 4.2, 5, eye); oval(41.5, 35, 4.2, 5, eye)
            oval(24, 33, 1.6, 1.6, .white); oval(43, 33, 1.6, 1.6, .white)
            tri((30, 41.5), (34, 41.5), (32, 43.9), Color(red: 1, green: 0.48, blue: 0.58))
            var mouth = Path()
            mouth.move(to: p(27.5, 45.5))
            mouth.addQuadCurve(to: p(32, 45.5), control: p(29.7, 48.1))
            mouth.addQuadCurve(to: p(36.5, 45.5), control: p(34.3, 48.1))
            ctx.stroke(mouth, with: .color(eye), style: StrokeStyle(lineWidth: 1.5 * s, lineCap: .round))
        }
        .accessibilityHidden(true)
    }
}
