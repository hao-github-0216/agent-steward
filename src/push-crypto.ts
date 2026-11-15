import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

const AAD = Buffer.from("agent-steward-push-v1", "ascii");
const MAX_PLAIN_BYTES = 2200;

export interface PushPlain {
	title: string;
	body: string;
	link?: string;
	thread?: string;
}

export function validKey(b64: unknown): b64 is string {
	if (typeof b64 !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(b64)) return false;
	const key = Buffer.from(b64, "base64");
	return key.length === 32 && key.toString("base64") === b64;
}

function keyBytes(keyB64: string): Buffer {
	if (!validKey(keyB64)) throw new TypeError("Invalid push key");
	return Buffer.from(keyB64, "base64");
}

export function encryptPush(keyB64: string, msg: PushPlain): string {
	const key = keyBytes(keyB64);
	const plain = { ...msg, title: Array.from(msg.title).slice(0, 200).join("") };
	let json = JSON.stringify(plain);
	if (Buffer.byteLength(json, "utf8") > MAX_PLAIN_BYTES) {
		const body = Array.from(plain.body);
		// 保留完整字元，逐字移除尾端並加上省略號。
		do {
			if (!body.length) throw new RangeError("Push metadata exceeds the plaintext limit");
			body.pop();
			plain.body = `${body.join("")}…`;
			json = JSON.stringify(plain);
		} while (Buffer.byteLength(json, "utf8") > MAX_PLAIN_BYTES);
	}
	const nonce = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, nonce);
	cipher.setAAD(AAD);
	const ciphertext = Buffer.concat([cipher.update(json, "utf8"), cipher.final()]);
	return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString("base64");
}

export function decryptPush(keyB64: string, payload: string): PushPlain {
	const key = keyBytes(keyB64);
	if (typeof payload !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(payload)) throw new TypeError("Invalid push payload");
	const data = Buffer.from(payload, "base64");
	if (data.length < 28 || data.toString("base64") !== payload) throw new TypeError("Invalid push payload");
	const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
	decipher.setAAD(AAD);
	decipher.setAuthTag(data.subarray(-16));
	const plaintext = Buffer.concat([decipher.update(data.subarray(12, -16)), decipher.final()]);
	return JSON.parse(plaintext.toString("utf8")) as PushPlain;
}

export function collapseFor(keyB64: string, projectId: string): string {
	return createHmac("sha256", keyBytes(keyB64)).update(projectId, "utf8").digest("hex").slice(0, 16);
}
