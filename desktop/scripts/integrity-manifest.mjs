import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

async function fileHashes(appDir, relative = "") {
	const files = [];
	for (const entry of await readdir(join(appDir, relative), { withFileTypes: true })) {
		const path = relative ? `${relative}/${entry.name}` : entry.name;
		if (entry.name === ".DS_Store" || (entry.isDirectory() && entry.name === "__pycache__") || path === "INTEGRITY.json") continue;
		if (entry.isDirectory()) files.push(...await fileHashes(appDir, path));
		else if (entry.isFile()) {
			const hash = createHash("sha256");
			for await (const chunk of createReadStream(join(appDir, path))) hash.update(chunk);
			files.push([path, hash.digest("hex")]);
		}
	}
	return files;
}

export async function writeIntegrityManifest(appDir) {
	const files = (await fileHashes(appDir)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
	// 依排序寫入鍵值,避免 JSON.stringify 把純數字檔名重新排序。
	const entries = files.map(([path, hash]) => `${JSON.stringify(path)}:${JSON.stringify(hash)}`);
	await writeFile(join(appDir, "INTEGRITY.json"), `{"version":1,"files":{${entries.join(",")}}}\n`);
}
