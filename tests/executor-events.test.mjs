import test from "node:test";
import assert from "node:assert/strict";

import { CANONICAL_EVENT_TYPES, assertCanonicalEventDraft, createCanonicalEvent } from "../plugins/codex/scripts/lib/executor-events.mjs";
import { AcpEventAdapter } from "../plugins/codex/scripts/lib/executors/acp-event-adapter.mjs";
import { renderJobEvent } from "../plugins/codex/scripts/lib/job-event-model.mjs";

test("canonical event validation accepts complete events and rejects malformed envelopes and payloads", () => {
  const event = createCanonicalEvent({
    job: { id: "job-1" },
    type: "message.delta",
    identity: { sessionId: "session", turnId: "turn", messageId: "message" },
    occurredAt: "2026-09-18T00:00:00.000Z",
    receivedAt: "2026-09-18T00:00:00.000Z",
    payload: { role: "assistant", block: { type: "text", text: "hello" } },
    source: { protocol: "codex-app-server", method: "item/agentMessage/delta", raw: { delta: "hello" } }
  });
  assert.equal(assertCanonicalEventDraft(event), event);
  assert.ok(CANONICAL_EVENT_TYPES.has("history.recording.failed"));
  assert.throws(() => assertCanonicalEventDraft({ ...event, schemaVersion: 1 }), { code: "INVALID_CANONICAL_EVENT" });
  assert.throws(() => assertCanonicalEventDraft({ ...event, type: "unknown.event" }), { code: "INVALID_CANONICAL_EVENT" });
  assert.throws(() => assertCanonicalEventDraft({ ...event, identity: { ...event.identity, turnId: 1 } }), { code: "INVALID_CANONICAL_EVENT" });
  const { block, ...incomplete } = event.payload;
  assert.throws(() => assertCanonicalEventDraft({ ...event, payload: incomplete }), { code: "INVALID_CANONICAL_EVENT" });
});

test("an ACP edit that changes no file is reported as the tool it is", async () => {
  // Qoder declares every task it creates as an "edit" whose diff has neither
  // old nor new text and whose path is the word "file". Routed by kind alone,
  // each task drew two phantom file changes -- "Files in_progress: delete file"
  // -- and the pane counted files that were never touched.
  const events = [];
  const adapter = new AcpEventAdapter((event) => events.push(event), { job: { id: "job-1" } });
  adapter.bindSession("session-1");
  const call = {
    toolCallId: "fc_1", title: "Edit file", kind: "edit", status: "pending",
    content: [{ type: "diff", path: "file", oldText: "", newText: "" }],
    locations: [{ path: "file" }],
    rawInput: { subject: "审查运行时清单兼容性" },
    _meta: { qoder: { toolName: "TaskCreate" } }
  };
  await adapter.accept({ sessionId: "session-1", update: { ...call, sessionUpdate: "tool_call" } });
  await adapter.accept({ sessionId: "session-1", update: { toolCallId: "fc_1", status: "completed",
    rawOutput: "Task #1 created", sessionUpdate: "tool_call_update" } });
  assert.deepEqual(events.map((event) => event.type), ["tool.started", "tool.completed"]);
  // The events are kept -- history records what the agent called -- and the
  // row is not: the plan says what the task list changed.
  assert.equal(renderJobEvent(events[1]), null);
  assert.match(renderJobEvent(events[1], { verbose: true }), /TaskCreate/);
  // The pane drops the name a row is prefixed with, so the vendor's own name
  // travels in the title, in place of the file edit this never was.
  assert.equal(events[0].payload.tool.title, "TaskCreate");
  // Its completion replaces the diff with a result: without the decision made
  // at creation, the locations fallback finds the phantom path again and the
  // way out reports a file change the way in refused.
  assert.deepEqual(events[1].payload.tool.files, []);

  const real = [];
  const editor = new AcpEventAdapter((event) => real.push(event), { job: { id: "job-2" } });
  editor.bindSession("session-1");
  await editor.accept({ sessionId: "session-1", update: { toolCallId: "fc_2", title: "Edit", kind: "edit", status: "pending",
    content: [{ type: "diff", path: "/repo/a.ts", oldText: "one", newText: "two" }], sessionUpdate: "tool_call" } });
  assert.deepEqual(real.map((event) => event.type), ["fileChange.started"]);
  assert.deepEqual(real[0].payload.files.map((file) => file.path), ["/repo/a.ts"]);
});

test("an ACP sub-agent is reported as a sub-agent, not as a tool called Agent", async () => {
  // Qoder runs a sub-agent through a tool call named "Agent" whose input names
  // the agent and what it was asked for. Routed as a tool, the row read "Agent"
  // and nothing else, while the same pane draws Codex's sub-agents by name,
  // status and activity.
  const events = [];
  const adapter = new AcpEventAdapter((event) => events.push(event), { job: { id: "job-1" } });
  adapter.bindSession("session-1");
  const rawInput = { subagent_type: "Explore", description: "locate the bare imports", prompt: "…" };
  await adapter.accept({ sessionId: "session-1", update: { toolCallId: "fc_1", title: "Agent", kind: "think",
    status: "pending", rawInput, sessionUpdate: "tool_call" } });
  // A sub-agent reports back in full on the same tool call: the report is the
  // news, and the line it lands on has room for the sentence that answers the
  // ask, not for the heading or the table under it.
  await adapter.accept({ sessionId: "session-1", update: { toolCallId: "fc_1", status: "completed",
    content: [{ type: "content", content: { type: "text", text: "## Result\n\nSeven bare imports, all declared.\n\n| a | b |\n|---|---|" } }],
    sessionUpdate: "tool_call_update" } });
  assert.deepEqual(events.map((event) => event.type), ["agent.activity", "agent.activity"]);
  assert.deepEqual(events.map((event) => event.payload.status), ["started", "completed"]);
  assert.equal(events[0].payload.path, "Explore");
  assert.equal(events[0].payload.detail, "locate the bare imports");
  assert.equal(events[0].identity.agentId, "fc_1");
  assert.equal(events[1].payload.detail, "Seven bare imports, all declared.");
});

test("what a sub-agent does while the parent waits is the sub-agent's", async () => {
  // A sub-agent's messages and tool calls arrive on the session the parent is
  // using, with nothing on them to say whose they are: the trace ran the two
  // together and the reader could not tell which was which. The parent is
  // waiting while the call it made runs, so the window between that call's
  // start and its end belongs to the sub-agent.
  const events = [];
  const adapter = new AcpEventAdapter((event) => events.push(event), { job: { id: "job-1" } });
  adapter.bindSession("session-1");
  await adapter.startTurn("turn-1", []);
  const say = (text) => adapter.accept({ sessionId: "session-1", update: { sessionUpdate: "agent_message_chunk",
    content: { type: "text", text } } });
  await say("planning first");
  await adapter.accept({ sessionId: "session-1", update: { toolCallId: "ag", title: "Agent", kind: "think",
    status: "pending", rawInput: { subagent_type: "Explore", description: "sweep the adapters" }, sessionUpdate: "tool_call" } });
  await say("reading both adapters");
  await adapter.accept({ sessionId: "session-1", update: { toolCallId: "r1", title: "Read …/acp.mjs", kind: "read",
    status: "completed", sessionUpdate: "tool_call" } });
  await adapter.accept({ sessionId: "session-1", update: { toolCallId: "ag", status: "completed", sessionUpdate: "tool_call_update" } });
  await say("now I write it up");
  const owners = events.filter((event) => /^(message|tool)\./.test(event.type))
    .map((event) => `${event.agent?.path ?? "parent"}:${event.type}`);
  assert.deepEqual(owners, ["parent:message.started", "parent:message.delta", "parent:message.completed",
    "Explore:message.started", "Explore:message.delta", "Explore:tool.started", "Explore:tool.completed",
    "Explore:message.completed", "parent:message.started", "parent:message.delta"]);
  // Qoder sends no message id, so every chunk of a turn fell into one message:
  // both speakers' words ran together and the whole of it was attributed to
  // whoever was speaking when it closed.
  const said = (agent) => events.filter((event) => event.type === "message.completed" && (event.agent?.path ?? null) === agent)
    .map((event) => event.payload.message.text);
  assert.deepEqual(said(null), ["planning first"]);
  assert.deepEqual(said("Explore"), ["reading both adapters"]);
});
