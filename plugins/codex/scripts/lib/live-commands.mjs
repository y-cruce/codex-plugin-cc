import fs from "node:fs";
import path from "node:path";
import { buildSingleJobSnapshot } from "./job-control.mjs";
import { ObservationClient } from "./observation-client.mjs";

function executorSessionId(job) {
  return job.executorSessionId ?? job.threadId ?? null;
}

async function withLiveClient(cwd, job, action, options = {}) {
  const client = await ObservationClient.connect(cwd, { ...options, job });
  try {
    return await action(client);
  } finally {
    await client.close();
  }
}

export async function liveStatus(cwd, job, options = {}) {
  try {
    return await withLiveClient(cwd, job, (client) => client.request("executor/status", {
      jobId: job.id,
      executor: job.executor ?? "codex",
      executorSessionId: executorSessionId(job)
    }), { brokerTimeoutMs: 5000, ...options });
  } catch (error) {
    return { unavailable: error.message };
  }
}

export async function acknowledgeNotifications(cwd, job, ids) {
  return withLiveClient(cwd, job, (client) => client.request("executor/ack-notifications", {
    jobId: job.id,
    executorSessionId: executorSessionId(job),
    ids
  }), { brokerTimeoutMs: 5000 });
}

export async function sendLiveCommand(cwd, reference, command, options, text) {
  if (!reference) throw new Error("Pass an explicit job ID from /codex:status.");
  const { job } = buildSingleJobSnapshot(cwd, reference);
  if (job.jobClass !== "task" || job.status !== "running" || !executorSessionId(job)) {
    throw new Error("This command requires a running task with a known executor session and turn.");
  }
  return withLiveClient(cwd, job, async (client) => {
    const params = { jobId: job.id, executorSessionId: executorSessionId(job), turnId: job.turnId };
    if (command === "answer") {
      if (!options["request-id"] || !options["answers-file"]) throw new Error("answer requires --request-id and --answers-file.");
      const snapshot = await client.request("executor/status", params);
      const question = snapshot.questions.find((item) => String(item.requestId) === options["request-id"]);
      if (!question) throw new Error("No matching pending question. Refresh /codex:status.");
      const answers = JSON.parse(fs.readFileSync(path.resolve(cwd, options["answers-file"]), "utf8"));
      return client.request("executor/answer-question", { ...params, turnId: question.turnId,
        requestId: question.requestId, action: "accept", values: answers });
    }
    if (!text?.trim()) throw new Error("message requires text or --prompt-file.");
    if (!job.turnId) throw new Error("The task is still starting. Refresh /codex:status before sending a message.");
    const prompt = [{ type: "text", text: text.trim() }];
    let result;
    if (options.interrupt) {
      result = await client.request("executor/interrupt-turn", { ...params, replacementPrompt: prompt });
    } else {
      const status = await client.request("executor/status", params);
      if (!status.capabilities?.midTurnSteer) {
        throw new Error("This executor cannot add a message to the active turn. Retry with --interrupt.");
      }
      result = await client.request("executor/steer", { ...params, prompt });
    }
    return { jobId: job.id, ...result };
  });
}

export async function cancelLiveJob(cwd, job) {
  const sessionId = executorSessionId(job);
  if (!sessionId || !job.turnId) return { attempted: false, interrupted: false, detail: "missing executorSessionId or turnId" };
  try {
    const result = await withLiveClient(cwd, job, (client) => client.request("executor/cancel-job", {
      jobId: job.id,
      executorSessionId: sessionId,
      turnId: job.turnId
    }), { brokerTimeoutMs: 15000 });
    return { attempted: true, interrupted: Boolean(result.interrupted), transport: job.executor ?? "codex", detail: result.note ?? null };
  } catch (error) {
    return { attempted: true, interrupted: false, transport: job.executor ?? "codex", detail: error.message };
  }
}
