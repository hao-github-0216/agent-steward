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
