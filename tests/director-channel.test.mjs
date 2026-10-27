import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import { spawn } from "node:child_process";
import readline from "node:readline";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { DirectorChannel, channelMessage, paths } from "../plugins/codex/scripts/director-channel.mjs";
import { channelRequest, DirectorPublisher, deliveryRoot, directorEvent, deliveryTag, eventPaths, pendingEvents, readJson, wasDelivered, acceptDirectorEvents, deliveryRefs, eventFromRef, stripDeliveryTags, isDirectorEventPending, durableJson, touchDirectorSession, sweepDirectorSessions, sessionDirectory, INACTIVE_SESSION_MS } from "../plugins/codex/scripts/lib/director-delivery.mjs";
import { LiveTurnControl } from "../plugins/codex/scripts/lib/live-turn-control.mjs";
import { streamJobEvents } from "../plugins/codex/scripts/lib/job-events.mjs";
import { admitDirector, directorIngress } from "../plugins/codex/hooks/director-channel/register.ts";
import { isolateTestEnvironment, makeTempDir, waitFor } from "./helpers.mjs";
import { runIngress } from "../plugins/codex/scripts/director-ingress.mjs";
import { handleSessionStart } from "../plugins/codex/scripts/session-lifecycle-hook.mjs";
import { scanConsumedDirectorEvents } from "../plugins/codex/scripts/lib/director-consumed.mjs";

// The pane runs the director ingress ahead of its own prompt.submit; this is that chain.
const through = (director) => async ($, e, next) => {
  const admitted = await admitDirector($, director, e);
  if ("drop" in admitted) return admitted;
  const result = await next(admitted.event);
  if (!result?.drop && admitted.accept) await directorIngress($, "accept", admitted.accept);
  return result;
};

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

test("ingress routes director agents separately, accepts successful sends and falls back on refusal", async (t) => {
  const h = fixture(t);
  for (const [route, delivered] of [["channel", true], ["channel", false], ["monitor", true]]) {
    const jobs = ["a", "b"].map(id => ({ ...h.job, id: `${route}-${delivered}-${id}`, directorAgentId: `agent-${id}` }));
    if (route === "monitor") jobs.push({ ...h.job, id: "main-job" });
    const events = jobs.map((job, index) => directorEvent(job, index ? "director.notified" : "question.opened", index
      ? { id: job.id, message: `note for ${job.id}` }
      : { requestId: "request-1", questions: [{ id: "source", question: "Which source?", options: [{ label: "Local", description: "Use disk" }] },
        { id: "mode", question: "Which mode?", options: [{ label: "Read", description: "Only read" }] }] }, h.stateDir));
    for (const event of events) durableJson(eventPaths(event).item, event);
    const sent = [];
    const engine = { plugin: { root: "/plugin" }, session: { id: async () => h.job.sessionId,
      send: async input => { sent.push(input); return delivered ? { isDelivered: true } : { isDelivered: false, reason: "agent was stopped" }; } },
      process: { run: async args => ({ exitCode: 0, stdout: JSON.stringify(await runIngress(args[2], JSON.parse(args[3]))), stderr: "" }) } };
    const input = route === "channel"
      ? { origin: { kind: "channel", server: "plugin:codex:director" }, text: events.map(event => {
        const meta = channelMessage(event).meta;
        return `<channel ${Object.entries(meta).map(([k, v]) => `${k}="${v}"`).join(" ")}>${event.text}</channel>`;
      }).join("\n") }
      : { origin: { kind: "task-notification" }, text: `<event>${events.map(event => `${event.text} ${deliveryTag(event)}`).join("\n")}</event>` };
    // Channel frames carry one event; a Monitor can batch several callers.
    let main = "";
    const submit = async e => {
      if (!delivered) for (const event of events.filter(event => e.text.includes(event.jobId))) {
        assert.equal(wasDelivered(event), false, "a refused agent send has no receipt before main accepts it");
      }
      main += e.text;
      return {};
    };
    if (route === "channel") {
      for (const event of events) {
        const meta = channelMessage(event).meta;
        await through({})(engine, { ...input, text: `<channel ${Object.entries(meta).map(([k, v]) => `${k}="${v}"`).join(" ")}>${event.text}</channel>` }, submit);
      }
    } else await through({})(engine, input, submit);
    assert.deepEqual(sent.map(item => item.to), [{ agentId: "agent-a" }, { agentId: "agent-b" }]);
    for (const key of [events[0].jobId, "/repo", events[0].eventId, "request-1", "source", "mode", "Which source?", "Local", "Use disk", "Which mode?", "Read", "Only read"]) {
      assert.ok(sent[0].text.includes(key), key);
    }
    for (const event of events.slice(0, 2)) {
      assert.equal(wasDelivered(event), true);
      assert.equal(readJson(eventPaths(event).receipt).route, delivered ? `agent:${event.directorAgentId}` : "channel");
      if (delivered) assert.ok(!main.includes(event.jobId), "agent event removed from main");
      else {
        assert.ok(main.includes(event.jobId));
        assert.ok(main.includes(event.directorAgentId));
        assert.match(main, /agent was stopped/);
      }
    }
    if (route === "monitor") assert.match(main, /main-job/);
  }
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

test("a Monitor line past Claude Code's 500-character cut keeps its delivery tag whole", async (t) => {
  const h = fixture(t);
  const note = { id: "long", message: "长".repeat(400) };
  const [written] = await monitor(h, { notifications: [note] }, h.job, false);
  const shown = written.split("\n").map(line => line.length > 500 ? `${line.slice(0, 500)}...(truncated)` : line).join("\n");
  assert.deepEqual(deliveryRefs(shown).map(eventFromRef).map(event => event?.eventId),
    [directorEvent(h.job, "director.notified", note, h.stateDir).eventId]);
});

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
  const { directorChannel, registerDirectorChannel, bindDirector } = await import("../plugins/codex/hooks/director-channel/register.ts");
  const hooks = new Map();
  const director = directorChannel();
  registerDirectorChannel((name, fn) => hooks.set(name, fn), director);
  let sessionId = h.job.sessionId;
  const engine = { plugin: { root: "/plugin" }, session: { id: async () => sessionId }, process: { run: async (args) =>
    ({ exitCode: 0, stdout: JSON.stringify(await runIngress(args[2], JSON.parse(args[3]))), stderr: "" }) } };
  const frames = [];
  const channel = await h.start(async message => {
    frames.push(message.params);
    const attributes = Object.entries(message.params.meta).map(([key, value]) => `${key}="${value}"`).join(" ");
    await through(director)(engine, { origin: { kind: "channel", server: "plugin:codex:director" },
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

test("an item waits for ingress without another copy until the channel rebinds", async (t) => {
  const h = fixture(t);
  const channel = await h.start(async message => { h.sent.push(message.params); });
  await h.confirm(channel);
  h.publisher().publish(h.job, "director.notified", { id: "once", message: "held by the host" }, h.stateDir);
  await waitFor(() => h.sent.length === 1);
  // The first send's five-second reservation runs out while a turn holds it.
  fs.rmSync(path.join(sessionDirectory(h.root, h.job.sessionId), "attempts"), { recursive: true, force: true });
  await channel.replay();
  assert.equal(h.sent.length, 1, "the host holds the first copy until its next step");
  await channel.handle({ action: "bind", sessionId: "other", instance: channel.instance });
  await channel.handle({ action: "bind", sessionId: h.job.sessionId, instance: channel.instance });
  await waitFor(() => h.sent.length === 2);
});

test("consumed channel input survives a missing ingress receipt and a new channel instance", async (t) => {
  for (const row of [
    { role: "system", tagged: true, consumed: true },
    { role: "system", tagged: false, consumed: true },
    { role: "user", tagged: true, consumed: true },
    { role: "user", tagged: false, consumed: true },
    { role: "system", tagged: false, consumed: false },
  ]) await t.test(JSON.stringify(row), async (t) => {
    const h = fixture(t);
    const transcript = path.join(h.dir, `${h.job.sessionId}.jsonl`);
    fs.writeFileSync(transcript, "");
    handleSessionStart({ session_id: h.job.sessionId, transcript_path: transcript });
    const send = async message => { h.sent.push(message.params); };
    let channel = await h.start(send);
    await h.confirm(channel);
    const note = { id: "unacknowledged", message: "already in the model input" };
    const event = directorEvent(h.job, "director.notified", note, h.stateDir);
    h.publisher().publish(h.job, event.type, note, h.stateDir);
    await waitFor(() => h.sent.length === 1);
    const attributes = Object.entries(channelMessage(event).meta)
      .filter(([key]) => row.tagged || key !== "delivery").map(([key, value]) => `${key}="${value}"`).join(" ");
    const text = `<channel source="plugin:codex:director" ${attributes}>${event.text}</channel>`;
    const content = [{ type: "text", text: "queued prefix" }, { type: "text", text }];
    const blob = row.role === "user" ? createHash("sha256").update(JSON.stringify({
      content: content.map(block => ({ text: block.text, type: block.type })), role: "user",
    })).digest("hex") : "b".repeat(64);
    const append = records => fs.appendFileSync(transcript, records.map(record => JSON.stringify(record)).join("\n") + "\n");
    const user = block => ({ type: "user", sessionId: h.job.sessionId, message: { role: "user", content: [block] } });
    append([user(content[0])]);
    // Recover once between adjacent user records and the request referencing
    // their merged input, as happens when a new process resumes the cursor.
    await channel.replay();
    append([user(content[1])]);
    append([{ type: "attachment", sessionId: h.job.sessionId, attachment: { type: "queued_command", prompt: text } }]);
    if (row.role === "system") append([
      { type: "api-request-blob", sessionId: h.job.sessionId, hash: blob, message: { role: row.role, content: [{ type: "text", text }] } },
    ]);
    const request = { type: "api-request", sessionId: h.job.sessionId, tail: [blob] };
    if (row.consumed) append([request]);
    else fs.appendFileSync(transcript, JSON.stringify(request).slice(0, -1));
    assert.equal(wasDelivered(event), false, "post-next accept never ran");
    await channel.close();
    channel = await h.start(send);
    await h.confirm(channel);
    assert.equal(h.sent.length, row.consumed ? 1 : 2, "only input referenced by a model request suppresses replay");
    assert.equal(wasDelivered(event), row.consumed);
    await channel.close();
    assert.equal((await monitor(h, { notifications: [], questions: [] }, h.job, false)).length, row.consumed ? 0 : 1,
      "Monitor uses the same consumption recovery");
    if (!row.consumed) fs.appendFileSync(transcript, "}\n");
    channel = await h.start(send);
    await h.confirm(channel);
    assert.ok(wasDelivered(event), "a later request consumes a blob scanned on an earlier recovery");
    const receipt = { ...readJson(eventPaths(event).receipt), at: "2000-01-01T00:00:00.000Z" };
    durableJson(eventPaths(event).receipt, receipt);
    const cursor = readJson(path.join(sessionDirectory(h.root, h.job.sessionId), "consumed.json"));
    append([request]);
    assert.equal(scanConsumedDirectorEvents(transcript, h.job.sessionId, cursor).bytesRead,
      Buffer.byteLength(JSON.stringify(request) + "\n"), "recovery reads only the appended records");
    await channel.replay();
    assert.deepEqual(readJson(eventPaths(event).receipt), receipt, "recovery never refreshes an existing receipt");
  });
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
  const { directorChannel, registerDirectorChannel, bindDirector } = await import("../plugins/codex/hooks/director-channel/register.ts");
  const hooks = new Map();
  const director = directorChannel();
  registerDirectorChannel((event, fn) => hooks.set(event, fn), director);
  const runs = [];
  let sessionId = "first";
  const engine = { plugin: { root: "/plugin" }, session: { id: async () => sessionId },
    process: { run: async (args) => { runs.push(args); return { exitCode: 0, stdout: args[0] === "sh" ? "4242" : "", stderr: "" }; } },
    env: { set: async () => {} }, ui: { log: () => {} } };
  await hooks.get("classic.SessionStart")(engine, { session_id: sessionId }, async () => {});
  sessionId = "resumed";
  await bindDirector(engine, director);
  sessionId = "cleared";
  await bindDirector(engine, director);
  assert.deepEqual(runs.filter((args) => args[0] === "node").map((args) => args.slice(2)), [
    ["bind", "4242", "first"], ["bind", "4242", "resumed"], ["bind", "4242", "cleared"]
  ]);
  const submit = through(director);
  const origin = { kind: "channel", server: "plugin:codex:director" };
  const dropped = await submit(engine, { origin, text: '<channel event="probe">codex-director-channel-probe 1-nonce: check</channel>' }, async () => assert.fail("probe reached director"));
  assert.ok(dropped.drop);
  assert.deepEqual(runs.at(-1).slice(2), ["confirm", "4242", "cleared", "1-nonce"]);
  assert.ok((await submit(engine, { origin, text: '<channel session="first">old</channel>' }, async () => assert.fail("foreign event"))).drop);
  assert.equal(await submit(engine, { origin, text: '<channel session="cleared">note</channel>' }, async () => "passed"), "passed");
});

test("binding the session `claude -r` resumes probes again after the startup round ran out", async (t) => {
  const h = fixture(t);
  const probes = [];
  const channel = new DirectorChannel({ root: h.root, dir: h.dir, claudePid: 1234, probeMs: 1, send: async (message) => { probes.push(message); } });
  await channel.start("picker");
  t.after(() => channel.close());
  channel.initialized = true;
  channel.startProbing();
  await waitFor(() => probes.length === 6 && !fs.existsSync(channel.files.probing), "the startup round to run out");
  await channel.handle({ action: "bind", sessionId: h.job.sessionId, instance: channel.instance });
  await waitFor(() => probes.length > 6, "a probe for the resumed session");
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
