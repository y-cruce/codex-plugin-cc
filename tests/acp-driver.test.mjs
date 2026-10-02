import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { AcpExecutorJobPort, openAcpExecutorJob } from "../plugins/codex/scripts/lib/executors/acp-driver.mjs";
import { listJobs, upsertJob, writeJobFile } from "../plugins/codex/scripts/lib/state.mjs";
import { createJobRecord, runTrackedJob } from "../plugins/codex/scripts/lib/tracked-jobs.mjs";
import { BROKER_READY_MS, isolateTestEnvironment, makeTempDir, run } from "./helpers.mjs";

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
  const job = { id, executor: "acp", workspaceRoot: cwd, status: "running", title: "ACP test",
    createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), pid: process.pid };
  writeJobFile(cwd, id, job);
  upsertJob(cwd, job);
  const port = await openAcpExecutorJob({ cwd, job, command: process.execPath, args: [AGENT], env: options.env,
    modelId: options.modelId, effortId: options.effortId, onProgress: options.onProgress });
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

test("ACP model selection sends session/set_config_option with the exact select shape", async (t) => {
  const recording = path.join(makeTempDir(), "acp-recording.jsonl");
  const h = await setupPort(t, "acp-model", { modelId: "efficient", env: { ...process.env, ACP_FAKE_RECORDING: recording } });
  const request = readRecording(recording).find((entry) => entry.method === "session/set_config_option");
  assert.deepEqual(request.params, { sessionId: h.session.sessionId, configId: "model", value: "efficient" });
  assert.equal(h.session.configOptions.find((option) => option.id === "model").currentValue, "efficient");
});

function recordingPort(configOptions, options = {}) {
  const requests = [];
  const progress = [];
  const port = new AcpExecutorJobPort({ cwd: ROOT, job: { id: "config-test" }, ...options,
    onProgress: (update) => progress.push(update) });
  port.connection = { setSessionConfigOption: async (params) => {
    requests.push({ method: "session/set_config_option", params });
    return { configOptions: configOptions.map((option) => ({ ...option,
      currentValue: option.id === params.configId ? params.value : option.currentValue })) };
  } };
  return { port, requests, progress, response: { configOptions } };
}

test("ACP model selection defaults to the 1M model, and an explicit model still wins", async () => {
  for (const row of [
    { id: "default", values: ["dfmodel", "efficient", "performance"], expected: "dfmodel" },
    { id: "explicit", values: ["dfmodel", "efficient", "performance"], modelId: "efficient", expected: "efficient" },
    { id: "unavailable", values: ["efficient", "performance"], expected: null }
  ]) {
    const h = recordingPort([{ type: "select", id: "model", currentValue: row.values[0],
      options: row.values.map((value) => ({ value, name: value })) }], { modelId: row.modelId });
    const choice = h.port.modelChoice({});
    await h.port.applyModel("session-1", h.response, choice.modelId, { soft: choice.soft });
    const request = h.requests.find((entry) => entry.params.configId === "model");
    assert.equal(request?.params.value ?? null, row.expected, row.id);
    if (row.expected) {
      assert.equal(h.response.configOptions.find((option) => option.id === "model").currentValue, row.expected, row.id);
    } else {
      assert.match(h.progress.map((update) => update.stderrMessage ?? "").join("\n"),
        /ACP model dfmodel is not available on this agent; keeping its default/i, row.id);
    }
  }
});

test("ACP model selection fails visibly for unsupported config and invalid values", async (t) => {
  isolateTestEnvironment(t);
  const cwd = fs.realpathSync(makeTempDir());
  for (const row of [
    { id: "unsupported", model: "efficient", error: /ACP model selection failed for efficient/i },
    { id: "invalid", model: "missing-model", error: /ACP model missing-model is not available.*dfmodel.*efficient.*performance/i }
  ]) {
    const h = recordingPort([{ type: "select", id: "model", options: ["dfmodel", "efficient", "performance"].map((value) => ({ value })) }]);
    if (row.id === "unsupported") h.port.connection.setSessionConfigOption = async () => { throw new Error("unsupported method"); };
    const job = createJobRecord({ id: row.id, workspaceRoot: cwd, executor: "acp" });
    await assert.rejects(runTrackedJob(job, () => h.port.applyModel("session-1", h.response, row.model)), row.error);
    const stored = listJobs(cwd).find((item) => item.id === row.id);
    assert.equal(stored.status, "failed");
    assert.match(stored.errorMessage, row.error);
  }
});

test("CLI selects an explicit ACP model and a rejected model fails the job", (t) => {
  isolateTestEnvironment(t);
  for (const model of ["efficient", "missing-model"]) {
    const cwd = fs.realpathSync(makeTempDir());
    const recording = path.join(cwd, "requests.jsonl");
    const result = run(process.execPath, [SCRIPT, "task", "--cwd", cwd, "--executor", "acp", "--executor-command", process.execPath,
      "--executor-args", JSON.stringify([AGENT]), "--executor-model", model, "--json", "basic"],
      { cwd, env: { ...process.env, ACP_FAKE_RECORDING: recording } });
    const job = listJobs(cwd)[0];
    if (model === "efficient") {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(job.executorModel, model);
      const request = readRecording(recording).find((entry) => entry.params?.configId === "model");
      assert.equal(request.params.value, model);
    } else {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /ACP model missing-model is not available/i);
      assert.equal(job.status, "failed");
      assert.match(job.errorMessage, /ACP model missing-model is not available/i);
    }
  }
});

test("ACP reasoning effort uses the strongest compatible option exposed by the agent", async () => {
  for (const [suffix, options, expected] of [
    ["xhigh", "xhigh,max,high", "xhigh"],
    ["max", "max,low,none", "max"],
    ["high", "high,low,none", "high"]
  ]) {
    const h = recordingPort([{ type: "select", id: "reasoning_effort",
      options: options.split(",").map((value) => ({ value })) }]);
    await h.port.applyReasoningEffort("session-1", h.response, "xhigh");
    const request = h.requests.find((entry) => entry.params.configId === "reasoning_effort");
    assert.deepEqual(request.params, { sessionId: "session-1", configId: "reasoning_effort", value: expected }, suffix);
  }
});

test("ACP reasoning effort fails the task when session/set_config_option returns an error", (t) => {
  isolateTestEnvironment(t);
  const cwd = fs.realpathSync(makeTempDir());
  const result = run(process.execPath, [SCRIPT, "task", "--cwd", cwd, "--executor", "acp", "--executor-command", process.execPath,
    "--executor-args", JSON.stringify([AGENT]), "--executor-effort", "high", "--json", "basic"], { cwd,
    env: { ...process.env, ACP_FAKE_CONFIG_BEHAVIOR: "effort-error" } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ACP reasoning effort selection failed for high/i);
  const job = listJobs(cwd)[0];
  assert.equal(job.status, "failed");
  assert.match(job.errorMessage, /ACP reasoning effort selection failed for high/i);
});

test("ACP model and reasoning effort metadata follow flags and environment", (t) => {
  isolateTestEnvironment(t);
  for (const row of [
    { args: ["--executor-effort", "xhigh"], env: { CODEX_COMPANION_ACP_MODEL: "performance" }, effort: "max", requested: "xhigh" },
    { args: [], env: { CODEX_COMPANION_ACP_MODEL: "performance", CODEX_COMPANION_ACP_EFFORT: "high" }, effort: "high", requested: "high" },
    { args: ["--executor-effort", "xhigh"], env: { CODEX_COMPANION_ACP_MODEL: "performance", ACP_FAKE_CONFIG_BEHAVIOR: "no-effort" }, effort: undefined, requested: "xhigh" }
  ]) {
    const cwd = fs.realpathSync(makeTempDir());
    const recording = path.join(cwd, "acp-recording.jsonl");
    const result = run(process.execPath, [SCRIPT, "task", "--cwd", cwd, "--executor", "acp", "--executor-command", process.execPath,
      "--executor-args", JSON.stringify([AGENT]), ...row.args, "--json", "basic"], { cwd,
      env: { ...process.env, ACP_FAKE_RECORDING: recording, ...row.env } });
    assert.equal(result.status, 0, result.stderr);
    const requests = readRecording(recording);
    assert.equal(requests.find((entry) => entry.params?.configId === "model").params.value, "performance");
    const job = listJobs(cwd)[0];
    assert.equal(job.executorModel, "performance");
    assert.equal(job.executorEffort, row.effort);
    assert.equal(job.request.executorEffort, row.requested);
    if (row.effort === undefined) {
      assert.equal(requests.filter((entry) => entry.params?.configId === "reasoning_effort").length, 0);
      assert.equal(job.status, "completed");
      assert.match(fs.readFileSync(job.logFile, "utf8"), /does not expose reasoning_effort; keeping its default/i);
    } else if (row.effort !== row.requested) {
      assert.match(fs.readFileSync(job.logFile, "utf8"), /reasoning effort xhigh is unavailable; using max/i);
    }
  }
});
