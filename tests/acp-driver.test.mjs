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

test("ACP model selection defaults to the 1M model, and an explicit model still wins", async (t) => {
  // A model carries a context ceiling and the window is a separate setting, so
  // the ceiling is what the model choice decides: `dfmodel` tops out at 1M
  // where the agent's own default (`auto`) stops at 200K. A dispatch that names
  // no model must still land on a 1M-capable one -- unless the agent does not
  // offer it, which is a downgrade to its own default rather than a failed task.
  for (const row of [
    { id: "default", expected: "dfmodel" },
    { id: "explicit", modelId: "efficient", expected: "efficient" },
    { id: "unavailable", env: { ACP_FAKE_MODEL_OPTIONS: "efficient,performance" }, expected: null }
  ]) {
    const recording = path.join(makeTempDir(), "acp-recording.jsonl");
    const progress = [];
    const h = await setupPort(t, `acp-model-${row.id}`, { modelId: row.modelId, onProgress: (update) => progress.push(update),
      env: { ...process.env, ACP_FAKE_RECORDING: recording, ...row.env } });
    const request = readRecording(recording).find((entry) => entry.method === "session/set_config_option" &&
      entry.params.configId === "model");
    assert.equal(request?.params.value ?? null, row.expected, row.id);
    if (row.expected) {
      assert.equal(h.session.configOptions.find((option) => option.id === "model").currentValue, row.expected, row.id);
    } else {
      assert.match(progress.map((update) => update.stderrMessage ?? "").join("\n"),
        /ACP model dfmodel is not available on this agent; keeping its default/i, row.id);
    }
  }
});

test("ACP model selection fails visibly for unsupported config and invalid values", async (t) => {
  isolateTestEnvironment(t);
  const cwd = fs.realpathSync(makeTempDir());
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

test("CODEX_COMPANION_ACP_MODEL selects and persists the ACP model", (t) => {
  isolateTestEnvironment(t);
  const cwd = fs.realpathSync(makeTempDir());
  const recording = path.join(makeTempDir(), "acp-recording.jsonl");
  const env = { ...process.env, CODEX_COMPANION_ACP_MODEL: "performance", ACP_FAKE_RECORDING: recording };
  const result = run(process.execPath, [SCRIPT, "task", "--cwd", cwd, "--executor", "acp", "--executor-command", process.execPath,
    "--executor-args", JSON.stringify([AGENT]), "--json", "basic"], { cwd, env });
  assert.equal(result.status, 0, result.stderr);
  const request = readRecording(recording).find((entry) => entry.method === "session/set_config_option");
  assert.equal(request.params.value, "performance");
  assert.equal(listJobs(cwd)[0].executorModel, "performance");
});

test("ACP reasoning effort uses the strongest compatible option exposed by the agent", async (t) => {
  for (const [suffix, options, expected] of [
    ["xhigh", "xhigh,max,high", "xhigh"],
    ["max", "max,low,none", "max"],
    ["high", "high,low,none", "high"]
  ]) {
    const recording = path.join(makeTempDir(), "acp-recording.jsonl");
    const h = await setupPort(t, `acp-effort-${suffix}`, { effortId: "xhigh", env: { ...process.env,
      ACP_FAKE_RECORDING: recording, ACP_FAKE_EFFORT_OPTIONS: options } });
    const request = readRecording(recording).find((entry) => entry.method === "session/set_config_option" &&
      entry.params.configId === "reasoning_effort");
    assert.deepEqual(request.params, {
      sessionId: h.session.sessionId,
      configId: "reasoning_effort",
      value: expected
    });
  }
});

test("ACP reasoning effort skips an agent without reasoning_effort and completes the task", (t) => {
  isolateTestEnvironment(t);
  const cwd = fs.realpathSync(makeTempDir());
  const recording = path.join(makeTempDir(), "acp-recording.jsonl");
  const result = run(process.execPath, [SCRIPT, "task", "--cwd", cwd, "--executor", "acp", "--executor-command", process.execPath,
    "--executor-args", JSON.stringify([AGENT]), "--executor-effort", "xhigh", "--json", "basic"], { cwd,
    env: { ...process.env, ACP_FAKE_RECORDING: recording, ACP_FAKE_CONFIG_BEHAVIOR: "no-effort" } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readRecording(recording).some((entry) => entry.method === "session/set_config_option" &&
    entry.params.configId === "reasoning_effort"), false);
  const job = listJobs(cwd)[0];
  assert.equal(job.status, "completed");
  assert.equal(job.executorEffort, undefined);
  assert.match(fs.readFileSync(job.logFile, "utf8"), /does not expose reasoning_effort; keeping its default/i);
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

test("companion persists the effective ACP reasoning effort in job metadata", (t) => {
  isolateTestEnvironment(t);
  const cwd = fs.realpathSync(makeTempDir());
  const result = run(process.execPath, [SCRIPT, "task", "--cwd", cwd, "--executor", "acp", "--executor-command", process.execPath,
    "--executor-args", JSON.stringify([AGENT]), "--executor-effort", "xhigh", "--json", "basic"], { cwd,
    env: { ...process.env, ACP_FAKE_EFFORT_OPTIONS: "max,low,none" } });
  assert.equal(result.status, 0, result.stderr);
  const job = listJobs(cwd)[0];
  assert.equal(job.executorEffort, "max");
  assert.equal(job.request.executorEffort, "xhigh");
  assert.match(fs.readFileSync(job.logFile, "utf8"), /reasoning effort xhigh is unavailable; using max/i);
});

test("CODEX_COMPANION_ACP_EFFORT selects and persists the ACP reasoning effort", (t) => {
  isolateTestEnvironment(t);
  const cwd = fs.realpathSync(makeTempDir());
  const env = { ...process.env, CODEX_COMPANION_ACP_EFFORT: "high", ACP_FAKE_EFFORT_OPTIONS: "high,low,none" };
  const result = run(process.execPath, [SCRIPT, "task", "--cwd", cwd, "--executor", "acp", "--executor-command", process.execPath,
    "--executor-args", JSON.stringify([AGENT]), "--json", "basic"], { cwd, env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(listJobs(cwd)[0].executorEffort, "high");
});
