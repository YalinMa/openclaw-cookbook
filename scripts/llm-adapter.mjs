#!/usr/bin/env node
// LLM bridge for Lobster's `llm.invoke` (generic "http" provider).
//
// Lobster POSTs { prompt, artifacts, outputSchema?, model?, temperature?, maxOutputTokens? }
// to <LOBSTER_LLM_ADAPTER_URL>/invoke and expects
// { ok: true, result: { output: { format: "json", data } | { format: "text", text } } }.
//
// This bridge forwards the request to any OpenAI-compatible Chat Completions API
// (DeepSeek, OpenAI, Qwen, OpenRouter, Ollama, LM Studio...) or, with --mock,
// answers locally with deterministic fake data that matches the requested schema.
//
// Usage:
//   node scripts/llm-adapter.mjs --mock                 # offline, free, for testing
//   LLM_API_KEY=sk-... node scripts/llm-adapter.mjs     # DeepSeek by default
//   LLM_BASE_URL=http://localhost:11434/v1 LLM_MODEL=llama3.2 node scripts/llm-adapter.mjs  # Ollama
//
// Then, in the shell that runs Lobster:
//   export LOBSTER_LLM_PROVIDER=http
//   export LOBSTER_LLM_ADAPTER_URL=http://127.0.0.1:18787
//
// No dependencies: Node.js 22+ only.

import { createHash } from "node:crypto";
import http from "node:http";

const MOCK = process.argv.includes("--mock") || process.env.LLM_MOCK === "1";
const PORT = Number(process.env.LLM_ADAPTER_PORT ?? 18787);
const BASE_URL = (process.env.LLM_BASE_URL ?? "https://api.deepseek.com/v1").replace(/\/$/, "");
const API_KEY = process.env.LLM_API_KEY ?? "";
const DEFAULT_MODEL = process.env.LLM_MODEL ?? "deepseek-chat";

if (!MOCK && !API_KEY && !/localhost|127\.0\.0\.1/.test(BASE_URL)) {
	console.error("LLM_API_KEY is not set. Set it, point LLM_BASE_URL at a local server, or use --mock.");
	process.exit(1);
}

// ---------- mock mode: build a value that satisfies a JSON Schema ----------

// The same input always gets the same answer, but different inputs get different
// enum values, so demos (e.g. ticket triage) don't put everything in one bucket.
function pick(seed, name, n) {
	return createHash("sha256").update(seed + "|" + name).digest().readUInt32BE(0) % n;
}

function mockFromSchema(schema, name = "value", depth = 0, seed = "") {
	if (!schema || typeof schema !== "object" || depth > 6) return `mock ${name}`;
	if ("const" in schema) return schema.const;
	if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[pick(seed, name, schema.enum.length)];
	if (schema.default !== undefined) return schema.default;
	const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== "null") : schema.type;
	switch (type) {
		case "object": {
			const out = {};
			for (const [key, sub] of Object.entries(schema.properties ?? {})) {
				out[key] = mockFromSchema(sub, name + "." + key, depth + 1, seed);
			}
			return out;
		}
		case "array": {
			const count = Math.max(1, schema.minItems ?? 1);
			return Array.from({ length: count }, (_, i) => mockFromSchema(schema.items, `${name}[${i}]`, depth + 1, seed));
		}
		case "integer":
		case "number": {
			// Inside list item N, count up (1, 2, 3...) so mock "pick an index" answers stay distinct.
			const inList = name.match(/\[(\d+)\]\.[^.[]+$/);
			return (schema.minimum ?? 1) + (inList ? Number(inList[1]) : pick(seed, name, 5));
		}
		case "boolean":
			return false;
		default:
			return `mock ${name.replace(/^value\./, "")}`;
	}
}

function mockAnswer(payload) {
	if (payload.outputSchema) {
		const seed = JSON.stringify(payload.artifacts ?? []);
		return { format: "json", data: mockFromSchema(payload.outputSchema, "value", 0, seed) };
	}
	const n = payload.artifacts?.length ?? 0;
	return { format: "text", text: `[mock LLM] ${payload.prompt.slice(0, 80)} (${n} input item${n === 1 ? "" : "s"})` };
}

// ---------- real mode: OpenAI-compatible Chat Completions ----------

async function realAnswer(payload) {
	const parts = [payload.prompt];
	if (payload.artifacts?.length) {
		parts.push("Input:\n" + payload.artifacts.map((a) => (a.kind === "text" ? a.text : JSON.stringify(a))).join("\n"));
	}
	if (payload.outputSchema) {
		parts.push("Reply with a single JSON object (no code fences) matching this JSON Schema:\n" + JSON.stringify(payload.outputSchema));
	}
	if (payload.retryContext?.validationErrors?.length) {
		parts.push("Your previous reply failed validation: " + payload.retryContext.validationErrors.join("; "));
	}
	const body = {
		model: payload.model || DEFAULT_MODEL,
		messages: [{ role: "user", content: parts.join("\n\n") }],
		...(payload.outputSchema ? { response_format: { type: "json_object" } } : {}),
		...(payload.temperature !== undefined ? { temperature: payload.temperature } : {}),
		...(payload.maxOutputTokens ? { max_tokens: payload.maxOutputTokens } : {}),
	};
	const res = await fetch(`${BASE_URL}/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json", ...(API_KEY ? { authorization: `Bearer ${API_KEY}` } : {}) },
		body: JSON.stringify(body),
	});
	const json = await res.json().catch(() => null);
	if (!res.ok) throw new Error(`${res.status} from ${BASE_URL}: ${JSON.stringify(json).slice(0, 300)}`);
	const text = json?.choices?.[0]?.message?.content ?? "";
	const usage = json?.usage
		? { inputTokens: json.usage.prompt_tokens, outputTokens: json.usage.completion_tokens }
		: undefined;
	if (!payload.outputSchema) return { output: { format: "text", text }, model: body.model, usage };
	const cleaned = text.replace(/^```(?:json)?\s*|\s*```$/g, "");
	return { output: { format: "json", data: JSON.parse(cleaned) }, model: body.model, usage };
}

// ---------- HTTP server ----------

const server = http.createServer(async (req, res) => {
	const send = (status, obj) => {
		res.writeHead(status, { "content-type": "application/json" });
		res.end(JSON.stringify(obj));
	};
	if (req.method === "GET" && req.url === "/health") return send(200, { ok: true, mock: MOCK });
	if (req.method !== "POST") return send(405, { ok: false, error: { message: "POST only" } });
	let raw = "";
	for await (const chunk of req) raw += chunk;
	try {
		const payload = JSON.parse(raw);
		if (MOCK) {
			// Rough token estimate (≈4 characters per token) so cost tracking and cost_limit can be tested.
			const output = mockAnswer(payload);
			const usage = { inputTokens: Math.ceil(raw.length / 4), outputTokens: Math.ceil(JSON.stringify(output).length / 4) };
			return send(200, { ok: true, result: { output, model: "mock", usage } });
		}
		return send(200, { ok: true, result: await realAnswer(payload) });
	} catch (err) {
		return send(200, { ok: false, error: { message: String(err?.message ?? err) } });
	}
});

server.listen(PORT, "127.0.0.1", () => {
	const mode = MOCK ? "MOCK (offline)" : `${BASE_URL} · model ${DEFAULT_MODEL}`;
	console.log(`LLM adapter listening on http://127.0.0.1:${PORT} · ${mode}`);
});
