# 分支(worktree)總覽 API

網頁端與原生 app 共用。實作在 `src/worktrees.ts`,路由在 `src/server.ts` 的 `worktreeRoute`。
身分檢查和程式碼頁一樣(`/api/code/...` 那一套);徽章計數走一般登入。

`<pid>` = 專案 ID。`<id>` = worktree 的短 ID(10 碼十六進位,由 worktree 路徑雜湊而來,重新整理後不變)。

## 列表

`GET /api/code/<pid>/worktrees`

非 git 專案回 `{ "repo": false }`。否則:

```jsonc
{
  "repo": true,
  "repoRoot": "/…/course",          // 主資料夾(main worktree)根目錄
  "prefix": "hw1",                 // 專案資料夾相對 repo 根目錄;"" = 專案就是 repo 根目錄
  "target": "main",                // 主資料夾目前所在的分支 = 合併目標;detached 時 null
  "items": [                       // 第一個一定是主資料夾(source=main),其餘照 lastModified 新到舊
    {
      "id": "a1b2c3d4e5",
      "path": "/…/course/.claude/worktrees/hw1-extra",
      "cwd":  "/…/course/.claude/worktrees/hw1-extra/hw1", // 專案資料夾在 worktree 裡的位置
      "exists": true,
      "source": "claude",          // main | claude(Claude Code 的 .claude/worktrees/)| steward(管家支線)| manual(其他)
      "branch": "worktree-hw1-extra", // detached 時 null
      "head": "34f3aef…",
      "locked": "claude session hw1-extra (pid 12345 …)", // 沒鎖就沒有這個欄位
      "prunable": "…",             // 資料夾已經不在時才有
      "ahead": 1, "behind": 0,     // 相對 target
      "dirty": 5,                  // 沒 commit 的改動檔案數(整個 worktree)
      "changed": 2,                // 在這個專案資料夾裡改到的檔案數(分岔後的 commit + 沒 commit 的)
      "relevant": true,            // 算進這個專案的徽章(改到這個資料夾,或是從這個專案開的);false 的建議收在「同 repo 的其他 worktree」
      "lastModified": "2026-10-31T22:46:25.000Z",
      "nested": true,              // 放在 repo 資料夾裡面
      "ignored": false,            // nested 時有沒有被 .gitignore 排除
      "session": {                 // 對不到就沒有這個欄位 → 顯示「不明」
        "agent": "claude",         // claude / pi / codex / …
        "id": "5f0c…",        // session ID 或紀錄檔路徑(pi)
        "via": "claude-transcript",// claude-transcript | steward-branch | pane-cwd
        "originalCwd": "/…/course/hw1",
        "startedAt": "…",
        "pane": { "paneId": "w3:p2", "tabId": "w3:t2", "workspaceId": "w3", "terminalId": "…", "agentStatus": "idle" }, // 窗格開著才有
        "alive": true              // 窗格還開著
      },
      "stewardBranchId": "b2f18a42" // source=steward 且有支線紀錄時
    }
  ],
  "warnings": {
    "unignored": [{ "id": "…", "path": "…", "pattern": ".claude/worktrees/" }], // 在 repo 裡、沒被 .gitignore 排除
    "gitlinks": [".claude/worktrees/hw1-extra"]                      // 已被誤 commit 成子專案
  }
}
```

## 徽章

`GET /api/worktree-counts` → `{ "counts": { "<pid>": 1, … } }`(只算 `relevant` 的;伺服器快取 20 秒)

## 操作

錯誤一律 `{ "error": "白話說明", "code"?: "…", "detail"?: … }`,直接把 `error` 顯示給使用者。

| 動作 | 請求 | 成功回應 | 需要確認 / 失敗 |
|---|---|---|---|
| 跟它對話 | `POST worktrees/<id>/chat` 本文可帶 `{ "agent": "claude" }`(對不到 session 時開哪種 agent,預設 claude) | `{ kind: "focus"\|"resume"\|"new", paneId, agent?, label?, note? }`;`note` 有值就提示使用者(agent 停在確認畫面) | 400 主資料夾 / 資料夾不在 |
| 合併預覽 | `GET worktrees/<id>/merge` | `{ target, branch, commits:[{hash,subject}], files:[{status,path}], stat, diff, blocker?, uncommitted }`;`blocker` 有值 → 合併按鈕停用並顯示原因;`uncommitted>0` → 提醒「worktree 裡還有 N 個沒 commit 的改動,不會一起合併」 | 400 detached / 主資料夾 |
| 合併 | `POST worktrees/<id>/merge` | `{ merged: true, target, branch, commit }` → 接著問「要不要一併移除這個 worktree?」(預設不勾) | 409 `main-dirty`、409 `conflict`(`detail.conflicts`,已自動取消、主資料夾不變)、400 `nothing` |
| 移除 | `POST worktrees/<id>/remove` 本文 `{ "confirm": { "alive"?: true, "locked"?: true, "dirty"?: true } }` | `{ removed: true, branch }`(分支保留) | 409 `alive` / `locked` / `dirty`:顯示 `error`,使用者同意後把那一項加進 `confirm` 再送一次(可能連續問 3 次) |
| 加入 .gitignore | `POST worktrees/ignore` | `{ added: [".claude/worktrees/"], file }` | |
| 從版本控制移除 | `POST worktrees/untrack` | `{ untracked: [...], ignoreAdded: [...], note }`(只放進暫存區,沒 commit;顯示 `note`) | |

## 看 / 改 worktree 裡的檔案

程式碼頁原本的所有請求(`tree`、`file`、`raw`、`find`、`fs`、`upload`、`stamps`、`git/*`、`latex`…)
都加上查詢參數 `?wt=<id>`,這次請求的專案資料夾就換成那個 worktree 裡的 `cwd`。
- `office/*`、`nb/*` 在 worktree 裡回 400(先不支援)
- `session`(版面記錄)在 worktree 裡讀回 `{}`、寫入不存
- worktree 資料夾不在 → 404
畫面上要明顯標示「正在看 worktree:<branch>」,並有一顆「回主資料夾」。

## 樹狀圖(資料夾樹 + 分岔圖)

`GET /api/code/<pid>/worktrees/tree`

非 git 回 `{ "repo": false }`。否則:

```jsonc
{
  "repo": true,
  "repoRoot": "/…/course",
  "repoName": "course",
  "target": "main",                 // 主線(主資料夾目前的分支)
  "currentFolder": "hw1",           // 正在看的專案在 repo 裡的位置;"" = repo 根目錄
  "folders": [                      // 資料夾樹的第二層(照路徑排序)
    { "path": "hw1", "projectId": "…", "name": "hw1", "current": true },
    { "path": "hw3", "name": "hw3", "current": false }   // 沒登記但有分支歸進來的資料夾(沒有 projectId)
  ],
  "items": [ /* 和 GET worktrees 的 items 完全一樣,每筆多一個 "folder" */ ],
  "leftovers": [                    // agent 留下、worktree 已移除的分支(worktree-* / steward/branch-*)
    { "branch": "worktree-hw1-extra", "head": "…", "source": "claude", "folder": "hw1",
      "ahead": 2, "merged": true, "session": { "agent": "claude", "id": "…", "originalCwd": "…" }, "lastModified": "…" }
  ],
  "graph": {
    "nodes": [                      // 主線上要畫的點(舊 → 新):分岔點、合併點、最新的 commit
      { "hash": "…", "short": "9ba55f9", "subject": "…", "date": "…", "gapBefore": 3 }  // gapBefore = 和前一個點之間省略的 commit 數(第一個點 = 更早的)
    ],
    "branches": [
      { "key": "a1b2c3d4e5", "branch": "worktree-hw1-extra", "forkAt": 0, "mergedAt": 1, "ahead": 2 },
      { "key": "branch:worktree-old", "branch": "worktree-old", "forkAt": 0, "ahead": 12 }  // mergedAt 沒有 = 還沒合併
    ],
    "truncated": false              // 主線超過 5000 個 commit 時只畫最近的,分岔點更舊的接在最舊的點
  }
}
```

- `folder`:`""` 代表歸不到任何資料夾 → 樹上放在 repo 根節點下的「其他」。主資料夾(source=main)的 folder 一律是 `""`,樹上當作 repo 根節點本身,不另外畫。
- `graph.branches[].key`:worktree 用它的 `id`(和 items 對得上,節點可以直接用 chat/files/merge/remove);留下的分支是 `branch:<名稱>`,只顯示、沒有操作。
- 資料夾樹:repo →(每個 folder)→ 歸在那裡的 items 與 leftovers;`current` 的資料夾預設展開,其他收合並顯示數量(items + 未合併的 leftovers)。
- 分岔圖:主線畫成一條線、nodes 依序排開,`gapBefore > 0` 畫「⋯ N 個 commit」;每條 branch 從 `forkAt` 長出一條枝,標 `branch`、`ahead`、開它的 agent;有 `mergedAt` 的畫一條線合回那個點並標「✔ 已合併」。
- 分岔圖一打開建議捲到「最早一條還沒合併的分支的分岔點」(沒有就最新的 commit),手機上才看得到要處理的分支。
