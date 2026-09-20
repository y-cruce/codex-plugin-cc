import { createCanonicalEvent } from "../executor-events.mjs";

const TERMINAL_TOOL_STATUSES = new Set(["completed", "failed"]);

function contentBlock(block) {
  if (!block || typeof block !== "object") return { type: "unknown", value: block };
  if (["text", "image", "audio", "resource_link", "resource"].includes(block.type)) return structuredClone(block);
  return { type: "unknown", value: structuredClone(block) };
}

function textFor(blocks) {
  const text = blocks.filter((block) => block.type === "text").map((block) => block.text).join("");
  return text || null;
}

function fileChangeFromDiff(diff) {
  const kind = diff.oldText == null ? "add" : diff.newText === "" ? "delete" : "update";
  return { path: diff.path, kind, additions: null, deletions: null, oldText: diff.oldText ?? null, newText: diff.newText };
}

// A diff with neither old nor new text changes nothing, and a tool that sends
// one is not editing a file: Qoder declares its task list as an "edit" whose
// diff is empty and whose path is the word "file", which drew a phantom file
// change for every task it created. Its locations are no better, so a tool
// that sent diffs and none of them changed anything keeps nothing.
function toolFiles(tool) {
  const diffs = (tool.content ?? []).filter((entry) => entry.type === "diff");
  const files = diffs.filter((entry) => (entry.oldText ?? "") !== "" || (entry.newText ?? "") !== "").map(fileChangeFromDiff);
  if (!files.length && !diffs.length && ["edit", "delete", "move"].includes(tool.kind)) {
    for (const location of tool.locations ?? []) files.push({ path: location.path, kind: tool.kind,
      additions: null, deletions: null });
  }
  return files;
}

// ACP carries a vendor's own tool name in `_meta`; the pane drops the name a
// row is prefixed with, so the name joins the title or the reader is left with
// the agent's generic wording ("Edit file" for a task it created).
function vendorTool(tool) {
  for (const value of Object.values(tool._meta ?? {})) {
    if (value && typeof value === "object" && typeof value.toolName === "string") return value.toolName;
  }
  return null;
}

function toolContent(tool) {
  return (tool.content ?? []).flatMap((entry) => entry.type === "content" ? [contentBlock(entry.content)] : []);
}

function commandText(tool) {
  if (typeof tool.rawInput?.command === "string") return tool.rawInput.command;
  return tool.title ?? "";
}

function toolSnapshot(tool) {
  return {
    toolCallId: String(tool.toolCallId),
    name: tool.name ?? vendorTool(tool),
    title: [vendorTool(tool), tool.title ?? tool.name ?? String(tool.toolCallId)]
      .filter((part, index, parts) => part && parts.indexOf(part) === index).join(" · "),
    kind: tool.kind ?? "other",
    status: tool.status ?? "pending",
    content: toolContent(tool),
    files: toolFiles(tool),
    rawInput: tool.rawInput,
    rawOutput: tool.rawOutput,
    error: tool.status === "failed" ? { message: String(tool.rawOutput?.message ?? tool.rawOutput ?? "Tool failed") } : null
  };
}

function commandPayload(tool) {
  const output = toolContent(tool);
  const exitCode = typeof tool.rawOutput?.exitCode === "number" ? tool.rawOutput.exitCode : null;
  return {
    command: commandText(tool),
    commandKnown: typeof tool.rawInput?.command === "string",
    cwd: typeof tool.rawInput?.cwd === "string" ? tool.rawInput.cwd : null,
    status: tool.status === "failed" ? "failed" : "completed",
    exitCode,
    signal: typeof tool.rawOutput?.signal === "string" ? tool.rawOutput.signal : null,
    durationMs: typeof tool.rawOutput?.durationMs === "number" ? tool.rawOutput.durationMs : null,
    output,
    outputText: textFor(output)
  };
}

function usagePayload(update, complete = false) {
  return {
    inputTokens: complete ? update.inputTokens ?? null : null,
    outputTokens: complete ? update.outputTokens ?? null : null,
    cachedInputTokens: complete ? update.cachedReadTokens ?? null : null,
    thoughtTokens: complete ? update.thoughtTokens ?? null : null,
    totalTokens: complete ? update.totalTokens ?? null : null,
    contextUsed: complete ? null : update.used ?? null,
    contextSize: complete ? null : update.size ?? null,
    cost: update.cost ? { amount: update.cost.amount, currency: update.cost.currency } : null,
    basis: complete ? "turn" : "context",
    complete
  };
}

function terminalReason(stopReason, interrupting) {
  const code = stopReason === "cancelled" && interrupting ? "interrupted" : stopReason;
  return { code, backendCode: stopReason, message: stopReason === "end_turn" ? null : stopReason, retryable:
    ["max_tokens", "max_turn_requests", "interrupted"].includes(code) };
}

function terminalStatus(stopReason, interrupting) {
  if (stopReason === "end_turn") return "completed";
  if (stopReason === "cancelled") return interrupting ? "interrupted" : "cancelled";
  return "failed";
}

function planEntries(entries = []) {
  return entries.map((entry) => ({ content: entry.content ?? "", priority: entry.priority ?? "unknown",
    status: entry.status ?? "unknown" }));
}

export class AcpEventAdapter {
  constructor(record, options = {}) {
    this.record = record;
    this.receiveTime = options.receiveTime ?? (() => new Date());
    this.job = options.job;
    this.sessionId = null;
    this.turnId = null;
    this.messages = new Map();
    this.currentMessages = new Map();
    this.tools = new Map();
    this.plan = null;
  }

  bindSession(sessionId) {
    this.sessionId = sessionId;
  }

  startTurn(turnId, prompt) {
    this.turnId = turnId;
    this.messages.clear();
    this.currentMessages.clear();
    this.tools.clear();
    this.plan = null;
    return this.emit("turn.started", { ordinal: 0, prompt }, { turnId });
  }

  event(type, payload, identity = {}, raw = null, method = "session/update") {
    const receivedAt = this.receiveTime().toISOString();
    return createCanonicalEvent({
      job: this.job,
      executor: "acp",
      type,
      identity: { sessionId: this.sessionId, turnId: this.turnId, ...identity },
      occurredAt: receivedAt,
      receivedAt,
      timeBasis: "received",
      payload,
      source: { protocol: "acp", method, raw: raw == null ? null : structuredClone(raw) }
    });
  }

  emit(type, payload, identity = {}, raw = null, method = "session/update") {
    return this.record(this.event(type, payload, identity, raw, method));
  }

  async flushMessage(role) {
    const messageId = this.currentMessages.get(role);
    if (!messageId) return;
    const message = this.messages.get(messageId);
    this.currentMessages.delete(role);
    if (!message) return;
    const payload = { message: { messageId, role, content: structuredClone(message.content), text: textFor(message.content) } };
    await this.emit(role === "reasoning" ? "reasoning.completed" : "message.completed", payload,
      { messageId }, null, "session/prompt");
  }

  async contentUpdate(notification, role) {
    const update = notification.update;
    const fallback = `${this.turnId}/${role === "reasoning" ? "reasoning" : role}`;
    const messageId = String(update.messageId ?? fallback);
    const previous = this.currentMessages.get(role);
    if (previous && previous !== messageId) await this.flushMessage(role);
    if (!this.messages.has(messageId)) {
      this.messages.set(messageId, { role, content: [] });
      this.currentMessages.set(role, messageId);
      await this.emit(role === "reasoning" ? "reasoning.started" : "message.started",
        role === "reasoning" ? { summaryIndex: null } : { role }, { messageId }, notification);
    }
    const block = contentBlock(update.content);
    this.messages.get(messageId).content.push(block);
    if (role === "reasoning") {
      await this.emit("reasoning.text.delta", { delta: block.type === "text" ? block.text : "", summaryIndex: null },
        { messageId }, notification);
    } else {
      await this.emit("message.delta", { role, block }, { messageId }, notification);
    }
  }

  mergeTool(update) {
    const previous = this.tools.get(String(update.toolCallId)) ?? { toolCallId: String(update.toolCallId), title: String(update.toolCallId),
      kind: "other", status: "pending", content: [], locations: [] };
    const next = { ...previous };
    for (const key of ["kind", "status", "title", "name", "content", "locations", "rawInput", "rawOutput", "_meta"]) {
      if (Object.hasOwn(update, key) && update[key] !== null) next[key] = structuredClone(update[key]);
    }
    this.tools.set(String(update.toolCallId), next);
    return next;
  }

  async toolUpdate(notification, created) {
    const tool = this.mergeTool(notification.update);
    const identity = { toolCallId: String(tool.toolCallId) };
    const terminal = TERMINAL_TOOL_STATUSES.has(tool.status);
    // A sub-agent is not a tool row. Qoder sends one as a tool call named
    // "Agent" whose input names the agent and what it was asked for, and the
    // row drew the word "Agent" and nothing else; the pane already has a
    // sub-agent of its own to draw, so this one is reported the same way.
    const subagent = typeof tool.rawInput?.subagent_type === "string" ? tool.rawInput.subagent_type : null;
    if (subagent) {
      const status = terminal ? (tool.status === "failed" ? "interrupted" : "completed") : created ? "started" : "interacted";
      // A Codex sub-agent's line says what it is doing now, because its own
      // events arrive; here only this call speaks for it. What the update
      // itself carries is that news -- the merged content is still the input
      // it was created with -- and what it was asked for stands until then.
      const report = created ? null : textFor((notification.update.content ?? [])
        .flatMap((entry) => entry.type === "content" ? [contentBlock(entry.content)] : []));
      // A sub-agent reports back in full -- the one that finished here sent
      // three thousand characters of Markdown and a table -- and its line has
      // room for the sentence that answers the ask, not for the whole report.
      const said = report && (report.split("\n").map((line) => line.trim())
        .find((line) => line && !/^#{1,6}\s/.test(line) && !/^[|>-]/.test(line)) ?? report);
      await this.emit("agent.activity", { agentId: String(tool.toolCallId), parentAgentId: null, path: subagent, status,
        detail: said ?? (created && typeof tool.rawInput?.description === "string" ? tool.rawInput.description : null) },
      { agentId: String(tool.toolCallId) }, notification);
      return;
    }
    if (tool.kind === "execute") {
      if (created) await this.emit("command.started", { command: commandText(tool), commandKnown: typeof tool.rawInput?.command === "string",
        cwd: typeof tool.rawInput?.cwd === "string" ? tool.rawInput.cwd : null, startedAt: this.receiveTime().toISOString() }, identity, notification);
      if (terminal) await this.emit("command.completed", commandPayload(tool), identity, notification);
      else if (!created) await this.emit("tool.progress", { message: tool.title, content: toolContent(tool) }, identity, notification);
      return;
    }
    // Whether this tool changes files is settled when it is created and kept
    // for its whole life: its completion replaces the diff with a result, and
    // deciding again there would send a fileChange.completed for a tool whose
    // start was never reported as one.
    if (!Object.hasOwn(tool, "_files")) tool._files = toolFiles(tool).length > 0;
    if (tool._files && ["edit", "delete", "move"].includes(tool.kind)) {
      const payload = { status: terminal ? (tool.status === "failed" ? "failed" : "completed") : "in_progress", files: toolFiles(tool) };
      if (created) await this.emit("fileChange.started", payload, identity, notification);
      if (terminal) await this.emit("fileChange.completed", payload, identity, notification);
      else if (!created) await this.emit("fileChange.patch.updated", payload, identity, notification);
      return;
    }
    const payload = { tool: toolSnapshot(tool) };
    if (created) await this.emit("tool.started", payload, identity, notification);
    if (terminal) await this.emit("tool.completed", payload, identity, notification);
    else if (!created) await this.emit("tool.updated", payload, identity, notification);
  }

  async accept(notification) {
    if (!notification || notification.sessionId !== this.sessionId) return false;
    const update = notification.update ?? {};
    switch (update.sessionUpdate) {
      case "user_message_chunk": await this.contentUpdate(notification, "user"); break;
      case "agent_message_chunk": await this.contentUpdate(notification, "assistant"); break;
      case "agent_thought_chunk": await this.contentUpdate(notification, "reasoning"); break;
      case "tool_call": await this.toolUpdate(notification, true); break;
      case "tool_call_update": await this.toolUpdate(notification, false); break;
      case "plan":
        this.plan = { entries: planEntries(update.entries), markdown: null, uri: null };
        await this.emit("plan.started", { entries: this.plan.entries }, {}, notification);
        await this.emit("plan.updated", this.plan, {}, notification);
        break;
      case "plan_update": {
        const plan = update.plan ?? {};
        this.plan = plan.type === "items" ? { entries: planEntries(plan.entries), markdown: null, uri: null }
          : plan.type === "markdown" ? { entries: [], markdown: plan.content ?? null, uri: null }
            : { entries: [], markdown: null, uri: plan.uri ?? null };
        await this.emit("plan.updated", this.plan, {}, notification);
        break;
      }
      case "plan_removed":
        this.plan = { entries: [], markdown: null, uri: null };
        await this.emit("plan.updated", this.plan, {}, notification);
        break;
      case "usage_update": await this.emit("usage.updated", { usage: usagePayload(update) }, {}, notification); break;
      case "available_commands_update":
      case "current_mode_update":
      case "config_option_update":
      case "session_info_update":
      case "compaction_update":
      case "compaction_summary_chunk":
      default:
        await this.emit("source.unknown", { method: `session/update:${update.sessionUpdate ?? "unknown"}`, data: structuredClone(update) }, {}, notification);
        break;
    }
    return true;
  }

  async completeTurn(response, options = {}) {
    await this.flushMessage("user");
    await this.flushMessage("reasoning");
    await this.flushMessage("assistant");
    if (this.plan) await this.emit("plan.completed", { entries: this.plan.entries }, {}, null, "session/prompt");
    const finalMessages = [...this.messages.entries()].map(([messageId, message]) => ({
      messageId,
      role: message.role,
      content: structuredClone(message.content),
      text: textFor(message.content)
    }));
    const usage = response.usage ? usagePayload(response.usage, true) : null;
    const terminal = { turnId: this.turnId, sessionId: this.sessionId,
      status: terminalStatus(response.stopReason, options.interrupting),
      reason: terminalReason(response.stopReason, options.interrupting), finalMessages, usage };
    if (usage) await this.emit("usage.updated", { usage }, {}, response, "session/prompt");
    await this.emit("turn.completed", { status: terminal.status, reason: terminal.reason, finalMessages, usage }, {}, response, "session/prompt");
    return terminal;
  }

  async completeJob(terminal) {
    const status = terminal.status === "interrupted" ? "failed" : terminal.status;
    const type = status === "completed" ? "job.completed" : status === "cancelled" ? "job.cancelled" : "job.failed";
    const completedAt = this.receiveTime().toISOString();
    await this.emit(type, { status, reason: terminal.reason, completedAt, finalMessages: terminal.finalMessages,
      error: status === "completed" ? null : { message: terminal.reason.message ?? terminal.reason.code } }, {}, null, type);
  }
}

export function normalizeAcpQuestion(params, requestId, receivedAt) {
  const schema = params.requestedSchema ?? params.schema ?? {};
  const required = new Set(schema.required ?? []);
  const fields = Object.entries(schema.properties ?? {}).map(([id, field]) => {
    const options = field.oneOf?.map((entry) => ({ value: String(entry.const), label: entry.title ?? String(entry.const) })) ??
      field.enum?.map((value) => ({ value: String(value), label: String(value) })) ??
      field.items?.enum?.map((value) => ({ value: String(value), label: String(value) }));
    return { id, title: field.title ?? null, description: field.description ?? null, required: required.has(id),
      kind: field.type === "array" ? "multi_select" : field.type === "string" && options ? "single_select"
        : ["string", "number", "integer", "boolean"].includes(field.type) ? (field.type === "string" ? "text" : field.type) : "unknown",
      ...(options ? { options } : {}), rawSchema: structuredClone(field) };
  });
  return { requestId, message: params.message ?? "", mode: params.mode === "form" ? "form" : params.mode === "url" ? "url" : "custom",
    fields, url: params.url ?? null, openedAt: receivedAt, expiresAt: null };
}

export function normalizeAcpPermission(params, requestId) {
  return { requestId, tool: toolSnapshot({ ...params.toolCall, toolCallId: params.toolCall.toolCallId }),
    options: (params.options ?? []).map((option) => ({ optionId: String(option.optionId), name: option.name,
      kind: option.kind ?? "unknown" })) };
}
