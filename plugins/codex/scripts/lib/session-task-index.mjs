import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const indexed = new Set();
const WAIT = new Int32Array(new SharedArrayBuffer(4));
const DAY = 86_400_000;

export function sessionTaskIndexPath(stateRoot, sessionId) {
  const data = path.basename(stateRoot) === "state" ? path.dirname(stateRoot) : stateRoot;
  const key = createHash("sha256").update(sessionId).digest("hex");
  return path.join(data, "session-jobs", `${key}.jsonl`);
}

export function parseSessionTaskIndex(contents) {
  const entries = new Map();
  let complete = false;
  for (const line of contents.split("\n")) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row?.complete === true) complete = true;
    if (typeof row?.stateDir === "string" && typeof row.jobId === "string" && row.jobId &&
      ![".", ".."].includes(row.jobId) && path.basename(row.jobId) === row.jobId) {
      entries.set(`${row.stateDir}\0${row.jobId}`, row);
    }
  }
  return { complete, entries: [...entries.values()] };
}

function withIndexLock(file, action) {
  const lock = `${file}.lock`;
  const deadline = Date.now() + 5000;
  let fd;
  while (fd === undefined) {
    try { fd = fs.openSync(lock, "wx"); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const stat = fs.statSync(lock);
        const owner = Number(fs.readFileSync(lock, "utf8"));
        let dead = !owner && Date.now() - stat.mtimeMs > 1000;
        if (owner > 0) {
          try { process.kill(owner, 0); } catch (error) { dead = error.code === "ESRCH"; }
        }
        if (dead) {
          const current = fs.statSync(lock);
          if (current.ino === stat.ino && current.mtimeMs === stat.mtimeMs) fs.unlinkSync(lock);
          continue;
        }
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for session task index: ${file}`);
      Atomics.wait(WAIT, 0, 0, 10);
    }
  }
  try {
    fs.writeFileSync(fd, String(process.pid));
    return action();
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}

// Serialize both migration and normal writers. The completion marker is written
// with the discovered references, so concurrent first listings merge once.
export function mergeSessionTaskIndex(stateRoot, sessionId, entries, complete = false) {
  const file = sessionTaskIndexPath(stateRoot, sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  withIndexLock(file, () => {
    let contents = "";
    try { contents = fs.readFileSync(file, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    const existing = parseSessionTaskIndex(contents);
    const known = new Set(existing.entries.map(row => `${row.stateDir}\0${row.jobId}`));
    const rows = [];
    for (const entry of entries) {
      const key = `${entry.stateDir}\0${entry.jobId}`;
      if (!known.has(key)) { rows.push({ ...entry, sessionId }); known.add(key); }
    }
    if (complete && !existing.complete) rows.push({ complete: true, sessionId });
    if (rows.length || !fs.existsSync(file)) {
      fs.appendFileSync(file, `${contents && !contents.endsWith("\n") ? "\n" : ""}${rows.map(row => JSON.stringify(row)).join("\n")}\n`);
    }
    const now = new Date();
    fs.utimesSync(file, now, now);
  });
  return file;
}

// At most one metadata sweep per hour. Only expired index files are removed;
// job records, history and state directories remain available for migration.
export function pruneSessionTaskIndexes(stateRoot, now = Date.now()) {
  const directory = path.dirname(sessionTaskIndexPath(stateRoot, ""));
  const stamp = path.join(directory, ".gc");
  try {
    try { if (fs.statSync(stamp).mtimeMs > now - 3_600_000) return; } catch (error) { if (error.code !== "ENOENT") throw error; }
    for (const name of fs.readdirSync(directory)) {
      if (!name.endsWith(".jsonl")) continue;
      const file = path.join(directory, name);
      if (fs.statSync(file).mtimeMs >= now - 7 * DAY) continue;
      // Skip a concurrent append/migration; a later sweep can reconsider it.
      let lock;
      try { lock = fs.openSync(`${file}.lock`, "wx"); } catch (error) { if (error.code === "EEXIST") continue; throw error; }
      try { if (fs.statSync(file).mtimeMs < now - 7 * DAY) fs.unlinkSync(file); }
      finally { fs.closeSync(lock); fs.unlinkSync(`${file}.lock`); }
    }
    fs.writeFileSync(stamp, "");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
}

// writeJobFile is shared by initial dispatches and queued follow-up rounds.
export function indexSessionTask(stateDir, job) {
  if (!job.sessionId) return;
  const stateRoot = path.dirname(stateDir);
  const key = `${stateDir}\0${job.sessionId}\0${job.id}`;
  if (indexed.has(key)) return;
  mergeSessionTaskIndex(stateRoot, job.sessionId, [{ stateDir, jobId: job.id, createdAt: job.createdAt ?? job.startedAt }]);
  indexed.add(key);
  pruneSessionTaskIndexes(stateRoot);
}
