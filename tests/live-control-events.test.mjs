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
import { BROKER_READY_MS, initGitRepo, isolateTestEnvironment, makeTempDir, run, shutdownTestBrokers, waitFor, closeTestBroker } from "./helpers.mjs";
import { liveStatus } from "../plugins/codex/scripts/lib/live-commands.mjs";
import { listJobs } from "../plugins/codex/scripts/lib/state.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = path.join(ROOT, "plugins/codex/scripts/codex-companion.mjs");


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
  t.after(() => closeTestBroker(broker, closed, endpoint, clients, pidFile));
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
  return { job: storedJob, done, child };
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
    description: "Send a short note to the director agent that started you, without stopping your work. Use it only when the director must act while you keep working (a blocker it has to clear, a decision or scope change it must approve, a finding that makes the brief wrong) or when another running task needs something you learned and the director has to relay it. Never send progress, finished steps or findings that only feed your final answer; those belong in your final message. Returns immediately; the director does not reply through this tool. Notes longer than 400 characters are rejected.",
    inputSchema: { type: "object", properties: { message: { type: "string", maxLength: 400 } }, required: ["message"], additionalProperties: false },
    deferLoading: false
  }]);
  const resumed = h.cli("task", "--thread", threadId, "continue");
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(h.requests().find((item) => item.method === "thread/resume").params.dynamicTools, undefined);
});

test("queued Codex messages are delivered together in one next turn and leave no queued rows", async (t) => {
  const h = await setup(t);
  const { job, done } = await startJob(t, h, "hold");
  const pending = ["queued-next\nKeep both paragraphs.", "queued-second"];
  for (const text of pending) {
    const queued = h.cli("message", job.id, "--queue", text);
    assert.equal(queued.status, 0, queued.stderr);
  }
  const listing = h.cli("observe", "threads");
  assert.equal(listing.status, 0, listing.stderr);
  const viewPath = JSON.parse(listing.stdout).threads.find(thread => thread.jobId === job.id).viewPath;
  const view = () => JSON.parse(fs.readFileSync(viewPath, "utf8"));
  assert.deepEqual(view().queuedPrompts.map(prompt => prompt.text), pending);
  assert.equal(view().tail.some(row => row.text.includes("queued-next")), false);
  assert.equal(h.cli("message", job.id, "finish").status, 0);
  const result = await done;
  assert.equal(result.code, 0, result.stderr);
  const finished = view();
  assert.deepEqual(finished.queuedPrompts, []);
  const messages = finished.tail.filter(row => row.type === "control.message.updated" || row.type === "message.completed");
  assert.deepEqual(messages.map(row => row.text), ["director → message: finish", "assistant: hold|finish",
    `director → message: ${pending.join("\n\n")}`, `assistant: ${pending.join("\n")}`]);
  const turns = h.requests().filter(request => request.method === "turn/start");
  assert.equal(turns.length, 2, "the backlog starts exactly one additional turn");
  assert.deepEqual(turns[1].params.input.map(block => block.text), pending);
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

test("task sandbox and network options are persisted and preserved through interrupt redirects", async (t) => {
  const h = await setup(t);
  for (const { options, sandbox, policy } of [
    { options: ["--sandbox", "danger-full-access"], sandbox: "danger-full-access", policy: { type: "dangerFullAccess" } },
    { options: ["--write", "--network"], sandbox: "workspace-write", policy: { type: "workspaceWrite",
      writableRoots: [fs.realpathSync(h.repo)], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false } }
  ]) {
    const { job, done } = await startJob(t, h, "hold", options);
    const current = job;
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
  const snapshot = JSON.parse(h.cli("status").stdout);
  const job = snapshot.threads?.find((thread) => thread.status !== "queued" && thread.status !== "running") ?? snapshot.latestFinished;
  assert.equal(job.sandbox, "read-only");
  assert.equal(job.write, false);
  assert.equal(job.network, false);
  const started = h.requests().find((item) => item.method === "turn/start" && item.params.threadId === job.threadId);
  assert.deepEqual(started.params.sandboxPolicy, { type: "readOnly", networkAccess: false });
});
