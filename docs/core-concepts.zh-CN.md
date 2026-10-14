# 核心概念

[English](core-concepts.md) · **简体中文**

理解下面 10 个概念，本食谱里的每个工作流都能轻松读懂。每个概念都附有可以看到实际用法的食谱链接。

## 1. Agent 与工作流：谁来做决定？

OpenClaw 的 Agent 是一个 LLM：灵活、有创造力，但每次做法可能略有不同，每一步都要消耗 token。**Lobster 工作流**正好相反：一串固定的步骤，每次都按同样的方式执行，并在关键节点停下来等你确认。

| 适合交给 Agent 的事 | 适合写成工作流的事 |
|---|---|
| 一次性的问题、开放式调研 | 需要重复执行的任务：监控、报告、同步 |
| 决定*做什么* | 每次都*用同样的方式*做 |
| | 任何有副作用、需要审批的操作 |

最佳搭配：Agent 用**一次工具调用**启动工作流（而不是自己调用 20 次工具），把审批请求展示给你，再带着你的答复恢复运行。工作流内部只在真正需要判断的地方调用 LLM（`llm.invoke`）。

## 2. 工作流文件的结构

```json
{
  "name": "daily-weather-briefing",
  "description": "一句话说明它做什么。",
  "args": {
    "city": { "default": "Berlin", "description": "消息中显示的城市名" }
  },
  "steps": [
    { "id": "forecast", "run": "curl -fsS \"https://api.open-meteo.com/...\"" },
    { "id": "format", "stdin": "$forecast.json", "run": "node -e '...'" }
  ]
}
```

- **`args`**：带默认值的输入参数。可以用 `--args-json '{"city":"Paris"}'`（终端）或 `argsJson`（OpenClaw 工具调用）覆盖。
- **`steps`**：从上到下依次执行。每一步有唯一的 `id`，并且**只能有一种**类型：`run`、`pipeline`、`approval`、`input`、`for_each`、`parallel` 或 `workflow`。
- 文件格式可以是 `.json`、`.yaml`/`.yml` 或 `.lobster`（YAML）。本食谱使用 JSON，方便用任何工具校验。

## 3. 步骤类型

| 类型 | 作用 | 食谱 |
|---|---|---|
| `run` | 执行一条 shell 命令（`/bin/sh`），打印的内容就是这一步的输出 | 全部 |
| `pipeline` | 执行 Lobster 内置命令：`llm.invoke`、`diff.last`、`state.get`、`state.set`…… | 03、04、05 |
| `approval` | 暂停，等待"是/否"决定 | 06、07 |
| `input` | 暂停并提问，答案必须符合指定的 JSON Schema | 08 |
| `for_each` | 对数组中的每一项执行一遍子步骤 | 03、04、06 |
| `parallel` | 同时执行多个分支 | 10 |
| `workflow` | 把另一个工作流文件当作一个步骤来运行 | 10 |

## 4. 在步骤之间传递数据

每个执行完的步骤都有：

- `$id.stdout`：它打印的文本
- `$id.json`：同样的内容按 JSON 解析后的结果（如果是合法 JSON）
- `$id.json.some.field`：深入 JSON 内部，支持数组下标（`$id.json.items.0.name`）
- `$id.approved`（审批步骤）、`$id.response`（input 步骤）、`$id.skipped`

把数据交给某个步骤，有两种**安全**的方式：

```json
{ "id": "format", "stdin": "$forecast.json", "run": "node -e '...从 stdin 读取...'" }
{ "id": "report", "env": { "SUMMARY": "$summary.stdout" }, "run": "node -e '...process.env.SUMMARY...'" }
```

> 🚫 **不要**写成 `"run": "echo $summary.json.title"`。引用会在 shell 执行前被当作**纯文本**替换进去，数据里的引号、`$` 或 `;` 可能导致命令出错，甚至执行意料之外的操作。`npm run validate` 会拒绝这种写法。

参数也一样。在命令里请使用 `$LOBSTER_ARG_CITY`（安全的环境变量），不要用 `${city}`（原样文本替换）。`${city}` 可以放心地用在 `pipeline` 文本和 `workflow_args` 中。

**工作流的结果**就是最后一个实际执行的步骤的输出（被跳过的步骤不算）。

## 5. 条件

给步骤加上 `when`（或 `condition`），让它只在满足条件时执行：

```json
{ "id": "notify", "when": "$report.json.alert == true", "run": "..." }
{ "id": "approve", "when": "$scan.json.count > 0", "approval": { "prompt": "Move these files?" } }
{ "id": "save", "when": "$approve.approved", "run": "..." }
```

支持：`==`、`!=`、`<`、`<=`、`>`、`>=`、`&&`、`||`、`!`、括号、带引号的字符串、数字、`true`/`false`/`null`。`<`、`>` 类比较严格按数字比较。

## 6. 循环与并行分支

```json
{ "id": "check", "for_each": "$targets.json", "item_var": "site", "pause_ms": 500,
  "steps": [ { "id": "probe", "env": { "URL": "$site.json.url" }, "run": "..." } ] }
```

循环的输出是一个列表，每一项对应一个元素：`[{ "site": {...}, "probe": {...} }, ...]`。

```json
{ "id": "sources", "parallel": { "wait": "all", "timeout_ms": 45000, "branches": [
  { "id": "news", "run": "..." }, { "id": "rates", "run": "..." } ] } }
```

输出是一个以分支 id 为键的对象：`{ "news": ..., "rates": ... }`。只要有一个分支失败，整个步骤就会失败，所以要让分支能容错（`... || echo '[]'`）。

## 7. 审批与输入：安全地暂停

工作流执行到 `approval` 或 `input` 步骤时，会**把当前状态保存到磁盘并停止**，返回：

```json
{ "status": "needs_approval",
  "requiresApproval": { "prompt": "...", "items": ["待审批的内容"], "resumeToken": "eyJ...", "approvalId": "5db7ce6c" } }
```

- 在**聊天**中：Agent 把提示和 items 展示给你，然后用 `{"action": "resume", "approvalId": "...", "approve": true}` 恢复运行。input 步骤则发送 `"token"` 和 `"responseJson"`。
- 在**终端**中：`npx lobster resume --token <token> --approve yes|no`，或 `--response-json '{...}'`。
- 拒绝会让运行以 `status: "cancelled"` 结束，后续步骤都不会执行。
- 令牌是**一次性**的，而且不绑定用户，要像密码一样保管。
- 传给审批步骤的 `stdin` 会变成它的 `items`。请传**数组**（例如报告的每一行）：OpenClaw 插件会把 `items` 展示给 Agent，而单个字符串会变成空列表。

## 8. 在多次运行之间记住信息

| 命令 | 用途 |
|---|---|
| `diff.last --key K` | 把输入和上次保存的 `K` 比较，保存新值，返回 `{changed, before, after}`。（[食谱 03](../examples/03-website-uptime-monitor/README.zh-CN.md)） |
| `state.get K` / `state.set K` | 读 / 写任意 JSON 值。（[食谱 04](../examples/04-github-release-watcher/README.zh-CN.md)） |

状态保存在 `~/.lobster/state`（可用 `LOBSTER_STATE_DIR` 修改）。

## 9. 调用 LLM

```json
{ "id": "pick", "stdin": "$stories.json",
  "pipeline": "llm.invoke --prompt 'Pick the 3 best stories...' --output-schema '{\"type\":\"object\",...}'" }
```

- 输入（`stdin`）会和提示词一起发送。
- 使用 `--output-schema` 时，答案会被校验，不符合就重试一次，结果在 `$pick.json.output.data`。不带 schema 时，文本在 `$pick.json.output.text`。
- 答案按"提示词 + 输入"缓存，重复运行和恢复运行都不会重复付费。
- 请求发往哪里取决于 `LOBSTER_LLM_PROVIDER`（`openclaw` 或 `http`），见[快速上手第 4 节](getting-started.zh-CN.md#4-接入-llmai-类食谱需要)。
- 贯穿全书的模式：**LLM 做判断，代码做排版。** 让模型去分类、挑选、撰写，而事实信息（链接、数字）由普通步骤从原始数据中补上。

## 10. 让工作流更可靠

| 手段 | 示例 |
|---|---|
| 重试 | `"retry": { "max": 3, "backoff": "exponential", "delay_ms": 2000 }`（[02](../examples/02-daily-weather-briefing/README.zh-CN.md)） |
| 超时 | 每步 `"timeout_ms": 60000`；整个运行的超时在工具调用里用 `timeoutMs` 设置 |
| 出错后继续 | `"on_error": "continue"`（该步骤会带上 `error: true`）或 `"skip_rest"` |
| 把错误当作数据 | 在步骤内部捕获失败，输出 `{"error": "..."}`（[03](../examples/03-website-uptime-monitor/README.zh-CN.md)、[04](../examples/04-github-release-watcher/README.zh-CN.md)） |
| 可撤销的操作 | 移动而不是删除，并生成撤销脚本（[07](../examples/07-safe-file-cleanup/README.zh-CN.md)） |
| 校验输入 | 把外部数据视为不可信（[09](../examples/09-webhook-lead-capture/README.zh-CN.md)） |
| 运行前检查 | `npx lobster run --dry-run --file …` 和 `npx lobster graph --file …` |
