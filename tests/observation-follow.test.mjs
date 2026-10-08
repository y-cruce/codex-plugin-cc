import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient } from "../plugins/codex/scripts/lib/app-server.mjs";
import { createBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-endpoint.mjs";
import { sendBrokerShutdown, waitForBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { JobEventStore, readHistory } from "../plugins/codex/scripts/lib/job-event-store.mjs";
import { handleObserve } from "../plugins/codex/scripts/lib/job-observe.mjs";
import { ObservationClient } from "../plugins/codex/scripts/lib/observation-client.mjs";
import { renderStoredJobResult } from "../plugins/codex/scripts/lib/render.mjs";
import { listJobs, writeJobFile, upsertJob } from "../plugins/codex/scripts/lib/state.mjs";
import { buildEnv } from "./fake-codex-fixture.mjs";
import { BROKER_READY_MS, isolateTestEnvironment, makeTempDir, run, waitFor, closeTestBroker, within } from "./helpers.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = path.join(ROOT, "plugins/codex/scripts/codex-companion.mjs");
const BROKER = path.join(ROOT, "plugins/codex/scripts/app-server-broker.mjs");



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

function cursor(output) {
  const match = output.match(/^CURSOR: (.+)$/m);
  assert.ok(match, output);
  return match[1];
}

async function observe(t, h, ...args) {
  const previous = { ...process.env };
  Object.assign(process.env, h.env);
  let stdout = "";
  const output = t.mock.method(process.stdout, "write", (text) => { stdout += text; return true; });
  try {
    await handleObserve([...args, "--cwd", h.repo]);
    return { code: 0, stdout, stderr: "" };
  } finally {
    output.mock.restore();
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
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
    const client = await CodexAppServerClient.connect(repo, { brokerEndpoint: endpoint, env, brokerTimeoutMs: BROKER_READY_MS });
    try { return await client.request(method, params); }
    finally {
      try { await within(client.close(), 1000, "observation RPC close"); }
      finally { client.socket?.destroy(); }
    }
  };
  const start = async (prompt, label = prompt) => {
    const result = cli("task", "--background", "--label", label, "--json", prompt);
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
  return { repo, env, endpoint, broker, closed, cli, child, rpc, start };
}

test("QUESTION exits with cursor and successful answers appear before terminal offline replay", async (t) => {
  const h = await setup(t);
  const jobId = await h.start("ask", "question job");
  const question = await h.child("observe", "follow", jobId).done;
  assert.equal(question.code, 0, question.stderr);
  assert.match(question.stdout, /^QUESTION job=.*request=question-1 Which source\?$/m);
  const savedCursor = cursor(question.stdout);
  const answersFile = path.join(h.repo, "answers.json");
  fs.writeFileSync(answersFile, JSON.stringify({ source: { answers: ["latest"] } }));
  const answered = h.cli("answer", jobId, "--request-id", "question-1", "--answers-file", answersFile, "--json");
  assert.equal(answered.status, 0, answered.stderr);
  await waitFor(() => listTestJobs(h).find((job) => job.id === jobId)?.status === "completed", "completed answer job");
  const stored = JSON.parse(fs.readFileSync(listTestJobs(h).find((job) => job.id === jobId).logFile.replace(/\.log$/, ".json"), "utf8"));
  const result = { stdout: renderStoredJobResult(stored, stored), status: 0, stderr: "" };
  assert.equal(result.status, 0, result.stderr);
  const stale = await observe(t, h, "follow", jobId);
  assert.equal(stale.code, 0, stale.stderr);
  assert.doesNotMatch(stale.stdout, /^QUESTION(?:_PENDING)? /m);
  assert.match(stale.stdout, /^DONE /m);
  await sendBrokerShutdown(h.endpoint);
  await h.closed;
  const followed = await observe(t, h, "follow", jobId, "--after", savedCursor);
  assert.equal(followed.code, 0, followed.stderr);
  assert.match(followed.stdout, /director → answer delivered request=question-1/);
  assert.match(followed.stdout, /^DONE job=/m);
  assert.ok(followed.stdout.endsWith(result.stdout), followed.stdout);
  const replay = await observe(t, h, "replay", jobId, "--jsonl");
  assert.equal(replay.code, 0, replay.stderr);
  const rows = replay.stdout.trim().split("\n").map(JSON.parse);
  assert.ok(rows.some((event) => event.type === "question.resolved"));
  assert.equal(rows.at(-1).type, "end");
  const offline = await observe(t, h, "follow", jobId);
  assert.equal(offline.code, 0, offline.stderr);
  assert.doesNotMatch(offline.stdout, /^QUESTION(?:_PENDING)? /m);
  assert.match(offline.stdout, /^DONE job=/m);
});

test("follow notification records the pending request at emission", async (t) => {
  const h = await setup(t);
  const jobId = await h.start("ask and notify", "pending notification");
  const question = await h.child("observe", "follow", jobId, "--quiet").done;
  assert.match(question.stdout, /^QUESTION job=/m);
  const notified = await h.child("observe", "follow", jobId, "--after", cursor(question.stdout), "--quiet").done;
  assert.equal(notified.code, 0, notified.stderr);
  assert.match(notified.stdout, new RegExp(`^NOTIFIED job=${jobId} \\[pending notification\\] thread=.*pending_request=question-1 Source decision needed$`, "m"));
  const repeated = await observe(t, h, "follow", jobId, "--quiet");
  assert.equal(repeated.code, 0, repeated.stderr);
  assert.match(repeated.stdout, /^QUESTION_PENDING job=.*request=question-1 still unanswered: Which source\?$/m);
  assert.doesNotMatch(repeated.stdout, /^QUESTION /m);
});


test("notifications use milestone vocabulary and until done keeps following through interrupt", async (t) => {
  const h = await setup(t);
  const jobId = await h.start("hold notify:observation note", "notifying job");
  const notified = await h.child("observe", "follow", jobId).done;
  assert.equal(notified.code, 0, notified.stderr);
  assert.match(notified.stdout, /^NOTIFIED job=.*observation note$/m);
  const resumed = h.child("observe", "follow", jobId, "--after", cursor(notified.stdout), "--until", "done");
  await waitFor(async () => (await h.rpc("broker/observe-status")).followers === 1, "resumed notification follower");
  const redirected = h.cli("message", jobId, "--interrupt", "resumed result", "--json");
  assert.equal(redirected.status, 0, redirected.stderr);
  const result = await resumed.done;
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /director → interrupt: resumed result/);
  assert.match(result.stdout, /^DONE job=/m);
  assert.match(result.stdout, /resumed result/);
});

test("quiet live follow suppresses items and exits with cursor and TIMEOUT", async (t) => {
  isolateTestEnvironment(t);
  const repo = makeTempDir();
  const job = { id: "task-quiet", label: "quiet relay", executor: "codex", status: "running", threadId: "quiet-thread",
    workspaceRoot: repo, startedAt: new Date().toISOString() };
  writeJobFile(repo, job.id, job);
  upsertJob(repo, job);
  const store = await new JobEventStore(repo, job.id).initialize({ job });
  store.append({ type: "message.completed", source: { message: { params: { item: { text: "VISIBLE_ITEM_TEXT" } } } } });
  await store.close();
  const page = await readHistory(repo, job.id);
  t.mock.method(ObservationClient, "connect", async () => {
    const client = new EventEmitter();
    client.socket = { pause() {}, resume() {} };
    client.close = () => {};
    client.request = async () => {
      client.emit("notification", { method: "broker/observation", params: page });
      await setImmediate();
      t.mock.timers.tick(500);
      await setImmediate();
    };
    return client;
  });
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: Date.now() });
  try {
    const normal = await observe(t, { repo, env: { ...process.env } }, "follow", job.id, "--max-seconds", "0.5");
    assert.match(normal.stdout, /VISIBLE_ITEM_TEXT/);
    const result = await observe(t, { repo, env: { ...process.env } }, "follow", job.id, "--quiet", "--max-seconds", "0.5");
    assert.equal(result.code, 0, result.stderr);
    const lines = result.stdout.trim().split("\n");
    assert.equal(lines.length, 2);
    assert.doesNotMatch(result.stdout, /VISIBLE_ITEM_TEXT/);
    assert.match(lines[0], /^CURSOR: /);
    assert.match(lines[1], /^TIMEOUT job=.*0\.5s elapsed, continue with --after$/);
  } finally {
    t.mock.timers.reset();
  }
});
