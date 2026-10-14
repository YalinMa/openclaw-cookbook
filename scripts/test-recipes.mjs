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

const wf = (recipe, file = "workflow.json") => path.join(root, "examples", recipe, file);

function lobsterCall(args, extraEnv = {}) {
	const res = spawnSync(lobster, args, { cwd: root, env: { ...env, ...extraEnv }, encoding: "utf8", timeout: 180000 });
	const out = res.stdout.trim();
	try {
		return JSON.parse(out);
	} catch {
		throw new Error(`Lobster did not return JSON (exit ${res.status}): ${(res.stderr || out).slice(-500)}`);
	}
}

function run(recipe, args = {}, { file = "workflow.json", extraEnv = {} } = {}) {
	const result = lobsterCall(["run", "--mode", "tool", "--file", wf(recipe, file), "--args-json", JSON.stringify(args)], extraEnv);
	if (!result.ok) throw new Error(`run failed: ${result.error?.message?.slice(-500)}`);
	return result;
}

// For runs that are expected to fail: returns the error message.
function runError(recipe, args = {}, { extraEnv = {} } = {}) {
	const result = lobsterCall(["run", "--mode", "tool", "--file", wf(recipe), "--args-json", JSON.stringify(args)], extraEnv);
	if (result.ok) throw new Error(`expected the run to fail, got status ${result.status}: ${JSON.stringify(result.output).slice(0, 200)}`);
	return result.error.message;
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

// ---------- recipes 11–20 ----------

test("11-rss-reading-list", "adds new articles to the Markdown file", () => {
	const output_file = path.join(tmp, "reading-list.md");
	const r = run("11-rss-reading-list", { output_file, max_items: "3", feeds: "https://feeds.bbci.co.uk/news/technology/rss.xml, https://blog.rust-lang.org/feed.xml" });
	expect(/📚 3 new articles added/.test(text(r)), text(r));
	const md = readFileSync(output_file, "utf8");
	expect(/^# Reading list\n\n## \d{4}-\d\d-\d\d \(3 new\)\n\n- \[ \] \[.+\]\(https?:\/\//.test(md), md);
});
test("11-rss-reading-list", "2nd run skips articles already seen", () => {
	const r = run("11-rss-reading-list", { output_file: path.join(tmp, "reading-list.md"), max_items: "500", feeds: "https://blog.rust-lang.org/feed.xml" });
	// The Rust feed was fully read in the 1st run (only 3 were added, but all were remembered as seen).
	expect(r.output[0].added === 0 && /No new articles/.test(r.output[0].message), text(r));
});
test("11-rss-reading-list", "a broken feed is reported, not fatal", () => {
	const r = run("11-rss-reading-list", { output_file: path.join(tmp, "rl2.md"), state_key: "t11b", feeds: "https://this-site-does-not-exist.invalid/feed, https://feeds.bbci.co.uk/news/technology/rss.xml" });
	expect(/⚠️ Could not read https:\/\/this-site-does-not-exist\.invalid\/feed/.test(text(r)), text(r));
});

test("12-price-threshold-alert", "1st run alerts on rules that are true", () => {
	const r = run("12-price-threshold-alert", { notify_channel: "telegram", notify_target: "@prices" });
	expect(/🔔 BTC-USD is [\d,.]+ USD, rule “BTC-USD > 1” is now true/.test(text(r)), text(r));
	expect(/▫️ ETH-USD < 1 \(now [\d,.]+\)/.test(text(r)), text(r));
	expect(/\[--target\] \[@prices\] \[--message\] \[🔔/.test(calls()), "no alert sent");
});
test("12-price-threshold-alert", "2nd run stays quiet", () => {
	const r = run("12-price-threshold-alert");
	expect(r.output[0].alert === false, text(r));
});
test("12-price-threshold-alert", "cleared rules, bad pairs and bad rules are reported", () => {
	const r = run("12-price-threshold-alert", { rules: "ETH-USD < 1, FOO-BAR > 5, nonsense" });
	const t = r.output[0].message;
	expect(/↩️ “BTC-USD > 1” is no longer true/.test(t) && /⚠️ FOO-BAR > 5 \(HTTP 404\)/.test(t) && /Could not understand rule: nonsense/.test(t), t);
});

test("13-git-daily-standup", "summarises recent commits", () => {
	const repo = path.join(tmp, "demo-repo");
	mkdirSync(repo);
	const git = (...a) => spawnSync("git", ["-C", repo, ...a], { encoding: "utf8" });
	git("init", "-q");
	writeFileSync(path.join(repo, "a.txt"), "a\n");
	git("add", ".");
	git("-c", "user.name=Ada", "-c", "user.email=ada@example.com", "commit", "-qm", "Add login form validation");
	git("-c", "user.name=Bob", "-c", "user.email=bob@example.com", "commit", "-q", "--allow-empty", "-m", "Bump version to 1.2.0");
	const r = run("13-git-daily-standup", { repo });
	expect(/🧑‍💻 Standup — demo-repo/.test(text(r)) && /Commits since 1 day ago: 2 · \+1 \/ -0 lines/.test(text(r)) && /Add login form validation \(Ada,/.test(text(r)), text(r));
	const bob = run("13-git-daily-standup", { repo, author: "Bob" });
	expect(/Commits since 1 day ago: 1 /.test(text(bob)) && !/Ada/.test(text(bob)), text(bob));
});
test("13-git-daily-standup", "quiet day and non-repo folder", () => {
	const r = run("13-git-daily-standup", { repo: path.join(tmp, "demo-repo"), since: "2099-01-01" });
	expect(/No commits in demo-repo since 2099-01-01/.test(text(r)), text(r));
	expect(/Not a git repository/.test(runError("13-git-daily-standup", { repo: os.tmpdir() })), "expected a clear error");
});

test("14-system-health-check", "alerts once when limits are crossed, then on recovery", () => {
	const strict = { disk_pct: "0", memory_pct: "0", load_per_cpu: "-1" };
	const a = run("14-system-health-check", strict);
	expect(/🔴 disk \/ is [\d.]+% full/.test(text(a)) && /🔴 memory is/.test(text(a)) && /🔴 CPU load is/.test(text(a)), text(a));
	const b = run("14-system-health-check", strict);
	expect(b.output[0].alert === false, text(b));
	const c = run("14-system-health-check", { disk_pct: "100", memory_pct: "100", load_per_cpu: "1000" });
	expect(/✅ OK again: memory/.test(text(c)) && /All checks within limits/.test(text(c)), text(c));
});

test("15-reusable-subworkflows", "holiday reminder built from lib/ sub-workflows", () => {
	const r = run("15-reusable-subworkflows", { country: "US", remind_days: "400", notify_channel: "slack", notify_target: "channel:C15" });
	expect(/^⚠️ Next public holiday in US: .+ in \d+ days, time to plan!\n• /.test(text(r)) || /^✅ .+ starts (today|tomorrow)/.test(text(r)), text(r));
	expect(/\[channel:C15\] \[--message\] \[(⚠️|✅) /.test(calls()), "lib/notify did not send");
});
test("15-reusable-subworkflows", "lib/notify works on its own", () => {
	const r = run("15-reusable-subworkflows", { title: "Deploy done", body: "v1.2 is live", level: "success" }, { file: "lib/notify.json" });
	expect(text(r).trim() === "✅ Deploy done\nv1.2 is live", text(r));
});

test("16-resilient-api-fallback", "primary API works", () => {
	const r = run("16-resilient-api-fallback");
	expect(/^💱 1 USD = [\d.]+ EUR · [\d.]+ CNY/.test(text(r)) && /Source: open\.er-api\.com/.test(text(r)), text(r));
});
test("16-resilient-api-fallback", "falls back when the primary is down", () => {
	const r = run("16-resilient-api-fallback", { primary_url: "https://this-site-does-not-exist.invalid/" });
	expect(/Source: frankfurter\.dev, .*backup API used, primary failed: no response/.test(text(r)), text(r));
});
test("16-resilient-api-fallback", "clear error when both are down; sanity check blocks bad data", () => {
	const err = runError("16-resilient-api-fallback", { primary_url: "https://this-site-does-not-exist.invalid/", fallback_url: "https://also-not-there.invalid/" });
	expect(/Both APIs failed\. Primary: no response .*Backup: no response/.test(err), err);
	const r = run("16-resilient-api-fallback", { symbols: "EUR,XYZ" });
	expect(/failed the sanity check, nothing was sent: missing or invalid rates for XYZ/.test(text(r)), text(r));
});

test("17-csv-contact-cleaner", "cleans, merges and rejects", () => {
	const output_dir = path.join(tmp, "contacts");
	const r = run("17-csv-contact-cleaner", { output_dir });
	const t = text(r);
	expect(/Cleaned 10 rows → 6 contacts/.test(t) && /merged 2 duplicate/.test(t) && /line 5: invalid email/.test(t) && /line 7: missing name/.test(t), t);
	const csv = readFileSync(path.join(output_dir, "contacts.clean.csv"), "utf8");
	expect(csv.includes('Ada Lovelace,ada@example.com,+442079460958,"Analytical Engines, Ltd",London,'), csv);
	expect(csv.includes('"Lin, Mei",mei.lin@example.cn,13800138000,"Example ""Tech"" Co",Shanghai,'), csv);
	expect(csv.includes("Linus Torvalds,linus@kernel.example,,Linux Foundation,Portland,phone unreadable: not available"), csv);
});

test("18-blog-to-social-posts", "draft → pick + edit → approve → published", () => {
	const drafts_file = path.join(tmp, "posts.md");
	const r = run("18-blog-to-social-posts", { drafts_file, notify_channel: "slack", notify_target: "channel:C18" });
	expect(r.status === "needs_input" && /^Drafts for: .+/.test(r.requiresInput.subject[0]), JSON.stringify(r.requiresInput?.subject));
	const picked = resume(r, { pick: 1, edited_text: "My own words about the new trait solver." });
	expect(picked.status === "needs_approval" && picked.requiresApproval.items.includes("My own words about the new trait solver."), JSON.stringify(picked.requiresApproval?.items));
	const done = resume(picked, true);
	expect(/✅ Published to slack/.test(text(done)), text(done));
	expect(/My own words about the new trait solver\.\n\nhttps:\/\/blog\.rust-lang\.org\//.test(readFileSync(drafts_file, "utf8")), "drafts file not written");
	expect(/\[channel:C18\] \[--message\] \[My own words/.test(calls()), "post not published");
});
test("18-blog-to-social-posts", "rejecting publishes nothing", () => {
	const drafts_file = path.join(tmp, "posts-rejected.md");
	const r = run("18-blog-to-social-posts", { drafts_file });
	const done = resume(resume(r, { pick: 1 }), false);
	expect(done.status === "cancelled" && !existsSync(drafts_file), `status ${done.status}`);
});

test("19-batch-geocoder", "geocodes a list with pauses, reports misses", () => {
	const input_file = path.join(tmp, "places.txt");
	writeFileSync(input_file, "# test\nBerlin\nSpringfield, US\nXyzzy Nowhereville\n");
	const output_file = path.join(tmp, "geo.csv");
	const r = run("19-batch-geocoder", { input_file, output_file });
	expect(/Geocoded 2 of 3 places/.test(text(r)) && /❓ Not found: Xyzzy Nowhereville/.test(text(r)), text(r));
	const csv = readFileSync(output_file, "utf8").split("\n");
	expect(csv[0] === "query,found,name,region,country,lat,lon,timezone,population" && /^Springfield, US|^"Springfield, US",true,Springfield,.*,United States,/.test(csv[2]), csv.join("\n"));
});

test("20-expense-categorizer", "report with correct totals; saved rules skip the LLM", () => {
	const report_file = path.join(tmp, "spending.md");
	const a = run("20-expense-categorizer", { report_file });
	expect(/💸 Spent 2,624\.12 EUR · income 4,200\.00 EUR · left 1,575\.88 EUR/.test(text(a)) && /0 categorised by saved rules, 16 new merchant\(s\) sent to the LLM/.test(text(a)), text(a));
	expect(/^# Spending report 2026-09-01 → 2026-09-28/.test(readFileSync(report_file, "utf8")), "report not written");
	const b = run("20-expense-categorizer", { report_file });
	expect(/[1-9]\d* categorised by saved rules/.test(text(b)), text(b));
});
test("20-expense-categorizer", "cost_limit stops an over-budget run", () => {
	const err = runError("20-expense-categorizer", { report_file: path.join(tmp, "never.md"), state_key: "t20b" }, { extraEnv: { LOBSTER_LLM_PRICING_JSON: JSON.stringify({ mock: { input: 1e7, output: 1e7 } }), LOBSTER_CACHE_DIR: path.join(tmp, "cache-cost") } });
	expect(/Cost limit exceeded/.test(err) && !existsSync(path.join(tmp, "never.md")), err);
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
