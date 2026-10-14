# 食谱是如何测试的

[English](validation.md) · **简体中文**

每个食谱都经过三个层次的检查。以下所有结果均来自 **2026 年 10 月 14 日**的测试。

| 层次 | 内容 | 运行方式 |
|---|---|---|
| 1. 静态检查 | 文件结构和安全规则 | `npm run validate`（CI 中也会运行） |
| 2. 端到端运行 | 用真实的 Lobster 运行时执行每个食谱，并检查输出 | `npm test` |
| 3. 在 OpenClaw 中实测 | 由真实的 OpenClaw Agent 通过 `lobster` 插件运行，覆盖聊天、定时任务和 Webhook | 手动，见下文 |

## 1. 静态检查：`npm run validate`

[`scripts/validate.mjs`](../scripts/validate.mjs)（无依赖）检查每个 `examples/*/workflow.json`：

- 合法的 JSON，只包含已知字段，有 `name` 和有意义的 `description`
- 检查每个工作流文件，包括 `lib/*.json` 这样的可复用子工作流
- 每个步骤有唯一的 id，并且只有一种类型（`run`、`pipeline`、`approval`……）
- 每个 `$step` 引用都指向**之前**的步骤（或循环变量）
- 每个 `${arg}` 和 `$LOBSTER_ARG_X` 都对应已声明的参数，每个参数都有默认值和说明
- **不把步骤输出或 `${arg}` 直接拼进 shell 命令**：数据必须通过 `stdin` 或 `env` 传递（防止引号错误和命令注入）
- 子工作流文件存在
- 不包含密钥（API Key 格式）
- 每个食谱都有 `README.md` 和 `README.zh-CN.md`
- 安装了 Lobster CLI 时：用 `lobster run --dry-run` 以和 OpenClaw 相同的方式解析文件

**结果：0 个错误**（见 README 中的 CI 徽章）。

## 2. 端到端运行：`npm test`

[`scripts/test-recipes.mjs`](../scripts/test-recipes.mjs) 以 tool 模式（与 OpenClaw 收到的 JSON 信封相同）运行每个工作流，并检查结果的**内容**，而不仅仅是"没有报错"：

- LLM 步骤使用内置的模拟模型（`scripts/llm-adapter.mjs --mock`），离线返回符合 schema 的答案，不需要 Key。
- `openclaw message send` 被替换成一个替身脚本（[`scripts/test-bin/openclaw`](../scripts/test-bin/openclaw)），只记录调用。
- 审批和 input 步骤会被自动恢复（批准、拒绝、回答）。
- 状态、缓存和输出文件都写到临时文件夹。
- 食谱 02–05、10–12、15、16、18、19 调用真实的公共 API。食谱 13 会创建一个临时 Git 仓库。

| 食谱 | 测试用例 |
|---|---|
| 01 | 默认参数；自定义参数（中文问候） |
| 02 | 实时天气 + 以正确的渠道/目标发送通知 |
| 03 | 第 1 次运行对宕机网站报警 · 第 2 次保持安静 · 第 3 次报告恢复 |
| 04 | 首次运行建立基线 · "没有新版本" · 检测到新版本和不存在的仓库（404） |
| 05 | 摘要包含 ≥ 3 条带链接的新闻 |
| 06 | 暂停并把报告作为审批 items → 批准后写入草稿 · 拒绝则什么都不写 |
| 07 | 审批后只移动顶层的旧文件，`undo.sh` 可还原（含带 `'` 的文件名）· 没有旧文件时不需要审批 |
| 08 | 暂停等待输入 → 回答 `keep: "1"` 后写出只有 1 项、带备注的清单 |
| 09 | 新线索保存并通知 · 重复线索被忽略 · 引号/逗号/换行正确转义为 CSV · 无效线索被拒绝 |
| 10 | 并行数据源 + 子工作流 + LLM，并附上链接 |
| 11 | RSS + Atom 文章追加到 Markdown · 第 2 次运行不重复添加 · 报告无法读取的订阅源 |
| 12 | 第 1 次对成立的规则报警（并发送）· 第 2 次保持安静 · 报告不再成立的规则、未知交易对和无效规则 |
| 13 | 总结临时仓库中的提交并给出总计 · 作者过滤 · 时间段内无提交 · 清晰的"不是 Git 仓库"错误 |
| 14 | 超过阈值只报警一次 · 重复运行保持安静 · 报告恢复 |
| 15 | 由 `lib/fetch-json` + `lib/notify` 组成的提醒（并发送）· 单独运行 `lib/notify` |
| 16 | 主 API · 主 API 宕机时切换备用 · 两者都宕机时明确失败 · 合理性检查拦截错误数据 |
| 17 | 10 行杂乱数据 → 6 个联系人，合并 2 个、拒绝 2 个并给出行号；引号和逗号正确转义 |
| 18 | input（挑选 + 修改）→ 审批时显示原文 → 发布并记录 · 拒绝则不发布 |
| 19 | 带暂停的地理编码，国家提示有效，报告找不到的地名，CSV 正确 |
| 20 | 报告总计准确 · 第 2 次运行使用已保存的规则 · `cost_limit` 拦下超预算的运行 |

**结果：40 / 40 通过**，覆盖 2026 年 5 月以来 OpenClaw 插件附带的每个 Lobster 引擎版本：

| Lobster 引擎 | 附带于插件版本 | 结果 |
|---|---|---|
| 2026.9.16（最新独立版） | — | 40/40 |
| 2026.9.14 | `@openclaw/lobster` 2026.10.x | 40/40 |
| 2026.6.11 | 2026.7.x – 2026.9.1 | 40/40 |
| 2026.5.22 | 2026.5.28 – 2026.6.x | 40/40 |
| 2026.4.6 | ≤ 2026.5.12 | 15/40：不支持 `for_each`、`parallel`、`workflow:` 和 `>` 比较 |

引擎 2026.9.8 和 2026.9.13（插件 2026.9.5–2026.9.9）没有单独测试。如需针对特定引擎测试：`LOBSTER_BIN=/path/to/lobster npm test`。

**真实 LLM 测试：** 食谱 05、06、08、10、13、18、20 还通过桥接用 DeepSeek（`deepseek-flash`）跑过一遍，各食谱 README 中的示例输出就来自这些运行。

## 3. 在 OpenClaw 中实测

以下在 OpenClaw 中的实测针对食谱 01–10。食谱 11–20 使用相同的构件（循环、状态、审批、输入、子工作流、`llm.invoke`），并在第 2 层中用相同的 Lobster 引擎验证过。

为了不影响真实环境，这些测试使用了隔离的 OpenClaw 配置（`openclaw --profile …`，独立的配置目录和端口），Agent 使用 DeepSeek 模型。

| 测试 | OpenClaw 2026.6.11（插件 2026.6.11） | OpenClaw 2026.10.3（插件 2026.10.3） |
|---|---|---|
| 01 在聊天中运行 | ✅ | — |
| 05 通过 OpenClaw `llm-task` 调用 AI（`LOBSTER_LLM_PROVIDER=openclaw`） | ❌ `invalid response envelope` | ✅ |
| 06/10 通过桥接调用 AI（`LOBSTER_LLM_PROVIDER=http`） | ✅ | — |
| 06 在聊天中审批 → 下一条消息批准 → 写入草稿 | ✅ | ✅ |
| 08 在聊天中 input → 回答"保留 1,3,4" → 写入文件 | ❌ 插件不支持 input | ✅ |
| 10 在聊天中运行并行 + 子工作流 + LLM | ✅ | — |
| 02 作为定时任务（`openclaw cron add` + `cron run`） | — | ✅ |
| 09 通过 Webhook（`POST /hooks/lead` → 映射 → Agent → 工作流 → CSV） | — | ✅ |

## 测试中发现（并已修复）的问题

真实运行暴露出了光看文档发现不了的问题：

1. **插件与主程序版本不匹配。** 在 OpenClaw 2026.5.12 上执行 `openclaw plugins install @openclaw/lobster` 会装上 2026.10.3 版插件，然后加载失败（`Cannot find module …/plugin-sdk/…`），尽管它声明 `minHostVersion >= 2026.4.25`。→ [快速上手](getting-started.zh-CN.md#2-安装-lobster-插件)中说明了如何安装匹配的版本。
2. **旧引擎不支持循环、并行和子工作流。** → 快速上手中的版本对照表。
3. **2026.9.14 之前的引擎读不懂 `llm-task` 的响应。** → 方案 A 需要 OpenClaw ≥ 2026.10.1；方案 B（桥接）在所有版本都可用。
4. **2026.10.1 之前的插件不支持 input 步骤。** → 已在食谱 08 中注明。
5. **模型抄错了 155 个字符的恢复令牌**，导致恢复时报 "state not found"。→ 食谱建议用 8 个字符的 `approvalId` 来恢复。
6. **审批预览没有展示给 Agent**：插件只转发 `items` 而不转发 `preview`，而字符串输入会得到空的 `items`。→ 食谱 06 和 07 改为把报告按行组成数组传入。
7. **OpenClaw 2026.10 把网关令牌移到了密钥存储中。** 从 `openclaw.json` 读到的是旧值，导致 `401`。→ 文档改用 `openclaw gateway auth-token --show`。
8. **Webhook 映射中的 `{{payload}}` 渲染为空。** → 食谱 09 改为每个字段一个占位符。
9. **`diff.last` 会把只有一项的列表存成单个值**，第二次比较时出错。→ 食谱 03 改为比较一个对象（`{down: [...]}`）。
10. **把步骤输出拼进 shell 命令时遇到引号就会出错。** → 所有食谱都改用 `stdin`/`env`，并由校验脚本强制检查。
11. **通过 `env` 传递大体积 API 响应**（维基百科约 300 KB）有超出系统环境变量大小限制的风险。→ 食谱 10 在每个分支内部先精简数据。
12. **`on_error: "skip_rest"` 会静默结束运行**，用户不知道为什么什么都没发生。→ 食谱 16 改用 `continue` + `when`，并展示 `$step.errorMessage`。
13. **报警键里含有数字时（"memory 62.3%"），每次细微变化都会重复报警。** → 食谱 14 使用稳定的键（`memory`、`disk /`）。
14. **`lobster` 工具默认 20 秒的超时**对限速任务来说太短（食谱 19 约需 30 秒）。→ 它的 README 说明了要传入 `timeoutMs`。

## 未覆盖的部分

- 真实的聊天推送（Telegram/Slack/飞书……）：测试中 `openclaw message send` 是替身，定时任务推送用 `--no-deliver` 测试。
- 终端中的交互式审批提示（测试使用 tool 模式）。
- Windows：步骤使用 `/bin/sh`，请使用 WSL。
- 所有 LLM 服务商：桥接只用 DeepSeek 和模拟模型测试过，其他 OpenAI 兼容接口理论上可用，但未经测试。
