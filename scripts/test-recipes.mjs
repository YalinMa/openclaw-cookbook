#!/usr/bin/env node
// End-to-end tests: run every recipe with the real Lobster runtime and check what it produced.
//
//   npm install && npm test
//
// - LLM steps use scripts/llm-adapter.mjs --mock (offline, free, deterministic).
//   Set TEST_LLM_ADAPTER_URL to test against a real model instead.
// - The `openclaw` CLI is replaced by scripts/test-bin/openclaw, which records
//   `openclaw message send` calls instead of sending anything.
// - State, cache and output files go to a temporary folder, never your real ones.
// - Set LOBSTER_BIN=/path/to/lobster to test with a different Lobster version.
// - Recipes 02, 03, 04, 05 and 10 call free public APIs, so a network connection is needed.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// LOBSTER_BIN lets you test against another Lobster version (e.g. the one bundled in your OpenClaw plugin).
const lobster = process.env.LOBSTER_BIN || path.join(root, "node_modules", ".bin", "lobster");
if (!existsSync(lobster)) {
	console.error("Lobster CLI not found. Run `npm install` first.");
	process.exit(1);
}

const tmp = mkdtempSync(path.join(os.tmpdir(), "openclaw-cookbook-test-"));
const stubLog = path.join(tmp, "openclaw-calls.log");
const env = {
	...process.env,
	PATH: `${path.join(root, "scripts", "test-bin")}${path.delimiter}${process.env.PATH}`,
	OPENCLAW_STUB_LOG: stubLog,
	LOBSTER_STATE_DIR: path.join(tmp, "state"),
	LOBSTER_CACHE_DIR: path.join(tmp, "cache"),
	LOBSTER_LLM_PROVIDER: "http",
	LOBSTER_LLM_ADAPTER_URL: process.env.TEST_LLM_ADAPTER_URL || "http://127.0.0.1:18799",
	LOBSTER_LLM_PRICING_JSON: JSON.stringify({ mock: { input: 0, output: 0 } }),
};

// ---------- helpers ----------

const wf = (recipe) => path.join(root, "examples", recipe, "workflow.json");

function lobsterCall(args) {
	const res = spawnSync(lobster, args, { cwd: root, env, encoding: "utf8", timeout: 180000 });
	const out = res.stdout.trim();
	try {
		return JSON.parse(out);
	} catch {
		throw new Error(`Lobster did not return JSON (exit ${res.status}): ${(res.stderr || out).slice(-500)}`);
	}
}

function run(recipe, args = {}) {
	const result = lobsterCall(["run", "--mode", "tool", "--file", wf(recipe), "--args-json", JSON.stringify(args)]);
	if (!result.ok) throw new Error(`run failed: ${result.error?.message?.slice(-500)}`);
	return result;
}

function resume(result, decision) {
	const token = (result.requiresApproval ?? result.requiresInput)?.resumeToken;
	if (!token) throw new Error(`expected a paused run, got status ${result.status}`);
	const flags = typeof decision === "boolean" ? ["--approve", decision ? "yes" : "no"] : ["--response-json", JSON.stringify(decision)];
	const out = lobsterCall(["resume", "--mode", "tool", "--token", token, ...flags]);
	if (!out.ok) throw new Error(`resume failed: ${out.error?.message?.slice(-500)}`);
	return out;
}

const text = (result) => result.output.map((o) => (typeof o === "string" ? o : JSON.stringify(o))).join("\n");
const calls = () => (existsSync(stubLog) ? readFileSync(stubLog, "utf8") : "");

function expect(condition, message) {
	if (!condition) throw new Error(message);
}

// ---------- test cases ----------

const tests = [];
const test = (recipe, name, fn) => tests.push({ recipe, name, fn });

test("01-hello-lobster", "default args", () => {
	const r = run("01-hello-lobster");
	expect(r.status === "ok", `status ${r.status}`);
	expect(r.output[0].message.startsWith("Hello, World!"), text(r));
	expect(typeof r.output[0].facts.cpus === "number", "facts missing");
});
test("01-hello-lobster", "custom args (zh)", () => {
	const r = run("01-hello-lobster", { name: "Ada", language: "zh" });
	expect(r.output[0].message.startsWith("你好, Ada!"), text(r));
});

test("02-daily-weather-briefing", "forecast + chat notification", () => {
	const r = run("02-daily-weather-briefing", { city: "Tokyo", latitude: "35.68", longitude: "139.69", notify_channel: "telegram", notify_target: "@me" });
	const t = text(r);
	expect(/Weather for Tokyo today/.test(t) && /°C/.test(t) && /Chance of rain: \d+%/.test(t), t);
	expect(/message\] \[send\] \[--channel\] \[telegram\] \[--target\] \[@me\]/.test(calls()), "openclaw message send was not called");
});

test("03-website-uptime-monitor", "1st run alerts on the down site", () => {
	const r = run("03-website-uptime-monitor");
	expect(/🔴 DOWN: https:\/\/this-site-does-not-exist\.invalid/.test(text(r)), text(r));
});
test("03-website-uptime-monitor", "2nd run stays quiet (no change)", () => {
	const r = run("03-website-uptime-monitor");
	expect(r.output[0].alert === false, text(r));
});
test("03-website-uptime-monitor", "3rd run reports recovery", () => {
	const r = run("03-website-uptime-monitor", { urls: "https://example.com" });
	expect(/✅ RECOVERED: https:\/\/this-site-does-not-exist\.invalid/.test(text(r)), text(r));
});

test("04-github-release-watcher", "1st run records a baseline", () => {
	const r = run("04-github-release-watcher", { repos: "nodejs/node, openclaw/openclaw" });
	expect(/Now watching \d+ repositories/.test(text(r)), text(r));
});
test("04-github-release-watcher", "2nd run: no new releases", () => {
	const r = run("04-github-release-watcher", { repos: "nodejs/node, openclaw/openclaw" });
	expect(r.output[0].hasNews === false && /No new releases/.test(r.output[0].message), text(r));
});
test("04-github-release-watcher", "detects a new release + reports bad repos", () => {
	const file = path.join(env.LOBSTER_STATE_DIR, "cookbook-github-releases.json");
	const saved = JSON.parse(readFileSync(file, "utf8"));
	const seen = Array.isArray(saved) ? saved[0] : saved;
	seen["nodejs/node"] = "v0.0.1";
	writeFileSync(file, JSON.stringify(saved));
	const r = run("04-github-release-watcher", { repos: "nodejs/node, openclaw/openclaw, nobody/no-such-repo-xyz" });
	const t = text(r);
	expect(/🚀 nodejs\/node released .* \(was v0\.0\.1\)/.test(t), t);
	expect(/⚠️ nobody\/no-such-repo-xyz: HTTP 404/.test(t), t);
});

test("05-ai-news-digest", "digest with real links", () => {
	const r = run("05-ai-news-digest", { count: "10" });
	const t = text(r);
	expect(/Hacker News digest/.test(t), t);
	expect((t.match(/^\d\. /gm) || []).length >= 3, `expected 3+ stories:\n${t}`);
	expect(/https?:\/\//.test(t), "no links in digest");
});

test("06-ai-support-ticket-triage", "pauses for approval with a readable report", () => {
	const outbox = path.join(tmp, "outbox-approved");
	const r = run("06-ai-support-ticket-triage", { outbox });
	expect(r.status === "needs_approval", `status ${r.status}`);
	// The report lines travel as approval `items`: that's what OpenClaw shows the agent.
	expect(r.requiresApproval.items[0] === "Triage report: 5 tickets", JSON.stringify(r.requiresApproval.items));
	const done = resume(r, true);
	const files = readdirSync(outbox);
	expect(files.length >= 1 && /Saved \d+ draft replies/.test(text(done)), text(done));
	expect(/^To: .+@.+\nSubject: Re: /.test(readFileSync(path.join(outbox, files[0]), "utf8")), "bad draft file");
});
test("06-ai-support-ticket-triage", "rejecting saves nothing", () => {
	const outbox = path.join(tmp, "outbox-rejected");
	const r = run("06-ai-support-ticket-triage", { outbox });
	const done = resume(r, false);
	expect(done.status === "cancelled", `status ${done.status}`);
	expect(!existsSync(outbox), "outbox was created although the run was rejected");
});

test("07-safe-file-cleanup", "moves old files after approval, undo restores them", () => {
	const folder = path.join(tmp, "messy");
	const archive = path.join(tmp, "archive");
	mkdirSync(path.join(folder, "subfolder"), { recursive: true });
	const old = new Date("2025-01-01");
	for (const name of ["old report.pdf", "it's old.zip", "old.dmg"]) {
		writeFileSync(path.join(folder, name), "x".repeat(1000));
		utimesSync(path.join(folder, name), old, old);
	}
	writeFileSync(path.join(folder, "fresh.txt"), "new");
	const r = run("07-safe-file-cleanup", { folder, archive });
	expect(r.status === "needs_approval" && /^3 files in /.test(r.requiresApproval.items[0]), JSON.stringify(r.requiresApproval?.items ?? r.status));
	const done = resume(r, true);
	expect(/Moved 3 files/.test(text(done)), text(done));
	expect(readdirSync(folder).sort().join(",") === "fresh.txt,subfolder", `left behind: ${readdirSync(folder)}`);
	const [batch] = readdirSync(archive);
	const undo = spawnSync("sh", [path.join(archive, batch, "undo.sh")], { encoding: "utf8" });
	expect(undo.status === 0, undo.stderr);
	expect(readdirSync(folder).length === 5, `after undo: ${readdirSync(folder)}`);
});
test("07-safe-file-cleanup", "nothing old → no approval needed", () => {
	const r = run("07-safe-file-cleanup", { folder: path.join(tmp, "messy"), older_than_days: "100000" });
	expect(r.status === "ok" && /Nothing to clean up/.test(text(r)), text(r));
});

test("08-meeting-notes-to-action-items", "pauses for review, writes the checklist", () => {
	const output = path.join(tmp, "action-items.md");
	const r = run("08-meeting-notes-to-action-items", { output_file: output });
	expect(r.status === "needs_input", `status ${r.status}`);
	expect(/Proposed action items:\n1\. /.test(r.requiresInput.subject), r.requiresInput.subject);
	const done = resume(r, { keep: "1", note: "Reviewed in test" });
	expect(/Wrote 1 of \d+ action items/.test(text(done)), text(done));
	const md = readFileSync(output, "utf8");
	expect(/^# .+\n\n> Reviewed in test\n/.test(md) && /## Action items\n\n- \[ \] \*\*/.test(md), md);
});

test("09-webhook-lead-capture", "new lead is cleaned, saved and announced", () => {
	const leads = path.join(tmp, "leads.csv");
	const r = run("09-webhook-lead-capture", { leads_file: leads, notify_channel: "slack", notify_target: "channel:C123" });
	expect(/🆕 New lead #1: Ada Lovelace <ada@example\.com>/.test(text(r)), text(r));
	expect(/\[--channel\] \[slack\] \[--target\] \[channel:C123\] \[--message\] \[🆕 New lead/.test(calls()), "no notification sent");
});
test("09-webhook-lead-capture", "duplicate email is ignored", () => {
	const r = run("09-webhook-lead-capture", { leads_file: path.join(tmp, "leads.csv") });
	expect(/Duplicate lead ignored: ada@example\.com/.test(text(r)), text(r));
});
test("09-webhook-lead-capture", "quotes and commas are CSV-escaped", () => {
	const leads = path.join(tmp, "leads.csv");
	const payload = JSON.stringify({ name: 'Bob "The Builder", Jr', email: "bob@build.io", message: "Hi,\nthere" });
	const r = run("09-webhook-lead-capture", { leads_file: leads, payload });
	expect(/New lead #2/.test(text(r)), text(r));
	expect(readFileSync(leads, "utf8").includes('"Bob ""The Builder"", Jr",bob@build.io,,"Hi, there"'), readFileSync(leads, "utf8"));
});
test("09-webhook-lead-capture", "invalid lead is rejected", () => {
	const r = run("09-webhook-lead-capture", { leads_file: path.join(tmp, "leads.csv"), payload: '{"email":"not-an-email"}' });
	expect(/❌ Lead rejected: name is missing, email is not valid/.test(text(r)), text(r));
});

test("10-morning-brief", "parallel sources + sub-workflow + LLM", () => {
	const r = run("10-morning-brief", { city: "Shanghai", latitude: "31.23", longitude: "121.47" });
	const t = text(r);
	expect(t.length > 50 && /🔗 Links\n1\. /.test(t), t);
});

// ---------- runner ----------

async function startMockAdapter() {
	if (process.env.TEST_LLM_ADAPTER_URL) return null;
	const child = spawn(process.execPath, [path.join(root, "scripts", "llm-adapter.mjs"), "--mock"], {
		env: { ...process.env, LLM_ADAPTER_PORT: "18799" },
		stdio: "ignore",
	});
	for (let i = 0; i < 50; i += 1) {
		try {
			const res = await fetch("http://127.0.0.1:18799/health");
			if (res.ok) return child;
		} catch {}
		await new Promise((r) => setTimeout(r, 100));
	}
	child.kill();
	throw new Error("mock LLM adapter did not start");
}

const adapter = await startMockAdapter();
const only = process.argv[2];
let passed = 0;
const failed = [];
let current = "";

for (const t of tests) {
	if (only && !t.recipe.startsWith(only)) continue;
	if (t.recipe !== current) {
		current = t.recipe;
		console.log(`\n${t.recipe}`);
	}
	const started = Date.now();
	try {
		t.fn();
		passed += 1;
		console.log(`  ✓ ${t.name} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
	} catch (err) {
		failed.push(`${t.recipe}: ${t.name}`);
		console.log(`  ✗ ${t.name}\n    ${String(err.message).split("\n").join("\n    ")}`);
	}
}

adapter?.kill();
rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed}/${passed + failed.length} tests passed${process.env.TEST_LLM_ADAPTER_URL ? " (real LLM)" : " (mock LLM)"}`);
if (failed.length) console.log("Failed:\n  " + failed.join("\n  "));
process.exit(failed.length ? 1 : 0);
