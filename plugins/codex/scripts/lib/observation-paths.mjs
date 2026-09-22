import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveJobHistoryAtStateDir } from "./history-resolver.mjs";
import { resolveStateDir } from "./state.mjs";

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

export async function observationJobs(stateDir) {
  const state = await readObservationJson(path.join(stateDir, "state.json"));
  const jobs = new Map((state?.jobs ?? []).map((job) => [job.id, { job, stateDir, mtime: 0 }]));
  for (const name of await fs.readdir(path.join(stateDir, "jobs")).catch((error) => {
    if (error.code === "ENOENT") return []; throw error;
  })) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(stateDir, "jobs", name);
    try {
      const job = await readObservationJson(file);
      if (job) jobs.set(job.id, { job, stateDir, mtime: (await fs.stat(file)).mtimeMs });
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  for (const id of await fs.readdir(path.join(stateDir, "job-history")).catch((error) => {
    if (error.code === "ENOENT") return []; throw error;
  })) {
    if (jobs.has(id)) continue;
    const job = (await readObservationJson(path.join(stateDir, "job-history", id, "manifest.json")))?.metadata?.job;
    if (job) jobs.set(id, { job, stateDir, mtime: 0 });
  }
  for (const name of await fs.readdir(path.join(stateDir, "job-index")).catch((error) => {
    if (error.code === "ENOENT") return []; throw error;
  })) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(stateDir, "job-index", name);
    try {
      const index = await readObservationJson(file);
      if (!index || index.schemaVersion !== 1 || index.jobId !== index.roundId || jobs.has(index.jobId)) continue;
      const history = await resolveJobHistoryAtStateDir(stateDir, index.jobId);
      const receipt = await readObservationJson(history.roundReceipt);
      const job = receipt?.job;
      if (job?.id === index.jobId) jobs.set(index.jobId, { job, stateDir, mtime: (await fs.stat(file)).mtimeMs });
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return [...jobs.values()];
}

export async function observationThreads(stateDir) {
  const threads = new Map();
  for (const entry of await observationJobs(stateDir)) {
    const history = await resolveJobHistoryAtStateDir(stateDir, entry.job.id);
    const view = await readObservationJson(history.liveView);
    if (history.layout === "legacy") {
      const job = view ?? entry.job;
      // A view is only as fresh as the last write its owner managed, so a job
      // whose owner died mid-flight leaves "running" in it for good. The job
      // record is written on the way out, so a terminal one overrides the view.
      const status = terminalStatus(entry.job.status) ? entry.job.status : job.status;
      threads.set(entry.job.id, { thread: {
        id: entry.job.id,
        recordId: entry.job.id,
        jobId: entry.job.id,
        label: job.label ?? null,
        status,
        startedAt: job.startedAt ?? null,
        endedAt: job.endedAt ?? entry.job.completedAt ?? null,
        threadId: job.threadId ?? entry.job.threadId ?? null,
        activeRoundId: terminalStatus(status) ? null : entry.job.id,
        latestRoundId: entry.job.id,
        sessionIds: entry.job.sessionId ? [entry.job.sessionId] : [],
        viewPath: history.liveView,
        historyAvailable: Boolean(await readObservationJson(history.manifest)),
        layout: "legacy"
      }, stateDir, mtime: Math.max(entry.mtime, await observationMtime(history.liveView)) });
      continue;
    }
    if (threads.has(history.recordId)) continue;
    const manifest = await readObservationJson(history.manifest);
    if (!view || !manifest) continue;
    const jobId = view.activeRoundId ?? view.latestRoundId ?? view.jobId;
    threads.set(history.recordId, { thread: {
      id: history.recordId,
      recordId: history.recordId,
      jobId,
      label: view.label ?? null,
      status: view.status,
      startedAt: view.startedAt ?? null,
      endedAt: view.endedAt ?? null,
      threadId: view.threadId ?? manifest.threadId ?? null,
      activeRoundId: view.activeRoundId ?? null,
      latestRoundId: view.latestRoundId ?? jobId,
      sessionIds: [...new Set((view.rounds ?? []).map((round) => round.sessionId).filter(Boolean))],
      viewPath: history.liveView,
      historyAvailable: !manifest.tombstone,
      layout: "thread-record"
    }, stateDir, mtime: Math.max(entry.mtime, await observationMtime(history.liveView)) });
  }
  return [...threads.values()];
}

const terminalStatus = (status) => ["completed", "failed", "cancelled"].includes(status);

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
