import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { setImmediate } from "node:timers/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createBrokerEndpoint, parseBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-endpoint.mjs";
import { JobRuntime } from "../plugins/codex/scripts/lib/job-runtime.mjs";
import { JobEventStore, readHistory } from "../plugins/codex/scripts/lib/job-event-store.mjs";
import { resolveJobFile, writeJobFile, upsertJob } from "../plugins/codex/scripts/lib/state.mjs";
import { renderStoredJobResult } from "../plugins/codex/scripts/lib/render.mjs";
import { handleObserve } from "../plugins/codex/scripts/lib/job-observe.mjs";
import { ObservationClient } from "../plugins/codex/scripts/lib/observation-client.mjs";
import { isolateTestEnvironment, makeTempDir } from "./helpers.mjs";

const SCRIPT = fileURLToPath(new URL("../plugins/codex/scripts/codex-companion.mjs", import.meta.url));

function fixture(t, status = "completed") {
  isolateTestEnvironment(t);
  const cwd = fs.realpathSync(makeTempDir());
  const job = { id: "task-errors", label: "error contract", kind: "task", jobClass: "task", workspaceRoot: cwd,
    status, startedAt: "2026-09-15T00:00:00.000Z", createdAt: "2026-09-15T00:00:00.000Z", threadId: "thread-errors", turnId: "turn-errors" };
  writeJobFile(cwd, job.id, job);
  upsertJob(cwd, job);
  const env = { ...process.env };
  const cli = (...args) => {
    const child = spawn(process.execPath, [SCRIPT, ...args, "--cwd", cwd], { cwd, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    const done = new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code) => resolve({ code, stdout, stderr }));
    });
    t.after(async () => { if (child.exitCode === null) child.kill(); await done; });
    return done;
  };
  return { cwd, job, env, cli };
}

async function expiredFixture(t) {
  const h = fixture(t);
  const store = await new JobEventStore(h.cwd, h.job.id, { segmentBytes: 700, maxJobBytes: 1500 }).initialize({ job: h.job });
  t.after(() => store.close());
  const event = () => ({ type: "message.delta", occurredAt: "2026-09-15T00:00:00.000Z", source: { message: { method: "item/agentMessage/delta", params: { delta: "x".repeat(150) } } } });
  store.append(event());
  await store.flush();
  const old = (await readHistory(h.cwd, h.job.id)).nextCursor;
  for (let i = 0; i < 6; i++) {
    store.append(event());
    await store.flush();
  }
  return { ...h, old };
}

async function followWithClock(t, observe) {
  const h = fixture(t, "running");
  const started = Date.now();
  h.job.startedAt = h.job.createdAt = new Date(started - 60 * 60000).toISOString();
  writeJobFile(h.cwd, h.job.id, h.job);
  upsertJob(h.cwd, h.job);
  const store = await new JobEventStore(h.cwd, h.job.id).initialize({ job: h.job });
  store.append({ type: "message.delta", receivedAt: new Date(started - 1000).toISOString(),
    source: { message: { method: "item/agentMessage/delta", params: { delta: "previous progress" } } } });
  await store.close();
  const page = await readHistory(h.cwd, h.job.id);
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: started });
  let output = "";
  const stdout = t.mock.method(process.stdout, "write", (text) => { output += text; return true; });
  const client = new EventEmitter();
  client.socket = { pause() {}, resume() {} };
  client.close = () => {};
  let seq = 1;
  const emit = async (type, receivedAt = Date.now(), params = { job: h.job, delta: "live progress" }) => {
    client.emit("notification", { method: "broker/observation", params: { ...page, events: [{
      type, seq: String(++seq), receivedAt: new Date(receivedAt).toISOString(),
      threadId: h.job.threadId, source: { message: { params } }
    }] } });
    await setImmediate();
  };
  const requests = [];
  client.request = async (method, params) => {
    requests.push({ method, params });
    await observe({ emit, output: () => output, started, tick: async (ms) => {
      t.mock.timers.tick(ms);
      await setImmediate();
    } });
    await emit("job.completed");
  };
  t.mock.method(ObservationClient, "connect", async () => client);
  try {
    await handleObserve(["follow", h.job.id, "--cwd", h.cwd, "--after", page.nextCursor, "--quiet"]);
  } finally {
    stdout.mock.restore();
    t.mock.timers.reset();
  }
  assert.deepEqual(requests, [{ method: "broker/observe-follow", params: { cwd: h.cwd, jobId: h.job.id, after: page.nextCursor } }]);
  return output;
}

test("follow reports a question when live pending state is unavailable", async (t) => {
  const output = await followWithClock(t, async ({ emit, started }) => {
    await emit("question.opened", started, { requestId: "request-1", questions: [{ question: "Choose?" }] });
  });
  assert.match(output, /^CURSOR: /m);
  assert.match(output, /^QUESTION job=task-errors .*request=request-1 Choose\?$/m);
  assert.doesNotMatch(output, /^DONE /m);
});

test("offline until-done follow skips a resolved historical question", async (t) => {
  const h = fixture(t);
  const store = await new JobEventStore(h.cwd, h.job.id).initialize({ job: h.job });
  const source = (method, params) => ({ message: { method, params: { threadId: h.job.threadId, ...params } } });
  store.append({ type: "question.opened", occurredAt: h.job.startedAt,
    source: source("companion/question", { requestId: "request-1", questions: [{ question: "Choose?" }] }) });
  store.append({ type: "question.resolved", occurredAt: h.job.startedAt,
    source: source("companion/answer-delivered", { requestId: "request-1", answers: { source: { answers: ["latest"] } } }) });
  store.append({ type: "job.completed", occurredAt: h.job.startedAt,
    source: source("companion/job-completed", { job: h.job }) });
  await store.close();

  const result = await h.cli("observe", "follow", h.job.id, "--until", "done");
  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /^QUESTION(?:_PENDING)? /m);
  assert.match(result.stdout, /^DONE job=/m);
});

test("resumed follow of an hour-old active job waits for progress and reaches DONE", async (t) => {
  const output = await followWithClock(t, async ({ tick, emit, started }) => {
    // The first stall check runs before the next live event arrives.
    await tick(1000);
    await emit("message.delta");
    for (let i = 0; i < 16; i++) {
      await tick(60000);
      await emit("message.delta");
    }
    // Replayed timestamps cannot move the silence baseline backwards.
    await emit("message.delta", started - 60 * 60000);
    await tick(1000);
  });
  assert.doesNotMatch(output, /^STALLED /m);
  assert.match(output, /^CURSOR: /m);
  assert.match(output, /^DONE job=task-errors .*thread=thread-errors$/m);
});

test("follow reports real silence after fifteen minutes measured from this follow", async (t) => {
  let beforeThreshold;
  const output = await followWithClock(t, async ({ tick, output }) => {
    await tick(15 * 60000 - 1000);
    beforeThreshold = output();
    await tick(1000);
  });
  assert.doesNotMatch(beforeThreshold, /^STALLED /m);
  assert.match(output, /^STALLED job=task-errors .*thread=thread-errors 15m without progress$/m);
  assert.equal((output.match(/^STALLED /gm) ?? []).length, 1);
  assert.doesNotMatch(output, /^DONE /m);
});

test("replay expired cursor reports nonzero structured error and a usable retained boundary", async (t) => {
  const h = await expiredFixture(t);
  const result = await h.cli("observe", "replay", h.job.id, "--after", h.old, "--jsonl");
  assert.equal(result.code, 1, result.stderr);
  const error = JSON.parse(result.stdout.trim());
  assert.equal(error.type, "error");
  assert.equal(error.code, "CURSOR_EXPIRED");
  assert.equal(typeof error.earliestAvailableCursor, "string");
  const resumed = await h.cli("observe", "replay", h.job.id, "--after", error.earliestAvailableCursor, "--limit", "1", "--jsonl");
  assert.equal(resumed.code, 0, resumed.stderr);
  const rows = resumed.stdout.trim().split("\n").map(JSON.parse);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].type, "end");
});

test("follow expired cursor reports its recovery boundary without contacting a broker", async (t) => {
  const h = await expiredFixture(t);
  const result = await h.cli("observe", "follow", h.job.id, "--after", h.old);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /CURSOR_EXPIRED/);
  assert.match(result.stderr, /earliestAvailableCursor/);
});

test("old broker receives initialize only and stays alive after unsupported follow", async (t) => {
  const h = fixture(t, "running");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cxo-old-"));
  const endpoint = createBrokerEndpoint(directory);
  h.env.CODEX_COMPANION_APP_SERVER_ENDPOINT = endpoint;
  const methods = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffered = "";
    socket.on("data", (data) => {
      buffered += data;
      let end;
      while ((end = buffered.indexOf("\n")) >= 0) {
        const message = JSON.parse(buffered.slice(0, end));
        buffered = buffered.slice(end + 1);
        methods.push(message.method);
        socket.write(`${JSON.stringify({ id: message.id, result: { userAgent: "old-broker" } })}\n`);
      }
    });
  });
  server.listen(parseBrokerEndpoint(endpoint).path);
  await once(server, "listening");
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const result = await h.cli("observe", "follow", h.job.id);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /OBSERVATION_UNSUPPORTED/);
  assert.deepEqual(methods, ["initialize"]);
  assert.equal(server.listening, true);
  const probe = net.createConnection(parseBrokerEndpoint(endpoint).path);
  await once(probe, "connect");
  probe.destroy();
});

test("legacy view-path creates an atomic-compatible legacy projection without inventing history", async (t) => {
  const h = fixture(t);
  const result = await h.cli("observe", "view-path", h.job.id);
  assert.equal(result.code, 0, result.stderr);
  const viewPath = result.stdout.trim();
  assert.equal(path.isAbsolute(viewPath), true);
  const view = JSON.parse(fs.readFileSync(viewPath, "utf8"));
  assert.equal(view.jobId, h.job.id);
  assert.equal(view.history.continuity, "legacy");
  assert.equal(view.history.committedSeq, "0");
  assert.deepEqual(view.tail, []);
  const listed = await h.cli("observe", "list", "--json");
  assert.equal(listed.code, 0, listed.stderr);
  assert.equal(JSON.parse(listed.stdout).jobs[0].historyAvailable, false);
  const unknown = await h.cli("observe", "view-path", "does-not-exist");
  assert.equal(unknown.code, 1);
  assert.equal(unknown.stdout, "");
  assert.equal(unknown.stderr.trim(), "UNKNOWN_JOB does-not-exist");
});


test("owner-exit terminal history remains followable after runtime shutdown", async (t) => {
  const h = fixture(t, "running");
  const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await once(dead, "exit");
  h.job.pid = dead.pid;
  writeJobFile(h.cwd, h.job.id, h.job);
  upsertJob(h.cwd, h.job);
  const runtime = new JobRuntime({ threadRecords: false });
  t.after(() => runtime.close());
  await runtime.register({}, h.cwd, h.job.id);
  await runtime.reconcile();
  await runtime.close();
  const history = await readHistory(h.cwd, h.job.id);
  assert.equal(history.events.at(-1).type, "job.failed");
  const followed = await h.cli("observe", "follow", h.job.id);
  assert.equal(followed.code, 0, followed.stderr);
  assert.match(followed.stdout, /^FAILED job=.*owner process exited$/m);
});

async function seedUnfinishedHistory(h) {
  const runtime = new JobRuntime({ threadRecords: false });
  await runtime.register({}, h.cwd, h.job.id);
  await runtime.close();
}

test("startup reconciliation fails unfinished history whose owner exited", async (t) => {
  const h = fixture(t, "running");
  const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await once(dead, "exit");
  h.job.pid = dead.pid;
  writeJobFile(h.cwd, h.job.id, h.job);
  upsertJob(h.cwd, h.job);
  await seedUnfinishedHistory(h);

  const before = await h.cli("observe", "list", "--json");
  assert.equal(JSON.parse(before.stdout).jobs[0].status, "running");

  const runtime = new JobRuntime({ historySweepMs: 0, threadRecords: false });
  t.after(() => runtime.close());
  await runtime.start(h.cwd);

  const history = await readHistory(h.cwd, h.job.id);
  assert.equal(history.events.at(-1).type, "job.failed");
  assert.equal(history.events.at(-1).payload.reason.message, "owner process exited");
  const after = await h.cli("observe", "list", "--json");
  assert.equal(JSON.parse(after.stdout).jobs[0].status, "failed");
  const reopened = await new JobEventStore(h.cwd, h.job.id).initialize({ job: h.job });
  await reopened.close();
  assert.equal(runtime.jobs.size, 0);
});

test("startup reconciliation fails unfinished history without a job record", async (t) => {
  const h = fixture(t, "running");
  h.job.pid = process.pid;
  writeJobFile(h.cwd, h.job.id, h.job);
  upsertJob(h.cwd, h.job);
  await seedUnfinishedHistory(h);
  fs.unlinkSync(resolveJobFile(h.cwd, h.job.id));

  const runtime = new JobRuntime({ historySweepMs: 0, threadRecords: false });
  t.after(() => runtime.close());
  await runtime.start(h.cwd);

  const history = await readHistory(h.cwd, h.job.id);
  assert.equal(history.events.at(-1).type, "job.failed");
  assert.equal(history.events.at(-1).payload.reason.message, "owner process exited");
});

test("startup reconciliation preserves unfinished history with a live owner", async (t) => {
  const h = fixture(t, "running");
  h.job.pid = process.pid;
  writeJobFile(h.cwd, h.job.id, h.job);
  upsertJob(h.cwd, h.job);
  await seedUnfinishedHistory(h);

  const runtime = new JobRuntime({ historySweepMs: 0, threadRecords: false });
  t.after(() => runtime.close());
  await runtime.start(h.cwd);

  const history = await readHistory(h.cwd, h.job.id);
  assert.equal(history.events.at(-1).type, "job.started");
  const listed = await h.cli("observe", "list", "--json");
  assert.equal(JSON.parse(listed.stdout).jobs[0].status, "running");
});

test("periodic reconciliation recovers an owner that exits after startup", async (t) => {
  const h = fixture(t, "running");
  const owner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  t.after(() => { if (owner.exitCode === null) owner.kill(); });
  h.job.pid = owner.pid;
  writeJobFile(h.cwd, h.job.id, h.job);
  upsertJob(h.cwd, h.job);
  await seedUnfinishedHistory(h);

  const runtime = new JobRuntime({ historySweepMs: 0, threadRecords: false });
  t.after(() => runtime.close());
  await runtime.start(h.cwd);
  assert.equal((await readHistory(h.cwd, h.job.id)).events.at(-1).type, "job.started");

  owner.kill();
  await once(owner, "exit");
  await runtime.sweepHistory();

  assert.equal((await readHistory(h.cwd, h.job.id)).events.at(-1).type, "job.failed");
});

test("startup reconciliation preserves recordless history owned by a live writer", async (t) => {
  const h = fixture(t, "running");
  h.job.pid = process.pid;
  writeJobFile(h.cwd, h.job.id, h.job);
  upsertJob(h.cwd, h.job);
  const owner = new JobRuntime({ threadRecords: false });
  t.after(() => owner.close());
  await owner.register({}, h.cwd, h.job.id);
  fs.unlinkSync(resolveJobFile(h.cwd, h.job.id));

  const runtime = new JobRuntime({ historySweepMs: 0, threadRecords: false });
  t.after(() => runtime.close());
  await runtime.start(h.cwd);

  const history = await readHistory(h.cwd, h.job.id);
  assert.equal(history.events.at(-1).type, "job.started");
  const listed = await h.cli("observe", "list", "--json");
  assert.equal(JSON.parse(listed.stdout).jobs[0].status, "running");
});

test("quiet follow prints only cursor and DONE without result or item text, even with verbose", async (t) => {
  const h = fixture(t);
  h.job.rendered = "UNIQUE_RESULT_FULL_TEXT\n";
  writeJobFile(h.cwd, h.job.id, h.job);
  const store = await new JobEventStore(h.cwd, h.job.id).initialize({ job: h.job });
  const source = (method, params) => ({ message: { method, params } });
  store.append({ type: "message.delta", occurredAt: h.job.startedAt, source: source("item/agentMessage/delta", { delta: "SECRET_DELTA" }) });
  store.append({ type: "message.completed", occurredAt: h.job.startedAt, source: source("item/completed", { item: { text: "ITEM_TEXT" } }) });
  store.append({ type: "job.completed", occurredAt: h.job.startedAt, threadId: h.job.threadId, source: source("companion/job-completed", { job: h.job }) });
  await store.close();
  const quiet = await h.cli("observe", "follow", h.job.id, "--quiet", "--verbose");
  assert.equal(quiet.code, 0, quiet.stderr);
  const lines = quiet.stdout.trim().split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^CURSOR: /);
  assert.equal(lines[1], `DONE job=${h.job.id} [${h.job.label}] thread=${h.job.threadId}`);
  assert.doesNotMatch(quiet.stdout, /UNIQUE_RESULT|ITEM_TEXT|SECRET_DELTA/);
  const normal = await h.cli("observe", "follow", h.job.id);
  assert.equal(normal.code, 0, normal.stderr);
  assert.match(normal.stdout, /ITEM_TEXT/);
  assert.ok(normal.stdout.endsWith(renderStoredJobResult(h.job, h.job)));
});
