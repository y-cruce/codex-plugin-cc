import test from "node:test";
import assert from "node:assert/strict";
import { createCanonicalEvent } from "../plugins/codex/scripts/lib/executor-events.mjs";
import { normalizeCodexEvent as normalizeJobEvent } from "../plugins/codex/scripts/lib/executors/codex-event-adapter.mjs";
import { renderJobEvent, createLiveView, applyJobEvent } from "../plugins/codex/scripts/lib/job-event-model.mjs";
import { DEFAULT_INPUT_TIMEOUT_MS } from "../plugins/codex/scripts/lib/live-turn-control.mjs";

function harness(job = {}) {
  const metadata = { id: "job-1", streamId: "stream-1", ...job };
  const view = createLiveView(metadata);
  let seq = 0;
  function accept(method, params = {}) {
    const event = normalizeJobEvent({ method, params: { threadId: "thread-1", turnId: "turn-1", ...params }, emittedAtMs: 1000 }, metadata);
    event.seq = String(++seq);
    applyJobEvent(view, event);
    return event;
  }
  return { view, accept };
}

test("normalization preserves full source and event identity without modifying it", () => {
  const message = { method: "item/started", params: { threadId: "thread", turnId: "turn", item: { id: "item", type: "commandExecution", command: "x".repeat(500) } }, emittedAtMs: 1000 };
  const event = normalizeJobEvent(message, { id: "job", streamId: "stream" });
  assert.equal(event.type, "command.started");
  assert.equal(event.occurredAt, "1970-01-01T00:00:01.000Z");
  assert.equal(event.jobId, "job");
  assert.equal(event.identity.toolCallId, "item");
  assert.deepEqual(event.source.raw, message);
  assert.equal(renderJobEvent(event), `$ ${"x".repeat(500)}`);
  message.params.item.command = "changed";
  assert.equal(event.source.raw.params.item.command.length, 500);
});

test("message deltas fold into one row, survive snapshot restoration and retain complete text", () => {
  const { view, accept } = harness();
  const first = accept("item/agentMessage/delta", { itemId: "m", delta: "hello\n" });
  assert.equal(renderJobEvent(first), null);
  assert.match(renderJobEvent(first, { verbose: true }), /hello/);
  const restored = JSON.parse(JSON.stringify(view));
  const second = normalizeJobEvent({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "m", delta: "world" } }, { id: "job-1", streamId: "stream-1" });
  second.seq = "2";
  applyJobEvent(restored, second);
  assert.equal(restored.tail.length, 1);
  // A message row keeps its paragraphs: the pane draws them as Markdown, and a
  // fold applied here is one the renderer cannot undo.
  assert.equal(restored.tail[0].text, "assistant: hello\nworld");
  assert.equal(restored.lastMessage.text, "hello\nworld");
  assert.equal(restored.history.committedSeq, "2");
});

test("writing that resumes opens its own row and leaves the rows already drawn alone", () => {
  const job = { id: "job-acp", executor: "acp", threadId: "session-1" };
  const view = createLiveView(job);
  let seq = 0;
  const accept = (type, identity, payload) => {
    const event = createCanonicalEvent({
      job,
      executor: "acp",
      type,
      identity: { sessionId: "session-1", turnId: "turn-1", ...identity },
      occurredAt: "2026-09-19T00:00:00.000Z",
      receivedAt: "2026-09-19T00:00:00.000Z",
      payload
    });
    event.seq = String(++seq);
    applyJobEvent(view, event);
  };

  accept("message.delta", { messageId: "message-1" }, { role: "assistant", block: { type: "text", text: "working" } });
  accept("message.delta", { messageId: "message-1" }, { role: "assistant", block: { type: "text", text: "..." } });
  assert.deepEqual(view.tail.map((row) => row.type), ["message.delta"]);
  assert.equal(view.tail[0].positionSeq, "1");

  const startedTool = { toolCallId: "tool-1", name: "Read", kind: "other", status: "in_progress", title: "/repo/package.json", content: [], locations: [] };
  accept("tool.started", { toolCallId: "tool-1" }, { tool: startedTool });
  accept("tool.completed", { toolCallId: "tool-1" }, { tool: { ...startedTool, status: "completed" } });
  assert.deepEqual(view.tail.map((row) => row.type), ["message.delta", "tool.started", "tool.completed"]);

  // The text written before the tool ran stays above it, and what the agent
  // writes afterwards arrives as a row of its own carrying only the new part.
  accept("message.delta", { messageId: "message-1" }, { role: "assistant", block: { type: "text", text: " done" } });
  assert.deepEqual(view.tail.map((row) => row.type), ["message.delta", "tool.started", "tool.completed", "message.delta"]);
  assert.equal(view.tail[0].text, "assistant: working...");
  assert.equal(view.tail.at(-1).text, "assistant:  done");
  assert.equal(view.tail.at(-1).positionSeq, "5");
  // The whole message is still what the result and the header report.
  assert.equal(view.lastMessage.text, "working... done");

  accept("message.completed", { messageId: "message-1" }, { message: {
    messageId: "message-1", role: "assistant", content: [{ type: "text", text: "working... done" }], text: "working... done"
  } });
  assert.deepEqual(view.tail.map((row) => row.type), ["message.delta", "tool.started", "tool.completed", "message.completed"]);
  assert.deepEqual(view.tail.map((row) => row.seq), ["2", "3", "4", "6"]);
  assert.equal(view.tail.at(-1).text, "assistant:  done");
  assert.equal(view.lastMessage.text, "working... done");
  assert.ok(view.tail.every((row, index) => index === 0 || BigInt(row.seq) > BigInt(view.tail[index - 1].seq)));
});

test("short Codex messages and command lifecycle keep their compact rows", () => {
  const { view, accept } = harness();
  accept("item/agentMessage/delta", { itemId: "message", delta: "short " });
  accept("item/agentMessage/delta", { itemId: "message", delta: "answer" });
  assert.deepEqual(view.tail.map((row) => row.type), ["message.delta"]);
  assert.equal(view.tail[0].positionSeq, "1");
  accept("item/completed", { item: { type: "agentMessage", id: "message", text: "short answer" } });
  assert.deepEqual(view.tail.map((row) => row.type), ["message.completed"]);

  accept("item/started", { item: { type: "commandExecution", id: "command", command: "pwd", cwd: "/repo" } });
  accept("item/completed", { item: { type: "commandExecution", id: "command", command: "pwd", exitCode: 0 } });
  assert.deepEqual(view.tail.map((row) => row.type), ["message.completed", "command.completed"]);
  // A message that never had to make room keeps the place it was first drawn in.
  assert.deepEqual(view.tail.map((row) => row.positionSeq), ["1", "4"]);
});

test("a command or patch the sandbox declined is not recorded as a success", () => {
  const { view, accept } = harness();
  // app-server reports "declined" for work its sandbox refused; it never ran,
  // so anything but a failure would show a refusal as a completed command.
  // Three separate mappings decide this: commands, patches and other tools.
  assert.equal(accept("item/completed", { item: { type: "commandExecution", id: "c", command: "rm -rf /", status: "declined" } }).payload.status, "failed");
  assert.equal(accept("item/completed", { item: { type: "fileChange", id: "f", status: "declined", changes: [] } }).payload.status, "failed");
  assert.equal(accept("item/completed", { item: { type: "mcpToolCall", id: "t", status: "declined" } }).payload.tool.status, "failed");
  assert.equal(accept("item/completed", { item: { type: "commandExecution", id: "f2", command: "x", status: "failed" } }).payload.status, "failed");
  assert.equal(accept("item/completed", { item: { type: "commandExecution", id: "i", command: "x", status: "interrupted" } }).payload.status, "cancelled");
  assert.equal(accept("item/completed", { item: { type: "commandExecution", id: "ok", command: "x", status: "completed" } }).payload.status, "completed");
  assert.ok(view.tail.length > 0);
});

test("a web search says what it searched for and its empty start draws no row", () => {
  const { view, accept } = harness();
  // A webSearch item carries its target in `action` and names no tool, so a
  // row built from the title alone read as a bare string; the started event
  // has no query at all and drew a bullet with nothing after it.
  // The shape app-server really sends for a search that has not run yet.
  accept("item/started", { item: { type: "webSearch", id: "w1", query: "", action: null } });
  assert.deepEqual(view.tail, []);
  const searches = [
    [{ query: "node esm resolution", action: { type: "search", query: "node esm resolution", queries: null } }, "web search: node esm resolution"],
    [{ query: "a", action: { type: "search", query: "a", queries: ["", ""] } }, "web search: a"],
    [{ query: "https://example.com/docs", action: { type: "openPage", url: "https://example.com/docs" } }, "web open: https://example.com/docs"],
    // The v1 spelling of the same action.
    [{ query: "https://example.com/a", action: { type: "open_page", url: "https://example.com/a" } }, "web open: https://example.com/a"],
    [{ query: "'dependencies'", action: { type: "findInPage", url: "https://example.com/docs", pattern: "dependencies" } }, "web find: dependencies in https://example.com/docs"],
    // Every field of an action is nullable; the item's query still says what
    // was looked for.
    [{ query: "'dependencies'", action: { type: "findInPage", url: "https://example.com/docs", pattern: null } }, "web find: 'dependencies' in https://example.com/docs"]
  ];
  searches.forEach(([item], index) => accept("item/completed", { item: { type: "webSearch", id: `s${index}`, ...item } }));
  assert.deepEqual(view.tail.map((row) => row.text), searches.map(([, expected]) => `webSearch completed: ${expected}`));
});

test("a view opens with the brief the job was given, without the note around it", () => {
  // The brief travels in a file and the trace starts at what the agent did, so
  // the pane never showed what it was asked. The worker prepends a fixed note
  // to every brief and marks where the brief begins.
  const brief = "## Goal\nFind the root cause.";
  const noted = `## Who you are working with\nYou were started by a director.\n\n---- Brief ----\n${brief}\n`;
  assert.equal(createLiveView({ id: "job-1", request: { prompt: noted } }).prompt, brief);
  assert.equal(createLiveView({ id: "job-1", request: { prompt: brief } }).prompt, brief);
  assert.equal(createLiveView({ id: "job-1" }).prompt, null);
});

test("a plan is one checklist that updates in place", () => {
  const { view, accept } = harness();
  // Every step that moves redraws the whole plan. Appended, a seven-step plan
  // filled the pane with eight copies of itself and pushed the trace away.
  const plan = (statuses) => ({ plan: statuses.map((status, index) => ({ step: `#${index + 1} step`, status })) });
  accept("turn/plan/updated", plan(["pending", "pending"]));
  accept("turn/plan/updated", plan(["completed", "in_progress"]));
  // The plan lives on the view, where the pane draws it at its foot, and
  // leaves the trace alone: appended as a row, every redraw put another copy
  // of the whole checklist in it.
  assert.deepEqual(view.tail, []);
  assert.deepEqual(view.plan.entries.map((step) => [step.content, step.status]),
    [["#1 step", "completed"], ["#2 step", "in_progress"]]);
});

test("command output updates one item while completion removes active command", () => {
  const { view, accept } = harness();
  accept("item/started", { item: { type: "commandExecution", id: "c", command: "npm test", cwd: "/repo" } });
  accept("item/commandExecution/outputDelta", { itemId: "c", delta: "one\n" });
  accept("item/commandExecution/outputDelta", { itemId: "c", delta: "two" });
  assert.equal(view.activeCommands.length, 1);
  assert.equal(view.tail.length, 1);
  // The command is the row; its output travels beside it, because a heredoc
  // command carries newlines of its own and joined they cannot be told apart.
  assert.equal(view.tail[0].text, "$ npm test");
  assert.equal(view.tail[0].output, "one\ntwo");
  const event = accept("item/completed", { item: { type: "commandExecution", id: "c", command: "npm test", exitCode: 0, aggregatedOutput: "one\ntwo" } });
  assert.equal(view.activeCommands.length, 0);
  assert.equal(view.tail.length, 1);
  assert.match(renderJobEvent(event), /exit 0/);
});

test("summary sections fold, raw reasoning stays off default output", () => {
  const { view, accept } = harness();
  accept("item/reasoning/summaryTextDelta", { itemId: "r", summaryIndex: 0, delta: "First" });
  accept("item/reasoning/summaryPartAdded", { itemId: "r", summaryIndex: 1 });
  accept("item/reasoning/summaryTextDelta", { itemId: "r", summaryIndex: 1, delta: "Second" });
  const raw = accept("item/reasoning/textDelta", { itemId: "r", contentIndex: 0, delta: "raw" });
  assert.equal(renderJobEvent(raw), null);
  assert.equal(view.tail.length, 1);
  const done = accept("item/completed", { item: { id: "r", type: "reasoning", summary: ["First", "Second"], content: ["raw"] } });
  assert.equal(renderJobEvent(done), "reasoning: First ⏎ Second");
  assert.equal(view.lastMessage.text, "First\nSecond");
});

test("patch line statistics distinguish unknown from zero", () => {
  const { view, accept } = harness();
  accept("item/completed", { item: { id: "f", type: "fileChange", status: "completed", changes: [
    { path: "a", kind: { type: "update" }, diff: "--- a\n+++ a\n@@ -1 +1,2 @@\n-old\n+new\n+more" },
    { path: "binary", kind: { type: "add" }, diff: "Binary files differ" }
  ] } });
  assert.deepEqual(view.files, [
    { path: "a", kind: "update", additions: 2, deletions: 1 },
    { path: "binary", kind: "add", additions: null, deletions: null }
  ]);
});

test("a file change keeps one row that its completion redraws in place", () => {
  // The start and the completion of one patch are the same tool call, so the
  // row the start opens is the row the completion finishes in; left without a
  // key, the start drew a row of its own and the completion appended a second
  // one for the same file.
  const job = { id: "job-files", executor: "acp", threadId: "session-1" };
  const view = createLiveView(job);
  let seq = 0;
  const accept = (type, toolCallId, status, files) => {
    const event = createCanonicalEvent({
      job, executor: "acp", type, payload: { status, files },
      identity: { sessionId: "session-1", turnId: "turn-1", toolCallId },
      occurredAt: "2026-09-19T00:00:00.000Z",
      receivedAt: "2026-09-19T00:00:00.000Z"
    });
    event.seq = String(++seq);
    applyJobEvent(view, event);
  };

  const edited = [{ path: "/repo/biz/a.ts", kind: "add", additions: 2, deletions: 0 }];
  accept("fileChange.started", "tool-1", "in_progress", edited);
  assert.deepEqual(view.tail.map((row) => row.text), ["Files in_progress: add /repo/biz/a.ts (+2 −0)"]);
  // A change that has only begun is not yet a file the pane reports.
  assert.deepEqual(view.files, []);
  accept("fileChange.completed", "tool-1", "completed", edited);
  assert.deepEqual(view.tail.map((row) => row.text), ["Files completed: add /repo/biz/a.ts (+2 −0)"]);
  assert.equal(view.tail[0].seq, "2");
  assert.equal(view.tail[0].positionSeq, "1");
  assert.deepEqual(view.files, [{ path: "/repo/biz/a.ts", kind: "add", additions: 2, deletions: 0 }]);

  // Another tool's patch is another row, finished or not.
  const rewritten = [{ path: "/repo/b.ts", kind: "update", additions: 1, deletions: 1 }];
  accept("fileChange.started", "tool-2", "in_progress", rewritten);
  accept("fileChange.completed", "tool-2", "failed", rewritten);
  assert.deepEqual(view.tail.map((row) => row.text), [
    "Files completed: add /repo/biz/a.ts (+2 −0)",
    "Files failed: update /repo/b.ts (+1 −1)"
  ]);
});

test("usage snapshots add increments rather than cumulative totals across turns", () => {
  const { view, accept } = harness();
  accept("thread/tokenUsage/updated", { tokenUsage: { total: { inputTokens: 20, outputTokens: 5, cachedInputTokens: 3 } } });
  accept("thread/tokenUsage/updated", { tokenUsage: { total: { inputTokens: 20, outputTokens: 5, cachedInputTokens: 3 } } });
  accept("thread/tokenUsage/updated", { turnId: "turn-2", tokenUsage: { total: { inputTokens: 30, outputTokens: 8, cachedInputTokens: 4 } } });
  assert.deepEqual(view.usage, { inputTokens: 30, outputTokens: 8, cachedInputTokens: 4, complete: true });
});

test("resumed usage excludes tokens consumed before this job", () => {
  const { view, accept } = harness({ request: { resumeThreadId: "thread-1" } });
  accept("thread/tokenUsage/updated", { tokenUsage: { total: { inputTokens: 120, outputTokens: 30, cachedInputTokens: 15 },
    last: { inputTokens: 20, outputTokens: 5, cachedInputTokens: 3 } } });
  accept("thread/tokenUsage/updated", { tokenUsage: { total: { inputTokens: 125, outputTokens: 32, cachedInputTokens: 16 },
    last: { inputTokens: 25, outputTokens: 7, cachedInputTokens: 4 } } });
  assert.deepEqual(view.usage, { inputTokens: 25, outputTokens: 7, cachedInputTokens: 4, complete: false });
});

test("director controls and delivered answers appear in default output and tail", () => {
  const { view, accept } = harness();
  accept("companion/question", { requestId: 4, questions: [{ question: "Which?" }] });
  assert.equal(view.status, "waiting-for-answer");
  assert.deepEqual(view.pendingQuestion, { requestId: "4", text: "Which?", openedAt: "1970-01-01T00:00:01.000Z", expiresAt: "1970-01-01T00:10:01.000Z" });
  const answer = accept("companion/answer-delivered", { requestId: 4 });
  assert.equal(renderJobEvent(answer), "director → answer delivered request=4");
  assert.equal(view.pendingQuestion, null);
  assert.equal(view.status, "running");
  const text = "x".repeat(300);
  const control = accept("companion/control-message", { message: text, interrupt: true, status: "accepted" });
  assert.equal(control.source.raw.params.message, text);
  assert.equal(renderJobEvent(control), `director → interrupt: ${"x".repeat(200)}`);
  assert.equal(view.tail.at(-1).text, renderJobEvent(control));
  assert.equal(accept("companion/control-message", { message: "steer", status: "accepted" }).payload.mode, "steer");
  const queued = accept("companion/control-message", { message: "later", mode: "queue", status: "rejected" });
  assert.deepEqual(queued.payload, { message: "later", mode: "queue", accepted: false });
  assert.equal(renderJobEvent(queued), "director → queue rejected: later");
});

test("tail is bounded and terminal snapshot settles fields", () => {
  const { view, accept } = harness();
  for (let n = 0; n < 220; n++) accept("companion/notification", { message: `note ${n}` });
  assert.equal(view.tail.length, 200);
  assert.equal(view.tail[0].text, "notify_director: note 20");
  accept("companion/job-completed", { job: { status: "completed", completedAt: "2026-01-01T00:00:00.000Z" } });
  assert.equal(view.status, "completed");
  assert.equal(view.endedAt, "2026-01-01T00:00:00.000Z");
});

test("a terminal view ignores a later root turn and reports the routing diagnostic", () => {
  const job = { id: "job-1", threadId: "thread-1", turnId: "turn-1" };
  const view = createLiveView(job);
  const completed = normalizeJobEvent({ method: "companion/job-completed", params: { threadId: "thread-1",
    job: { ...job, status: "completed", completedAt: "2026-01-01T00:00:00.000Z" } } }, job);
  completed.seq = "1";
  applyJobEvent(view, completed);
  const started = normalizeJobEvent({ method: "turn/started", params: { threadId: "thread-1",
    turn: { id: "turn-2" } } }, job);
  started.seq = "2";
  const diagnostics = [];
  applyJobEvent(view, started, { onDiagnostic: (message) => diagnostics.push(message) });
  assert.equal(view.status, "completed");
  assert.equal(view.turnId, "turn-1");
  assert.equal(view.endedAt, "2026-01-01T00:00:00.000Z");
  assert.deepEqual(diagnostics, [
    "Ignored turn.started for terminal job job-1 (completed): event job=job-1, session=thread-1, turn=turn-2, terminal turn=turn-1"
  ]);
});

test("moving a completed message within a full tail does not trim another row", () => {
  const { view, accept } = harness();
  accept("item/agentMessage/delta", { itemId: "message", delta: "working" });
  for (let n = 0; n < 199; n++) accept("companion/notification", { message: `note ${n}` });
  accept("item/completed", { item: { type: "agentMessage", id: "message", text: "done" } });
  assert.equal(view.tail.length, 200);
  assert.equal(view.tail[0].text, "notify_director: note 0");
  assert.equal(view.tail.at(-1).text, "assistant: done");
  assert.equal(view.tail.filter((row) => row.type === "director.notified").length, 199);
});

test("display hides usage, user echoes and blank reasoning but retains their source and usage state", () => {
  const { view, accept } = harness();
  const usage = accept("thread/tokenUsage/updated", { tokenUsage: { total: { inputTokens: 12, outputTokens: 3, cachedInputTokens: 2 } } });
  for (const method of ["item/started", "item/completed"]) {
    const echo = accept(method, { item: { type: "userMessage", id: "echo", text: "internal" } });
    assert.equal(renderJobEvent(echo), null);
    assert.match(renderJobEvent(echo, { verbose: true }), /userMessage/);
  }
  for (const summary of [[], ["", " \n "]]) {
    const reasoning = accept("item/completed", { item: { type: "reasoning", id: "empty", summary } });
    assert.equal(renderJobEvent(reasoning), null);
    assert.deepEqual(reasoning.source.raw.params.item.summary, summary);
  }
  accept("item/reasoning/summaryTextDelta", { itemId: "blank", delta: " \n " });
  assert.deepEqual(view.tail, []);
  assert.equal(view.usage.inputTokens, 12);
  assert.equal(renderJobEvent(usage), null);
  assert.match(renderJobEvent(usage, { verbose: true }), /Tokens:/);
  const meaningful = accept("item/completed", { item: { type: "reasoning", id: "real", summary: ["Useful conclusion"] } });
  assert.equal(renderJobEvent(meaningful), "reasoning: Useful conclusion");
  assert.equal(view.tail.length, 1);
});

test("display previews are bounded by Unicode characters while raw content and lastMessage stay complete", () => {
  const { view, accept } = harness();
  const command = "nl -ba example.mjs";
  const output = `first\n${"🙂".repeat(150)}`;
  accept("item/started", { item: { type: "commandExecution", id: "cmd", command, cwd: "/repo" } });
  accept("item/commandExecution/outputDelta", { itemId: "cmd", delta: output });
  let body = view.tail.at(-1).output;
  assert.equal([...body].length, 120);
  assert.ok(body.endsWith("…"));
  const completed = accept("item/completed", { item: { type: "commandExecution", id: "cmd", command, exitCode: 0, aggregatedOutput: output } });
  body = renderJobEvent(completed).slice(`$ ${command} (exit 0) ⏎ `.length);
  assert.equal([...body].length, 120);
  assert.ok(body.endsWith("…"));
  assert.equal(completed.source.raw.params.item.aggregatedOutput, output);
  assert.ok(renderJobEvent(completed, { verbose: true }).endsWith(output.replace(/\n/g, " ⏎ ")));
  const message = `header\n${"文".repeat(350)}`;
  accept("item/agentMessage/delta", { itemId: "msg", delta: message });
  assert.equal([...view.tail.at(-1).text].length, 300);
  const assistant = accept("item/completed", { item: { type: "agentMessage", id: "msg", text: message } });
  assert.equal([...renderJobEvent(assistant)].length, 300);
  assert.ok(renderJobEvent(assistant).endsWith("…"));
  assert.equal(view.lastMessage.text, message);
  assert.equal(assistant.source.raw.params.item.text, message);
  assert.equal(renderJobEvent(assistant, { verbose: true }), `assistant: ${message.replace(/\n/g, " ⏎ ")}`);
  // Prose rows keep their breaks; every other kind is still one row, one line.
  assert.ok(view.tail.every((row) => /^(message|reasoning|question|director|control|source|plan|tool\.progress)/.test(row.type) || !row.text.includes("\n")));
  assert.ok(view.tail.some((row) => row.type.startsWith("message") && row.text.includes("\n")));
});

test("turn lifecycle stays in follow stdout but not in tail", () => {
  const { view, accept } = harness();
  const start = accept("turn/started", { turn: { id: "turn-1" } });
  const end = accept("turn/completed", { turn: { id: "turn-1", status: "completed" } });
  assert.deepEqual(view.tail, []);
  assert.equal(renderJobEvent(start), "Turn started");
  assert.equal(renderJobEvent(end), "Turn completed");
  assert.equal(renderJobEvent(start, { verbose: true }), "Turn started turn-1");
  assert.equal(renderJobEvent(end, { verbose: true }), "Turn completed turn-1");
});

test("command projection unwraps shell arguments without altering inner text or raw payload", () => {
  const cases = [
    ["/bin/zsh -lc 'npm test -- runtime.test.mjs'", "npm test -- runtime.test.mjs"],
    [String.raw`bash -lc "echo \"hello\""`, 'echo "hello"'],
    ["sh -c 'printf \"%s\\n\" \"a b\"'", 'printf "%s\\n" "a b"'],
    ["/usr/bin/bash -c '  echo one\necho two  '", "  echo one\necho two  "],
    ["zsh -lc 'echo '\"'\"'quoted'\"'\"''", "echo 'quoted'"],
    ['sh -c "printf \\"%s\\" \\$HOME"', 'printf "%s" $HOME'],
    ["sh -c 'bash -lc \"echo nested\"'", 'bash -lc "echo nested"'],
    ["npm test", "npm test"],
    ["python -c 'print(1)'", "python -c 'print(1)'"],
    ["sh -c 'echo one' extra", "sh -c 'echo one' extra"],
    ["sh -c 'unterminated", "sh -c 'unterminated"],
    ["sh -c 'echo one'; echo two", "sh -c 'echo one'; echo two"]
  ];
  for (const [command, expected] of cases) {
    const { view, accept } = harness();
    const start = accept("item/started", { item: { type: "commandExecution", id: "c", command, cwd: "/repo" } });
    assert.equal(view.activeCommands[0].command, expected, command);
    assert.equal(view.tail[0].text, `$ ${expected.replace(/\r?\n/g, " ⏎ ")}`, command);
    assert.equal(start.source.raw.params.item.command, command);
    accept("item/commandExecution/outputDelta", { itemId: "c", delta: "output" });
    assert.equal(view.tail[0].output, "output", command);
    const done = accept("item/completed", { item: { type: "commandExecution", id: "c", command, exitCode: 0, durationMs: 123, aggregatedOutput: "output" } });
    assert.equal(view.tail[0].text, `$ ${expected.replace(/\r?\n/g, " ⏎ ")}`, command);
    assert.equal(view.tail[0].output, "output", command);
    assert.equal(done.source.raw.params.item.command, command);
    assert.ok(renderJobEvent(done).includes("(exit 0)"));
  }
});

test("only completed command tail rows carry exit and duration metadata", () => {
  const { view, accept } = harness();
  accept("item/started", { item: { type: "commandExecution", id: "c", command: "sh -c 'echo ok'" } });
  accept("item/commandExecution/outputDelta", { itemId: "c", delta: "ok" });
  assert.equal(Object.hasOwn(view.tail[0], "exitCode"), false);
  assert.equal(Object.hasOwn(view.tail[0], "durationMs"), false);
  accept("item/completed", { item: { type: "commandExecution", id: "c", command: "sh -c 'echo ok'", exitCode: 0, durationMs: 42, aggregatedOutput: "ok" } });
  assert.equal(view.tail[0].exitCode, 0);
  assert.equal(view.tail[0].durationMs, 42);
  assert.equal(view.tail[0].text, "$ echo ok");
  assert.equal(view.tail[0].output, "ok");
  accept("item/completed", { item: { type: "commandExecution", id: "missing", command: "false" } });
  assert.equal(view.tail.at(-1).exitCode, null);
  assert.equal(view.tail.at(-1).durationMs, null);
  accept("item/completed", { item: { type: "agentMessage", id: "m", text: "done" } });
  assert.equal(Object.hasOwn(view.tail.at(-1), "exitCode"), false);
  assert.equal(Object.hasOwn(view.tail.at(-1), "durationMs"), false);
});

test("pending question timestamps use the broker deadline and shared default timeout", () => {
  const { view, accept } = harness();
  const event = accept("companion/question", { requestId: "q", questions: [{ question: "Choose?" }] });
  assert.equal(view.pendingQuestion.openedAt, event.occurredAt);
  assert.equal(Date.parse(view.pendingQuestion.expiresAt) - Date.parse(event.occurredAt), DEFAULT_INPUT_TIMEOUT_MS);
  accept("companion/question", { requestId: "custom", questions: [], expiresAt: 1250 });
  assert.equal(view.pendingQuestion.expiresAt, "1970-01-01T00:00:01.250Z");
  accept("companion/question", { requestId: "none", questions: [], expiresAt: null });
  assert.equal(view.pendingQuestion.expiresAt, null);
});

test("large command delta streams keep a bounded preview without rescanning accumulated output", (t) => {
  const { view, accept } = harness();
  accept("item/started", { item: { type: "commandExecution", id: "large", command: "sh -c 'cat large.txt'" } });
  const chunk = "x".repeat(8192);
  const started = performance.now();
  let last;
  for (let index = 0; index < 500; index++) last = accept("item/commandExecution/outputDelta", { itemId: "large", delta: chunk });
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 200, `500 × 8KiB deltas took ${elapsed.toFixed(1)}ms`);
  t.diagnostic(`500 × 8KiB deltas: ${elapsed.toFixed(1)}ms`);
  assert.equal(view.tail.length, 1);
  assert.equal(view.tail[0].text, "$ cat large.txt");
  assert.equal(view.tail[0].output, `${"x".repeat(119)}…`);
  const state = view._items[JSON.stringify(["thread-1", "turn-1", "large"])];
  assert.equal(state.outputPreviewTruncated, true);
  assert.ok(state.output.length <= 242);
  assert.equal(last.source.raw.params.delta, chunk);
});

test("bounded output preview handles CRLF and surrogate pairs split between deltas", () => {
  const { view, accept } = harness();
  accept("item/started", { item: { type: "commandExecution", id: "c", command: "cat file" } });
  for (const delta of ["first\r", "\n", "\ud83d", "\ude42", "x".repeat(200)]) accept("item/commandExecution/outputDelta", { itemId: "c", delta });
  // The preview keeps its breaks so the renderer can give each line a row.
  assert.equal(view.tail[0].text, "$ cat file");
  assert.equal(view.tail[0].output, `first\n🙂${"x".repeat(112)}…`);
});

test("empty terminal input is hidden only from tail, nonempty input remains visible", () => {
  const { view, accept } = harness();
  const empty = accept("item/commandExecution/terminalInteraction", { itemId: "c", processId: "5733", stdin: "" });
  assert.deepEqual(view.tail, []);
  assert.equal(renderJobEvent(empty), "stdin 5733: ");
  const input = accept("item/commandExecution/terminalInteraction", { itemId: "c", processId: "5733", stdin: "y\n" });
  assert.equal(view.tail.length, 1);
  assert.equal(view.tail[0].text, "stdin 5733: y ⏎ ");
  assert.equal(input.source.raw.params.stdin, "y\n");
});

test("live view consumes canonical payload and ignores contradictory raw source", () => {
  const job = { id: "job-canonical", executor: "acp", threadId: "session-1" };
  const view = createLiveView(job);
  const event = createCanonicalEvent({
    job,
    executor: "acp",
    type: "command.started",
    identity: { sessionId: "session-1", turnId: "turn-1", toolCallId: "tool:with:colons" },
    occurredAt: "2026-09-18T00:00:00.000Z",
    receivedAt: "2026-09-18T00:00:00.000Z",
    payload: { command: "Build project", commandKnown: false, cwd: "/repo", startedAt: "2026-09-18T00:00:00.000Z" },
    source: { protocol: "acp", method: "session/update", raw: { command: "must not be used", cwd: "/wrong" } }
  });
  event.seq = "1";
  applyJobEvent(view, event);
  assert.deepEqual(view.activeCommands, [{ itemId: "tool:with:colons", command: "Build project", cwd: "/repo",
    startedAt: "2026-09-18T00:00:00.000Z", _key: JSON.stringify(["session-1", "turn-1", "tool:with:colons"]) }]);
  assert.equal(view.executor.label, "Qoder");
  assert.deepEqual(view.subAgents ?? [], []);
  assert.equal(view.tail[0].text, "$ Build project");
});

test("a canonical completion migrates and clears an active item from a legacy checkpoint", () => {
  const job = { id: "job-legacy", threadId: "thread-1" };
  const view = createLiveView(job);
  const legacyKey = "thread-1:turn-1:command-1";
  view._items[legacyKey] = { command: "npm test", turnId: "turn-1", tailSeq: "1" };
  view.activeCommands.push({ itemId: "command-1", command: "npm test", cwd: "/repo",
    startedAt: "2026-09-18T00:00:00.000Z", _key: legacyKey });
  view.tail.push({ seq: "1", at: "2026-09-18T00:00:00.000Z", type: "command.started", text: "$ npm test" });
  const event = createCanonicalEvent({ job, type: "command.completed",
    identity: { sessionId: "thread-1", turnId: "turn-1", toolCallId: "command-1" },
    payload: { command: "npm test", commandKnown: true, cwd: "/repo", status: "completed", exitCode: 0,
      signal: null, durationMs: 10, output: [], outputText: null },
    source: { protocol: "local", method: "test/completed", raw: null } });
  event.seq = "2";
  applyJobEvent(view, event);
  assert.deepEqual(view.activeCommands, []);
  assert.equal(view._items[legacyKey], undefined);
  assert.equal(Object.keys(view._items).length, 0);
  assert.equal(view.tail[0].exitCode, 0);
});
