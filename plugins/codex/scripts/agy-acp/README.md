# agy CLI ACP

The CLI can return `end_turn` while a background command is running. In a
direct stdio probe, agy 1.5.14 pushed the command's terminal update 13.47
seconds after `end_turn` and streamed its own reply 3.31 seconds later. The
client sent one prompt and kept the same connection open throughout.

Dispatch uses the installed `agy acp` server (verified with 1.5.6). It reuses
the CLI login, settings and MCP configuration. No separate ACP installation,
helper executable, client-name override or harness proxy is needed.

The preset prefers `~/.local/bin/agy` to avoid terminal wrappers, then searches
PATH. `EXECUTOR_COMMAND` / `CODEX_DIRECTOR_ANTIGRAVITY_COMMAND` override the
binary; `EXECUTOR_ARGS` defaults to `["acp"]`.

```sh
node plugins/codex/scripts/codex-companion.mjs task \
  --executor acp --executor-command "$HOME/.local/bin/agy" \
  --executor-args '["acp"]' --executor-permissions allow-once \
  --json "Inspect the project"
```

New sessions default to `gemini-pro-orchestrator-neon`, which exposes no thinking
level. Other explicit models default to high thinking, Opus to medium; explicit model/effort options take priority. The
server exposes effort as `thought_level`. Continued sessions retain their
existing settings unless explicitly overridden.

agy asks native questions through `elicitation/create`, since the driver
advertises form elicitation. Each question `qN` is a string field whose `oneOf`
lists the options, paired with an optional free-text field `qN_other`. agy
drops a choice whose `const` it does not recognize, so the driver sends the
value of the option the director names by label. The director puts its note in
`qN_other`, and agy hands the model both as `A1: <option>, <note>`.

Running corrections use another `session/prompt` on the same session. The
server settles the previous prompt when steering arrives; the driver waits
for the newest response before completing the original job and turn. Sending
a message confirms submission, without a separate model-consumption receipt.
Queue, interrupt, cancel and continue retain the usual director controls.

Steering works while agy's prompt is active, including while commands run.
When agy returns `end_turn` with unfinished commands or a pending `schedule`,
the job stays running and keeps receiving ACP updates. For a command wait,
the driver tracks new tools as agy continues. It infers completion when
all tools have reached terminal status, agy has answered after the latest
work, and the session has sent no update for 25 seconds. If agy shows no
sign of resuming after the commands finish and that quiet period passes,
the driver sends a continuation prompt in the same turn. Progress and
the final reply are separate messages.

For a pending command, `session/load` checks its status after 60 seconds
without a session update. This interval keeps history loads infrequent.
In an active session, agy 1.5.14 was observed restarting its update stream
on each load and timing out while waiting for the history stream. The
driver filters replay to known command IDs during the load and the
existing 2-second quiet window that follows it.

For a scheduled follow-up, the driver collects native updates in the same
job and turn. It defers command snapshots during the native follow-up to
keep replay separate from live output.
Command-only waits share a cumulative 30-minute limit. A scheduled follow-up
times out after 30 minutes without a live session event once all pending
timers have reached their deadlines. A timer's deadline is its tool start
time plus `DurationSeconds`. A timeout reports the outstanding tools.
During the wait, use queue, interrupt, or cancel. Commands marked
`IsDaemon: true` are excluded from the wait.

Direct stdio probes with `agy acp` 1.5.12 observed a one-shot `schedule` remain
`in_progress` past the original prompt's `end_turn`. At the requested time the
CLI pushed a `completed` tool update, then ran the scheduled prompt and streamed
its output without a new `session/prompt`. Closing stdio before the timer fired
exited the process. Loading the same session in a new process after the deadline
replayed the first reply and the completed tool row, with no scheduled reply.
An explicit `session/cancel` before the deadline also stopped the follow-up.

The native follow-up sends no second `end_turn`. A two-read probe saw
`usage_update` before the first tool call, between tool calls, and after the
final answer. The driver therefore infers completion from assistant text after
the latest scheduled work, terminal tool statuses, and 25 seconds without a
new ACP update. The longest observed gap from timer completion to a live
follow-up update was 20.8 seconds. Each live update restarts the quiet period.

This is recovery from the observed premature response, not a guarantee that
every native agent task finishes correctly. A three-run comparison per model
found no improvement from adding a wait instruction to dispatch: Carbon high
was 0/3 early before and after; Opus medium was 1/3 before and 2/3 after. That
instruction is therefore not included in the preset.

The subprocess inherits the companion's network environment. This machine's
tested environment uses `HTTP_PROXY` / `HTTPS_PROXY` at `127.0.0.1:20809`;
the former launcher's fixed mihomo port `7890` is not required. The plugin
does not choose a machine-specific proxy.

The CLI reads `~/.gemini/config/mcp_config.json`, including `serverUrl` HTTP
entries, itself. The former alias conversion and generated workflow skill
exclusion are no longer needed. Linked skill directories and HOME remain in
the file-tool scope; an appended system prompt names the task directory for
shell commands.

For rollback, revert the plugin and director migration commits together. This
restores the previous proxy files and the `agy_acp_server.par` preset. The
existing `~/.local/share/antigravity-acp/1.4.4/` installation remains available
for old jobs. On this machine, `launch.sh` runs the standalone copies of both
proxy scripts and `ws` under its `compat-proxy/` directory, so deleting the
checkout proxies does not break recorded launch commands. The original
launcher is backed up as `launch.sh.before-standalone-proxy-20261112`.
Existing jobs keep their recorded command and arguments; continue uses those
instead of the new preset.

派单使用 CLI 自带的 `agy acp`，复用现有登录和 MCP 配置。默认 gemini-pro-orchestrator-neon（没有思考强度选项），
显式选其他模型默认 high，Opus 默认 medium；显式 model/effort 优先。运行中纠偏使用同一会话的
新 prompt，等待最新响应后结束原任务。提前 `end_turn` 时，原任务继续等待
后台命令或 `schedule`。后台命令依靠实时更新追踪，60 秒无更新才读取状态快照，
累计等待上限为 30 分钟。工具结束后若收到 agy 自唤醒的回复，驱动在 25 秒静默后完成任务。
工具结束后若静默 25 秒且 agy 未开始接续，驱动发送接续提示。定时接续在连续
30 分钟未收到会话事件且没有未到点的定时任务时超时。agy 自行执行定时接续，驱动在同一
job 收取输出，并根据工具状态、助手输出和 25 秒无新事件推断结束。回退时一起撤销插件和调度规则的迁移
提交，恢复旧代理和预设；旧安装及启动器保留在原处。
