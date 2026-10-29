// 專案欄(網頁的 nav):從左邊滑出來換專案,分組和按鈕跟網頁一樣
import SwiftUI

struct ProjectSidebar: View {
    @Environment(AppModel.self) private var model
    let width: CGFloat
    @State private var renaming: Project?
    @State private var newName = ""
    @State private var stopping: Project?
    @State private var error: String?

    var body: some View {
        HStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 8) {
                        Button("＋ 建立專案") { model.showNav = false; model.webSheet = .create }.buttonStyle(.smallPrimary)
                        Button("整理 spaces") { model.showNav = false; model.webSheet = .tidy }.buttonStyle(.small)
                    }
                    .padding(.bottom, 6)
                    if let error { Text(error).font(.system(size: 12)).foregroundStyle(Theme.bad) }
                    heading("專案")
                    if model.projects.isEmpty { Text("還沒有專案").font(.system(size: 13)).foregroundStyle(Theme.muted).padding(8) }
                    ForEach(model.projects) { p in row(p, menu: true) }
                    if !model.specialProjects.isEmpty {
                        heading("其他")
                        ForEach(model.specialProjects) { p in row(p, menu: false) }
                    }
                    if !model.pendingFolders.isEmpty {
                        heading("要登記成專案嗎?")
                        ForEach(model.pendingFolders) { p in
                            VStack(alignment: .leading, spacing: 6) {
                                Text(p.root ?? p.name).font(.system(size: 13, weight: .semibold)).lineLimit(2)
                                HStack {
                                    Button("登記") { Task { await set(p, ["status": "active"]) } }.buttonStyle(.smallPrimary)
                                    Button("略過") { Task { await set(p, ["status": "ignored"]) } }.buttonStyle(.small)
                                }
                            }
                            .padding(8)
                        }
                    }
                    if !model.closedProjects.isEmpty {
                        DisclosureGroup {
                            Text("herdr 的 space 被關掉的專案。在它的資料夾裡開 agent 就會自動回來。").font(.system(size: 12)).foregroundStyle(Theme.muted)
                            ForEach(model.closedProjects) { p in
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(p.name).font(.system(size: 13, weight: .semibold))
                                    Text("\(p.root ?? "")\(p.closedAt.map { " · \(Fmt.ago(Fmt.date($0)))收起" } ?? "")").font(.system(size: 12)).foregroundStyle(Theme.muted)
                                    HStack {
                                        Button("打開") { Task { await reopen(p) } }.buttonStyle(.smallPrimary)
                                        Button("停止追蹤") { Task { await set(p, ["status": "ignored"]) } }.buttonStyle(.small)
                                    }
                                }
                                .padding(.vertical, 6)
                            }
                        } label: {
                            heading("已收起(\(model.closedProjects.count))")
                        }
                    }
                    if !model.stoppedProjects.isEmpty {
                        DisclosureGroup {
                            ForEach(model.stoppedProjects) { p in
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(p.name).font(.system(size: 13, weight: .semibold))
                                    Text("\(p.root ?? "")\(p.state?.updatedAt.map { " · 紀錄保留到 \(Fmt.ago(Fmt.date($0)))" } ?? "")").font(.system(size: 12)).foregroundStyle(Theme.muted)
                                    Button("恢復追蹤") { Task { await set(p, ["status": "active"]) } }.buttonStyle(.smallPrimary)
                                }
                                .padding(.vertical, 6)
                            }
                        } label: {
                            heading("已停止追蹤(\(model.stoppedProjects.count))")
                        }
                    }
                }
                .padding(12)
            }
            .frame(width: width)
            .background(Theme.panel)
            .overlay(alignment: .trailing) { Rectangle().fill(Theme.line).frame(width: 1) }
            .shadow(color: .black.opacity(0.18), radius: 12, x: 8)
            // 點旁邊收起來
            Color.black.opacity(0.15)
                .contentShape(Rectangle())
                .onTapGesture { model.showNav = false }
                .accessibilityLabel("收起專案欄")
                .accessibilityAddTraits(.isButton)
        }
        .alert("改名", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField("新名稱", text: $newName)
            Button("儲存") { if let p = renaming { Task { await set(p, ["name": newName.trimmingCharacters(in: .whitespaces)]) } } }
            Button("取消", role: .cancel) {}
        } message: {
            Text("新名稱(herdr 的 space 也會跟著改)")
        }
        .confirmationDialog("停止追蹤「\(stopping?.name ?? "")」?", isPresented: Binding(get: { stopping != nil }, set: { if !$0 { stopping = nil } }), titleVisibility: .visible) {
            if let p = stopping {
                Button("停止追蹤", role: .destructive) { Task { await set(p, ["status": "ignored"]) } }
                if model.spaces[p.id]?.label != nil {
                    Button("停止追蹤並關掉 herdr 的 space", role: .destructive) { Task { await set(p, ["status": "ignored", "closeSpace": true]) } }
                }
            }
        } message: {
            Text("管家不再整理這個資料夾的進度(紀錄會保留,之後可以恢復追蹤)。關掉 space 會停掉裡面還在跑的 agent。")
        }
    }

    private func heading(_ t: String) -> some View {
        Text(t).font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.muted)
            .padding(.top, 12).padding(.bottom, 4).padding(.horizontal, 4)
    }

    /// 網頁的 .projrow:選到的藍底白字;右邊是提案+卡住的數字和「⋯」
    private func row(_ p: Project, menu: Bool) -> some View {
        let selected = p.id == model.currentProjectId
        let n = model.openCount(p)
        return HStack(spacing: 4) {
            Button {
                model.switchProject(p.id)
                model.showNav = false
            } label: {
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text("\(p.private == true ? "🔒 " : "")\(p.name)").font(.system(size: 14)).lineLimit(1)
                        Text(p.lastActive.map { Fmt.ago($0) } ?? "尚無紀錄").font(.system(size: 11))
                            .foregroundStyle(selected ? Color.white.opacity(0.8) : Theme.muted)
                    }
                    Spacer(minLength: 4)
                    if n > 0 {
                        Text("\(n)").font(.system(size: 11)).padding(.horizontal, 6).padding(.vertical, 1)
                            .background(Theme.warn, in: Capsule()).foregroundStyle(.white)
                            .accessibilityLabel("\(n) 張提案或卡住")
                    }
                    if model.working(p) > 0 {
                        Image(systemName: "bolt.fill").font(.system(size: 10)).foregroundStyle(selected ? Color.white : Color.orange)
                            .accessibilityLabel("agent 工作中")
                    }
                }
                .padding(.horizontal, 10).padding(.vertical, 8)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if menu {
                Menu {
                    Button { model.switchProject(p.id); model.showNav = false; model.mode = .terminal } label: { Label("在終端機開啟", systemImage: "terminal") }
                    Button { model.switchProject(p.id); model.showNav = false; model.mode = .code } label: { Label("在程式碼模式開啟", systemImage: "chevron.left.forwardslash.chevron.right") }
                    Button { newName = p.name; renaming = p } label: { Label("改名", systemImage: "pencil") }
                    Button(role: .destructive) { stopping = p } label: { Label("停止追蹤", systemImage: "eye.slash") }
                } label: {
                    Text("⋯").font(.system(size: 16, weight: .bold)).frame(width: 28, height: 28)
                        .foregroundStyle(selected ? Color.white : Theme.muted)
                }
                .accessibilityLabel("\(p.name) 的更多動作")
            }
        }
        .foregroundStyle(selected ? Color.white : Theme.ink)
        .background(selected ? Theme.accent : Color.clear, in: RoundedRectangle(cornerRadius: 8))
    }

    private func set(_ p: Project, _ body: [String: Any]) async {
        do { try await model.updateProject(p.id, body); error = nil } catch { self.error = error.localizedDescription }
    }

    /// 打開收起的專案:恢復追蹤,並在 herdr 開一個新的 space 綁上
    private func reopen(_ p: Project) async {
        do {
            try await model.updateProject(p.id, ["status": "active"])
            try? await model.api?.focusTerminal(project: p.id, create: true)
            await model.refresh()
            model.switchProject(p.id)
            model.showNav = false
        } catch {
            self.error = error.localizedDescription
        }
    }
}
