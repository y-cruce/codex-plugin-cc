import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ACTIVE_STORES } from "./thread-records.mjs";

export const liveJob = (job) => job?.status === "queued" || job?.status === "running";

function entries(directory) {
  try {
    if (!fs.lstatSync(directory).isDirectory()) throw new Error("Unsafe history directory");
    return fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) { if (error.code === "ENOENT") return []; throw error; }
}

function readJson(file) {
  try {
    if (!fs.lstatSync(file).isFile()) throw new Error("Unsafe history metadata");
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function ownerAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== "ESRCH"; }
}

function writerActive(directory, manifest) {
  if (ACTIVE_STORES.has(directory) || (!manifest.closed && ownerAlive(manifest.writerPid))) return true;
  const lock = readJson(path.join(directory, "writer.lock"));
  return lock !== null && ownerAlive(lock.pid);
}

// Use the writer's populated-file/link protocol, so deletion cannot race an
// already acquired lease, including a writer in another broker process.
function acquirePruner(directory) {
  const lock = path.join(directory, "writer.lock");
  const previous = readJson(lock);
  if (previous) {
    if (ownerAlive(previous.pid)) return null;
    if (JSON.stringify(readJson(lock)) !== JSON.stringify(previous)) return null;
    fs.unlinkSync(lock);
  }
  const lease = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
  const temporary = path.join(directory, `.writer-${process.pid}-${randomUUID()}.tmp`);
  fs.writeFileSync(temporary, lease, { flag: "wx" });
  try {
    fs.linkSync(temporary, lock);
    return lease;
  } catch (error) { if (error.code === "EEXIST") return null; throw error; }
  finally { fs.unlinkSync(temporary); }
}

function directoryBytes(directory) {
  let bytes = 0;
  for (const entry of entries(directory)) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) bytes += directoryBytes(file);
    else if (entry.isFile()) bytes += fs.lstatSync(file).size;
    else throw new Error("Unsafe history entry");
  }
  return bytes;
}

// Synchronous for state.json's existing synchronous write path. Unknown
// metadata keeps the record; segments are only stat'ed, never read or rewritten.
export function pruneThreadRecords(stateDir, { keptJobs = null, dryRun = false } = {}) {
  const removed = [];
  let keptIds;
  let keptRecords;
  let indexes;
  let records;
  try {
    const jobs = keptJobs ?? readJson(path.join(stateDir, "state.json"))?.jobs ?? [];
    keptIds = new Set(jobs.map((job) => job.id));
    keptRecords = new Set(jobs.map((job) => job.recordId).filter(Boolean));
    for (const entry of entries(path.join(stateDir, "jobs"))) {
      if (!entry.name.endsWith(".json")) continue;
      const job = readJson(path.join(stateDir, "jobs", entry.name));
      if (!job?.id) return removed;
      keptIds.add(job.id);
      if (job.recordId) keptRecords.add(job.recordId);
    }
    indexes = ["job-index", "thread-index"].flatMap((name) => entries(path.join(stateDir, name))
      .filter((entry) => entry.name.endsWith(".json"))
      .map((entry) => {
        const file = path.join(stateDir, name, entry.name);
        const index = readJson(file);
        if (name === "job-index" && keptIds.has(index?.jobId)) keptRecords.add(index.recordId);
        return { file, index };
      }));
    records = entries(path.join(stateDir, "thread-records"));
  } catch { return removed; }

  for (const entry of records) {
    if (!entry.isDirectory() || keptRecords.has(entry.name)) continue;
    const directory = path.join(stateDir, "thread-records", entry.name);
    let lease;
    try {
      const manifest = readJson(path.join(directory, "manifest.json"));
      if (!manifest || writerActive(directory, manifest)) continue;
      const lock = path.join(directory, "writer.lock");
      const previousLockBytes = fs.existsSync(lock) ? fs.lstatSync(lock).size : 0;
      if (!dryRun) {
        lease = acquirePruner(directory);
        if (!lease) continue;
      }
      let keep = false;
      const rounds = entries(path.join(directory, "rounds"));
      for (const round of rounds) {
        if (!round.name.endsWith(".json")) continue;
        const receipt = readJson(path.join(directory, "rounds", round.name));
        const id = round.name.slice(0, -5);
        if (!receipt || keptIds.has(id) || fs.existsSync(path.join(stateDir, "jobs", round.name)) ||
            !["completed", "failed", "cancelled"].includes(receipt.status ?? receipt.job?.status) ||
            liveJob(receipt.job)) { keep = true; break; }
      }
      if (manifest.activeRoundId && !rounds.some((round) => round.name === `${manifest.activeRoundId}.json`)) keep = true;
      if (keep) continue;
      const links = indexes.filter(({ index }) => index?.recordId === entry.name);
      // Don't count the temporary pruning lease as reclaimable history bytes.
      const bytes = directoryBytes(directory) + (lease ? previousLockBytes - Buffer.byteLength(lease) : 0)
        + links.reduce((sum, { file }) => sum + fs.lstatSync(file).size, 0);
      if (!dryRun) {
        fs.rmSync(directory, { recursive: true });
        for (const { file } of links) {
          if (readJson(file)?.recordId === entry.name) fs.unlinkSync(file);
        }
      }
      removed.push({ stateDir, recordId: entry.name, reason: "orphanThreadRecords", bytes, jobs: 0, sessions: {} });
    } catch { /* Incomplete metadata or a concurrent writer keeps the record. */ }
    finally {
      const lock = path.join(directory, "writer.lock");
      if (lease && fs.existsSync(lock) && fs.readFileSync(lock, "utf8") === lease) fs.unlinkSync(lock);
    }
  }
  return removed;
}
