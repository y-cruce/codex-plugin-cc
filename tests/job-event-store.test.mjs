import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";

import { createCanonicalEvent } from "../plugins/codex/scripts/lib/executor-events.mjs";
import { JobEventStore, cleanupHistory, readHistory, resolveHistoryDir, resolveLiveViewPath } from "../plugins/codex/scripts/lib/job-event-store.mjs";
import { JobRuntime } from "../plugins/codex/scripts/lib/job-runtime.mjs";
import { resolveStateDir, upsertJob, writeJobFile } from "../plugins/codex/scripts/lib/state.mjs";

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-event-store-"));
  t.historyStores = [];
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = path.join(directory, "data");
  t.after(async () => {
    for (const store of t.historyStores) await store.close();
    if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous;
    await fs.rm(directory, { recursive: true, force: true });
  });
  return directory;
}

function event(text = "hello") {
  return createCanonicalEvent({ job: { id: "fixture" }, type: "message.delta",
    identity: { sessionId: "thread", turnId: "turn", messageId: "message" },
    occurredAt: "2026-09-15T00:00:00.000Z", receivedAt: "2026-09-15T00:00:00.000Z",
    payload: { role: "assistant", block: { type: "text", text } },
    source: { protocol: "codex-app-server", method: "item/agentMessage/delta",
      raw: { method: "item/agentMessage/delta", params: { delta: text } } } });
}

test("history is invisible until a durable batch commit and cursors resume without duplicates", async (t) => {
  const cwd = await fixture(t);
  const committed = [];
  const store = await new JobEventStore(cwd, "task-one", {
    flushMs: 10000,
    onCommit: async (events) => {
      const history = await readHistory(cwd, "task-one");
      assert.equal(history.committedSeq, events.at(-1).seq);
      committed.push(...events);
    }
  }).initialize({ label: "One" });
  t.historyStores.push(store);
  const first = store.append(event("a complete command longer than 96 characters: " + "x".repeat(200)));
  assert.equal(first.seq, "1");
  assert.equal((await readHistory(cwd, "task-one")).events.length, 0);
  store.append(event("second"));
  await store.flush();
  assert.equal(committed.length, 2);
  const page = await readHistory(cwd, "task-one", { limit: 1 });
  assert.equal(page.events[0].source.raw.params.delta, first.source.raw.params.delta);
  assert.deepEqual((await readHistory(cwd, "task-one", { after: page.nextCursor })).events.map((value) => value.seq), ["2"]);
  assert.equal(resolveLiveViewPath(cwd, "task-one"), path.join(resolveHistoryDir(cwd, "task-one"), "live-view.json"));
});

test("automatic short-window batching commits pending events", async (t) => {
  const cwd = await fixture(t);
  let committed;
  const done = new Promise((resolve) => { committed = resolve; });
  const store = await new JobEventStore(cwd, "task-timer", { flushMs: 5, onCommit: committed }).initialize();
  t.historyStores.push(store);
  store.append(event());
  const keepAlive = setTimeout(() => {}, 1000);
  t.after(() => clearTimeout(keepAlive));
  await done;
  assert.equal((await readHistory(cwd, "task-timer")).committedSeq, "1");
});

test("legacy v1 segments replay with v2 records and produce a canonical checkpoint", async (t) => {
  const cwd = await fixture(t);
  const jobId = "task-mixed";
  const streamId = "legacy-stream";
  const directory = resolveHistoryDir(cwd, jobId);
  await fs.mkdir(path.join(directory, "segments"), { recursive: true });
  const legacy = { schemaVersion: 1, streamId, jobId, seq: "1", type: "message.completed",
    occurredAt: "2026-09-15T00:00:00.000Z", receivedAt: "2026-09-15T00:00:00.000Z",
    threadId: "thread", turnId: "turn-1", itemId: "message-1", source: { message: { method: "item/completed",
      params: { threadId: "thread", turnId: "turn-1", item: { type: "agentMessage", id: "message-1", text: "legacy" } } } } };
  const data = JSON.stringify([legacy]);
  const encoded = `${JSON.stringify({ events: [legacy], sha256: createHash("sha256").update(data).digest("hex") })}\n`;
  const bytes = Buffer.byteLength(encoded);
  await fs.writeFile(path.join(directory, "segments", "000001.events"), encoded);
  await fs.writeFile(path.join(directory, "manifest.json"), `${JSON.stringify({ schemaVersion: 1, jobId, streamId,
    earliestSeq: "1", committedSeq: "1", continuity: "complete", segments: [{ file: "000001.events", bytes,
      firstSeq: "1", lastSeq: "1", blocks: [{ offset: 0, bytes, firstSeq: "1", lastSeq: "1" }] }], nextSegment: 2,
    metadata: {}, createdAt: "2026-09-15T00:00:00.000Z", closed: true, writerPid: null })}\n`);
  const first = await readHistory(cwd, jobId);
  assert.equal(first.events[0].schemaVersion, 2);
  assert.equal(first.events[0].payload.message.text, "legacy");
  const projection = ["legacy"];
  const store = await new JobEventStore(cwd, jobId, {
    createCheckpoint: (events, manifest) => ({ messages: [...projection, ...events.map((entry) => entry.payload.message.text)],
      history: { committedSeq: manifest.committedSeq } }),
    onCommit: (events) => projection.push(...events.map((entry) => entry.payload.message.text))
  }).initialize();
  t.historyStores.push(store);
  store.append(createCanonicalEvent({ job: { id: jobId }, type: "message.completed",
    identity: { sessionId: "thread", turnId: "turn-2", messageId: "message-2" },
    payload: { message: { messageId: "message-2", role: "assistant", content: [{ type: "text", text: "canonical" }], text: "canonical" } },
    source: { protocol: "local", method: "test/canonical", raw: null } }));
  await store.flush();
  const history = await readHistory(cwd, jobId);
  assert.deepEqual(history.events.map((entry) => [entry.schemaVersion, entry.seq, entry.payload.message.text]), [[2, "1", "legacy"], [2, "2", "canonical"]]);
  assert.deepEqual((await readHistory(cwd, jobId, { after: first.nextCursor })).events.map((entry) => entry.seq), ["2"]);
  assert.deepEqual(store.checkpoint.messages, ["legacy", "canonical"]);
  assert.equal(store.checkpoint.history.committedSeq, "2");
});

test("terminated writer preserves every published cursor and recovery removes an uncommitted tail", async (t) => {
  const cwd = await fixture(t);
  const moduleUrl = new URL("../plugins/codex/scripts/lib/job-event-store.mjs", import.meta.url).href;
  const code = `import { JobEventStore, readHistory } from ${JSON.stringify(moduleUrl)};
    const store = await new JobEventStore(process.argv[1], "task-crash", { flushMs: 60000 }).initialize();
    store.append({type:"message.completed", source:{message:{params:{text:"durable"}}}});
    await store.flush();
    const history = await readHistory(process.argv[1], "task-crash");
    store.append({type:"message.delta", source:{message:{params:{delta:"not committed"}}}});
    process.stdout.write(history.nextCursor + "\\n");
    setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code, cwd], { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill("SIGKILL"));
  let line = "";
  const cursor = await new Promise((resolve, reject) => {
    child.stdout.on("data", (data) => { line += data; if (line.includes("\n")) resolve(line.trim()); });
    child.once("error", reject);
    child.once("exit", () => { if (!line) reject(new Error("writer exited before commit")); });
  });
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  const directory = resolveHistoryDir(cwd, "task-crash");
  const manifest = JSON.parse(await fs.readFile(path.join(directory, "manifest.json"), "utf8"));
  const segment = path.join(directory, "segments", manifest.segments[0].file);
  await fs.appendFile(segment, '{"incomplete":');
  const store = await new JobEventStore(cwd, "task-crash").initialize();
  t.historyStores.push(store);
  assert.equal((await fs.stat(segment)).size, manifest.segments[0].bytes);
  const history = await readHistory(cwd, "task-crash", { after: cursor });
  assert.equal(history.continuity, "partial");
  assert.deepEqual(history.events, []);
  assert.equal(store.append(event("resumed")).seq, "2");
  await store.flush();
  assert.deepEqual((await readHistory(cwd, "task-crash", { after: cursor })).events.map((value) => value.seq), ["2"]);
});

test("segment retention expires old cursors with an explicit recoverable boundary", async (t) => {
  const cwd = await fixture(t);
  const store = await new JobEventStore(cwd, "task-retention", { segmentBytes: 700, maxJobBytes: 1500 }).initialize();
  t.historyStores.push(store);
  store.append(event("x".repeat(150)));
  await store.flush();
  const old = (await readHistory(cwd, "task-retention")).nextCursor;
  for (let index = 0; index < 6; index += 1) {
    store.append(event("x".repeat(150)));
    await store.flush();
  }
  let boundary;
  await assert.rejects(readHistory(cwd, "task-retention", { after: old }), (error) => {
    assert.equal(error.code, "CURSOR_EXPIRED");
    boundary = error.earliestAvailableCursor;
    return true;
  });
  const history = await readHistory(cwd, "task-retention", { after: boundary });
  assert.equal(history.continuity, "partial");
  assert.equal(history.events[0].seq, history.earliestSeq);
  assert.equal(history.events.at(-1).seq, "7");
  assert.ok(store.snapshot.segments.reduce((sum, segment) => sum + segment.bytes, 0) <= 1500);
});

test("segment retention preserves history still needed by an active follower", async (t) => {
  const cwd = await fixture(t);
  let retainedCursor = null;
  const store = await new JobEventStore(cwd, "task-follow-retention", {
    segmentBytes: 700,
    maxJobBytes: 1500,
    retainedCursors: () => retainedCursor ? [retainedCursor] : []
  }).initialize();
  t.historyStores.push(store);
  store.append(event("first"));
  await store.flush();
  retainedCursor = (await readHistory(cwd, "task-follow-retention")).nextCursor;
  for (let index = 0; index < 6; index += 1) {
    store.append(event("x".repeat(150)));
    await store.flush();
  }
  assert.deepEqual((await readHistory(cwd, "task-follow-retention", { after: retainedCursor })).events.map((value) => value.seq), ["2", "3", "4", "5", "6", "7"]);
  assert.ok(store.snapshot.segments.reduce((sum, segment) => sum + segment.bytes, 0) > 1500);
  const expiredCursor = retainedCursor;
  retainedCursor = null;
  await store.pruneToBytes(1500);
  await assert.rejects(readHistory(cwd, "task-follow-retention", { after: expiredCursor }), { code: "CURSOR_EXPIRED" });
});

test("segment retention advances with pages sent to an active follower", async (t) => {
  const cwd = await fixture(t);
  const job = { id: "task-follow-progress", kind: "task", jobClass: "task", workspaceRoot: cwd,
    status: "running", startedAt: new Date().toISOString(), createdAt: new Date().toISOString(), pid: process.pid };
  writeJobFile(cwd, job.id, job);
  upsertJob(cwd, job);
  const runtime = new JobRuntime({ threadRecords: false });
  try {
    await runtime.register({}, cwd, job.id);
    const entry = [...runtime.jobs.values()][0];
    entry.store.options.segmentBytes = 700;
    entry.store.options.maxJobBytes = 2500;
    const socket = { destroyed: false, writableLength: 0, write: () => true,
      end() { this.destroyed = true; }, destroy() { this.destroyed = true; } };
    await runtime.follow(socket, cwd, job.id);
    const follower = runtime.followers.get(socket);
    follower.pumping = true;
    for (let index = 0; index < 3; index += 1) {
      entry.store.append(event(`consumed-${index}-${"x".repeat(150)}`));
      await entry.store.flush();
    }
    follower.pumping = false;
    await runtime.pump(follower);
    const consumedCursor = follower.after;
    assert.equal((await readHistory(cwd, job.id, { after: consumedCursor })).events.length, 0);

    follower.pumping = true;
    for (let index = 0; index < 2; index += 1) {
      entry.store.append(event(`unread-${index}-${"x".repeat(150)}`));
      await entry.store.flush();
    }
    assert.ok(BigInt(entry.store.snapshot.earliestSeq) > 1n);
    assert.deepEqual((await readHistory(cwd, job.id, { after: consumedCursor })).events.map((value) => value.seq), ["5", "6"]);
    assert.ok(entry.store.snapshot.segments.reduce((sum, segment) => sum + segment.bytes, 0) <= 2500);
  } finally {
    await runtime.close();
  }
});

test("runtime reports a terminal job after its final history and view are committed", async (t) => {
  const cwd = await fixture(t);
  const startedAt = new Date().toISOString();
  const job = { id: "task-terminal-binding", kind: "task", jobClass: "task", workspaceRoot: cwd,
    status: "running", startedAt, createdAt: startedAt, pid: process.pid, threadId: "thread-terminal" };
  writeJobFile(cwd, job.id, job);
  upsertJob(cwd, job);
  const terminal = [];
  const runtime = new JobRuntime({ threadRecords: false, onTerminal: (finished) => terminal.push(finished.id) });
  try {
    await runtime.register({}, cwd, job.id);
    writeJobFile(cwd, job.id, { ...job, status: "completed", completedAt: new Date().toISOString(), pid: null });
    assert.deepEqual(await runtime.finish(cwd, job.id), { recorded: true });
    assert.deepEqual(terminal, [job.id]);
    assert.equal((await readHistory(cwd, job.id)).events.at(-1).type, "job.completed");
    assert.equal(JSON.parse(await fs.readFile(resolveLiveViewPath(cwd, job.id), "utf8")).status, "completed");
  } finally {
    await runtime.close();
  }
});

test("history validates cursor ownership and rejects unbounded pending queues without consuming a sequence", async (t) => {
  const cwd = await fixture(t);
  const store = await new JobEventStore(cwd, "task-limit", { maxPendingEvents: 1, flushMs: 10000 }).initialize();
  t.historyStores.push(store);
  store.append(event());
  assert.throws(() => store.append(event()), { code: "HISTORY_BACKPRESSURE" });
  await store.flush();
  assert.equal(store.append(event()).seq, "2");
  await store.flush();
  await assert.rejects(readHistory(cwd, "task-limit", { after: "broken" }), { code: "INVALID_CURSOR" });
  const cursor = Buffer.from(JSON.stringify({ protocolVersion: 1, jobId: "task-limit", streamId: "other", lastAppliedSeq: "0" })).toString("base64url");
  await assert.rejects(readHistory(cwd, "task-limit", { after: cursor }), { code: "STREAM_REPLACED" });
});

test("closed terminal histories replay without a writer and cleanup obeys age and aggregate budgets", async (t) => {
  const cwd = await fixture(t);
  const old = await new JobEventStore(cwd, "task-old").initialize({ status: "completed", completedAt: "2026-01-01T00:00:00.000Z" });
  old.append(event());
  await old.close();
  assert.equal((await readHistory(cwd, "task-old")).events.length, 1);
  const active = await new JobEventStore(cwd, "task-active").initialize({ status: "running" });
  t.historyStores.push(active);
  active.append(event());
  await active.flush();
  const cleaned = await cleanupHistory(cwd, { now: Date.parse("2026-09-15T00:00:00Z") });
  assert.deepEqual(cleaned.removed, ["task-old"]);
  assert.equal((await readHistory(cwd, "task-active")).events.length, 1);
  const recent = await new JobEventStore(cwd, "task-recent").initialize({ status: "completed", completedAt: "2026-09-15T00:00:00.000Z" });
  recent.append(event());
  await recent.close();
  const budget = await cleanupHistory(cwd, { maxTotalBytes: 1, now: Date.parse("2026-09-15T00:00:01Z") });
  assert.deepEqual(budget.removed, ["task-recent"]);
  assert.equal((await readHistory(cwd, "task-active")).events.length, 1);
});

test("a crash between segment fsync and manifest publication never exposes the unpublished batch", async (t) => {
  const cwd = await fixture(t);
  const moduleUrl = new URL("../plugins/codex/scripts/lib/job-event-store.mjs", import.meta.url).href;
  const code = `import fs from "node:fs/promises";
    import { JobEventStore, readHistory } from ${JSON.stringify(moduleUrl)};
    const store = await new JobEventStore(process.argv[1], "task-midcommit").initialize();
    store.append({type:"message.completed", source:{message:{params:{text:"published"}}}});
    await store.flush();
    process.stdout.write((await readHistory(process.argv[1], "task-midcommit")).nextCursor + "\\n");
    const rename = fs.rename;
    fs.rename = async (from, to) => {
      if (to.endsWith("manifest.json")) { process.kill(process.pid, "SIGKILL"); await new Promise(() => {}); }
      return rename(from, to);
    };
    store.append({type:"message.completed", source:{message:{params:{text:"fsynced but unpublished"}}}});
    await store.flush();`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code, cwd], { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
  let cursor = "";
  child.stdout.on("data", (data) => { cursor += data; });
  const [codeValue, signal] = await once(child, "exit");
  assert.equal(codeValue, null);
  assert.equal(signal, "SIGKILL");
  assert.ok(cursor.trim());
  assert.equal((await readHistory(cwd, "task-midcommit")).events.length, 1);
  const store = await new JobEventStore(cwd, "task-midcommit").initialize();
  t.historyStores.push(store);
  assert.deepEqual((await readHistory(cwd, "task-midcommit", { after: cursor.trim() })).events, []);
  assert.equal(store.append(event("after crash")).seq, "2");
  await store.flush();
  assert.equal((await readHistory(cwd, "task-midcommit", { after: cursor.trim() })).events[0].source.raw.params.delta, "after crash");
});

test("retention publishes a complete projection checkpoint before removing old event segments", async (t) => {
  const cwd = await fixture(t);
  const moduleUrl = new URL("../plugins/codex/scripts/lib/job-event-store.mjs", import.meta.url).href;
  const code = `import { JobEventStore, readHistory } from ${JSON.stringify(moduleUrl)};
    let view = { texts: [], history: { committedSeq: "0" } };
    const store = await new JobEventStore(process.argv[1], "task-checkpoint", {
      segmentBytes: 700, maxJobBytes: 1500,
      createCheckpoint: (events, manifest) => ({ texts: [...view.texts, ...events.map(e => e.payload.message.text)], history: { committedSeq: manifest.committedSeq } }),
      onCommit: async (events) => {
        view.texts.push(...events.map(e => e.payload.message.text));
        view.history.committedSeq = events.at(-1).seq;
        if (view.history.committedSeq === "6") {
          process.stdout.write((await readHistory(process.argv[1], "task-checkpoint")).nextCursor + "\\n");
          process.kill(process.pid, "SIGKILL");
          await new Promise(() => {});
        }
      }
    }).initialize();
    for (let i = 0; i < 6; i++) {
      store.append({type:"message.completed", source:{message:{params:{text:String(i) + "x".repeat(150)}}}});
      await store.flush();
    }`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code, cwd], { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
  let cursor = "";
  child.stdout.on("data", (data) => { cursor += data; });
  const [, signal] = await once(child, "exit");
  assert.equal(signal, "SIGKILL");
  assert.ok(cursor.trim());
  const store = await new JobEventStore(cwd, "task-checkpoint").initialize();
  t.historyStores.push(store);
  assert.equal(store.checkpoint.history.committedSeq, "6");
  assert.equal(store.checkpoint.texts.length, 6);
  const history = await readHistory(cwd, "task-checkpoint");
  assert.ok(history.events.length < 6);
  assert.equal((await readHistory(cwd, "task-checkpoint", { after: cursor.trim() })).events.length, 0);
});

test("global cleanup never deletes another live process's terminal history", async (t) => {
  const cwd = await fixture(t);
  const moduleUrl = new URL("../plugins/codex/scripts/lib/job-event-store.mjs", import.meta.url).href;
  const code = `import { JobEventStore } from ${JSON.stringify(moduleUrl)};
    const store = await new JobEventStore(process.argv[1], "task-external").initialize({job:{status:"completed"}, completedAt:"2020-01-01T00:00:00Z"});
    store.append({type:"job.completed"});
    await store.flush();
    process.stdout.write("ready\\n");
    setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code, cwd], { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
  try {
    await once(child.stdout, "data");
    await assert.rejects(new JobEventStore(cwd, "task-external").initialize(), { code: "STORE_BUSY" });
    const cleaned = await cleanupHistory(cwd, { maxTotalBytes: 0 });
    assert.deepEqual(cleaned.removed, []);
    assert.equal((await readHistory(cwd, "task-external")).events.length, 1);
  } finally {
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
  }
  assert.deepEqual((await cleanupHistory(cwd, { maxTotalBytes: 0 })).removed, ["task-external"]);
});

test("whole-job retirement retains cursor identity and a compact final live view", async (t) => {
  const cwd = await fixture(t);
  const store = await new JobEventStore(cwd, "task-expired").initialize({
    job: { id: "task-expired", label: "Expired task", status: "completed", startedAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:01:00Z", request: { prompt: "private large prompt" }, result: "large result" }
  });
  store.append(event("first"));
  await store.flush();
  const firstCursor = (await readHistory(cwd, "task-expired")).nextCursor;
  store.append(event("second"));
  await store.close();
  const lastCursor = (await readHistory(cwd, "task-expired")).nextCursor;
  const file = resolveLiveViewPath(cwd, "task-expired");
  await fs.writeFile(file, JSON.stringify({ label: "Expired task", status: "completed", lastMessage: { text: "large message" }, tail: [{ text: "large tail" }], files: [{ path: "large-file" }], usage: { inputTokens: 5, outputTokens: 3, cachedInputTokens: 2, complete: true }, _items: { large: "content" } }));
  const cleaned = await cleanupHistory(cwd, { retentionDays: 30, now: Date.parse("2026-09-15T00:00:00Z") });
  assert.deepEqual(cleaned.removed, ["task-expired"]);
  let boundary;
  await assert.rejects(readHistory(cwd, "task-expired", { after: firstCursor }), (error) => {
    assert.equal(error.code, "CURSOR_EXPIRED");
    assert.equal(error.earliestSeq, "3");
    boundary = error.earliestAvailableCursor;
    return true;
  });
  for (const after of [undefined, lastCursor, boundary]) {
    const history = await readHistory(cwd, "task-expired", { after });
    assert.deepEqual(history.events, []);
    assert.equal(history.committedSeq, "2");
    assert.equal(history.nextCursor, lastCursor);
  }
  const manifest = JSON.parse(await fs.readFile(path.join(resolveHistoryDir(cwd, "task-expired"), "manifest.json"), "utf8"));
  assert.equal(manifest.tombstone, true);
  assert.equal(manifest.purged, true);
  assert.equal(manifest.metadata.job.request, undefined);
  assert.equal(manifest.metadata.job.result, undefined);
  const view = JSON.parse(await fs.readFile(file, "utf8"));
  assert.deepEqual(view.tail, []);
  assert.deepEqual(view.files, []);
  assert.equal(view.lastMessage, null);
  assert.equal(view._items, undefined);
  assert.equal(view.usage.inputTokens, 5);
  assert.equal(view.history.continuity, "partial");
  assert.deepEqual(Object.keys(view).sort(), ["schemaVersion", "jobId", "label", "status", "startedAt", "endedAt", "threadId", "turnId", "activeCommands", "lastMessage", "files", "usage", "pendingQuestion", "history", "tail"].sort());
  assert.deepEqual((await cleanupHistory(cwd, { maxTotalBytes: 0 })).removed, []);
});

test("cleanup tolerates temporary projection rename races and legacy view-only directories", async (t) => {
  const cwd = await fixture(t);
  const store = await new JobEventStore(cwd, "task-race").initialize({ status: "running" });
  t.historyStores.push(store);
  const temporary = `${resolveLiveViewPath(cwd, "task-race")}.${process.pid}.tmp`;
  await fs.writeFile(temporary, "temporary projection");
  const legacy = resolveHistoryDir(cwd, "task-legacy");
  await fs.mkdir(legacy, { recursive: true });
  await fs.writeFile(path.join(legacy, "live-view.json"), "{}");
  const originalStat = fs.stat;
  let raced = false;
  fs.stat = async (file, ...args) => {
    if (file === temporary) { await fs.rm(file, { force: true }); raced = true; }
    return originalStat(file, ...args);
  };
  try {
    const result = await cleanupHistory(cwd);
    assert.deepEqual(result.removed, []);
    assert.equal(raced, true);
  } finally { fs.stat = originalStat; }
});

test("cleanup removes a legacy history whose round is safely in a record, and keeps every other case", async (t) => {
  const cwd = await fixture(t);
  const stateDir = resolveStateDir(cwd);
  // A round observed before it bound leaves this behind, saying "running" for
  // ever. It may only go once the round is in the record and the job is over.
  const plant = async (jobId, { recordId, receipt = true, status = "completed" } = {}) => {
    await fs.mkdir(path.join(stateDir, "job-history", jobId), { recursive: true });
    await fs.writeFile(path.join(stateDir, "job-history", jobId, "live-view.json"),
      JSON.stringify({ schemaVersion: 1, jobId, status: "running", endedAt: null }));
    await fs.mkdir(path.join(stateDir, "job-index"), { recursive: true });
    await fs.writeFile(path.join(stateDir, "job-index", `${jobId}.json`),
      JSON.stringify({ schemaVersion: 1, jobId, roundId: jobId, recordId }));
    if (receipt) {
      await fs.mkdir(path.join(stateDir, "thread-records", recordId, "rounds"), { recursive: true });
      await fs.writeFile(path.join(stateDir, "thread-records", recordId, "rounds", `${jobId}.json`), JSON.stringify({ job: { id: jobId } }));
    }
    if (status) {
      await fs.mkdir(path.join(stateDir, "jobs"), { recursive: true });
      await fs.writeFile(path.join(stateDir, "jobs", `${jobId}.json`), JSON.stringify({ id: jobId, status }));
    }
  };
  await plant("task-superseded", { recordId: "rec-one" });
  await plant("task-still-running", { recordId: "rec-two", status: "running" });
  await plant("task-no-receipt", { recordId: "rec-three", receipt: false });
  await plant("task-own-record", { recordId: "task-own-record" });

  const cleaned = await cleanupHistory(cwd);
  assert.deepEqual(cleaned.removedLegacy, ["task-superseded"]);
  for (const [jobId, expected] of [["task-superseded", false], ["task-still-running", true],
    ["task-no-receipt", true], ["task-own-record", true]]) {
    assert.equal(fsSync.existsSync(path.join(stateDir, "job-history", jobId)), expected, jobId);
  }
});
