# Codex plugin for Claude Code

Use Codex from inside Claude Code for code reviews or to delegate tasks to Codex.

This plugin is for Claude Code users who want an easy way to start using Codex from the workflow
they already have.

<video src="./docs/plugin-demo.webm" controls muted playsinline autoplay></video>

## What You Get

- `/codex:review` for a normal read-only Codex review
- `/codex:adversarial-review` for a steerable challenge review
- `/codex:transfer`, `/codex:status`, `/codex:result`, `/codex:answer`, `/codex:message`, and `/codex:cancel` to hand off sessions and steer or manage background jobs
- delegation itself is driven by the [codex-director](https://github.com/y-cruce/codex-director) workflow: it starts a Codex task through the companion and leaves it running, while the `task-pane` mod watches every job of the session, draws its live trace and raises the events the director must act on

## Requirements

- **ChatGPT subscription (incl. Free) or OpenAI API key.**
  - Usage will contribute to your Codex usage limits. [Learn more](https://developers.openai.com/codex/pricing).
- **Node.js 18.18 or later**

## Install

Add the marketplace in Claude Code:

```bash
/plugin marketplace add openai/codex-plugin-cc
```

Install the plugin:

```bash
/plugin install codex@openai-codex
```

Reload plugins:

```bash
/reload-plugins
```

Then run:

```bash
/codex:setup
```

`/codex:setup` will tell you whether Codex is ready. If Codex is missing and npm is available, it can offer to install Codex for you.

If you prefer to install Codex yourself, use:

```bash
npm install -g @openai/codex
```

If Codex is installed but not logged in yet, run:

```bash
!codex login
```

After install, you should see the slash commands listed below.

One simple first run is:

```bash
/codex:review --background
/codex:status
/codex:result
```

## Usage

### Live task input

Use the job ID from `/codex:status` to control an already running task:

```text
/codex:message <job-id> Use the latest plan from the plan center, not the stored chargeId.
/codex:message <job-id> --interrupt Stop this approach and inspect the new requirement first.
/codex:status <job-id> --wait
/codex:answer <job-id> --request-id <id> --answers-file /absolute/path/answers.json
```

`message` uses native `turn/steer`: inputs stay ordered and are consumed before a later model request, not necessarily before tools already issued by the model. The acknowledgement means accepted, not executed. `--interrupt` cancels the current turn and starts a new turn in the same job and thread with the new input and the original write permission. Existing changes remain; its report includes observed file changes and the workspace's Git status, including pre-existing edits.

`status <job-id>` shows pending messages, questions, and interruption state. Messages leave the pending list when their user-message event is observed; this confirms entry into thread history, not model execution. `status --wait` returns early for questions. Answer files contain an answers map such as `{"source":{"answers":["Use the latest plan."]}}`. Answers must match the pending request and question IDs. Questions time out after 10 minutes and interrupt the turn; the plugin does not fabricate an answer or auto-approve permissions. After answering, wait on the same job again and collect `/codex:result <job-id>`.

Tasks require the shared broker; live commands never start a second runtime or silently create another thread. The broker enables `default_mode_request_user_input` for its Codex process without editing global configuration. Existing sessions must restart to load an updated broker. `task --thread <id> --write` applies workspace-write on `turn/start`; omitting `--write` explicitly restores read-only. Native `thread/queue/*` (follow-up turns after completion) is separate and is not exposed by these mid-turn controls.

Run `npm test` and `npm run build` for local checks. The optional `CODEX_REAL_APP_SERVER_TEST=1 node --test tests/real-app-server.test.mjs` uses an installed Codex CLI with isolated temporary configuration and a local mock model, including actual file writing and syntax validation. It does not contact a real model service.

### `/codex:review`

Runs a normal Codex review on your current work. It gives you the same quality of code review as running `/review` inside Codex directly.

> [!NOTE]
> Code review especially for multi-file changes might take a while. It's generally recommended to run it in the background.

Use it when you want:

- a review of your current uncommitted changes
- a review of your branch compared to a base branch like `main`

Use `--base <ref>` for branch review. It also supports `--wait` and `--background`. It is not steerable and does not take custom focus text. Use [`/codex:adversarial-review`](#codexadversarial-review) when you want to challenge a specific decision or risk area.

Examples:

```bash
/codex:review
/codex:review --base main
/codex:review --background
```

This command is read-only and will not perform any changes. When run in the background you can use [`/codex:status`](#codexstatus) to check on the progress and [`/codex:cancel`](#codexcancel) to cancel the ongoing task.

### `/codex:adversarial-review`

Runs a **steerable** review that questions the chosen implementation and design.

It can be used to pressure-test assumptions, tradeoffs, failure modes, and whether a different approach would have been safer or simpler.

It uses the same review target selection as `/codex:review`, including `--base <ref>` for branch review.
It also supports `--wait` and `--background`. Unlike `/codex:review`, it can take extra focus text after the flags.

Use it when you want:

- a review before shipping that challenges the direction, not just the code details
- review focused on design choices, tradeoffs, hidden assumptions, and alternative approaches
- pressure-testing around specific risk areas like auth, data loss, rollback, race conditions, or reliability

Examples:

```bash
/codex:adversarial-review
/codex:adversarial-review --base main challenge whether this was the right caching and retry design
/codex:adversarial-review --background look for race conditions and question the chosen approach
```

This command is read-only. It does not fix code.

### `/codex:transfer`

Creates a persistent Codex thread from the current Claude Code session and prints a `codex resume <session-id>` command.

Use it when you started a debugging or implementation conversation in Claude Code and want to continue that same context directly in Codex.

Examples:

```bash
/codex:transfer
/codex:transfer --source ~/.claude/projects/-Users-me-repo/<session-id>.jsonl
```

The plugin's existing `SessionStart` hook supplies the current transcript path automatically; `--source` is available as a manual override. The transfer uses Codex's external-agent session importer, so it follows the same conversion rules as importing Claude history in the Codex App and creates visible turns that can be continued in the App or TUI. The source must be under `~/.claude/projects`, and older Codex versions that do not expose session import must be upgraded before using this command.

### `/codex:status`

Shows running and recent Codex jobs for the current repository.

Examples:

```bash
/codex:status
/codex:status task-abc123
```

Use it to:

- check progress on background work
- see the latest completed job
- confirm whether a task is still running

### `/codex:result`

Shows the final stored Codex output for a finished job.
When available, it also includes the Codex session ID so you can reopen that run directly in Codex with `codex resume <session-id>`.

Examples:

```bash
/codex:result
/codex:result task-abc123
```

### `/codex:cancel`

Cancels an active background Codex job.

Examples:

```bash
/codex:cancel
/codex:cancel task-abc123
```

### `/codex:setup`

Checks whether Codex is installed and authenticated.
If Codex is missing and npm is available, it can offer to install Codex for you.

You can also use `/codex:setup` to manage the optional review gate.

#### Enabling review gate

```bash
/codex:setup --enable-review-gate
/codex:setup --disable-review-gate
```

When the review gate is enabled, the plugin uses a `Stop` hook to run a targeted Codex review based on Claude's response. If that review finds issues, the stop is blocked so Claude can address them first.

> [!WARNING]
> The review gate can create a long-running Claude/Codex loop and may drain usage limits quickly. Only enable it when you plan to actively monitor the session.

## Typical Flows

### Review Before Shipping

```bash
/codex:review
```

### Start Something Long-Running

```bash
/codex:adversarial-review --background
```

Then check in with:

```bash
/codex:status
/codex:result
```

## Codex Integration

### Live task history / 实时任务轨迹

The companion records complete app-server event payloads, including text deltas, even without a viewer. Each job has its own durable cursor and atomic `live-view.json` projection. Existing `status`, `result`, `events`, and job logs retain their interfaces.

Observation reads first use the current state directory, then discover the same repository key under `$CLAUDE_CONFIG_DIR/plugins/data/*/state` (default `~/.claude`) and the temporary companion directory. If multiple fallback roots contain a job, the newest job JSON wins. Without `CLAUDE_PLUGIN_DATA`, `observe list` merges these roots. Execution writes keep their existing location.

observe 读取优先使用当前状态目录；找不到任务时，回退查找 Claude 插件数据目录及临时目录下相同 repo-key，并按 job JSON 的修改时间选最新副本。未注入 `CLAUDE_PLUGIN_DATA` 时，list 合并这些目录；写入位置保持不变。

```bash
node plugins/codex/scripts/codex-companion.mjs observe list --cwd /path/to/repo --json
node plugins/codex/scripts/codex-companion.mjs observe follow JOB --cwd /path/to/repo --max-seconds 540
node plugins/codex/scripts/codex-companion.mjs observe follow JOB --cwd /path/to/repo --after CURSOR --until done
node plugins/codex/scripts/codex-companion.mjs observe replay JOB --cwd /path/to/repo --limit 200 --jsonl
node plugins/codex/scripts/codex-companion.mjs observe view-path JOB --cwd /path/to/repo
```

`follow` prints compact item events; `--verbose` includes deltas. It emits `CURSOR:` before DONE, FAILED, QUESTION, NOTIFIED, STALLED, or TIMEOUT. `--until done` keeps following through notifications. Closing the process closes its subscription; it does not interrupt the Codex task. Completed histories remain readable after the broker exits. Old brokers return `OBSERVATION_UNSUPPORTED` and are never replaced to enable observation.

`QUESTION job=<id> request=<id> ...` is emitted only while that request remains pending. If the same request is encountered again while still pending, `follow` and `events` emit `QUESTION_PENDING job=<id> request=<id> still unanswered: ...` (periodic `events` reminders retain their elapsed-time format). Answered requests are skipped. `NOTIFIED job=<id> thread=<id> pending_request=<id> <note>` includes the request pending when the notification was created; the field is omitted when there was none. Explicit `--after` cursors continue to select their exact history position.

Use `--quiet` for relay agents: only the cursor and terminal line are emitted, with a one-line heartbeat every 60 seconds while waiting. DONE does not include result text in this mode; read it separately with `result`. Default display hides token updates, user-message echoes and empty reasoning, and bounds command output previews to 120 characters and assistant rows to 300. Full event payloads and `lastMessage.text` remain unchanged; `--verbose` retains full output.

The live view unwraps recognized `zsh/bash/sh -lc/-c` command wrappers for active commands and tail rows. Completed command rows carry `exitCode` and `durationMs` instead of embedding the exit code in text. Pending questions include ISO `openedAt` and `expiresAt` (the broker's actual deadline, or the shared ten-minute default when absent). Turn lifecycle lines remain in follow output but not in the tail. Raw event payloads are unchanged.

live-view 的活动命令和 tail 会剥除可识别的 shell 包装，无法可靠解析时保留原文；命令完成行通过 exitCode/durationMs 字段提供退出码与耗时，不再拼进 tail 文本。待答问题新增 openedAt/expiresAt 时间字段，turn 起止只在 follow 中展示，不占 tail 行。原始事件 payload 不变。

Native subagent activity binds the child thread to the same job, including notifications buffered before its identity arrived. Child events retain `derived.agent` and render with `[agent-name]` prefixes; tail rows also expose `agent`. The optional `subAgents` projection lists thread ID, short path, activity status and lifecycle timestamps. Child messages and questions do not replace the parent task's current message, question or status. Ownership is retained after child completion/interruption to capture late notifications.

原生子 agent 的 started/interacted/interrupted/completed 活动均会建立同一 job 归属并回放缓冲通知；子线程事件以 derived.agent 标识来源，tail/follow 显示名称前缀。live-view 的可选 subAgents 字段记录生命周期，子线程内容不覆盖父线程的 lastMessage、待答问题或状态；完成后保留归属以记录迟到通知。

事件全程保存，不依赖观察者。`follow` 适用于原生后台 agent 的阻塞 Bash 行；默认展示命令、消息预览、非空推理摘要、文件改动和调度者控制消息，`--verbose` 保留完整展示并输出 delta。`--quiet` 仅输出游标和终结行，等待时每60秒一行心跳，DONE 后不附结果；主线程另用 result 读取。默认命令输出预览最多120字符，assistant行最多300字符，完整事件与 lastMessage.text 不截断。`--max-seconds 540` 可在 Bash 时限前输出游标，下一次用 `--after` 续跟。`view-path` 返回 mod 可直接读取的原子投影文件，最多每秒更新五次，终态额外刷新。

Writes are batched at 50 ms or 256 KiB and become visible only after durable commit. Histories rotate at 64 MiB, retain up to 1 GiB per job, and keep completed jobs for 30 days within a 20 GiB total budget. Retention removes oldest segments/jobs, never truncates individual payloads; expired cursors return `CURSOR_EXPIRED` and `earliestAvailableCursor`. Crashes or retention are marked as partial history. Legacy jobs do not acquire invented event history.

写入以 50ms/256KiB 批量提交，公开游标只指向已持久化的数据。异常退出可能丢失尚未提交的批次，上游未提供重放的通知也无法补造。保留策略为单任务 1GiB、64MiB 分段、已结束任务 30 天、总量 20GiB；超限清理最旧历史并明确标记缺口。`job.log` 继续作为兼容文本日志，新增消费者不应解析它。

The Codex plugin wraps the [Codex app server](https://developers.openai.com/codex/app-server). It uses the global `codex` binary installed in your environment and [applies the same configuration](https://developers.openai.com/codex/config-basic).

### Common Configurations

If you want to change the default reasoning effort or the default model that gets used by the plugin, you can define that inside your user-level or project-level `config.toml`. For example to always use `gpt-5.4-mini` on `high` for a specific project you can add the following to a `.codex/config.toml` file at the root of the directory you started Claude in:

```toml
model = "gpt-5.4-mini"
model_reasoning_effort = "high"
```

Your configuration will be picked up based on:

- user-level config in `~/.codex/config.toml`
- project-level overrides in `.codex/config.toml`
- project-level overrides only load when the [project is trusted](https://developers.openai.com/codex/config-advanced#project-config-files-codexconfigtoml)

Check out the Codex docs for more [configuration options](https://developers.openai.com/codex/config-reference).

### Moving The Work Over To Codex

Delegated tasks and any [stop gate](#what-does-the-review-gate-do) run can also be directly resumed inside Codex by running `codex resume` either with the specific session ID you received from running `/codex:result` or `/codex:status` or by selecting it from the list.

This way you can review the Codex work or continue the work there.

## FAQ

### Do I need a separate Codex account for this plugin?

If you are already signed into Codex on this machine, that account should work immediately here too. This plugin uses your local Codex CLI authentication.

If you only use Claude Code today and have not used Codex yet, you will also need to sign in to Codex with either a ChatGPT account or an API key. [Codex is available with your ChatGPT subscription](https://developers.openai.com/codex/pricing/), and [`codex login`](https://developers.openai.com/codex/cli/reference/#codex-login) supports both ChatGPT and API key sign-in. Run `/codex:setup` to check whether Codex is ready, and use `!codex login` if it is not.

### Does the plugin use a separate Codex runtime?

No. This plugin delegates through your local [Codex CLI](https://developers.openai.com/codex/cli/) and [Codex app server](https://developers.openai.com/codex/app-server/) on the same machine.

That means:

- it uses the same Codex install you would use directly
- it uses the same local authentication state
- it uses the same repository checkout and machine-local environment

### Will it use the same Codex config I already have?

Yes. If you already use Codex, the plugin picks up the same [configuration](#common-configurations).

### Can I keep using my current API key or base URL setup?

Yes. Because the plugin uses your local Codex CLI, your existing sign-in method and config still apply.

If you need to point the built-in OpenAI provider at a different endpoint, set `openai_base_url` in your [Codex config](https://developers.openai.com/codex/config-advanced/#config-and-state-locations).
