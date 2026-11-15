# 推播中繼協定 v1

管家（agent-steward）、推播中繼（這個資料夾的 Cloudflare Worker）、iPhone App、Android App 共用這份規格。改格式時先改這份，再改程式。

## 為什麼要中繼

Apple 和 Google 只替 App 的開發者送推播，要用開發者帳號的金鑰。每個人的管家都在自己的電腦上，不能每台都放這把金鑰，所以由中繼代送：

```
管家 ──(加密的通知)──▶ 中繼 ──▶ APNs ──▶ iPhone：通知服務擴充解密後顯示
                           └──▶ FCM  ──▶ Android：FirebaseMessagingService 解密後顯示
```

中繼看得到的只有 device token、平台和密文，看不到通知內容。

## 加密（管家加密，App 解密）

- **金鑰**：每台手機在第一次註冊推播時，自己產生 32 位元組的隨機金鑰，交給自己的管家（`POST /api/push/register` 的 `key` 欄位，標準 base64），中繼從頭到尾拿不到。
- **明文**：UTF-8 的 JSON 物件：

  ```json
  {"title": "🗂 專案管家提案(某專案)", "body": "…", "link": "agentsteward://project/<id>", "thread": "<id>"}
  ```

  `title`、`body` 一定有；`link`、`thread` 可以沒有。
- **演算法**：AES-256-GCM，nonce 12 位元組（每則隨機產生），tag 16 位元組，AAD 是 ASCII 字串 `agent-steward-push-v1`。
- **密文格式**：`base64(nonce ‖ ciphertext ‖ tag)`，標準 base64（有 `=` 補位）。
- **長度上限**：密文字串最多 3000 個字元。管家加密前先把 `body` 截短，讓結果不超過上限。
- **解不開時**（金鑰對不上、格式錯）：iPhone 顯示備用文字；Android 直接丟掉，不顯示。

`relay/test/vectors.json` 放固定的測試向量（金鑰、nonce、明文、密文），管家、iPhone、Android 的測試都要能解開同一組。

## 中繼的 API

### `POST /v1/push`

```json
{"v": 1, "platform": "ios", "token": "<hex>", "env": "production", "payload": "<密文>", "collapse": "<選填>"}
```

| 欄位 | 規則 |
|---|---|
| `v` | 固定是 `1` |
| `platform` | `ios` 或 `android` |
| `token` | iOS：64 到 200 個十六進位字元。Android：1 到 4096 個字元，只能是英數字和 `-_:` |
| `env` | 只有 iOS 用：`sandbox` 或 `production`，沒給就是 `production` |
| `payload` | 上面的密文，1 到 3000 個字元，只能是 base64 字元 |
| `collapse` | 選填，最多 64 個字元，只能是英數字和 `-_`。同一個值的通知收在一起（iOS 的 thread-id、Android 的 collapse key）。管家用 HMAC-SHA256(裝置金鑰, 專案 id) 的前 16 個十六進位字元，不送原本的專案 id |

body 超過 4 KB、JSON 格式不對或欄位不合規則，回 `400 {"ok": false, "error": "<原因>"}`。

**送到 Apple（iOS）**：`https://api.push.apple.com` 或 `https://api.sandbox.push.apple.com`，路徑 `/3/device/<token>`，用 ES256 JWT（50 分鐘換一次）。標頭 `apns-push-type: alert`、`apns-priority: 10`、`apns-topic: <APNS_TOPIC>`。內容：

```json
{"aps": {"alert": {"title-loc-key": "PUSH_FALLBACK_TITLE", "loc-key": "PUSH_FALLBACK_BODY"}, "mutable-content": 1, "sound": "default", "thread-id": "<collapse>"}, "e": "<payload>"}
```

`alert` 是解不開時才會顯示的備用文字，App 用自己的語言檔顯示。沒有 `collapse` 就不放 `thread-id`。

**送到 Google（Android）**：FCM HTTP v1 `https://fcm.googleapis.com/v1/projects/<project_id>/messages:send`，用 service account 換來的 OAuth access token（RS256 JWT 換 token，快取到過期前 5 分鐘）。內容：

```json
{"message": {"token": "<token>", "data": {"v": "1", "e": "<payload>"}, "android": {"priority": "high", "collapse_key": "<collapse>"}}}
```

只送 data message，不放 notification 欄位，通知由 App 解密後自己發。

**回應**

| 情況 | 回應 |
|---|---|
| 送出成功 | `200 {"ok": true}` |
| token 已失效（APNs 410、`BadDeviceToken`、`Unregistered`；FCM `UNREGISTERED`、404） | `410 {"ok": false, "gone": true}`，管家要把這台裝置刪掉 |
| 太頻繁 | `429 {"ok": false, "error": "rate_limited"}` |
| Apple 或 Google 端出錯、逾時 | `502 {"ok": false, "error": "<上游狀態碼或原因>"}` |
| 中繼沒設定該平台的金鑰 | `503 {"ok": false, "error": "platform_not_configured"}` |

### `GET /v1/health`

回 `200 {"ok": true, "ios": <有沒有設定 APNs>, "android": <有沒有設定 FCM>, "v": 1}`。

其他路徑和方法一律回 `404`。

## 防濫用

- 限流用 Workers Rate Limiting binding：同一個 token 每 60 秒最多 30 則，同一個來源 IP 每 60 秒最多 300 則。
- 中繼不接受任何網址欄位，不會替人連到別的地方（沒有 SSRF）。
- 中繼不存任何東西，也不記錄 token 或內容；log 只寫平台、上游狀態碼、花了多久。

## 中繼的設定

| 名稱 | 種類 | 內容 |
|---|---|---|
| `APNS_KEY_P8` | secret | APNs 金鑰 .p8 的全文 |
| `APNS_KEY_ID` | secret | 金鑰 ID |
| `APNS_TEAM_ID` | var | Apple Team ID |
| `APNS_TOPIC` | var | iPhone App 的 bundle ID |
| `FCM_SERVICE_ACCOUNT` | secret | Firebase service account 的 JSON 全文 |

只設了其中一個平台也能跑，另一個平台回 `503`。secret 由本地模型用 `wrangler secret put` 設定，不經過雲端 AI。
