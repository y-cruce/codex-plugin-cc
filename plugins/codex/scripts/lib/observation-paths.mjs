import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveJobHistoryAtStateDir } from "./history-resolver.mjs";
import { resolveStateDir } from "./state.mjs";
import { threadRecordPaths } from "./thread-records.mjs";
import { checkJobLiveness } from "./job-control.mjs";

export async function readObservationJson(file) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

export async function observationRoots(cwd) {
  const current = resolveStateDir(cwd);
  const key = path.basename(current);
  const config = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  const data = path.join(config, "plugins", "data");
  let entries;
  try { entries = await fs.readdir(data, { withFileTypes: true }); }
  catch (error) { if (error.code !== "ENOENT") throw error; entries = []; }
  return [...new Set([current, ...entries.filter((entry) => entry.isDirectory())
    .map((entry) => path.join(data, entry.name, "state", key)), path.join(os.tmpdir(), "codex-companion", key)])];
}

export async function mapConcurrent(items, visit, limit = 16) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const at = next++;
      results[at] = await visit(items[at]);
    }
  }));
  return results;
}

export async function observationJobs(stateDir, { concurrency = 1, since = 0 } = {}) {
  const state = await readObservationJson(path.join(stateDir, "state.json"));
  const jobs = new Map((state?.jobs ?? []).map((job) => [job.id, { job, stateDir, mtime: 0 }]));
  const names = async directory => fs.readdir(path.join(stateDir, directory)).catch(error => {
    if (error.code === "ENOENT") return []; throw error;
  });
  const recent = async file => !since || (await fs.stat(file)).mtimeMs >= since;
  const files = await names("jobs");
  for (const entry of await mapConcurrent(files.filter(name => name.endsWith(".json")), async name => {
    const file = path.join(stateDir, "jobs", name);
    try {
      const stat = await fs.stat(file);
      if (stat.mtimeMs < since) return null;
      const job = await readObservationJson(file);
      return job ? { job, stateDir, mtime: stat.mtimeMs, hasJobFile: true } : null;
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }, concurrency)) if (entry) jobs.set(entry.job.id, entry);
  for (const entry of await mapConcurrent((await names("job-history")).filter(id => !jobs.has(id)), async id => {
    const file = path.join(stateDir, "job-history", id, "manifest.json");
    try {
      if (!(await recent(file))) return null;
      const job = (await readObservationJson(file))?.metadata?.job;
      return job ? { job, stateDir, mtime: 0 } : null;
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }, concurrency)) if (entry) jobs.set(entry.job.id, entry);
  for (const entry of await mapConcurrent((await names("job-index")).filter(name => name.endsWith(".json")), async name => {
    const file = path.join(stateDir, "job-index", name);
    try {
      if (jobs.has(name.slice(0, -5)) || !(await recent(file))) return null;
      const index = await readObservationJson(file);
      if (!index || index.schemaVersion !== 1 || index.jobId !== index.roundId || jobs.has(index.jobId)) return null;
      const history = await resolveJobHistoryAtStateDir(stateDir, index.jobId, index);
      const receipt = await readObservationJson(history.roundReceipt);
      const job = receipt?.job;
      return job?.id === index.jobId ? { job, stateDir, mtime: (await fs.stat(file)).mtimeMs } : null;
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }, concurrency)) if (entry) jobs.set(entry.job.id, entry);
  return [...jobs.values()];
}

export async function observationThreads(stateDir, { finishedAfter } = /** @type {{ finishedAfter?: number }} */ ({})) {
  const threads = new Map();
  const jobs = await observationJobs(stateDir);
  const producers = new Map(jobs.map(({ job }) => [job.id, job.directorPush === true]));
  for (const entry of jobs) {
    // A retained active record still needs owner-exit recovery from its Monitor.
    const live = entry.hasJobFile === true && ["running", "queued"].includes(entry.job.status);
    entry.job = checkJobLiveness(entry.job.workspaceRoot, entry.job, null, new Map(), { persist: false });
    let history = await resolveJobHistoryAtStateDir(stateDir, entry.job.id);
    const associatedQueued = history.layout === "legacy" && entry.job.status === "queued" &&
      typeof entry.job.recordId === "string" && entry.job.recordId;
    if (associatedQueued) history = threadRecordPaths(stateDir, entry.job.recordId);
    const view = await readObservationJson(history.liveView);
    if (history.layout === "legacy") {
      const manifest = await readObservationJson(history.manifest);
      const job = view ?? entry.job;
      // A view is only as fresh as the last write its owner managed, so a job
      // whose owner died mid-flight leaves "running" in it for good. The job
      // record is written on the way out, so a terminal one overrides the view.
      const status = terminalStatus(entry.job.status) || !manifest ? entry.job.status : job.status;
      threads.set(entry.job.id, { thread: {
        id: entry.job.id,
        recordId: entry.job.id,
        jobId: entry.job.id,
        label: job.label ?? null,
        status,
        live,
        startedAt: job.startedAt ?? null,
        endedAt: job.endedAt ?? entry.job.completedAt ?? null,
        threadId: job.threadId ?? entry.job.threadId ?? null,
        activeRoundId: terminalStatus(status) ? null : entry.job.id,
        latestRoundId: entry.job.id,
        sessionIds: entry.job.sessionId ? [entry.job.sessionId] : [],
        viewPath: history.liveView,
        historyAvailable: Boolean(manifest),
        directorPush: entry.job.directorPush === true,
        layout: "legacy"
      }, stateDir, mtime: Math.max(entry.mtime, await observationMtime(history.liveView)) });
      continue;
    }
    const existing = threads.get(history.recordId);
    if (existing) {
      existing.thread.live ||= live;
      if (associatedQueued && entry.job.sessionId && !existing.thread.sessionIds.includes(entry.job.sessionId)) {
        existing.thread.sessionIds.push(entry.job.sessionId);
      }
      if (associatedQueued && existing.thread.activeRoundId === null) {
        existing.thread.status = "queued";
        existing.thread.endedAt = null;
      }
      existing.mtime = Math.max(existing.mtime, entry.mtime);
      continue;
    }
    const manifest = await readObservationJson(history.manifest);
    if (!view || !manifest) continue;
    const jobId = view.activeRoundId ?? view.latestRoundId ?? view.jobId;
    threads.set(history.recordId, { thread: {
      id: history.recordId,
      recordId: history.recordId,
      jobId,
      label: view.label ?? null,
      status: associatedQueued && view.activeRoundId == null ? "queued" : view.status,
      live,
      startedAt: view.startedAt ?? null,
      endedAt: associatedQueued && view.activeRoundId == null ? null : view.endedAt ?? null,
      threadId: view.threadId ?? manifest.threadId ?? null,
      activeRoundId: view.activeRoundId ?? null,
      latestRoundId: view.latestRoundId ?? jobId,
      sessionIds: [...new Set([
        ...(view.rounds ?? []).map((round) => round.sessionId).filter(Boolean),
        ...(associatedQueued && entry.job.sessionId ? [entry.job.sessionId] : [])
      ])],
      viewPath: history.liveView,
      historyAvailable: !manifest.tombstone,
      directorPush: producers.get(jobId) === true,
      layout: "thread-record"
    }, stateDir, mtime: Math.max(entry.mtime, await observationMtime(history.liveView)) });
  }
  return [...threads.values()].filter(({ thread }) => finishedAfter === undefined || thread.activeRoundId !== null ||
    !validEndedAt(thread.endedAt) || Date.parse(thread.endedAt) > finishedAfter);
}

const terminalStatus = (status) => ["completed", "failed", "cancelled"].includes(status);
const validEndedAt = (endedAt) => typeof endedAt === "string" && Number.isFinite(Date.parse(endedAt));

async function observationMtime(file) {
  try { return (await fs.stat(file)).mtimeMs; }
  catch (error) { if (error.code === "ENOENT") return 0; throw error; }
}

export async function resolveObservationRoot(cwd, id) {
  if (!id || path.basename(id) !== id || id === "." || id === "..") throw Object.assign(new Error(`UNKNOWN_JOB ${id}`), { code: "UNKNOWN_JOB" });
  const current = resolveStateDir(cwd);
  if (process.env.CLAUDE_PLUGIN_DATA && (await observationJobs(current)).some((entry) => entry.job.id === id)) return current;
  const roots = await observationRoots(cwd);
  let selected = null;
  for (const stateDir of roots) {
    const entry = (await observationJobs(stateDir)).find((candidate) => candidate.job.id === id);
    if (entry && (!selected || entry.mtime > selected.mtime)) selected = entry;
  }
  return selected?.stateDir ?? roots[0];
}
