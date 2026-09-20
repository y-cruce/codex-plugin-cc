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
import { initGitRepo, isolateTestEnvironment, makeTempDir, run } from "./helpers.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = path.join(ROOT, "plugins/codex/scripts/codex-companion.mjs");
const BROKER = path.join(ROOT, "plugins/codex/scripts/app-server-broker.mjs");

async function waitFor(predicate, description = "observation", timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function cursor(output) {
  const match = output.match(/^CURSOR: (.+)$/m);
  assert.ok(match, output);
  return match[1];
}

async function setup(t) {
  isolateTestEnvironment(t);
  const repo = makeTempDir();
  const bin = makeTempDir();
  const socketDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxo-"));
  fs.copyFileSync(new URL("live-codex-fixture.cjs", import.meta.url), path.join(bin, "codex"));
  fs.chmodSync(path.join(bin, "codex"), 0o755);
  if (process.platform === "win32") fs.writeFileSync(path.join(bin, "codex.cmd"), '@node "%~dp0codex" %*\r\n');
  initGitRepo(repo);
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
    await sendBrokerShutdown(endpoint);
    if (broker.exitCode === null) broker.kill();
    await closed;
    fs.rmSync(socketDir, { recursive: true, force: true });
  });
  assert.equal(await waitForBrokerEndpoint(endpoint, 15000), true, brokerErrors);
  const rpc = async (method, params = {}) => {
    const client = await CodexAppServerClient.connect(repo, { brokerEndpoint: endpoint, env });
    try { return await client.request(method, params); }
    finally { await client.close(); }
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
    }, "running registered job", 30000);
    return jobId;
  };
  return { repo, env, endpoint, broker, closed, cli, child, rpc, start };
}

test("follow socket closes on process death and another busy job does not mix streams", async (t) => {
  const h = await setup(t);
  const first = await h.start("hold observation-burst", "busy");
  const second = await h.start("hold observation", "quiet");
  const firstState = JSON.parse(h.cli("status", first, "--json").stdout).job;
  const secondState = JSON.parse(h.cli("status", second, "--json").stdout).job;
  assert.notEqual(firstState.threadId, secondState.threadId);
  const watching = h.child("observe", "follow", first);
  await waitFor(async () => (await h.rpc("broker/observe-status")).followers === 1, "registered follower");
  watching.process.kill("SIGKILL");
  await watching.done;
  await waitFor(async () => (await h.rpc("broker/observe-status")).followers === 0, "detached killed follower");
  const quiet = h.child("observe", "follow", second, "--max-seconds", "0.5");
  const status = h.cli("status", second, "--json");
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).job.status, "running");
  const output = await quiet.done;
  assert.equal(output.code, 0, output.stderr);
  assert.match(output.stdout, new RegExp(`observation-${secondState.threadId}`));
  assert.doesNotMatch(output.stdout, new RegExp(`observation-${firstState.threadId}`));
  cursor(output.stdout);
});

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
  await waitFor(() => JSON.parse(h.cli("status", jobId, "--json").stdout).job.status === "completed", "completed answer job");
  const result = h.cli("result", jobId);
  assert.equal(result.status, 0, result.stderr);
  const stale = await h.child("observe", "follow", jobId).done;
  assert.equal(stale.code, 0, stale.stderr);
  assert.doesNotMatch(stale.stdout, /^QUESTION(?:_PENDING)? /m);
  assert.match(stale.stdout, /^DONE /m);
  await sendBrokerShutdown(h.endpoint);
  await h.closed;
  const followed = await h.child("observe", "follow", jobId, "--after", savedCursor).done;
  assert.equal(followed.code, 0, followed.stderr);
  assert.match(followed.stdout, /director → answer delivered request=question-1/);
  assert.match(followed.stdout, /^DONE job=/m);
  assert.ok(followed.stdout.endsWith(result.stdout), followed.stdout);
  const replay = h.cli("observe", "replay", jobId, "--jsonl");
  assert.equal(replay.status, 0, replay.stderr);
  const rows = replay.stdout.trim().split("\n").map(JSON.parse);
  assert.ok(rows.some((event) => event.type === "question.resolved"));
  assert.equal(rows.at(-1).type, "end");
  const offline = await h.child("observe", "follow", jobId).done;
  assert.equal(offline.code, 0, offline.stderr);
  assert.match(offline.stdout, /^QUESTION_PENDING job=.*request=question-1 still unanswered: Which source\?$/m);
  assert.doesNotMatch(offline.stdout, /^QUESTION /m);
});

test("follow notification records the pending request at emission", async (t) => {
  const h = await setup(t);
  const jobId = await h.start("ask and notify", "pending notification");
  const question = await h.child("observe", "follow", jobId, "--quiet").done;
  assert.match(question.stdout, /^QUESTION job=/m);
  const notified = await h.child("observe", "follow", jobId, "--after", cursor(question.stdout), "--quiet").done;
  assert.equal(notified.code, 0, notified.stderr);
  assert.match(notified.stdout, new RegExp(`^NOTIFIED job=${jobId} \\[pending notification\\] thread=.*pending_request=question-1 Source decision needed$`, "m"));
  const repeated = await h.child("observe", "follow", jobId, "--quiet").done;
  assert.equal(repeated.code, 0, repeated.stderr);
  assert.match(repeated.stdout, /^QUESTION_PENDING job=.*request=question-1 still unanswered: Which source\?$/m);
  assert.doesNotMatch(repeated.stdout, /^QUESTION /m);
});

test("unknown view path is a structured nonzero lookup failure", async (t) => {
  const h = await setup(t);
  const result = h.cli("observe", "view-path", "missing");
  assert.equal(result.status, 1);
  assert.equal(result.stderr.trim(), "UNKNOWN_JOB missing");
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
  const h = await setup(t);
  const jobId = await h.start("hold observation", "quiet relay");
  const result = await h.child("observe", "follow", jobId, "--quiet", "--max-seconds", "0.5").done;
  assert.equal(result.code, 0, result.stderr);
  const lines = result.stdout.trim().split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^CURSOR: /);
  assert.match(lines[1], /^TIMEOUT job=.*0\.5s elapsed, continue with --after$/);
});
