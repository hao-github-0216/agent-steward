import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { APP_DIR } from "./agents.ts";

export interface IntegrityResult {
	status: "ok" | "modified" | "unavailable" | "error";
	changed: string[];
	missing: string[];
	added: string[];
	counts: { changed: number; missing: number; added: number };
	error?: string;
}

let latest: IntegrityResult | { status: "pending" } = { status: "pending" };

export function integrityStatus(): IntegrityResult | { status: "pending" } {
	return latest;
}

async function fileHashes(appDir: string, relative = ""): Promise<[string, string][]> {
	const files: [string, string][] = [];
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

export async function checkIntegrity(appDir = APP_DIR): Promise<IntegrityResult> {
	const result: IntegrityResult = { status: "ok", changed: [], missing: [], added: [], counts: { changed: 0, missing: 0, added: 0 } };
	try {
		let text: string;
		try { text = await readFile(join(appDir, "INTEGRITY.json"), "utf8"); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			result.status = "unavailable";
			return latest = result;
		}
		const manifest = JSON.parse(text);
		if (manifest?.version !== 1 || !manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files)
			|| !Object.entries(manifest.files).every(([path, hash]) => path && path.split("/").every((part) => part && part !== "." && part !== "..") && typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash))) {
			throw new Error("Invalid integrity manifest");
		}
		const expected = manifest.files as Record<string, string>;
		const actual = new Map(await fileHashes(appDir));
		const record = (kind: "changed" | "missing" | "added", path: string) => {
			result.counts[kind]++;
			if (result[kind].length < 20) result[kind].push(path);
		};
		for (const path of Object.keys(expected).sort()) {
			if (!actual.has(path)) record("missing", path);
			else if (actual.get(path) !== expected[path]) record("changed", path);
		}
		for (const path of [...actual.keys()].sort()) if (!Object.hasOwn(expected, path)) record("added", path);
		if (Object.values(result.counts).some((count) => count > 0)) result.status = "modified";
	} catch (error) {
		result.status = "error";
		result.error = error instanceof Error ? error.message : String(error);
	}
	return latest = result;
}
