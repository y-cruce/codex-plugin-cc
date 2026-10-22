import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "./args.mjs";
import { resolveJobHistoryAtStateDir } from "./history-resolver.mjs";
import { checkJobLiveness } from "./job-control.mjs";
import { createLiveView } from "./job-event-model.mjs";
import { mapConcurrent, observationJobs, readObservationJson } from "./observation-paths.mjs";
import { canonicalWorkspaceRoot, threadRecordPaths } from "./thread-records.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";
import { mergeSessionTaskIndex, parseSessionTaskIndex, pruneSessionTaskIndexes, sessionTaskIndexPath } from "./session-task-index.mjs";

async function directories(root) {
  try {
    return (await fs.readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory())
      .map(entry => path.join(root, entry.name));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

// Only metadata is needed to bound the one-time pre-index migration.
async function sessionCreatedAt(sessionId, configDir) {
  const supplied = process.env.CODEX_COMPANION_TRANSCRIPT_PATH;
  const sources = new Set([
    ...(supplied && path.basename(supplied) === `${sessionId}.jsonl` ? [supplied] : []),
    ...(await directories(path.join(configDir, "projects"))).map(dir => path.join(dir, `${sessionId}.jsonl`))
  ]);
  const times = await mapConcurrent([...sources], async source => {
    const stat = await fs.stat(source).catch(error => { if (error.code !== "ENOENT") throw error; });
    return stat?.birthtimeMs > 0 ? stat.birthtimeMs : null;
  });
  return Math.min(...times.filter(time => time !== null), Infinity);
}

async function indexedJob(stateDir, jobId, snapshots) {
  const file = path.join(stateDir, "jobs", `${jobId}.json`);
  const job = await readObservationJson(file);
  if (job) return { job, stateDir, mtime: (await fs.stat(file)).mtimeMs };
  if (!snapshots.has(stateDir)) snapshots.set(stateDir, readObservationJson(path.join(stateDir, "state.json")));
  const cached = (await snapshots.get(stateDir))?.jobs?.find(job => job.id === jobId);
  if (cached) return { job: cached, stateDir, mtime: 0 };
  const legacy = await readObservationJson(path.join(stateDir, "job-history", jobId, "manifest.json"));
  if (legacy?.metadata?.job) return { job: legacy.metadata.job, stateDir, mtime: 0 };
  const history = await resolveJobHistoryAtStateDir(stateDir, jobId);
  if (history.layout === "legacy") return null;
  const receipt = await readObservationJson(history.roundReceipt);
  return receipt?.job ? { job: receipt.job, stateDir,
    mtime: (await fs.stat(path.join(stateDir, "job-index", `${jobId}.json`))).mtimeMs } : null;
}

async function scanJobs(roots, since) {
  const stateDirs = (await mapConcurrent([...roots], root => directories(root))).flat()
    .filter(dir => path.basename(dir) !== "session-jobs");
  return (await mapConcurrent(stateDirs, async stateDir => {
    const stat = await fs.stat(path.join(stateDir, "jobs")).catch(async error => {
      if (error.code === "ENOENT") return fs.stat(stateDir); throw error;
    });
    if (stat.mtimeMs < since) return [];
    return observationJobs(stateDir, { concurrency: 8, since });
  }, 8)).flat();
}

async function readIndex(file) {
  const contents = await fs.readFile(file, "utf8").catch(error => {
    if (error.code === "ENOENT") return ""; throw error;
  });
  return parseSessionTaskIndex(contents);
}

export async function listDirectorTasks({ sessionId, query = "", cwd, all = false, limit = 20, days = 3,
  home = os.homedir(), configDir = process.env.CLAUDE_CONFIG_DIR || path.join(home, ".claude"), tmpDir = os.tmpdir() } = {}) {
  if (!sessionId) throw new Error("tasks needs the current Claude session id (CODEX_COMPANION_SESSION_ID)");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("limit must be an integer from 1 to 100");
  if (!Number.isSafeInteger(days) || days < 1) throw new Error("days must be a positive integer");
  const primary = process.env.CLAUDE_PLUGIN_DATA ? path.join(process.env.CLAUDE_PLUGIN_DATA, "state") : path.join(tmpDir, "codex-companion");
  const roots = new Set([primary,
    ...(await directories(path.join(configDir, "plugins", "data"))).map(dir => path.join(dir, "state")),
    path.join(tmpDir, "codex-companion")
  ]);
  const references = new Map();
  let complete = false;
  for (const root of roots) {
    const index = await readIndex(sessionTaskIndexPath(root, sessionId));
    if (root === primary) complete = index.complete;
    for (const ref of index.entries) {
      if (roots.has(path.dirname(ref.stateDir))) references.set(`${ref.stateDir}\0${ref.jobId}`, ref);
    }
  }
  if (!complete) {
    const since = await sessionCreatedAt(sessionId, configDir);
    if (!Number.isFinite(since)) throw new Error("Cannot bootstrap tasks without this session's transcript creation time");
    for (const { job, stateDir } of await scanJobs(roots, since)) {
      if (job.sessionId === sessionId) references.set(`${stateDir}\0${job.id}`,
        { stateDir, jobId: job.id, createdAt: job.createdAt ?? job.startedAt });
    }
  }
  // No time filter applies to this session. Even an index idle for over a week
  // is read and refreshed before retention considers the other index files.
  mergeSessionTaskIndex(primary, sessionId, [...references.values()], true);
  const cutoff = Date.now() - days * 86_400_000;
  if (all) {
    for (const root of roots) {
      const directory = path.dirname(sessionTaskIndexPath(root, sessionId));
      const files = await fs.readdir(directory).catch(error => { if (error.code === "ENOENT") return []; throw error; });
      const indexes = await mapConcurrent(files.filter(name => name.endsWith(".jsonl")), async name => {
        const file = path.join(directory, name);
        if (file === sessionTaskIndexPath(root, sessionId) || (await fs.stat(file)).mtimeMs < cutoff) return [];
        return (await readIndex(file)).entries;
      });
      for (const ref of indexes.flat()) {
        if (roots.has(path.dirname(ref.stateDir)) && (!ref.createdAt || Date.parse(ref.createdAt) >= cutoff)) {
          references.set(`${ref.stateDir}\0${ref.jobId}`, ref);
        }
      }
    }
  }
  const wanted = cwd ? canonicalWorkspaceRoot(resolveWorkspaceRoot(cwd)) : null;
  const jobs = new Map();
  const add = entry => {
    if (!entry) return;
    const { job } = entry;
    if (!job.workspaceRoot || (job.sessionId !== sessionId &&
      (!all || Date.parse(job.createdAt ?? job.startedAt ?? "") < cutoff))) return;
    const workspaceRoot = canonicalWorkspaceRoot(job.workspaceRoot);
    if (wanted && workspaceRoot !== wanted) return;
    const key = `${workspaceRoot}\0${job.id}`;
    if (!jobs.has(key) || jobs.get(key).mtime < entry.mtime) jobs.set(key, { ...entry, workspaceRoot });
  };
  const snapshots = new Map();
  for (const entry of await mapConcurrent([...references.values()], ref => indexedJob(ref.stateDir, ref.jobId, snapshots))) add(entry);
  // Older releases did not create session indexes. Only recent stores and
  // artifacts are opened for the other-session lookback, including widened days.
  if (all) for (const entry of await scanJobs(roots, cutoff)) if (entry.job.sessionId !== sessionId) add(entry);
  for (const root of roots) pruneSessionTaskIndexes(root);
  const views = new Map();
  const threads = new Map();
  const viewOf = history => {
    if (!views.has(history.liveView)) views.set(history.liveView, readObservationJson(history.liveView));
    return views.get(history.liveView);
  };
  const newest = entry => Date.parse(entry.job.createdAt ?? entry.job.startedAt ?? "") || 0;
  const sorted = [...jobs.values()].sort((a, b) => newest(b) - newest(a) || b.mtime - a.mtime);
  const rows = await mapConcurrent(sorted, async entry => {
    const { job, stateDir, workspaceRoot } = entry;
    let history = await resolveJobHistoryAtStateDir(stateDir, job.id);
    if (history.layout === "legacy" && job.status === "queued" && job.recordId) {
      history = threadRecordPaths(stateDir, job.recordId);
    }
    // Bound records already identify the thread. Most legacy jobs also retain
    // their thread id, so only read a view here when grouping requires it.
    const knownThread = job.executorSessionId || job.threadId;
    const view = history.layout === "legacy" && !knownThread ? await viewOf(history) : null;
    const threadId = knownThread || view?.threadId || job.request?.resumeThreadId || null;
    const identity = JSON.stringify([job.executor ?? "codex", job.request?.executorCommand, job.request?.executorArgs]);
    const key = history.layout === "thread-record" ? `${workspaceRoot}\0record:${history.recordId}`
      : `${workspaceRoot}\0${identity}\0${threadId ?? job.id}`;
    return { key, job, workspaceRoot, history };
  });
  for (const { key, ...row } of rows) if (!threads.has(key)) threads.set(key, row);
  const matches = [...threads.values()].filter(({ job }) =>
    String(job.label ?? job.title ?? job.id).toLowerCase().includes(query.toLowerCase()));
  const line = value => String(value).replace(/\s+/g, " ").trim();
  const lines = await mapConcurrent(matches.slice(0, limit), async ({ job, workspaceRoot, history }) => {
    const view = await viewOf(history);
    const threadId = job.executorSessionId || job.threadId || view?.threadId || job.request?.resumeThreadId || null;
    const executor = (view?.executor ?? createLiveView(job).executor).label.toLowerCase();
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
    valueOptions: ["query", "cwd", "limit", "days"], booleanOptions: ["all"], rejectUnknownOptions: true
  });
  console.log(await listDirectorTasks({ ...options, sessionId: process.env.CODEX_COMPANION_SESSION_ID,
    limit: options.limit === undefined ? 20 : Number(options.limit),
    days: options.days === undefined ? 3 : Number(options.days) }));
}
