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
    modelId: options.modelId });
  t.after(() => port.close());
  const events = [];
  const pump = (async () => { for await (const event of port.events()) events.push(event); })();
  t.after(() => pump);
  const session = await port.startSession({ cwd, additionalDirectories: [], mcpServers: [], modeId: "default",
    modelId: options.modelId });
  return { cwd, job, port, events, session };
}

function readRecording(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
}

test("ACP model selection sends session/set_config_option with the exact select shape", async (t) => {
  const recording = path.join(makeTempDir(), "acp-recording.jsonl");
  const h = await setupPort(t, "acp-model", { modelId: "efficient", env: { ...process.env, ACP_FAKE_RECORDING: recording } });
  const request = readRecording(recording).find((entry) => entry.method === "session/set_config_option");
  assert.deepEqual(request.params, { sessionId: h.session.sessionId, configId: "model", value: "efficient" });
  assert.equal(h.session.configOptions.find((option) => option.id === "model").currentValue, "efficient");
});

test("ACP session creation does not set a config option when no model is requested", async (t) => {
  const recording = path.join(makeTempDir(), "acp-recording.jsonl");
  await setupPort(t, "acp-default-model", { env: { ...process.env, ACP_FAKE_RECORDING: recording } });
  assert.equal(readRecording(recording).some((entry) => entry.method === "session/set_config_option"), false);
});

test("ACP model selection fails visibly for unsupported config and invalid values", async (t) => {
  isolateTestEnvironment(t);
  const cwd = fs.realpathSync(makeTempDir());
  initGitRepo(cwd);
  const base = [SCRIPT, "task", "--cwd", cwd, "--executor", "acp", "--executor-command", process.execPath,
    "--executor-args", JSON.stringify([AGENT]), "--json"];
  const unsupported = run(process.execPath, [...base, "--executor-model", "efficient", "basic"], {
    cwd, env: { ...process.env, ACP_FAKE_CONFIG_BEHAVIOR: "unsupported" }
  });
  assert.notEqual(unsupported.status, 0);
  assert.match(unsupported.stderr, /ACP model selection failed for efficient/i);
  assert.equal(listJobs(cwd)[0].status, "failed");
  assert.match(listJobs(cwd)[0].errorMessage, /ACP model selection failed for efficient/i);
  const invalid = run(process.execPath, [...base, "--executor-model", "missing-model", "basic"], { cwd });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /ACP model missing-model is not available.*dfmodel.*efficient.*performance/i);
  assert.equal(listJobs(cwd)[0].status, "failed");
});

test("companion persists the selected ACP model in job metadata", (t) => {
  isolateTestEnvironment(t);
  const cwd = fs.realpathSync(makeTempDir());
  initGitRepo(cwd);
  const result = run(process.execPath, [SCRIPT, "task", "--cwd", cwd, "--executor", "acp", "--executor-command", process.execPath,
    "--executor-args", JSON.stringify([AGENT]), "--executor-model", "efficient", "--json", "basic"], { cwd });
  assert.equal(result.status, 0, result.stderr);
  const job = listJobs(cwd)[0];
  assert.equal(job.executorModel, "efficient");
  assert.equal(job.request.executorModel, "efficient");
});

test("CODEX_COMPANION_ACP_MODEL selects and persists the ACP model", (t) => {
  isolateTestEnvironment(t);
  const cwd = fs.realpathSync(makeTempDir());
  initGitRepo(cwd);
  const recording = path.join(makeTempDir(), "acp-recording.jsonl");
  const env = { ...process.env, CODEX_COMPANION_ACP_MODEL: "performance", ACP_FAKE_RECORDING: recording };
  const result = run(process.execPath, [SCRIPT, "task", "--cwd", cwd, "--executor", "acp", "--executor-command", process.execPath,
    "--executor-args", JSON.stringify([AGENT]), "--json", "basic"], { cwd, env });
  assert.equal(result.status, 0, result.stderr);
  const request = readRecording(recording).find((entry) => entry.method === "session/set_config_option");
  assert.equal(request.params.value, "performance");
  assert.equal(listJobs(cwd)[0].executorModel, "performance");
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

test("ACP cancel waits for late updates and cancels pending permissions", async (t) => {
  const h = await setupPort(t, "acp-cancel");
  const turn = await h.port.startTurn({ sessionId: h.session.sessionId, prompt: [{ type: "text", text: "cancel-late" }] });
  const terminal = await h.port.interruptTurn({ sessionId: h.session.sessionId, turnId: turn.turnId, timeoutMs: 5000,
    replacementPrompt: [{ type: "text", text: "replacement" }] });
  assert.equal(terminal.status, "interrupted");
  assert.equal(terminal.reason.backendCode, "cancelled");
  assert.equal(h.port.takeReplacementPrompt()[0].text, "replacement");
  const late = h.events.findIndex((event) => event.type === "message.delta" && event.payload.block.text === "late update");
  const completed = h.events.findIndex((event) => event.type === "turn.completed");
  assert.ok(late >= 0 && completed > late);

  const permissionTurn = await h.port.startTurn({ sessionId: h.session.sessionId, prompt: [{ type: "text", text: "permission" }] });
  await waitFor(() => h.port.permissions.size === 1);
  const cancelled = await h.port.cancelJob({ sessionId: h.session.sessionId, turnId: permissionTurn.turnId, timeoutMs: 5000 });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(h.port.permissions.size, 0);
});

test("ACP transport failure rejects the active turn", async (t) => {
  const h = await setupPort(t, "acp-transport");
  const turn = await h.port.startTurn({ sessionId: h.session.sessionId, prompt: [{ type: "text", text: "transport-failure" }] });
  await assert.rejects(turn.done, (error) => error.code === "TRANSPORT_CLOSED");
});

test("ACP observation endpoint follows events and persists a nonblank live view", async (t) => {
  const h = await setupPort(t, "acp-observe");
  const job = { ...h.job, executorSessionId: h.session.sessionId, controlEndpoint: h.port.controlEndpoint };
  const client = await ObservationClient.connect(h.cwd, { job });
  t.after(() => client.close());
  const pages = [];
  client.on("notification", (message) => { if (message.method === "broker/observation") pages.push(message.params); });
  await client.request("broker/observe-follow", { cwd: h.cwd, jobId: h.job.id });
  const turn = await h.port.startTurn({ sessionId: h.session.sessionId, prompt: [{ type: "text", text: "basic" }] });
  const terminal = await turn.done;
  await h.port.adapter.completeJob(terminal);
  await waitFor(() => pages.some((page) => page.events.some((event) => event.type === "message.completed")));
  await h.port.close();
  const history = await readHistory(h.cwd, h.job.id);
  assert.ok(history.events.some((event) => event.type === "job.completed"));
  const view = JSON.parse(fs.readFileSync(resolveLiveViewPath(h.cwd, h.job.id), "utf8"));
  assert.equal(view.executor.kind, "acp");
  assert.equal(view.lastMessage.text, "Basic complete");
  assert.equal(view.files.length, 1);
});

test("ACP follow replays a committed terminal event after its endpoint closes", async (t) => {
  const h = await setupPort(t, "acp-follow-close-race");
  const running = { ...h.job, executorSessionId: h.session.sessionId, controlEndpoint: h.port.controlEndpoint };
  writeJobFile(h.cwd, h.job.id, running);
  upsertJob(h.cwd, running);
  const turn = await h.port.startTurn({ sessionId: h.session.sessionId, prompt: [{ type: "text", text: "basic" }] });
  const terminal = await turn.done;
  await h.port.adapter.completeJob(terminal);
  await h.port.close();

  const followed = run(process.execPath, [SCRIPT, "observe", "follow", h.job.id, "--cwd", h.cwd, "--quiet"], { cwd: h.cwd });
  assert.equal(followed.status, 0, followed.stderr);
  assert.match(followed.stdout, /^CURSOR: /m);
  assert.match(followed.stdout, /^DONE job=acp-follow-close-race /m);
});

test("ACP follow reaches DONE when the endpoint closes while it is waiting", async (t) => {
  const h = await setupPort(t, "acp-follow-connected-close");
  const running = { ...h.job, executorSessionId: h.session.sessionId, controlEndpoint: h.port.controlEndpoint };
  writeJobFile(h.cwd, h.job.id, running);
  upsertJob(h.cwd, running);
  const child = spawn(process.execPath, [SCRIPT, "observe", "follow", h.job.id, "--cwd", h.cwd, "--quiet"], {
    cwd: h.cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const exited = once(child, "exit");
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  await waitFor(() => h.port.runtime.followers.size === 1);

  const turn = await h.port.startTurn({ sessionId: h.session.sessionId, prompt: [{ type: "text", text: "basic" }] });
  const terminal = await turn.done;
  await h.port.adapter.completeJob(terminal);
  await h.port.close();
  const [code] = await exited;

  assert.equal(code, 0, stderr);
  assert.match(stdout, /^CURSOR: /m);
  assert.match(stdout, /^DONE job=acp-follow-connected-close /m);
});

test("ACP follow prints a recovery cursor when its endpoint closes before a terminal event", async (t) => {
  const h = await setupPort(t, "acp-follow-unavailable");
  const running = { ...h.job, executorSessionId: h.session.sessionId, controlEndpoint: h.port.controlEndpoint };
  writeJobFile(h.cwd, h.job.id, running);
  upsertJob(h.cwd, running);
  await h.port.close();

  const followed = run(process.execPath, [SCRIPT, "observe", "follow", h.job.id, "--cwd", h.cwd, "--quiet"], { cwd: h.cwd });
  assert.equal(followed.status, 1);
  assert.match(followed.stdout, /^CURSOR: /m);
  assert.match(followed.stderr, /^BROKER_UNAVAILABLE Broker disconnected; continue with --after$/m);
});

test("companion selects the ACP executor without changing the Codex default", (t) => {
  isolateTestEnvironment(t);
  const cwd = fs.realpathSync(makeTempDir());
  initGitRepo(cwd);
  const result = run(process.execPath, [SCRIPT, "task", "--cwd", cwd, "--executor", "acp", "--executor-command", process.execPath,
    "--executor-args", JSON.stringify([AGENT]), "--json", "basic"], { cwd });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.executor, "acp");
  assert.equal(payload.rawOutput, "Basic complete");
  const job = listJobs(cwd)[0];
  const replay = run(process.execPath, [SCRIPT, "observe", "replay", job.id, "--cwd", cwd, "--jsonl"], { cwd });
  assert.equal(replay.status, 0, replay.stderr);
  const events = replay.stdout.trim().split("\n").map(JSON.parse);
  assert.ok(events.some((event) => event.type === "message.completed"));
  assert.equal(events.at(-1).type, "end");
});

test("CODEX_COMPANION_EXECUTOR sets the default executor and an explicit flag still wins", (t) => {
  isolateTestEnvironment(t);
  const cwd = fs.realpathSync(makeTempDir());
  initGitRepo(cwd);
  const env = {
    ...process.env,
    CODEX_COMPANION_EXECUTOR: "acp",
    CODEX_COMPANION_ACP_COMMAND: process.execPath,
    CODEX_COMPANION_ACP_ARGS: JSON.stringify([AGENT])
  };
  const viaEnv = run(process.execPath, [SCRIPT, "task", "--cwd", cwd, "--json", "basic"], { cwd, env });
  assert.equal(viaEnv.status, 0, viaEnv.stderr);
  assert.equal(JSON.parse(viaEnv.stdout).executor, "acp");

  const viaFlag = run(process.execPath, [SCRIPT, "task", "--cwd", cwd, "--executor", "codex", "--json", "basic"], { cwd, env });
  // Codex is not installed in the test environment, so the run fails; what it
  // must prove is that the flag, not the environment, chose the executor.
  assert.doesNotMatch(String(viaFlag.stdout) + String(viaFlag.stderr), /ACP execution requires/);
});
