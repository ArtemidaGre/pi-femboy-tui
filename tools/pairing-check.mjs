// ♡ pairing-check.mjs — end-to-end tests for the femboy-mcp pairing (Phase 6).
//
// Spawns the real pi-femboy-mcp server (sibling repo ../femboy-mcp/dist) on a
// random port, points the extension modules at it through a temp cwd, and asserts
// the contract the chrome relies on:
//   1. settingsMcpConfig: project overrides user, enabled:false means never connect
//   2. initPairing reaches "paired" against a live server
//   3. first-pair sync paints the vibe from the shared state (outfit, headpats)
//   4. wearThroughPairing: free skin → pushed AND the pushing window paints itself
//   5. wearThroughPairing: gated skin → refused with a reason, outfit NOT painted
//   6. patThroughPairing: pushed → shared headpat counter lands via the mood feed
//   7. a *remote* change (second client) arrives: features.uwu → vibe.uwuMode
//   8. local toggle pushes through: vibe.uwuMode=true → server sees uwu:true, then :false
//   9. server dies mid-session: no throw, status degrades, local mode keeps working
//
// Exit 0 + "ALL PAIRING CHECKS PASSED" or non-zero with the failed assertion.
// When ../femboy-mcp/dist is absent the whole suite SKIPS (exit 0) — pastel must
// never break CI for someone who only cloned the extension repo.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const ROOT = path.resolve(import.meta.dirname, "..");
const SERVER_ENTRY = path.resolve(ROOT, "..", "femboy-mcp", "dist", "index.js");
const require_ = createRequire(import.meta.url);
const { createJiti } = require_("jiti");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
function ok(name, fn) {
	checks.push([name, fn]);
}

function writeSettings(cwd, femboy) {
	mkdirSync(path.join(cwd, ".pi"), { recursive: true });
	writeFileSync(path.join(cwd, ".pi/settings.json"), JSON.stringify({ femboy }));
}

async function startServer() {
	const dir = mkdtempSync(path.join(tmpdir(), "femboy-pair-"));
	const readyPath = path.join(dir, "ready.json");
	const dbPath = path.join(dir, "state.sqlite");
	const proc = spawn(
		process.execPath,
		[SERVER_ENTRY, "serve", "--transport", "http", "--port", "0", "--db-path", dbPath, "--tick-enabled", "false", "--log-level", "silent"],
		{ env: { ...process.env, FEMBOY_HOST: "127.0.0.1", FEMBOY_READY_FILE: readyPath }, stdio: ["ignore", "ignore", "pipe"] },
	);
	const stderr = [];
	proc.stderr.setEncoding("utf8");
	proc.stderr.on("data", (chunk) => stderr.push(chunk));
	for (let i = 0; i < 100; i++) {
		if (existsSync(readyPath)) {
			try {
				const ready = JSON.parse(readFileSync(readyPath, "utf8"));
				if (ready.http?.port > 0) {
					return { proc, url: `http://127.0.0.1:${ready.http.port}${ready.http.path}`, dir };
				}
			} catch {
				/* not flushed yet */
			}
		}
		if (proc.exitCode !== null) break;
		await wait(50);
	}
	proc.kill("SIGKILL");
	throw new Error(`server never became ready:\n${stderr.join("")}`);
}

if (!existsSync(SERVER_ENTRY)) {
	console.log("skip   pairing-check — ../femboy-mcp/dist not built (clone + npm run build there to enable)");
	process.exit(0);
}

const jiti = createJiti(import.meta.url);
const pairing = await jiti.import(path.join(ROOT, "extensions/pairing.ts"));
const vibeMod = await jiti.import(path.join(ROOT, "extensions/vibe.ts"));
const mcpMod = await jiti.import(path.join(ROOT, "extensions/mcp.ts"));
const { createMcpClient } = mcpMod;

const server = await startServer();
const cwd = mkdtempSync(path.join(tmpdir(), "femboy-pair-cwd-"));
writeSettings(cwd, { mcp: { url: server.url } });
vibeMod.setVibePersister(() => {});

async function cleanup(code) {
	await pairing.shutdownPairing().catch(() => {});
	server.proc.kill("SIGKILL");
	rmSync(cwd, { recursive: true, force: true });
	rmSync(server.dir, { recursive: true, force: true });
	process.exit(code);
}

ok("settingsMcpConfig: project wins over user, junk url falls back to default", () => {
	const cfg = mcpMod.settingsMcpConfig(cwd);
	assert.equal(cfg.enabled, true);
	assert.equal(cfg.url, server.url);
	const off = mkdtempSync(path.join(tmpdir(), "femboy-pair-off-"));
	writeSettings(off, { mcp: { enabled: false, url: "not-a-url" } });
	const cfg2 = mcpMod.settingsMcpConfig(off);
	assert.equal(cfg2.enabled, false);
	assert.equal(cfg2.url, mcpMod.MCP_DEFAULT_URL);
	rmSync(off, { recursive: true, force: true });
});

ok("initPairing reaches paired against a live server", async () => {
	pairing.initPairing(cwd);
	for (let i = 0; i < 100 && pairing.pairingStatus() !== "paired"; i++) await wait(50);
	assert.equal(pairing.pairingStatus(), "paired", `status=${pairing.pairingStatus()} detail=${pairing.pairingDetail()}`);
});

ok("first-pair sync paints outfit + headpats from the shared state", async () => {
	// mutate via a *foreign* raw client so this window has to learn it from remote
	const stranger = createMcpClient({ enabled: true, url: server.url });
	await stranger.connect();
	for (let i = 0; i < 60 && stranger.status !== "paired"; i++) await wait(50);
	assert.equal(stranger.status, "paired", "stranger could not pair");
	const pres = await stranger.readResource("femboy://presence");
	const mine = (pres.sessions ?? []).find((s) => s.clientId === stranger.clientId);
	assert.ok(mine, "presence must register the x-femboy-client clientId from initialize");
	assert.equal(mine.pid, process.pid, "presence must carry the client's real pid (x-femboy-pid)");
	await stranger.callTool("femboy_set_outfit", { outfit: "Gothic Mochi" });
	await stranger.callTool("femboy_headpat", { intensity: 4 });
	for (let i = 0; i < 60 && vibeMod.getVibe().headpats < 4; i++) await wait(50);
	assert.equal(vibeMod.getVibe().outfit, 2, "remote outfit did not paint");
	assert.ok(vibeMod.getVibe().headpats >= 4, "remote headpats did not sync");
	assert.ok(vibeMod.vibeShort().includes("♡mcp"), "badge missing while paired");
	await stranger.disconnect();
});

ok("wearThroughPairing free skin: pushed and the pushing window paints itself", async () => {
	vibeMod.patchVibe({ outfit: 0 });
	await wait(400); // let the local→remote push settle
	const worn = await pairing.wearThroughPairing("Oversized Hoodie");
	assert.equal(worn.result, "pushed");
	for (let i = 0; i < 40 && vibeMod.getVibe().outfit !== 1; i++) await wait(50);
	assert.equal(vibeMod.getVibe().outfit, 1, "own push did not paint own vibe");
});

ok("wearThroughPairing gated skin: refused with a reason, never painted", async () => {
	const before = vibeMod.getVibe().outfit;
	const worn = await pairing.wearThroughPairing("Cyber Maid");
	assert.equal(worn.result, "refused");
	assert.ok(worn.reason.length > 0, "refusal should carry the server hint");
	await wait(400);
	assert.equal(vibeMod.getVibe().outfit, before, "a gated skin must not be painted locally");
});

ok("patThroughPairing: pushed pats arrive through the mood feed", async () => {
	const before = vibeMod.getVibe().headpats;
	const patted = await pairing.patThroughPairing(3);
	assert.equal(patted, "pushed");
	for (let i = 0; i < 40 && vibeMod.getVibe().headpats < before + 3; i++) await wait(50);
	assert.equal(vibeMod.getVibe().headpats, before + 3);
});

ok("remote feature toggle arrives: features.uwu → vibe.uwuMode", async () => {
	const stranger = createMcpClient({ enabled: true, url: server.url });
	await stranger.connect();
	for (let i = 0; i < 60 && stranger.status !== "paired"; i++) await wait(50);
	vibeMod.patchVibe({ uwuMode: false });
	await wait(400);
	await stranger.callTool("femboy_toggle_feature", { feature: "uwu", enabled: true });
	for (let i = 0; i < 40 && !vibeMod.getVibe().uwuMode; i++) await wait(50);
	assert.equal(vibeMod.getVibe().uwuMode, true, "remote feature toggle did not paint");
	await stranger.disconnect();
});

ok("local toggle pushes to the server: vibe.uwuMode=true → uwu:true, then false", async () => {
	vibeMod.patchVibe({ uwuMode: true });
	for (let i = 0; i < 60; i++) {
		const s = await fetchServerState();
		if (s.features?.uwu === true) break;
		await wait(100);
	}
	const pushed = await fetchServerState();
	assert.equal(pushed.features?.uwu, true, `expected uwu:true on the server, got ${JSON.stringify(pushed.features)}`);
	vibeMod.patchVibe({ uwuMode: false });
	for (let i = 0; i < 60; i++) {
		const s = await fetchServerState();
		if (s.features?.uwu === false) return;
		await wait(100);
	}
	assert.fail("local toggle-off never reached the server");
});

async function fetchServerState() {
	const probe = createMcpClient({ enabled: true, url: server.url });
	await probe.connect();
	for (let j = 0; j < 60 && probe.status !== "paired"; j++) await wait(50);
	const s = await probe.readResource("femboy://state");
	await probe.disconnect();
	return s;
}

ok("server dies mid-session: graceful degrade to local mode, no throws", async () => {
	assert.equal(pairing.pairingStatus(), "paired");
	server.proc.kill("SIGKILL");
	await wait(300);
	for (let i = 0; i < 120 && pairing.pairingStatus() === "paired"; i++) await wait(50);
	assert.notEqual(pairing.pairingStatus(), "paired", `status should degrade, got ${pairing.pairingStatus()}`);
	// vibe keeps working purely locally — the Phase 7 "never breaks pi" requirement
	const before = vibeMod.getVibe().outfit;
	vibeMod.patchVibe({ outfit: before === 0 ? 3 : 0 });
	const worn = await pairing.wearThroughPairing("Gothic Mochi");
	assert.equal(worn.result, "offline");
	const patted = await pairing.patThroughPairing(1);
	assert.equal(patted, "offline");
	assert.ok(!vibeMod.vibeShort().includes("♡mcp"), "badge should clear when unpaired");
});

let failed = 0;
for (const [name, fn] of checks) {
	try {
		await fn();
		console.log(`ok   ${name}`);
	} catch (error) {
		failed++;
		console.error(`FAIL ${name}\n     ${error?.message ?? error}`);
	}
}
await cleanup(failed > 0 ? 1 : 0);
