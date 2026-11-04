// 測試用自己的暫存資料夾當 STEWARD_DATA_DIR,不碰 ~/.agent-steward(平行跑的測試程序同時建立設定檔會互撞)。
// 要在載入任何 ../src/*.ts 之前 import,src 讀到的 DATA_DIR 才會是這個資料夾。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.STEWARD_DATA_DIR) {
	const dir = mkdtempSync(join(tmpdir(), "steward-test-data-"));
	process.env.STEWARD_DATA_DIR = dir;
	process.on("exit", () => {
		try { rmSync(dir, { recursive: true, force: true }); } catch { /* 刪不掉就算了 */ }
	});
}
