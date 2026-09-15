import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { resolveStateDir } from "./state.mjs";

const ACTIVE_STORES = new Map();
const HISTORY_ROOTS = new Map();
const TERMINAL = new Set(["completed", "failed", "cancelled"]);

function writerAlive(manifest) {
  if (manifest.closed || !Number.isInteger(manifest.writerPid)) return false;
  try { process.kill(manifest.writerPid, 0); return true; }
  catch (error) { return error.code !== "ESRCH"; }
}

async function acquireWriter(directory) {
  const lease = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
  const temporary = path.join(directory, `.writer-${process.pid}-${randomUUID()}.tmp`);
  const lock = path.join(directory, "writer.lock");
  await fs.writeFile(temporary, lease, { flag: "wx" });
  try {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        await fs.link(temporary, lock);
        return lease;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        let previous;
        try { previous = await fs.readFile(lock, "utf8"); }
        catch (readError) { if (readError.code === "ENOENT") continue; throw readError; }
        let owner;
        try { owner = JSON.parse(previous); } catch { throw historyError("STORE_BUSY", "History writer lock is unreadable"); }
        if (writerAlive({ writerPid: owner.pid })) throw historyError("STORE_BUSY", "History is owned by a live writer");
        try {
          if (await fs.readFile(lock, "utf8") === previous) await fs.unlink(lock);
        } catch (removeError) { if (removeError.code !== "ENOENT") throw removeError; }
      }
    }
    throw historyError("STORE_BUSY", "History writer lock changed concurrently");
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function releaseWriter(directory, lease) {
  const lock = path.join(directory, "writer.lock");
  try {
    if (await fs.readFile(lock, "utf8") === lease) await fs.unlink(lock);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
}

export function resolveHistoryDir(cwd, jobId) {
  if (!jobId || path.basename(jobId) !== jobId || jobId === "." || jobId === "..") {
    throw historyError("UNKNOWN_JOB", `Unknown job: ${jobId}`);
  }
  const key = `${process.env.CLAUDE_PLUGIN_DATA ?? ""}\0${path.resolve(cwd)}`;
  if (!HISTORY_ROOTS.has(key)) HISTORY_ROOTS.set(key, path.join(resolveStateDir(cwd), "job-history"));
  return path.join(HISTORY_ROOTS.get(key), jobId);
}

export function resolveLiveViewPath(cwd, jobId) {
  return path.join(resolveHistoryDir(cwd, jobId), "live-view.json");
}

function historyError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}

export function cursorFor(manifest, seq) {
  return Buffer.from(JSON.stringify({ protocolVersion: 1, jobId: manifest.jobId, streamId: manifest.streamId, lastAppliedSeq: String(seq) })).toString("base64url");
}

function parseCursor(manifest, cursor) {
  if (!cursor) return BigInt(manifest.earliestSeq) - 1n;
  let value;
  try {
    value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (value.protocolVersion !== 1 || value.jobId !== manifest.jobId || !/^(0|[1-9]\d*)$/.test(value.lastAppliedSeq)) throw new Error();
  } catch {
    throw historyError("INVALID_CURSOR", "Invalid history cursor");
  }
  if (value.streamId !== manifest.streamId) throw historyError("STREAM_REPLACED", "The job history stream has changed");
  const seq = BigInt(value.lastAppliedSeq);
  if (seq < BigInt(manifest.earliestSeq) - 1n) {
    throw historyError("CURSOR_EXPIRED", "Requested history has been removed by retention", {
      earliestAvailableCursor: cursorFor(manifest, BigInt(manifest.earliestSeq) - 1n),
      earliestSeq: manifest.earliestSeq
    });
  }
  if (seq > BigInt(manifest.committedSeq)) throw historyError("INVALID_CURSOR", "Cursor is ahead of committed history");
  return seq;
}

async function syncDirectory(directory) {
  const handle = await fs.open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function atomicJson(file, value) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, file);
  await syncDirectory(path.dirname(file));
}

async function loadManifest(directory) {
  try {
    return JSON.parse(await fs.readFile(path.join(directory, "manifest.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") throw historyError("UNKNOWN_JOB", `No event history at ${directory}`);
    throw error;
  }
}

function encodeBatch(events) {
  const data = JSON.stringify(events);
  return `${JSON.stringify({ events, sha256: createHash("sha256").update(data).digest("hex") })}\n`;
}

async function readSegment(directory, segment, afterSeq = -1n, limit = Infinity) {
  const handle = await fs.open(path.join(directory, "segments", segment.file), "r");
  const events = [];
  try {
    for (const block of segment.blocks ?? [{ offset: 0, bytes: segment.bytes, lastSeq: segment.lastSeq }]) {
      if (BigInt(block.lastSeq) <= afterSeq) continue;
      const bytes = Buffer.alloc(block.bytes);
      let offset = 0;
      while (offset < bytes.length) {
        const result = await handle.read(bytes, offset, bytes.length - offset, block.offset + offset);
        if (!result.bytesRead) throw historyError("HISTORY_CORRUPT", "Committed history segment is incomplete");
        offset += result.bytesRead;
      }
      for (const line of bytes.toString("utf8").split("\n")) {
        if (!line) continue;
        const batch = JSON.parse(line);
        if (createHash("sha256").update(JSON.stringify(batch.events)).digest("hex") !== batch.sha256) throw historyError("HISTORY_CORRUPT", "History checksum mismatch");
        for (const event of batch.events) {
          if (BigInt(event.seq) > afterSeq) events.push(event);
          if (events.length >= limit) return events;
        }
      }
    }
    return events;
  } finally {
    await handle.close();
  }
}

export async function readHistory(cwd, jobId, { after, limit = Infinity, stateDir } = {}) {
  const defaultDirectory = resolveHistoryDir(cwd, jobId);
  const directory = stateDir ? path.join(stateDir, "job-history", jobId) : defaultDirectory;
  // Retention publishes its new manifest before deleting old segments. Retry a
  // read crossing that boundary so callers receive CURSOR_EXPIRED, not ENOENT.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const manifest = await loadManifest(directory);
    const afterSeq = parseCursor(manifest, after);
    if (!(limit === Infinity || (Number.isInteger(limit) && limit > 0))) throw historyError("INVALID_LIMIT", "limit must be a positive integer");
    const events = [];
    try {
      for (const segment of manifest.segments) {
        if (BigInt(segment.lastSeq) <= afterSeq) continue;
        for (const event of await readSegment(directory, segment, afterSeq, limit - events.length)) {
          if (BigInt(event.seq) > afterSeq && BigInt(event.seq) <= BigInt(manifest.committedSeq)) events.push(event);
          if (events.length >= limit) break;
        }
        if (events.length >= limit) break;
      }
      return {
        events,
        nextCursor: cursorFor(manifest, events.at(-1)?.seq ?? afterSeq),
        committedSeq: manifest.committedSeq,
        earliestSeq: manifest.earliestSeq,
        streamId: manifest.streamId,
        continuity: manifest.continuity,
        metadata: manifest.metadata,
        closed: manifest.closed
      };
    } catch (error) {
      if (error.code !== "ENOENT" || attempt === 2) throw error;
    }
  }
}

export class JobEventStore {
  constructor(cwd, jobId, options = {}) {
    this.cwd = cwd;
    this.jobId = jobId;
    this.directory = resolveHistoryDir(cwd, jobId);
    this.options = {
      flushMs: 50,
      batchBytes: 262144,
      segmentBytes: 67108864,
      maxJobBytes: 1073741824,
      maxPendingEvents: 256,
      maxPendingBytes: 1048576,
      checkpointIntervalMs: 5000,
      ...options
    };
    this.pending = [];
    this.pendingBytes = 0;
    this.uncommittedCount = 0;
    this.uncommittedBytes = 0;
    this.chain = Promise.resolve();
    this.timer = null;
    this.failure = null;
    this.closed = false;
  }

  get snapshot() {
    return this.manifest ? structuredClone(this.manifest) : null;
  }

  async initialize(metadata = {}) {
    if (ACTIVE_STORES.has(this.directory)) throw historyError("STORE_BUSY", "History already has a writer");
    await fs.mkdir(path.join(this.directory, "segments"), { recursive: true });
    this.writerLease = await acquireWriter(this.directory);
    try { return await this.initializeLocked(metadata); }
    catch (error) { await releaseWriter(this.directory, this.writerLease); throw error; }
  }

  async initializeLocked(metadata) {
    try {
      this.manifest = await loadManifest(this.directory);
      if (!this.manifest.closed) this.manifest.continuity = "partial";
      for (const segment of this.manifest.segments) {
        await readSegment(this.directory, segment);
        await fs.truncate(path.join(this.directory, "segments", segment.file), segment.bytes);
      }
      const retained = new Set(this.manifest.segments.map((segment) => segment.file));
      for (const file of await fs.readdir(path.join(this.directory, "segments"))) {
        if (!retained.has(file)) await fs.rm(path.join(this.directory, "segments", file));
      }
    } catch (error) {
      if (error.code !== "UNKNOWN_JOB") throw error;
      this.manifest = {
        schemaVersion: 1, jobId: this.jobId, streamId: randomUUID(),
        earliestSeq: "1", committedSeq: "0", continuity: "complete",
        segments: [], nextSegment: 1, metadata: {}, createdAt: new Date().toISOString()
      };
    }
    this.checkpoint = this.manifest.checkpoint
      ? JSON.parse(await fs.readFile(path.join(this.directory, this.manifest.checkpoint.file), "utf8"))
      : null;
    for (const file of await fs.readdir(this.directory)) {
      if (file.startsWith("checkpoint-") && file !== this.manifest.checkpoint?.file) await fs.rm(path.join(this.directory, file));
      if (file.startsWith("manifest.json.") && file.endsWith(".tmp")) await fs.rm(path.join(this.directory, file));
    }
    this.manifest.metadata = { ...this.manifest.metadata, ...metadata };
    this.manifest.closed = false;
    this.manifest.writerPid = process.pid;
    this.nextSeq = BigInt(this.manifest.committedSeq) + 1n;
    await atomicJson(path.join(this.directory, "manifest.json"), this.manifest);
    ACTIVE_STORES.set(this.directory, this);
    return this;
  }

  append(event) {
    if (!this.manifest || this.closed) throw historyError("STORE_CLOSED", "History store is not open");
    if (this.failure) throw this.failure;
    const record = { ...structuredClone(event), schemaVersion: 1, streamId: this.manifest.streamId, jobId: this.jobId, seq: String(this.nextSeq) };
    const bytes = Buffer.byteLength(encodeBatch([record]));
    if (bytes > this.options.maxJobBytes) throw historyError("EVENT_TOO_LARGE", "One event exceeds the job history budget");
    if (this.uncommittedCount >= this.options.maxPendingEvents || (this.uncommittedCount && this.uncommittedBytes + bytes > this.options.maxPendingBytes)) {
      throw historyError("HISTORY_BACKPRESSURE", "Uncommitted history queue is full");
    }
    this.nextSeq += 1n;
    this.pending.push(record);
    this.pendingBytes += bytes;
    this.uncommittedCount += 1;
    this.uncommittedBytes += bytes;
    if (!this.timer) {
      this.timer = setTimeout(() => { this.flush().catch((error) => this.options.onError?.(error)); }, this.options.flushMs);
      this.timer.unref();
    }
    if (this.pendingBytes >= this.options.batchBytes) this.flush().catch((error) => this.options.onError?.(error));
    return record;
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    const events = this.pending;
    const bytes = this.pendingBytes;
    this.pending = [];
    this.pendingBytes = 0;
    this.chain = this.chain.then(async () => {
      if (this.failure) throw this.failure;
      let batch = [];
      let batchBytes = 0;
      for (const event of events) {
        const size = Buffer.byteLength(encodeBatch([event]));
        if (batch.length && batchBytes + size > Math.min(this.options.batchBytes, this.options.segmentBytes, this.options.maxJobBytes)) {
          await this.commitBatch(batch);
          batch = [];
          batchBytes = 0;
        }
        batch.push(event);
        batchBytes += size;
      }
      if (batch.length) await this.commitBatch(batch);
      this.uncommittedCount -= events.length;
      this.uncommittedBytes -= bytes;
    }).catch((error) => {
      this.failure = error;
      throw error;
    });
    return this.chain;
  }

  async commitBatch(events) {
    const encoded = encodeBatch(events);
    const bytes = Buffer.byteLength(encoded);
    const manifest = structuredClone(this.manifest);
    let segment = manifest.segments.at(-1);
    if (!segment || segment.bytes + bytes > Math.min(this.options.segmentBytes, this.options.maxJobBytes)) {
      segment = { file: `${String(manifest.nextSegment++).padStart(6, "0")}.events`, bytes: 0, firstSeq: events[0].seq, lastSeq: events.at(-1).seq, blocks: [] };
      manifest.segments.push(segment);
    }
    const handle = await fs.open(path.join(this.directory, "segments", segment.file), "a");
    try {
      await handle.writeFile(encoded);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(path.join(this.directory, "segments"));
    segment.blocks.push({ offset: segment.bytes, bytes, firstSeq: events[0].seq, lastSeq: events.at(-1).seq });
    segment.bytes += bytes;
    segment.lastSeq = events.at(-1).seq;
    manifest.committedSeq = events.at(-1).seq;
    manifest.updatedAt = new Date().toISOString();
    const removed = [];
    let total = manifest.segments.reduce((sum, value) => sum + value.bytes, 0);
    while (total > this.options.maxJobBytes && manifest.segments.length > 1) {
      const first = manifest.segments.shift();
      removed.push(first);
      total -= first.bytes;
      manifest.continuity = "partial";
    }
    manifest.earliestSeq = manifest.segments[0]?.firstSeq ?? String(BigInt(manifest.committedSeq) + 1n);
    const checkpoint = await this.prepareCheckpoint(events, manifest, removed.length > 0);
    await atomicJson(path.join(this.directory, "manifest.json"), manifest);
    const oldCheckpoint = this.manifest.checkpoint;
    this.manifest = manifest;
    if (checkpoint) this.checkpoint = checkpoint;
    if (oldCheckpoint && oldCheckpoint.file !== manifest.checkpoint?.file) await fs.rm(path.join(this.directory, oldCheckpoint.file), { force: true });
    for (const old of removed) await fs.rm(path.join(this.directory, "segments", old.file), { force: true });
    await this.options.onCommit?.(events, this.snapshot);
  }

  async prepareCheckpoint(events, manifest, force = false) {
    if (!this.options.createCheckpoint) return null;
    const terminalEvent = events.some((event) => ["job.completed", "job.failed", "job.cancelled"].includes(event.type));
    if (!force && manifest.checkpoint && !terminalEvent && Date.now() - manifest.checkpoint.savedAt < this.options.checkpointIntervalMs) return null;
    const checkpoint = await this.options.createCheckpoint(events, structuredClone(manifest));
    if (!checkpoint) throw historyError("CHECKPOINT_FAILED", "Projection checkpoint callback returned no snapshot");
    const file = `checkpoint-${manifest.committedSeq}-${randomUUID()}.json`;
    await atomicJson(path.join(this.directory, file), checkpoint);
    manifest.checkpoint = { file, appliedThroughSeq: manifest.committedSeq, savedAt: Date.now() };
    return checkpoint;
  }

  async pruneToBytes(maxBytes) {
    await this.flush();
    this.chain = this.chain.then(async () => {
      const manifest = structuredClone(this.manifest);
      const removed = [];
      let total = manifest.segments.reduce((sum, segment) => sum + segment.bytes, 0);
      while (total > maxBytes && manifest.segments.length > 1) {
        const segment = manifest.segments.shift();
        removed.push(segment);
        total -= segment.bytes;
      }
      if (!removed.length) return 0;
      manifest.earliestSeq = manifest.segments[0].firstSeq;
      manifest.continuity = "partial";
      const checkpoint = await this.prepareCheckpoint([], manifest, true);
      await atomicJson(path.join(this.directory, "manifest.json"), manifest);
      const oldCheckpoint = this.manifest.checkpoint;
      this.manifest = manifest;
      if (checkpoint) this.checkpoint = checkpoint;
      if (oldCheckpoint && oldCheckpoint.file !== manifest.checkpoint?.file) await fs.rm(path.join(this.directory, oldCheckpoint.file), { force: true });
      for (const segment of removed) await fs.rm(path.join(this.directory, "segments", segment.file), { force: true });
      await this.options.onRetention?.(this.snapshot);
      return removed.reduce((sum, segment) => sum + segment.bytes, 0);
    });
    return this.chain;
  }

  async updateMetadata(metadata) {
    await this.flush();
    this.chain = this.chain.then(async () => {
      this.manifest.metadata = { ...this.manifest.metadata, ...metadata };
      await atomicJson(path.join(this.directory, "manifest.json"), this.manifest);
    });
    return this.chain;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    try {
      await this.flush();
      this.manifest.closed = true;
      this.manifest.writerPid = null;
      await atomicJson(path.join(this.directory, "manifest.json"), this.manifest);
    } finally {
      ACTIVE_STORES.delete(this.directory);
      await releaseWriter(this.directory, this.writerLease);
    }
  }
}

async function directoryBytes(directory) {
  let total = 0;
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return 0; throw error; }
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    try {
      if (entry.isDirectory()) total += await directoryBytes(file);
      else if (entry.isFile()) total += (await fs.stat(file)).size;
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return total;
}

async function retireHistory(directory, current, now) {
  let previousView;
  try { previousView = JSON.parse(await fs.readFile(path.join(directory, "live-view.json"), "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const original = current.metadata.job ?? {};
  const job = {};
  for (const field of ["id", "label", "title", "status", "workspaceRoot", "sessionId", "createdAt", "startedAt", "completedAt", "threadId", "turnId"]) {
    if (original[field] !== undefined) job[field] = original[field];
  }
  job.id ??= current.jobId;
  job.status ??= current.metadata.status ?? previousView?.status;
  const tombstone = {
    schemaVersion: 1, jobId: current.jobId, streamId: current.streamId,
    committedSeq: current.committedSeq, earliestSeq: String(BigInt(current.committedSeq) + 1n),
    segments: [], continuity: "partial", tombstone: true, purged: false,
    closed: true, writerPid: null, createdAt: current.createdAt,
    updatedAt: current.updatedAt, retiredAt: current.retiredAt ?? new Date(now).toISOString(),
    metadata: { job, status: job.status, completedAt: current.metadata.completedAt ?? job.completedAt }
  };
  // Publish the expiration boundary before deleting payloads, so concurrent
  // readers retry against CURSOR_EXPIRED instead of seeing an unknown job.
  await atomicJson(path.join(directory, "manifest.json"), tombstone);
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (["manifest.json", "live-view.json", "writer.lock"].includes(entry.name) || entry.name.startsWith(".writer-")) continue;
    await fs.rm(path.join(directory, entry.name), { recursive: true, force: true });
  }
  const usage = previousView?.usage ?? {};
  await atomicJson(path.join(directory, "live-view.json"), {
    schemaVersion: 1, jobId: current.jobId, label: previousView?.label ?? job.label ?? job.title ?? current.jobId,
    status: job.status, startedAt: previousView?.startedAt ?? job.startedAt ?? null,
    endedAt: previousView?.endedAt ?? job.completedAt ?? current.metadata.completedAt ?? null,
    threadId: previousView?.threadId ?? job.threadId ?? null, turnId: previousView?.turnId ?? job.turnId ?? null,
    activeCommands: [], lastMessage: null, files: [],
    usage: { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0, cachedInputTokens: usage.cachedInputTokens ?? 0, complete: usage.complete ?? false },
    pendingQuestion: null, history: { committedSeq: current.committedSeq, continuity: "partial" }, tail: []
  });
  tombstone.purged = true;
  await atomicJson(path.join(directory, "manifest.json"), tombstone);
}

export async function cleanupHistory(cwd, { maxTotalBytes = 20 * 1024 ** 3, retentionDays = 30, now = Date.now() } = {}) {
  const root = path.dirname(resolveStateDir(cwd));
  const histories = [];
  let workspaces;
  try { workspaces = await fs.readdir(root, { withFileTypes: true }); } catch (error) { if (error.code === "ENOENT") return { removed: [], bytes: 0 }; throw error; }
  for (const workspace of workspaces.filter((entry) => entry.isDirectory())) {
    const parent = path.join(root, workspace.name, "job-history");
    let jobs;
    try { jobs = await fs.readdir(parent, { withFileTypes: true }); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    for (const job of jobs.filter((entry) => entry.isDirectory())) {
      const directory = path.join(parent, job.name);
      try {
        const manifest = await loadManifest(directory);
        histories.push({ directory, manifest, bytes: await directoryBytes(directory) });
      } catch (error) {
        if (!["ENOENT", "UNKNOWN_JOB"].includes(error.code)) throw error;
      }
    }
  }
  for (const entry of histories.filter((history) => history.manifest.tombstone && !history.manifest.purged)) {
    let lease;
    try {
      lease = await acquireWriter(entry.directory);
      const current = await loadManifest(entry.directory);
      if (current.tombstone && !current.purged) await retireHistory(entry.directory, current, now);
      entry.bytes = await directoryBytes(entry.directory);
    } catch (error) {
      if (!["STORE_BUSY", "ENOENT", "UNKNOWN_JOB"].includes(error.code)) throw error;
    } finally {
      if (lease) await releaseWriter(entry.directory, lease);
    }
  }
  let bytes = histories.reduce((sum, entry) => sum + entry.bytes, 0);
  const removed = [];
  const completed = histories.filter((entry) => !entry.manifest.tombstone && TERMINAL.has(entry.manifest.metadata.status ?? entry.manifest.metadata.job?.status) && !writerAlive(entry.manifest) && !ACTIVE_STORES.has(entry.directory));
  completed.sort((a, b) => String(a.manifest.metadata.completedAt ?? a.manifest.metadata.job?.completedAt ?? a.manifest.updatedAt).localeCompare(String(b.manifest.metadata.completedAt ?? b.manifest.metadata.job?.completedAt ?? b.manifest.updatedAt)));
  for (const entry of completed) {
    const ended = Date.parse(entry.manifest.metadata.completedAt ?? entry.manifest.metadata.endedAt ?? entry.manifest.metadata.job?.completedAt ?? entry.manifest.updatedAt);
    if (bytes <= maxTotalBytes && now - ended < retentionDays * 86400000) continue;
    let lease;
    try {
      lease = await acquireWriter(entry.directory);
      const current = await loadManifest(entry.directory);
      if (current.tombstone || !TERMINAL.has(current.metadata.status ?? current.metadata.job?.status)) continue;
      await retireHistory(entry.directory, current, now);
      bytes -= entry.bytes - await directoryBytes(entry.directory);
      removed.push(entry.manifest.jobId);
    } catch (error) {
      if (!["STORE_BUSY", "ENOENT", "UNKNOWN_JOB"].includes(error.code)) throw error;
    } finally {
      if (lease) await releaseWriter(entry.directory, lease);
    }
  }
  // Each broker only mutates its own running stores. Other brokers apply the
  // same check on their next sweep; never race an external writer's manifest.
  const active = histories.filter((entry) => ACTIVE_STORES.has(entry.directory)).sort((a, b) => b.bytes - a.bytes);
  for (const entry of active) {
    if (bytes <= maxTotalBytes) break;
    const store = ACTIVE_STORES.get(entry.directory);
    const saved = await store.pruneToBytes(Math.max(0, entry.bytes - (bytes - maxTotalBytes)));
    bytes -= saved;
  }
  return { removed, bytes, overBudget: bytes > maxTotalBytes };
}
