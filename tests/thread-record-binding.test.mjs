import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createCanonicalEvent } from "../plugins/codex/scripts/lib/executor-events.mjs";
import { resolveJobHistory, resolveThreadRecord } from "../plugins/codex/scripts/lib/history-resolver.mjs";
import { readHistory, readRecordHistory } from "../plugins/codex/scripts/lib/job-event-store.mjs";
import { bindProvisionalDispatch, bufferProvisionalEvent, createProvisionalDispatch, failProvisionalDispatch } from "../plugins/codex/scripts/lib/thread-record-binding.mjs";

const AT = "2026-09-21T00:00:00.000Z";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-thread-binding-"));
  const workspaceRoot = fs.mkdtempSync(path.join(root, "workspace-"));
  const stateDir = path.join(root, "state");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { workspaceRoot, stateDir };
}

function provisional(workspaceRoot, jobId) {
  return createProvisionalDispatch({
    workspaceRoot,
    job: { id: jobId, executor: "codex", status: "running", startedAt: AT }
  });
}

function event(jobId, type, marker, turnId = null) {
  const payload = type === "job.started"
    ? { label: marker, startedAt: AT }
    : { code: marker, message: marker, data: null };
  return createCanonicalEvent({
    job: { id: jobId },
    type,
    identity: { sessionId: null, turnId },
    occurredAt: AT,
    receivedAt: AT,
    payload,
    source: { protocol: "local", method: `test/${marker}`, raw: null }
  });
}

function failure(jobId) {
  return createCanonicalEvent({
    job: { id: jobId },
    type: "job.failed",
    identity: { sessionId: null, turnId: null },
    occurredAt: AT,
    receivedAt: AT,
    payload: {
      status: "failed",
      reason: { code: "backend_error", backendCode: "startup", message: "failed before identity", retryable: false },
      completedAt: AT,
      finalMessages: [],
      error: { message: "failed before identity" }
    },
    source: { protocol: "local", method: "test/failure", raw: null }
  });
}

test("racing live binds select one record and reject the loser as busy", async (t) => {
  const { workspaceRoot, stateDir } = fixture(t);
  const first = provisional(workspaceRoot, "task-first");
  const second = provisional(workspaceRoot, "task-second");
  bufferProvisionalEvent(first, event(first.jobId, "job.started", "first"));
  bufferProvisionalEvent(second, event(second.jobId, "job.started", "second"));

  const results = await Promise.allSettled([
    bindProvisionalDispatch(first, "thread-race", { stateDir }),
    bindProvisionalDispatch(second, "thread-race", { stateDir })
  ]);
  const winner = results.find((result) => result.status === "fulfilled").value;
  const loser = results.find((result) => result.status === "rejected").reason;
  assert.equal(loser.code, "THREAD_BUSY");
  assert.match(loser.message, new RegExp(`active_job=${winner.roundId}$`));
  const record = await resolveThreadRecord(workspaceRoot, "codex", "thread-race", { stateDir });
  assert.equal(record.recordId, winner.recordId);
  assert.equal((await resolveJobHistory(workspaceRoot, winner.roundId, { stateDir })).recordId, winner.recordId);
});

test("a later round appends in the existing record sequence", async (t) => {
  const { workspaceRoot, stateDir } = fixture(t);
  const first = provisional(workspaceRoot, "task-one");
  bufferProvisionalEvent(first, event(first.jobId, "job.started", "one", "turn-one"));
  bufferProvisionalEvent(first, failure(first.jobId));
  const firstBound = await bindProvisionalDispatch(first, "thread-shared", { stateDir });

  const second = provisional(workspaceRoot, "task-two");
  bufferProvisionalEvent(second, event(second.jobId, "job.started", "two", "turn-two"));
  const secondBound = await bindProvisionalDispatch(second, "thread-shared", { stateDir });

  assert.equal(secondBound.recordId, firstBound.recordId);
  const history = await readRecordHistory(workspaceRoot, secondBound.recordId, { stateDir });
  assert.deepEqual(history.events.map((entry) => [entry.seq, entry.jobId]), [
    ["1", first.jobId],
    ["2", first.jobId],
    ["3", second.jobId]
  ]);
  // A round's page starts at its own first event: the rounds before it are
  // skipped, not scanned against the limit a page at a time.
  const page = await readHistory(workspaceRoot, second.jobId, { stateDir, limit: 1 });
  assert.deepEqual(page.events.map((entry) => entry.seq), ["3"]);
});

test("provisional events flush in arrival order", async (t) => {
  const { workspaceRoot, stateDir } = fixture(t);
  const dispatch = provisional(workspaceRoot, "task-order");
  bufferProvisionalEvent(dispatch, event(dispatch.jobId, "job.started", "started"));
  bufferProvisionalEvent(dispatch, event(dispatch.jobId, "source.warning", "middle"));
  bufferProvisionalEvent(dispatch, event(dispatch.jobId, "source.warning", "last"));

  await bindProvisionalDispatch(dispatch, "thread-order", { stateDir });
  const history = await readHistory(workspaceRoot, dispatch.jobId, { stateDir });
  assert.deepEqual(history.events.map((entry) => entry.payload.label ?? entry.payload.message), ["started", "middle", "last"]);
  assert.deepEqual(history.events.map((entry) => entry.seq), ["1", "2", "3"]);
});

test("failure before identity creates a readable standalone record", async (t) => {
  const { workspaceRoot, stateDir } = fixture(t);
  const dispatch = provisional(workspaceRoot, "task-no-thread");
  bufferProvisionalEvent(dispatch, event(dispatch.jobId, "job.started", "no thread"));

  const bound = await failProvisionalDispatch(dispatch, failure(dispatch.jobId), { stateDir });
  const location = await resolveJobHistory(workspaceRoot, dispatch.jobId, { stateDir });
  const manifest = JSON.parse(fs.readFileSync(location.manifest, "utf8"));
  const history = await readHistory(workspaceRoot, dispatch.jobId, { stateDir });

  assert.equal(bound.recordId, dispatch.jobId);
  assert.equal(location.layout, "thread-record");
  assert.equal(manifest.threadId, null);
  assert.equal(manifest.activeRoundId, null);
  assert.deepEqual(history.events.map((entry) => entry.type), ["job.started", "job.failed"]);
});
