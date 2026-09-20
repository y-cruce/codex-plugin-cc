import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { openAcpExecutorJob } from "../plugins/codex/scripts/lib/executors/acp-driver.mjs";
import { ObservationClient } from "../plugins/codex/scripts/lib/observation-client.mjs";
import { readHistory, resolveLiveViewPath } from "../plugins/codex/scripts/lib/job-event-store.mjs";
import { listJobs, upsertJob, writeJobFile } from "../plugins/codex/scripts/lib/state.mjs";
import { initGitRepo, isolateTestEnvironment, makeTempDir, run } from "./helpers.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const AGENT = path.join(ROOT, "tests/fake-acp-agent.mjs");
const SCRIPT = path.join(ROOT, "plugins/codex/scripts/codex-companion.mjs");

async function waitFor(predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for ACP state");
}

async function setupPort(t, id = "acp-job", options = {}) {
  isolateTestEnvironment(t);
  const cwd = fs.realpathSync(makeTempDir());
  initGitRepo(cwd);
  const job = { id, executor: "acp", workspaceRoot: cwd, status: "running", title: "ACP test",
    createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), pid: process.pid };
  writeJobFile(cwd, id, job);
  upsertJob(cwd, job);
  const port = await openAcpExecutorJob({ cwd, job, command: process.execPath, args: [AGENT], env: options.env,
    modelId: options.modelId, effortId: options.effortId });
  t.after(() => port.close());
  const events = [];
  const pump = (async () => { for await (const event of port.events()) events.push(event); })();
  t.after(() => pump);
  const session = await port.startSession({ cwd, additionalDirectories: [], mcpServers: [], modeId: "default",
    modelId: options.modelId, effortId: options.effortId });
  return { cwd, job, port, events, session };
}

function readRecording(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test("ACP initialization failure closes the spawned agent", async (t) => {
  isolateTestEnvironment(t);
  const cwd = fs.realpathSync(makeTempDir());
  initGitRepo(cwd);
  const pidFile = path.join(makeTempDir(), "agent.pid");
  const job = { id: "acp-init-failure", executor: "acp", workspaceRoot: cwd, status: "running", title: "ACP test",
    createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), pid: process.pid };
  writeJobFile(cwd, job.id, job);
  upsertJob(cwd, job);
  let childPid = null;
  t.after(() => { if (childPid && processAlive(childPid)) process.kill(childPid, "SIGKILL"); });

  await assert.rejects(openAcpExecutorJob({ cwd, job, command: process.execPath, args: [AGENT],
    env: { ...process.env, ACP_FAKE_INITIALIZE_ERROR: "1", ACP_FAKE_PID_FILE: pidFile } }));
  childPid = Number(fs.readFileSync(pidFile, "utf8").trim());
  assert.equal(processAlive(childPid), false, "ACP child remained alive after initialize failed");
});

test("ACP basic turn normalizes all session update variants and preserves tool patches", async (t) => {
  const h = await setupPort(t, "acp-basic");
  const turn = await h.port.startTurn({ sessionId: h.session.sessionId, prompt: [{ type: "text", text: "basic" }] });
  const terminal = await turn.done;
  assert.equal(terminal.status, "completed");
  assert.equal(terminal.reason.code, "end_turn");
  assert.equal(terminal.finalMessages.find((message) => message.role === "assistant").text, "Basic complete");
  const discriminators = new Set(h.events.map((event) => event.source.raw?.update?.sessionUpdate).filter(Boolean));
  assert.deepEqual([...discriminators].sort(), ["agent_message_chunk", "agent_thought_chunk", "available_commands_update",
    "compaction_summary_chunk", "compaction_update", "config_option_update", "current_mode_update", "plan", "plan_removed",
    "plan_update", "session_info_update", "tool_call", "tool_call_update", "usage_update", "user_message_chunk"].sort());
  const completed = h.events.find((event) => event.type === "tool.completed");
  assert.equal(completed.payload.tool.title, "Inspect fixture");
  assert.equal(completed.payload.tool.rawInput.path, "README.md");
  const contextUsage = h.events.find((event) => event.type === "usage.updated" && event.payload.usage.basis === "context");
  assert.equal(contextUsage.payload.usage.inputTokens, null);
  assert.equal(contextUsage.payload.usage.complete, false);
  assert.ok(h.events.filter((event) => event.type === "source.unknown").length >= 6);
});

test("ACP permission and elicitation stay distinct and resolve through pending maps", async (t) => {
  const h = await setupPort(t, "acp-input");
  const permissionTurn = await h.port.startTurn({ sessionId: h.session.sessionId, prompt: [{ type: "text", text: "permission" }] });
  const permission = await waitFor(() => [...h.port.permissions.values()][0]);
  assert.equal(permission.payload.options[0].kind, "allow_once");
  await h.port.answerPermission({ requestId: permission.requestId, outcome: "selected", optionId: "allow" });
  assert.equal((await permissionTurn.done).status, "completed");
  const questionTurn = await h.port.startTurn({ sessionId: h.session.sessionId, prompt: [{ type: "text", text: "question" }] });
  const question = await waitFor(() => [...h.port.questions.values()][0]);
  assert.deepEqual(question.payload.fields.map((field) => field.kind), ["text", "single_select", "multi_select", "boolean"]);
  await h.port.answerQuestion({ requestId: question.requestId, action: "accept",
    values: { name: "Ada", choice: "a", tags: ["x"], enabled: true } });
  assert.equal((await questionTurn.done).status, "completed");
  assert.ok(h.events.some((event) => event.type === "permission.resolved"));
  assert.ok(h.events.some((event) => event.type === "question.resolved"));
});

test("ACP resume emits no replay and stop reasons retain failure semantics", async (t) => {
  const recording = path.join(makeTempDir(), "acp-recording.jsonl");
  const h = await setupPort(t, "acp-resume", { env: { ...process.env, ACP_FAKE_RECORDING: recording } });
  const first = await h.port.startTurn({ sessionId: h.session.sessionId, prompt: [{ type: "text", text: "basic" }] });
  await first.done;
  const before = h.events.length;
  await h.port.resumeSession({ sessionId: h.session.sessionId, cwd: h.cwd, additionalDirectories: [], mcpServers: [],
    modelId: "performance" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(h.events.length, before);
  const request = readRecording(recording).filter((entry) => entry.method === "session/set_config_option").at(-1);
  assert.deepEqual(request.params, { sessionId: h.session.sessionId, configId: "model", value: "performance" });
  for (const code of ["max_tokens", "max_turn_requests", "refusal"]) {
    const turn = await h.port.startTurn({ sessionId: h.session.sessionId, prompt: [{ type: "text", text: `stop:${code}` }] });
    const terminal = await turn.done;
    assert.equal(terminal.status, "failed", code);
    assert.equal(terminal.reason.code, code, code);
  }
});

test("ACP cancel waits for late updates and closes pending input requests", async (t) => {
  const h = await setupPort(t, "acp-cancel");
  const turn = await h.port.startTurn({ sessionId: h.session.sessionId, prompt: [{ type: "text", text: "cancel-late" }] });
  const terminal = await h.port.interruptTurn({ sessionId: h.session.sessionId, turnId: turn.turnId, timeoutMs: 5000,
    replacementPrompt: [{ type: "text", text: "replacement" }] });
  assert.equal(terminal.status, "interrupted");
  assert.equal(terminal.reason.backendCode, "cancelled");
  assert.equal(h.port.takeReplacementPrompt()[0].text, "replacement");
  const late = h.events.findIndex((event) => event.type === "message.delta" && event.payload.block.text === "late update 1");
  const completed = h.events.findIndex((event) => event.type === "turn.completed");
  assert.ok(late >= 0 && completed > late);

  const permissionTurn = await h.port.startTurn({ sessionId: h.session.sessionId, prompt: [{ type: "text", text: "permission" }] });
  await waitFor(() => h.port.permissions.size === 1);
  const cancelled = await h.port.cancelJob({ sessionId: h.session.sessionId, turnId: permissionTurn.turnId, timeoutMs: 5000 });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(h.port.permissions.size, 0);

  const questionTurn = await h.port.startTurn({ sessionId: h.session.sessionId, prompt: [{ type: "text", text: "question" }] });
  await waitFor(() => h.port.questions.size === 1);
  const questionCancelled = await h.port.cancelJob({ sessionId: h.session.sessionId, turnId: questionTurn.turnId, timeoutMs: 5000 });
  assert.equal(questionCancelled.status, "cancelled");
  assert.deepEqual(h.events.filter((event) => event.type === "permission.resolved" || event.type === "question.closed")
    .map((event) => [event.type, event.payload.outcome ?? event.payload.reason]), [
      ["permission.resolved", "cancelled"],
      ["question.closed", "cancelled"]
    ]);

  let stderr = "";
  const stderrWrite = t.mock.method(process.stderr, "write", (chunk) => { stderr += chunk; return true; });
  try { await h.port.close(); } finally { stderrWrite.mock.restore(); }
  const history = await readHistory(h.cwd, h.job.id);
  assert.deepEqual({
    finalToolPersisted: history.events.some((event) => event.type === "tool.completed" && event.identity.toolCallId === "late-tool-3"),
    finalMessagePersisted: history.events.some((event) => event.type === "message.delta" && event.payload.block.text === "late update 3"),
    closedStoreDiagnostic: stderr.includes("History store is not open")
  }, {
    finalToolPersisted: true,
    finalMessagePersisted: true,
    closedStoreDiagnostic: false
  });
});

test("ACP redirect prompt is discarded when cancellation loses to natural completion", async (t) => {
  const h = await setupPort(t, "acp-cancel-natural");
  const turn = await h.port.startTurn({ sessionId: h.session.sessionId, prompt: [{ type: "text", text: "cancel-natural" }] });
  const terminal = await h.port.interruptTurn({ sessionId: h.session.sessionId, turnId: turn.turnId, timeoutMs: 5000,
    replacementPrompt: [{ type: "text", text: "must not run" }] });
  assert.equal(terminal.status, "completed");
  assert.equal(h.port.takeReplacementPrompt(), null);
});

test("ACP terminal tool calls emit both lifecycle endpoints from their first update", async (t) => {
  const h = await setupPort(t, "acp-terminal-tools");
  const turn = await h.port.startTurn({ sessionId: h.session.sessionId, prompt: [{ type: "text", text: "terminal-tool-calls" }] });
  assert.equal((await turn.done).status, "completed");
  assert.deepEqual(h.events.filter((event) => event.identity.toolCallId?.startsWith("terminal-"))
    .map((event) => [event.identity.toolCallId, event.type, event.payload.status ?? event.payload.tool?.status]), [
      ["terminal-generic", "tool.started", "completed"],
      ["terminal-generic", "tool.completed", "completed"],
      ["terminal-command", "command.started", undefined],
      ["terminal-command", "command.completed", "failed"],
      ["terminal-edit", "fileChange.started", "completed"],
      ["terminal-edit", "fileChange.completed", "completed"]
    ]);
});

test("ACP transport failure rejects the active turn", async (t) => {
  const h = await setupPort(t, "acp-transport");
  const turn = await h.port.startTurn({ sessionId: h.session.sessionId, prompt: [{ type: "text", text: "transport-failure" }] });
  await assert.rejects(turn.done, (error) => error.code === "TRANSPORT_CLOSED");
});
