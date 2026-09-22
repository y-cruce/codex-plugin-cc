import fs from "node:fs/promises";
import path from "node:path";
import { JobEventStore, readHistory, readRecordHistory, resolveLiveViewPath, cursorFor, cleanupHistory, historyHasTerminalEvent } from "./job-event-store.mjs";
import { createCanonicalEvent } from "./executor-events.mjs";
import { createLiveView, applyJobEvent, jobConfig } from "./job-event-model.mjs";
import { readStoredJob, ownerProcessAlive } from "./job-control.mjs";
import { stateDirFor } from "./history-resolver.mjs";
import { resolveStateDir } from "./state.mjs";
import { bindProvisionalDispatch, bufferProvisionalEvent, createProvisionalDispatch, failProvisionalDispatch,
  MAX_PROVISIONAL_BYTES, MAX_PROVISIONAL_EVENTS, updateRoundReceipt } from "./thread-record-binding.mjs";
import { THREAD_RECORDS_ENABLED } from "./thread-records.mjs";

const terminal = (status) => ["completed", "failed", "cancelled"].includes(status);
const immediateEvents = new Set(["control.message.updated", "question.opened", "question.resolved", "question.closed", "director.notified",
  "job.completed", "job.failed", "job.cancelled"]);
const TERMINAL_EVENTS = new Set(["job.completed", "job.failed", "job.cancelled"]);

function roundPrompt(job) {
  const prompt = job.request?.prompt;
  if (typeof prompt !== "string" || !prompt.trim()) return null;
  const marker = prompt.lastIndexOf("---- Brief ----");
  return (marker < 0 ? prompt : prompt.slice(marker + "---- Brief ----".length)).trim() || null;
}

function jobEvent(job, type, threadRecord = false) {
  const completedAt = job.completedAt ?? new Date().toISOString();
  const status = type.slice(4);
  const errorMessage = job.errorMessage ?? job.result?.error?.message ?? null;
  const terminal = job.result?.terminal ?? null;
  return createCanonicalEvent({
    job,
    type,
    identity: { sessionId: job.executorSessionId ?? job.threadId ?? null, turnId: job.turnId ?? null },
    occurredAt: type === "job.started" ? job.startedAt ?? job.createdAt : completedAt,
    payload: type === "job.started"
      ? { label: job.label ?? job.title ?? job.id, startedAt: job.startedAt ?? job.createdAt ?? completedAt,
        ...(threadRecord ? { sessionId: job.sessionId ?? null, prompt: roundPrompt(job), resumed: Boolean(job.request?.resumeThreadId) } : {}) }
      : { status, reason: terminal?.reason ?? { code: status === "cancelled" ? "cancelled" : status === "completed" ? "end_turn" : "backend_error",
        backendCode: status, message: errorMessage, retryable: false }, completedAt, finalMessages: terminal?.finalMessages ?? [],
        error: errorMessage ? { message: errorMessage } : null, ...(threadRecord ? { result: job.result ?? null } : {}) },
    source: { protocol: "local", method: type, raw: null }
  });
}

export class JobRuntime {
  constructor(options = {}) {
    this.jobs = new Map();
    this.owners = new Map();
    this.followers = new Map();
    this.onTerminal = options.onTerminal ?? null;
    this.threadRecords = options.threadRecords ?? THREAD_RECORDS_ENABLED;
    this.executorIdentity = options.executorIdentity ?? null;
    this.reconciling = false;
    this.historySweepMs = options.historySweepMs ?? 60000;
    this.historyCwds = new Set();
    this.historySweep = null;
    this.historyTimer = null;
    this.timer = setInterval(() => this.reconcile().catch((error) => this.diagnostic(error)), 1000);
    this.timer.unref();
    this.cleaner = setInterval(() => this.cleanup().catch((error) => this.diagnostic(error)), 300000);
    this.cleaner.unref();
  }

  diagnostic(error) { process.stderr.write(`Observation: ${error.message}\n`); }

  async start(cwd) {
    this.historyCwds.add(path.resolve(cwd));
    await this.sweepHistory();
    if (this.historySweepMs > 0 && !this.historyTimer) {
      this.historyTimer = setInterval(() => this.sweepHistory().catch((error) => this.diagnostic(error)), this.historySweepMs);
      this.historyTimer.unref();
    }
  }

  async sweepHistory() {
    if (this.historySweep) return this.historySweep;
    this.historySweep = (async () => {
      for (const cwd of this.historyCwds) await this.reconcileHistory(cwd);
    })().finally(() => { this.historySweep = null; });
    return this.historySweep;
  }

  async reconcileHistory(cwd) {
    const root = path.join(resolveStateDir(cwd), "job-history");
    let histories;
    try { histories = await fs.readdir(root, { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    for (const history of histories) {
      if (!history.isDirectory()) continue;
      const jobId = history.name;
      const stored = readStoredJob(cwd, jobId);
      if (stored && ownerProcessAlive(stored.pid) !== false) continue;
      let hasTerminal;
      try { hasTerminal = await historyHasTerminalEvent(cwd, jobId); }
      catch (error) { if (["ENOENT", "UNKNOWN_JOB"].includes(error.code)) continue; throw error; }
      if (hasTerminal) continue;
      let historical;
      try { historical = await readHistory(cwd, jobId, { limit: 1 }); }
      catch (error) { if (["ENOENT", "UNKNOWN_JOB"].includes(error.code)) continue; throw error; }
      const job = stored ?? historical.metadata?.job ?? { id: jobId, workspaceRoot: cwd, status: "running" };
      const key = `${job.workspaceRoot ?? cwd}\0${job.id}`;
      const openedForSweep = !this.jobs.has(key);
      let entry;
      try {
        entry = await this.openEntry(cwd, jobId, job, false);
      } catch (error) {
        if (["STORE_BUSY", "ENOENT", "UNKNOWN_JOB"].includes(error.code)) continue;
        throw error;
      }
      try {
        if (await historyHasTerminalEvent(cwd, jobId)) continue;
        await this.failOwnerExited(entry, job);
      } finally {
        if (openedForSweep) {
          this.jobs.delete(entry.key);
          await entry.store.close();
        }
      }
    }
  }

  async openEntry(cwd, jobId, job, appendStarted = true) {
    const key = `${job.workspaceRoot ?? cwd}\0${job.id}`;
    let entry = this.jobs.get(key);
    if (entry) return entry;
    entry = { key, cwd: job.workspaceRoot ?? cwd, job, view: createLiveView(job), writeTail: Promise.resolve(), viewTimer: null,
      lastViewAt: 0, ended: false, failure: null };
    entry.store = new JobEventStore(entry.cwd, jobId, {
      createCheckpoint: (events, snapshot) => {
        const view = structuredClone(entry.view);
        for (const event of events) applyJobEvent(view, event);
        view.history.committedSeq = snapshot.committedSeq;
        view.history.continuity = snapshot.continuity;
        return view;
      },
      onRetention: (snapshot) => {
        entry.view.history.continuity = snapshot.continuity;
        entry.view.history.earliestSeq = snapshot.earliestSeq;
        this.scheduleView(entry);
      },
      onError: (error) => {
        entry.failure = error.message;
        entry.view.history.continuity = "partial";
        this.scheduleView(entry);
        this.diagnostic(error);
      },
      onCommit: async (events, snapshot) => {
        for (const event of events) applyJobEvent(entry.view, event, {
          onDiagnostic: (message) => this.diagnostic(new Error(message))
        });
        entry.view.history.committedSeq = snapshot.committedSeq;
        if (snapshot.continuity === "partial") entry.view.history.continuity = "partial";
        if (!events.some((event) => event.type.startsWith("job.") && terminal(entry.view.status))) this.scheduleView(entry);
        const segment = snapshot.segments.at(-1)?.file;
        if (entry.lastSegment && entry.lastSegment !== segment) setImmediate(() => this.cleanup().catch((error) => this.diagnostic(error)));
        entry.lastSegment = segment;
        for (const follower of this.followers.values()) if (follower.entry === entry) this.wake(follower);
      },
      retainedCursors: () => [...this.followers.values()]
        .filter((follower) => follower.entry === entry && !follower.closed)
        .map((follower) => follower.after ?? follower.retentionCursor)
    });
    await entry.store.initialize({ job });
    entry.jobFile = path.join(path.dirname(path.dirname(entry.store.directory)), "jobs", `${jobId}.json`);
    const previous = entry.store.checkpoint;
    if (previous) entry.view = previous;
    entry.view.history.continuity = entry.store.snapshot.continuity;
    let after = previous ? cursorFor(entry.store.snapshot, previous.history.committedSeq) : undefined;
    do {
      const history = await readHistory(entry.cwd, jobId, { after, limit: 256 });
      for (const event of history.events) {
        if (BigInt(event.seq) > BigInt(entry.view.history.committedSeq ?? "0")) applyJobEvent(entry.view, event);
      }
      after = history.nextCursor;
      if (history.caughtUp === true || (history.caughtUp === undefined &&
        (!history.events.length || history.events.at(-1).seq === history.committedSeq))) break;
    } while (true);
    this.jobs.set(key, entry);
    if (appendStarted && entry.store.snapshot.committedSeq === "0") {
      await this.append(entry, jobEvent(job, "job.started"));
      await entry.store.flush();
    }
    clearTimeout(entry.viewTimer);
    entry.viewTimer = null;
    await this.writeView(entry);
    return entry;
  }

  async persistRound(entry) {
    const round = entry.view.rounds?.find((value) => value.jobId === entry.job.id);
    if (round && entry.location?.roundReceipt) await updateRoundReceipt(entry.location, round, entry.job);
  }

  terminalJob(entry, event) {
    const errorMessage = event.payload?.error?.message ?? event.payload?.reason?.message ?? null;
    return { ...entry.job, status: event.type.slice(4), completedAt: event.payload?.completedAt ?? event.occurredAt,
      ...(event.payload?.result !== undefined ? { result: event.payload.result } : {}),
      ...(errorMessage ? { errorMessage } : {}) };
  }

  async finalize(entry) {
    if (entry.ended) return false;
    if (entry.finalizing) return entry.finalizing;
    entry.finalizing = (async () => {
      await entry.store.flush();
      if (this.threadRecords) {
        await entry.store.updateManifest({ activeRoundId: null });
        await this.persistRound(entry);
      } else await entry.store.updateMetadata({ job: entry.job, status: entry.job.status, completedAt: entry.job.completedAt });
      clearTimeout(entry.viewTimer);
      entry.viewTimer = null;
      await this.writeView(entry);
      if (this.threadRecords) {
        await entry.store.close();
        entry.store = null;
      }
      entry.ended = true;
      this.onTerminal?.(entry.job);
      this.cleanup().catch((error) => this.diagnostic(error));
      return true;
    })();
    try { return await entry.finalizing; }
    finally { entry.finalizing = null; }
  }

  async noteRoundTurn(entry, turnId) {
    if (!turnId) return;
    entry.view.turnId = turnId;
    const round = entry.view.rounds?.find((value) => value.jobId === entry.job.id);
    if (round && !round.executorTurnIds.includes(turnId)) round.executorTurnIds.push(turnId);
    await this.persistRound(entry);
  }

  async openThreadEntry(entry, binding) {
    entry.recordId = binding.recordId;
    entry.location = binding.location;
    entry.receipt = binding.receipt;
    entry.view = createLiveView(entry.job, { recordId: binding.recordId });
    entry.store = new JobEventStore(entry.cwd, binding.recordId, {
      directory: binding.location.directory,
      threadRecord: { recordId: binding.recordId, workspaceRoot: entry.provisional.workspaceRoot,
        executorKey: entry.provisional.executorKey, threadId: entry.job.threadId },
      createCheckpoint: (events, snapshot) => {
        const view = structuredClone(entry.view);
        for (const event of events) applyJobEvent(view, event);
        view.history.committedSeq = snapshot.committedSeq;
        view.history.continuity = snapshot.continuity;
        return view;
      },
      onRetention: (snapshot) => {
        entry.view.history.continuity = snapshot.continuity;
        entry.view.history.earliestSeq = snapshot.earliestSeq;
        this.scheduleView(entry);
      },
      onError: (error) => {
        entry.failure = error.message;
        entry.view.history.continuity = "partial";
        this.scheduleView(entry);
        this.diagnostic(error);
      },
      onCommit: async (events, snapshot) => {
        for (const event of events) applyJobEvent(entry.view, event, {
          onDiagnostic: (message) => this.diagnostic(new Error(message))
        });
        entry.view.history.committedSeq = snapshot.committedSeq;
        if (snapshot.continuity === "partial") entry.view.history.continuity = "partial";
        await this.persistRound(entry);
        if (!events.some((event) => event.type.startsWith("job.") && terminal(entry.view.status))) this.scheduleView(entry);
        for (const follower of this.followers.values()) if (follower.entry === entry) this.wake(follower);
      },
      retainedCursors: () => [...this.followers.values()]
        .filter((follower) => follower.entry === entry && !follower.closed)
        .map((follower) => follower.after ?? follower.retentionCursor)
    });
    await entry.store.initialize({ recordId: binding.recordId });
    const previous = entry.store.checkpoint;
    if (previous?.recordId === binding.recordId) entry.view = previous;
    entry.view.history.continuity = entry.store.snapshot.continuity;
    let after = previous?.recordId === binding.recordId ? cursorFor(entry.store.snapshot, previous.history.committedSeq) : undefined;
    do {
      const history = await readRecordHistory(entry.cwd, binding.recordId, { after, limit: 256 });
      for (const event of history.events) {
        if (BigInt(event.seq) > BigInt(entry.view.history.committedSeq ?? "0")) applyJobEvent(entry.view, event);
      }
      after = history.nextCursor;
      if (history.caughtUp === true || (history.caughtUp === undefined &&
        (!history.events.length || history.events.at(-1).seq === history.committedSeq))) break;
    } while (true);
    await this.persistRound(entry);
    clearTimeout(entry.viewTimer);
    entry.viewTimer = null;
    await this.writeView(entry);
    entry.bound = true;
    return entry;
  }

  queueBindingEvent(entry, event) {
    const value = structuredClone(event);
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (entry.bindingEvents.length >= MAX_PROVISIONAL_EVENTS || entry.bindingBytes + bytes > MAX_PROVISIONAL_BYTES) {
      throw Object.assign(new Error("Provisional dispatch exceeded its bind-window event buffer"), { code: "PROVISIONAL_BUFFER_OVERFLOW" });
    }
    entry.bindingEvents.push(value);
    entry.bindingBytes += bytes;
  }

  async register(socket, cwd, jobId) {
    const job = readStoredJob(cwd, jobId);
    if (!job) throw Object.assign(new Error(`UNKNOWN_JOB ${jobId}`), { code: "UNKNOWN_JOB" });
    if (this.threadRecords) {
      const key = `${job.workspaceRoot}\0${job.id}`;
      let entry = this.jobs.get(key);
      if (!entry) {
        entry = { key, cwd: job.workspaceRoot ?? cwd, job, provisional: createProvisionalDispatch({
          workspaceRoot: job.workspaceRoot ?? cwd, job, executor: this.executorIdentity ?? {}
        }), view: createLiveView(job, { recordId: job.id }), writeTail: Promise.resolve(), viewTimer: null,
        lastViewAt: 0, ended: false, failure: null, bound: false, store: null };
        entry.binding = false;
        entry.bindingEvents = [];
        entry.bindingBytes = 0;
        entry.jobFile = path.join(stateDirFor(entry.cwd), "jobs", `${jobId}.json`);
        bufferProvisionalEvent(entry.provisional, jobEvent(job, "job.started", true));
        this.jobs.set(key, entry);
      }
      this.owners.set(socket, entry);
      return { historyAvailable: false, jobId, streamId: null };
    }
    const key = `${job.workspaceRoot}\0${job.id}`;
    let entry = this.jobs.get(key);
    if (!entry) {
      entry = await this.openEntry(cwd, jobId, job);
      this.cleanup().catch((error) => this.diagnostic(error));
    }
    this.owners.set(socket, entry);
    return { historyAvailable: true, jobId, streamId: entry.store.snapshot.streamId };
  }

  async bind(socket, cwd, jobId, threadId, turnId = null, expectedRecordId = null) {
    if (!this.threadRecords) return { bound: false, jobId };
    const entry = this.owners.get(socket) ?? [...this.jobs.values()].find((item) => item.cwd === cwd && item.job.id === jobId);
    if (!entry || entry.job.id !== jobId) throw Object.assign(new Error(`UNKNOWN_JOB ${jobId}`), { code: "UNKNOWN_JOB" });
    entry.job = { ...entry.job, threadId, executorSessionId: threadId, ...(turnId ? { turnId } : {}) };
    entry.provisional.job = structuredClone(entry.job);
    if (entry.bound) {
      await this.noteRoundTurn(entry, turnId);
      return { bound: true, jobId, recordId: entry.recordId };
    }
    entry.binding = true;
    try {
      const binding = await bindProvisionalDispatch(entry.provisional, threadId, { expectedRecordId });
      await this.openThreadEntry(entry, binding);
      await this.noteRoundTurn(entry, turnId);
      const queued = entry.bindingEvents;
      entry.bindingEvents = [];
      entry.bindingBytes = 0;
      const terminalEvent = queued.findLast((event) => TERMINAL_EVENTS.has(event.type));
      if (terminalEvent) entry.job = this.terminalJob(entry, terminalEvent);
      for (const event of queued) await this.append(entry, event);
      if (terminalEvent) {
        entry.terminalRecorded = true;
        await this.finalize(entry);
      } else if (queued.some((event) => immediateEvents.has(event.type))) await entry.store.flush();
    } finally {
      entry.binding = false;
    }
    return { bound: true, jobId, recordId: entry.recordId };
  }

  jobForSocket(socket) {
    return this.owners.get(socket)?.job ?? null;
  }

  jobForId(cwd, jobId) {
    const entry = [...this.jobs.values()].find((item) => item.cwd === cwd && item.job.id === jobId);
    return entry ? readStoredJob(cwd, jobId) ?? entry.job : null;
  }

  async record(event) {
    const entry = [...this.jobs.values()].find((item) => item.job.id === event.jobId);
    if (!entry) return false;
    if (entry.ended && TERMINAL_EVENTS.has(event.type)) return true;
    if (this.threadRecords && entry.binding) {
      this.queueBindingEvent(entry, event);
      return true;
    }
    if (this.threadRecords && !entry.bound) {
      if (TERMINAL_EVENTS.has(event.type)) return true;
      bufferProvisionalEvent(entry.provisional, event);
      return true;
    }
    if (this.threadRecords && TERMINAL_EVENTS.has(event.type)) entry.job = this.terminalJob(entry, event);
    await this.append(entry, event);
    if (this.threadRecords && TERMINAL_EVENTS.has(event.type)) {
      entry.terminalRecorded = true;
      await this.finalize(entry);
    } else if (immediateEvents.has(event.type)) await entry.store.flush();
    return true;
  }

  async append(entry, event) {
    if (entry.failure) return;
    try {
      try { entry.store.append(event); }
      catch (error) {
        if (error.code !== "HISTORY_BACKPRESSURE") throw error;
        await entry.store.flush();
        entry.store.append(event);
      }
    }
    catch (error) {
      entry.failure = error.message;
      entry.view.history.continuity = "partial";
      this.scheduleView(entry);
      this.diagnostic(error);
    }
  }

  scheduleView(entry, immediate = false) {
    if (entry.viewTimer) {
      if (!immediate) return;
      clearTimeout(entry.viewTimer);
    }
    const wait = immediate ? 0 : Math.max(0, 200 - (Date.now() - entry.lastViewAt));
    entry.viewTimer = setTimeout(() => {
      entry.viewTimer = null;
      this.writeView(entry).catch((error) => this.diagnostic(error));
    }, wait);
  }

  writeView(entry) {
    const content = `${JSON.stringify(entry.view)}\n`;
    entry.writeTail = entry.writeTail.catch(() => {}).then(async () => {
      const file = entry.location?.liveView ?? resolveLiveViewPath(entry.cwd, entry.job.id);
      await fs.mkdir(path.dirname(file), { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      await fs.writeFile(temporary, content, "utf8");
      await fs.rename(temporary, file);
      entry.lastViewAt = Date.now();
    });
    return entry.writeTail;
  }

  async finish(cwd, jobId) {
    const entry = [...this.jobs.values()].find((item) => item.job.id === jobId && item.cwd === cwd);
    if (!entry) return { recorded: false };
    const job = await fs.readFile(entry.jobFile, "utf8").then(JSON.parse).catch(() => null);
    if (!job || !terminal(job.status)) return { recorded: entry.ended };
    entry.job = this.threadRecords ? { ...job, recordId: entry.recordId, roundId: job.id,
      threadId: entry.job.threadId ?? job.threadId ?? null } : job;
    // A round finalizes on its executor's terminal event, and only afterwards
    // does the runner write `result` and `rendered` into the job file -- so the
    // receipt this leaves behind holds a job captured mid-flight. Returning
    // here left it that way for good, and `result`, which reads the receipt,
    // answered "no captured result payload" for every ACP round while the
    // answer sat in the job file. Codex never showed it: its terminal event
    // carries the payload, so its receipt is right the first time.
    if (entry.ended) {
      if (this.threadRecords) await this.persistRound(entry);
      return { recorded: true };
    }
    if (this.threadRecords && !entry.bound) {
      const binding = await failProvisionalDispatch(entry.provisional, jobEvent(job, `job.${job.status}`, true));
      entry.job = { ...job, recordId: binding.recordId, roundId: job.id, threadId: null };
      await this.openThreadEntry(entry, binding);
      entry.terminalRecorded = true;
    } else if (!this.threadRecords || !entry.terminalRecorded) {
      await this.append(entry, jobEvent(entry.job, `job.${job.status}`, this.threadRecords));
      if (this.threadRecords) entry.terminalRecorded = true;
    }
    await this.finalize(entry);
    return { recorded: true };
  }

  async reconcile() {
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      for (const entry of this.jobs.values()) {
        if (entry.ended) continue;
        const job = await fs.readFile(entry.jobFile, "utf8").then(JSON.parse).catch(() => null);
        if (job && terminal(job.status)) await this.finish(entry.cwd, entry.job.id);
        else if (job && ownerProcessAlive(job.pid) === false) {
          await this.failOwnerExited(entry, job);
        } else if (job) this.syncConfig(entry, job);
      }
    } finally { this.reconciling = false; }
  }

  // An ACP session settles the reasoning effort with its agent after the view
  // was made, so the record knows the rung that took effect before the view
  // does: the tick reads that record already, and the pane was showing the
  // requested rung until the agent answered for it.
  syncConfig(entry, job) {
    const config = jobConfig(job);
    if (config.model === (entry.view.model ?? null) && config.effort === (entry.view.effort ?? null)) return;
    Object.assign(entry.view, config);
    this.scheduleView(entry);
  }

  async failOwnerExited(entry, job) {
    entry.job = { ...job, status: "failed", errorMessage: "owner process exited", completedAt: new Date().toISOString() };
    if (this.threadRecords && !entry.bound) {
      const binding = await failProvisionalDispatch(entry.provisional, jobEvent(entry.job, "job.failed", true));
      entry.job = { ...entry.job, recordId: binding.recordId, roundId: entry.job.id, threadId: null };
      await this.openThreadEntry(entry, binding);
      entry.terminalRecorded = true;
    } else {
      await this.append(entry, jobEvent(entry.job, "job.failed", this.threadRecords));
      if (this.threadRecords) entry.terminalRecorded = true;
    }
    await this.finalize(entry);
  }

  async follow(socket, cwd, jobId, after) {
    const entry = [...this.jobs.values()].find((item) => item.job.id === jobId && item.cwd === cwd);
    if (!entry) throw Object.assign(new Error("OBSERVATION_UNSUPPORTED: job is not owned by this broker"), { code: "OBSERVATION_UNSUPPORTED" });
    const page = await readHistory(cwd, jobId, { after, limit: 1 });
    const retentionCursor = after ?? cursorFor(page.recordId
      ? { recordId: page.recordId, streamId: page.streamId }
      : { jobId, streamId: page.streamId }, BigInt(page.earliestSeq) - 1n);
    const follower = { socket, entry, after, retentionCursor, pumping: false, dirty: false, closed: false };
    this.followers.set(socket, follower);
    return { jobId, streamId: page.streamId, committedSeq: page.committedSeq };
  }

  wake(follower) {
    follower.dirty = true;
    if (follower.pumping || follower.closed) return;
    follower.pumping = true;
    this.pump(follower).catch((error) => {
      if (!follower.socket.destroyed) follower.socket.end(`${JSON.stringify({ method: "broker/observation-error", params: {
        code: error.code ?? "OBSERVATION_FAILED", message: error.message, earliestAvailableCursor: error.earliestAvailableCursor
      } })}\n`);
    }).finally(() => {
      follower.pumping = false;
      if (follower.dirty && !follower.closed) this.wake(follower);
    });
  }

  async pump(follower) {
    while (!follower.closed) {
      follower.dirty = false;
      const page = await readHistory(follower.entry.cwd, follower.entry.job.id, { after: follower.after, limit: 64 });
      const { metadata, ...publicPage } = page;
      const data = `${JSON.stringify({ method: "broker/observation", params: publicPage })}\n`;
      if (follower.socket.writableLength > 1024 * 1024) { follower.socket.destroy(); return; }
      const ready = follower.socket.write(data);
      follower.after = page.nextCursor;
      if (!ready) {
        await new Promise((resolve) => {
          const done = () => { follower.socket.off("drain", done); follower.socket.off("close", done); resolve(); };
          follower.socket.once("drain", done);
          follower.socket.once("close", done);
        });
      }
      if (page.caughtUp === true || (page.caughtUp === undefined &&
        (!page.events.length || page.events.at(-1).seq === page.committedSeq))) return;
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  disconnected(socket) {
    this.owners.delete(socket);
    const follower = this.followers.get(socket);
    if (follower) follower.closed = true;
    this.followers.delete(socket);
  }

  async close() {
    clearInterval(this.timer);
    clearInterval(this.cleaner);
    clearInterval(this.historyTimer);
    await this.historySweep?.catch((error) => this.diagnostic(error));
    for (const follower of this.followers.values()) follower.closed = true;
    this.followers.clear();
    for (const entry of this.jobs.values()) {
      await entry.store?.close();
      clearTimeout(entry.viewTimer);
      if (!this.threadRecords || entry.bound) await this.writeView(entry);
    }
    await this.cleanup().catch((error) => this.diagnostic(error));
  }

  async cleanup() {
    if (this.cleaning) return this.cleaning;
    const entry = this.jobs.values().next().value;
    if (!entry) return;
    this.cleaning = cleanupHistory(entry.cwd).then((result) => {
      if (result.overBudget) this.diagnostic(new Error("History remains above the total budget: live writers and their current segments are retained"));
    }).finally(() => { this.cleaning = null; });
    return this.cleaning;
  }
}
