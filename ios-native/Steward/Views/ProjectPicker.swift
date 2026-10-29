// 專案清單(點標題的專案名稱打開):換專案、專案的動作。分組和按鈕名稱跟網頁的專案欄一樣,元件用 Apple 的清單
import SwiftUI

struct ProjectPicker: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var renaming: Project?
    @State private var newName = ""
    @State private var stopping: Project?
    @State private var error: String?

    private func match(_ p: Project) -> Bool {
        let q = query.trimmingCharacters(in: .whitespaces)
        return q.isEmpty || p.name.localizedCaseInsensitiveContains(q) || (p.root ?? "").localizedCaseInsensitiveContains(q)
    }

    var body: some View {
        NavigationStack {
            List {
                if let error { Text(error).font(.footnote).foregroundStyle(.red) }
                Section("專案") {
                    let list = model.projects.filter(match)
                    if list.isEmpty { Text("還沒有專案").foregroundStyle(.secondary) }
                    ForEach(list) { p in
                        projectButton(p)
                            .contextMenu { actions(p) }
                            .swipeActions(edge: .trailing) {
                                Button(role: .destructive) { stopping = p } label: { Label("停止追蹤", systemImage: "eye.slash") }
                                Button { newName = p.name; renaming = p } label: { Label("改名", systemImage: "pencil") }.tint(.gray)
                            }
                    }
                }
                let special = model.specialProjects.filter(match)
                if !special.isEmpty {
                    Section("其他") {
                        ForEach(special) { p in projectButton(p) }
                    }
                }
                let pending = model.pendingFolders.filter(match)
                if !pending.isEmpty {
                    Section("要登記成專案嗎?") {
                        ForEach(pending) { p in
                            VStack(alignment: .leading, spacing: 8) {
                                Text(p.root ?? p.name).font(.subheadline.weight(.semibold))
                                HStack {
                                    Button("登記") { Task { await set(p, ["status": "active"]) } }.buttonStyle(.borderedProminent)
                                    Button("略過") { Task { await set(p, ["status": "ignored"]) } }.buttonStyle(.bordered)
                                }
                            }
                            .padding(.vertical, 2)
                        }
                    }
                }
                let closed = model.closedProjects.filter(match)
                if !closed.isEmpty {
                    Section {
                        ForEach(closed) { p in
                            VStack(alignment: .leading, spacing: 6) {
                                Text(p.name).font(.headline)
                                Text("\(p.root ?? "")\(p.closedAt.map { " · \(Fmt.ago(Fmt.date($0)))收起" } ?? "")").font(.caption).foregroundStyle(.secondary)
                                HStack {
                                    Button("打開") { Task { await reopen(p) } }.buttonStyle(.borderedProminent)
                                    Button("停止追蹤") { Task { await set(p, ["status": "ignored"]) } }.buttonStyle(.bordered)
                                }
                            }
                            .padding(.vertical, 2)
                        }
                    } header: {
                        Text("已收起(\(closed.count))")
                    } footer: {
                        Text("herdr 的 space 被關掉的專案。在它的資料夾裡開 agent 就會自動回來。")
                    }
                }
                let stopped = model.stoppedProjects.filter(match)
                if !stopped.isEmpty {
                    Section("已停止追蹤(\(stopped.count))") {
                        ForEach(stopped) { p in
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(p.name)
                                    Text("\(p.root ?? "")\(p.state?.updatedAt.map { " · 紀錄保留到 \(Fmt.ago(Fmt.date($0)))" } ?? "")").font(.caption).foregroundStyle(.secondary).lineLimit(2)
                                }
                                Spacer()
                                Button("恢復追蹤") { Task { await set(p, ["status": "active"]) } }.buttonStyle(.bordered)
                            }
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .searchable(text: $query, prompt: "找專案")
            .refreshable { await model.refresh() }
            .navigationTitle("專案")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Menu {
                        Button { open(.create) } label: { Label("建立專案", systemImage: "folder.badge.plus") }
                        Button { open(.tidy) } label: { Label("整理 spaces", systemImage: "rectangle.3.group") }
                    } label: {
                        Image(systemName: "plus")
                    }
                    .accessibilityLabel("建立專案或整理 spaces")
                }
                ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } }
            }
            .alert("改名", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
                TextField("新名稱", text: $newName)
                Button("儲存") { if let p = renaming { Task { await set(p, ["name": newName.trimmingCharacters(in: .whitespaces)]) } } }
                Button("取消", role: .cancel) {}
            } message: {
                Text("herdr 的 space 也會跟著改名。")
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
    }

    private func projectButton(_ p: Project) -> some View {
        Button {
            model.switchProject(p.id)
            dismiss()
        } label: {
            ProjectRow(project: p, selected: p.id == model.currentProjectId)
        }
        .buttonStyle(.plain)
    }

    /// 長按專案的動作(網頁專案旁的「⋯」)
    @ViewBuilder
    private func actions(_ p: Project) -> some View {
        Button { go(p, .terminal) } label: { Label("在終端機開啟", systemImage: "terminal") }
        Button { go(p, .code) } label: { Label("在程式碼模式開啟", systemImage: "chevron.left.forwardslash.chevron.right") }
        Button { newName = p.name; renaming = p } label: { Label("改名", systemImage: "pencil") }
        Button(role: .destructive) { stopping = p } label: { Label("停止追蹤", systemImage: "eye.slash") }
    }

    private func go(_ p: Project, _ mode: Mode) {
        model.switchProject(p.id)
        model.mode = mode
        dismiss()
    }

    /// 建立專案、整理 spaces 是網頁的對話框:等專案清單收好再打開(兩個視窗不能同時升起)
    private func open(_ w: WebSheet) {
        model.pendingPresentation = .web(w)
        dismiss()
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
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

struct ProjectRow: View {
    @Environment(AppModel.self) private var model
    let project: Project
    var selected = false

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    if project.private == true { Image(systemName: "lock.fill").font(.caption).foregroundStyle(.secondary) }
                    Text(project.name).font(.headline).lineLimit(1)
                    Spacer(minLength: 4)
                    let n = model.openCount(project)
                    if n > 0 {
                        Text("\(n)")
                            .font(.caption.bold())
                            .padding(.horizontal, 7).padding(.vertical, 2)
                            .background(Color.orange, in: Capsule())
                            .foregroundStyle(.white)
                            .accessibilityLabel("\(n) 張提案或卡住")
                    }
                    let w = model.working(project)
                    if w > 0 {
                        Label("\(w)", systemImage: "bolt.fill")
                            .font(.caption.bold())
                            .foregroundStyle(.orange)
                            .accessibilityLabel("\(w) 個 agent 工作中")
                    }
                }
                if let progress = project.state?.progress, !progress.isEmpty {
                    Text(Markdown.plain(progress)).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                }
                Text(project.lastActive.map { Fmt.ago($0) } ?? "尚無紀錄").font(.caption).foregroundStyle(.tertiary)
            }
            if selected {
                Image(systemName: "checkmark").font(.body.weight(.semibold)).foregroundStyle(Theme.accent)
                    .accessibilityLabel("目前的專案")
            }
        }
        .contentShape(Rectangle())
        .padding(.vertical, 2)
    }
}
