const EVENT_TYPES = [
  "job.started", "job.completed", "job.failed", "job.cancelled",
  "turn.started", "turn.completed",
  "message.started", "message.delta", "message.completed",
  "reasoning.started", "reasoning.summary.delta", "reasoning.summary.part", "reasoning.text.delta", "reasoning.completed",
  "command.started", "command.output.delta", "command.interaction", "command.completed",
  "fileChange.started", "fileChange.patch.updated", "fileChange.output.delta", "fileChange.completed",
  "plan.started", "plan.delta", "plan.updated", "plan.completed",
  "tool.started", "tool.updated", "tool.progress", "tool.completed",
  "usage.updated", "turn.diff.updated",
  "question.opened", "question.resolved", "question.closed",
  "permission.requested", "permission.resolved",
  "director.notified", "control.message.updated", "agent.activity",
  "source.warning", "source.error", "source.unknown",
  "history.retention.changed", "history.continuity.lost", "history.recording.failed"
];

export const CANONICAL_EVENT_TYPES = new Set(EVENT_TYPES);

const PAYLOAD_FIELDS = {
  "job.started": ["label", "startedAt"],
  "job.completed": ["status", "reason", "completedAt", "finalMessages", "error"],
  "job.failed": ["status", "reason", "completedAt", "finalMessages", "error"],
  "job.cancelled": ["status", "reason", "completedAt", "finalMessages", "error"],
  "turn.started": ["ordinal", "prompt"],
  "turn.completed": ["status", "reason", "finalMessages", "usage"],
  "message.started": ["role"],
  "message.delta": ["role", "block"],
  "message.completed": ["message"],
  "reasoning.started": ["summaryIndex"],
  "reasoning.summary.delta": ["delta", "summaryIndex"],
  "reasoning.summary.part": ["summaryIndex"],
  "reasoning.text.delta": ["delta", "summaryIndex"],
  "reasoning.completed": ["message"],
  "command.started": ["command", "commandKnown", "cwd", "startedAt"],
  "command.output.delta": ["delta"],
  "command.interaction": ["stdin", "processId"],
  "command.completed": ["command", "commandKnown", "cwd", "status", "exitCode", "signal", "durationMs", "output", "outputText"],
  "fileChange.started": ["status", "files"],
  "fileChange.patch.updated": ["status", "files"],
  "fileChange.output.delta": ["delta"],
  "fileChange.completed": ["status", "files"],
  "plan.started": ["entries"],
  "plan.delta": ["delta"],
  "plan.updated": ["entries", "markdown", "uri"],
  "plan.completed": ["entries"],
  "tool.started": ["tool"],
  "tool.updated": ["tool"],
  "tool.progress": ["message", "content"],
  "tool.completed": ["tool"],
  "usage.updated": ["usage"],
  "turn.diff.updated": ["diff", "files"],
  "question.opened": ["requestId", "message", "mode", "fields", "url", "openedAt", "expiresAt"],
  "question.resolved": ["requestId", "action", "values"],
  "question.closed": ["requestId", "reason"],
  "permission.requested": ["requestId", "tool", "options"],
  "permission.resolved": ["requestId", "outcome", "optionId"],
  "director.notified": ["notificationId", "message", "pendingRequestId"],
  "control.message.updated": ["message", "mode", "accepted"],
  "agent.activity": ["agentId", "parentAgentId", "path", "status"],
  "source.warning": ["code", "message"],
  "source.error": ["code", "message"],
  "source.unknown": ["method", "data"],
  "history.retention.changed": ["earliestSeq", "committedSeq"],
  "history.continuity.lost": ["continuity", "reason"],
  "history.recording.failed": ["message"]
};

const IDENTITY_FIELDS = ["jobId", "sessionId", "turnId", "messageId", "toolCallId", "requestId", "agentId"];

function eventError(message) {
  return Object.assign(new Error(`Invalid canonical event: ${message}`), { code: "INVALID_CANONICAL_EVENT" });
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function assertCanonicalEventDraft(event) {
  if (!isObject(event)) throw eventError("event must be an object");
  if (event.schemaVersion !== 2) throw eventError("schemaVersion must be 2");
  if (typeof event.jobId !== "string" || !event.jobId) throw eventError("jobId must be a nonempty string");
  if (!CANONICAL_EVENT_TYPES.has(event.type)) throw eventError(`unknown type ${String(event.type)}`);
  if (!["codex", "acp"].includes(event.executor)) throw eventError("executor must be codex or acp");
  if (!isObject(event.identity)) throw eventError("identity must be an object");
  for (const field of IDENTITY_FIELDS) {
    const value = event.identity[field];
    if (field === "jobId" ? value !== event.jobId : value !== null && typeof value !== "string") {
      throw eventError(`identity.${field} is invalid`);
    }
  }
  if (!Number.isFinite(Date.parse(event.occurredAt))) throw eventError("occurredAt must be an ISO timestamp");
  if (!Number.isFinite(Date.parse(event.receivedAt))) throw eventError("receivedAt must be an ISO timestamp");
  if (!["source", "received"].includes(event.timeBasis)) throw eventError("timeBasis is invalid");
  if (!isObject(event.source) || typeof event.source.protocol !== "string" || typeof event.source.method !== "string" || !Object.hasOwn(event.source, "raw")) {
    throw eventError("source is invalid");
  }
  if (!isObject(event.payload)) throw eventError("payload must be an object");
  for (const field of PAYLOAD_FIELDS[event.type]) {
    if (!Object.hasOwn(event.payload, field)) throw eventError(`${event.type}.payload.${field} is required`);
  }
  if (event.agent !== undefined && (!isObject(event.agent) || typeof event.agent.id !== "string" || typeof event.agent.path !== "string")) {
    throw eventError("agent attribution is invalid");
  }
  return event;
}

/** @typedef {import("./executor-events.js").CanonicalIdentity} CanonicalIdentity */

export function createCanonicalEvent({ job, executor = "codex", type, identity = /** @type {Partial<CanonicalIdentity>} */ ({}), occurredAt, receivedAt, timeBasis = "received", payload, source, agent }) {
  const jobId = job.id ?? job.jobId;
  const received = receivedAt ?? new Date().toISOString();
  const event = {
    schemaVersion: 2,
    jobId,
    executor,
    type,
    identity: {
      jobId,
      sessionId: identity.sessionId ?? null,
      turnId: identity.turnId ?? null,
      messageId: identity.messageId ?? null,
      toolCallId: identity.toolCallId ?? null,
      requestId: identity.requestId ?? null,
      agentId: identity.agentId ?? null
    },
    occurredAt: occurredAt ?? received,
    receivedAt: received,
    timeBasis,
    payload,
    source: source ?? { protocol: "local", method: type, raw: null },
    ...(agent ? { agent: structuredClone(agent) } : {})
  };
  return assertCanonicalEventDraft(event);
}
