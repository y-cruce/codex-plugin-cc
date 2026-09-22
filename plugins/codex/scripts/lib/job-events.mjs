import { setTimeout } from "node:timers/promises";
import { buildStatusSnapshot, checkJobLiveness, DEFAULT_STALL_MS, lastJobProgressAt, readStoredJob } from "./job-control.mjs";
import { acknowledgeNotifications, liveStatus } from "./live-commands.mjs";
import { readRoundContext } from "./history-resolver.mjs";
import { resolveStateDir } from "./state.mjs";
import { claimQuestion } from "./question-report.mjs";
import { THREAD_RECORDS_ENABLED } from "./thread-records.mjs";

export const DEFAULT_QUESTION_REMIND_MS = 120000;

function oneLine(text) {
  return String(text ?? "").replace(/[\r\n]+/g, " ");
}

export async function streamJobEvents(cwd, { pollMs = 2000, stallMs = DEFAULT_STALL_MS, questionRemindMs = DEFAULT_QUESTION_REMIND_MS,
  exitIdleMs = 3600000, signal, session, threadRecords = THREAD_RECORDS_ENABLED } = {}, dependencies = {}) {
  const snapshot = dependencies.snapshot ?? buildStatusSnapshot;
  const status = dependencies.status ?? liveStatus;
  const acknowledge = dependencies.acknowledge ?? acknowledgeNotifications;
  const readJob = dependencies.readJob ?? readStoredJob;
  const writeLine = dependencies.writeLine ?? ((line) => process.stdout.write(`${line}\n`));
  const now = dependencies.now ?? Date.now;
  const progressAt = dependencies.progressAt ?? lastJobProgressAt;
  const claim = dependencies.claimQuestion ?? ((cwd, jobId, requestId) => claimQuestion(resolveStateDir(cwd), jobId, requestId));
  const roundContext = dependencies.roundContext ?? ((cwd, jobId) => readRoundContext(cwd, jobId));
  const active = new Set();
  const questions = new Map();
  const notifications = new Set();
  const brokerFailures = new Map();
  const stalls = new Map();
  let lastActiveAt = now();
  while (!signal?.aborted) {
    const report = snapshot(cwd, { all: true, threadRecords: false });
    const jobs = [...report.running, report.latestFinished, ...report.recent]
      .filter((job) => job && (session === undefined || job.sessionId === session));
    for (let job of jobs) {
      if (signal?.aborted) break;
      let running = job.status === "queued" || job.status === "running";
      if (running) active.add(job.id);
      if (!active.has(job.id)) continue;
      const context = threadRecords ? await roundContext(report.workspaceRoot ?? cwd, job.id) : null;
      const currentRound = !context || context.layout === "legacy" || context.activeRoundId === job.id;
      let live = currentRound ? await status(cwd, job) : null;
      if (signal?.aborted) continue;
      job = checkJobLiveness(report.workspaceRoot ?? cwd, job, live, brokerFailures, dependencies);
      const jobPrefix = `job=${job.id}${job.label ? ` [${oneLine(job.label)}]` : ""}`;
      // A dead owner must be reported even when its pending notes cannot be acknowledged.
      if (job.status === "failed" && (job.errorMessage === "owner process exited" || job.errorMessage === "broker unreachable")) live = null;
      running = job.status === "queued" || job.status === "running";
      const pendingQuestions = live?.questions ?? [];
      if (job.status === "running" && pendingQuestions.length === 0) {
        const progress = progressAt(job);
        const previous = stalls.get(job.id);
        const lastReported = previous?.progress === progress ? previous.reportedAt : progress;
        if (now() - lastReported >= stallMs) {
          writeLine(`STALLED ${jobPrefix} thread=${job.threadId ?? "unknown"} ${Math.max(0, Math.floor((now() - progress) / 60000))}m without progress`);
          lastActiveAt = now();
          stalls.set(job.id, { progress, reportedAt: now() });
        }
      }
      if (running && live?.unavailable) continue;
      for (const question of pendingQuestions) {
        const key = `${job.id}:${question.requestId}`;
        const previous = questions.get(key);
        if (previous) {
          const time = now();
          if (running && time - previous.reportedAt >= questionRemindMs) {
            const minutes = Math.max(0, Math.floor((time - previous.firstSeenAt) / 60000));
            const expires = question.expiresAt == null ? "" : `, expires in ${Math.max(0, Math.floor((question.expiresAt - time) / 60000))}m`;
            writeLine(`QUESTION_PENDING ${jobPrefix} request=${question.requestId} ${minutes}m unanswered${expires}: ${oneLine(question.questions?.[0]?.question).slice(0, 200)}`);
            lastActiveAt = now();
            previous.reportedAt = time;
          }
          continue;
        }
        const first = await claim(report.workspaceRoot ?? cwd, job.id, question.requestId);
        const text = oneLine(question.message ?? question.questions?.[0]?.question).slice(0, 200);
        writeLine(first ? `QUESTION ${jobPrefix} request=${question.requestId} ${text}`
          : `QUESTION_PENDING ${jobPrefix} request=${question.requestId} still unanswered: ${text}`);
        lastActiveAt = now();
        questions.set(key, { firstSeenAt: lastActiveAt, reportedAt: lastActiveAt });
      }
      const pending = (live?.notifications ?? []).filter((note) => !notifications.has(`${job.id}:${note.id}`));
      if (pending.length) {
        try {
          await acknowledge(cwd, job, pending.map((note) => note.id));
        } catch {
          continue;
        }
        for (const note of pending) {
          const requestId = note.pendingRequestId;
          const pendingField = requestId == null ? "" : ` pending_request=${requestId}`;
          writeLine(`NOTIFIED ${jobPrefix} thread=${job.threadId ?? "unknown"}${pendingField} ${oneLine(note.message)}`);
          lastActiveAt = now();
          notifications.add(`${job.id}:${note.id}`);
        }
      }
      if (!running) {
        const prefix = `${jobPrefix} thread=${job.threadId ?? "unknown"}`;
        if (job.status === "completed") {
          writeLine(`DONE ${prefix}`);
          lastActiveAt = now();
        } else {
          const error = job.errorMessage ?? readJob(report.workspaceRoot, job.id)?.result?.error?.message;
          writeLine(`FAILED ${prefix} ${String(error ?? "").split(/[\r\n]/)[0] || "unknown"}`);
          lastActiveAt = now();
        }
        active.delete(job.id);
      }
    }
    if (active.size) lastActiveAt = now();
    if (!active.size && now() - lastActiveAt >= exitIdleMs) {
      writeLine(`IDLE_EXIT no active job for ${Math.floor(exitIdleMs / 60000)}m; re-arm the monitor before the next dispatch`);
      return;
    }
    try {
      await setTimeout(pollMs, undefined, { signal });
    } catch (error) {
      if (error.name !== "AbortError") throw error;
    }
  }
}
