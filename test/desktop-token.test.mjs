import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, scryptSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const HOME = mkdtempSync(join(tmpdir(), "steward-desktop-token-"));
Object.assign(process.env, { HOME, USERPROFILE: HOME, STEWARD_DATA_DIR: HOME, XDG_CONFIG_HOME: HOME, APPDATA: HOME });
after(() => rmSync(HOME, { recursive: true, force: true }));
const { DEFAULTS } = await import("../src/settings.ts");
const token = randomBytes(32).toString("hex");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function freePort() {
    const server = createServer();
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const { port } = server.address();
    await new Promise((resolve) => server.close(resolve));
    assert.ok(![8791, 8792, 8793].includes(port));
    return port;
}
async function within(promise, ms) {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Child did not exit in time")), ms); })]); }
    finally { clearTimeout(timer); }
}
async function launch(t, { desktop = true, configuredToken = token } = {}) {
    const home = mkdtempSync(join(HOME, "child-"));
    const data = join(home, "data");
    mkdirSync(data);
    const config = structuredClone(DEFAULTS);
    config.aiDetected = true;
    config.setupDone = true;
    config.server.tailnetBindReviewed = true;
    const salt = randomBytes(16);
    config.access.passwordHash = ["scrypt", salt.toString("hex"), scryptSync(randomBytes(32), salt, 32).toString("hex")].join("$");
    writeFileSync(join(data, "settings.json"), JSON.stringify(config));
    const herdr = join(home, process.platform === "win32" ? "herdr.cmd" : "herdr");
    writeFileSync(herdr, process.platform === "win32" ? "@echo off\r\necho {}\r\n" : "#!/bin/sh\nprintf '{}\\n'\n", { mode: 0o755 });
    const port = await freePort();
    const env = { ...process.env, HOME: home, USERPROFILE: home, STEWARD_DATA_DIR: data, XDG_CONFIG_HOME: home, APPDATA: home,
        STEWARD_HOSTS: "127.0.0.1", STEWARD_PORT: String(port), STEWARD_TERMINAL_PORT: String(await freePort()),
        HERDR_BIN_PATH: herdr, HERDR_SOCKET_PATH: join(home, "no-herdr.sock"), STEWARD_APP_DIR: ROOT };
    for (const key of Object.keys(env)) if (key.startsWith("HERDR_") && !["HERDR_BIN_PATH", "HERDR_SOCKET_PATH"].includes(key)) delete env[key];
    if (desktop) env.STEWARD_DESKTOP = "1"; else delete env.STEWARD_DESKTOP;
    if (configuredToken !== undefined && configuredToken !== null) env.STEWARD_DESKTOP_TOKEN = configuredToken; else delete env.STEWARD_DESKTOP_TOKEN;
    const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", join(ROOT, "src/main.ts")],
        { cwd: ROOT, env, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (data) => { output += data; });
    child.stderr.on("data", (data) => { output += data; });
    const exited = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal })); });
    t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) {
            if (desktop) child.stdin.end(); else child.kill("SIGTERM");
            try { await within(exited, 4500); } catch { child.kill("SIGKILL"); }
        }
        await within(exited, 2000);
    });
    const base = `http://127.0.0.1:${port}`;
    const headers = { connection: "close" };
    let ready = false;
    for (const until = Date.now() + 15000; Date.now() < until;) {
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(output);
        try { if ((await fetch(base + "/api/health", { headers, signal: AbortSignal.timeout(500) })).ok) { ready = true; break; } } catch {}
        await sleep(40);
    }
    assert.ok(ready, output);
    return { base, headers, child };
}

test("desktop token authorizes loopback requests and authenticated settings writes with a management password set", { timeout: 25000 }, async (t) => {
    const f = await launch(t);
    const request = (path, extra = {}) => fetch(f.base + path, { ...extra, headers: { ...f.headers, "x-steward-desktop": token, ...extra.headers } });
    const auth = await (await request("/api/auth/status")).json();
    assert.equal(auth.authed, true);
    assert.equal(auth.user, "desktop");
    assert.equal(auth.how, "desktop");
    assert.equal(auth.hasPassword, true);
    const changed = await request("/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ settings: { desktop: { autostart: false } } }) });
    assert.equal(changed.status, 200);
    assert.equal((await changed.json()).settings.desktop.autostart, false);
    for (const value of [undefined, randomBytes(32).toString("hex"), "short", token + "0"]) {
        const response = await fetch(f.base + "/api/settings", { headers: { ...f.headers, ...(value ? { "x-steward-desktop": value } : {}) } });
        assert.equal(response.status, 401, "ordinary, wrong, and different-length tokens remain blocked");
    }
    const browser = await (await fetch(f.base + "/api/auth/status", { headers: f.headers })).json();
    assert.equal(browser.authed, false, "the password blocks an ordinary browser request");
});

for (const scenario of [{ name: "missing token environment", configuredToken: null }, { name: "not in App mode", desktop: false }]) {
    test(`desktop token is rejected when ${scenario.name}`, { timeout: 25000 }, async (t) => {
        const f = await launch(t, scenario);
        const response = await fetch(f.base + "/api/settings", { headers: { ...f.headers, "x-steward-desktop": token } });
        assert.equal(response.status, 401);
    });
}

test("desktop tokens never authorize non-loopback clients", { timeout: 10000 }, async () => {
    const script = `
        import assert from "node:assert/strict";
        const { authorize } = await import(${JSON.stringify(new URL("../src/terminal-auth.ts", import.meta.url).href)});
        const req = { headers: { "x-steward-desktop": process.env.STEWARD_DESKTOP_TOKEN }, socket: { remoteAddress: "192.0.2.1" } };
        const result = await authorize(req);
        assert.equal(result.ok, false);
        console.log("non-loopback rejected");
    `;
    const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "--eval", script],
        { env: { ...process.env, STEWARD_DESKTOP: "1", STEWARD_DESKTOP_TOKEN: token }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (data) => { output += data; });
    child.stderr.on("data", (data) => { output += data; });
    const result = await within(new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code) => resolve(code)); }), 5000)
        .finally(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
    assert.equal(result, 0, output);
    assert.match(output, /non-loopback rejected/);
});
