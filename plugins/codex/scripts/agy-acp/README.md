# agy CLI ACP

The CLI can return `end_turn` while a background command is running, including
without steering. In the isolated wakeup probe, it sent no `session/update`
for 84 seconds after the command's final output was written. Keeping the ACP
connection open alone is insufficient to collect the completed result.

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

New sessions default to `gemini-4-carbon` with high thinking. Explicit Opus
models default to medium; explicit model/effort options take priority. The
server exposes effort as `thought_level`. Continued sessions retain their
existing settings unless explicitly overridden.

Running corrections use another `session/prompt` on the same session. The
server settles the previous prompt when steering arrives; the driver waits
for the newest response before completing the original job and turn. Sending
a message confirms submission, without a separate model-consumption receipt.
Queue, interrupt, cancel and continue retain the usual director controls.

While an execute tool is unfinished, agy steering is refused with instructions
to choose queue or interrupt; no second prompt is sent. When agy returns
`end_turn` with unfinished commands, the job stays running. The driver reads
their native tool statuses with `session/load`, filters out history replay,
and sends a continuation prompt in the same job and turn once they finish.
Repeated waits share a 30-minute limit. On timeout the task fails with the
explicit warning `agy 结束本轮时仍有后台命令在运行` and the remaining commands.
Queue, interrupt and cancel remain available during waiting. Commands marked
with the native `run_command` field `IsDaemon: true` are not waited on.

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
existing `~/.local/share/antigravity-acp/1.4.4/launch.sh` and old installation
are left in place. Existing jobs keep their recorded command and arguments;
continue uses those instead of the new preset.

派单使用 CLI 自带的 `agy acp`，复用现有登录和 MCP 配置。默认 Carbon high，
显式 Opus 默认 medium；显式 model/effort 优先。运行中纠偏使用同一会话的
新 prompt，等待最新响应后结束原任务。回退时一起撤销插件和调度规则的迁移
提交，恢复旧代理和预设；旧安装及启动器保留在原处。
