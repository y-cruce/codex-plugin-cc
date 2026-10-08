import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient } from "../plugins/codex/scripts/lib/app-server.mjs";
import { createBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-endpoint.mjs";
import { sendBrokerShutdown, waitForBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { buildEnv } from "./fake-codex-fixture.mjs";
import { BROKER_READY_MS, isolateTestEnvironment, makeTempDir, run, closeTestBroker, within } from "./helpers.mjs";
import { readHistory } from "../plugins/codex/scripts/lib/job-event-store.mjs";
import { listJobs, resolveStateDir } from "../plugins/codex/scripts/lib/state.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = path.join(ROOT, "plugins/codex/scripts/codex-companion.mjs");
const BROKER = path.join(ROOT, "plugins/codex/scripts/app-server-broker.mjs");

async function waitFor(predicate, description = "observation", timeoutMs = BROKER_READY_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function listTestJobs(h) {
  const pluginData = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = h.env.CLAUDE_PLUGIN_DATA;
  try {
    return listJobs(h.repo);
  } finally {
    if (pluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = pluginData;
  }
}

async function setup(t) {
  isolateTestEnvironment(t);
  const repo = makeTempDir();
  const bin = makeTempDir();
  const socketDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxo-"));
  fs.copyFileSync(new URL("live-codex-fixture.cjs", import.meta.url), path.join(bin, "codex"));
  fs.chmodSync(path.join(bin, "codex"), 0o755);
  if (process.platform === "win32") fs.writeFileSync(path.join(bin, "codex.cmd"), '@node "%~dp0codex" %*\r\n');
  const endpoint = createBrokerEndpoint(socketDir);
  const env = { ...buildEnv(bin), CLAUDE_PLUGIN_DATA: path.join(repo, ".plugin-data"), CODEX_COMPANION_APP_SERVER_ENDPOINT: endpoint };
  const previousPluginData = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = env.CLAUDE_PLUGIN_DATA;
  const stateDir = resolveStateDir(repo);
  if (previousPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
  else process.env.CLAUDE_PLUGIN_DATA = previousPluginData;
  const broker = spawn(process.execPath, [BROKER, "serve", "--endpoint", endpoint, "--cwd", repo,
    "--pid-file", path.join(socketDir, "broker.pid"), "--idle-timeout-ms", "600000"], { env });
  let brokerErrors = "";
  broker.stderr.on("data", (chunk) => { brokerErrors += chunk; });
  const closed = new Promise((resolve) => broker.on("exit", resolve));
  const children = [];
  const jobs = [];
  const workerPids = new Set();
  const cli = (...args) => run(process.execPath, [SCRIPT, ...args, "--cwd", repo], { cwd: repo, env });
  const child = (...args) => {
    const process = spawn(globalThis.process.execPath, [SCRIPT, ...args, "--cwd", repo], { cwd: repo, env });
    let stdout = "";
    let stderr = "";
    process.stdout.on("data", (chunk) => { stdout += chunk; });
    process.stderr.on("data", (chunk) => { stderr += chunk; });
    const done = new Promise((resolve) => process.on("exit", (code) => resolve({ code, stdout, stderr })));
    const entry = { process, done, output: () => stdout };
    children.push(entry);
    return entry;
  };
  t.after(async () => {
    for (const entry of children) if (entry.process.exitCode === null) entry.process.kill();
    await Promise.all(children.map((entry) => entry.done));
    for (const pid of workerPids) {
      try { globalThis.process.kill(pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
    await closeTestBroker(broker, closed, endpoint, [], path.join(socketDir, "broker.pid"));
    fs.rmSync(socketDir, { recursive: true, force: true });
  });
  assert.equal(await waitForBrokerEndpoint(endpoint, BROKER_READY_MS), true, brokerErrors);
  const rpc = async (method, params = {}) => {
    const client = await CodexAppServerClient.connect(repo, { brokerEndpoint: endpoint, env });
    try { return await client.request(method, params); }
    finally {
      try { await within(client.close(), 1000, "observation RPC close"); }
      finally { client.socket?.destroy(); }
    }
  };
  const start = async (prompt, label = prompt, options = []) => {
    const result = cli("task", "--background", ...options, "--label", label, "--json", prompt);
    assert.equal(result.status, 0, result.stderr);
    const launched = JSON.parse(result.stdout);
    const jobId = launched.jobId;
    jobs.push(jobId);
    await waitFor(() => {
      let job;
      try { job = JSON.parse(fs.readFileSync(launched.logFile.replace(/\.log$/, ".json"), "utf8")); }
      catch { return false; }
      if (job.pid) workerPids.add(job.pid);
      return job.threadId && job.turnId ? job : false;
    }, "running registered job");
    return jobId;
  };
  return { repo, env, stateDir, endpoint, broker, closed, cli, child, rpc, start };
}

test("resuming one thread routes the next job to its own history, view, follow and result", async (t) => {
  const h = await setup(t);
  const history = (jobId) => readHistory(h.repo, jobId, { stateDir: h.stateDir });
  const firstId = await h.start("hold observation", "first observation");
  const firstRunning = JSON.parse(h.cli("status", firstId, "--json").stdout).job;
  const firstFollow = h.child("observe", "follow", firstId, "--max-seconds", "10");
  await waitFor(async () => (await h.rpc("broker/observe-status")).followers === 1, "first follow");
  await h.rpc("turn/steer", { threadId: firstRunning.threadId, expectedTurnId: firstRunning.turnId,
    input: [{ type: "text", text: "finish" }] });
  const firstFollowed = await firstFollow.done;
  assert.equal(firstFollowed.code, 0, firstFollowed.stderr);
  assert.match(firstFollowed.stdout, new RegExp(`DONE job=${firstId}`));
  await waitFor(() => listTestJobs(h).find((job) => job.id === firstId)?.status === "completed", "first completion");
  const firstTerminalHistory = await history(firstId);
  assert.equal(firstTerminalHistory.events.at(-1).type, "job.completed");

  const secondId = await h.start("hold observation-burst", "resumed observation", ["--resume-last"]);
  const secondRunning = JSON.parse(h.cli("status", secondId, "--json").stdout).job;
  assert.equal(secondRunning.threadId, firstRunning.threadId);
  const secondFollow = h.child("observe", "follow", secondId, "--max-seconds", "10");
  await waitFor(async () => (await h.rpc("broker/observe-status")).followers === 1, "second follow");
  await waitFor(async () => (await history(secondId)).events.some((event) => event.type === "command.completed"),
    "second job history");
  await h.rpc("turn/steer", { threadId: secondRunning.threadId, expectedTurnId: secondRunning.turnId,
    input: [{ type: "text", text: "finish" }] });
  const secondFollowed = await secondFollow.done;
  assert.equal(secondFollowed.code, 0, secondFollowed.stderr);
  assert.match(secondFollowed.stdout, new RegExp(`DONE job=${secondId}`));
  await waitFor(() => listTestJobs(h).find((job) => job.id === secondId)?.status === "completed", "second completion");

  const firstHistory = await history(firstId);
  const secondHistory = await history(secondId);
  assert.ok(BigInt(firstHistory.committedSeq) > BigInt(firstTerminalHistory.committedSeq));
  assert.ok(secondHistory.events.some((event) => event.type === "turn.started"));
  assert.ok(secondHistory.events.some((event) => event.type === "command.completed"));
  assert.ok(secondHistory.events.some((event) => event.type === "message.delta"));
  assert.equal(secondHistory.events.at(-1).type, "job.completed");
  assert.ok(firstHistory.events.every((event) => event.jobId === firstId));
  assert.ok(secondHistory.events.every((event) => event.jobId === secondId));

  const firstViewPath = h.cli("observe", "view-path", firstId).stdout.trim();
  const secondViewPath = h.cli("observe", "view-path", secondId).stdout.trim();
  assert.equal(firstViewPath, secondViewPath);
  const threadView = JSON.parse(fs.readFileSync(firstViewPath, "utf8"));
  assert.equal(threadView.status, "completed");
  assert.equal(threadView.turnId, secondRunning.turnId);
  assert.deepEqual(threadView.rounds.map((round) => round.jobId), [firstId, secondId]);
  assert.match(firstFollowed.stdout, /observation conclusion/);
  assert.match(secondFollowed.stdout, /observation conclusion/);

  const firstResult = h.cli("result", firstId);
  const secondResult = h.cli("result", secondId);
  assert.equal(firstResult.status, 0, firstResult.stderr);
  assert.equal(secondResult.status, 0, secondResult.stderr);
  assert.match(firstResult.stdout, /hold observation\|finish/);
  assert.doesNotMatch(firstResult.stdout, /hold observation-burst/);
  assert.match(secondResult.stdout, /hold observation-burst\|finish/);
});
