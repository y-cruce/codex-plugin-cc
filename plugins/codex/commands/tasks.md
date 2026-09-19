---
description: Open the Codex tasks pane, or switch it to another task
argument-hint: '[number | part of a task name]'
disable-model-invocation: true
---

The pane is drawn by the plugin's hooks module, which answers this command in
the session; this body runs only when that module is not loaded.

The Codex tasks pane needs the plugin's hooks module. Reload the plugins, or
start a new session, and run `/codex:tasks` again.
