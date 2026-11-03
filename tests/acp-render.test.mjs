import test from "node:test";
import assert from "node:assert/strict";

import { AcpEventAdapter } from "../plugins/codex/scripts/lib/executors/acp-event-adapter.mjs";
import { AcpExecutorJobPort } from "../plugins/codex/scripts/lib/executors/acp-driver.mjs";
import { normalizeCodexEvent } from "../plugins/codex/scripts/lib/executors/codex-event-adapter.mjs";
import { applyJobEvent, createLiveView, renderJobEvent } from "../plugins/codex/scripts/lib/job-event-model.mjs";
import { liveTree } from "../plugins/codex/hooks/live-tool-row/view.ts";
import { textOf } from "./fixtures/live-tool-row.mjs";

const element = (type) => ({ children, ...props }) => ({ type, props, children: [children ?? props.label ?? ""].flat() });
const ui = Object.fromEntries(["Box", "Text", "Markdown", "Button"].map((type) => [type, element(type)]));

function harness() {
  const job = { id: "acp-render", executor: "acp", startedAt: "2026-10-23T00:00:00Z" };
  const view = createLiveView(job);
  const events = [];
  const record = (event) => {
    event.seq = String(events.length + 1);
    events.push(event);
    applyJobEvent(view, event);
  };
  const adapter = new AcpEventAdapter(record, { job });
  adapter.bindSession("session");
  const update = (sessionUpdate, content) => adapter.accept({ sessionId: "session", update: { sessionUpdate, ...content } });
  const draw = (open = false) => textOf(liveTree(ui, { ...view, activeCommands: [] }, 160, Date.now(), 48,
    undefined, 200, false, { Button: ui.Button, isOpen: () => open, toggle() {} }));
  return { job, view, events, adapter, record, update, draw };
}

test("ACP submitted steering, accepted queue and interrupt messages use director rows, including during a sub-agent", async () => {
  for (const mode of ["queued", "interrupt", "steer"]) {
    const h = harness();
    await h.adapter.startTurn("turn", []);
    h.adapter.subagent = { id: "child", path: "Explore" };
    const port = new AcpExecutorJobPort({ job: h.job, createQueuedRound: () => ({ job: { id: "next" } }) });
    port.adapter = h.adapter;
    port.sessionId = "session";
    port.activeTurn = { turnId: "turn", done: Promise.resolve({ status: "interrupted" }) };
    port.connection = { cancel: async () => {} };
    const prompt = [{ type: "text", text: "Keep the focused tests.\nReport evidence." }];
    if (mode === "queued") await port.queuePrompt({ turnId: "turn", prompt });
    else if (mode === "interrupt") await port.interruptTurn({ sessionId: "session", turnId: "turn", replacementPrompt: prompt, timeoutMs: 100 });
    else await h.adapter.controlMessage(prompt, "steer", "turn");
    const [control] = h.events.filter((event) => event.type === "control.message.updated");
    assert.ok(control, mode);
    const codex = normalizeCodexEvent({ method: "companion/control-message", params: {
      message: prompt[0].text, interrupt: mode === "interrupt", status: "accepted",
      ...(mode === "queued" ? { queued: true, queuedJobId: "next" } : {}),
    } }, h.job);
    assert.deepEqual(control.payload, mode === "steer" ? { ...codex.payload, mode: "steer", accepted: null, sent: true, consumed: null } : codex.payload);
    assert.equal(control.identity.turnId, "turn");
    assert.equal(control.agent, undefined, "director messages belong to the parent");
    assert.match(h.draw(), mode === "interrupt" ? /◆ ↓ Director interrupt/ : /◆ ↓ Director message/);
    assert.ok(h.draw().includes(mode === "queued" ? prompt[0].text.replace(/\s+/gu, " ") : prompt[0].text));
    if (mode === "queued") assert.equal(h.view.queuedPrompts[0].text, prompt[0].text);

    const count = h.events.length;
    if (mode === "queued") await assert.rejects(port.queuePrompt({ turnId: "stale", prompt }));
    else if (mode === "interrupt") {
      port.connection.cancel = async () => { throw new Error("cancel failed"); };
      await assert.rejects(port.interruptTurn({ sessionId: "session", turnId: "turn", replacementPrompt: prompt }), /cancel failed/);
    } else await assert.rejects(port.steerPrompt({ sessionId: "session", turnId: "turn", prompt }));
    assert.equal(h.events.length, count, "rejected controls draw no accepted message");
  }
});

test("ACP shell lifecycle renders one command or tool row, including legacy progress and failures without exit codes", async () => {
  for (const [kind, status] of [["execute", "completed"], ["other", "completed"], ["execute", "failed"]]) {
    const h = harness();
    await h.adapter.startTurn("turn", []);
    await h.update("tool_call", { toolCallId: "shell", kind, title: kind === "execute" ? "echo hello" : "bash",
      rawInput: { command: "echo hello" }, status: "pending" });
    await h.update("tool_call_update", { toolCallId: "shell", status: "in_progress" });
    // Old segments contain this title-only event for every execute update.
    if (kind === "execute") h.record(h.adapter.event("tool.progress", { message: "echo hello", content: [] }, { toolCallId: "shell" }));
    await h.update("tool_call_update", { toolCallId: "shell", status,
      content: [{ type: "content", content: { type: "text", text: status === "failed" ? "denied" : "hello" } }] });
    h.view.status = "completed";
    assert.equal(h.view.tail.length, 1, `${kind}/${status}`);
    assert.equal((h.draw(true).match(/echo hello/g) ?? []).length, 1);
    if (status === "failed") {
      assert.match(h.draw(), /failed/);
      assert.doesNotMatch(h.draw(), /Ran 1 shell command/);
    } else if (kind === "execute") assert.match(h.draw(), /Ran 1 shell command/);
  }
});

test("a tool titled with its own name shows the argument it was given and is counted by that name", async () => {
  const h = harness();
  await h.adapter.startTurn("turn", []);
  // DSH sends the tool's name as the title and what it was given in rawInput:
  // every row read "read" or "grep" alone, and the fold counted them all as
  // generic tools.
  for (const [toolCallId, title, rawInput] of [["call-1", "read", { file_path: "/repo/src/adapter.mjs" }],
    ["call-2", "grep", { pattern: "EXECUTION_WINDOW", path: "/repo" }], ["call-3", "bash", { command: "npm test" }]]) {
    await h.update("tool_call", { toolCallId, title, kind: "other", rawInput, status: "pending" });
    await h.update("tool_call_update", { toolCallId, status: "completed" });
  }
  h.view.status = "completed";
  const drawn = h.draw(true);
  assert.match(drawn, /● read: \/repo\/src\/adapter\.mjs/);
  assert.match(drawn, /● grep: EXECUTION_WINDOW/);
  assert.match(drawn, /● bash: npm test/);
  // Folded clauses keep the pane's own order (searches, reads, then tools).
  assert.match(drawn, /Searched for 1 pattern, read 1 file, called 1 tool/);
});

test("a title that says more than the tool's name keeps the agent's own wording", async () => {
  const h = harness();
  await h.adapter.startTurn("turn", []);
  await h.update("tool_call", { toolCallId: "call-1", title: "Inspect fixture", kind: "other", status: "pending",
    rawInput: { path: "README.md" } });
  assert.equal(h.events.at(-1).payload.tool.title, "Inspect fixture");
  // The detail is one line however the argument spelled its breaks, and a
  // value the title already carries is not repeated.
  await h.update("tool_call_update", { toolCallId: "call-2", title: "Shell", kind: "other",
    rawInput: { description: "a\nb  c" } });
  assert.equal(h.events.at(-1).payload.tool.title, "Shell: a b c");
  await h.update("tool_call_update", { toolCallId: "call-2", title: "a b c", rawInput: { description: "a b c" } });
  assert.equal(h.events.at(-1).payload.tool.title, "a b c");
});

test("DSH's task list call becomes the pane's plan instead of a row naming the tool", async () => {
  const h = harness();
  await h.adapter.startTurn("turn", []);
  await h.update("tool_call", { toolCallId: "call-1", title: "todo_write", kind: "other", status: "pending",
    rawInput: { todos: [{ content: "Read the rules", status: "completed" }, { content: "Check the pane", status: "in_progress" }] } });
  await h.update("tool_call_update", { toolCallId: "call-1", status: "completed" });
  assert.deepEqual(h.view.plan.entries.map((entry) => [entry.content, entry.status]),
    [["Read the rules", "completed"], ["Check the pane", "in_progress"]]);
  assert.equal(h.view.tail.length, 0, "the list is drawn at the foot, not as a trace row");
  const drawn = h.draw();
  assert.match(drawn, /Plan · 1\/2/);
  assert.match(drawn, /☑ Read the rules/);
  assert.match(drawn, /▸ Check the pane/);
});

test("Antigravity file reads show the file and requested lines throughout the tool lifecycle", async () => {
  for (const status of ["completed", "failed"]) {
    const h = harness();
    await h.adapter.startTurn("turn", []);
    await h.update("tool_call", { toolCallId: "read", kind: "read", title: "Running view_file", status: "in_progress" });
    assert.match(h.draw(), /Running view_file/);
    await h.update("tool_call_update", { toolCallId: "read",
      rawInput: { file_path: "/repo/src/ExecutionView.jsx", start_line: 0, end_line: 799 } });
    const title = "Running view_file: /repo/src/ExecutionView.jsx (lines 0–799)";
    assert.equal(h.events.at(-1).payload.tool.title, title);
    assert.ok(h.draw().includes(title));
    await h.update("tool_call_update", { toolCallId: "read", status,
      rawOutput: status === "failed" ? "Cannot view file: missing" : "Read ExecutionView.jsx" });
    h.view.status = "completed";
    assert.equal(h.view.tail.length, 1);
    assert.ok(h.draw(true).includes(title));
    assert.equal(h.events.at(-1).payload.tool.error?.message ?? null, status === "failed" ? "Cannot view file: missing" : null);
  }
});

test("Qoder replies stay in the 200-row view when tool lifecycle updates follow them", async () => {
  const h = harness();
  await h.adapter.startTurn("turn", []);
  await h.update("agent_message_chunk", { content: { type: "text", text: "Checking the adapter." } });
  for (let index = 0; index < 75; index++) {
    for (const kind of ["execute", "read"]) {
      const toolCallId = `${kind}-${index}`;
      await h.update("tool_call", { toolCallId, kind, title: kind === "read" ? "Read adapter.mjs" : "pwd", status: "pending" });
      await h.update("tool_call_update", { toolCallId, status: "in_progress" });
      await h.update("tool_call_update", { toolCallId, status: "completed" });
    }
    if (index === 0) await h.update("agent_message_chunk", { content: { type: "text", text: "Found the cause." } });
  }
  await h.adapter.completeTurn({ stopReason: "end_turn" });
  assert.equal(h.view.tail.length, 152);
  assert.deepEqual(h.view.tail.filter((event) => event.type.startsWith("message.")).map((event) => event.body),
    ["Checking the adapter.", "Found the cause."]);
  assert.match(h.draw(), /Checking the adapter\./);
  assert.match(h.draw(), /Found the cause\./);
});

test("ACP user echoes stay out of assistant text and match Codex's hidden userMessage items", async () => {
  const h = harness();
  await h.adapter.startTurn("turn", []);
  for (const [sessionUpdate, text] of [["agent_message_chunk", "Answer"], ["user_message_chunk", "Internal prompt echo"]]) {
    await h.update(sessionUpdate, { messageId: "same-id", content: { type: "text", text } });
  }
  assert.equal(h.view.lastMessage.text, "Answer");
  await h.adapter.completeTurn({ stopReason: "end_turn" });
  const echo = h.events.find((event) => event.type === "message.completed" && event.payload.message.role === "user");
  assert.equal(renderJobEvent(echo), null);
  assert.match(renderJobEvent(echo, { verbose: true }), /^user:/);
  assert.doesNotMatch(h.draw(), /Internal prompt echo/);
});

test("ACP item, Markdown and file plans render and plan_removed clears them", async () => {
  for (const [plan, expected] of [
    [{ type: "items", entries: [{ content: "Check adapter", status: "pending" }] }, "Check adapter"],
    [{ type: "markdown", content: "Check adapter\nThen run tests" }, "Check adapter\nThen run tests"],
    [{ type: "file", uri: "file:///repo/plan.md" }, "file:///repo/plan.md"],
  ]) {
    const h = harness();
    await h.update("plan_update", { plan: { planId: "plan", ...plan } });
    assert.ok(h.draw().includes(expected), plan.type);
    await h.update("plan_removed", { planId: "plan" });
    assert.ok(!h.draw().includes(expected), plan.type);
  }
});
