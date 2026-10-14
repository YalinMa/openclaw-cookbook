# Cheat Sheet

**English** · [简体中文](cheatsheet.zh-CN.md)

## Workflow file skeleton

```json
{
  "name": "my-workflow",
  "description": "One sentence.",
  "args": { "city": { "default": "Berlin", "description": "..." } },
  "cost_limit": { "max_usd": 0.05, "action": "stop" },
  "steps": [
    { "id": "fetch", "run": "curl -fsS \"https://api.example.com/?q=$LOBSTER_ARG_CITY\"", "retry": { "max": 3 } },
    { "id": "shape", "stdin": "$fetch.json", "run": "node -e 'const d = JSON.parse(require(\"fs\").readFileSync(0, \"utf8\")); console.log(JSON.stringify(d.items))'" }
  ]
}
```

## Step fields

| Field | Meaning |
|---|---|
| `id` | Unique name; letters, digits, `_`, `-` |
| `run` / `command` | Shell command (`/bin/sh`) |
| `pipeline` | Lobster command, e.g. `llm.invoke …`, `diff.last --key k`, `state.get k`, `state.set k` |
| `approval` | `"Prompt?"` or `{ "prompt": "...", "required_approver": "..." }` |
| `input` | `{ "prompt": "...", "responseSchema": {...}, "defaults": {...} }` |
| `for_each` + `steps` | Loop; also `item_var`, `index_var`, `batch_size`, `pause_ms` |
| `parallel` | `{ "wait": "all"\|"any", "timeout_ms": N, "branches": [{ "id", "run" }] }` |
| `workflow` + `workflow_args` | Run another file (path relative to this file) |
| `stdin` | `"$step.json"`, `"$step.stdout"`, `"$step.json.field"` |
| `env` | `{ "NAME": "$step.json.field" }`. Values are not shell-expanded. |
| `when` / `condition` | `"$a.json.n > 0 && $b.approved"` |
| `retry` | `{ "max": 3, "backoff": "fixed"\|"exponential", "delay_ms": 1000, "max_delay_ms": 30000, "jitter": true }` |
| `timeout_ms` | Per-step timeout |
| `on_error` | `"stop"` (default), `"continue"`, `"skip_rest"` |
| `cwd` | Working directory for the step |

## References

| Write | Get |
|---|---|
| `$step.stdout` | Printed text |
| `$step.json` | Parsed JSON |
| `$step.json.a.b.0` | Nested value / array index |
| `$step.approved` | `true`/`false` after an approval |
| `$step.error`, `$step.errorMessage` | Failure info of a step with `on_error: "continue"` |
| `$step.response` | The answer of an input step |
| `$item.json` | Current item inside `for_each` (or your `item_var`) |
| `$LOBSTER_ARG_NAME` | Arg value inside a shell command (safe) |
| `$LOBSTER_ARGS_JSON` | All args as one JSON string |
| `${name}` | Raw arg text: only in `pipeline`, `workflow_args`, `cwd` |

## Terminal commands

```bash
npx lobster run path/to/workflow.json                      # human output
npx lobster run --mode tool --file wf.json --args-json '{"a":"b"}'   # JSON envelope (like OpenClaw)
npx lobster run --dry-run --file wf.json                   # show the plan, run nothing
npx lobster graph --file wf.json --format mermaid          # diagram (mermaid | dot | ascii)
npx lobster resume --token <token> --approve yes           # answer an approval
npx lobster resume --token <token> --response-json '{...}' # answer an input step
npx lobster help llm.invoke                                # help for any command
```

## OpenClaw `lobster` tool calls

```json
{ "action": "run", "pipeline": "/abs/path/workflow.json", "argsJson": "{\"city\":\"Paris\"}", "timeoutMs": 120000 }
{ "action": "resume", "approvalId": "5db7ce6c", "approve": true }
{ "action": "resume", "token": "eyJ...", "responseJson": "{\"keep\":\"all\"}" }
{ "action": "resume", "token": "eyJ...", "cancel": true }
```

## llm.invoke

```text
llm.invoke --prompt '...' [--output-schema '{json schema}'] [--model provider/model]
           [--temperature 0.2] [--max-output-tokens 800] [--max-validation-retries 2]
```

| Variable | Purpose |
|---|---|
| `LOBSTER_LLM_PROVIDER` | `openclaw` or `http` |
| `OPENCLAW_URL`, `OPENCLAW_TOKEN` | Gateway URL + token (provider `openclaw`) |
| `LOBSTER_LLM_ADAPTER_URL` | Bridge URL (provider `http`), e.g. `http://127.0.0.1:18787` |
| `LOBSTER_LLM_MODEL` | Default model |
| `LOBSTER_LLM_FORCE_REFRESH=1` | Ignore the cache |
| `LOBSTER_STATE_DIR`, `LOBSTER_CACHE_DIR` | Where state / cache live |

## OpenClaw commands used in this cookbook

```bash
openclaw plugins install @openclaw/lobster
openclaw config set tools.alsoAllow '["lobster","llm-task"]' --strict-json
openclaw config set plugins.entries.llm-task.enabled true --strict-json
openclaw gateway restart
openclaw gateway auth-token --show
openclaw cron add --name N --cron "30 7 * * *" --tz Asia/Shanghai --session isolated --message "..." --announce --channel telegram --to <id>
openclaw cron list | openclaw cron run <id> | openclaw cron runs --id <id> | openclaw cron rm <id>
openclaw message send --channel telegram --target <id> --message "Hi"
openclaw logs --follow
```

## Snippets

**Read stdin JSON in Node (one line):**
`node -e 'const d = JSON.parse(require("fs").readFileSync(0, "utf8")); ...'`

**Expand `~` in a path arg:**
`process.env.LOBSTER_ARG_FILE.replace(/^~(?=\/|$)/, require("os").homedir())`

**Optional chat notification step:**

```json
{ "id": "notify", "stdin": "$format.stdout",
  "run": "MSG=$(cat); if [ -n \"$LOBSTER_ARG_NOTIFY_CHANNEL\" ]; then openclaw message send --channel \"$LOBSTER_ARG_NOTIFY_CHANNEL\" --target \"$LOBSTER_ARG_NOTIFY_TARGET\" --message \"$MSG\" >&2; fi; printf '%s\\n' \"$MSG\"" }
```

**Never-failing HTTP call (errors become data):**
`fetch(url, { signal: AbortSignal.timeout(10000) }).then(r => ({ ok: r.ok, status: r.status }), e => ({ ok: false, error: e.name }))`
