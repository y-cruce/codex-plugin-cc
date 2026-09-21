import fs from "node:fs/promises";
import path from "node:path";

import { resolveStateDir } from "./state.mjs";
import { canonicalWorkspaceRoot, jobIndexPath, legacyJobHistoryPaths, threadIndexPath, threadRecordPaths } from "./thread-records.mjs";

// resolveStateDir does a synchronous realpath and a hash on every call, and the
// pane asks for a live-view path per job per poll. The key carries the plugin
// data directory because that is what the state directory hangs off.
const STATE_DIRS = new Map();
export function stateDirFor(cwd) {
  const key = `${process.env.CLAUDE_PLUGIN_DATA ?? ""}\0${path.resolve(cwd)}`;
  if (!STATE_DIRS.has(key)) STATE_DIRS.set(key, resolveStateDir(cwd));
  return STATE_DIRS.get(key);
}

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function corruptIndex(file) {
  return Object.assign(new Error(`History index is invalid: ${file}`), { code: "HISTORY_INDEX_CORRUPT" });
}

export function resolveLegacyJobHistory(cwd, jobId, { stateDir = stateDirFor(cwd) } = {}) {
  return legacyJobHistoryPaths(stateDir, jobId);
}

export async function resolveJobHistoryAtStateDir(stateDir, jobId) {
  const legacy = legacyJobHistoryPaths(stateDir, jobId);
  const file = jobIndexPath(stateDir, jobId);
  const index = await readJson(file);
  if (!index) return legacy;
  if (index.schemaVersion !== 1 || index.jobId !== jobId || index.roundId !== jobId || typeof index.recordId !== "string") {
    throw corruptIndex(file);
  }
  return threadRecordPaths(stateDir, index.recordId, index.roundId);
}

export function resolveJobHistory(cwd, jobId, { stateDir = stateDirFor(cwd) } = {}) {
  return resolveJobHistoryAtStateDir(stateDir, jobId);
}

export async function resolveThreadRecord(workspaceRoot, executorKey, threadId, { stateDir = stateDirFor(workspaceRoot) } = {}) {
  const file = threadIndexPath(stateDir, workspaceRoot, executorKey, threadId);
  const index = await readJson(file);
  if (!index) return null;
  if (index.schemaVersion !== 1 || index.workspaceRoot !== canonicalWorkspaceRoot(workspaceRoot) ||
    index.executorKey !== executorKey || index.threadId !== threadId || typeof index.recordId !== "string") {
    throw corruptIndex(file);
  }
  return threadRecordPaths(stateDir, index.recordId);
}

export async function readRoundContext(cwd, jobId, { stateDir = stateDirFor(cwd) } = {}) {
  const location = await resolveJobHistoryAtStateDir(stateDir, jobId);
  if (location.layout === "legacy") return { layout: "legacy", location };
  const manifest = await readJson(location.manifest);
  const receipt = await readJson(location.roundReceipt);
  if (!manifest || !receipt || receipt.jobId !== jobId || receipt.recordId !== location.recordId) {
    throw corruptIndex(location.roundReceipt);
  }
  return { layout: "thread-record", location, recordId: location.recordId,
    activeRoundId: manifest.activeRoundId ?? null, threadId: manifest.threadId ?? null, receipt };
}
