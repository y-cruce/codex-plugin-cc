---
description: Send guidance to a running task now, after its turn, or by interrupting it
argument-hint: '<job-id> [--interrupt|--queue] [--prompt-file <path>] [message]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" message "$ARGUMENTS"`

Return the command output unchanged. With no flag, the message enters the active turn and requires mid-turn steering support. `--queue` lets that turn finish naturally and starts the next turn with the message. `--interrupt` cancels the current turn and continues the same job and thread with the new message, retaining existing file changes and the task's original write permissions. It does not roll back files. For a pending structured question or permission request, use `/codex:answer` instead.
