#!/usr/bin/env node
// Static checks for every examples/*/workflow.json. No dependencies.
//
//   node scripts/validate.mjs
//
// If the Lobster CLI is installed (npm install), each workflow is also passed
// through `lobster run --dry-run`, which parses it exactly like OpenClaw does.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const examplesDir = path.join(root, "examples");
const lobsterBin = path.join(root, "node_modules", ".bin", "lobster");

const STEP_KINDS = ["run", "command", "pipeline", "workflow", "approval", "input", "parallel", "for_each"];
const STEP_KEYS = new Set([
	"id", ...STEP_KINDS, "steps", "item_var", "index_var", "batch_size", "pause_ms", "workflow_args",
	"env", "cwd", "stdin", "when", "condition", "timeout_ms", "on_error", "retry",
]);
const TOP_KEYS = new Set(["name", "description", "args", "env", "cwd", "steps", "cost_limit"]);
const SECRET_PATTERNS = [/sk-[A-Za-z0-9]{20,}/, /gh[pousr]_[A-Za-z0-9]{30,}/, /xox[abpr]-[A-Za-z0-9-]{10,}/, /AKIA[0-9A-Z]{16}/];
const STEP_REF = /\$([A-Za-z0-9_-]+)\.(json|stdout|approved|response|skipped|error)\b/g;

let failures = 0;
let checks = 0;

function check(ok, file, message) {
	checks += 1;
	if (!ok) {
		failures += 1;
		console.log(`  ✗ ${file}: ${message}`);
	}
}

function refsIn(value) {
	const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
	return [...text.matchAll(STEP_REF)].map((m) => m[1]);
}

function validateSteps(steps, file, args, known, scope) {
	const ids = new Set();
	for (const step of steps) {
		const where = `${scope}step "${step.id}"`;
		check(typeof step.id === "string" && /^[A-Za-z0-9_-]+$/.test(step.id), file, `${where}: id must be letters, digits, _ or -`);
		check(!ids.has(step.id) && !known.has(step.id), file, `${where}: duplicate id`);
		const kinds = STEP_KINDS.filter((k) => step[k] !== undefined);
		check(kinds.length === 1, file, `${where}: needs exactly one of ${STEP_KINDS.join(", ")} (found ${kinds.join(", ") || "none"})`);
		for (const key of Object.keys(step)) check(STEP_KEYS.has(key), file, `${where}: unknown field "${key}"`);

		// Step references must point at an earlier step (or the loop variable).
		for (const field of ["stdin", "when", "condition", "for_each", "env", "pipeline", "workflow_args"]) {
			for (const ref of refsIn(step[field])) {
				check(known.has(ref) || ids.has(ref), file, `${where}: ${field} references unknown or later step "$${ref}"`);
			}
		}
		// Shell commands must not splice step output into the command text:
		// pass it through stdin or env instead (safe from quoting bugs and injection).
		for (const field of ["run", "command"]) {
			if (typeof step[field] === "string") {
				check(refsIn(step[field]).length === 0, file, `${where}: don't put $step references inside ${field}; use stdin or env`);
				for (const [, name] of step[field].matchAll(/\$\{([A-Za-z0-9_-]+)\}/g)) {
					check(false, file, `${where}: \${${name}} is spliced raw into a shell command; use $LOBSTER_ARG_${name.toUpperCase()} instead`);
				}
			}
		}
		// Every ${arg} and $LOBSTER_ARG_X must be a declared argument.
		const text = JSON.stringify(step);
		for (const [, name] of text.matchAll(/\$\{([A-Za-z0-9_-]+)\}/g)) {
			check(name in args, file, `${where}: \${${name}} is not a declared arg`);
		}
		for (const [, name] of text.matchAll(/LOBSTER_ARG_([A-Z0-9_]+)/g)) {
			const declared = Object.keys(args).some((a) => a.toUpperCase().replace(/[^A-Z0-9]+/g, "_") === name);
			check(declared, file, `${where}: $LOBSTER_ARG_${name} has no matching arg`);
		}
		if (step.workflow) {
			const sub = path.resolve(path.dirname(path.join(examplesDir, file)), step.workflow);
			check(existsSync(sub), file, `${where}: sub-workflow ${step.workflow} not found`);
		}
		if (step.parallel) {
			check(Array.isArray(step.parallel.branches) && step.parallel.branches.length > 1, file, `${where}: parallel needs 2+ branches`);
		}
		if (step.for_each) {
			check(Array.isArray(step.steps) && step.steps.length > 0, file, `${where}: for_each needs sub-steps`);
			const inner = new Set([...known, ...ids, step.item_var ?? "item", step.index_var ?? "index"]);
			validateSteps(step.steps, file, args, inner, `${where} > `);
		}
		if (step.input) {
			check(typeof step.input.prompt === "string" && step.input.responseSchema, file, `${where}: input needs prompt and responseSchema`);
		}
		ids.add(step.id);
	}
}

const recipes = readdirSync(examplesDir, { withFileTypes: true })
	.filter((d) => d.isDirectory())
	.map((d) => d.name)
	.sort();

console.log(`Validating ${recipes.length} recipes\n`);

for (const recipe of recipes) {
	const dir = path.join(examplesDir, recipe);
	const file = `${recipe}/workflow.json`;
	const before = failures;

	check(/^\d{2}-[a-z0-9-]+$/.test(recipe), file, "folder must be named NN-kebab-case");
	for (const doc of ["README.md", "README.zh-CN.md"]) check(existsSync(path.join(dir, doc)), file, `missing ${doc}`);

	let raw = "";
	let wf;
	try {
		raw = readFileSync(path.join(dir, "workflow.json"), "utf8");
		wf = JSON.parse(raw);
	} catch (err) {
		check(false, file, `not valid JSON: ${err.message}`);
		continue;
	}

	for (const key of Object.keys(wf)) check(TOP_KEYS.has(key), file, `unknown top-level field "${key}"`);
	check(typeof wf.name === "string" && wf.name.length > 0, file, "missing name");
	check(typeof wf.description === "string" && wf.description.length > 20, file, "missing or too short description");
	check(Array.isArray(wf.steps) && wf.steps.length > 0, file, "missing steps");
	const args = wf.args ?? {};
	for (const [name, spec] of Object.entries(args)) {
		check(/^[a-z][a-z0-9_]*$/.test(name), file, `arg "${name}" should be snake_case`);
		check(spec && spec.default !== undefined, file, `arg "${name}" needs a default so the recipe runs as-is`);
		check(spec && typeof spec.description === "string", file, `arg "${name}" needs a description`);
	}
	if (Array.isArray(wf.steps)) validateSteps(wf.steps, file, args, new Set(), "");

	for (const pattern of SECRET_PATTERNS) check(!pattern.test(raw), file, `looks like it contains a secret (${pattern})`);

	if (existsSync(lobsterBin)) {
		try {
			execFileSync(lobsterBin, ["run", "--dry-run", "--file", path.join(dir, "workflow.json")], { stdio: "pipe", cwd: root });
			checks += 1;
		} catch (err) {
			check(false, file, `lobster --dry-run failed: ${String(err.stderr || err.message).trim().split("\n").pop()}`);
		}
	}

	console.log(`${failures === before ? "✓" : "✗"} ${recipe}`);
}

if (!existsSync(lobsterBin)) console.log("\n(Lobster CLI not installed: skipped dry-run parsing. Run `npm install` to enable it.)");
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
