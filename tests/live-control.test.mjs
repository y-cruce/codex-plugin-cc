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

test("steering from another socket preserves FIFO and the owning event stream", async (t) => {
  const h = await setup(t);
  const { turn } = await h.start("hold");
  const control = await h.connect();
  const accepted = await Promise.all(["first", "finish"].map((text) => control.request("turn/steer", {
    threadId: h.thread.id, expectedTurnId: turn.id, clientUserMessageId: text, input: [{ type: "text", text }]
  })));
  assert.deepEqual(accepted.map((result) => result.turnId), [turn.id, turn.id]);
  assert.deepEqual(accepted.map((result) => result.messageId), ["first", "finish"]);
  await waitFor(() => h.notifications.some((item) => item.method === "turn/completed"));
  assert.deepEqual(h.notifications.filter((item) => item.method === "item/started" && item.params.item.type === "userMessage")
    .map((item) => item.params.item.clientId), ["first", "finish"]);
  const final = h.notifications.find((item) => item.params?.item?.type === "agentMessage");
  assert.equal(final.params.item.text, "hold|first|finish");
  assert.deepEqual((await control.request("broker/status", { threadId: h.thread.id })).pendingMessages, []);
});

test("parallel thread owners receive only their own events and reject another socket taking an active thread", async (t) => {
  const h = await setup(t);
  const second = await h.connect();
  const control = await h.connect();
  const secondEvents = [];
  const controlEvents = [];
  second.setNotificationHandler((message) => secondEvents.push(message));
  control.setNotificationHandler((message) => controlEvents.push(message));
  const [{ thread: secondThread }] = await Promise.all([
    second.request("thread/start", { cwd: h.repo, sandbox: "read-only" }),
    h.owner.request("thread/name/set", { threadId: h.thread.id, name: "first" })
  ]);
  const [{ turn: firstTurn }, { turn: secondTurn }] = await Promise.all([
    h.start("hold first"),
    second.request("turn/start", { threadId: secondThread.id, input: [{ type: "text", text: "hold second" }] })
  ]);
  await assert.rejects(control.request("turn/start", {
    threadId: h.thread.id, input: [{ type: "text", text: "steal" }]
  }), (error) => error.rpcCode === BROKER_BUSY_RPC_CODE && /busy/.test(error.message));
  const states = await Promise.all([h.thread, secondThread].map((thread) =>
    control.request("broker/status", { threadId: thread.id })));
  assert.deepEqual(states.map((state) => state.turnId), [firstTurn.id, secondTurn.id]);
  const accepted = await Promise.all([[h.thread, firstTurn], [secondThread, secondTurn]].map(([thread, turn]) =>
    control.request("turn/steer", { threadId: thread.id, expectedTurnId: turn.id,
      input: [{ type: "text", text: "finish" }] })));
  assert.deepEqual(accepted.map((result) => result.turnId), [firstTurn.id, secondTurn.id]);
  await waitFor(() => [h.notifications, secondEvents].every((events) =>
    events.some((message) => message.method === "turn/completed")));
  for (const [events, thread] of [[h.notifications, h.thread], [secondEvents, secondThread]]) {
    assert.ok(events.every((message) => (message.params?.threadId ?? message.params?.thread?.id) === thread.id));
    assert.ok(events.some((message) => message.method === "turn/started"));
    assert.ok(events.some((message) => message.method === "item/started"));
    assert.ok(events.some((message) => message.method === "item/completed"));
    assert.equal((await control.request("broker/status", { threadId: thread.id })).turnId, null);
  }
  assert.deepEqual(controlEvents, []);
  const [{ turn: nextFirst }, { turn: nextSecond }] = await Promise.all([
    second.request("turn/start", { threadId: h.thread.id, input: [{ type: "text", text: "next first" }] }),
    h.owner.request("turn/start", { threadId: secondThread.id, input: [{ type: "text", text: "next second" }] })
  ]);
  await waitFor(() => secondEvents.some((message) => message.method === "turn/completed" && message.params.turn.id === nextFirst.id)
    && h.notifications.some((message) => message.method === "turn/completed" && message.params.turn.id === nextSecond.id));
});

test("idle broker stays alive with an owner, exits after disconnect, and is replaced on the next request", async (t) => {
  const h = await setup(t, 600000, 250);
  process.env.CLAUDE_PLUGIN_DATA = h.env.CLAUDE_PLUGIN_DATA;
  saveBrokerSession(h.repo, { endpoint: h.endpoint, pidFile: h.pidFile, sessionDir: h.socketDir, pid: h.broker.pid });
  t.after(() => shutdownTestBrokers(h.env.CLAUDE_PLUGIN_DATA));
  await h.start("hold");
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(h.broker.exitCode, null);
  await h.owner.close();
  await waitFor(() => h.broker.exitCode !== null);
  assert.equal(await h.closed, 0);
  assert.equal(fs.existsSync(h.pidFile), false);
  const replacement = await ensureBrokerSession(h.repo, { env: h.env });
  assert.ok(replacement);
  assert.notEqual(replacement.pid, h.broker.pid);
  assert.notEqual(replacement.endpoint, h.endpoint);
  assert.equal(await waitForBrokerEndpoint(replacement.endpoint), true);
});

test("question responses use the original request ID and reject incorrect answers", async (t) => {
  const h = await setup(t);
  const { turn } = await h.start("ask");
  const control = await h.connect();
  const snapshot = await waitFor(async () => {
    const state = await control.request("broker/status", { threadId: h.thread.id });
    return state.questions.length ? state : null;
  });
  assert.equal(snapshot.questions[0].requestId, "question-1");
  const params = { threadId: h.thread.id, turnId: turn.id, requestId: "question-1" };
  await assert.rejects(control.request("broker/answer", { ...params, turnId: "old", answers: { source: { answers: ["wrong turn"] } } }), /turn mismatch/);
  await assert.rejects(control.request("broker/answer", { ...params, answers: { wrong: { answers: ["latest"] } } }), /question/);
  await control.request("broker/answer", { ...params, answers: { source: { answers: ["latest"] } } });
  await waitFor(() => h.notifications.some((item) => item.method === "turn/completed"));
  assert.match(h.notifications.find((item) => item.params?.item?.type === "agentMessage").params.item.text, /latest/);
  await assert.rejects(control.request("broker/answer", { ...params, answers: { source: { answers: ["again"] } } }), /pending/);
});

test("unanswered questions interrupt with an explicit timeout", async (t) => {
  const h = await setup(t, 80);
  await h.start("ask");
  await waitFor(() => h.notifications.some((item) => item.method === "turn/completed"));
  const control = await h.connect();
  const snapshot = await control.request("broker/status", { threadId: h.thread.id });
  assert.match(snapshot.error, /answer.*timed out/i);
  assert.deepEqual(snapshot.questions, []);
});

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
