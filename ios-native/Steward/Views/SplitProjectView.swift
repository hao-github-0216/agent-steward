// 拆出子資料夾(原生):跟網頁專案說明裡的「拆出子資料夾」一樣——
//   列出專案底下的子資料夾,按「拆成專案」就登記成獨立專案;也可以輸入完整路徑。登記好切到新專案的看板。
import SwiftUI

struct SplitProjectView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let projectId: String
    @State private var dirs: [API.Subdir]?
    @State private var error: String?
    @State private var busy: String?
    @State private var customPath = ""

    private var project: Project? { model.project(projectId) }
    private var custom: String { customPath.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    if let dirs, dirs.isEmpty {
                        Text("沒有子資料夾").foregroundStyle(.secondary)
                    }
                    ForEach(dirs ?? []) { d in
                        HStack(spacing: 12) {
                            Image(systemName: "folder.fill").foregroundStyle(Theme.accent)
                            Text(d.name).lineLimit(1)
                            Spacer(minLength: 8)
                            if d.project == true {
                                Text("已是專案").font(.subheadline).foregroundStyle(.secondary)
                            } else if busy == d.root {
                                ProgressView()
                            } else {
                                Button("拆成專案") { Task { await register(d.root) } }
                                    .buttonStyle(.bordered)
                                    .controlSize(.small)
                                    .disabled(busy != nil)
                            }
                        }
                    }
                } header: {
                    Text("子資料夾")
                } footer: {
                    Text("拆出來的子資料夾會變成獨立專案;之後在裡面的工作改記到新專案(已經記在「\(project?.name ?? "這個專案")」的內容不會搬過去)。")
                }
                Section {
                    TextField("例如 \(project?.root ?? "~")/某個資料夾", text: $customPath, axis: .vertical)
                        .font(.callout.monospaced())
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.done)
                    Button {
                        Task { await register(custom) }
                    } label: {
                        HStack {
                            Text("登記成專案")
                            Spacer()
                            if busy != nil && busy == custom { ProgressView() }
                        }
                    }
                    .disabled(custom.isEmpty || busy != nil)
                } header: {
                    Text("或輸入完整路徑")
                }
                if let error {
                    Section { Text(error).foregroundStyle(.red) }
                }
            }
            .listStyle(.insetGrouped)
            .overlay { if dirs == nil && error == nil { ProgressView() } }
            .navigationTitle("拆出子資料夾")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("關閉") { dismiss() } }
            }
            .task { await load() }
            .refreshable { await load() }
        }
    }

    private func load() async {
        do {
            dirs = try await model.api?.subdirs(project: projectId)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// 登記成專案,切到新專案的看板(跟網頁一樣)
    private func register(_ root: String) async {
        guard let api = model.api, !root.isEmpty else { return }
        busy = root
        defer { busy = nil }
        do {
            let id = try await api.registerProject(root: root)
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            await model.refresh()
            model.mode = .board
            model.switchProject(id)
            dismiss()
        } catch {
            self.error = error.localizedDescription
            UINotificationFeedbackGenerator().notificationOccurred(.error)
        }
    }
}
