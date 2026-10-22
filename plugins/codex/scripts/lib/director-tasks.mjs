import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "./args.mjs";
import { resolveJobHistoryAtStateDir } from "./history-resolver.mjs";
import { checkJobLiveness } from "./job-control.mjs";
import { createLiveView } from "./job-event-model.mjs";
import { observationJobs, readObservationJson } from "./observation-paths.mjs";
import { canonicalWorkspaceRoot, threadRecordPaths } from "./thread-records.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

async function directories(root) {
  try {
    return (await fs.readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory())
      .map(entry => path.join(root, entry.name));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

// The pane discovers this session across repositories from these same job
// stores. Read them directly: finished threads outlive the pane's visible rows.
export async function listDirectorTasks({ sessionId, query = "", cwd, all = false, limit = 20,
  home = os.homedir(), configDir = process.env.CLAUDE_CONFIG_DIR || path.join(home, ".claude"), tmpDir = os.tmpdir() } = {}) {
  if (!sessionId) throw new Error("tasks needs the current Claude session id (CODEX_COMPANION_SESSION_ID)");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("limit must be an integer from 1 to 100");
  const roots = new Set([
    ...(process.env.CLAUDE_PLUGIN_DATA ? [path.join(process.env.CLAUDE_PLUGIN_DATA, "state")] : []),
    ...(await directories(path.join(configDir, "plugins", "data"))).map(dir => path.join(dir, "state")),
    path.join(tmpDir, "codex-companion")
  ]);
  const wanted = cwd ? canonicalWorkspaceRoot(resolveWorkspaceRoot(cwd)) : null;
  const jobs = new Map();
  for (const root of roots) {
    for (const stateDir of await directories(root)) {
      for (const entry of await observationJobs(stateDir)) {
        const { job } = entry;
        if ((!all && job.sessionId !== sessionId) || !job.workspaceRoot) continue;
        const workspaceRoot = canonicalWorkspaceRoot(job.workspaceRoot);
        if (wanted && workspaceRoot !== wanted) continue;
        const key = `${workspaceRoot}\0${job.id}`;
        if (!jobs.has(key) || jobs.get(key).mtime < entry.mtime) jobs.set(key, { ...entry, workspaceRoot });
      }
    }
  }
  const views = new Map();
  const threads = new Map();
  const newest = entry => Date.parse(entry.job.createdAt ?? entry.job.startedAt ?? "") || 0;
  for (const entry of [...jobs.values()].sort((a, b) => newest(b) - newest(a) || b.mtime - a.mtime)) {
    const { job, stateDir, workspaceRoot } = entry;
    let history = await resolveJobHistoryAtStateDir(stateDir, job.id);
    if (history.layout === "legacy" && job.status === "queued" && job.recordId) {
      history = threadRecordPaths(stateDir, job.recordId);
    }
    if (!views.has(history.liveView)) views.set(history.liveView, await readObservationJson(history.liveView));
    const view = views.get(history.liveView);
    const threadId = job.executorSessionId || job.threadId || view?.threadId || job.request?.resumeThreadId || null;
    const executor = (view?.executor ?? createLiveView(job).executor).label.toLowerCase();
    const identity = JSON.stringify([job.executor ?? "codex", job.request?.executorCommand, job.request?.executorArgs]);
    const key = history.layout === "thread-record" ? `${workspaceRoot}\0record:${history.recordId}`
      : `${workspaceRoot}\0${identity}\0${threadId ?? job.id}`;
    if (!threads.has(key)) threads.set(key, { job, workspaceRoot, threadId, executor });
  }
  const matches = [...threads.values()].filter(({ job }) =>
    String(job.label ?? job.title ?? job.id).toLowerCase().includes(query.toLowerCase()));
  const line = value => String(value).replace(/\s+/g, " ").trim();
  const lines = matches.slice(0, limit).map(({ job, workspaceRoot, threadId, executor }) => {
    const repo = workspaceRoot.startsWith(`${home}/`) ? `~${workspaceRoot.slice(home.length)}` : workspaceRoot;
    const status = checkJobLiveness(workspaceRoot, job, null, new Map(), { persist: false }).status;
    const foreign = job.sessionId !== sessionId ? ` · other session=${line(job.sessionId ?? "unknown")}` : "";
    return `${line(job.label ?? job.title ?? job.id)} · thread=${line(threadId ?? "pending")} · ${executor} · ${line(status)} · job=${line(job.id)} · ${line(repo)}${foreign}`;
  });
  if (matches.length > limit) lines.push(`${matches.length - limit} older not shown`);
  return lines.join("\n") || "No matching tasks.";
}

export async function handleTasks(argv) {
  const { options } = parseArgs(argv, {
    valueOptions: ["query", "cwd", "limit"], booleanOptions: ["all"], rejectUnknownOptions: true
  });
  console.log(await listDirectorTasks({ ...options, sessionId: process.env.CODEX_COMPANION_SESSION_ID,
    limit: options.limit === undefined ? 20 : Number(options.limit) }));
}
