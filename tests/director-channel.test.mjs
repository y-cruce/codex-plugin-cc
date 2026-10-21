import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import { spawn } from "node:child_process";
import readline from "node:readline";
import os from "node:os";
import path from "node:path";
import { DirectorChannel, channelMessage, paths } from "../plugins/codex/scripts/director-channel.mjs";
import { channelRequest, DirectorPublisher, deliveryRoot, directorEvent, eventPaths, pendingEvents, readJson, wasDelivered, acceptDirectorEvents, deliveryRefs, eventFromRef, stripDeliveryTags, isDirectorEventPending, durableJson, touchDirectorSession, sweepDirectorSessions, sessionDirectory, INACTIVE_SESSION_MS } from "../plugins/codex/scripts/lib/director-delivery.mjs";
import { LiveTurnControl } from "../plugins/codex/scripts/lib/live-turn-control.mjs";
import { streamJobEvents } from "../plugins/codex/scripts/lib/job-events.mjs";
import { isolateTestEnvironment, makeTempDir, waitFor } from "./helpers.mjs";
import { runIngress } from "../plugins/codex/scripts/director-ingress.mjs";

function fixture(t) {
  isolateTestEnvironment(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cxd-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stateDir = path.join(process.env.CLAUDE_PLUGIN_DATA, "state", "repo");
  const root = deliveryRoot(stateDir);
  const job = { id: "job", sessionId: "session", workspaceRoot: "/repo", status: "running", threadId: "thread", turnId: "turn" };
  const sent = [];
  const start = async (send = async (message) => {
    sent.push(message.params);
    await acceptDirectorEvents([eventFromRef(message.params.meta.delivery)], "channel", async () => ({}));
  }, claudePid = 1234) => {
    const channel = new DirectorChannel({ root, dir, send, claudePid });
    await channel.start(job.sessionId);
    t.after(() => channel.close());
    return channel;
  };
  const confirm = (channel, sessionId = job.sessionId) => channel.handle({ action: "confirm", sessionId, instance: channel.instance, nonce: channel.nonce });
  const publisher = () => {
    const publisher = new DirectorPublisher();
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
  // Lose the transport ACK after ingress: an explicit retry sees the same
  // receipt and never outputs this item twice. Recovery belongs to the consumer.
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
  publisher = h.publisher();
  await publisher.push(next);
  assert.equal(h.sent.filter((message) => message.meta.id === next.eventId).length, 1);
});

async function monitor(h, live, job = h.job, ingress = true) {
  const lines = [];
  const abort = new AbortController();
  let polls = 0;
  const terminalReportsFile = path.join(h.dir, "monitor.json");
  await streamJobEvents("/repo", { session: job.sessionId, signal: abort.signal, pollMs: 1 }, {
    directorStateDir: h.stateDir, terminalReportsFile, claimQuestion: async () => true, acknowledge: async () => {}, progressAt: Date.now,
    status: async () => live, snapshot: () => { if (polls++) abort.abort(); return { running: [job], recent: [] }; },
    writeLine: async (line) => {
      if (!ingress) { lines.push(line); return; }
      const events = deliveryRefs(line).map(eventFromRef).filter(Boolean);
      if (events.length) await acceptDirectorEvents(events, "monitor", async () => { lines.push(stripDeliveryTags(line)); return {}; });
      else lines.push(line);
    }
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
  await Promise.all(["channel", "monitor"].map((route) => deliverDirectorEvents([event], route, async pending =>
    acceptDirectorEvents(pending, route, async () => { outputs++; return {}; }))));
  assert.equal(outputs, 1);
});

test("session rebind fences consumers and replays frames the old-session ingress dropped on clear", async (t) => {
  const h = fixture(t);
  const { registerDirectorChannel } = await import("../plugins/codex/hooks/director-channel/register.ts");
  const hooks = new Map();
  registerDirectorChannel((name, fn) => hooks.set(name, fn));
  let sessionId = h.job.sessionId;
  const engine = { plugin: { root: "/plugin" }, session: { id: async () => sessionId }, process: { run: async (args) =>
    ({ exitCode: 0, stdout: JSON.stringify(await runIngress(args[2], JSON.parse(args[3]))), stderr: "" }) } };
  const frames = [];
  const channel = await h.start(async message => {
    frames.push(message.params);
    const attributes = Object.entries(message.params.meta).map(([key, value]) => `${key}="${value}"`).join(" ");
    await hooks.get("prompt.submit")(engine, { origin: { kind: "channel", server: "plugin:codex:director" },
      text: `<channel ${attributes}>${message.params.content}</channel>` }, async () => { h.sent.push(message.params); return {}; });
  });
  const publisher = h.publisher();
  await h.confirm(channel);
  const competitor = new DirectorChannel({ root: h.root, dir: h.dir, claudePid: 5678, send: async () => assert.fail("competing consumer") });
  t.after(() => competitor.close());
  await assert.rejects(competitor.start(h.job.sessionId), /live writer/);
  // The host clears before its lifecycle rebind runs. This old frame was sent,
  // but the new session's ingress rejects it and must not commit a receipt.
  sessionId = "cleared";
  const old = directorEvent(h.job, "director.notified", { id: "old", message: "for resumed session" }, h.stateDir);
  publisher.publish(h.job, old.type, old.payload, h.stateDir);
  await waitFor(() => frames.length === 1);
  assert.equal(h.sent.length, 0);
  assert.equal(wasDelivered(old), false);
  await channel.handle({ action: "bind", sessionId, instance: channel.instance });
  const fresh = { ...h.job, sessionId };
  publisher.publish(fresh, "director.notified", { id: "new", message: "new session" }, h.stateDir);
  await waitFor(() => h.sent.length === 1);
  assert.equal(h.sent[0].meta.session, "cleared");
  sessionId = h.job.sessionId;
  await channel.handle({ action: "bind", sessionId, instance: channel.instance });
  assert.equal(h.sent[1].meta.id, old.eventId);
  assert.equal(wasDelivered(old), true);
});

// No producer socket or timer survives this acceptance. The consumer must
// discover the item by directory watch and retry its first failed output.
test("the confirmed consumer recovers acceptance after publisher exit and retries failed delivery", async (t) => {
  const h = fixture(t);
  let attempts = 0;
  const channel = await h.start(async message => {
    if (++attempts === 1) throw new Error("temporary output failure");
    const event = eventFromRef(message.params.meta.delivery);
    h.sent.push(message.params);
    // Simulate ingress dying after its receipt fsync, before unlinking the item.
    durableJson(eventPaths(event).receipt, { eventId: event.eventId, route: "channel" });
  });
  await h.confirm(channel);
  const source = `import { DirectorPublisher } from ${JSON.stringify(new URL("../plugins/codex/scripts/lib/director-delivery.mjs", import.meta.url).href)};
    const publisher = new DirectorPublisher();
    publisher.push = () => process.exit(0);
    publisher.publish(${JSON.stringify(h.job)}, "director.notified", { id: "producer-exit", message: "accepted before exit" }, ${JSON.stringify(h.stateDir)});`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], { env: process.env, stdio: "ignore" });
  const closed = new Promise(resolve => child.on("exit", resolve));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await closed; });
  assert.equal(await closed, 0);
  await waitFor(() => h.sent.length === 1, "consumer watch/retry without producer", 5000);
  assert.equal(attempts, 2);
  assert.equal(h.sent[0].content.includes("accepted before exit"), true);
  assert.deepEqual(pendingEvents(h.root, h.job.sessionId), [], "consumer cleans accepted items without a producer timer");
});

test("answered, closed and expired questions stay retired across channel and Monitor replay", async (t) => {
  const h = fixture(t);
  const publisher = h.publisher();
  const channel = await h.start();
  const retired = [];
  for (const reason of ["answered", "server-closed", "turn-closed", "expired"]) {
    let control;
    const threadId = `thread-${reason}`;
    const turnId = `turn-${reason}`;
    const client = { cwd: h.dir, respond: () => {}, exitPromise: new Promise(() => {}), request: async () => {
      control.observe({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "interrupted" } } });
    } };
    control = new LiveTurnControl(client, () => {}, reason === "expired" ? 20 : 600000,
      (_thread, type, payload) => publisher.publish(h.job, type, payload, h.stateDir));
    t.after(() => control.close());
    control.observe({ method: "turn/started", params: { threadId, turn: { id: turnId } } });
    control.handleServerRequest({ id: reason, method: "item/tool/requestUserInput", params: { threadId, turnId,
      questions: [{ id: "source", question: "Which source?" }] } });
    const question = control.snapshot(threadId).questions[0];
    const event = directorEvent(h.job, "question.opened", question, h.stateDir);
    if (reason === "answered") await control.request("broker/answer", { threadId, turnId, requestId: reason, answers: { source: { answers: ["local"] } } });
    else if (reason === "server-closed") control.observe({ method: "serverRequest/resolved", params: { threadId, requestId: reason } });
    else if (reason === "turn-closed") control.observe({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
    else await waitFor(() => control.snapshot(threadId).error?.includes("timed out"));
    assert.equal(readJson(eventPaths(event).question).status, reason === "answered" ? "resolved" : reason === "expired" ? "expired" : "closed");
    assert.equal(fs.existsSync(eventPaths(event).item), false, "settlement removes the item while keeping its tombstone");
    retired.push({ question, event });
  }
  await h.confirm(channel);
  assert.equal(h.sent.length, 0);
  channel.confirmed = false;
  fs.rmSync(channel.files.confirmed, { force: true });
  assert.deepEqual(await monitor(h, { questions: retired.map(item => item.question) }), []);
  assert.ok(retired.every(({ event }) => !isDirectorEventPending(event) && !wasDelivered(event)));
});

test("retention removes 30-day inactive sessions at startup and keeps live consumers", async (t) => {
  const h = fixture(t);
  const publisher = h.publisher();
  const now = Date.now();
  const cases = [
    { session: "expired", at: now - INACTIVE_SESSION_MS - 86400000, keep: false },
    { session: "recent", at: now - 86400000, keep: true },
    { session: "live", at: now - INACTIVE_SESSION_MS - 86400000, keep: true, live: true },
  ];
  for (const entry of cases) {
    publisher.publish({ ...h.job, sessionId: entry.session }, "director.notified", { id: entry.session, message: "pending" }, h.stateDir);
    const directory = sessionDirectory(h.root, entry.session);
    durableJson(path.join(directory, "delivered", "receipt.json"), {});
    durableJson(path.join(directory, "questions", "tombstone.json"), {});
    if (entry.live) durableJson(path.join(directory, "consumer", "writer.lock"), { pid: process.pid, nonce: "live-test-consumer" });
    touchDirectorSession(directory, entry.at);
  }
  const channel = await h.start();
  for (const entry of cases) assert.equal(fs.existsSync(sessionDirectory(h.root, entry.session)), entry.keep, entry.session);
  const later = sessionDirectory(h.root, "expired-after-start");
  publisher.publish({ ...h.job, sessionId: "expired-after-start" }, "director.notified", { id: "later" }, h.stateDir);
  touchDirectorSession(later, now - INACTIVE_SESSION_MS - 86400000);
  await channel.replay();
  assert.equal(fs.existsSync(later), true, "current-session recovery never performs global retention");
  sweepDirectorSessions(h.root, now);
  assert.equal(fs.existsSync(later), false, "the hourly retention pass deletes the whole expired session");
  assert.equal(fs.existsSync(sessionDirectory(h.root, "live")), true);
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
  const forwarded = second.messages.find(message => message.params?.meta?.event === "director_notified").params;
  assert.equal(forwarded.meta.id, id);
  assert.equal(wasDelivered(eventFromRef(forwarded.meta.delivery)), false, "stdout and ACK are not ingress acceptance");
  await acceptDirectorEvents([eventFromRef(forwarded.meta.delivery)], "channel", async () => ({}));
  second.child.stdin.end();
  await second.closed;
  assert.equal(second.child.exitCode, 0, second.errors);
  assert.equal(fs.existsSync(files.confirmed), false);
});
