import { spawn as spawnProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pruneMissingStateTaskEntries } from "./session-task-index.mjs";

const DAY = 86_400_000;

function directoryExists(file) {
  try { return fs.lstatSync(file).isDirectory(); }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

function recentlySwept(stamp, now) {
  try { return fs.lstatSync(stamp).mtimeMs > now - DAY; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

function ownerAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== "ESRCH"; }
}

function acquireLock(file, now) {
  try { return fs.openSync(file, "wx"); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  const stat = fs.lstatSync(file);
  if (!stat.isFile()) return null;
  const owner = Number(fs.readFileSync(file, "utf8"));
  if (ownerAlive(owner) !== false && !(owner === 0 && now - stat.mtimeMs > 1000)) return null;
  const current = fs.lstatSync(file);
  if (current.ino !== stat.ino || current.mtimeMs !== stat.mtimeMs) return null;
  fs.unlinkSync(file);
  try { return fs.openSync(file, "wx"); }
  catch (error) { if (error.code === "EEXIST") return null; throw error; }
}

// lstat every descendant: neither the scan nor deletion traverses a symlink.
// Unknown/corrupt job metadata keeps the entire store.
function inspectStateDir(stateDir, now) {
  let bytes = 0;
  let latest = 0;
  const jobs = new Map();
  const workspaces = new Set();
  const keep = reason => { throw Object.assign(new Error(reason), { keep: reason }); };
  function addJob(job) {
    if (!job || typeof job.id !== "string" || !path.isAbsolute(job.workspaceRoot ?? "")) keep("unknownJob");
    workspaces.add(job.workspaceRoot);
    if (job.status === "queued" || job.status === "running") {
      const alive = ownerAlive(job.pid);
      if (alive !== false) keep(alive ? "liveJob" : "unknownOwner");
    }
    jobs.set(job.id, job);
  }
  function visit(file, relative = "") {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) keep("unsafeEntry");
    latest = Math.max(latest, stat.mtimeMs);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file)) visit(path.join(file, name), relative ? `${relative}/${name}` : name);
      return;
    }
    bytes += stat.size;
    if (/^jobs\/[^/]+\.json$/.test(relative)) addJob(JSON.parse(fs.readFileSync(file, "utf8")));
    else if (relative === "state.json") {
      const state = JSON.parse(fs.readFileSync(file, "utf8"));
      if (state.workspaceRoot) workspaces.add(state.workspaceRoot);
      if (state.jobs !== undefined && !Array.isArray(state.jobs)) throw new Error("unknown jobs");
      for (const job of state.jobs ?? []) addJob(job);
    } else if (/^job-history\/[^/]+\/manifest\.json$/.test(relative)) {
      addJob(JSON.parse(fs.readFileSync(file, "utf8")).metadata?.job);
    } else if (/^thread-records\/[^/]+\/rounds\/[^/]+\.json$/.test(relative)) {
      addJob(JSON.parse(fs.readFileSync(file, "utf8")).job);
    } else if (/^thread-records\/[^/]+\/manifest\.json$/.test(relative)) {
      const record = JSON.parse(fs.readFileSync(file, "utf8"));
      if (record.workspaceRoot) workspaces.add(record.workspaceRoot);
    }
  }
  try {
    visit(stateDir);
    for (const workspace of workspaces) {
      if (!path.isAbsolute(workspace)) return { keep: "unknown" };
      try { fs.statSync(workspace); return { keep: "workspaceExists" }; }
      catch (error) { if (error.code !== "ENOENT" && error.code !== "ENOTDIR") return { keep: "unknown" }; }
    }
    if (latest > now - 3 * DAY) return { keep: "recent" };
    const sessions = {};
    for (const job of jobs.values()) if (job.sessionId) sessions[job.sessionId] = (sessions[job.sessionId] ?? 0) + 1;
    return { stateDir, reason: jobs.size ? "workspaceMissing" : "noJobs", bytes, jobs: jobs.size, sessions };
  } catch (error) { return { keep: error.keep ?? "unknown" }; }
}

export function gcPluginState({ dataDir = process.env.CLAUDE_PLUGIN_DATA, dryRun = false, now = Date.now() } = {}) {
  if (!dataDir) throw new Error("gc requires CLAUDE_PLUGIN_DATA (this plugin's data directory)");
  const root = path.resolve(dataDir, "state");
  if (!directoryExists(root)) return { skipped: "unsafe-root" };
  const stamp = path.join(root, ".gc");
  const lock = `${stamp}.lock`;
  let fd;
  if (!dryRun) {
    if (recentlySwept(stamp, now)) return { skipped: "daily" };
    fd = acquireLock(lock, now);
    if (fd === null) return { skipped: "locked" };
    fs.writeFileSync(fd, String(process.pid));
  }
  try {
    if (!dryRun && recentlySwept(stamp, now)) return { skipped: "daily" };
    if (!dryRun) {
      // Throttle failed/interrupted sweeps too; never follow a marker symlink.
      const marker = fs.openSync(stamp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
      try { fs.futimesSync(marker, now / 1000, now / 1000); } finally { fs.closeSync(marker); }
    }
    const summary = { scanned: 0, directories: 0, bytes: 0, jobs: 0,
      byRule: { workspaceMissing: { directories: 0, bytes: 0, jobs: 0 }, noJobs: { directories: 0, bytes: 0, jobs: 0 } },
      sessions: {}, kept: {} };
    const candidates = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      summary.scanned++;
      const dir = path.join(root, entry.name);
      let candidate = inspectStateDir(dir, now);
      if (!candidate.keep && !dryRun) {
        // A workspace or writer may have appeared since the first scan.
        candidate = inspectStateDir(dir, now);
        if (!candidate.keep) fs.rmSync(dir, { recursive: true });
      }
      if (candidate.keep) {
        summary.kept[candidate.keep] = (summary.kept[candidate.keep] ?? 0) + 1;
        continue;
      }
      candidates.push(candidate);
      for (const total of [summary, summary.byRule[candidate.reason]]) {
        total.directories++;
        total.bytes += candidate.bytes;
        total.jobs += candidate.jobs;
      }
      // Bytes are whole directories referenced by this session, not apportioned
      // between sessions that share a store.
      for (const [session, count] of Object.entries(candidate.sessions)) {
        const total = summary.sessions[session] ??= { directories: 0, bytes: 0, jobs: 0 };
        total.directories++;
        total.bytes += candidate.bytes;
        total.jobs += count;
      }
    }
    const prunedEntries = dryRun ? 0 : pruneMissingStateTaskEntries(root);
    return { dryRun, candidates, summary, prunedEntries };
  } finally {
    if (fd !== undefined && fd !== null) { fs.closeSync(fd); fs.unlinkSync(lock); }
  }
}

// The hook only stats the marker and launches an unreferenced, detached child.
// The child owns the lock for the entire sweep, including index pruning.
export function scheduleStateGc({ dataDir = process.env.CLAUDE_PLUGIN_DATA, now = Date.now(), spawn = spawnProcess } = {}) {
  if (!dataDir) return false;
  try {
    dataDir = path.resolve(dataDir);
    const root = path.resolve(dataDir, "state");
    if (!directoryExists(root) || recentlySwept(path.join(root, ".gc"), now)) return false;
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
      detached: true, stdio: "ignore", cwd: dataDir, env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir }
    });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch { return false; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { gcPluginState(); } catch { /* Opportunistic cleanup is best effort. */ }
}
