# Changelog

## 1.2.1

- The live-tool-row mod also takes over the result block under a follow row, so the quiet heartbeat lines, repository edits the host attributes to the command (made by Codex meanwhile) and the timeout note no longer appear beneath the card.

## 1.2.0

- Removed the `/codex:rescue` command, the `codex-rescue` subagent and the internal `codex-cli-runtime`, `codex-result-handling` and `gpt-5-4-prompting` skills. Delegation is driven by the codex-director workflow (the `codex-task` subagent with `observe follow`); the remaining commands (`review`, `adversarial-review`, `status`, `result`, `answer`, `message`, `cancel`, `transfer`, `setup`) are unchanged.

## 1.1.2

- While an assistant message is still streaming, only its completed Markdown blocks are rendered; the block being written shows as plain wrapped text, so tables no longer re-lay out on every delta and half-written links stay literal. The full Markdown rendering applies once the message completes.

## 1.1.1

- Follow rows that ended on NOTIFIED, QUESTION, TIMEOUT or STALLED draw a segment card from their own output; only the DONE card carries the final answer.
- Event lines: answered questions draw as a cyan arrow; closed-question and dynamic tool call rows are hidden.

## 1.1.0

- `observe` command family (`list`, `replay`, `view-path`, `follow`): every app-server notification, deltas included, is normalized into a durable per-job event history with opaque cursors. `follow` blocks until the director must act (DONE, FAILED, QUESTION, NOTIFIED, STALLED, TIMEOUT); `--quiet` prints only the cursor and that line; `--max-seconds` yields a resumable cursor before a caller's time limit.
- The broker writes an atomic `live-view.json` projection per job (status, active commands, pending question with expiry, files, usage, recent events).
- `live-tool-row` function-hooks module: draws a running `observe follow` command as the job's live trace (Markdown-rendered assistant text, tables, commands with exit codes and durations, files, question countdown, stall hint), unfolds tool groups while it runs, turns the finished row into a result card, and shows running jobs on the prompt hint line with toasts for questions, notifications and completion.
- Existing `status`, `result`, `events`, `message`, `answer` and `job.log` keep their interfaces; lookups work without `CLAUDE_PLUGIN_DATA` by searching the plugin data roots.
- Command-output previews are bounded, removing a quadratic projection cost on large outputs.

## 1.0.0

- Initial version of the Codex plugin for Claude Code
