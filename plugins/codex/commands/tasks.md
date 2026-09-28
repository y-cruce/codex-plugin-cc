---
description: Open, refresh, or clean the Codex tasks pane, or switch tasks
argument-hint: '[number | part of a task name | refresh | forget <number | part of a task name>]'
disable-model-invocation: true
---

The pane is drawn by the plugin's hooks module, which answers this command in
the session; this body runs only when that module is not loaded.

`/codex:tasks` opens or closes the pane. A number or part of a task name selects
a task. `/codex:tasks refresh` clears the pane's cache and rebuilds it from disk.
`/codex:tasks forget <number | part of a task name>` hides a row from the display;
job files are untouched. It stays hidden until refresh or a new session.

The Codex tasks pane needs the plugin's hooks module. Reload the plugins, or
start a new session, and run `/codex:tasks` again.
