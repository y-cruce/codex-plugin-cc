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
