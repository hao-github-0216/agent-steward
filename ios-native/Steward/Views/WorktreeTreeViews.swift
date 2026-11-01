// 分支樹狀圖(原生):資料夾樹(repo → 作業資料夾 → worktree / 留下的分支)和分岔圖(主線 + 從分岔點長出的枝)
// 資料:GET worktrees/tree(docs/worktrees-api.md 最後一節)
import SwiftUI

// MARK: - 示意資料(管家還沒部署樹狀圖 API 時,Debug 版用規格裡的範例)

enum WorktreeTreeDemo {
    static let tree: WorktreeTree? = {
        let now = ISO8601DateFormatter().string(from: .now)
        let json = """
        {"repo":true,"repoRoot":"/demo/course","repoName":"course","target":"main","currentFolder":"hw1",
         "folders":[{"path":"hw1","projectId":"demo","name":"hw1","current":true},{"path":"hw3","name":"hw3","current":false}],
         "items":[
          {"id":"0000000000","path":"/demo/course","source":"main","branch":"main","exists":true,"folder":""},
          {"id":"a1b2c3d4e5","path":"/demo/course/.claude/worktrees/hw1-extra","cwd":"/demo/course/.claude/worktrees/hw1-extra/hw1","exists":true,"source":"claude","branch":"worktree-hw1-extra","ahead":1,"behind":0,"dirty":2,"relevant":true,"lastModified":"\(now)","folder":"hw1",
           "session":{"agent":"claude","pane":{"paneId":"w3:p2"},"alive":true}},
          {"id":"b2f18a42c0","path":"/demo/.agent-steward/worktrees/course-fix","exists":true,"source":"steward","branch":"steward/branch-b2f18a42","ahead":2,"behind":0,"dirty":0,"relevant":true,"lastModified":"2026-10-30T10:00:00.000Z","folder":"hw1",
           "session":{"agent":"codex","alive":false}},
          {"id":"c3d4e5f6a7","path":"/demo/course-try","exists":true,"source":"manual","branch":"try-layout","ahead":0,"behind":4,"dirty":0,"lastModified":"2026-10-20T10:00:00.000Z","folder":""}
         ],
         "leftovers":[
          {"branch":"worktree-hw1-old","source":"claude","folder":"hw1","ahead":2,"merged":true,"session":{"agent":"claude"},"lastModified":"2026-10-28T10:00:00.000Z"},
          {"branch":"worktree-hw3-try","source":"claude","folder":"hw3","ahead":12,"merged":false,"session":{"agent":"pi"},"lastModified":"2026-10-25T10:00:00.000Z"}
         ],
         "graph":{"nodes":[
           {"hash":"1","short":"4c1e2aa","subject":"hw3 開始","gapBefore":3},
           {"hash":"2","short":"9ba55f9","subject":"hw1 第一題","gapBefore":0},
           {"hash":"3","short":"d07b3e1","subject":"Merge worktree-hw1-old","gapBefore":5},
           {"hash":"4","short":"e882fd8","subject":"hw1 第二題","gapBefore":2}],
          "branches":[
           {"key":"branch:worktree-hw3-try","branch":"worktree-hw3-try","forkAt":0,"ahead":12},
           {"key":"branch:worktree-hw1-old","branch":"worktree-hw1-old","forkAt":1,"mergedAt":2,"ahead":2},
           {"key":"a1b2c3d4e5","branch":"worktree-hw1-extra","forkAt":2,"ahead":1},
           {"key":"b2f18a42c0","branch":"steward/branch-b2f18a42","forkAt":3,"ahead":2}],
          "truncated":false}}
        """
        return try? JSONDecoder().decode(WorktreeTree.self, from: Data(json.utf8))
    }()
}

// MARK: - 資料夾樹的列

/// 留下的分支(worktree 已移除):只顯示
struct WorktreeLeftoverRow: View {
    let leftover: WorktreeTree.Leftover
    let target: String?

    var body: some View {
        let l = leftover
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Image(systemName: "arrow.triangle.branch").foregroundStyle(.tertiary).font(.caption)
                Text(l.branch).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                Spacer(minLength: 4)
                if l.merged == true {
                    Text("✔ 已合併").font(.caption2.bold()).foregroundStyle(.green)
                }
                Text("worktree 已移除")
                    .font(.caption2)
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(Color(.tertiarySystemFill), in: Capsule())
                    .foregroundStyle(.secondary)
            }
            HStack(spacing: 10) {
                if let a = l.ahead, a > 0, l.merged != true { Text("領先 \(target ?? "主線") \(a)") }
                if let agent = l.session?.agent { Text(agent) }
                Text(Fmt.ago(Fmt.date(l.lastModified)))
            }
            .font(.caption).foregroundStyle(.tertiary)
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

extension WorktreeTree {
    /// 某個資料夾裡的 worktree(主資料夾不算;folder 對不到任何資料夾的歸到「其他」= "")
    func items(in folder: String) -> [Worktree] {
        let known = Set((folders ?? []).map(\.path))
        return others.filter { w in
            let f = w.folder ?? ""
            return folder.isEmpty ? (f.isEmpty || !known.contains(f)) : f == folder
        }
    }
    func leftovers(in folder: String) -> [Leftover] {
        let known = Set((folders ?? []).map(\.path))
        return (leftovers ?? []).filter { l in
            let f = l.folder ?? ""
            return folder.isEmpty ? (f.isEmpty || !known.contains(f)) : f == folder
        }
    }
    /// 收合時顯示的數量:worktree + 還沒合併的留下分支
    func count(in folder: String) -> Int {
        items(in: folder).count + leftovers(in: folder).filter { $0.merged != true }.count
    }
    /// 分岔圖上那條枝的來源(claude / steward / manual)
    func source(for key: String) -> String? {
        if let w = items?.first(where: { $0.id == key }) { return w.source }
        return leftovers?.first(where: { $0.id == key })?.source
    }
    /// 分岔圖上那條枝是誰開的
    func agent(for key: String) -> String? {
        if let w = items?.first(where: { $0.id == key }) { return w.session?.agent }
        return leftovers?.first(where: { $0.id == key })?.session?.agent
    }
}

// MARK: - 分岔圖

/// 主線畫成一條橫線、點依序排開;每條分支從分岔點長出一條枝,合併過的畫線合回去。
/// 太寬放不下(iPhone)就左右捲動,iPad 放得下直接攤開
struct WorktreeGraphView<Actions: View>: View {
    let tree: WorktreeTree
    @ViewBuilder let actions: (Worktree) -> Actions

    /// 顏色跟網頁一樣:Claude 橘、管家支線藍、手動綠
    private func color(_ b: WorktreeTree.Branch) -> Color {
        switch tree.source(for: b.key) {
        case "claude": .orange
        case "steward": Theme.accent
        case "manual": .green
        default: b.key.hasPrefix("branch:steward/") ? Theme.accent : b.key.hasPrefix("branch:worktree-") ? .orange : .gray
        }
    }
    private let nodeGap: CGFloat = 104
    private let gapW: CGFloat = 92
    private let padL: CGFloat = 24
    private let mainY: CGFloat = 62
    private let laneTop: CGFloat = 116
    private let laneH: CGFloat = 50

    var body: some View {
        if let g = tree.graph, !g.nodes.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                ViewThatFits(in: .horizontal) {
                    canvas(g)
                    // 放不下就左右捲動;一打開捲到最早一條還沒合併的分支的分岔點(不然只看到舊的 commit)
                    ScrollViewReader { proxy in
                        ScrollView(.horizontal, showsIndicators: true) {
                            canvas(g).background(alignment: .topLeading) {
                                HStack(spacing: 0) {
                                    Color.clear.frame(width: scrollStart(g), height: 1)
                                    Color.clear.frame(width: 1, height: 1).id("start")
                                }
                            }
                        }
                        .onAppear { DispatchQueue.main.async { proxy.scrollTo("start", anchor: .leading) } }
                    }
                }
                if g.truncated == true {
                    Text("主線太長,只畫最近的部分;更舊的分岔點接在最左邊的點。").font(.caption2).foregroundStyle(.secondary).padding(.horizontal, 12)
                }
            }
            .padding(.vertical, 8)
        } else {
            Text("主線上還沒有分岔出去的分支。").font(.subheadline).foregroundStyle(.secondary)
        }
    }

    private struct Layout {
        var nodeX: [CGFloat] = []
        var gapX: [Int: CGFloat] = [:]
        var width: CGFloat = 0
        var height: CGFloat = 0
    }

    private func layout(_ g: WorktreeTree.Graph) -> Layout {
        var l = Layout()
        var x = padL + 10
        for (i, n) in g.nodes.enumerated() {
            let gap = (n.gapBefore ?? 0) > 0
            if gap { x += gapW }
            l.nodeX.append(x)
            // 「⋯ N 個 commit」放在前一個點(第一個點就是線頭)和這個點的正中間
            if gap { l.gapX[i] = ((i == 0 ? padL : l.nodeX[i - 1]) + x) / 2 }
            x += nodeGap
        }
        var w = (l.nodeX.last ?? x) + nodeGap / 2
        for b in g.branches {
            w = max(w, labelX(b, l, g) + labelWidth(b) + 16)
        }
        l.width = w
        l.height = laneTop + CGFloat(g.branches.count) * laneH
        return l
    }

    /// 一打開要捲到的位置:最早一條還沒合併的分支的分岔點(都合併了就看最新的點)
    private func scrollStart(_ g: WorktreeTree.Graph) -> CGFloat {
        let l = layout(g)
        let x: CGFloat
        if let fork = g.branches.filter({ $0.mergedAt == nil }).map(\.forkAt).min() {
            x = l.nodeX[clamp(fork, g)]
        } else {
            x = (l.nodeX.last ?? 0) - 200
        }
        return max(x - 60, 0)
    }

    /// 枝由上到下的順序:已合併的(線短)靠近主線,還沒合併的放下面,各自照分岔點新到舊,線比較不會交叉
    private func lanes(_ g: WorktreeTree.Graph) -> [WorktreeTree.Branch] {
        let merged = g.branches.filter { $0.mergedAt != nil }.sorted { $0.forkAt > $1.forkAt }
        let open = g.branches.filter { $0.mergedAt == nil }.sorted { $0.forkAt > $1.forkAt }
        return merged + open
    }

    private func clamp(_ i: Int, _ g: WorktreeTree.Graph) -> Int { min(max(i, 0), g.nodes.count - 1) }

    /// 估標籤寬度(只用來算畫布要多寬)
    private func labelWidth(_ b: WorktreeTree.Branch) -> CGFloat {
        let text = (b.branch ?? b.key) + " +\(b.ahead ?? 0) " + (tree.agent(for: b.key) ?? "") + (b.mergedAt != nil ? " ✔ 已合併" : "")
        return CGFloat(text.count) * 7.5 + 24
    }

    private func canvas(_ g: WorktreeTree.Graph) -> some View {
        let l = layout(g)
        return ZStack(alignment: .topLeading) {
            // 枝
            ForEach(Array(lanes(g).enumerated()), id: \.element.id) { i, b in
                let color = color(b)
                // 已合併用虛線
                branchPath(b, lane: i, l, g)
                    .stroke(color.opacity(b.mergedAt != nil ? 0.7 : 1), style: StrokeStyle(lineWidth: 2.5, lineCap: .round, lineJoin: .round, dash: b.mergedAt != nil ? [5, 4] : []))
                if b.mergedAt == nil {
                    Circle().fill(color).frame(width: 9, height: 9)
                        .offset(x: endX(b, l, g) - 4.5, y: laneY(i) - 4.5)
                }
            }
            // 主線
            Path { p in
                p.move(to: CGPoint(x: padL, y: mainY))
                p.addLine(to: CGPoint(x: (l.nodeX.last ?? padL) + 24, y: mainY))
            }
            .stroke(Color.primary.opacity(0.7), lineWidth: 3)
            Text(tree.target ?? "主線")
                .font(.caption.bold())
                .offset(x: padL - 4, y: mainY + 8)
            // 省略的 commit
            ForEach(Array(l.gapX.keys.sorted()), id: \.self) { i in
                Text("⋯ \(g.nodes[i].gapBefore ?? 0) 個 commit")
                    .font(.caption2).foregroundStyle(.secondary)
                    .fixedSize()
                    .padding(.horizontal, 4)
                    .background(Color(.secondarySystemGroupedBackground))
                    .offset(x: l.gapX[i]! - 34, y: mainY - 8)
            }
            // 主線上的點
            ForEach(Array(g.nodes.enumerated()), id: \.element.hash) { i, n in
                let x = l.nodeX[i]
                Circle().fill(Color.primary).frame(width: 11, height: 11).offset(x: x - 5.5, y: mainY - 5.5)
                VStack(spacing: 1) {
                    Text(n.subject ?? "").font(.caption2).lineLimit(1).truncationMode(.tail)
                    Text(n.short ?? String(n.hash.prefix(7))).font(.caption2.monospaced()).foregroundStyle(.secondary)
                }
                .frame(width: nodeGap - 10)
                .offset(x: max(x - (nodeGap - 10) / 2, 2), y: mainY - 44)
                .accessibilityElement(children: .combine)
            }
            // 枝的標籤:worktree 點了有四個動作;留下的分支只顯示
            ForEach(Array(lanes(g).enumerated()), id: \.element.id) { i, b in
                label(b, color: color(b))
                    .offset(x: labelX(b, l, g), y: laneY(i) - (b.mergedAt != nil ? 11 : 24))
            }
        }
        .frame(width: l.width, height: l.height, alignment: .topLeading)
    }

    /// 標籤的左邊:還沒合併的放在枝上方;已合併的放在合回去那條線的右邊(不壓到虛線)
    private func labelX(_ b: WorktreeTree.Branch, _ l: Layout, _ g: WorktreeTree.Graph) -> CGFloat {
        let fx = l.nodeX[clamp(b.forkAt, g)]
        if let m = b.mergedAt { return max(l.nodeX[clamp(m, g)], fx + 40) + 10 }
        return fx + 18
    }

    private func laneY(_ i: Int) -> CGFloat { laneTop + CGFloat(i) * laneH + 14 }

    private func endX(_ b: WorktreeTree.Branch, _ l: Layout, _ g: WorktreeTree.Graph) -> CGFloat {
        let fx = l.nodeX[clamp(b.forkAt, g)]
        if let m = b.mergedAt { return l.nodeX[clamp(m, g)] }
        return fx + 18 + min(labelWidth(b), 160)
    }

    private func branchPath(_ b: WorktreeTree.Branch, lane i: Int, _ l: Layout, _ g: WorktreeTree.Graph) -> Path {
        let fx = l.nodeX[clamp(b.forkAt, g)]
        let y = laneY(i)
        let ex = endX(b, l, g)
        return Path { p in
            p.move(to: CGPoint(x: fx, y: mainY))
            p.addCurve(to: CGPoint(x: fx + 16, y: y), control1: CGPoint(x: fx, y: y - 10), control2: CGPoint(x: fx + 4, y: y))
            if b.mergedAt != nil {
                let mx = max(ex, fx + 40)
                p.addLine(to: CGPoint(x: mx - 16, y: y))
                p.addCurve(to: CGPoint(x: mx, y: mainY), control1: CGPoint(x: mx - 4, y: y), control2: CGPoint(x: mx, y: y - 10))
            } else {
                p.addLine(to: CGPoint(x: ex, y: y))
            }
        }
    }

    @ViewBuilder
    private func label(_ b: WorktreeTree.Branch, color: Color) -> some View {
        let content = HStack(spacing: 6) {
            Text(b.branch ?? b.key).font(.caption.bold()).foregroundStyle(color)
            if let a = b.ahead, a > 0 { Text("+\(a)").font(.caption2.monospaced()).foregroundStyle(.secondary) }
            if let agent = tree.agent(for: b.key) { Text(agent).font(.caption2).foregroundStyle(.secondary) }
            if b.mergedAt != nil { Text("✔ 已合併").font(.caption2.bold()).foregroundStyle(.green) }
            if b.key.hasPrefix("branch:") && b.mergedAt == nil { Text("worktree 已移除").font(.caption2).foregroundStyle(.tertiary) }
        }
        .fixedSize()
        if let w = tree.items?.first(where: { $0.id == b.key }) {
            Menu { actions(w) } label: {
                content
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(color.opacity(0.12), in: Capsule())
            }
            .buttonStyle(.plain)
        } else {
            content.padding(.horizontal, 6).padding(.vertical, 2)
        }
    }
}
