# How the Recipes Are Tested

**English** · [简体中文](validation.zh-CN.md)

Every recipe is checked at three levels. All results below are from **14 October 2026**.

| Level | What | How to run it |
|---|---|---|
| 1. Static checks | File structure and safety rules | `npm run validate` (also in CI) |
| 2. End-to-end runs | Every recipe executed by the real Lobster runtime, outputs checked | `npm test` |
| 3. Inside OpenClaw | Recipes run by a real OpenClaw agent through the `lobster` plugin, from chat, cron and webhooks | manual, described below |

## 1. Static checks: `npm run validate`

[`scripts/validate.mjs`](../scripts/validate.mjs) (no dependencies) checks every `examples/*/workflow.json`:

- valid JSON, only known fields, a `name` and a meaningful `description`
- every step has a unique id and exactly one kind (`run`, `pipeline`, `approval`, …)
- every `$step` reference points to an **earlier** step (or the loop variable)
- every `${arg}` and `$LOBSTER_ARG_X` matches a declared arg, and every arg has a default and a description
- **no step output or `${arg}` spliced into shell commands**: data must travel through `stdin` or `env` (prevents quoting bugs and command injection)
- sub-workflow files exist
- no secrets (API-key patterns)
- each recipe has `README.md` and `README.zh-CN.md`
- when the Lobster CLI is installed: `lobster run --dry-run` parses the file the same way OpenClaw does

**Result: 0 errors** (see the CI badge on the README).

## 2. End-to-end runs: `npm test`

[`scripts/test-recipes.mjs`](../scripts/test-recipes.mjs) runs each workflow with the Lobster CLI in tool mode (the same JSON envelope OpenClaw receives) and checks the **content** of the result, not just "no error":

- LLM steps use the bundled mock (`scripts/llm-adapter.mjs --mock`), which returns schema-valid answers offline, so no key is needed.
- `openclaw message send` is replaced by a stub ([`scripts/test-bin/openclaw`](../scripts/test-bin/openclaw)) that records the call.
- Approvals and input steps are resumed (approve, reject, answer).
- State, cache and output files go to a temporary folder.
- Recipes 02, 03, 04, 05 and 10 call the real public APIs.

| Recipe | Test cases |
|---|---|
| 01 | default args; custom args (Chinese greeting) |
| 02 | live forecast + notification sent with the right channel/target |
| 03 | 1st run alerts on a down site · 2nd run stays quiet · 3rd run reports recovery |
| 04 | baseline on 1st run · "no new releases" · detects a new release and a 404 repo |
| 05 | digest has ≥ 3 stories with links |
| 06 | pauses with the report as approval items → approve writes drafts · reject writes nothing |
| 07 | moves only old top-level files after approval, `undo.sh` restores them (incl. a filename with `'`) · nothing old → no approval |
| 08 | pauses for input → answer `keep: "1"` writes a 1-item checklist with the note |
| 09 | new lead saved + notified · duplicate ignored · quotes/commas/newlines CSV-escaped · invalid lead rejected |
| 10 | parallel sources + sub-workflow + LLM, links appended |

**Result: 20 / 20 passed** with each Lobster engine version bundled in OpenClaw plugins since May 2026:

| Lobster engine | Bundled in plugin | Result |
|---|---|---|
| 2026.9.16 (latest standalone) | — | 20/20 |
| 2026.9.14 | `@openclaw/lobster` 2026.10.x | 20/20 |
| 2026.6.11 | 2026.7.x – 2026.9.1 | 20/20 |
| 2026.5.22 | 2026.5.28 – 2026.6.x | 20/20 |
| 2026.4.6 | ≤ 2026.5.12 | 9/20: no `for_each`, `parallel`, `workflow:` or `>` comparisons |

Engines 2026.9.8 and 2026.9.13 (plugins 2026.9.5–2026.9.9) weren't tested separately. Run against a specific engine with `LOBSTER_BIN=/path/to/lobster npm test`.

**Real-LLM run:** recipes 05, 06, 08 and 10 were also run with DeepSeek (`deepseek-flash`) through the bridge. The example outputs in the recipe READMEs come from these runs.

## 3. Inside OpenClaw

To avoid touching a real setup, these tests used isolated OpenClaw profiles (`openclaw --profile …`, own config folder and port) with DeepSeek as the agent model.

| Test | OpenClaw 2026.6.11 (plugin 2026.6.11) | OpenClaw 2026.10.3 (plugin 2026.10.3) |
|---|---|---|
| 01 run from chat | ✅ | — |
| 05 AI via OpenClaw `llm-task` (`LOBSTER_LLM_PROVIDER=openclaw`) | ❌ `invalid response envelope` | ✅ |
| 06/10 AI via bridge (`LOBSTER_LLM_PROVIDER=http`) | ✅ | — |
| 06 approval in chat → approve in next message → drafts written | ✅ | ✅ |
| 08 input step in chat → answer "keep 1,3,4" → file written | ❌ input not supported by plugin | ✅ |
| 10 parallel + sub-workflow + LLM from chat | ✅ | — |
| 02 as a cron job (`openclaw cron add` + `cron run`) | — | ✅ |
| 09 via webhook (`POST /hooks/lead` → mapping → agent → workflow → CSV) | — | ✅ |

## Problems found by testing (and fixed)

Running everything for real surfaced issues that reading the docs would not have:

1. **Plugin/host mismatch.** `openclaw plugins install @openclaw/lobster` on OpenClaw 2026.5.12 installed plugin 2026.10.3, which then failed to load (`Cannot find module …/plugin-sdk/…`), although it declares `minHostVersion >= 2026.4.25`. → [Getting Started](getting-started.md#2-install-the-lobster-plugin) explains how to install the matching version.
2. **Old engines lack loops, parallel steps and sub-workflows.** → Version table in Getting Started.
3. **`llm-task` responses were misread by engines before 2026.9.14.** → Option A requires OpenClaw ≥ 2026.10.1; option B (bridge) works everywhere.
4. **Input steps aren't supported by plugins before 2026.10.1.** → Noted in recipe 08.
5. **A model mistyped the 155-character resume token**, so the resume failed with "state not found". → Recipes recommend resuming with the 8-character `approvalId`.
6. **The approval preview wasn't shown to the agent:** the plugin forwards `items`, not `preview`, and a string input produces empty `items`. → Recipes 06 and 07 pass their report as an array of lines.
7. **OpenClaw 2026.10 moved the gateway token into a secret store.** Reading it from `openclaw.json` gave an outdated value and a `401`. → Docs use `openclaw gateway auth-token --show`.
8. **`{{payload}}` in a webhook mapping rendered as empty.** → Recipe 09 uses one placeholder per field.
9. **`diff.last` stores a one-item list as a bare value**, so the comparison crashed the second time. → Recipe 03 diffs an object (`{down: [...]}`).
10. **Splicing step output into shell commands broke on quotes.** → All recipes use `stdin`/`env`, and the validator enforces it.
11. **Large API responses passed through `env`** (Wikipedia ≈ 300 KB) risk the OS environment size limit. → Recipe 10 trims data inside each branch.

## What is *not* covered

- Real chat delivery (Telegram/Slack/Feishu…): `openclaw message send` is stubbed in tests, and cron delivery was tested with `--no-deliver`.
- Interactive terminal prompts for approvals (tests use tool mode).
- Windows: steps use `/bin/sh`, so use WSL.
- Every LLM provider: the bridge was tested with DeepSeek and the mock. Other OpenAI-compatible APIs should work, but weren't tested.
