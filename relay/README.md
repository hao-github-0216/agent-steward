# 推播中繼

這個 Cloudflare Worker 依照 [PROTOCOL.md](./PROTOCOL.md) 代送 APNs 與 FCM 推播。中繼只轉送密文，不持有裝置的解密金鑰，也不儲存 token 或通知內容。v1 不驗證管家身分，只限制每個裝置 token 與來源 IP 的請求頻率。

## 安裝與驗證

使用 Node.js 24 或 26，在這個資料夾執行：

```sh
cd relay
npm ci
npm test
npx tsc --noEmit
```

測試透過 `@cloudflare/vitest-pool-workers` 在 Workers runtime 執行。`vitest.config.ts` 的 `outboundService` 攔截所有對外請求，只回傳測試指定的回應；未預期的請求會讓測試失敗，不會轉送到網路。APNs、FCM 與 Google OAuth 都不會收到真實請求。測試金鑰由 WebCrypto 臨時產生，不需要 `.dev.vars`、Cloudflare 帳號或任何真實秘密。

直接相依套件與 `package-lock.json` 都固定版本。計畫指定的 `@cloudflare/vitest-pool-workers` 已被官方標示停止更新，因此執行測試時會出現改名警告。`package.json` 的 overrides 保留它需要的 Miniflare API，將 workerd 固定為與 Wrangler 相同的 `1.20261113.1`，以支援 `2026-10-01` compatibility date；也固定其相依套件的安全修補版本。更新這些版本時，請重新執行全部測試、型別檢查與 dry-run。

### 共用加密向量

固定向量位於 `test/vectors.json`，包含三組可解密案例及一組 `wrongKey` 案例。每組都有標準 base64 的 `key`、`nonce`、`payload`，以及 UTF-8 JSON 字串 `plaintext`。`payload` 格式與 AAD 依協定定義；`wrongKey` 沿用第一組密文，但換成另一把測試金鑰，預期解密失敗。

需要重新產生時執行：

```sh
npm run make-vectors
npm test
```

這個指令會覆寫固定向量，產生新的隨機測試金鑰與 nonce。若管家或手機 App 已引用舊向量，必須一併更新，不能只更新中繼。

## 設定

`wrangler.toml` 已設定 Worker 名稱、bundle ID 與限流 binding：

- `RL_TOKEN`：每個 token 每 60 秒最多 30 則。
- `RL_IP`：每個來源 IP 每 60 秒最多 300 則。程式先檢查 IP，再檢查 token。
- `APNS_TOPIC`：`io.github.haogithub0216.agentsteward.native`。
- `APNS_TEAM_ID`：預設空字串；啟用 iOS 前才填入 Apple Team ID。

秘密設定如下，只由本地模型或操作者處理，不要把內容交給雲端 AI、寫進 Git，或放在命令列參數中：

| 名稱 | 內容 |
| --- | --- |
| `APNS_KEY_P8` | APNs `.p8` 的完整 PKCS8 PEM |
| `APNS_KEY_ID` | APNs 金鑰 ID |
| `FCM_SERVICE_ACCOUNT` | Firebase service account 的完整 JSON |

FCM 的 `project_id` 從 service account JSON 讀取。OAuth 端點固定為 `https://oauth2.googleapis.com/token`，不採用 JSON 裡的 `token_uri`。所有上游請求都有 10 秒逾時，且不跟隨重新導向。

只設定一個平台也能使用：iOS 的三項金鑰設定任一為空，或 Android 的 service account 為空時，該平台回 `503 platform_not_configured`。`GET /v1/health` 只回傳平台有沒有設定，不會連線驗證金鑰。

## 建置檢查與部署指令

以下 dry-run 只建置，不部署，也不需要登入：

```sh
npx wrangler deploy --dry-run --outdir /tmp/relay-dry
rm -rf /tmp/relay-dry
```

本輪工作不執行部署、登入或 secret 設定。日後獲准部署時，先由操作者完成 Cloudflare 登入，再由本地模型或操作者執行必要的平台設定指令；只啟用一個平台時，不必設定另一個平台：

```sh
npx wrangler login
npx wrangler secret put APNS_KEY_P8
npx wrangler secret put APNS_KEY_ID
npx wrangler secret put FCM_SERVICE_ACCOUNT
```

iOS 還需要先在 `wrangler.toml` 填入 `APNS_TEAM_ID`。確認設定後，再執行部署與健康檢查：

```sh
npx wrangler deploy
curl --fail-with-body https://YOUR_WORKER_HOST/v1/health
```

部署後仍須由持有測試裝置的操作者驗證真實推播。單靠 health 無法確認 Apple 或 Google 是否接受金鑰。

## API 與紀錄

- 僅接受 `POST /v1/push` 與 `GET /v1/health`；其他路徑或方法回 `404`。
- 推播 body 依實際串流位元組數限制為 4096 bytes，再依協定逐欄驗證；不接受規格外的欄位或網址。
- iOS 未提供 `env` 時使用 production；Android 不使用這個欄位。
- 上游的 `200`、失效 token、限流及錯誤依協定映射成 `200`、`410`、`429`、`502`。
- 每次嘗試送出只記錄 JSON 的 `platform`、`status`、`ms`。`status` 是取得的上游 HTTP 狀態碼；若送出流程丟出例外或逾時，則記為 `502`。不記錄 token、payload、collapse、憑證或例外訊息。

完整欄位規則、推播內容與回應格式以 `PROTOCOL.md` 為準。
