import test from "node:test";
import assert from "node:assert/strict";
import { normalizeJobEvent, renderJobEvent, createLiveView, applyJobEvent } from "../plugins/codex/scripts/lib/job-event-model.mjs";
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
  assert.equal(event.itemId, "item");
  assert.deepEqual(event.source.message, message);
  assert.equal(renderJobEvent(event), `$ ${"x".repeat(500)}`);
  message.params.item.command = "changed";
  assert.equal(event.source.message.params.item.command.length, 500);
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
  assert.equal(restored.tail[0].text, "assistant: hello ⏎ world");
  assert.equal(restored.lastMessage.text, "hello\nworld");
  assert.equal(restored.history.committedSeq, "2");
});

test("command output updates one item while completion removes active command", () => {
  const { view, accept } = harness();
  accept("item/started", { item: { type: "commandExecution", id: "c", command: "npm test", cwd: "/repo" } });
  accept("item/commandExecution/outputDelta", { itemId: "c", delta: "one\n" });
  accept("item/commandExecution/outputDelta", { itemId: "c", delta: "two" });
  assert.equal(view.activeCommands.length, 1);
  assert.equal(view.tail.length, 1);
  assert.equal(view.tail[0].text, "$ npm test ⏎ one ⏎ two");
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

test("usage snapshots add increments rather than cumulative totals across turns", () => {
  const { view, accept } = harness();
  accept("thread/tokenUsage/updated", { tokenUsage: { total: { inputTokens: 20, outputTokens: 5, cachedInputTokens: 3 } } });
  accept("thread/tokenUsage/updated", { tokenUsage: { total: { inputTokens: 20, outputTokens: 5, cachedInputTokens: 3 } } });
  accept("thread/tokenUsage/updated", { turnId: "turn-2", tokenUsage: { total: { inputTokens: 30, outputTokens: 8, cachedInputTokens: 4 } } });
  assert.deepEqual(view.usage, { inputTokens: 30, outputTokens: 8, cachedInputTokens: 4, complete: true });
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
  assert.equal(control.source.message.params.message, text);
  assert.equal(renderJobEvent(control), `director → interrupt: ${"x".repeat(200)}`);
  assert.equal(view.tail.at(-1).text, renderJobEvent(control));
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
    assert.deepEqual(reasoning.source.message.params.item.summary, summary);
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
  let body = view.tail.at(-1).text.slice(`$ ${command} ⏎ `.length);
  assert.equal([...body].length, 120);
  assert.ok(body.endsWith("…"));
  const completed = accept("item/completed", { item: { type: "commandExecution", id: "cmd", command, exitCode: 0, aggregatedOutput: output } });
  body = renderJobEvent(completed).slice(`$ ${command} (exit 0) ⏎ `.length);
  assert.equal([...body].length, 120);
  assert.ok(body.endsWith("…"));
  assert.equal(completed.source.message.params.item.aggregatedOutput, output);
  assert.ok(renderJobEvent(completed, { verbose: true }).endsWith(output.replace(/\n/g, " ⏎ ")));
  const message = `header\n${"文".repeat(350)}`;
  accept("item/agentMessage/delta", { itemId: "msg", delta: message });
  assert.equal([...view.tail.at(-1).text].length, 300);
  const assistant = accept("item/completed", { item: { type: "agentMessage", id: "msg", text: message } });
  assert.equal([...renderJobEvent(assistant)].length, 300);
  assert.ok(renderJobEvent(assistant).endsWith("…"));
  assert.equal(view.lastMessage.text, message);
  assert.equal(assistant.source.message.params.item.text, message);
  assert.equal(renderJobEvent(assistant, { verbose: true }), `assistant: ${message.replace(/\n/g, " ⏎ ")}`);
  assert.ok(view.tail.every((row) => !row.text.includes("\n")));
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
    assert.equal(start.source.message.params.item.command, command);
    accept("item/commandExecution/outputDelta", { itemId: "c", delta: "output" });
    assert.equal(view.tail[0].text, `$ ${expected.replace(/\r?\n/g, " ⏎ ")} ⏎ output`, command);
    const done = accept("item/completed", { item: { type: "commandExecution", id: "c", command, exitCode: 0, durationMs: 123, aggregatedOutput: "output" } });
    assert.equal(view.tail[0].text, `$ ${expected.replace(/\r?\n/g, " ⏎ ")} ⏎ output`, command);
    assert.equal(done.source.message.params.item.command, command);
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
  assert.equal(view.tail[0].text, "$ echo ok ⏎ ok");
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
  assert.equal(view.tail[0].text, `$ cat large.txt ⏎ ${"x".repeat(119)}…`);
  const state = view._items["thread-1:turn-1:large"];
  assert.equal(state.outputPreviewTruncated, true);
  assert.ok(state.output.length <= 242);
  assert.equal(last.source.message.params.delta, chunk);
});

test("bounded output preview handles CRLF and surrogate pairs split between deltas", () => {
  const { view, accept } = harness();
  accept("item/started", { item: { type: "commandExecution", id: "c", command: "cat file" } });
  for (const delta of ["first\r", "\n", "\ud83d", "\ude42", "x".repeat(200)]) accept("item/commandExecution/outputDelta", { itemId: "c", delta });
  assert.equal(view.tail[0].text, `$ cat file ⏎ first ⏎ 🙂${"x".repeat(110)}…`);
});

test("empty terminal input is hidden only from tail, nonempty input remains visible", () => {
  const { view, accept } = harness();
  const empty = accept("item/commandExecution/terminalInteraction", { itemId: "c", processId: "5733", stdin: "" });
  assert.deepEqual(view.tail, []);
  assert.equal(renderJobEvent(empty), "stdin 5733: ");
  const input = accept("item/commandExecution/terminalInteraction", { itemId: "c", processId: "5733", stdin: "y\n" });
  assert.equal(view.tail.length, 1);
  assert.equal(view.tail[0].text, "stdin 5733: y ⏎ ");
  assert.equal(input.source.message.params.stdin, "y\n");
});
