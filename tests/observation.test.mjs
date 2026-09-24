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
import { BROKER_READY_MS, isolateTestEnvironment, makeTempDir, run } from "./helpers.mjs";
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
    await sendBrokerShutdown(endpoint);
    if (broker.exitCode === null) broker.kill();
    await closed;
    fs.rmSync(socketDir, { recursive: true, force: true });
  });
  assert.equal(await waitForBrokerEndpoint(endpoint, BROKER_READY_MS), true, brokerErrors);
  const rpc = async (method, params = {}) => {
    const client = await CodexAppServerClient.connect(repo, { brokerEndpoint: endpoint, env });
    try { return await client.request(method, params); }
    finally { await client.close(); }
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
    }, "running registered job", 30000);
    return jobId;
  };
  return { repo, env, stateDir, endpoint, broker, closed, cli, child, rpc, start };
}

test("observe discovery, committed replay, live projection and follow resume", async (t) => {
  const h = await setup(t);
  const jobId = await h.start("hold observation", "observation task");
  const listing = h.cli("observe", "list", "--json");
  assert.equal(listing.status, 0, listing.stderr);
  const listData = JSON.parse(listing.stdout);
  const jobs = Array.isArray(listData) ? listData : listData.jobs;
  assert.equal(jobs.find((job) => job.id === jobId).historyAvailable, true);
  const located = h.cli("observe", "view-path", jobId);
  assert.equal(located.status, 0, located.stderr);
  const viewPath = located.stdout.trim();
  assert.equal(path.isAbsolute(viewPath), true);
  const readView = () => fs.existsSync(viewPath) ? JSON.parse(fs.readFileSync(viewPath, "utf8")) : null;
  // The window is a backstop, not the test's pace. At ten seconds the setup
  // below -- attaching, a `status` process, the steer -- ate most of it on a
  // loaded machine and the fixture's last event landed after it had expired,
  // so the test failed for being slow rather than for being wrong.
  const followed = h.child("observe", "follow", jobId, "--max-seconds", "60");
  await waitFor(async () => (await h.rpc("broker/observe-status")).followers === 1, "attached follow");
  const metadata = JSON.parse(h.cli("status", jobId, "--json").stdout).job;
  await h.rpc("turn/steer", { threadId: metadata.threadId, expectedTurnId: metadata.turnId, input: [{ type: "text", text: "observation-live" }] });
  const live = await waitFor(() => {
    const view = readView();
    return view?.lastMessage?.text === "live incremental " ? view : null;
  }, "delta-updated live view");
  assert.equal(live.tail.filter((row) => row.text.includes("live incremental")).length, 1);
  const completeView = await waitFor(() => {
    const view = readView();
    return view?.lastMessage?.text === "live incremental conclusion" ? view : null;
  }, "folded message delta");
  assert.equal(completeView.tail.filter((row) => row.text.includes("live incremental")).length, 1);
  await waitFor(() => followed.output().includes("live incremental conclusion") || null, "follow printed the folded message");
  followed.process.kill("SIGINT");
  const result = await followed.done;
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /echo observation-/);
  assert.match(result.stdout, /live incremental conclusion/);
  assert.doesNotMatch(result.stdout, /message\.delta|command\.output\.delta/);
  const savedCursor = cursor(result.stdout);
  const accepted = h.cli("message", jobId, "keep working", "--json");
  assert.equal(accepted.status, 0, accepted.stderr);
  const resumed = h.child("observe", "follow", jobId, "--after", savedCursor, "--max-seconds", "60");
  // The line below is the last thing this follow has to see. Anything the
  // negative assertions guard against would be replayed before it, not after,
  // so stopping here still catches a regression.
  await waitFor(() => resumed.output().includes("director → message: keep working") || null, "resumed follow printed the message");
  resumed.process.kill("SIGINT");
  const resumedResult = await resumed.done;
  assert.equal(resumedResult.code, 0, resumedResult.stderr);
  assert.match(resumedResult.stdout, /director → message: keep working/);
  assert.doesNotMatch(resumedResult.stdout, /echo observation-|live incremental conclusion/);
  const replay = h.cli("observe", "replay", jobId, "--jsonl");
  assert.equal(replay.status, 0, replay.stderr);
  const rows = replay.stdout.trim().split("\n").map(JSON.parse);
  const end = rows.pop();
  assert.equal(end.type, "end");
  assert.ok(rows.some((event) => event.type === "message.delta"));
  assert.ok(rows.every((event) => event.schemaVersion === 2 && event.payload && event.identity));
  assert.ok(rows.every((event) => !Object.hasOwn(event, "threadId") && !Object.hasOwn(event, "turnId") && !Object.hasOwn(event, "itemId")));
  assert.ok(rows.every((event, index) => index === 0 || BigInt(event.seq) > BigInt(rows[index - 1].seq)));
  const tail = h.cli("observe", "replay", jobId, "--after", end.nextCursor, "--jsonl");
  assert.equal(tail.status, 0, tail.stderr);
  assert.equal(JSON.parse(tail.stdout.trim()).type, "end");
});

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
