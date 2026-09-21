import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { JobRuntime } from "../plugins/codex/scripts/lib/job-runtime.mjs";
import { readHistory } from "../plugins/codex/scripts/lib/job-event-store.mjs";
import { CodexEventAdapter, normalizeCodexEvent as normalizeJobEvent } from "../plugins/codex/scripts/lib/executors/codex-event-adapter.mjs";
import { applyJobEvent, createLiveView, renderJobEvent } from "../plugins/codex/scripts/lib/job-event-model.mjs";
import { writeJobFile, upsertJob } from "../plugins/codex/scripts/lib/state.mjs";
import { initGitRepo, isolateTestEnvironment, makeTempDir } from "./helpers.mjs";

const activity = (kind, method = "item/started") => ({ method, params: { threadId: "parent", turnId: "turn-parent",
  item: { type: "subAgentActivity", id: `call-${kind}`, kind, agentThreadId: "child", agentPath: "/root/review_41_44" } } });
const childMessage = (text) => ({ method: "item/completed", params: { threadId: "child", turnId: "turn-child",
  item: { type: "agentMessage", id: `message-${text}`, text } } });

test("subAgentActivity of every kind binds buffered and future child events to one job", async (t) => {
  isolateTestEnvironment(t);
  const cwd = fs.realpathSync(makeTempDir());
  initGitRepo(cwd);
  for (const kind of ["started", "interacted", "interrupted", "completed"]) {
    const job = { id: `task-${kind}`, status: "running", workspaceRoot: cwd, pid: process.pid, threadId: "parent" };
    writeJobFile(cwd, job.id, job);
    upsertJob(cwd, job);
    const runtime = new JobRuntime({ threadRecords: false });
    const owner = {};
    const adapter = new CodexEventAdapter((event) => runtime.record(event));
    try {
      await runtime.register(owner, cwd, job.id);
      await adapter.bindSession("parent", job);
      await adapter.accept(childMessage("buffered"));
      assert.equal(adapter.pending.get("child").length, 1);
      await adapter.accept(activity(kind));
      assert.equal(adapter.pending.has("child"), false);
      await adapter.accept(childMessage("future"));
      await adapter.accept(activity(kind, "item/completed"));
      await adapter.accept(childMessage("late"));
      const entry = [...runtime.jobs.values()][0];
      await entry.store.flush();
      const history = await readHistory(cwd, job.id);
      const children = history.events.filter((event) => event.identity.sessionId === "child");
      assert.equal(children.length, 3);
      for (const event of children) {
        assert.equal(event.jobId, job.id);
        assert.deepEqual(event.agent, { id: "child", path: "review_41_44", parentId: "parent" });
        assert.match(renderJobEvent(event), /^\[review_41_44\] assistant:/);
        assert.equal(event.source.raw.params.threadId, "child");
      }
      assert.equal(entry.view.lastMessage, null);
      assert.equal(entry.view.subAgents[0].status, kind);
      assert.equal(entry.view.tail.filter((row) => row.agent === "review_41_44").length, 3);
      assert.ok(entry.view.tail.some((row) => row.text === `⇢ sub-agent review_41_44 ${kind}`));
      assert.ok(entry.view.tail.every((row) => !row.text.includes("call-")));
    } finally { await runtime.close(); }
  }
});

test("a new root job replaces the thread binding and retires the old job's child sessions", async () => {
  const recorded = [];
  const adapter = new CodexEventAdapter((event) => recorded.push(event));
  const first = { id: "task-first", threadId: "parent" };
  const second = { id: "task-second", threadId: "parent" };
  await adapter.bindSession("parent", first);
  await adapter.accept(activity("started"));
  assert.equal(adapter.sessions.get("child").job.id, first.id);

  await adapter.bindSession("parent", second);
  assert.equal(adapter.sessions.get("parent").job.id, second.id);
  assert.equal(adapter.sessions.has("child"), false);
  assert.equal(adapter.inactive.has("child"), true);
  assert.equal(await adapter.accept(childMessage("late from first")), false);
  assert.equal(adapter.pending.has("child"), false);

  await adapter.accept({ method: "turn/started", params: { threadId: "parent", turn: { id: "turn-second" } } });
  assert.equal(recorded.at(-1).jobId, second.id);
});

test("child messages and questions do not replace the parent's current state", () => {
  const job = { id: "task", threadId: "parent" };
  const view = createLiveView(job);
  let seq = 0;
  const accept = (message, agent = false) => {
    const event = normalizeJobEvent(message, job, agent ? { id: "child", path: "review_41_44", parentId: "parent" } : null);
    event.seq = String(++seq);
    applyJobEvent(view, event);
    return event;
  };
  accept({ method: "item/completed", params: { threadId: "parent", turnId: "turn-parent", item: { type: "agentMessage", id: "parent-message", text: "parent conclusion" } } });
  accept({ method: "companion/question", params: { threadId: "parent", requestId: "parent-question", questions: [{ question: "Parent question?" }] } });
  const original = structuredClone({ lastMessage: view.lastMessage, pendingQuestion: view.pendingQuestion, status: view.status, threadId: view.threadId, turnId: view.turnId });
  accept(activity("started"));
  accept({ method: "turn/started", params: { threadId: "child", turn: { id: "turn-child" } } }, true);
  accept({ method: "item/agentMessage/delta", params: { threadId: "child", turnId: "turn-child", itemId: "child-message", delta: "x".repeat(400) } }, true);
  accept(childMessage("child conclusion"), true);
  accept({ method: "item/reasoning/summaryTextDelta", params: { threadId: "child", itemId: "reason", delta: "child reasoning" } }, true);
  accept({ method: "item/completed", params: { threadId: "child", item: { type: "reasoning", id: "reason", summary: ["reasoned"] } } }, true);
  accept({ method: "companion/question", params: { threadId: "child", requestId: "child-question", questions: [{ question: "Child?" }] } }, true);
  assert.deepEqual({ lastMessage: view.lastMessage, pendingQuestion: view.pendingQuestion, status: view.status, threadId: view.threadId, turnId: view.turnId }, original);
  assert.ok(view.tail.filter((row) => row.agent).every((row) => row.text.startsWith("[review_41_44] ")));
  const done = accept(activity("completed", "item/completed"));
  assert.equal(view.subAgents[0].endedAt, done.occurredAt);
  assert.equal(view.subAgents[0].status, "completed");
});

test("agent summaries retain activity and original positions after replacement, truncation and terminal events", () => {
  const job = { id: "task", threadId: "parent" };
  const view = createLiveView(job);
  let seq = 0;
  const accept = (message, child = false) => {
    const event = normalizeJobEvent(message, job, child ? { id: "child", path: "review_41_44", parentId: "parent" } : null);
    event.seq = String(++seq);
    applyJobEvent(view, event);
    return event;
  };
  const started = accept(activity("started"));
  const command = { type: "commandExecution", id: "command", command: "pwd", cwd: "/work" };
  accept({ method: "item/started", params: { threadId: "child", item: command } }, true);
  assert.equal(view.activeCommands[0].agentThreadId, "child");
  assert.equal(view.subAgents[0].lastActivity, "$ pwd");
  const position = view.tail[1].positionSeq;
  accept(childMessage("progress"), true);
  accept({ method: "item/completed", params: { threadId: "child", item: { ...command, exitCode: 0 } } }, true);
  assert.equal(view.tail[1].positionSeq, position);
  assert.equal(view.tail[1].seq, "4");
  assert.equal(view.tail[1].agentThreadId, "child");
  assert.equal(view.subAgents[0].startedSeq, started.seq);
  assert.match(view.subAgents[0].lastActivity, /pwd/);
  accept(childMessage("final result"), true);
  accept(activity("completed", "item/completed"));
  accept(activity("interacted"));
  accept(childMessage("late message"), true);
  assert.equal(view.subAgents[0].status, "completed");
  assert.equal(view.subAgents[0].lastActivity, "assistant: final result");
  for (let index = 0; index < 210; index++) {
    accept({ method: "item/completed", params: { threadId: "parent", item: { type: "agentMessage", id: `parent-${index}`, text: "parent activity" } } });
  }
  assert.equal(view.tail.length, 200);
  assert.ok(view.tail.every(row => !row.agentThreadId));
  assert.equal(view.subAgents[0].lastActivity, "assistant: final result");
  assert.equal(view.subAgents[0].startedSeq, started.seq);
  accept(activity("started"));
  accept({ method: "turn/completed", params: { threadId: "child", turn: { id: "failed-turn", status: "failed", error: { message: "child failed" } } } }, true);
  accept(activity("completed", "item/completed"));
  accept(childMessage("late after failure"), true);
  assert.equal(view.subAgents[0].status, "failed");
  assert.equal(view.subAgents[0].lastActivity, "child failed");
});

test("a child observed before its lifecycle gets the eventual agent name without losing activity", () => {
  const job = { id: "task", threadId: "parent" };
  const view = createLiveView(job);
  const message = normalizeJobEvent(childMessage("early progress"), job, { id: "child", path: "child", parentId: "parent" });
  message.seq = "1";
  applyJobEvent(view, message);
  const started = normalizeJobEvent(activity("started"), job);
  started.seq = "2";
  applyJobEvent(view, started);
  assert.equal(view.subAgents.length, 1);
  assert.equal(view.subAgents[0].path, "review_41_44");
  assert.equal(view.subAgents[0].lastActivity, "assistant: early progress");
  assert.equal(view.subAgents[0].startedSeq, "1");
});
