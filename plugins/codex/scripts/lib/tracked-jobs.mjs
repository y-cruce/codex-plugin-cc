import fs from "node:fs";
import process from "node:process";
import { finishObservedJob } from "./observation-client.mjs";
import { jobStatusForTerminal } from "./executor-port.mjs";

import { readJobFile, resolveJobFile, resolveJobLogFile, upsertJob, writeJobFile } from "./state.mjs";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";

export function nowIso() {
  return new Date().toISOString();
}

function normalizeProgressEvent(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      message: String(value.message ?? "").trim(),
      phase: typeof value.phase === "string" && value.phase.trim() ? value.phase.trim() : null,
      executor: typeof value.executor === "string" && value.executor.trim() ? value.executor.trim() : null,
      executorSessionId: typeof value.executorSessionId === "string" && value.executorSessionId.trim() ? value.executorSessionId.trim() : null,
      threadId: typeof value.threadId === "string" && value.threadId.trim() ? value.threadId.trim() : null,
      turnId: typeof value.turnId === "string" && value.turnId.trim() ? value.turnId.trim() : null,
      controlEndpoint: typeof value.controlEndpoint === "string" && value.controlEndpoint.trim() ? value.controlEndpoint.trim() : null,
      executorEffort: typeof value.executorEffort === "string" && value.executorEffort.trim() ? value.executorEffort.trim() : null,
      stderrMessage: value.stderrMessage == null ? null : String(value.stderrMessage).trim(),
      logTitle: typeof value.logTitle === "string" && value.logTitle.trim() ? value.logTitle.trim() : null,
      logBody: value.logBody == null ? null : String(value.logBody).trimEnd()
    };
  }

  return {
    message: String(value ?? "").trim(),
    phase: null,
    executor: null,
    executorSessionId: null,
    threadId: null,
    turnId: null,
    controlEndpoint: null,
    executorEffort: null,
    stderrMessage: String(value ?? "").trim(),
    logTitle: null,
    logBody: null
  };
}

export function appendLogLine(logFile, message) {
  const normalized = String(message ?? "").trim();
  if (!logFile || !normalized) {
    return;
  }
  fs.appendFileSync(logFile, `[${nowIso()}] ${normalized}\n`, "utf8");
}

export function appendLogBlock(logFile, title, body) {
  if (!logFile || !body) {
    return;
  }
  fs.appendFileSync(logFile, `\n[${nowIso()}] ${title}\n${String(body).trimEnd()}\n`, "utf8");
}

export function createJobLogFile(workspaceRoot, jobId, title) {
  const logFile = resolveJobLogFile(workspaceRoot, jobId);
  fs.writeFileSync(logFile, "", "utf8");
  if (title) {
    appendLogLine(logFile, `Starting ${title}.`);
  }
  return logFile;
}

export function createJobRecord(base, options = {}) {
  const env = options.env ?? process.env;
  const sessionId = env[options.sessionIdEnv ?? SESSION_ID_ENV];
  return {
    ...base,
    createdAt: nowIso(),
    ...(sessionId ? { sessionId } : {})
  };
}

export function createJobProgressUpdater(workspaceRoot, jobId) {
  let lastPhase = null;
  let lastExecutor = null;
  let lastExecutorSessionId = null;
  let lastThreadId = null;
  let lastTurnId = null;
  let lastControlEndpoint = null;
  let lastExecutorEffort = null;

  return (event) => {
    const normalized = normalizeProgressEvent(event);
    const patch = { id: jobId };
    let changed = false;

    if (normalized.phase && normalized.phase !== lastPhase) {
      lastPhase = normalized.phase;
      patch.phase = normalized.phase;
      changed = true;
    }

    if (normalized.executor && normalized.executor !== lastExecutor) {
      lastExecutor = normalized.executor;
      patch.executor = normalized.executor;
      changed = true;
    }

    if (normalized.executorSessionId && normalized.executorSessionId !== lastExecutorSessionId) {
      lastExecutorSessionId = normalized.executorSessionId;
      patch.executorSessionId = normalized.executorSessionId;
      changed = true;
    }

    if (normalized.threadId && normalized.threadId !== lastThreadId) {
      lastThreadId = normalized.threadId;
      patch.threadId = normalized.threadId;
      changed = true;
    }

    if (normalized.turnId && normalized.turnId !== lastTurnId) {
      lastTurnId = normalized.turnId;
      patch.turnId = normalized.turnId;
      changed = true;
    }

    if (normalized.controlEndpoint && normalized.controlEndpoint !== lastControlEndpoint) {
      lastControlEndpoint = normalized.controlEndpoint;
      patch.controlEndpoint = normalized.controlEndpoint;
      changed = true;
    }

    if (normalized.executorEffort && normalized.executorEffort !== lastExecutorEffort) {
      lastExecutorEffort = normalized.executorEffort;
      patch.executorEffort = normalized.executorEffort;
      changed = true;
    }

    if (!changed) {
      return;
    }

    upsertJob(workspaceRoot, patch);

    const jobFile = resolveJobFile(workspaceRoot, jobId);
    if (!fs.existsSync(jobFile)) {
      return;
    }

    const storedJob = readJobFile(jobFile);
    writeJobFile(workspaceRoot, jobId, {
      ...storedJob,
      ...patch
    });
  };
}

export function createProgressReporter({ stderr = false, logFile = null, onEvent = null } = {}) {
  if (!stderr && !logFile && !onEvent) {
    return null;
  }

  return (eventOrMessage) => {
    const event = normalizeProgressEvent(eventOrMessage);
    const stderrMessage = event.stderrMessage ?? event.message;
    if (stderr && stderrMessage) {
      process.stderr.write(`[codex] ${stderrMessage}\n`);
    }
    appendLogLine(logFile, event.message);
    appendLogBlock(logFile, event.logTitle, event.logBody);
    onEvent?.(event);
  };
}

function readStoredJobOrNull(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

export async function runTrackedJob(job, runner, options = {}) {
  const runningRecord = {
    ...job,
    status: "running",
    startedAt: nowIso(),
    phase: "starting",
    pid: process.pid,
    logFile: options.logFile ?? job.logFile ?? null
  };
  writeJobFile(job.workspaceRoot, job.id, runningRecord);
  upsertJob(job.workspaceRoot, runningRecord);

  try {
    const execution = await runner();
    const completionStatus = jobStatusForTerminal(execution.terminal, execution.exitStatus);
    const completedAt = nowIso();
    const executorSessionId = execution.sessionId ?? execution.executorSessionId ?? execution.threadId ?? null;
    const executor = execution.executor ?? runningRecord.executor ?? "codex";
    const terminalMessage = completionStatus === "completed" ? null
      : execution.terminal?.reason?.message ?? execution.terminal?.reason?.code ?? null;
    const result = execution.terminal
      ? { ...execution.payload, terminal: execution.terminal }
      : execution.payload;
    const existing = readStoredJobOrNull(job.workspaceRoot, job.id) ?? runningRecord;
    writeJobFile(job.workspaceRoot, job.id, {
      ...existing,
      status: completionStatus,
      executor,
      executorSessionId,
      threadId: execution.threadId ?? null,
      turnId: execution.turnId ?? null,
      pid: null,
      phase: completionStatus === "completed" ? "done" : completionStatus,
      completedAt,
      ...(terminalMessage ? { errorMessage: terminalMessage } : {}),
      result,
      rendered: execution.rendered
    });
    upsertJob(job.workspaceRoot, {
      id: job.id,
      status: completionStatus,
      executor,
      executorSessionId,
      threadId: execution.threadId ?? null,
      turnId: execution.turnId ?? null,
      summary: execution.summary,
      phase: completionStatus === "completed" ? "done" : completionStatus,
      pid: null,
      ...(terminalMessage ? { errorMessage: terminalMessage } : {}),
      completedAt
    });
    appendLogBlock(options.logFile ?? job.logFile ?? null, "Final output", execution.rendered);
    await finishObservedJob(job.workspaceRoot, job.id);
    return execution;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const existing = readStoredJobOrNull(job.workspaceRoot, job.id) ?? runningRecord;
    const completedAt = nowIso();
    writeJobFile(job.workspaceRoot, job.id, {
      ...existing,
      status: "failed",
      phase: "failed",
      errorMessage,
      pid: null,
      completedAt,
      logFile: options.logFile ?? job.logFile ?? existing.logFile ?? null
    });
    upsertJob(job.workspaceRoot, {
      id: job.id,
      status: "failed",
      phase: "failed",
      pid: null,
      errorMessage,
      completedAt
    });
    await finishObservedJob(job.workspaceRoot, job.id);
    throw error;
  }
}
