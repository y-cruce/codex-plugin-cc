import { DEFAULT_INPUT_TIMEOUT_MS } from "./live-turn-control.mjs";

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
  "error": "source.error",
  "warning": "source.warning"
};

const ITEM_TYPES = {
  commandExecution: "command", agentMessage: "message", reasoning: "reasoning",
  fileChange: "fileChange", plan: "plan"
};
const oneLine = (text) => String(text ?? "").replace(/\r?\n/g, " ⏎ ");
function preview(text, limit) {
  // At most two UTF-16 units per code point. Include one extra point to
  // distinguish an exact-length preview from truncated output.
  const characters = [...oneLine(String(text ?? "").slice(0, limit * 2 + 2))];
  return characters.length > limit ? `${characters.slice(0, limit - 1).join("")}…` : characters.join("");
}
const params = (event) => event.source?.message?.params ?? {};
const isDelta = (event) => event.type.endsWith(".delta") || event.type === "reasoning.summary.part";

function unwrapCommand(command) {
  const match = String(command ?? "").match(/^(?:\/(?:[^\s/]+\/)*)?(?:zsh|bash|sh)\s+-(?:lc|cl|c)\s+([\s\S]+)$/);
  if (!match) return command ?? "";
  const argument = match[1].trim();
  if (!["'", '"'].includes(argument[0])) return command;
  let quote = null;
  let result = "";
  for (let index = 0; index < argument.length; index++) {
    const character = argument[index];
    if (quote === "'") {
      if (character === "'") quote = null;
      else result += character;
    } else if (character === "\\") {
      if (index + 1 === argument.length) return command;
      const next = argument[index + 1];
      if (!quote || /[$`"\\\n]/.test(next)) {
        if (next !== "\n") result += next;
        index++;
      } else result += character;
    } else if (quote === '"') {
      if (character === '"') quote = null;
      else result += character;
    } else if (["'", '"'].includes(character)) quote = character;
    else {
      if (/[\s;|&<>()$`#]/.test(character)) return command;
      result += character;
    }
  }
  return quote ? command : result;
}

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
    return { path: change.path, kind: change.kind?.type ?? change.kind ?? "update", additions, deletions };
  });
}

export function normalizeJobEvent(message, job) {
  const p = message.params ?? {};
  let type = METHODS[message.method] ?? "source.unknown";
  if (message.method === "item/started" || message.method === "item/completed") {
    type = `${ITEM_TYPES[p.item?.type] ?? "tool"}.${message.method.endsWith("started") ? "started" : "completed"}`;
  }
  if (message.method === "companion/job-completed") {
    type = `job.${p.job?.status ?? "completed"}`;
  }
  const receivedAt = new Date().toISOString();
  const sourceTime = message.emittedAtMs ?? p.startedAtMs ?? p.completedAtMs;
  const occurredAt = sourceTime != null && Number.isFinite(Number(sourceTime))
    ? new Date(Number(sourceTime)).toISOString() : receivedAt;
  const changes = p.item?.changes ?? p.changes;
  return {
    schemaVersion: 1,
    streamId: job.streamId,
    jobId: job.id ?? job.jobId,
    occurredAt,
    receivedAt,
    type,
    threadId: p.threadId ?? p.thread?.id ?? p.job?.threadId ?? job.threadId ?? null,
    turnId: p.turnId ?? p.turn?.id ?? p.job?.turnId ?? job.turnId ?? null,
    itemId: p.itemId ?? p.item?.id ?? null,
    source: { protocol: message.method.startsWith("companion/") ? "companion" : "codex-app-server", message: structuredClone(message) },
    derived: changes ? { files: changedFiles(changes) } : null
  };
}

export function renderJobEvent(event, { verbose = false, tail = false } = {}) {
  const p = params(event);
  const item = p.item ?? {};
  if (isDelta(event)) {
    if (!verbose) return null;
    return oneLine(`${event.type}: ${p.delta ?? `part ${p.summaryIndex ?? ""}`}`);
  }
  let text;
  switch (event.type) {
    case "job.started": text = "Job started"; break;
    case "job.completed": case "job.failed": case "job.cancelled": text = `Job ${event.type.slice(4)}`; break;
    case "turn.started": text = verbose ? `Turn started ${event.turnId ?? ""}` : "Turn started"; break;
    case "turn.completed": text = `Turn ${p.turn?.status ?? "completed"}${verbose ? ` ${event.turnId ?? ""}` : ""}`; break;
    case "command.started": text = `$ ${tail ? unwrapCommand(item.command) : item.command ?? ""}`; break;
    case "command.completed": text = `$ ${tail ? unwrapCommand(item.command) : item.command ?? ""}${tail ? "" : ` (exit ${item.exitCode ?? "?"})`}${item.aggregatedOutput ? `\n${verbose ? item.aggregatedOutput : preview(item.aggregatedOutput, 120)}` : ""}`; break;
    case "command.interaction":
      if (tail && !String(p.stdin ?? "")) return null;
      text = `stdin ${p.processId ?? ""}: ${p.stdin ?? ""}`;
      break;
    case "message.completed": text = verbose ? `assistant: ${item.text ?? ""}` : preview(`assistant: ${item.text ?? ""}`, 300); break;
    case "reasoning.completed": {
      const summary = item.summary ?? [];
      const body = Array.isArray(summary) ? summary.join("\n") : summary;
      if (!verbose && !String(body).trim()) return null;
      text = `reasoning: ${body}`;
      break;
    }
    case "fileChange.started": case "fileChange.patch.updated": case "fileChange.completed":
      text = `Files ${item.status ?? event.type.split(".").at(-1)}: ${(event.derived?.files ?? []).map((file) => `${file.kind} ${file.path}${file.additions == null ? "" : ` (+${file.additions} −${file.deletions})`}`).join(", ")}`;
      break;
    case "usage.updated": {
      if (!verbose) return null;
      const usage = p.tokenUsage?.total ?? {};
      text = `Tokens: input=${usage.inputTokens ?? 0} output=${usage.outputTokens ?? 0} cached=${usage.cachedInputTokens ?? 0}`;
      break;
    }
    case "question.opened": text = `Question request=${p.requestId}: ${(p.questions ?? []).map((question) => question.question).join("; ")}`; break;
    case "question.resolved": text = `director → answer delivered request=${p.requestId}`; break;
    case "question.closed": text = `Question resolved request=${p.requestId}`; break;
    case "director.notified": text = `notify_director: ${p.message ?? ""}`; break;
    case "control.message.updated": text = `director → ${p.interrupt ? "interrupt" : "message"}: ${[...String(p.message ?? "")].slice(0, 200).join("")}`; break;
    case "tool.started": case "tool.completed":
      if (!verbose && item.type === "userMessage") return null;
      text = `${item.type ?? "Tool"} ${event.type.endsWith("started") ? "started" : item.status ?? "completed"}: ${item.server ? `${item.server}/` : ""}${item.tool ?? item.query ?? item.path ?? item.text ?? item.id ?? ""}`;
      break;
    case "tool.progress": text = p.message ?? ""; break;
    case "plan.updated": text = `Plan: ${p.explanation ?? ""} ${(p.plan ?? []).map((step) => `${step.status}: ${step.step}`).join("; ")}`; break;
    case "source.error": text = `Error: ${p.error?.message ?? p.message ?? "Unknown error"}`; break;
    case "source.warning": text = `Warning: ${p.message ?? ""}`; break;
    default: return null;
  }
  return oneLine(text);
}

export function createLiveView(job) {
  return {
    schemaVersion: 1,
    jobId: job.id ?? job.jobId,
    label: job.label ?? job.title ?? job.kindLabel ?? job.id ?? job.jobId,
    status: job.status === "queued" ? "running" : job.status ?? "running",
    startedAt: job.startedAt ?? job.createdAt ?? null,
    endedAt: job.completedAt ?? null,
    threadId: job.threadId ?? null,
    turnId: job.turnId ?? null,
    activeCommands: [],
    lastMessage: null,
    files: [],
    usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, complete: !job.request?.resumeThreadId },
    pendingQuestion: null,
    history: { committedSeq: "0", continuity: "complete" },
    tail: [],
    _items: {},
    _usage: {},
    _resumed: Boolean(job.request?.resumeThreadId)
  };
}

function updateTail(view, event, text, key = null) {
  if (text == null || event.type === "turn.started" || event.type === "turn.completed") return;
  const row = { seq: String(event.seq), at: event.occurredAt, type: event.type, text: oneLine(text) };
  if (event.type === "command.completed") {
    const item = params(event).item ?? {};
    row.exitCode = typeof item.exitCode === "number" ? item.exitCode : null;
    row.durationMs = typeof item.durationMs === "number" ? item.durationMs : null;
  }
  const prior = key && view._items[key]?.tailSeq;
  const index = prior ? view.tail.findIndex((entry) => entry.seq === prior) : -1;
  if (index >= 0) view.tail[index] = row;
  else view.tail.push(row);
  if (key) {
    view._items[key] ??= {};
    view._items[key].tailSeq = row.seq;
  }
  view.tail = view.tail.slice(-200);
}

export function applyJobEvent(view, event) {
  const p = params(event);
  const item = p.item ?? {};
  view._items ??= {};
  view._usage ??= {};
  view.history.committedSeq = String(event.seq);
  if (event.threadId && (!view.threadId || event.threadId === view.threadId)) {
    view.threadId = event.threadId;
    if (event.turnId) view.turnId = event.turnId;
  }
  const key = event.itemId ? `${event.threadId}:${event.turnId}:${event.itemId}` : null;
  const state = key ? (view._items[key] ??= { text: "", summary: [], output: "" }) : null;
  let text = renderJobEvent(event, { tail: true });
  let tailKey = null;
  switch (event.type) {
    case "job.started":
      view.status = "running";
      view.startedAt = p.job?.startedAt ?? view.startedAt ?? event.occurredAt;
      break;
    case "job.completed": case "job.failed": case "job.cancelled":
      view.status = event.type.slice(4);
      view.endedAt = p.job?.completedAt ?? event.occurredAt;
      view.activeCommands = [];
      view.pendingQuestion = null;
      break;
    case "turn.started": view.status = "running"; view.pendingQuestion = null; break;
    case "turn.completed": view.activeCommands = view.activeCommands.filter((command) => view._items[command._key]?.turnId !== event.turnId); break;
    case "command.started":
      Object.assign(state, { command: unwrapCommand(item.command), cwd: item.cwd, turnId: event.turnId });
      view.activeCommands.push({ itemId: event.itemId, command: state.command, cwd: item.cwd, startedAt: event.occurredAt, _key: key });
      tailKey = key;
      break;
    case "command.output.delta":
      if (!state.outputPreviewTruncated) {
        state.output = `${String(state.output ?? "").slice(0, 242)}${String(p.delta ?? "").slice(0, 242)}`.slice(0, 242);
        const characters = [...oneLine(state.output)];
        state.outputPreviewTruncated = characters.length > 120;
        state.outputPreview = state.outputPreviewTruncated ? `${characters.slice(0, 119).join("")}…` : characters.join("");
      }
      text = `$ ${state.command ?? ""}\n${state.outputPreview}`;
      tailKey = key;
      break;
    case "command.completed":
      view.activeCommands = view.activeCommands.filter((command) => command._key !== key);
      tailKey = key;
      break;
    case "message.delta":
      state.text = (state.text ?? "") + (p.delta ?? "");
      view.lastMessage = { kind: "assistant", text: state.text, at: event.occurredAt };
      text = preview(`assistant: ${state.text}`, 300);
      tailKey = key;
      break;
    case "reasoning.summary.delta":
      state.summary ??= [];
      state.summary[p.summaryIndex ?? 0] = (state.summary[p.summaryIndex ?? 0] ?? "") + (p.delta ?? "");
      view.lastMessage = { kind: "reasoning", text: state.summary.join("\n"), at: event.occurredAt };
      text = state.summary.join("\n").trim() ? `reasoning: ${state.summary.join("\n")}` : null;
      tailKey = key;
      break;
    case "message.completed": case "reasoning.completed": {
      const body = event.type === "message.completed" ? item.text ?? "" : (Array.isArray(item.summary) ? item.summary.join("\n") : item.summary ?? "");
      view.lastMessage = { kind: event.type === "message.completed" ? "assistant" : "reasoning", text: body, at: event.occurredAt };
      tailKey = key;
      break;
    }
    case "fileChange.completed": case "fileChange.patch.updated":
      for (const file of event.derived?.files ?? []) {
        const index = view.files.findIndex((entry) => entry.path === file.path);
        if (index < 0) view.files.push(file);
        else view.files[index] = file;
      }
      tailKey = key;
      break;
    case "usage.updated": {
      const total = p.tokenUsage?.total;
      if (!total) { view.usage.complete = false; break; }
      const usageKey = event.threadId ?? "unknown";
      const prior = view._usage[usageKey];
      const fields = ["inputTokens", "outputTokens", "cachedInputTokens"];
      const first = prior ?? Object.fromEntries(fields.map((field) => [field, view._resumed ? Math.max(0, (total[field] ?? 0) - (p.tokenUsage?.last?.[field] ?? 0)) : 0]));
      for (const field of fields) {
        const increment = (total[field] ?? 0) - (first[field] ?? 0);
        if (increment < 0) view.usage.complete = false;
        view.usage[field] += Math.max(0, increment);
      }
      view._usage[usageKey] = total;
      break;
    }
    case "question.opened": {
      const openedAt = event.occurredAt;
      const expires = p.expiresAt === undefined ? Date.parse(openedAt) + DEFAULT_INPUT_TIMEOUT_MS
        : p.expiresAt === null ? NaN : typeof p.expiresAt === "number" ? p.expiresAt : Date.parse(p.expiresAt);
      view.pendingQuestion = { requestId: String(p.requestId), text: (p.questions ?? []).map((question) => question.question).join("\n"),
        openedAt, expiresAt: Number.isFinite(expires) ? new Date(expires).toISOString() : null };
      view.status = "waiting-for-answer";
      break;
    }
    case "question.resolved": case "question.closed":
      if (view.pendingQuestion?.requestId === String(p.requestId)) {
        view.pendingQuestion = null;
        view.status = "running";
      }
      break;
    case "history.retention.changed": case "history.continuity.lost": case "history.recording.failed":
      view.history.continuity = "partial";
      break;
  }
  updateTail(view, event, text, tailKey);
  if (key && event.type.endsWith(".completed")) delete view._items[key];
  if (["job.completed", "job.failed", "job.cancelled"].includes(event.type)) view._items = {};
  return view;
}
