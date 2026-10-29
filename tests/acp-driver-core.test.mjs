import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import os from "node:os";
import { DirectorChannel } from "../plugins/codex/scripts/director-channel.mjs";
import { acceptDirectorEvents, eventFromRef } from "../plugins/codex/scripts/lib/director-delivery.mjs";
import { AcpExecutorJobPort, openAcpExecutorJob } from "../plugins/codex/scripts/lib/executors/acp-driver.mjs";
import { AcpEventAdapter } from "../plugins/codex/scripts/lib/executors/acp-event-adapter.mjs";
import { loadAcpDriver } from "../plugins/codex/scripts/lib/acp.mjs";
import { ObservationClient } from "../plugins/codex/scripts/lib/observation-client.mjs";
import { resolveLiveViewPath } from "../plugins/codex/scripts/lib/job-event-store.mjs";
import { listJobs, upsertJob, writeJobFile } from "../plugins/codex/scripts/lib/state.mjs";
import { BROKER_READY_MS, isolateTestEnvironment, makeTempDir, run, within } from "./helpers.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const AGENT = path.join(ROOT, "tests/fake-acp-agent.mjs");
const SCRIPT = path.join(ROOT, "plugins/codex/scripts/codex-companion.mjs");

async function waitFor(predicate, timeoutMs = BROKER_READY_MS) {
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
  const job = { id, executor: "acp", workspaceRoot: cwd, sessionId: options.sessionId, status: "running", title: "ACP test",
    createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), pid: process.pid };
  writeJobFile(cwd, id, job);
  upsertJob(cwd, job);
  const port = await openAcpExecutorJob({ cwd, job, command: process.execPath, args: [AGENT], env: options.env,
    modelId: options.modelId, effortId: options.effortId });
  const events = [];
  const pump = (async () => { for await (const event of port.events()) events.push(event); })();
  t.after(async () => {
    try {
      await within(port.close(), 5000, "ACP port cleanup");
    } finally {
      if (port.proc?.exitCode === null && port.proc.signalCode === null) port.proc.kill("SIGKILL");
      port.proc?.stdin.destroy();
      port.proc?.stdout.destroy();
      port.queue.close();
      await within(pump, 1000, "ACP event pump cleanup");
      await within(port.runtime.close(), 5000, "ACP runtime cleanup");
    }
  });
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

test("ACP steering extensions require confirmed injection and leave idle input with the client", async () => {
  for (const [outcome, code] of [["injected", null], ["promptRequired", "TURN_NOT_ACTIVE"], [null, "INVALID_RESPONSE"]]) {
    const events = [];
    const port = new AcpExecutorJobPort({ job: { id: "extension-steering" } });
    port.sessionId = "session";
    port.capabilities.midTurnSteer = true;
    port.steeringExtension = true;
    port.activeTurn = { turnId: "turn", accepting: true, messages: [] };
    port.adapter = new AcpEventAdapter(event => events.push(event), { job: port.job });
    port.adapter.bindSession(port.sessionId);
    const prompt = [{ type: "text", text: "Use the current plan." }];
    port.connection = { extMethod: async (method, params) => {
      assert.equal(method, "_session/steering");
      assert.deepEqual(params, { sessionId: "session", prompt, _meta: { steering: { idleBehavior: "promptRequired" } } });
      return outcome ? { outcome } : null;
    } };
    const result = port.steerPrompt({ sessionId: "session", turnId: "turn", prompt });
    if (code) {
      await assert.rejects(result, error => error.code === code);
      assert.equal(events.length, 0);
      assert.equal(port.activeTurn.messages.length, 0);
    } else {
      const ack = await result;
      assert.equal(ack.accepted, true);
      assert.equal(ack.consumed, null);
      assert.equal(events[0].payload.accepted, true);
      assert.equal(port.activeTurn.messages.length, 1);
    }
  }
});

test("Qoder validates steering, fails on rejection before root completion and ignores later cleanup errors", async () => {
  const events = [];
  const responses = [];
  const port = new AcpExecutorJobPort({ job: { id: "qoder-rejection" } });
  port.sessionId = "session";
  port.adapter = new AcpEventAdapter(event => events.push(event), { job: port.job });
  port.adapter.bindSession(port.sessionId);
  port.exitPromise = new Promise(() => {});
  port.connection = { prompt: () => new Promise((resolve, reject) => responses.push({ resolve, reject })) };
  const prompt = [{ type: "text", text: "correction" }];
  const turn = await port.startTurn({ sessionId: port.sessionId, prompt });
  await assert.rejects(port.steerPrompt({ sessionId: port.sessionId, turnId: turn.turnId, prompt }), /does not support/i);
  port.capabilities.midTurnSteer = true;
  for (const request of [
    { sessionId: "wrong", turnId: turn.turnId, prompt },
    { sessionId: port.sessionId, turnId: "stale", prompt },
    { sessionId: port.sessionId, turnId: turn.turnId, prompt: [] }
  ]) await assert.rejects(port.steerPrompt(request));
  port.questions.set("question", {});
  await assert.rejects(port.steerPrompt({ sessionId: port.sessionId, turnId: turn.turnId, prompt }), /pending question/i);
  port.questions.clear();
  port.permissions.set("permission", {});
  await assert.rejects(port.steerPrompt({ sessionId: port.sessionId, turnId: turn.turnId, prompt }), /pending question/i);
  port.permissions.clear();
  assert.equal(responses.length, 1);
  await port.steerPrompt({ sessionId: port.sessionId, turnId: turn.turnId, prompt });
  const failed = assert.rejects(turn.done, /explicit steering rejection/);
  responses[1].reject(new Error("explicit steering rejection"));
  await waitFor(() => events.some(event => event.type === "source.error"));
  responses[0].resolve({ stopReason: "end_turn" });
  await failed;
  assert.equal(events.filter(event => event.type === "turn.completed").length, 0);
  assert.ok(events.some(event => event.type === "source.error" && /explicit steering rejection/.test(event.payload.message)));

  const next = await port.startTurn({ sessionId: port.sessionId, prompt });
  await port.steerPrompt({ sessionId: port.sessionId, turnId: next.turnId, prompt });
  responses[2].resolve({ stopReason: "end_turn" });
  assert.equal((await next.done).status, "completed");
  const count = events.length;
  responses[3].reject(new Error("connection closed during cleanup"));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(events.length, count, "cleanup must not emit events after turn completion");

  for (const [method, expected] of [["cancelJob", "cancelled"], ["interruptTurn", "interrupted"]]) {
    const offset = responses.length;
    const stopping = await port.startTurn({ sessionId: port.sessionId, prompt });
    await port.steerPrompt({ sessionId: port.sessionId, turnId: stopping.turnId, prompt });
    port.connection.cancel = async () => {
      responses[offset + 1].resolve({ stopReason: "cancelled" });
      await new Promise(resolve => setImmediate(resolve));
      responses[offset].resolve({ stopReason: "cancelled" });
    };
    const beforeStop = events.length;
    const terminal = await port[method]({ sessionId: port.sessionId, turnId: stopping.turnId, timeoutMs: 1000 });
    assert.equal(terminal.status, expected);
    assert.equal(await stopping.done, terminal);
    const stopped = events.slice(beforeStop);
    assert.equal(stopped.filter(event => event.type === "turn.completed").length, 1);
    assert.equal(stopped.some(event => event.type === "source.error"), false, "expected cancellation is not a steering rejection");
  }
});

test("ACP initialization failure closes the spawned agent", async (t) => {
  isolateTestEnvironment(t);
  const cwd = fs.realpathSync(makeTempDir());
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
  const h = await setupPort(t, "acp-input", { sessionId: "acp-director" });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cxd-acp-"));
  const messages = [];
  const channel = new DirectorChannel({ dir, send: async message => {
    await acceptDirectorEvents([eventFromRef(message.params.meta.delivery)], "channel", async () => { messages.push(message.params); return {}; });
  } });
  await channel.start(h.job.sessionId);
  await channel.handle({ action: "confirm", sessionId: h.job.sessionId, instance: channel.instance, nonce: channel.nonce });
  t.after(async () => { await channel.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const permissionTurn = await h.port.startTurn({ sessionId: h.session.sessionId, prompt: [{ type: "text", text: "permission" }] });
  const permission = await waitFor(() => [...h.port.permissions.values()][0]);
  assert.equal(permission.payload.options[0].kind, "allow_once");
  await waitFor(() => messages.some(message => message.content.includes(permission.requestId)));
  await h.port.answerPermission({ requestId: permission.requestId, outcome: "selected", optionId: "allow" });
  assert.equal((await permissionTurn.done).status, "completed");
  const manual = h.events.find((event) => event.type === "permission.resolved" && event.identity.requestId === permission.requestId);
  assert.ok(manual, "manual answer resolution was not recorded");
  assert.deepEqual(manual.payload, { requestId: permission.requestId, outcome: "selected", optionId: "allow" });
  await h.port.setMode({ sessionId: h.session.sessionId, modeId: "yolo" });
  const automatic = await h.port.startTurn({ sessionId: h.session.sessionId, prompt: [{ type: "text", text: "permission" }] });
  const outcome = await within(automatic.done, 10000, "automatic yolo permission turn");
  assert.equal(outcome.status, "completed");
  assert.match(outcome.finalMessages.find((message) => message.role === "assistant").text, /"optionId":"allow-session"/);
  const content = { name: "Ada", choice: "a", tags: ["x", "y"], enabled: true };
  let terminal;
  for (const values of [content, { name: { answers: ["Ada"] }, choice: { answers: ["a"] },
    tags: { answers: ["x", "y"] }, enabled: true }]) {
    const questionTurn = await h.port.startTurn({ sessionId: h.session.sessionId, prompt: [{ type: "text", text: "question" }] });
    const question = await waitFor(() => [...h.port.questions.values()][0]);
    assert.deepEqual(question.payload.fields.map((field) => field.kind), ["text", "single_select", "multi_select", "boolean"]);
    await waitFor(() => messages.some(message => message.content.includes(question.requestId)));
    assert.equal(messages.filter(message => message.meta.event.startsWith("job_")).length, 0, "turn completions are not job endings");
    await h.port.answerQuestion({ requestId: question.requestId, action: "accept", values });
    terminal = await questionTurn.done;
    assert.equal(terminal.status, "completed");
    assert.deepEqual(JSON.parse(terminal.finalMessages.find((message) => message.role === "assistant").text),
      { action: "accept", content });
  }
  await h.port.adapter.completeJob(terminal);
  await waitFor(() => messages.some(message => message.meta.event === "job_completed"));
  assert.equal(messages.filter(message => message.meta.event === "job_completed").length, 1);
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

test("a redirect reaches the run loop, which reads it the moment the turn settles", async (t) => {
  // The run loop awaits the turn and takes the replacement in the same step,
  // and it awaited first: a replacement stored after the interrupt's own race
  // resolves is written into a field nobody reads again, and the job ends
  // cancelled with the correction lost. This is that ordering, not the
  // interrupt call's return value.
  const h = await setupPort(t, "acp-redirect-order");
  const turn = await h.port.startTurn({ sessionId: h.session.sessionId, prompt: [{ type: "text", text: "cancel-late" }] });
  const consumed = turn.done.then(() => h.port.takeReplacementPrompt());
  await h.port.interruptTurn({ sessionId: h.session.sessionId, turnId: turn.turnId, timeoutMs: 5000,
    replacementPrompt: [{ type: "text", text: "carry on" }] });
  assert.deepEqual(await consumed, [{ type: "text", text: "carry on" }]);
});

test("a redirect that loses to natural completion is still delivered", async (t) => {
  // It used to be dropped here: the turn ended by itself while the cancel was
  // in flight, so the interrupt had nothing to interrupt. But the director sent
  // a correction, and a correction that arrives a moment late is the ordinary
  // case, not a mistake -- delivering it in the next turn is what sending it
  // meant. Dropping it silently is the defect this whole path is being fixed
  // for, and it cannot be told apart from the message never having been sent.
  const h = await setupPort(t, "acp-cancel-natural");
  const turn = await h.port.startTurn({ sessionId: h.session.sessionId, prompt: [{ type: "text", text: "cancel-natural" }] });
  const terminal = await h.port.interruptTurn({ sessionId: h.session.sessionId, turnId: turn.turnId, timeoutMs: 5000,
    replacementPrompt: [{ type: "text", text: "carry on" }] });
  assert.equal(terminal.status, "completed");
  assert.deepEqual(h.port.takeReplacementPrompt(), [{ type: "text", text: "carry on" }]);
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

test("a copy missing the ACP SDK installs it and loads the driver, and nothing else triggers an install", async () => {
  // Claude Code reports a plugin install as a success when its `npm ci` fails,
  // so a copy can reach its first Qoder turn without the SDK.
  const missing = (name) => Object.assign(new Error(`Cannot find package '${name}' imported from acp-driver.mjs`),
    { code: "ERR_MODULE_NOT_FOUND" });
  const cases = [
    ["SDK missing", missing("@agentclientprotocol/sdk"), null, { installs: 1, imports: 2, loaded: true }],
    ["zod missing", missing("zod"), null, { installs: 1, imports: 2, loaded: true }],
    ["another package missing", missing("left-pad"), null, { installs: 0, imports: 1, error: /left-pad/ }],
    ["driver itself broken", new SyntaxError("Unexpected token"), null, { installs: 0, imports: 1, error: /Unexpected token/ }],
    ["install fails", missing("@agentclientprotocol/sdk"), new Error("npm exit 1"), { installs: 1, imports: 1, error: /npm exit 1/ }],
  ];
  for (const [name, firstError, installError, expected] of cases) {
    const imports = [];
    const roots = [];
    const attempt = loadAcpDriver({
      importDriver: async (href) => {
        imports.push(href);
        if (imports.length === 1) throw firstError;
        return { openAcpExecutorJob: "driver" };
      },
      install: async (root) => { roots.push(root); if (installError) throw installError; },
    });
    if (expected.error) await assert.rejects(attempt, expected.error, name);
    else assert.equal((await attempt).openAcpExecutorJob, "driver", name);
    assert.equal(roots.length, expected.installs, name);
    assert.equal(imports.length, expected.imports, name);
    if (roots.length) assert.ok(fs.existsSync(path.join(roots[0], "package.json")), `${name}: installs into the plugin root`);
    if (imports.length === 2) assert.match(imports[1], /acp-driver\.mjs\?installed=\d+$/, name);
  }
});
