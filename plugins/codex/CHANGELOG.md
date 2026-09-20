# Changelog

## 1.2.7

- Never report a question that has already been answered: a request is surfaced once, while it is still open.

## 1.2.6

- Measure `observe follow` stalls from the current follow session and subsequent event progress, preventing immediate false STALLED results when resuming long-running jobs.

## 1.2.5

- Separate live transcript prose blocks with blank lines while keeping command, file and agent rows compact; result cards separate the final message from file and agent summaries.

## 1.2.4

- Group each Codex sub-agent into one anchored live row with its name, status and latest activity; result and intermediate cards keep one summary per agent. Child commands and output no longer interleave with the parent trace.

## 1.2.3

- Codex sub-agent threads (`subAgentActivity`) are bound to their parent job: their events are recorded in the same history with `derived.agent`, tail rows carry an `agent` field and a `[name]` prefix, `⇢ sub-agent <name> started|completed` rows replace the raw call ids, and `live-view.json` gains `subAgents`. Sub-agent messages never replace the parent thread's `lastMessage`, pending question or status.
- The live-tool-row mod draws sub-agent rows as single dim lines without Markdown.

## 1.2.2

- While an assistant message streams, the block still being written is no longer drawn as raw text; completed blocks appear whole and a dim `…` marks the rest, so text never snaps from Markdown source into its rendered form.

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
