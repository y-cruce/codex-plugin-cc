import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { AcpExecutorJobPort } from "../plugins/codex/scripts/lib/executors/acp-driver.mjs";
import { createCanonicalEvent } from "../plugins/codex/scripts/lib/executor-events.mjs";
import { inactiveRoundMessage, sendLiveCommand } from "../plugins/codex/scripts/lib/live-commands.mjs";
import { LiveTurnControl } from "../plugins/codex/scripts/lib/live-turn-control.mjs";
import { ObservationClient } from "../plugins/codex/scripts/lib/observation-client.mjs";
import { renderBriefJobStatus } from "../plugins/codex/scripts/lib/render.mjs";
import { upsertJob, writeJobFile } from "../plugins/codex/scripts/lib/state.mjs";
import { bindProvisionalDispatch, bufferProvisionalEvent, createProvisionalDispatch } from "../plugins/codex/scripts/lib/thread-record-binding.mjs";
import { isolateTestEnvironment, makeTempDir } from "./helpers.mjs";

function setup(t, snapshot) {
  isolateTestEnvironment(t);
  const cwd = makeTempDir();
  const job = { id: "acp-answers", jobClass: "task", status: "running", executor: "acp",
    executorSessionId: "session-1", turnId: "turn-1", workspaceRoot: cwd };
  writeJobFile(cwd, job.id, job);
  upsertJob(cwd, job);
  const requests = [];
  t.mock.method(ObservationClient, "connect", async () => ({
    request: async (method, params) => {
      requests.push({ method, params });
      return method === "executor/status" ? snapshot : { answered: true };
    },
    close() {}
  }));
  return { cwd, job, requests };
}

test("permission answers accept offered values or a unique exact label", async (t) => {
  const options = [
    { value: "proceed_once", label: "Allow" },
    { value: "cancel", label: "Reject" },
    { value: "duplicate-1", label: "Duplicate" },
    { value: "duplicate-2", label: "Duplicate" }
  ];
  const h = setup(t, { questions: [{ requestId: "permission:1", turnId: "question-turn", kind: "permission",
    questions: [{ id: "optionId", options }] }] });
  const answersFile = path.join(h.cwd, "answers.json");
  for (const [answers, expected] of [
    [["Allow"], "proceed_once"], [["proceed_once"], "proceed_once"], [["Reject"], "cancel"],
    [["Duplicate"], null], [["allow"], null], [["unknown"], null], [["Allow", "Reject"], null], [[], null]
  ]) {
    h.requests.length = 0;
    fs.writeFileSync(answersFile, JSON.stringify({ optionId: { answers } }));
    const result = sendLiveCommand(h.cwd, h.job.id, "answer", { "request-id": "permission:1", "answers-file": answersFile });
    if (expected === null) {
      await assert.rejects(result, /exactly one offered option/i, JSON.stringify(answers));
      assert.deepEqual(h.requests.map((request) => request.method), ["executor/status"]);
    } else {
      await result;
      assert.deepEqual(h.requests.at(-1), { method: "executor/answer-permission", params: {
        jobId: h.job.id, executorSessionId: "session-1", turnId: "question-turn", requestId: "permission:1",
        outcome: "selected", optionId: expected
      } }, JSON.stringify(answers));
    }
  }
});

test("unsupported mid-turn steering suggests queue before interrupt", async (t) => {
  const h = setup(t, { capabilities: { midTurnSteer: false } });
  await assert.rejects(sendLiveCommand(h.cwd, h.job.id, "message", {}, "more context"),
    /cannot add a message to the active turn.*--queue.*--interrupt/i);
  assert.deepEqual(h.requests.map((request) => request.method), ["executor/status"]);
});

test("pending-question steer refusal lists MCP actions and reuses the status QUESTION format across Codex and ACP", async () => {
  const codexControl = new LiveTurnControl({ cwd: "/repo", respond() {}, exitPromise: new Promise(() => {}) }, () => {});
  codexControl.observe({ method: "turn/started", params: { threadId: "thr-1", turn: { id: "turn-1" } } });
  codexControl.handleServerRequest({
    id: "req-codex",
    method: "item/tool/requestUserInput",
    params: {
      threadId: "thr-1",
      turnId: "turn-1",
      questions: [{
        id: "scope",
        question: "Which target?\nPick one.",
        options: [{ label: "Unit", description: "Fast check" }, { label: "Full", description: "All suites" }]
      }]
    }
  });

  const makeAcpPort = () => {
    const port = new AcpExecutorJobPort({ cwd: "/repo", job: { id: "job-acp" }, command: "dsh" });
    port.capabilities.midTurnSteer = true;
    port.sessionId = "sess-1";
    port.activeTurn = { turnId: "turn-1", accepting: true, messages: [] };
    return port;
  };

  const acpQuestionPort = makeAcpPort();
  acpQuestionPort.questions.set("question:1", {
    requestId: "question:1",
    turnId: "turn-1",
    expiresAt: Date.now() + 60_000,
    payload: {
      message: "Choose fallback",
      fields: [{ id: "mode", title: "Choose fallback", description: "How should we proceed?",
        options: [{ label: "Keep", description: "Preserve state" }, { label: "Reset", description: "Clean state" }] }]
    }
  });

  const acpPermissionPort = makeAcpPort();
  acpPermissionPort.permissions.set("permission:1", {
    requestId: "permission:1",
    turnId: "turn-1",
    payload: {
      interaction: false,
      tool: { title: "Run rm -rf build" },
      options: [{ name: "Allow once", optionId: "allow_once" }, { name: "Reject", optionId: "reject" }]
    }
  });

  try {
    for (const [label, steer, live] of [
      ["codex user-input question",
        () => codexControl.request("turn/steer", { threadId: "thr-1", expectedTurnId: "turn-1", input: [{ type: "text", text: "steer" }] }),
        codexControl.snapshot("thr-1")],
      ["acp elicitation question",
        () => acpQuestionPort.steerPrompt({ sessionId: "sess-1", turnId: "turn-1", prompt: [{ type: "text", text: "steer" }] }),
        acpQuestionPort.liveStatus()],
      ["acp permission question",
        () => acpPermissionPort.steerPrompt({ sessionId: "sess-1", turnId: "turn-1", prompt: [{ type: "text", text: "steer" }] }),
        acpPermissionPort.liveStatus()],
    ]) {
      const statusQuestionLine = renderBriefJobStatus({ id: "job-1", status: "running", live })
        .split("\n")
        .find((line) => line.startsWith("QUESTION "));
      assert.ok(statusQuestionLine, label);
      await assert.rejects(steer, (error) => {
        assert.equal(/[\r\n]/.test(error.message), false, `${label}: single line`);
        assert.doesNotMatch(error.message, /--interrupt/);
        assert.match(error.message, /\banswer\b/);
        assert.match(error.message, /delivery: "queue"/);
        assert.match(error.message, /delivery: "interrupt"/);
        assert.ok(error.message.endsWith(statusQuestionLine), `${label}: expected suffix ${statusQuestionLine}, got ${error.message}`);
        return true;
      }, label);
    }
  } finally {
    codexControl.close();
  }
});

test("inactive round message distinguishes finished threads from superseded rounds and names next steps", async (t) => {
  isolateTestEnvironment(t);
  const cwd = makeTempDir();
  const job = { id: "task-done", label: "done", workspaceRoot: cwd, executor: "codex", jobClass: "task",
    threadId: "thr-done", status: "completed", startedAt: "2026-10-20T00:00:00.000Z", completedAt: "2026-10-20T00:01:00.000Z" };
  writeJobFile(cwd, job.id, job);
  upsertJob(cwd, job);
  const provisional = createProvisionalDispatch({ workspaceRoot: cwd, job });
  for (const [type, payload] of [
    ["job.started", { label: job.label, startedAt: job.startedAt, sessionId: null, prompt: "go", resumed: false }],
    ["job.completed", { status: "completed", reason: { code: "end_turn", backendCode: null, message: null, retryable: false },
      completedAt: job.completedAt, finalMessages: [], error: null, result: null }]
  ]) {
    bufferProvisionalEvent(provisional, createCanonicalEvent({
      job, type, identity: { sessionId: job.threadId, turnId: "turn-1" },
      occurredAt: job.startedAt, receivedAt: job.startedAt, payload, source: { protocol: "local", method: type, raw: null }
    }));
  }
  await bindProvisionalDispatch(provisional, job.threadId);

  for (const [label, activeId, pattern] of [
    ["superseded round", "task-next", /^Job task-done is not the active round; active job is task-next\.$/],
    ["finished thread", null, /^Job task-done has finished \(no active round\)\. .*result.*message \(delivery: "queue"\).*dispatch \(mode: "continue"\)\.$/],
  ]) {
    const text = inactiveRoundMessage(job.id, activeId);
    assert.equal(/[\r\n]/.test(text), false, label);
    assert.match(text, pattern, label);
  }

  await assert.rejects(
    sendLiveCommand(cwd, job.id, "message", {}, "late correction"),
    (error) => error.code === "STALE_ROUND" && error.message === inactiveRoundMessage(job.id, null)
  );
});
