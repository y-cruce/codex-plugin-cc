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
import { initGitRepo, isolateTestEnvironment, makeTempDir, run, shutdownTestBrokers } from "./helpers.mjs";
import { liveStatus } from "../plugins/codex/scripts/lib/live-commands.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = path.join(ROOT, "plugins/codex/scripts/codex-companion.mjs");
async function waitFor(predicate) {
  for (let i = 0; i < 200; i += 1) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for live control.");
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
  assert.equal(await waitForBrokerEndpoint(endpoint, 15000), true, errors);
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
  const job = await waitFor(() => {
    const result = h.cli("status");
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout).running.find((item) => item.pid === child.pid && item.threadId && item.turnId);
  });
  return { job, done, child };
}

test("task thread starts declare notify_director and initialize enables experimental API", async (t) => {
  const h = await setup(t);
  const task = h.cli("task", "initial");
  assert.equal(task.status, 0, task.stderr);
  const threadId = JSON.parse(task.stdout).threadId;
  const requests = h.requests();
  assert.equal(requests.find((item) => item.method === "initialize").params.capabilities.experimentalApi, true);
  const starts = requests.filter((item) => item.method === "thread/start");
  assert.equal(starts[0].params.dynamicTools, undefined);
  assert.deepEqual(starts[1].params.dynamicTools, [{
    type: "function", name: "notify_director",
    description: "Send a short note to the director agent that started you, without stopping your work. Use it only for conclusions that change the plan, blockers you are working around, or a finished phase the director could act on now. Do not report routine progress. Returns immediately; the director does not reply through this tool. Notes longer than 400 characters are rejected.",
    inputSchema: { type: "object", properties: { message: { type: "string", maxLength: 400 } }, required: ["message"], additionalProperties: false },
    deferLoading: false
  }]);
  const resumed = h.cli("task", "--thread", threadId, "continue");
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(h.requests().find((item) => item.method === "thread/resume").params.dynamicTools, undefined);
});

function startEvents(t, h) {
  const child = spawn(process.execPath, [SCRIPT, "events", "--cwd", h.repo, "--poll-ms", "20"], {
    cwd: h.repo, env: h.env
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data) => { stdout += data; });
  child.stderr.on("data", (data) => { stderr += data; });
  const done = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal, stdout, stderr })));
  t.after(async () => { if (child.exitCode === null) child.kill(); await done; });
  return { child, done, lines: () => stdout.split("\n").slice(0, -1) };
}

test("events emits one notification and one completion, acknowledges the note, and exits cleanly on SIGINT", async (t) => {
  const h = await setup(t);
  const { job, done } = await startJob(t, h, "hold notify:Build phase ready");
  const events = startEvents(t, h);
  const notified = `NOTIFIED job=${job.id} thread=${job.threadId} Build phase ready`;
  const completed = `DONE job=${job.id} thread=${job.threadId}`;
  await waitFor(() => events.lines().includes(notified));
  await waitFor(async () => !(await h.owner.request("broker/status", { threadId: job.threadId })).notifications.length);
  const waiting = h.cli("status", job.id, "--wait", "--timeout-ms", "150");
  assert.equal(waiting.status, 0, waiting.stderr);
  assert.equal(JSON.parse(waiting.stdout).hasNotifications, undefined);
  assert.equal(JSON.parse(waiting.stdout).waitTimedOut, true);
  const finished = h.cli("message", job.id, "finish");
  assert.equal(finished.status, 0, finished.stderr);
  assert.equal((await done).code, 0);
  await waitFor(() => events.lines().includes(completed));
  events.child.kill("SIGINT");
  const result = await events.done;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.deepEqual(result.stdout.trimEnd().split("\n"), [notified, completed]);
});

test("events and status --wait report a killed task owner as failed once", async (t) => {
  const h = await setup(t);
  const { job, done, child } = await startJob(t, h, "hold notify:Owner ready");
  const events = startEvents(t, h);
  await waitFor(() => events.lines().some((line) => line.startsWith(`NOTIFIED job=${job.id} `)));
  child.kill("SIGKILL");
  await done;
  const waiting = h.cli("status", job.id, "--wait", "--timeout-ms", "5000");
  assert.equal(waiting.status, 0, waiting.stderr);
  const snapshot = JSON.parse(waiting.stdout);
  assert.equal(snapshot.job.status, "failed");
  assert.equal(snapshot.waitTimedOut, false);
  assert.match(snapshot.job.errorMessage, /owner process exited/i);
  const failed = `FAILED job=${job.id} thread=${job.threadId} owner process exited`;
  await waitFor(() => events.lines().includes(failed));
  events.child.kill("SIGTERM");
  const result = await events.done;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.deepEqual(events.lines().filter((line) => line.startsWith("FAILED ")), [failed]);
  assert.equal(JSON.parse(h.cli("status", job.id).stdout).job.status, "failed");
});

test("events and status --wait report a quiet live task as stalled without failing it", async (t) => {
  const h = await setup(t);
  const { job, done } = await startJob(t, h, "hold notify:Owner ready");
  const notified = h.cli("status", job.id, "--wait", "--timeout-ms", "5000");
  assert.equal(notified.status, 0, notified.stderr);
  assert.equal(JSON.parse(notified.stdout).hasNotifications, true);
  const old = new Date(Date.now() - 20 * 60 * 1000);
  fs.utimesSync(job.logFile, old, old);
  const events = startEvents(t, h);
  await waitFor(() => events.lines().some((line) => line === `STALLED job=${job.id} thread=${job.threadId} 20m without progress`));
  const waiting = h.cli("status", job.id, "--wait", "--timeout-ms", "5000");
  assert.equal(waiting.status, 0, waiting.stderr);
  const snapshot = JSON.parse(waiting.stdout);
  assert.equal(snapshot.stalled, true);
  assert.equal(snapshot.waitTimedOut, false);
  assert.equal(snapshot.job.status, "running");
  const again = h.cli("status", job.id, "--wait", "--timeout-ms", "150");
  assert.equal(again.status, 0, again.stderr);
  assert.equal(JSON.parse(again.stdout).stalled, undefined);
  assert.equal(JSON.parse(again.stdout).waitTimedOut, true);
  events.child.kill("SIGTERM");
  const result = await events.done;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(events.lines().filter((line) => line.startsWith("STALLED ")).length, 1);
  assert.equal(h.cli("message", job.id, "finish").status, 0);
  assert.equal((await done).code, 0);
});

test("task sandbox and network options are persisted and preserved through interrupt redirects", async (t) => {
  const h = await setup(t);
  for (const { options, sandbox, policy } of [
    { options: ["--sandbox", "danger-full-access"], sandbox: "danger-full-access", policy: { type: "dangerFullAccess" } },
    { options: ["--write", "--network"], sandbox: "workspace-write", policy: {
      type: "workspaceWrite", writableRoots: [fs.realpathSync(h.repo)], networkAccess: true,
      excludeTmpdirEnvVar: false, excludeSlashTmp: false
    } }
  ]) {
    const { job, done } = await startJob(t, h, "hold", options);
    const status = h.cli("status", job.id);
    assert.equal(status.status, 0, status.stderr);
    const current = JSON.parse(status.stdout).job;
    assert.equal(current.sandbox, sandbox);
    assert.equal(current.request.sandbox, sandbox);
    assert.equal(current.write, true);
    assert.equal(current.network, sandbox === "workspace-write");
    assert.equal(current.request.network, sandbox === "workspace-write");
    const started = h.requests().filter((item) => item.method === "turn/start" && item.params.threadId === job.threadId);
    assert.equal(started.length, 1);
    assert.deepEqual(started[0].params.sandboxPolicy, policy);
    const redirected = h.cli("message", job.id, "--interrupt", "write redirected");
    assert.equal(redirected.status, 0, redirected.stderr);
    const result = await done;
    assert.equal(result.code, 0, result.stderr);
    const turns = h.requests().filter((item) => item.method === "turn/start" && item.params.threadId === job.threadId);
    assert.equal(turns.length, 2);
    assert.deepEqual(turns[1].params.sandboxPolicy, policy);
    assert.equal(fs.readFileSync(path.join(h.repo, "written.txt"), "utf8"), "write redirected");
  }
  const readonly = h.cli("task", "--write", "--sandbox", "read-only", "initial");
  assert.equal(readonly.status, 0, readonly.stderr);
  const job = JSON.parse(h.cli("status").stdout).latestFinished;
  assert.equal(job.sandbox, "read-only");
  assert.equal(job.write, false);
  const started = h.requests().find((item) => item.method === "turn/start" && item.params.threadId === job.threadId);
  assert.deepEqual(started.params.sandboxPolicy, { type: "readOnly", networkAccess: false });
});
