import { createCipheriv, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const fixtureURL = new URL("../test/vectors.json", import.meta.url);
const fixtures = JSON.parse(await readFile(fixtureURL, "utf8"));
const aad = Buffer.from("agent-steward-push-v1", "ascii");
const messages = [
  {
    title: "🗂 專案管家提案（測試專案）",
    body: "有一個新提案，請查看內容。🔔",
    link: "agentsteward://project/test-project",
    thread: "test-project",
  },
  { title: "測試通知 ✨", body: "這則通知沒有連結或討論串。" },
  {
    title: "建置完成 ✅",
    body: "繁體中文、emoji 🚀，以及換行\n第二行。",
    link: "agentsteward://project/build",
    thread: "build",
  },
  {
    title: "🗂 專案管家提案（按鈕測試）",
    body: "請核准派工，或選擇不要。",
    link: "agentsteward://project/action-project",
    thread: "action-project",
    category: "proposal",
    card: "card-action-1",
  },
];

const vectors = messages.map((message, index) => {
  // 已發布的固定向量不重產金鑰或密文，新增向量也能重複執行腳本。
  const existing = fixtures.vectors.find((vector) => vector.name === `vector-${index + 1}`);
  if (existing) return existing;
  const key = randomBytes(32);
  const nonce = randomBytes(12);
  const plaintext = JSON.stringify(message);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    name: `vector-${index + 1}`,
    key: key.toString("base64"),
    nonce: nonce.toString("base64"),
    plaintext,
    payload: Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString("base64"),
  };
});

await writeFile(
  fixtureURL,
  JSON.stringify({ v: 1, aad: aad.toString("ascii"), vectors, wrongKey: fixtures.wrongKey }, null, 2) + "\n",
);
