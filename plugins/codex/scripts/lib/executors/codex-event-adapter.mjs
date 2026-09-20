import { createCanonicalEvent } from "../executor-events.mjs";
import { DEFAULT_INPUT_TIMEOUT_MS } from "../live-turn-control.mjs";

const METHODS = {
  "turn/started": "turn.started",
  "turn/completed": "turn.completed",
  "item/agentMessage/delta": "message.delta",
  "item/reasoning/summaryTextDelta": "reasoning.summary.delta",
  "item/reasoning/summaryPartAdded": "reasoning.summary.part",
  "item/reasoning/textDelta": "reasoning.text.delta",
  "item/commandExecution/outputDelta": "command.output.delta",
  "item/commandExecution/terminalInteraction": "command.interaction",
  "item/fileChange/patchUpdated": "fileChange.patch.updated",
  "item/fileChange/outputDelta": "fileChange.output.delta",
  "thread/tokenUsage/updated": "usage.updated",
  "turn/diff/updated": "turn.diff.updated",
  "turn/plan/updated": "plan.updated",
  "item/plan/delta": "plan.delta",
  "item/mcpToolCall/progress": "tool.progress",
  "companion/question": "question.opened",
  "companion/notification": "director.notified",
  "companion/control-message": "control.message.updated",
  "companion/answer-delivered": "question.resolved",
  "serverRequest/resolved": "question.closed",
  "companion/job-started": "job.started",
  "companion/job-completed": "job.completed",
  error: "source.error",
  warning: "source.warning"
};

const ITEM_TYPES = {
  commandExecution: "command", agentMessage: "message", reasoning: "reasoning",
  fileChange: "fileChange", plan: "plan"
};

function changedFiles(changes = []) {
  return changes.map((change) => {
    let additions = null;
    let deletions = null;
    const diff = change.diff;
    if (typeof diff === "string" && /^@@ /m.test(diff)) {
      additions = 0;
      deletions = 0;
      let inHunk = false;
      for (const line of diff.split("\n")) {
        if (line.startsWith("@@ ")) { inHunk = true; continue; }
        if (line.startsWith("diff ") || line.startsWith("--- ") || line.startsWith("+++ ")) {
          inHunk = false;
          continue;
        }
        if (inHunk && line.startsWith("+")) additions++;
        if (inHunk && line.startsWith("-")) deletions++;
      }
    }
    return { path: change.path, kind: change.kind?.type ?? change.kind ?? "update", additions, deletions,
      ...(typeof diff === "string" ? { diff } : {}) };
  });
}

function content(text) {
  return typeof text === "string" ? [{ type: "text", text }] : [];
}

function canonicalMessage(item, role) {
  const text = role === "reasoning"
    ? (Array.isArray(item.summary) ? item.summary.join("\n") : item.summary ?? "")
    : item.text ?? "";
  return { messageId: String(item.id), role, content: content(text), text };
}

function toolSnapshot(item, status) {
  const detail = item.tool ?? item.query ?? item.path ?? item.text ?? item.id ?? "";
  return {
    toolCallId: String(item.id),
    name: item.type ?? null,
    title: `${item.server ? `${item.server}/` : ""}${detail}`,
    kind: "other",
    status,
    content: [],
    files: [],
    rawInput: item,
    rawOutput: status === "completed" || status === "failed" ? item : null,
    error: item.error?.message ? { message: item.error.message } : null
  };
}

function usage(total = {}, last = null, complete = true) {
  return {
    inputTokens: total.inputTokens ?? 0,
    outputTokens: total.outputTokens ?? 0,
    cachedInputTokens: total.cachedInputTokens ?? 0,
    thoughtTokens: total.thoughtTokens ?? null,
    totalTokens: total.totalTokens ?? null,
    contextUsed: null,
    contextSize: null,
    cost: null,
    basis: "session",
    complete,
    baselineTokens: last ? {
      inputTokens: Math.max(0, (total.inputTokens ?? 0) - (last.inputTokens ?? 0)),
      outputTokens: Math.max(0, (total.outputTokens ?? 0) - (last.outputTokens ?? 0)),
      cachedInputTokens: Math.max(0, (total.cachedInputTokens ?? 0) - (last.cachedInputTokens ?? 0))
    } : null
  };
}

function terminalReason(status, error) {
  const code = status === "interrupted" ? "interrupted" : status === "completed" ? "end_turn" : "backend_error";
  return { code, backendCode: status ?? null, message: error?.message ?? null, retryable: code === "interrupted" };
}

function itemStatus(item, lifecycle) {
  if (lifecycle === "started") return "in_progress";
  if (item.status === "failed") return "failed";
  // "declined" is what app-server reports for a command or patch the sandbox
  // refused; it never ran, so the fallthrough to completed showed it in the
  // history as a success.
  if (item.status === "cancelled" || item.status === "interrupted" || item.status === "declined") return "failed";
  return "completed";
}

function payloadFor(type, message, receivedAt) {
  const p = message.params ?? {};
  const item = p.item ?? {};
  const lifecycle = message.method?.endsWith("started") ? "started" : "completed";
  switch (type) {
    case "job.started": return { label: p.job?.label ?? p.job?.title ?? p.job?.id ?? "", startedAt: p.job?.startedAt ?? receivedAt };
    case "job.completed": case "job.failed": case "job.cancelled": {
      const status = type.slice(4);
      const error = p.job?.errorMessage ?? p.job?.result?.error?.message;
      return { status, reason: terminalReason(status, error ? { message: error } : null), completedAt: p.job?.completedAt ?? receivedAt,
        finalMessages: [], error: error ? { message: error } : null };
    }
    case "turn.started": return { ordinal: 0, prompt: [] };
    case "turn.completed": return { status: p.turn?.status === "interrupted" ? "interrupted" : p.turn?.status === "failed" ? "failed" : "completed",
      reason: terminalReason(p.turn?.status, p.turn?.error), finalMessages: [], usage: null };
    case "message.started": return { role: item.type === "userMessage" ? "user" : "assistant" };
    case "message.delta": return { role: "assistant", block: { type: "text", text: p.delta ?? "" } };
    case "message.completed": return { message: canonicalMessage(item, item.type === "userMessage" ? "user" : "assistant") };
    case "reasoning.started": return { summaryIndex: null };
    case "reasoning.summary.delta": case "reasoning.text.delta": return { delta: p.delta ?? "", summaryIndex: p.summaryIndex ?? null };
    case "reasoning.summary.part": return { summaryIndex: p.summaryIndex ?? 0 };
    case "reasoning.completed": return { message: canonicalMessage(item, "reasoning") };
    case "command.started": return { command: item.command ?? "", commandKnown: true, cwd: item.cwd ?? null, startedAt: receivedAt };
    case "command.output.delta": return { delta: p.delta ?? "" };
    case "command.interaction": return { stdin: p.stdin ?? "", processId: p.processId == null ? null : String(p.processId) };
    case "command.completed": return { command: item.command ?? "", commandKnown: true, cwd: item.cwd ?? null,
      status: item.status === "failed" || item.status === "declined" ? "failed" : item.status === "interrupted" ? "cancelled" : "completed",
      exitCode: typeof item.exitCode === "number" ? item.exitCode : null, signal: item.signal ?? null,
      durationMs: typeof item.durationMs === "number" ? item.durationMs : null, output: content(item.aggregatedOutput), outputText: item.aggregatedOutput ?? null };
    case "fileChange.started": case "fileChange.patch.updated": case "fileChange.completed":
      return { status: itemStatus(item, lifecycle), files: changedFiles(item.changes ?? p.changes) };
    case "fileChange.output.delta": return { delta: p.delta ?? "" };
    case "plan.started": case "plan.completed": return { entries: (item.plan ?? []).map((entry) => ({ content: entry.step ?? entry.content ?? "", priority: entry.priority ?? "unknown", status: entry.status ?? "unknown" })) };
    case "plan.delta": return { delta: p.delta ?? "" };
    case "plan.updated": return { entries: (p.plan ?? []).map((entry) => ({ content: entry.step ?? entry.content ?? "", priority: entry.priority ?? "unknown", status: entry.status ?? "unknown" })), markdown: p.explanation ?? null, uri: null };
    case "tool.started": return { tool: toolSnapshot(item, "in_progress") };
    case "tool.completed": return { tool: toolSnapshot(item, item.status === "failed" || item.status === "declined" ? "failed" : "completed") };
    case "tool.progress": return { message: p.message ?? "", content: content(p.message) };
    case "usage.updated": return { usage: usage(p.tokenUsage?.total, p.tokenUsage?.last, Boolean(p.tokenUsage?.total)) };
    case "turn.diff.updated": return { diff: p.diff ?? "", files: changedFiles(p.changes) };
    case "question.opened": {
      const questions = p.questions ?? [];
      return { requestId: String(p.requestId), message: questions.map((question) => question.question).join("\n"), mode: "form",
        fields: questions.map((question) => ({ id: String(question.id ?? question.header ?? "question"), title: question.header ?? null,
          description: question.question ?? null, required: true, kind: question.options ? "single_select" : "text",
          ...(question.options ? { options: question.options.map((option) => ({ value: option.label ?? option.value ?? String(option), label: option.label ?? option.value ?? String(option) })) } : {}) })),
        url: null, openedAt: receivedAt,
        expiresAt: p.expiresAt === undefined ? new Date(Date.parse(receivedAt) + DEFAULT_INPUT_TIMEOUT_MS).toISOString()
          : p.expiresAt === null ? null : new Date(typeof p.expiresAt === "number" ? p.expiresAt : Date.parse(p.expiresAt)).toISOString() };
    }
    case "question.resolved": return { requestId: String(p.requestId), action: "accept", values: p.answers ?? null };
    case "question.closed": return { requestId: String(p.requestId), reason: "answered" };
    case "director.notified": return { notificationId: String(p.id ?? p.notificationId ?? ""), message: p.message ?? "", pendingRequestId: p.pendingRequestId == null ? null : String(p.pendingRequestId) };
    case "control.message.updated": return { message: p.message ?? "", mode: p.interrupt ? "interrupt" : "queued", accepted: p.status !== "rejected" };
    case "agent.activity": return { agentId: String(item.agentThreadId), parentAgentId: p.threadId == null ? null : String(p.threadId),
      path: String(item.agentPath ?? item.agentThreadId).split("/").filter(Boolean).at(-1), status: item.kind ?? "interacted" };
    case "source.error": return { code: p.error?.code ?? null, message: p.error?.message ?? p.message ?? "Unknown error", data: p.error ?? null };
    case "source.warning": return { code: p.code ?? null, message: p.message ?? "", data: p };
    default: return { method: message.method ?? "unknown", data: structuredClone(p) };
  }
}

function identityFor(type, p, job, agent) {
  const item = p.item ?? {};
  const itemId = p.itemId ?? item.id;
  const messageId = type.startsWith("message.") || type.startsWith("reasoning.") ? itemId : null;
  const toolCallId = ["command.", "fileChange.", "plan.", "tool."].some((prefix) => type.startsWith(prefix)) ? itemId : null;
  return {
    sessionId: p.threadId ?? p.thread?.id ?? p.job?.executorSessionId ?? p.job?.threadId ?? job.executorSessionId ?? job.threadId ?? null,
    turnId: p.turnId ?? p.turn?.id ?? p.job?.turnId ?? job.turnId ?? null,
    messageId: messageId == null ? null : String(messageId),
    toolCallId: toolCallId == null ? null : String(toolCallId),
    requestId: p.requestId == null ? null : String(p.requestId),
    agentId: type === "agent.activity" ? String(item.agentThreadId) : agent?.id ?? null
  };
}

export function normalizeCodexEvent(message, job, agent = null) {
  const cloned = structuredClone(message);
  const p = cloned.params ?? {};
  let type = METHODS[cloned.method] ?? "source.unknown";
  if (cloned.method === "item/started" || cloned.method === "item/completed") {
    type = `${ITEM_TYPES[p.item?.type] ?? "tool"}.${cloned.method.endsWith("started") ? "started" : "completed"}`;
    if (p.item?.type === "subAgentActivity") type = "agent.activity";
  }
  if (cloned.method === "companion/job-completed") type = `job.${p.job?.status ?? "completed"}`;
  const receivedAt = new Date().toISOString();
  const sourceTime = cloned.emittedAtMs ?? p.startedAtMs ?? p.completedAtMs;
  const occurredAt = sourceTime != null && Number.isFinite(Number(sourceTime)) ? new Date(Number(sourceTime)).toISOString() : receivedAt;
  return createCanonicalEvent({
    job,
    executor: "codex",
    type,
    identity: identityFor(type, p, job, agent),
    occurredAt,
    receivedAt,
    timeBasis: sourceTime == null ? "received" : "source",
    payload: payloadFor(type, cloned, occurredAt),
    source: { protocol: cloned.method?.startsWith("companion/") ? "companion" : "codex-app-server", method: cloned.method ?? "unknown", raw: cloned },
    agent
  });
}

export function upgradeLegacyJobEvent(event) {
  if (event?.schemaVersion === 2) return event;
  const raw = structuredClone(event?.source?.message ?? event?.source?.raw ?? {});
  const job = { id: event.jobId, threadId: event.threadId, turnId: event.turnId };
  const methodByType = Object.fromEntries(Object.entries(METHODS).map(([method, type]) => [type, method]));
  const lifecycle = event.type?.endsWith(".started") ? "item/started" : "item/completed";
  raw.method ??= methodByType[event.type] ?? (/^(message|reasoning|command|fileChange|plan|tool)\.(started|completed)$/.test(event.type ?? "") ? lifecycle : null);
  raw.params ??= {};
  raw.params.threadId ??= event.threadId;
  raw.params.turnId ??= event.turnId;
  raw.params.itemId ??= event.itemId;
  if (raw.method === "item/started" || raw.method === "item/completed") {
    const [kind] = String(event.type).split(".");
    const itemType = Object.entries(ITEM_TYPES).find(([, value]) => value === kind)?.[0] ?? "dynamicToolCall";
    raw.params.item ??= {};
    raw.params.item.id ??= event.itemId ?? `${kind}-legacy`;
    raw.params.item.type ??= itemType;
    if (kind === "message") raw.params.item.text ??= raw.params.text ?? "";
    if (kind === "reasoning") raw.params.item.summary ??= raw.params.summary ?? [];
  }
  if (raw.method === "companion/job-completed") raw.params.job = { ...(raw.params.job ?? {}), status: String(event.type).slice(4) };
  if (!raw.method) raw.method = "legacy/unknown";
  const normalized = normalizeCodexEvent(raw, job, event.derived?.agent
    ? { id: event.derived.agent.threadId, path: event.derived.agent.path, parentId: null } : null);
  if (event.type && normalized.type !== event.type) {
    normalized.type = event.type;
  }
  normalized.occurredAt = event.occurredAt ?? normalized.occurredAt;
  normalized.receivedAt = event.receivedAt ?? normalized.receivedAt;
  return { ...normalized, ...(event.streamId ? { streamId: event.streamId } : {}), ...(event.seq ? { seq: event.seq } : {}) };
}

export class CodexEventAdapter {
  constructor(record) {
    this.record = record;
    this.sessions = new Map();
    this.pending = new Map();
    this.inactive = new Set();
  }

  async bindSession(sessionId, job, agent = null) {
    if (!sessionId) return;
    const existing = this.sessions.get(sessionId);
    if (!agent && existing && existing.job.id !== job.id) this.releaseJob(existing.job.id);
    this.inactive.delete(sessionId);
    this.sessions.set(sessionId, { job, agent });
    const buffered = this.pending.get(sessionId) ?? [];
    this.pending.delete(sessionId);
    for (const message of buffered) await this.accept(message);
  }

  releaseJob(jobId) {
    for (const [sessionId, binding] of this.sessions) {
      if (binding.job.id === jobId) {
        this.sessions.delete(sessionId);
        this.pending.delete(sessionId);
        this.inactive.add(sessionId);
      }
    }
  }

  async accept(message) {
    const p = message.params ?? {};
    const sessionId = p.threadId ?? p.thread?.id;
    const parentId = p.thread?.source?.subagent?.thread_spawn?.parent_thread_id;
    if (sessionId && parentId && this.sessions.has(parentId) && !this.sessions.has(sessionId)) {
      const parent = this.sessions.get(parentId);
      await this.bindSession(sessionId, parent.job, { id: sessionId, path: p.thread?.name ?? sessionId, parentId });
    }
    const binding = this.sessions.get(sessionId);
    if (!binding) {
      if (this.inactive.has(sessionId)) return false;
      if (sessionId && this.pending.size < 64) {
        const buffered = this.pending.get(sessionId) ?? [];
        if (buffered.length < 256) buffered.push(structuredClone(message));
        this.pending.set(sessionId, buffered);
      }
      return false;
    }
    await this.record(normalizeCodexEvent(message, binding.job, binding.agent));
    if (p.item?.type === "subAgentActivity" && p.item.agentThreadId) {
      await this.bindSession(p.item.agentThreadId, binding.job, { id: p.item.agentThreadId,
        path: String(p.item.agentPath ?? p.item.agentThreadId).split("/").filter(Boolean).at(-1), parentId: sessionId });
    } else if (p.item?.type === "collabAgentToolCall") {
      for (const childId of p.item.receiverThreadIds ?? []) {
        const child = this.sessions.get(childId);
        await this.bindSession(childId, binding.job, child?.job.id === binding.job.id
          ? child.agent : { id: childId, path: childId, parentId: sessionId });
      }
    }
    return true;
  }
}
