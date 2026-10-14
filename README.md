# 🦞 OpenClaw Cookbook

**English** · [简体中文](README.zh-CN.md)

**10 practical, tested [OpenClaw](https://openclaw.ai) workflows you can run today, from a 3-step "hello world" to AI triage with human approval.** Each recipe is a ready-to-use [Lobster](https://docs.openclaw.ai/tools/lobster) workflow file (`workflow.json`) with a step-by-step guide, real example output and ideas for taking it further.

[![Validate workflows](https://github.com/YalinMa/openclaw-cookbook/actions/workflows/validate.yml/badge.svg)](https://github.com/YalinMa/openclaw-cookbook/actions/workflows/validate.yml)
![OpenClaw](https://img.shields.io/badge/OpenClaw-%E2%89%A5%202026.10.1-E8473C)
![License: MIT](https://img.shields.io/badge/license-MIT-blue)

> **New to OpenClaw?** OpenClaw is a personal AI assistant that runs on your machine and talks to you through your chat apps. **Lobster** is its workflow engine: you describe a job as a list of steps, the agent runs it with **one** tool call, and the workflow pauses to ask you before doing anything important. Start with **[Getting Started](docs/getting-started.md)**, then read **[Core Concepts](docs/core-concepts.md)**.

## Recipes

| # | Recipe | Real-world use | You'll learn | Needs | Level |
|---|---|---|---|---|---|
| 01 | [**Hello Lobster**](examples/01-hello-lobster/) | Your first workflow | args, steps, `stdin`/`env`, `$step.json` | — | ⭐ |
| 02 | [**Daily Weather Briefing**](examples/02-daily-weather-briefing/) | Morning message in your chat | HTTP + `retry`, `openclaw message send`, cron | — | ⭐ |
| 03 | [**Website Uptime Monitor**](examples/03-website-uptime-monitor/) | Get pinged when your site goes down / comes back | `for_each`, `diff.last`, `when` | — | ⭐⭐ |
| 04 | [**GitHub Release Watcher**](examples/04-github-release-watcher/) | Know when tools you use ship a new version | `state.get`/`state.set`, first-run baseline | — | ⭐⭐ |
| 05 | [**AI News Digest**](examples/05-ai-news-digest/) | A personal Hacker News digest | `llm.invoke`, JSON schemas, "LLM decides, code formats" | LLM | ⭐⭐ |
| 06 | [**AI Support Ticket Triage**](examples/06-ai-support-ticket-triage/) | Classify tickets, draft replies, save only after approval | LLM per item, enums, **approval gates** | LLM | ⭐⭐⭐ |
| 07 | [**Safe File Cleanup**](examples/07-safe-file-cleanup/) | Tidy Downloads, reversibly | comparisons, branching, undo script | — | ⭐⭐ |
| 08 | [**Meeting Notes → Action Items**](examples/08-meeting-notes-to-action-items/) | Notes in, checklist out, you choose what stays | extraction, **input steps** | LLM | ⭐⭐⭐ |
| 09 | [**Webhook Lead Capture**](examples/09-webhook-lead-capture/) | Website form → validated CSV + team ping | **OpenClaw webhooks**, validation, CSV | — | ⭐⭐ |
| 10 | [**Morning Brief**](examples/10-morning-brief/) | Weather + news + rates + "on this day", written by AI | **`parallel`**, **sub-workflows** | LLM | ⭐⭐⭐ |

**6 of 10 recipes need no account or API key.** The AI recipes work with OpenClaw's own model, any OpenAI-compatible API (DeepSeek, OpenAI, Qwen, Ollama…) through the [bundled bridge](scripts/llm-adapter.mjs), or a free offline mock.

## Quick start

```bash
git clone https://github.com/YalinMa/openclaw-cookbook.git ~/openclaw-cookbook
```

```bash
cd ~/openclaw-cookbook && npm install
```

```bash
npx lobster run examples/01-hello-lobster/workflow.json
```

**In OpenClaw** (after `openclaw plugins install @openclaw/lobster`, see [Getting Started](docs/getting-started.md#2-install-the-lobster-plugin)), just ask in chat:

> Run the Lobster workflow `~/openclaw-cookbook/examples/02-daily-weather-briefing/workflow.json` with argsJson `{"city":"Shanghai","latitude":"31.23","longitude":"121.47"}`.

Then make it a daily habit:

```bash
openclaw cron add --name "Weather" --cron "30 7 * * *" --session isolated \
  --message "Run the Lobster workflow ~/openclaw-cookbook/examples/02-daily-weather-briefing/workflow.json and reply with its output." \
  --announce --channel telegram --to "<your chat id>"
```

## Suggested learning path

```mermaid
flowchart LR
  01[01 Hello] --> 02[02 APIs + cron] --> 03[03 Loops + memory] --> 04[04 State]
  04 --> 05[05 First LLM step] --> 06[06 Approvals] --> 07[07 Branching]
  07 --> 08[08 Input steps] --> 09[09 Webhooks] --> 10[10 Parallel + sub-workflows]
```

| I want to… | Recipes |
|---|---|
| Get a message on a schedule | 02, 04, 05, 10 |
| Monitor something and alert on change | 03, 04 |
| Use AI safely (draft → human approves → act) | 06, 07, 08 |
| React to events from other systems | 09 |
| Learn every Lobster feature | 01 → 10 in order |

## What's in each recipe

```
examples/NN-recipe-name/
├── README.md         # what it does, how to run it (terminal + chat), real output, step-by-step explanation, ideas, troubleshooting
├── README.zh-CN.md   # the same in Simplified Chinese
└── workflow.json     # the Lobster workflow: run it with OpenClaw or `npx lobster`
```

Recipes 06 and 08 include sample data (`tickets.json`, `notes.md`).

## Repository layout

```
openclaw-cookbook/
├── README.md / README.zh-CN.md
├── docs/
│   ├── getting-started.md   # install the plugin, connect an LLM, run in chat, schedule
│   ├── core-concepts.md     # the 10 ideas behind every recipe
│   ├── cheatsheet.md        # step fields, references, commands
│   └── validation.md        # how everything is tested + what testing found
├── examples/                # the 10 recipes
├── scripts/
│   ├── validate.mjs         # static checks (no dependencies)
│   ├── test-recipes.mjs     # runs every recipe end to end
│   ├── llm-adapter.mjs      # LLM bridge: any OpenAI-compatible API, or --mock
│   └── test-bin/openclaw    # stub used by tests instead of sending real messages
└── .github/workflows/validate.yml
```

## Validation

- **Static checks** (`npm run validate`): structure, references, declared args, no secrets, and a safety rule: **no data spliced into shell commands**. Runs in CI.
- **End-to-end** (`npm test`): all 10 recipes run on the real Lobster runtime against live public APIs, with approvals and inputs resumed. **20/20 tests pass** on every Lobster engine shipped with OpenClaw since 2026.5.28.
- **Inside OpenClaw**: recipes were run by a real OpenClaw agent: from chat, with approval and input in follow-up messages, as a cron job, and from a webhook, on OpenClaw 2026.6.11 and 2026.10.3.

Testing for real found 11 issues that reading the docs would have missed (plugin version mismatches, a model mistyping resume tokens, webhook template quirks…). See **[docs/validation.md](docs/validation.md)**.

## Contributing

New recipes, fixes and translations are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE). Use these workflows however you like, including commercially.

*OpenClaw and Lobster are projects of their respective authors. This is an independent community cookbook.*
