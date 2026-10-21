import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import { spawn } from "node:child_process";
import readline from "node:readline";
import os from "node:os";
import path from "node:path";
import { DirectorChannel, channelMessage, paths } from "../plugins/codex/scripts/director-channel.mjs";
import { channelRequest, DirectorPublisher, deliveryRoot, directorEvent, eventPaths, pendingEvents, readJson, wasDelivered } from "../plugins/codex/scripts/lib/director-delivery.mjs";
import { streamJobEvents } from "../plugins/codex/scripts/lib/job-events.mjs";
import { isolateTestEnvironment, makeTempDir, waitFor } from "./helpers.mjs";

function fixture(t) {
  isolateTestEnvironment(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cxd-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stateDir = path.join(process.env.CLAUDE_PLUGIN_DATA, "state", "repo");
  const root = deliveryRoot(stateDir);
  const job = { id: "job", sessionId: "session", workspaceRoot: "/repo", status: "running", threadId: "thread", turnId: "turn" };
  const sent = [];
  const start = async (send = async (message) => { sent.push(message.params); }, claudePid = 1234) => {
    const channel = new DirectorChannel({ root, dir, send, claudePid });
    await channel.start(job.sessionId);
    t.after(() => channel.close());
    return channel;
  };
  const confirm = (channel, sessionId = job.sessionId) => channel.handle({ action: "confirm", sessionId, instance: channel.instance, nonce: channel.nonce });
  const publisher = () => {
    const publisher = new DirectorPublisher({ root, retryMs: 60000 });
    t.after(() => publisher.close());
    return publisher;
  };
  return { dir, stateDir, root, job, sent, start, confirm, publisher };
}

test("channel messages keep job, event, stable id and owning session", () => {
  assert.deepEqual(channelMessage({ jobId: "task", type: "job.completed", text: "done", eventId: "id", sessionId: "session" }),
    { content: "done", meta: { event: "job_completed", job: "task", id: "id", session: "session" } });
  assert.equal(channelMessage({ text: " " }), null);
});

test("unconfirmed items survive broker/channel restart and replay stable ids across send/ACK failures", async (t) => {
  const h = fixture(t);
  let channel = await h.start();
  let publisher = h.publisher();
  const note = { id: "note", message: "persist before sending" };
  const id = publisher.publish(h.job, "director.notified", note, h.stateDir);
  const event = directorEvent(h.job, "director.notified", note, h.stateDir);
  assert.equal(h.sent.length, 0);
  assert.equal(pendingEvents(h.root, h.job.sessionId).length, 1);
  publisher.close();
  await channel.close();
  // A send succeeded, but the process died before it could persist its receipt.
  channel = await h.start(async (message) => { h.sent.push(message.params); throw new Error("crash before receipt/ACK"); });
  await assert.rejects(h.confirm(channel), /crash before receipt/);
  assert.equal(wasDelivered(event), false);
  assert.equal(pendingEvents(h.root, h.job.sessionId)[0].eventId, id);
  await channel.close();
  channel = await h.start();
  await h.confirm(channel);
  assert.deepEqual(h.sent.map((message) => message.meta.id), [id, id]);
  assert.ok(wasDelivered(event));
  publisher = h.publisher();
  await publisher.push(event);
  assert.equal(h.sent.length, 2);
  // Lose the transport ACK after output/receipt: the next broker's replay sees
  // the same receipt and never outputs this item twice.
  const second = { id: "lost-ack", message: "ACK may be lost" };
  const next = directorEvent(h.job, "director.notified", second, h.stateDir);
  fs.rmSync(channel.files.confirmed, { force: true });
  publisher.publish(h.job, "director.notified", second, h.stateDir);
  channel.confirmation();
  await new Promise((resolve) => {
    const socket = net.createConnection(channel.endpoint, () => {
      socket.end(`${JSON.stringify({ action: "deliver", sessionId: h.job.sessionId, eventId: next.eventId, instance: channel.instance })}\n`);
      socket.destroy();
      resolve();
    });
  });
  await waitFor(() => wasDelivered(next));
  publisher.close();
  publisher = h.publisher();
  await publisher.push(next);
  assert.equal(h.sent.filter((message) => message.meta.id === next.eventId).length, 1);
});

async function monitor(h, live, job = h.job) {
  const lines = [];
  const abort = new AbortController();
  let polls = 0;
  const terminalReportsFile = path.join(h.dir, "monitor.json");
  await streamJobEvents("/repo", { session: job.sessionId, signal: abort.signal, pollMs: 1 }, {
    directorStateDir: h.stateDir, terminalReportsFile, claimQuestion: async () => true, acknowledge: async () => {}, progressAt: Date.now,
    status: async () => live, snapshot: () => { if (polls++) abort.abort(); return { running: [job], recent: [] }; },
    writeLine: async (line) => { lines.push(line); }
  });
  return lines;
}

test("Monitor and channel share receipts in either switching order, including concurrent delivery", async (t) => {
  const h = fixture(t);
  const publisher = h.publisher();
  const channel = await h.start();
  for (const [index, type] of ["question.opened", "director.notified", "job.completed"].entries()) {
    const job = { ...h.job, id: `job-${index}`, ...(type.startsWith("job.") ? { status: "completed" } : {}) };
    const payload = type === "question.opened" ? { requestId: "q", threadId: "thread", turnId: "turn", questions: [{ id: "source", question: "Which?" }] }
      : type === "director.notified" ? { id: "n", message: "note" } : {};
    const live = type === "question.opened" ? { questions: [payload] } : type === "director.notified" ? { notifications: [payload] } : {};
    publisher.publish(job, type, payload, h.stateDir);
    if (type.startsWith("job.")) fs.rmSync(path.join(h.dir, "monitor.json"), { force: true });
    assert.equal((await monitor(h, { unavailable: "broker exited" }, job)).length, 1);
    await h.confirm(channel);
    assert.equal(h.sent.length, index, "the Monitor's receipt suppresses channel replay");
    const nextJob = { ...job, id: `${job.id}-channel` };
    publisher.publish(nextJob, type, payload, h.stateDir);
    const event = directorEvent(nextJob, type, payload, h.stateDir);
    await waitFor(() => wasDelivered(event));
    assert.deepEqual(await monitor(h, live, nextJob), []);
    channel.confirmed = false;
    const expired = readJson(channel.files.confirmed);
    fs.writeFileSync(channel.files.confirmed, JSON.stringify({ ...expired, until: 0 }));
  }
  assert.equal(h.sent.length, 3);
  // Two consumers racing at the route switch still serialize through one lock.
  const { deliverDirectorEvents } = await import("../plugins/codex/scripts/lib/director-delivery.mjs");
  const event = directorEvent(h.job, "director.notified", { id: "race" }, h.stateDir);
  let outputs = 0;
  await Promise.all(["channel", "monitor"].map((route) => deliverDirectorEvents([event], route, async () => { outputs++; })));
  assert.equal(outputs, 1);
});

test("session rebind fences consumers and keeps old-session outbox items for resume", async (t) => {
  const h = fixture(t);
  const publisher = h.publisher();
  const channel = await h.start();
  await h.confirm(channel);
  const competitor = new DirectorChannel({ root: h.root, dir: h.dir, claudePid: 5678, send: async () => assert.fail("competing consumer") });
  t.after(() => competitor.close());
  await assert.rejects(competitor.start(h.job.sessionId), /live writer/);
  await channel.handle({ action: "bind", sessionId: "cleared", instance: channel.instance });
  const old = directorEvent(h.job, "director.notified", { id: "old", message: "for resumed session" }, h.stateDir);
  publisher.publish(h.job, old.type, old.payload, h.stateDir);
  assert.equal(h.sent.length, 0);
  assert.ok(readJson(eventPaths(old).item));
  const fresh = { ...h.job, sessionId: "cleared" };
  publisher.publish(fresh, "director.notified", { id: "new", message: "new session" }, h.stateDir);
  await waitFor(() => h.sent.length === 1);
  assert.equal(h.sent[0].meta.session, "cleared");
  await channel.handle({ action: "bind", sessionId: h.job.sessionId, instance: channel.instance });
  assert.equal(h.sent[1].meta.id, old.eventId);
  assert.equal(h.sent[1].meta.session, h.job.sessionId);
});

test("the independent ingress hook binds lifecycle sessions, confirms probes and rejects old-session frames", async () => {
  const { registerDirectorChannel } = await import("../plugins/codex/hooks/director-channel/register.ts");
  const hooks = new Map();
  registerDirectorChannel((event, fn) => hooks.set(event, fn));
  const runs = [];
  let sessionId = "first";
  const engine = { plugin: { root: "/plugin" }, session: { id: async () => sessionId },
    process: { run: async (args) => { runs.push(args); return { exitCode: 0, stdout: args[0] === "sh" ? "4242" : "", stderr: "" }; } },
    env: { set: async () => {} }, ui: { log: () => {} } };
  await hooks.get("classic.SessionStart")(engine, { session_id: sessionId }, async () => {});
  sessionId = "resumed";
  await hooks.get("session.start")(engine, {}, async () => {});
  sessionId = "cleared";
  await hooks.get("turn.start")(engine, {}, async () => {});
  assert.deepEqual(runs.filter((args) => args[0] === "node").map((args) => args.slice(2)), [
    ["bind", "4242", "first"], ["bind", "4242", "resumed"], ["bind", "4242", "cleared"]
  ]);
  const submit = hooks.get("prompt.submit");
  const origin = { kind: "channel", server: "plugin:codex:director" };
  const dropped = await submit(engine, { origin, text: '<channel event="probe">codex-director-channel-probe 1-nonce: check</channel>' }, async () => assert.fail("probe reached director"));
  assert.ok(dropped.drop);
  assert.deepEqual(runs.at(-1).slice(2), ["confirm", "4242", "cleared", "1-nonce"]);
  assert.ok((await submit(engine, { origin, text: '<channel session="first">old</channel>' }, async () => assert.fail("foreign event"))).drop);
  assert.equal(await submit(engine, { origin, text: '<channel session="cleared">note</channel>' }, async () => "passed"), "passed");
});

test("the MCP stdio server probes, restarts over a stale lease and replays accepted items before ACK", async (t) => {
  const h = fixture(t);
  const start = async () => {
    const child = spawn(process.execPath, [path.resolve("plugins/codex/scripts/director-channel.mjs")], {
      env: { ...process.env, TMPDIR: h.dir, CLAUDE_CODE_SESSION_ID: h.job.sessionId }, stdio: ["pipe", "pipe", "pipe"]
    });
    const closed = new Promise(resolve => child.on("exit", resolve));
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await closed; });
    const messages = [];
    let errors = "";
    child.stderr.on("data", chunk => { errors += chunk; });
    readline.createInterface({ input: child.stdout }).on("line", line => messages.push(JSON.parse(line)));
    child.stdin.write(`${JSON.stringify({ id: 1, method: "initialize", params: {} })}\n`);
    child.stdin.write(`${JSON.stringify({ method: "notifications/initialized" })}\n`);
    await waitFor(() => messages.find(message => message.params?.meta?.event === "probe"), errors);
    assert.deepEqual(messages.find(message => message.id === 1).result.capabilities, { experimental: { "claude/channel": {} } });
    return { child, messages, closed, errors };
  };
  const first = await start();
  const publisher = h.publisher();
  const id = publisher.publish(h.job, "director.notified", { id: "stdio", message: "direct" }, h.stateDir);
  first.child.kill("SIGKILL");
  await first.closed;
  assert.equal(pendingEvents(h.root, h.job.sessionId)[0].eventId, id);
  const second = await start();
  const files = paths(process.pid, path.join(h.dir, "codex-channel"));
  const server = readJson(files.server);
  await channelRequest(server.endpoint, { action: "confirm", sessionId: h.job.sessionId, instance: server.instance, nonce: server.nonce });
  await waitFor(() => second.messages.some(message => message.params?.meta?.event === "director_notified"));
  assert.equal(second.messages.find(message => message.params?.meta?.event === "director_notified").params.meta.id, id);
  second.child.stdin.end();
  await second.closed;
  assert.equal(second.child.exitCode, 0, second.errors);
  assert.equal(fs.existsSync(files.confirmed), false);
});
