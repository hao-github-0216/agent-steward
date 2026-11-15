import { createCipheriv, randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";

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
];

const vectors = messages.map((message, index) => {
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

const wrongKey = {
  ...vectors[0],
  name: "wrongKey",
  key: randomBytes(32).toString("base64"),
};
await writeFile(
  new URL("../test/vectors.json", import.meta.url),
  JSON.stringify({ v: 1, aad: aad.toString("ascii"), vectors, wrongKey }, null, 2) + "\n",
);
