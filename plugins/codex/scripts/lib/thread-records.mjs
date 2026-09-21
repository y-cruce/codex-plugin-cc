import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const LEGACY_CURSOR_VERSION = 1;
export const THREAD_RECORD_CURSOR_VERSION = 2;
export const THREAD_RECORDS_ENABLED = true;

function identifier(value, label) {
  if (!value || path.basename(value) !== value || value === "." || value === "..") {
    const message = label === "job id" ? `Unknown job: ${value}` : `Invalid ${label}: ${value}`;
    throw Object.assign(new Error(message), { code: "UNKNOWN_JOB" });
  }
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalWorkspaceRoot(cwd) {
  const workspaceRoot = path.resolve(cwd);
  try { return fs.realpathSync.native(workspaceRoot); }
  catch { return workspaceRoot; }
}

export function executorKeyFor({ executor = "codex", command = null, args = [] } = {}) {
  if (executor === "codex") return "codex";
  if (executor !== "acp") throw new Error(`Unsupported executor: ${executor}`);
  // ACP session ids are agent-local, so command and args namespace the session.
  if (typeof command !== "string" || !command.trim()) {
    throw new Error("ACP executor identity requires its command.");
  }
  if (!Array.isArray(args) || args.some((value) => typeof value !== "string")) {
    throw new Error("ACP executor identity requires an array of string arguments.");
  }
  return `acp:${sha256(JSON.stringify([command.trim(), args]))}`;
}

export function threadIndexHash(workspaceRoot, executorKey, threadId) {
  if (typeof executorKey !== "string" || !executorKey) throw new Error("executorKey is required.");
  if (typeof threadId !== "string" || !threadId) throw new Error("threadId is required.");
  // The NUL-delimited tuple is the canonical thread-index key material.
  return sha256(`${canonicalWorkspaceRoot(workspaceRoot)}\0${executorKey}\0${threadId}`);
}

export function legacyJobHistoryPaths(stateDir, jobId) {
  const roundId = identifier(jobId, "job id");
  const directory = path.join(stateDir, "job-history", roundId);
  return {
    layout: "legacy",
    recordId: roundId,
    roundId,
    jobId: roundId,
    directory,
    manifest: path.join(directory, "manifest.json"),
    segments: path.join(directory, "segments"),
    liveView: path.join(directory, "live-view.json"),
    roundReceipt: null
  };
}

export function threadRecordPaths(stateDir, recordId, roundId = null) {
  const safeRecordId = identifier(recordId, "record id");
  const directory = path.join(stateDir, "thread-records", safeRecordId);
  const rounds = path.join(directory, "rounds");
  return {
    layout: "thread-record",
    recordId: safeRecordId,
    roundId,
    jobId: roundId,
    directory,
    manifest: path.join(directory, "manifest.json"),
    segments: path.join(directory, "segments"),
    liveView: path.join(directory, "live-view.json"),
    rounds,
    roundReceipt: roundId ? path.join(rounds, `${identifier(roundId, "round id")}.json`) : null
  };
}

export function jobIndexPath(stateDir, jobId) {
  return path.join(stateDir, "job-index", `${identifier(jobId, "job id")}.json`);
}

export function threadIndexPath(stateDir, workspaceRoot, executorKey, threadId) {
  return path.join(stateDir, "thread-index", `${threadIndexHash(workspaceRoot, executorKey, threadId)}.json`);
}

export function historyCursorVersion(value) {
  if (value?.protocolVersion === LEGACY_CURSOR_VERSION) return LEGACY_CURSOR_VERSION;
  if (value?.protocolVersion === THREAD_RECORD_CURSOR_VERSION) return THREAD_RECORD_CURSOR_VERSION;
  return null;
}
