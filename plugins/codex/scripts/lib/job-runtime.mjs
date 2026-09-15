import fs from "node:fs/promises";
import path from "node:path";
import { JobEventStore, readHistory, resolveLiveViewPath, cursorFor, cleanupHistory } from "./job-event-store.mjs";
import { normalizeJobEvent, createLiveView, applyJobEvent } from "./job-event-model.mjs";
import { readStoredJob, ownerProcessAlive } from "./job-control.mjs";

const terminal = (status) => ["completed", "failed", "cancelled"].includes(status);

export class JobRuntime {
  constructor() {
    this.jobs = new Map();
    this.owners = new Map();
    this.threads = new Map();
    this.agents = new Map();
    this.pendingThreads = new Map();
    this.followers = new Map();
    this.reconciling = false;
    this.timer = setInterval(() => this.reconcile().catch((error) => this.diagnostic(error)), 1000);
    this.timer.unref();
    this.cleaner = setInterval(() => this.cleanup().catch((error) => this.diagnostic(error)), 300000);
    this.cleaner.unref();
  }

  diagnostic(error) { process.stderr.write(`Observation: ${error.message}\n`); }

  async register(socket, cwd, jobId) {
    const job = readStoredJob(cwd, jobId);
    if (!job) throw Object.assign(new Error(`UNKNOWN_JOB ${jobId}`), { code: "UNKNOWN_JOB" });
    const key = `${job.workspaceRoot}\0${job.id}`;
    let entry = this.jobs.get(key);
    if (!entry) {
      entry = { key, cwd: job.workspaceRoot, job, view: createLiveView(job), writeTail: Promise.resolve(), viewTimer: null,
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
          for (const event of events) applyJobEvent(entry.view, event);
          entry.view.history.committedSeq = snapshot.committedSeq;
          if (snapshot.continuity === "partial") entry.view.history.continuity = "partial";
          if (!events.some((event) => event.type.startsWith("job.") && terminal(entry.view.status))) this.scheduleView(entry);
          const segment = snapshot.segments.at(-1)?.file;
          if (entry.lastSegment && entry.lastSegment !== segment) setImmediate(() => this.cleanup().catch((error) => this.diagnostic(error)));
          entry.lastSegment = segment;
          for (const follower of this.followers.values()) if (follower.entry === entry) this.wake(follower);
        }
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
        if (!history.events.length || history.events.at(-1).seq === history.committedSeq) break;
      } while (true);
      this.jobs.set(key, entry);
      for (const agent of entry.view.subAgents ?? []) {
        this.threads.set(agent.threadId, entry);
        this.agents.set(agent.threadId, { threadId: agent.threadId, path: agent.path });
      }
      if (entry.store.snapshot.committedSeq === "0") {
        await this.append(entry, { method: "companion/job-started", params: { job } });
        await entry.store.flush();
      }
      clearTimeout(entry.viewTimer);
      entry.viewTimer = null;
      await this.writeView(entry);
      this.cleanup().catch((error) => this.diagnostic(error));
    }
    this.owners.set(socket, entry);
    return { historyAvailable: true, jobId, streamId: entry.store.snapshot.streamId };
  }

  async bind(socket, threadId) {
    const entry = this.owners.get(socket);
    if (!entry || !threadId) return;
    this.threads.set(threadId, entry);
    this.agents.delete(threadId);
    await this.bindThread(entry, threadId);
  }

  async bindThread(entry, threadId, agentPath) {
    if (this.threads.has(threadId) && this.threads.get(threadId) !== entry) return;
    this.threads.set(threadId, entry);
    if (agentPath) this.agents.set(threadId, { threadId, path: agentPath.split("/").filter(Boolean).at(-1) ?? threadId });
    const buffered = this.pendingThreads.get(threadId) ?? [];
    this.pendingThreads.delete(threadId);
    for (const message of buffered) await this.observe(message);
  }

  async observe(message) {
    const p = message.params ?? {};
    const threadId = p.threadId ?? p.thread?.id;
    const parentId = p.thread?.source?.subagent?.thread_spawn?.parent_thread_id;
    if (threadId && parentId && this.threads.has(parentId) && !this.threads.has(threadId)) {
      await this.bindThread(this.threads.get(parentId), threadId, p.thread?.name ?? threadId);
    }
    const entry = this.threads.get(threadId);
    if (!entry) {
      if (threadId && this.pendingThreads.size < 64) {
        const pending = this.pendingThreads.get(threadId) ?? [];
        if (pending.length < 256) pending.push(structuredClone(message));
        this.pendingThreads.set(threadId, pending);
      }
      return;
    }
    await this.append(entry, message);
    if (p.item?.type === "subAgentActivity" && p.item.agentThreadId) {
      await this.bindThread(entry, p.item.agentThreadId, p.item.agentPath ?? p.item.agentThreadId);
    } else if (p.item?.type === "collabAgentToolCall") {
      for (const childId of p.item.receiverThreadIds ?? []) {
        await this.bindThread(entry, childId, this.agents.get(childId)?.path ?? childId);
      }
    }
  }

  async append(entry, message) {
    if (entry.failure) return;
    try {
      const event = normalizeJobEvent(structuredClone(message), entry.job);
      const agent = this.agents.get(event.threadId);
      if (agent) event.derived = { ...event.derived, agent: { ...agent } };
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
      const file = resolveLiveViewPath(entry.cwd, entry.job.id);
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
    if (!job || !terminal(job.status) || entry.ended) return { recorded: entry.ended };
    entry.ended = true;
    entry.job = job;
    await this.append(entry, { method: "companion/job-completed", params: { job } });
    await entry.store.flush();
    await entry.store.updateMetadata({ job, status: job.status, completedAt: job.completedAt });
    clearTimeout(entry.viewTimer);
    entry.viewTimer = null;
    await this.writeView(entry);
    this.cleanup().catch((error) => this.diagnostic(error));
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
          entry.ended = true;
          entry.job = { ...job, status: "failed", errorMessage: "owner process exited", completedAt: new Date().toISOString() };
          await this.append(entry, { method: "companion/job-completed", params: { job: entry.job } });
          await entry.store.flush();
          await entry.store.updateMetadata({ job: entry.job, status: "failed", completedAt: entry.job.completedAt });
          await this.writeView(entry);
        }
      }
    } finally { this.reconciling = false; }
  }

  async follow(socket, cwd, jobId, after) {
    const entry = [...this.jobs.values()].find((item) => item.job.id === jobId && item.cwd === cwd);
    if (!entry) throw Object.assign(new Error("OBSERVATION_UNSUPPORTED: job is not owned by this broker"), { code: "OBSERVATION_UNSUPPORTED" });
    const page = await readHistory(cwd, jobId, { after, limit: 1 });
    const follower = { socket, entry, after, pumping: false, dirty: false, closed: false };
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
      if (!page.events.length || page.events.at(-1).seq === page.committedSeq) return;
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
    for (const follower of this.followers.values()) follower.closed = true;
    this.followers.clear();
    for (const entry of this.jobs.values()) {
      await entry.store.close();
      clearTimeout(entry.viewTimer);
      await this.writeView(entry);
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
