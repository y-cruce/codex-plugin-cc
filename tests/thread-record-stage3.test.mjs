import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createCanonicalEvent } from "../plugins/codex/scripts/lib/executor-events.mjs";
import { applyJobEvent, createLiveView } from "../plugins/codex/scripts/lib/job-event-model.mjs";
import { historyHasTerminalEvent, JobEventStore, readHistory, readRecordHistory } from "../plugins/codex/scripts/lib/job-event-store.mjs";
import { resolveJobHistory } from "../plugins/codex/scripts/lib/history-resolver.mjs";
import { JobRuntime } from "../plugins/codex/scripts/lib/job-runtime.mjs";
import { jobIndexPath, legacyJobHistoryPaths, threadRecordPaths } from "../plugins/codex/scripts/lib/thread-records.mjs";
import { resolveStateDir, writeJobFile } from "../plugins/codex/scripts/lib/state.mjs";
import { isolateTestEnvironment, makeTempDir } from "./helpers.mjs";

const AT = "2026-09-21T00:00:00.000Z";

function temp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-thread-stage3-"));
  const cwd = fs.mkdtempSync(path.join(root, "workspace-"));
  const stateDir = path.join(root, "state");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { cwd, stateDir };
}

function event(jobId, type, turnId = null, extra = {}) {
  const payload = type === "job.started"
    ? { label: jobId, startedAt: AT, sessionId: `claude-${jobId}`, prompt: `prompt ${jobId}`, resumed: false }
    : type.startsWith("job.")
      ? { status: type.slice(4), reason: { code: type === "job.completed" ? "end_turn" : "backend_error",
        backendCode: null, message: null, retryable: false }, completedAt: AT, finalMessages: [], error: null, result: extra.result ?? null }
      : type === "turn.started"
        ? { ordinal: 0, prompt: [] }
        : type === "turn.completed"
          ? { status: extra.status ?? "completed", reason: { code: extra.status === "interrupted" ? "interrupted" : "end_turn",
            backendCode: null, message: null, retryable: extra.status === "interrupted" }, finalMessages: [], usage: null }
          : { usage: extra.usage };
  return createCanonicalEvent({ job: { id: jobId }, type, identity: { sessionId: "thread-one", turnId },
    occurredAt: AT, receivedAt: AT, payload, source: { protocol: "local", method: `test/${type}`, raw: null } });
}

function decode(cursor) {
  return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
}

test("thread history uses v2 cursors and filters reads and terminals by round", async (t) => {
  const { cwd, stateDir } = temp(t);
  const recordId = "task-one";
  const location = threadRecordPaths(stateDir, recordId);
  const store = await new JobEventStore(cwd, recordId, { directory: location.directory,
    threadRecord: { recordId, workspaceRoot: cwd, executorKey: "codex", threadId: "thread-one" } }).initialize();
  store.append(event("task-one", "job.started"));
  store.append(event("task-one", "job.completed", null, { result: "one" }));
  store.append(event("task-two", "job.started"));
  await store.close();
  fs.mkdirSync(path.join(stateDir, "job-index"), { recursive: true });
  for (const jobId of ["task-one", "task-two"]) {
    fs.writeFileSync(jobIndexPath(stateDir, jobId), `${JSON.stringify({ schemaVersion: 1, jobId, roundId: jobId, recordId })}\n`);
  }

  const first = await readHistory(cwd, "task-one", { stateDir });
  const second = await readHistory(cwd, "task-two", { stateDir });
  const whole = await readRecordHistory(cwd, recordId, { stateDir });
  assert.deepEqual(first.events.map((value) => value.jobId), ["task-one", "task-one"]);
  assert.deepEqual(second.events.map((value) => value.jobId), ["task-two"]);
  assert.deepEqual(whole.events.map((value) => value.seq), ["1", "2", "3"]);
  assert.deepEqual(decode(first.nextCursor), { protocolVersion: 2, recordId, streamId: first.streamId, lastAppliedSeq: "3" });
  assert.equal(await historyHasTerminalEvent(cwd, "task-one", { stateDir }), true);
  assert.equal(await historyHasTerminalEvent(cwd, "task-two", { stateDir }), false);

  const legacyId = "legacy-job";
  const legacy = legacyJobHistoryPaths(stateDir, legacyId);
  const legacyStore = await new JobEventStore(cwd, legacyId, { directory: legacy.directory }).initialize();
  legacyStore.append(event(legacyId, "job.started"));
  await legacyStore.close();
  const legacyPage = await readHistory(cwd, legacyId, { stateDir });
  assert.equal(decode(legacyPage.nextCursor).protocolVersion, 1);
  await assert.rejects(readHistory(cwd, legacyId, { stateDir, after: first.nextCursor }), { code: "INVALID_CURSOR" });
  await assert.rejects(readHistory(cwd, "task-one", { stateDir, after: legacyPage.nextCursor }), { code: "INVALID_CURSOR" });
});

test("round paging crosses empty filtered pages until the record cursor is caught up", async (t) => {
  const { cwd, stateDir } = temp(t);
  const recordId = "task-a";
  const location = threadRecordPaths(stateDir, recordId);
  const store = await new JobEventStore(cwd, recordId, { directory: location.directory,
    threadRecord: { recordId, workspaceRoot: cwd, executorKey: "codex", threadId: "thread-paged" } }).initialize();
  store.append(event("task-a", "job.started"));
  store.append(event("task-b", "job.started"));
  store.append(event("task-b", "turn.started", "turn-b"));
  store.append(event("task-a", "turn.started", "turn-a"));
  await store.close();
  fs.mkdirSync(path.join(stateDir, "job-index"), { recursive: true });
  fs.writeFileSync(jobIndexPath(stateDir, "task-a"), `${JSON.stringify({ schemaVersion: 1,
    jobId: "task-a", roundId: "task-a", recordId })}\n`);

  let after;
  let crossedEmpty = 0;
  const found = [];
  while (true) {
    const page = await readHistory(cwd, "task-a", { stateDir, after, limit: 1 });
    found.push(...page.events);
    if (!page.events.length && page.caughtUp === false) crossedEmpty += 1;
    after = page.nextCursor;
    if (page.caughtUp) break;
  }
  assert.equal(crossedEmpty, 2);
  assert.deepEqual(found.map((value) => [value.seq, value.type]), [["1", "job.started"], ["4", "turn.started"]]);
});

test("round reducer keeps redirected executor turns in one dispatch round", () => {
  const view = createLiveView({ id: "task-one", executor: "codex", startedAt: AT }, { recordId: "task-one" });
  let seq = 0;
  const apply = (value) => { value.seq = String(++seq); applyJobEvent(view, value); };
  apply(event("task-one", "job.started"));
  apply(event("task-one", "turn.started", "turn-one"));
  apply(event("task-one", "turn.completed", "turn-one", { status: "interrupted" }));
  apply(event("task-one", "turn.started", "turn-two"));
  apply(event("task-one", "usage.updated", "turn-two", { usage: { inputTokens: 5, outputTokens: 2,
    cachedInputTokens: 1, complete: true, baselineTokens: null } }));
  apply(event("task-one", "turn.completed", "turn-two"));
  apply(event("task-one", "job.completed", "turn-two", { result: { rawOutput: "done" } }));

  assert.equal(view.activeRoundId, null);
  assert.equal(view.latestRoundId, "task-one");
  assert.equal(view.rounds.length, 1);
  assert.deepEqual(view.rounds[0].executorTurnIds, ["turn-one", "turn-two"]);
  assert.equal(view.rounds[0].status, "completed");
  assert.deepEqual(view.rounds[0].usage, { inputTokens: 5, outputTokens: 2, cachedInputTokens: 1, complete: true });
  assert.deepEqual(view.rounds[0].result, { rawOutput: "done" });
  assert.equal(view.rounds[0].firstSeq, "1");
  assert.equal(view.rounds[0].lastSeq, "7");
});

test("terminal endings release a bound record for the next round", async (t) => {
  const endings = [
    { name: "ACP completed", executor: "acp", status: "completed", source: "event" },
    { name: "ACP failed", executor: "acp", status: "failed", source: "event" },
    { name: "ACP cancelled", executor: "acp", status: "cancelled", source: "event" },
    { name: "Codex completed", executor: "codex", status: "completed", source: "job-file" },
    { name: "owner process exited", executor: "codex", status: "failed", source: "owner-exit" }
  ];

  for (const ending of endings) await t.test(ending.name, async (t) => {
    isolateTestEnvironment(t);
    const cwd = fs.realpathSync(makeTempDir());
    const threadId = `thread-${ending.executor}-${ending.source}-${ending.status}`;
    let pid = process.pid;
    if (ending.source === "owner-exit") {
      const ownerProcess = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
      await once(ownerProcess, "exit");
      pid = ownerProcess.pid;
    }
    const first = { id: `task-first-${ending.source}-${ending.status}`, workspaceRoot: cwd, executor: ending.executor,
      status: "running", startedAt: AT, createdAt: AT, pid };
    writeJobFile(cwd, first.id, first);
    const runtime = new JobRuntime({ historySweepMs: 0, threadRecords: true,
      executorIdentity: ending.executor === "acp" ? { kind: "acp", command: "qoder", args: [] } : null });
    try {
      const firstOwner = {};
      await runtime.register(firstOwner, cwd, first.id);
      const firstBinding = await runtime.bind(firstOwner, cwd, first.id, threadId, "turn-first");
      if (ending.source === "event") {
        await runtime.record(event(first.id, `job.${ending.status}`, "turn-first"));
      } else if (ending.source === "job-file") {
        writeJobFile(cwd, first.id, { ...first, status: ending.status, completedAt: AT,
          executorSessionId: threadId, threadId, turnId: "turn-first", pid: null });
        await runtime.finish(cwd, first.id);
      } else {
        await runtime.reconcile();
      }

      const firstLocation = await resolveJobHistory(cwd, first.id);
      const firstManifest = JSON.parse(fs.readFileSync(firstLocation.manifest, "utf8"));
      const firstView = JSON.parse(fs.readFileSync(firstLocation.liveView, "utf8"));
      const firstReceipt = JSON.parse(fs.readFileSync(firstLocation.roundReceipt, "utf8"));
      assert.equal(firstManifest.activeRoundId, null);
      assert.equal(firstView.activeRoundId, null);
      assert.equal(firstView.latestRoundId, first.id);
      assert.equal(firstView.status, ending.status);
      assert.ok(firstView.endedAt);
      assert.equal(firstReceipt.status, ending.status);
      assert.ok(firstReceipt.endedAt);

      const second = { id: `task-second-${ending.source}-${ending.status}`, workspaceRoot: cwd, executor: ending.executor,
        status: "running", startedAt: AT, createdAt: AT, pid: process.pid };
      writeJobFile(cwd, second.id, second);
      const secondOwner = {};
      await runtime.register(secondOwner, cwd, second.id);
      const secondBinding = await runtime.bind(secondOwner, cwd, second.id, threadId, "turn-second");
      assert.equal(secondBinding.recordId, firstBinding.recordId);
      const history = await readRecordHistory(cwd, firstBinding.recordId);
      assert.deepEqual([...new Set(history.events.map((entry) => entry.jobId))], [first.id, second.id]);
      const secondManifest = JSON.parse(fs.readFileSync(firstLocation.manifest, "utf8"));
      assert.equal(secondManifest.activeRoundId, second.id);
    } finally {
      await runtime.close();
    }
  });
});

test("explicit seam-off runtime keeps the legacy path and v1 cursor", async (t) => {
  isolateTestEnvironment(t);
  const cwd = makeTempDir();
  const job = { id: "task-legacy-default", workspaceRoot: cwd, executor: "codex", status: "running",
    startedAt: AT, createdAt: AT, pid: process.pid };
  writeJobFile(cwd, job.id, job);
  const runtime = new JobRuntime({ historySweepMs: 0, threadRecords: false });
  const owner = {};
  try {
    await runtime.register(owner, cwd, job.id);
    const page = await readHistory(cwd, job.id);
    const stateDir = resolveStateDir(cwd);
    assert.equal(decode(page.nextCursor).protocolVersion, 1);
    assert.equal(page.nextCursor, Buffer.from(JSON.stringify({ protocolVersion: 1, jobId: job.id,
      streamId: page.streamId, lastAppliedSeq: page.committedSeq })).toString("base64url"));
    assert.deepEqual(page.events.map((event) => event.type), ["job.started"]);
    assert.equal(fs.existsSync(path.join(stateDir, "job-history", job.id, "manifest.json")), true);
    assert.equal(fs.existsSync(path.join(stateDir, "thread-records")), false);
    assert.equal(fs.existsSync(path.join(stateDir, "job-index")), false);
    assert.equal(runtime.threadRecords, false);
  } finally {
    await runtime.close();
  }
});
