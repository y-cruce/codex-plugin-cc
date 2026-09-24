import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BROKER_BUSY_RPC_CODE, CodexAppServerClient } from "../plugins/codex/scripts/lib/app-server.mjs";
import { createBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-endpoint.mjs";
import { ensureBrokerSession, saveBrokerSession, sendBrokerShutdown, waitForBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { buildEnv } from "./fake-codex-fixture.mjs";
import { BROKER_READY_MS, initGitRepo, isolateTestEnvironment, makeTempDir, run, shutdownTestBrokers } from "./helpers.mjs";
import { liveStatus } from "../plugins/codex/scripts/lib/live-commands.mjs";
import { listJobs } from "../plugins/codex/scripts/lib/state.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = path.join(ROOT, "plugins/codex/scripts/codex-companion.mjs");
async function waitFor(predicate) {
  // Waits on a broker and on worker processes it starts, so it takes the same
  // allowance as a broker starting up.
  for (let i = 0; i < BROKER_READY_MS / 25; i += 1) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for live control.");
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

async function setup(t, timeoutMs = 600000, idleTimeoutMs = 600000) {
  isolateTestEnvironment(t);
  const repo = makeTempDir();
  const bin = makeTempDir();
  const socketDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxl-"));
  fs.copyFileSync(new URL("live-codex-fixture.cjs", import.meta.url), path.join(bin, "codex"));
  fs.chmodSync(path.join(bin, "codex"), 0o755);
  if (process.platform === "win32") fs.writeFileSync(path.join(bin, "codex.cmd"), '@node "%~dp0codex" %*\r\n');
  initGitRepo(repo);
  const endpoint = createBrokerEndpoint(socketDir);
  const pidFile = path.join(socketDir, "broker.pid");
  const env = { ...buildEnv(bin), CLAUDE_PLUGIN_DATA: path.join(repo, ".plugin-data"),
    CODEX_COMPANION_APP_SERVER_ENDPOINT: endpoint, LIVE_CODEX_RECORDING: path.join(bin, "requests.jsonl") };
  const broker = spawn(process.execPath, [path.join(ROOT, "plugins/codex/scripts/app-server-broker.mjs"),
    "serve", "--endpoint", endpoint, "--cwd", repo, "--input-timeout-ms", String(timeoutMs),
    "--idle-timeout-ms", String(idleTimeoutMs), "--pid-file", pidFile], { env });
  let errors = "";
  broker.stderr.on("data", (data) => { errors += data; });
  const closed = new Promise((resolve) => broker.on("exit", resolve));
  const clients = [];
  t.after(async () => {
    for (const client of clients) await client.close();
    await sendBrokerShutdown(endpoint);
    if (broker.exitCode === null) broker.kill();
    await closed;
  });
  assert.equal(await waitForBrokerEndpoint(endpoint, BROKER_READY_MS), true, errors);
  const connect = async () => {
    const client = await CodexAppServerClient.connect(repo, { brokerEndpoint: endpoint, env });
    clients.push(client);
    return client;
  };
  const owner = await connect();
  const notifications = [];
  owner.setNotificationHandler((message) => notifications.push(message));
  const { thread } = await owner.request("thread/start", { cwd: repo, sandbox: "read-only" });
  const start = (text) => owner.request("turn/start", { threadId: thread.id, input: [{ type: "text", text }] });
  const cli = (...args) => run(process.execPath, [SCRIPT, ...args, "--json"], { cwd: repo, env });
  const requests = () => fs.readFileSync(env.LIVE_CODEX_RECORDING, "utf8").trim().split("\n").map(JSON.parse);
  return { repo, env, owner, connect, thread, start, notifications, cli, requests, broker, closed, endpoint, pidFile, socketDir };
}

async function startJob(t, h, prompt, options = ["--write"]) {
  const child = spawn(process.execPath, [SCRIPT, "task", ...options, "--json", prompt], { cwd: h.repo, env: h.env });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data) => { stdout += data; });
  child.stderr.on("data", (data) => { stderr += data; });
  const done = new Promise((resolve) => child.on("exit", (code) => resolve({ code, stdout, stderr })));
  t.after(async () => { if (child.exitCode === null) child.kill(); await done; });
  const storedJob = await waitFor(() => listTestJobs(h)
    .find((item) => item.pid === child.pid && item.threadId && item.turnId));
  const result = h.cli("status");
  assert.equal(result.status, 0, result.stderr);
  const snapshot = JSON.parse(result.stdout);
  const job = (snapshot.threads ?? snapshot.running).find((item) => item.id === storedJob.id);
  return { job, done, child };
}

test("concurrent task jobs share a repository and retain both results and progress logs", async (t) => {
  const h = await setup(t);
  const jobs = await Promise.all([startJob(t, h, "hold first"), startJob(t, h, "hold second")]);
  assert.notEqual(jobs[0].job.threadId, jobs[1].job.threadId);
  const status = h.cli("status");
  assert.equal(status.status, 0, status.stderr);
  const snapshot = JSON.parse(status.stdout);
  assert.deepEqual((snapshot.threads ?? snapshot.running).map((job) => job.id).sort(), jobs.map(({ job }) => job.id).sort());
  const control = await h.connect();
  await Promise.all(jobs.map(({ job }) => control.request("turn/steer", {
    threadId: job.threadId, expectedTurnId: job.turnId, input: [{ type: "text", text: "finish" }]
  })));
  const results = await Promise.all(jobs.map(({ done }) => done));
  for (const [index, result] of results.entries()) {
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).threadId, jobs[index].job.threadId);
    const finished = h.cli("status", jobs[index].job.id);
    assert.equal(finished.status, 0, finished.stderr);
    const job = JSON.parse(finished.stdout).job;
    assert.equal(job.status, "completed");
    assert.ok(fs.existsSync(job.logFile));
    assert.match(fs.readFileSync(job.logFile, "utf8"), /Turn completed/);
  }
});

test("message --interrupt continues the original job and reports retained changes", async (t) => {
  const h = await setup(t);
  const { job, done } = await startJob(t, h, "hold");
  const redirected = h.cli("message", job.id, "--interrupt", "write redirected");
  assert.equal(redirected.status, 0, redirected.stderr);
  const report = JSON.parse(redirected.stdout);
  assert.equal(report.threadId, job.threadId);
  assert.deepEqual(report.partialChanges, [{ path: path.join(fs.realpathSync(h.repo), "partial.txt"), status: "completed" }]);
  const result = await done;
  assert.equal(result.code, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.threadId, job.threadId);
  assert.equal(payload.interruptedTurns[0].turnId, job.turnId);
  assert.match(report.workspaceStatus, /partial.txt/);
  assert.equal(fs.readFileSync(path.join(h.repo, "partial.txt"), "utf8"), "partial");
  assert.equal(fs.readFileSync(path.join(h.repo, "written.txt"), "utf8"), "write redirected");
});

test("liveStatus resolves a running job from executorSessionId without threadId", async (t) => {
  const h = await setup(t);
  const { job, done } = await startJob(t, h, "hold");
  assert.equal(job.executor, "codex");
  assert.equal(job.executorSessionId, job.threadId);
  assert.equal(job.controlEndpoint, h.endpoint);
  const live = await liveStatus(h.repo, { ...job, threadId: undefined });
  assert.equal(live.turnId, job.turnId);
  assert.equal(live.capabilities.midTurnSteer, true);
  const finished = h.cli("message", job.id, "finish");
  assert.equal(finished.status, 0, finished.stderr);
  assert.equal((await done).code, 0);
});

test("CLI status exposes questions and answer resumes the original job", async (t) => {
  const h = await setup(t);
  const { job, done } = await startJob(t, h, "ask");
  const status = h.cli("status", job.id);
  assert.equal(status.status, 0, status.stderr);
  const question = JSON.parse(status.stdout).job.live.questions[0];
  assert.equal(question.requestId, "question-1");
  const stateRoot = path.join(h.env.CLAUDE_PLUGIN_DATA, "state");
  const stateFile = path.join(stateRoot, fs.readdirSync(stateRoot)[0], "state.json");
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  state.jobs.find((entry) => entry.id === job.id).phase = "running";
  fs.writeFileSync(stateFile, JSON.stringify(state));
  const waiting = h.cli("status", job.id, "--wait", "--timeout-ms", "5000");
  assert.equal(waiting.status, 0, waiting.stderr);
  assert.equal(JSON.parse(waiting.stdout).waitingForAnswer, true);
  const forbidden = h.cli("message", job.id, "latest");
  assert.equal(forbidden.status, 1);
  assert.match(forbidden.stderr, /pending question/);
  fs.writeFileSync(path.join(h.repo, "answers.json"), JSON.stringify({ source: { answers: ["latest"] } }));
  const answered = h.cli("answer", job.id, "--request-id", "question-1", "--answers-file", "answers.json");
  assert.equal(answered.status, 0, answered.stderr);
  const result = await done;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).threadId, job.threadId);
  assert.match(JSON.parse(result.stdout).rawOutput, /latest/);
});

test("interruption reports changes that finish during cancellation", async (t) => {
  const h = await setup(t);
  const { turn } = await h.start("hold-late");
  const control = await h.connect();
  const report = await control.request("turn/interrupt", { threadId: h.thread.id, turnId: turn.id });
  assert.deepEqual(report.partialChanges.map((entry) => path.basename(entry.path)), ["partial.txt", "late.txt"]);
  assert.match(report.workspaceStatus, /late.txt/);
});

test("director notifications reply immediately, survive turns, and acknowledge only selected IDs", async (t) => {
  const h = await setup(t);
  const { turn } = await h.start("notify:Use the alternate source");
  await waitFor(() => h.notifications.some((item) => item.method === "turn/completed"));
  const response = h.requests().find((item) => item.id === `tool-${turn.id}`);
  assert.deepEqual(response.result, {
    contentItems: [{ type: "inputText", text: "Delivered to the director." }], success: true
  });
  const first = await h.owner.request("broker/status", { threadId: h.thread.id });
  assert.equal(first.notifications.length, 1);
  const notification = first.notifications[0];
  assert.deepEqual(Object.keys(notification).sort(), ["id", "message", "receivedAt", "turnId"]);
  assert.equal(typeof notification.id, "string");
  assert.ok(notification.id.length > 0);
  assert.equal(notification.message, "Use the alternate source");
  assert.equal(notification.turnId, turn.id);
  assert.equal(new Date(notification.receivedAt).toISOString(), notification.receivedAt);
  assert.deepEqual(h.notifications.find((item) => item.method === "companion/notification").params,
    { threadId: h.thread.id, ...notification });
  await h.start("hold notify:Phase two ready");
  const second = await waitFor(async () => {
    const state = await h.owner.request("broker/status", { threadId: h.thread.id });
    return state.notifications.length === 2 ? state : null;
  });
  assert.notEqual(second.notifications[1].id, notification.id);
  assert.deepEqual(await h.owner.request("broker/ack-notifications", {
    threadId: h.thread.id, ids: [notification.id, "not-pending"]
  }), { remaining: 1 });
  assert.deepEqual((await h.owner.request("broker/status", { threadId: h.thread.id })).notifications,
    [second.notifications[1]]);
});

test("pending questions take precedence over director notifications", async (t) => {
  const h = await setup(t);
  const { job } = await startJob(t, h, "ask notify:Need a source decision");
  await waitFor(async () => (await h.owner.request("broker/status", { threadId: job.threadId })).questions.length);
  const result = h.cli("status", job.id, "--wait", "--timeout-ms", "5000");
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.waitingForAnswer, true);
  assert.equal(report.hasNotifications, undefined);
  assert.equal(report.job.live.notifications[0].message, "Need a source decision");
  assert.deepEqual((await h.owner.request("broker/status", { threadId: job.threadId })).notifications,
    report.job.live.notifications);
});
