import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createCanonicalEvent } from "../plugins/codex/scripts/lib/executor-events.mjs";
import { buildStatusSnapshot, resolveResultJob, resolveThreadResultJob } from "../plugins/codex/scripts/lib/job-control.mjs";
import { streamJobEvents } from "../plugins/codex/scripts/lib/job-events.mjs";
import { follow } from "../plugins/codex/scripts/lib/job-observe.mjs";
import { cancelLiveJob, inactiveRoundMessage, sendLiveCommand } from "../plugins/codex/scripts/lib/live-commands.mjs";
import { renderStatusReport, renderStoredJobResult } from "../plugins/codex/scripts/lib/render.mjs";
import { bindProvisionalDispatch, bufferProvisionalEvent, createProvisionalDispatch } from "../plugins/codex/scripts/lib/thread-record-binding.mjs";
import { stateDirFor } from "../plugins/codex/scripts/lib/history-resolver.mjs";
import { upsertJob, writeJobFile } from "../plugins/codex/scripts/lib/state.mjs";
import { isolateTestEnvironment, makeTempDir, run } from "./helpers.mjs";

const AT = "2026-09-21T00:00:00.000Z";
const SCRIPT = path.join(fileURLToPath(new URL("..", import.meta.url)), "plugins/codex/scripts/codex-companion.mjs");

function setup(t) {
  isolateTestEnvironment(t);
  const cwd = makeTempDir();
  return { cwd, stateDir: stateDirFor(cwd) };
}

function lifecycle(job, type) {
  return createCanonicalEvent({
    job,
    type,
    identity: { sessionId: job.threadId, turnId: job.turnId ?? null },
    occurredAt: AT,
    receivedAt: AT,
    payload: type === "job.started"
      ? { label: job.label, startedAt: AT, sessionId: job.sessionId ?? null, prompt: job.request?.prompt ?? null, resumed: false }
      : { status: type.slice(4), reason: { code: "end_turn", backendCode: null, message: null, retryable: false },
        completedAt: AT, finalMessages: [], error: null, result: job.result ?? null },
    source: { protocol: "local", method: `test/${type}`, raw: null }
  });
}

async function bindRound(cwd, job, terminal = false) {
  writeJobFile(cwd, job.id, job);
  upsertJob(cwd, job);
  const provisional = createProvisionalDispatch({ workspaceRoot: cwd, job });
  bufferProvisionalEvent(provisional, lifecycle(job, "job.started"));
  if (terminal) bufferProvisionalEvent(provisional, lifecycle(job, `job.${job.status}`));
  return bindProvisionalDispatch(provisional, job.threadId);
}

async function eventLines(reports) {
  const controller = new AbortController();
  const lines = [];
  let poll = 0;
  let activeRoundId = null;
  await streamJobEvents("/repo", { pollMs: 1, signal: controller.signal, threadRecords: true }, {
    snapshot() {
      if (poll === reports.length) {
        controller.abort();
        return { running: [], latestFinished: null, recent: [] };
      }
      const report = reports[poll++];
      activeRoundId = report.running?.[0]?.id ?? null;
      return report;
    },
    roundContext: async () => ({ layout: "thread-record", activeRoundId }),
    status: async () => ({}),
    readJob: () => null,
    acknowledge: async () => {},
    claimQuestion: async () => true,
    progressAt: () => Date.now(),
    writeLine: (line) => lines.push(line)
  });
  return lines;
}

test("each round emits one terminal signal and an old follow stops at its own terminal", async (t) => {
  const { cwd, stateDir } = setup(t);
  const first = { id: "task-first", label: "first", workspaceRoot: cwd, executor: "codex", jobClass: "task",
    threadId: "thread-one", status: "completed", startedAt: AT, completedAt: AT, result: { rawOutput: "first result" } };
  const second = { ...first, id: "task-second", label: "second", result: { rawOutput: "second result" } };
  await bindRound(cwd, first, true);
  await bindRound(cwd, second, true);

  let output = "";
  await follow({ cwd, stateDir, fallback: false }, first, { quiet: true }, {
    write: async (text) => { output += text; }
  });
  assert.equal((output.match(/^DONE job=task-first/mg) ?? []).length, 1);
  assert.doesNotMatch(output, /task-second/);

  const runningFirst = { ...first, status: "running", completedAt: null };
  const runningSecond = { ...second, status: "running", completedAt: null };
  const lines = await eventLines([
    { running: [runningFirst], latestFinished: null, recent: [] },
    { running: [], latestFinished: first, recent: [] },
    { running: [], latestFinished: first, recent: [] },
    { running: [runningSecond], latestFinished: first, recent: [] },
    { running: [], latestFinished: second, recent: [first] },
    { running: [], latestFinished: second, recent: [first] }
  ]);
  assert.deepEqual(lines, [
    "DONE job=task-first [first] thread=thread-one",
    "DONE job=task-second [second] thread=thread-one"
  ]);
});

test("stale controls name the active job and a second live round is THREAD_BUSY", async (t) => {
  const { cwd } = setup(t);
  const first = { id: "task-old", label: "old", workspaceRoot: cwd, executor: "codex", jobClass: "task",
    threadId: "thread-live", status: "completed", startedAt: AT, completedAt: AT, result: { rawOutput: "old" } };
  const active = { ...first, id: "task-active", label: "active", status: "running", completedAt: null,
    turnId: "turn-active", result: null };
  await bindRound(cwd, first, true);
  await bindRound(cwd, active, false);
  const expected = inactiveRoundMessage(first.id, active.id);
  const cases = [
    ["message", () => sendLiveCommand(cwd, first.id, "message", {}, "new direction")],
    ["answer", () => sendLiveCommand(cwd, first.id, "answer", {}, null)],
    ["cancel", () => cancelLiveJob(cwd, first)]
  ];
  for (const [name, action] of cases) {
    await assert.rejects(action, (error) => error.code === "STALE_ROUND" && error.message === expected, name);
  }
  const staleStatus = run(process.execPath, [SCRIPT, "status", first.id, "--json", "--cwd", cwd], { cwd, env: process.env });
  assert.equal(staleStatus.status, 0, staleStatus.stderr);
  const stalePayload = JSON.parse(staleStatus.stdout).job;
  assert.equal(stalePayload.activeRoundId, active.id);
  assert.equal(stalePayload.live.unavailable, expected);

  const third = { ...active, id: "task-third", label: "third" };
  writeJobFile(cwd, third.id, third);
  upsertJob(cwd, third);
  const provisional = createProvisionalDispatch({ workspaceRoot: cwd, job: third });
  bufferProvisionalEvent(provisional, lifecycle(third, "job.started"));
  await assert.rejects(bindProvisionalDispatch(provisional, third.threadId), (error) =>
    error.code === "THREAD_BUSY" && error.message === `THREAD_BUSY thread=${third.threadId} active_job=${active.id}`);
});

test("thread status uses one current handle and seam-off status and result bytes stay unchanged", async (t) => {
  const { cwd } = setup(t);
  const first = { id: "task-old", label: "old label", workspaceRoot: cwd, executor: "codex", jobClass: "task",
    threadId: "thread-status", status: "completed", startedAt: AT, completedAt: AT, result: { rawOutput: "old result" } };
  const latest = { ...first, id: "task-current", label: "current label", status: "running", completedAt: null, result: null };
  writeJobFile(cwd, first.id, first);
  upsertJob(cwd, first);
  writeJobFile(cwd, latest.id, latest);
  upsertJob(cwd, latest);

  const report = buildStatusSnapshot(cwd, { all: true, threadRecords: true });
  assert.equal(report.threads.length, 1);
  assert.deepEqual({ id: report.threads[0].id, label: report.threads[0].label, status: report.threads[0].status,
    activeRoundId: report.threads[0].activeRoundId },
  { id: latest.id, label: latest.label, status: latest.status, activeRoundId: latest.id });
  assert.equal(Object.hasOwn(report.threads[0], "rounds"), false);
  const rows = renderStatusReport(report).split("\n").filter((line) => /^\| task-/.test(line));
  assert.deepEqual(rows.length, 1);
  assert.match(rows[0], /task-current \[current label\]/);
  assert.doesNotMatch(renderStatusReport(report), /task-old/);

  const one = makeTempDir();
  const single = { ...first, id: "task-single", workspaceRoot: one, threadId: null, label: "single",
    result: { rawOutput: "single result" } };
  writeJobFile(one, single.id, single);
  upsertJob(one, single);
  const legacyReport = buildStatusSnapshot(one, { all: true, threadRecords: false });
  const threadReport = buildStatusSnapshot(one, { all: true, threadRecords: true });
  assert.equal(renderStatusReport(threadReport), renderStatusReport(legacyReport));
  assert.equal(Object.hasOwn(legacyReport, "threads"), false);
  assert.equal(renderStoredJobResult(single, { ...single, threadId: null, result: { rawOutput: "single result" } }), "single result\n");
  const legacyStatus = run(process.execPath, [SCRIPT, "status", "--all", "--json", "--cwd", one], { cwd: one, env: process.env });
  assert.equal(legacyStatus.status, 0, legacyStatus.stderr);
  assert.equal(JSON.parse(legacyStatus.stdout).threads[0].id, single.id);
  const legacyResult = run(process.execPath, [SCRIPT, "result", single.id, "--cwd", one], { cwd: one, env: process.env });
  assert.equal(legacyResult.stdout, "single result\n");

  const completedLatest = { ...latest, status: "completed", completedAt: AT, result: { rawOutput: "current result" } };
  writeJobFile(cwd, completedLatest.id, completedLatest);
  upsertJob(cwd, completedLatest);
  assert.equal(resolveThreadResultJob(cwd, latest.threadId).job.id, latest.id);
  assert.equal(resolveResultJob(cwd, first.id).job.id, first.id);
  const threadResult = run(process.execPath, [SCRIPT, "result", "--thread", latest.threadId, "--json", "--cwd", cwd],
    { cwd, env: process.env });
  assert.equal(threadResult.status, 0, threadResult.stderr);
  assert.equal(JSON.parse(threadResult.stdout).job.id, latest.id);
});
