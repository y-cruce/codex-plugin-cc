import { setTimeout } from "node:timers/promises";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { buildStatusSnapshot, checkJobLiveness, DEFAULT_STALL_MS, lastJobProgressAt, readStoredJob } from "./job-control.mjs";
import { acknowledgeNotifications, liveStatus } from "./live-commands.mjs";
import { readRoundContext } from "./history-resolver.mjs";
import { resolveStateDir } from "./state.mjs";
import { claimQuestion } from "./question-report.mjs";
import { THREAD_RECORDS_ENABLED } from "./thread-records.mjs";
import { atomicJson } from "./job-event-store.mjs";

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
  const writeLine = dependencies.writeLine ?? ((line) => new Promise((resolve, reject) => {
    process.stdout.write(`${line}\n`, (error) => error ? reject(error) : resolve());
  }));
  const now = dependencies.now ?? Date.now;
  const progressAt = dependencies.progressAt ?? lastJobProgressAt;
  const claim = dependencies.claimQuestion ?? ((cwd, jobId, requestId) => claimQuestion(resolveStateDir(cwd), jobId, requestId));
  const roundContext = dependencies.roundContext ?? ((cwd, jobId) => readRoundContext(cwd, jobId));
  // Monitor processes expire; a session's baseline and terminal receipts must not.
  const terminalReportsFile = session === undefined ? null : dependencies.terminalReportsFile
    ?? path.join(resolveStateDir(cwd), "event-monitors", `${createHash("sha256").update(session).digest("hex")}.json`);
  let reported = new Set();
  let initialized = !terminalReportsFile;
  if (terminalReportsFile) {
    try {
      reported = new Set(JSON.parse(await fs.readFile(terminalReportsFile, "utf8")));
      initialized = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
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
    if (signal?.aborted) break;
    // The first snapshot establishes what was already over before this watch.
    // Save even an empty baseline, or a restart would silently reset its scope.
    if (!initialized) {
      for (const job of jobs) {
        if (job.status !== "queued" && job.status !== "running") reported.add(job.id);
      }
      await fs.mkdir(path.dirname(terminalReportsFile), { recursive: true });
      await atomicJson(terminalReportsFile, [...reported]);
      initialized = true;
    }
    for (let job of jobs) {
      if (signal?.aborted) break;
      let running = job.status === "queued" || job.status === "running";
      if (running) active.add(job.id);
      // A replacement catches terminals after the persisted baseline, including
      // jobs dispatched and completed entirely between two watches.
      else if (terminalReportsFile && !reported.has(job.id)) active.add(job.id);
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
          await writeLine(`STALLED ${jobPrefix} thread=${job.threadId ?? "unknown"} ${Math.max(0, Math.floor((now() - progress) / 60000))}m without progress`);
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
            await writeLine(`QUESTION_PENDING ${jobPrefix} request=${question.requestId} ${minutes}m unanswered${expires}: ${oneLine(question.questions?.[0]?.question).slice(0, 200)}`);
            lastActiveAt = now();
            previous.reportedAt = time;
          }
          continue;
        }
        const first = await claim(report.workspaceRoot ?? cwd, job.id, question.requestId);
        const text = oneLine(question.message ?? question.questions?.[0]?.question).slice(0, 200);
        await writeLine(first ? `QUESTION ${jobPrefix} request=${question.requestId} ${text}`
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
          await writeLine(`NOTIFIED ${jobPrefix} thread=${job.threadId ?? "unknown"}${pendingField} ${oneLine(note.message)}`);
          lastActiveAt = now();
          notifications.add(`${job.id}:${note.id}`);
        }
      }
      if (!running) {
        const prefix = `${jobPrefix} thread=${job.threadId ?? "unknown"}`;
        if (job.status === "completed") {
          await writeLine(`DONE ${prefix}`);
          lastActiveAt = now();
        } else {
          const error = job.errorMessage ?? readJob(report.workspaceRoot, job.id)?.result?.error?.message;
          await writeLine(`FAILED ${prefix} ${String(error ?? "").split(/[\r\n]/)[0] || "unknown"}`);
          lastActiveAt = now();
        }
        if (terminalReportsFile) {
          reported.add(job.id);
          await fs.mkdir(path.dirname(terminalReportsFile), { recursive: true });
          await atomicJson(terminalReportsFile, [...reported]);
        }
        active.delete(job.id);
      }
    }
    if (active.size) lastActiveAt = now();
    if (!active.size && now() - lastActiveAt >= exitIdleMs) {
      await writeLine(`IDLE_EXIT no active job for ${Math.floor(exitIdleMs / 60000)}m; re-arm the monitor before the next dispatch`);
      return;
    }
    try {
      await setTimeout(pollMs, undefined, { signal });
    } catch (error) {
      if (error.name !== "AbortError") throw error;
    }
  }
}
