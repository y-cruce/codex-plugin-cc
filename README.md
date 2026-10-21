# Codex plugin for Claude Code

Use Codex from inside Claude Code for code reviews or to delegate tasks to Codex.

This plugin is for Claude Code users who want an easy way to start using Codex from the workflow
they already have.

<video src="./docs/plugin-demo.webm" controls muted playsinline autoplay></video>

## What You Get

- `/codex:review` for a normal read-only Codex review
- `/codex:adversarial-review` for a steerable challenge review
- `/codex:transfer`, `/codex:status`, `/codex:result`, `/codex:answer`, `/codex:message`, and `/codex:cancel` to hand off sessions and steer or manage background jobs
- delegation itself is driven by the [code-director](https://github.com/y-cruce/code-director) workflow: it starts a Codex task through the companion and leaves it running, while the `task-pane` mod watches every job of the session, draws its live trace and raises the events the director must act on

## Requirements

- **ChatGPT subscription (incl. Free) or OpenAI API key.**
  - Usage will contribute to your Codex usage limits. [Learn more](https://developers.openai.com/codex/pricing).
- **Node.js 18.18 or later**

## Install

Add the marketplace in Claude Code:

```bash
/plugin marketplace add y-cruce/codex-plugin-cc
```

Install the plugin:

```bash
/plugin install codex@y-cruce-codex
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

With Claude Code 2.1.299 or later, task completion, failure and pending questions use your notification channel. The task name and status in the pane are one clickable control. Sessions without a drawing surface report why the pane cannot be shown.

When entering a target for `/codex:tasks`, `/codex:tasks forget` or `/codex:message`, type part of its name or ID and press Tab to insert its ID. Message suggestions include only running tasks; answer pending questions with `/codex:answer`.

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

### Director tools

From 1.4.48, when code-director's `dispatch.sh` is installed at `~/.claude/skills/code-director/scripts/dispatch.sh`, the plugin gives the director five tools of its own: `mcp__codex__dispatch`, `mcp__codex__message`, `mcp__codex__answer`, `mcp__codex__result` and `mcp__codex__status`. They sit in the tool list from the start of the session, with no ToolSearch step. `dispatch` takes the headers as fields (`mode`, `name`, `cwd`, `brief`, and optionally `thread`, `base`, `write`, `effort`, `model`, `siblings`, `sandbox`, `executor`, `executor_mode`, `executor_effort`) and passes the brief to `dispatch.sh dispatch` on stdin. It returns the same `STATUS` / `JOB` / `NAME` / `THREAD` lines, and the tasks pane picks up the job at its next poll. `message` and `answer` write the correction or the answers map to a temporary file, run `dispatch.sh message` or `dispatch.sh answer` on it, and remove it afterwards. `result` and `status` run this plugin's own companion. A failure comes back as a tool error carrying the script's own line. Every tool runs the plugin's own `codex-companion.mjs`, not whichever version is newest in the plugin cache. The Bash route still works where the tools are absent (the skill not installed, or mods unavailable).

`dispatch.sh` 安装在上述位置时，插件为主 agent 注册 `mcp__codex__dispatch`、`message`、`answer`、`result`、`status` 五个工具，会话开始即可直接调用，不必先经过 ToolSearch。派单的各个头部字段变成结构化参数，brief 通过 stdin 交给 `dispatch.sh`，不再经过 shell 命令行；返回的内容与原来相同，任务面板在下一次轮询时显示该任务。纠正消息和答案会先写入临时文件，执行完毕后删除。所有工具都使用本插件自带的 companion。没有这些工具时，原来的 Bash 用法照常可用。

### Director channel

From 1.4.58 the plugin also ships a [channel](https://code.claude.com/docs/en/channels) MCP server, `director`. Start Claude Code with the plugin named among its channels:

```bash
claude --dangerously-load-development-channels plugin:codex@y-cruce-codex
```

This marketplace is not on the approved channels allowlist, so it needs the development flag, and Claude Code asks you to confirm it at every start. Once the startup probe confirms the route, the broker pushes questions and notes directly from their tool handlers, and job endings from the explicit job finish path. Command output and the tasks pane's replay cursor cannot delay those messages. They arrive as `<channel source="plugin:codex:director" event="question_opened" job="task-…" id="…">` messages, joining a running turn at its next step or starting one when idle. Questions include the request id, every question id, full text and option descriptions; notes include `pending_request=` when a question is open. The tool reply says “Accepted for the director”; it does not prove the director read the message.

Each Claude session has a durable outbox and shared delivery receipts under the plugin data directory. Brokers connect to the channel's socket; its ACK confirms transport only. The session consumer also watches its outbox and retries failed or unaccepted items, recovering acceptance even if the publisher dies before IPC. A slow rescan repairs missed watch notifications. The prompt.submit ingress writes the final receipt only after accepting a channel message or Monitor notification; a frame dropped after Monitor retirement or a session change stays pending for recovery. Delivery is at least once: a crash between ingress acceptance and persisting its receipt can repeat the stable id. The receipt does not prove model reading or an atomic durable enqueue inside Claude Code. Answered, closed and expired questions are persisted and excluded from replay. ACP/Qoder questions, permissions and job endings use the same publisher, using the persisted job's owner session. Producers declare push support in the jobs they own; jobs from an older broker without that declaration retain pane/Monitor fallback. A running old broker is reused without replacement. Session hooks rebind on `/clear` and `/resume`; one fenced consumer owns each session, and multiple repository brokers can use it. The pane keeps displaying progress and stops producing director lines while the channel is confirmed. Repositories with ACP jobs retain a Monitor for abrupt worker exit recovery, because that runtime runs inside the worker; normal ACP questions and endings still publish directly. Broker idle exit still works.

Until the probe returns (up to fifteen seconds), the pane holds its fallback. Without confirmation, or after the channel's heartbeat expires, the Monitor route remains available. Both routes write the same per-event receipt, so changing routes does not repeat an already reported event. Settled or accepted items are removed from the outbox while their tombstones and receipts remain. Producers push once and leave recovery to the consumer. Inactive sessions expire 30 days after their last activity; a live consumer lease always keeps its session. Retention runs at channel startup and once an hour, separately from the current-session 30-second recovery rescan. Channels work in interactive sessions only; `claude -p`, the SDK and sessions without the flag keep the Monitor route.

本 marketplace 不在官方 channel 白名单里，需要用上面的开发参数启动，每次启动都会要求确认。启动探针回到会话后，broker 会从提问和通知的工具处理函数直接推送消息，从明确的任务结束路径推送完成、失败或取消消息。命令输出和任务面板的回放进度不会阻塞它们。消息在回合进行中插到下一步，会话空闲时启动新回合。提问携带 request id、全部 question id、完整问题和选项说明；存在待答问题时，通知携带 `pending_request=`。工具返回“Accepted for the director”只说明已接受，不能证明主 agent 已阅读。

每个 Claude 会话在插件数据目录中保存持久 outbox 和统一的投递记录。broker 主动连接 channel socket，ACK 仅确认传输。会话消费者还会监听 outbox 并重试发送失败或未被接受的事件，发布者在 IPC 前退出也能恢复；低频重扫只修复遗漏的文件通知。prompt.submit ingress 接受 channel 消息或 Monitor 通知后才保存最终投递记录，被退休 Monitor 或会话校验丢弃的帧保留待恢复。交付保证为至少一次：ingress 接受后、保存记录前崩溃，可能重复同一 id；记录不能证明模型已阅读或 Claude 内部已原子完成持久入队。已回答、关闭和过期的问题会持久记录并排除回放。ACP/Qoder 的提问、权限请求和任务结束也共用 publisher，owner session 从持久化的 job 读取。producer 在自己拥有的 job 上声明 push 能力；旧 broker 没有声明时保留 pane/Monitor fallback，继续复用正在运行的 broker。独立 hook 在 `/clear`、`/resume` 时重新绑定会话，每个会话由一个带实例校验的消费者处理，同一会话可连接多个仓库的 broker。面板继续显示任务，channel 确认后停止生成主 agent 消息。含 ACP 任务的仓库保留 Monitor 检测 worker 的异常退出，因为该 runtime 与 worker 同进程；正常 ACP 提问和结束仍直接发布。broker 仍按原条件空闲退出。

探针等待期间（最多 15 秒）面板暂缓 fallback。未确认 channel 或心跳过期时使用 Monitor；两条路径共用逐事件投递记录，切换时不会重新报告已有记录的事件。已接受或已结束的事件移出 outbox，保留 receipt 和 tombstone。producer 只直接推送一次，恢复由消费者负责。inactive session 在最后活动 30 天后清理，有活跃 consumer lease 的会话始终保留；清理在 channel 启动时及每小时执行，与当前会话的 30 秒恢复重扫分开。channel 只在交互模式下生效，`-p`、SDK 和未带参数启动的会话继续使用 Monitor。


### Parallel worktrees

The director prepares a separate worktree for each writer and passes it as the task's `CWD`. With code-director installed:

```bash
bash ~/.claude/skills/code-director/scripts/dispatch.sh worktree /abs/source-repo /abs/new-worktree worker/topic
```

The plugin's `scripts/worktree.mjs <source-repo> <new-directory> <new-branch>` registers the worktree with Git, pins source HEAD, and clones unchanged tracked files. macOS uses native `clonefile` through Python 3 batches; other platforms use `COPYFILE_FICLONE_FORCE`. Unsupported cloning falls back to ordinary copies and reports separate `clonedFiles`, `copiedFiles` and `checkoutFiles` counts. Source edits and missing files come from the pinned Git commit. Untracked or ignored dependencies, outputs and session data are excluded. Keep the source stable during creation; a verification failure retains the incomplete tree for inspection.

From 1.4.45, nested submodules are initialized at their parent's recorded commits, with private Git directories, indexes and objects. Available source submodules provide local clones; otherwise Git uses their configured URLs and normal network permissions. Missing pinned commits are fetched from the configured URL even when the source is initialized. Git's initial object hard links are replaced by independent copy-on-write files where available, or ordinary copies, counted separately as `clonedObjectFiles` / `copiedObjectFiles`; no hard links or alternates remain on success. The `submodules` receipt lists each path, commit, local/remote source and `fetchedFromRemote`. Normal submodule initialization may add registrations to the main repository's shared config. Failed clones remain for inspection. A `.gitmodules` file without gitlink entries does not block creation.

Executors stay in their assigned directory and check symlinks and absolute paths before builds. Writable dependencies and outputs belong to that directory; do not share them through hard links or symlinks. Commit submodule edits before updating the parent gitlink. After stopping tasks and integrating commits, the director uses `dispatch.sh worktree remove <source-repo> <worktree>` (or `node scripts/worktree.mjs remove ...`). Removal checks every repository for uncommitted, untracked and ignored files, and refuses to discard submodule commits outside its recorded initial refs and remote-tracking refs. Git's force flag for initialized submodules is used only after those checks. The parent branch is kept. Hiding a pane row does not remove its tree; keep the original directory while its thread needs further turns.

主 agent 为每个写入者准备独立 worktree，并通过任务的 `CWD` 分配。上述入口先由 Git 登记工作树，再克隆未修改的跟踪文件；macOS 上需要 Python 3 调用 APFS 原生接口，不支持时明确报告普通复制数量。源目录已有修改与缺失文件从固定的 HEAD 提交检出，未跟踪或忽略的依赖、产物和会话数据不复制。支持嵌套子模块，每个子模块固定到父仓记录的提交，并拥有独立 Git 目录、索引和对象库；优先使用本地源子模块，否则按配置 URL 克隆，需要正常的网络和权限。对象文件克隆数单独报告，`submodules` 回执列出路径、提交和来源。初始化可能补全主仓共享配置中的子模块登记；失败时保留目录供检查，不因存在 `.gitmodules` 文件就拒绝创建。

Executor 只在分配目录工作，构建前检查符号链接和绝对路径，可写依赖和产物分别维护；先提交子模块修改，再更新主仓 gitlink。主 agent 停止任务并集成提交后，通过 `dispatch.sh worktree remove <source-repo> <worktree>` 回收目录。入口检查各仓库的未提交、未跟踪、忽略文件及不在初始引用和远端跟踪引用中的子模块新增提交，发现需要保留的数据即拒绝删除；检查通过后才使用 Git 对已初始化子模块要求的 force 参数。主仓分支保留，线程仍需续接时保留原目录，面板隐藏不会回收目录。

### `/codex:review`

Runs a normal Codex review on your current work. It gives you the same quality of code review as running `/review` inside Codex directly.

> [!NOTE]
> Code review especially for multi-file changes might take a while. It's generally recommended to run it in the background.

Use it when you want:

- a review of your current uncommitted changes
- a review of your branch compared to a base branch like `main`

Use `--base <ref>` for branch review. It also supports `--wait` and `--background`. It is not steerable and does not take custom focus text. Use [`/codex:adversarial-review`](#codexadversarial-review) when you want to challenge a specific decision or risk area.

Both review commands run read-only by default; `--sandbox <read-only|workspace-write|danger-full-access>` widens that so Codex can build or run tests while verifying findings. Each review keeps its Codex thread, so `task --thread <id>` can follow up on the findings in the same context, and its full output is also written next to the job record as `<job-id>.review.md` (the path is the job's `reportFile` and is appended to monitor `DONE` lines as `report=<path>`).

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

### `/codex:tasks`

Opens or closes the tasks pane for this session. Select a task by its row number
or a case-insensitive part of its name. Live rows are reconciled with job files
and live views on each poll.

The pane leaves two columns of space on the right, shows the director's delivered
answers after the questions, and displays durations in whole seconds.

面板右侧保留两个字符的空白；提问后显示主 agent 送达的回复内容，耗时显示到整秒。

Commands with a nonzero exit code show `exit N`. The pane and inline traces
omit command output and output preview controls.

命令非零退出时显示 `exit N`；面板与内联轨迹均不展示命令输出及输出预览入口。

The pane and inline traces use the same block layout for `◆ ↓ Director reply`,
`◆ ↓ Director message`, `◆ ↓ Director interrupt` and `◇ ↑ Executor notification`.
Headings align on the left and bodies indent two columns. All four use cyan for both
headings and bodies, including completed notification cards. Messages retain
their complete text and wrap in traces.
Completed, failed and cancelled tasks stay in the pane for three minutes after ending.
Completed Markdown tables use bordered columns with wrapping cells, or labelled
rows when the viewport is too narrow. Cell formatting and links use native Markdown.
While Codex compacts its context, the trace, task list and status hint show
`正在压缩上下文` with elapsed time in the trace and hint. The state clears when
compaction completes or the turn or task ends.

面板与内联轨迹用统一块式布局显示 `◆ ↓ Director reply`、`◆ ↓ Director message`、
`◆ ↓ Director interrupt` 和 `◇ ↑ Executor notification`。英文标题左对齐，正文统一缩进两列；
四类的标题与正文统一使用青色，已结束的通知卡片也使用同一样式。
消息保留完整正文，在轨迹中换行显示。
已完成、失败和取消的任务在结束后保留三分钟，再从面板隐藏。
完整 Markdown 表格显示为带边框且单元格换行的分列布局；窗口过窄时按列名逐条展示。
单元格内的格式和链接继续使用宿主 Markdown 渲染。
Codex 压缩上下文期间，轨迹、任务列表和状态提示显示 `正在压缩上下文`，轨迹与提示同时显示耗时。
压缩完成或本轮、任务结束后清除该状态。

```text
/codex:tasks
/codex:tasks 2
/codex:tasks refresh
/codex:tasks forget 2
/codex:tasks forget batch 74
```

`refresh` clears the pane's cache and rebuilds the list from disk. `forget` hides
the matching row without changing job data. It stays hidden until refresh or a
new session.

A shell in the same session reaches the pane with
`node scripts/codex-companion.mjs pane [list|refresh|forget <n|name|task id>]`.
`list` prints each row's status in the pane next to its job file's status on
disk and marks the rows that disagree `STALE`. The pane answers after its next
poll, within a few seconds.

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

`events --session <id>` saves the first snapshot's already finished jobs as a
historical baseline, even when it emits no notification. It keeps that baseline
and terminal output receipts across restarts in the repository's state directory.
A replacement Monitor reports later completions, failures and cancellations from
that session, including jobs finished between watches, and skips historical and
already reported terminals. Existing 1.4.35 receipt files keep their deduplication
state. The pane also re-arms repositories with recently finished tasks so the last
task's completion is caught. Watches without `--session` continue to report only
jobs they observed active.

`events --session <id>` 首次读取任务状态时，把已结束任务保存为历史基线，即使没有通知输出也保存；基线和后续已输出终态的记录在仓库状态目录跨重启保留。监听重挂时补报当前会话在基线之后完成、失败或取消的任务，包括监听空档内结束的任务，跳过历史和已报告终态。已有 1.4.35 回执继续去重。pane 对近期已结束任务所在的仓库也会重挂监听。未指定会话的监听继续只报告自己见过运行中的任务。

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
