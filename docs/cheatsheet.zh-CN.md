# 速查表

[English](cheatsheet.md) · **简体中文**

## 工作流文件骨架

```json
{
  "name": "my-workflow",
  "description": "一句话说明。",
  "args": { "city": { "default": "Berlin", "description": "..." } },
  "cost_limit": { "max_usd": 0.05, "action": "stop" },
  "steps": [
    { "id": "fetch", "run": "curl -fsS \"https://api.example.com/?q=$LOBSTER_ARG_CITY\"", "retry": { "max": 3 } },
    { "id": "shape", "stdin": "$fetch.json", "run": "node -e 'const d = JSON.parse(require(\"fs\").readFileSync(0, \"utf8\")); console.log(JSON.stringify(d.items))'" }
  ]
}
```

## 步骤字段

| 字段 | 含义 |
|---|---|
| `id` | 唯一名称；字母、数字、`_`、`-` |
| `run` / `command` | Shell 命令（`/bin/sh`） |
| `pipeline` | Lobster 命令，如 `llm.invoke …`、`diff.last --key k`、`state.get k`、`state.set k` |
| `approval` | `"提示?"` 或 `{ "prompt": "...", "required_approver": "..." }` |
| `input` | `{ "prompt": "...", "responseSchema": {...}, "defaults": {...} }` |
| `for_each` + `steps` | 循环；另有 `item_var`、`index_var`、`batch_size`、`pause_ms` |
| `parallel` | `{ "wait": "all"\|"any", "timeout_ms": N, "branches": [{ "id", "run" }] }` |
| `workflow` + `workflow_args` | 运行另一个文件（路径相对于当前文件） |
| `stdin` | `"$step.json"`、`"$step.stdout"`、`"$step.json.field"` |
| `env` | `{ "NAME": "$step.json.field" }`，值不会经过 shell 展开 |
| `when` / `condition` | `"$a.json.n > 0 && $b.approved"` |
| `retry` | `{ "max": 3, "backoff": "fixed"\|"exponential", "delay_ms": 1000, "max_delay_ms": 30000, "jitter": true }` |
| `timeout_ms` | 单步超时 |
| `on_error` | `"stop"`（默认）、`"continue"`、`"skip_rest"` |
| `cwd` | 该步骤的工作目录 |

## 引用语法

| 写法 | 得到 |
|---|---|
| `$step.stdout` | 打印的文本 |
| `$step.json` | 解析后的 JSON |
| `$step.json.a.b.0` | 嵌套字段 / 数组下标 |
| `$step.approved` | 审批后为 `true`/`false` |
| `$step.error`、`$step.errorMessage` | 设置了 `on_error: "continue"` 的步骤的失败信息 |
| `$step.response` | input 步骤收到的答案 |
| `$item.json` | `for_each` 中的当前元素（或你设置的 `item_var`） |
| `$LOBSTER_ARG_NAME` | 在 shell 命令中读取参数（安全） |
| `$LOBSTER_ARGS_JSON` | 所有参数组成的 JSON 字符串 |
| `${name}` | 参数原样文本：只用于 `pipeline`、`workflow_args`、`cwd` |

## 终端命令

```bash
npx lobster run path/to/workflow.json                      # 人类可读输出
npx lobster run --mode tool --file wf.json --args-json '{"a":"b"}'   # JSON 信封（和 OpenClaw 一致）
npx lobster run --dry-run --file wf.json                   # 只展示执行计划，不运行
npx lobster graph --file wf.json --format mermaid          # 生成流程图（mermaid | dot | ascii）
npx lobster resume --token <token> --approve yes           # 回复审批
npx lobster resume --token <token> --response-json '{...}' # 回复 input 步骤
npx lobster help llm.invoke                                # 查看任意命令的帮助
```

## OpenClaw `lobster` 工具调用

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

| 变量 | 作用 |
|---|---|
| `LOBSTER_LLM_PROVIDER` | `openclaw` 或 `http` |
| `OPENCLAW_URL`、`OPENCLAW_TOKEN` | 网关地址 + 令牌（provider 为 `openclaw` 时） |
| `LOBSTER_LLM_ADAPTER_URL` | 桥接地址（provider 为 `http` 时），如 `http://127.0.0.1:18787` |
| `LOBSTER_LLM_MODEL` | 默认模型 |
| `LOBSTER_LLM_FORCE_REFRESH=1` | 忽略缓存 |
| `LOBSTER_STATE_DIR`、`LOBSTER_CACHE_DIR` | 状态 / 缓存的存放位置 |

## 本食谱用到的 OpenClaw 命令

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

## 常用片段

**用 Node 读取 stdin 中的 JSON（一行）：**
`node -e 'const d = JSON.parse(require("fs").readFileSync(0, "utf8")); ...'`

**展开路径参数中的 `~`：**
`process.env.LOBSTER_ARG_FILE.replace(/^~(?=\/|$)/, require("os").homedir())`

**可选的聊天通知步骤：**

```json
{ "id": "notify", "stdin": "$format.stdout",
  "run": "MSG=$(cat); if [ -n \"$LOBSTER_ARG_NOTIFY_CHANNEL\" ]; then openclaw message send --channel \"$LOBSTER_ARG_NOTIFY_CHANNEL\" --target \"$LOBSTER_ARG_NOTIFY_TARGET\" --message \"$MSG\" >&2; fi; printf '%s\\n' \"$MSG\"" }
```

**永不失败的 HTTP 请求（把错误变成数据）：**
`fetch(url, { signal: AbortSignal.timeout(10000) }).then(r => ({ ok: r.ok, status: r.status }), e => ({ ok: false, error: e.name }))`
