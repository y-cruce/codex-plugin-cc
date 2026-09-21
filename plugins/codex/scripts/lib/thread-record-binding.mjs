import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { stateDirFor, resolveThreadRecord } from "./history-resolver.mjs";
import { acquireWriter, atomicJson, JobEventStore, releaseWriter } from "./job-event-store.mjs";
import { canonicalWorkspaceRoot, executorKeyFor, jobIndexPath, threadIndexHash, threadIndexPath, threadRecordPaths } from "./thread-records.mjs";

export const MAX_PROVISIONAL_EVENTS = 256;
export const MAX_PROVISIONAL_BYTES = 1024 * 1024;

const INDEX_LOCK_TIMEOUT_MS = 5000;
const TERMINAL_EVENTS = new Set(["job.completed", "job.failed", "job.cancelled"]);

function bindingError(code, message) {
  return Object.assign(new Error(message), { code });
}

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await atomicJson(file, value);
}

async function acquireWriterWaiting(directory) {
  await fs.mkdir(directory, { recursive: true });
  const deadline = Date.now() + INDEX_LOCK_TIMEOUT_MS;
  while (true) {
    try { return await acquireWriter(directory); }
    catch (error) {
      if (error.code !== "STORE_BUSY" || Date.now() >= deadline) throw error;
      await sleep(10);
    }
  }
}

function beginBinding(provisional, allowOverflow = false) {
  if (!provisional || !["open", ...(allowOverflow ? ["overflowed"] : [])].includes(provisional.state)) {
    throw bindingError("PROVISIONAL_CLOSED", "Provisional dispatch is not open for binding");
  }
  provisional.state = "binding";
  return provisional.events.map((event) => structuredClone(event));
}

function resetBinding(provisional, error) {
  provisional.state = provisional.overflowed ? "overflowed" : "open";
  throw error;
}

function receiptFor(provisional, recordId, events, records, job) {
  const started = events.find((event) => event.type === "job.started")?.payload ?? {};
  const terminal = events.findLast((event) => TERMINAL_EVENTS.has(event.type));
  return {
    schemaVersion: 1,
    recordId,
    roundId: provisional.jobId,
    jobId: provisional.jobId,
    firstSeq: records[0]?.seq ?? null,
    lastSeq: records.at(-1)?.seq ?? null,
    executorTurnIds: [...new Set(events.map((event) => event.identity?.turnId).filter(Boolean))],
    sessionId: started.sessionId ?? job.sessionId ?? null,
    prompt: started.prompt ?? job.request?.prompt ?? null,
    usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, complete: true },
    result: terminal?.payload?.result ?? job.result ?? null,
    status: terminal?.type.slice(4) ?? job.status ?? "running",
    startedAt: started.startedAt ?? job.startedAt ?? job.createdAt ?? null,
    endedAt: terminal?.payload?.completedAt ?? job.completedAt ?? null,
    job
  };
}

export async function updateRoundReceipt(location, round, job) {
  const current = await readJson(location.roundReceipt);
  if (!current) throw bindingError("UNKNOWN_ROUND", `No round receipt for ${round.jobId}`);
  await writeJson(location.roundReceipt, { ...current, ...structuredClone(round), job: structuredClone(job ?? current.job) });
}

async function appendEvents(store, events) {
  const records = [];
  for (const event of events) {
    try { records.push(store.append(event)); }
    catch (error) {
      if (error.code !== "HISTORY_BACKPRESSURE") throw error;
      await store.flush();
      records.push(store.append(event));
    }
  }
  await store.flush();
  return records;
}

async function writeRound(provisional, { stateDir, recordId, threadId, activeRoundId, events, job }) {
  const workspaceRoot = canonicalWorkspaceRoot(provisional.workspaceRoot);
  const location = threadRecordPaths(stateDir, recordId, provisional.jobId);
  const store = new JobEventStore(workspaceRoot, recordId, {
    directory: location.directory,
    threadRecord: { recordId, workspaceRoot, executorKey: provisional.executorKey, threadId }
  });
  await store.initialize();
  try {
    const records = await appendEvents(store, events);
    await store.updateManifest({ activeRoundId });
    const receipt = receiptFor(provisional, recordId, events, records, job);
    await writeJson(location.roundReceipt, receipt);
    return { location, receipt };
  } finally {
    await store.close();
  }
}

async function writeJobIndex(stateDir, jobId, recordId) {
  const file = jobIndexPath(stateDir, jobId);
  const current = await readJson(file);
  if (current && (current.schemaVersion !== 1 || current.jobId !== jobId || current.roundId !== jobId || current.recordId !== recordId)) {
    throw bindingError("JOB_ALREADY_BOUND", `Job ${jobId} is already bound to another record`);
  }
  await writeJson(file, { schemaVersion: 1, jobId, roundId: jobId, recordId });
}

export function createProvisionalDispatch({ workspaceRoot, job, executor = {} }) {
  if (!job?.id) throw new Error("A provisional dispatch requires a job id.");
  const kind = executor.kind ?? job.executor ?? "codex";
  const command = executor.command ?? job.request?.executorCommand ?? null;
  const args = executor.args ?? job.request?.executorArgs ?? [];
  return {
    workspaceRoot: canonicalWorkspaceRoot(workspaceRoot),
    jobId: job.id,
    job: structuredClone(job),
    executorKey: executorKeyFor({ executor: kind, command, args }),
    events: [],
    bytes: 0,
    overflowed: false,
    state: "open"
  };
}

export function bufferProvisionalEvent(provisional, event) {
  if (provisional.state !== "open") throw bindingError("PROVISIONAL_CLOSED", "Provisional dispatch is not accepting events");
  if (event?.jobId !== provisional.jobId) throw bindingError("ROUND_MISMATCH", "Buffered event belongs to another round");
  const value = structuredClone(event);
  const bytes = Buffer.byteLength(JSON.stringify(value));
  if (provisional.events.length >= MAX_PROVISIONAL_EVENTS || provisional.bytes + bytes > MAX_PROVISIONAL_BYTES) {
    provisional.overflowed = true;
    provisional.state = "overflowed";
    throw bindingError("PROVISIONAL_BUFFER_OVERFLOW", "Provisional dispatch exceeded its event buffer");
  }
  provisional.events.push(value);
  provisional.bytes += bytes;
}

export async function bindProvisionalDispatch(provisional, threadId, { stateDir = stateDirFor(provisional.workspaceRoot) } = {}) {
  if (typeof threadId !== "string" || !threadId) throw new Error("threadId is required.");
  const events = beginBinding(provisional);
  const workspaceRoot = canonicalWorkspaceRoot(provisional.workspaceRoot);
  const hash = threadIndexHash(workspaceRoot, provisional.executorKey, threadId);
  const lockDirectory = path.join(stateDir, "thread-index-locks", hash);
  const lease = await acquireWriterWaiting(lockDirectory).catch((error) => resetBinding(provisional, error));
  try {
    const existing = await resolveThreadRecord(workspaceRoot, provisional.executorKey, threadId, { stateDir });
    if (existing) {
      const manifest = await readJson(existing.manifest);
      if (manifest?.activeRoundId && manifest.activeRoundId !== provisional.jobId) {
        throw bindingError("THREAD_BUSY", `THREAD_BUSY thread=${threadId} active_job=${manifest.activeRoundId}`);
      }
    }
    const recordId = existing?.recordId ?? provisional.jobId;
    const job = { ...structuredClone(provisional.job), recordId, roundId: provisional.jobId, threadId };
    const activeRoundId = events.some((event) => TERMINAL_EVENTS.has(event.type)) ? null : provisional.jobId;
    const result = await writeRound(provisional, {
      stateDir, recordId, threadId, activeRoundId, events, job
    });
    if (!existing) {
      await writeJson(threadIndexPath(stateDir, workspaceRoot, provisional.executorKey, threadId), {
        schemaVersion: 1, workspaceRoot, executorKey: provisional.executorKey, threadId, recordId
      });
    }
    await writeJobIndex(stateDir, provisional.jobId, recordId);
    provisional.state = "bound";
    provisional.recordId = recordId;
    return { recordId, roundId: provisional.jobId, ...result };
  } catch (error) {
    return resetBinding(provisional, error);
  } finally {
    await releaseWriter(lockDirectory, lease);
  }
}

export async function failProvisionalDispatch(provisional, terminalEvent, { stateDir = stateDirFor(provisional.workspaceRoot) } = {}) {
  if (!TERMINAL_EVENTS.has(terminalEvent?.type) || terminalEvent.jobId !== provisional.jobId) {
    throw bindingError("INVALID_TERMINAL_EVENT", "Failure before identity requires a terminal event for the provisional round");
  }
  const events = beginBinding(provisional, true);
  events.push(structuredClone(terminalEvent));
  try {
    const status = terminalEvent.type.slice(4);
    const job = { ...structuredClone(provisional.job), recordId: provisional.jobId, roundId: provisional.jobId,
      threadId: null, status, completedAt: terminalEvent.payload?.completedAt ?? new Date().toISOString() };
    const result = await writeRound(provisional, {
      stateDir, recordId: provisional.jobId, threadId: null, activeRoundId: null, events, job
    });
    await writeJobIndex(stateDir, provisional.jobId, provisional.jobId);
    provisional.state = "bound";
    provisional.recordId = provisional.jobId;
    return { recordId: provisional.jobId, roundId: provisional.jobId, ...result };
  } catch (error) {
    return resetBinding(provisional, error);
  }
}
