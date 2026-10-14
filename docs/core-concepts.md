# Core Concepts

**English** · [简体中文](core-concepts.zh-CN.md)

Ten ideas that make every recipe in this cookbook easy to read. Each one links to a recipe where you can see it in action.

## 1. Agent vs. workflow: who decides what?

OpenClaw's agent is an LLM: flexible and creative, but it may do things slightly differently each time, and every step costs tokens. A **Lobster workflow** is the opposite: a fixed list of steps that runs the same way every time and pauses for you at the points that matter.

| Use the agent for… | Use a workflow for… |
|---|---|
| One-off questions, open-ended research | Repeatable jobs: monitors, reports, syncs |
| Deciding *what* to do | Doing it the *same way* every time |
| | Anything with side effects that needs approval |

The best combination: the agent starts a workflow with **one tool call** (instead of 20 tool calls of its own), shows you any approval request, and resumes it with your answer. Inside the workflow, LLM calls (`llm.invoke`) are used only for the parts that need judgement.

## 2. Anatomy of a workflow file

```json
{
  "name": "daily-weather-briefing",
  "description": "What it does, in one sentence.",
  "args": {
    "city": { "default": "Berlin", "description": "Display name used in the message" }
  },
  "steps": [
    { "id": "forecast", "run": "curl -fsS \"https://api.open-meteo.com/...\"" },
    { "id": "format", "stdin": "$forecast.json", "run": "node -e '...'" }
  ]
}
```

- **`args`**: inputs with defaults. Override them with `--args-json '{"city":"Paris"}'` (terminal) or `argsJson` (OpenClaw tool call).
- **`steps`**: run top to bottom. Each has a unique `id` and **one** kind: `run`, `pipeline`, `approval`, `input`, `for_each`, `parallel` or `workflow`.
- Files can be `.json`, `.yaml`/`.yml` or `.lobster` (YAML). This cookbook uses JSON so you can validate it with any tool.

## 3. Step kinds

| Kind | What it does | Recipe |
|---|---|---|
| `run` | A shell command (`/bin/sh`). Whatever it prints is the step's output. | all |
| `pipeline` | A built-in Lobster command: `llm.invoke`, `diff.last`, `state.get`, `state.set`… | 03, 04, 05, 11, 12, 20 |
| `approval` | Pause for a yes/no decision. | 06, 07, 18 |
| `input` | Pause and ask a question; the answer must match a JSON Schema. | 08, 18 |
| `for_each` | Run sub-steps once per item of an array. | 03, 04, 06, 11, 12, 19 |
| `parallel` | Run several branches at the same time. | 10 |
| `workflow` | Run another workflow file as one step. | 10, 15 |

## 4. Passing data between steps

Each finished step has:

- `$id.stdout`: what it printed (text)
- `$id.json`: the same, parsed as JSON (if it was valid JSON)
- `$id.json.some.field`: drill into JSON, including array indexes (`$id.json.items.0.name`)
- `$id.approved` (approval steps), `$id.response` (input steps), `$id.skipped`
- `$id.error` and `$id.errorMessage` (a step that failed with `on_error: "continue"`)

Hand data to a step in one of two **safe** ways:

```json
{ "id": "format", "stdin": "$forecast.json", "run": "node -e '...read stdin...'" }
{ "id": "report", "env": { "SUMMARY": "$summary.stdout" }, "run": "node -e '...process.env.SUMMARY...'" }
```

> 🚫 **Don't** write `"run": "echo $summary.json.title"`. References are replaced as **plain text** before the shell runs, so quotes, `$` or `;` inside the data can break the command or run something unintended. `npm run validate` rejects this pattern.

Args work the same way. Inside commands, use `$LOBSTER_ARG_CITY` (a safe environment variable), not `${city}` (raw text). `${city}` is fine in `pipeline` text and in `workflow_args`.

The **workflow's result** is the output of the last step that ran (skipped steps don't count).

## 5. Conditions

Add `when` (or `condition`) to run a step only sometimes:

```json
{ "id": "notify", "when": "$report.json.alert == true", "run": "..." }
{ "id": "approve", "when": "$scan.json.count > 0", "approval": { "prompt": "Move these files?" } }
{ "id": "save", "when": "$approve.approved", "run": "..." }
```

Supported: `==`, `!=`, `<`, `<=`, `>`, `>=`, `&&`, `||`, `!`, parentheses, strings in quotes, numbers, `true`/`false`/`null`. Comparisons with `<` `>` are strictly numeric.

## 6. Loops and parallel branches

```json
{ "id": "check", "for_each": "$targets.json", "item_var": "site", "pause_ms": 500,
  "steps": [ { "id": "probe", "env": { "URL": "$site.json.url" }, "run": "..." } ] }
```

The loop's output is a list with one entry per item: `[{ "site": {...}, "probe": {...} }, ...]`.

```json
{ "id": "sources", "parallel": { "wait": "all", "timeout_ms": 45000, "branches": [
  { "id": "news", "run": "..." }, { "id": "rates", "run": "..." } ] } }
```

The output is an object keyed by branch id: `{ "news": ..., "rates": ... }`. If any branch fails, the step fails, so make branches tolerant (`... || echo '[]'`).

## 7. Approvals and input: pausing safely

When a workflow reaches an `approval` or `input` step, it **saves its state to disk and stops**, returning:

```json
{ "status": "needs_approval",
  "requiresApproval": { "prompt": "...", "items": ["what you're approving"], "resumeToken": "eyJ...", "approvalId": "5db7ce6c" } }
```

- In **chat**, the agent shows you the prompt and items, then resumes with `{"action": "resume", "approvalId": "...", "approve": true}`. For input steps it sends `"token"` and `"responseJson"` instead.
- In the **terminal**: `npx lobster resume --token <token> --approve yes|no` or `--response-json '{...}'`.
- Rejecting ends the run with `status: "cancelled"`. Later steps don't run.
- Tokens are **single-use**. They're not tied to a user, so treat them like passwords.
- Whatever you pass to an approval step as `stdin` becomes its `items`. Pass an **array** (e.g. report lines): the OpenClaw plugin shows `items` to the agent, and a plain string arrives as an empty list.

## 8. Remembering things between runs

| Command | Use |
|---|---|
| `diff.last --key K` | Compare the input with the last saved value of `K`, save the new one, and return `{changed, before, after}`. ([recipe 03](../examples/03-website-uptime-monitor/)) |
| `state.get K` / `state.set K` | Read / write any JSON value. ([recipe 04](../examples/04-github-release-watcher/)) |

State lives in `~/.lobster/state` (override with `LOBSTER_STATE_DIR`).

## 9. Calling an LLM

```json
{ "id": "pick", "stdin": "$stories.json",
  "pipeline": "llm.invoke --prompt 'Pick the 3 best stories...' --output-schema '{\"type\":\"object\",...}'" }
```

- The input (`stdin`) is sent along with the prompt.
- With `--output-schema`, the answer is validated, retried once if it doesn't match, and available at `$pick.json.output.data`. Without a schema, the text is at `$pick.json.output.text`.
- Answers are cached by prompt + input, so re-runs and resumes don't pay twice.
- Put a budget on a whole workflow with `"cost_limit": { "max_usd": 0.05, "action": "stop" }` (set `LOBSTER_LLM_PRICING_JSON` for models Lobster doesn't know). Batch items into one call, and save answers as rules so they aren't asked again ([recipe 20](../examples/20-expense-categorizer/)).
- Where the request goes depends on `LOBSTER_LLM_PROVIDER` (`openclaw` or `http`), see [Getting Started §4](getting-started.md#4-connect-an-llm-for-ai-recipes).
- Pattern used throughout: **the LLM decides, code formats.** Let the model classify, pick or write, and add facts (URLs, numbers) from the source data in a normal step.

## 10. Making workflows robust

| Tool | Example |
|---|---|
| Retries | `"retry": { "max": 3, "backoff": "exponential", "delay_ms": 2000 }` ([02](../examples/02-daily-weather-briefing/)) |
| Timeouts | `"timeout_ms": 60000` per step; `timeoutMs` for the whole run in the tool call |
| Keep going on error | `"on_error": "continue"` (the step gets `error: true` and `errorMessage`), then branch with `when` ([16](../examples/16-resilient-api-fallback/)). `"skip_rest"` ends the run silently. |
| Errors as data | Catch failures inside the step and print `{"error": "..."}` ([03](../examples/03-website-uptime-monitor/), [04](../examples/04-github-release-watcher/)) |
| Reversible actions | Move instead of delete, write an undo script ([07](../examples/07-safe-file-cleanup/)) |
| Validate input | Treat external data as untrusted ([09](../examples/09-webhook-lead-capture/), [17](../examples/17-csv-contact-cleaner/)) |
| Fallbacks | A backup source when the main one fails ([16](../examples/16-resilient-api-fallback/)) |
| Rate limits | `batch_size` + `pause_ms` on loops, and wait-and-retry on HTTP 429 ([19](../examples/19-batch-geocoder/)) |
| Reuse | Put shared logic in sub-workflows ([15](../examples/15-reusable-subworkflows/)) |
| Inspect before running | `npx lobster run --dry-run --file …` and `npx lobster graph --file …` |
