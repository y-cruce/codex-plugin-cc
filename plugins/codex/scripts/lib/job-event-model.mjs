import { DEFAULT_INPUT_TIMEOUT_MS } from "./live-turn-control.mjs";

const oneLine = (text) => String(text ?? "").replace(/\r?\n/g, " ⏎ ");
// A row is one line, so a preview is flattened -- except a message's, whose
// paragraphs are what the pane draws as Markdown. Flattening here is what the
// per-type check in updateTail cannot undo: by then the breaks are gone.
function preview(text, limit, keepLines = false) {
  const source = String(text ?? "").slice(0, limit * 2 + 2);
  const characters = [...(keepLines ? source : oneLine(source))];
  return characters.length > limit ? `${characters.slice(0, limit - 1).join("")}…` : characters.join("");
}
// The kinds the live renderer wraps rather than clipping to a single row; kept
// in step with PROSE in hooks/live-tool-row/view.ts.
const PROSE = /^(message|reasoning|question|director|control|source|plan|tool\.progress)/;
const isDelta = (event) => event.type.endsWith(".delta") || event.type === "reasoning.summary.part";
const terminal = (status) => ["completed", "failed", "cancelled"].includes(status);

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

function blockText(block) {
  if (block?.type === "text") return block.text;
  if (block?.type === "image") return "[image]";
  if (block?.type === "audio") return "[audio]";
  if (block?.type === "resource_link") return `[resource: ${block.title ?? block.name}]`;
  if (block?.type === "resource") return `[resource: ${block.resource?.uri ?? "embedded"}]`;
  return block ? `[${block.type ?? "content"}]` : "";
}

function eventEntityKey(event) {
  const identity = event.identity;
  const id = identity.messageId ?? identity.toolCallId;
  return id == null ? null : JSON.stringify([identity.sessionId, identity.turnId, id]);
}

function eventAgent(event, view) {
  if (event.agent) return event.agent;
  const id = event.identity.agentId;
  const known = id ? view?.subAgents?.find((entry) => entry.threadId === id) : null;
  return known ? { id, path: known.path, parentId: null } : null;
}

export function renderJobEvent(event, { verbose = false, tail = false } = {}) {
  const text = renderEventText(event, { verbose, tail });
  if (text == null || !event.agent) return text;
  const prefixed = `[${oneLine(event.agent.path)}] ${text}`;
  return !verbose && /^(message|reasoning)\./.test(event.type) ? preview(prefixed, 300) : prefixed;
}

function renderEventText(event, { verbose = false, tail = false } = {}) {
  const p = event.payload;
  if (isDelta(event)) {
    if (!verbose) return null;
    const delta = p.delta ?? blockText(p.block) ?? `part ${p.summaryIndex ?? ""}`;
    return oneLine(`${event.type}: ${delta}`);
  }
  let text;
  switch (event.type) {
    case "agent.activity": text = `⇢ sub-agent ${p.path} ${p.status}`; break;
    case "job.started": text = "Job started"; break;
    case "job.completed": case "job.failed": case "job.cancelled": text = `Job ${event.type.slice(4)}`; break;
    case "turn.started": text = verbose ? `Turn started ${event.identity.turnId ?? ""}` : "Turn started"; break;
    case "turn.completed": text = `Turn ${p.status}${verbose ? ` ${event.identity.turnId ?? ""}` : ""}`; break;
    case "command.started": text = `$ ${tail ? unwrapCommand(p.command) : p.command ?? ""}`; break;
    case "command.completed": text = `$ ${tail ? unwrapCommand(p.command) : p.command ?? ""}${tail ? "" : ` (exit ${p.exitCode ?? "?"})`}${!tail && p.outputText ? `\n${verbose ? p.outputText : preview(p.outputText, 120)}` : ""}`; break;
    case "command.interaction":
      if (tail && !String(p.stdin ?? "")) return null;
      text = `stdin ${p.processId ?? ""}: ${p.stdin ?? ""}`;
      break;
    case "message.completed": text = verbose ? `assistant: ${p.message.text ?? ""}` : preview(`assistant: ${p.message.text ?? ""}`, 300); break;
    case "reasoning.completed": {
      const body = p.message.text ?? "";
      if (!verbose && !String(body).trim()) return null;
      text = `reasoning: ${body}`;
      break;
    }
    case "fileChange.started": case "fileChange.patch.updated": case "fileChange.completed":
      text = `Files ${p.status ?? event.type.split(".").at(-1)}: ${(p.files ?? []).map((file) => `${file.kind} ${file.path}${file.additions == null ? "" : ` (+${file.additions} −${file.deletions})`}`).join(", ")}`;
      break;
    case "usage.updated": {
      if (!verbose) return null;
      const usage = p.usage;
      text = `Tokens: input=${usage.inputTokens ?? 0} output=${usage.outputTokens ?? 0} cached=${usage.cachedInputTokens ?? 0}`;
      break;
    }
    case "question.opened": text = `Question request=${p.requestId}: ${p.message}`; break;
    case "question.resolved": text = `director → answer delivered request=${p.requestId}`; break;
    case "question.closed": text = `Question resolved request=${p.requestId}`; break;
    case "director.notified": text = `notify_director: ${p.message ?? ""}`; break;
    case "control.message.updated": text = `director → ${p.mode === "interrupt" ? "interrupt" : "message"}: ${[...String(p.message ?? "")].slice(0, 200).join("")}`; break;
    case "tool.started": case "tool.updated": case "tool.completed": {
      const tool = p.tool;
      if (!verbose && tool.name === "userMessage") return null;
      // A tool that has not said what it is working on yet draws a bullet with
      // nothing after it; the completed event carries the whole row.
      if (!verbose && event.type === "tool.started" && !String(tool.title ?? "").trim()) return null;
      const lifecycle = event.type === "tool.started" ? "started" : event.type === "tool.completed" ? tool.status : "updated";
      text = `${tool.name ?? "Tool"} ${lifecycle}: ${tool.title ?? ""}`;
      break;
    }
    case "tool.progress": text = p.message ?? ""; break;
    case "plan.updated": text = `Plan: ${p.markdown ?? ""} ${(p.entries ?? []).map((step) => `${step.status}: ${step.content}`).join("; ")}`; break;
    case "source.error": text = `Error: ${p.message ?? "Unknown error"}`; break;
    case "source.warning": text = `Warning: ${p.message ?? ""}`; break;
    default: return null;
  }
  // A line-oriented stream gets one line per event. A tail row is drawn, and
  // the renderer wraps the kinds that are prose, so what it does with the
  // breaks is updateTail's call to make.
  return tail ? text : oneLine(text);
}

export function createLiveView(job) {
  const executor = job.executor ?? "codex";
  return {
    schemaVersion: 1,
    jobId: job.id ?? job.jobId,
    label: job.label ?? job.title ?? job.kindLabel ?? job.id ?? job.jobId,
    status: job.status === "queued" ? "running" : job.status ?? "running",
    startedAt: job.startedAt ?? job.createdAt ?? null,
    endedAt: job.completedAt ?? null,
    threadId: job.executorSessionId ?? job.threadId ?? null,
    turnId: job.turnId ?? null,
    executor: { kind: executor, label: executor === "acp" ? "Qoder" : "Codex" },
    activeCommands: [],
    lastMessage: null,
    files: [],
    usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, complete: !job.request?.resumeThreadId },
    pendingQuestion: null,
    plan: null,
    history: { committedSeq: "0", continuity: "complete" },
    tail: [],
    _items: {},
    _usage: {},
    _resumed: Boolean(job.request?.resumeThreadId)
  };
}

function updateTail(view, event, text, key = null) {
  if (text == null || event.type === "turn.started" || event.type === "turn.completed") return;
  // A row is one line, except the kinds the renderer wraps as prose: their
  // paragraphs are what makes them readable, and flattening here leaves the
  // renderer nothing to restore. A command keeps the fold, which the renderer
  // splits on to draw its failing output.
  const row = { seq: String(event.seq), at: event.occurredAt, type: event.type,
    text: PROSE.test(event.type) ? String(text ?? "") : oneLine(text) };
  // A row holds a preview; lastMessage holds the whole answer. Writing that
  // resumed after a tool has a row per stretch, so a row says where its own
  // stretch begins and the reader takes the rest from lastMessage.
  if (/^message\./.test(event.type) && key) row.from = String(view._items[key]?.shown ?? 0);
  const agent = event.type === "agent.activity" ? { id: event.payload.agentId, path: event.payload.path } : eventAgent(event, view);
  if (agent?.id) row.agentThreadId = agent.id;
  if (event.agent) {
    row.agent = event.agent.path;
    row.text = `[${oneLine(row.agent)}] ${row.text}`;
    if (/^(message|reasoning)\./.test(event.type)) row.text = preview(row.text, 300, /^message\./.test(event.type));
  }
  // A command may be a heredoc and carry newlines of its own, so its output
  // travels beside it rather than joined to it: in one string the renderer
  // cannot tell where the command ends and the output begins.
  const output = key ? view._items[key]?.outputPreview : null;
  if (output && event.type.startsWith("command.")) row.output = output;
  if (event.type === "command.completed") {
    row.exitCode = typeof event.payload.exitCode === "number" ? event.payload.exitCode : null;
    row.durationMs = typeof event.payload.durationMs === "number" ? event.payload.durationMs : null;
  }
  const prior = key && view._items[key]?.tailSeq;
  const index = prior ? view.tail.findIndex((entry) => entry.seq === prior) : -1;
  // Reasoning arrives as one block at the end of a turn, so it is the one kind
  // still worth moving: its row was opened when the thinking began.
  const moveToEnd = index >= 0 && index < view.tail.length - 1 && event.type === "reasoning.completed";
  row.positionSeq = index >= 0 && !moveToEnd ? view.tail[index].positionSeq ?? view.tail[index].seq : row.seq;
  if (moveToEnd) view.tail.splice(index, 1);
  if (index >= 0 && !moveToEnd) view.tail[index] = row;
  else view.tail.push(row);
  if (key) {
    view._items[key] ??= {};
    view._items[key].tailSeq = row.seq;
  }
  view.tail = view.tail.slice(-200);
}

export function applyJobEvent(view, event, options = {}) {
  const p = event.payload;
  const identity = event.identity;
  view._items ??= {};
  view._usage ??= {};
  view.history.committedSeq = String(event.seq);
  const child = Boolean(event.agent);
  const turnAfterTerminal = !child && event.type === "turn.started" && terminal(view.status);
  if (!turnAfterTerminal && !child && identity.sessionId && (!view.threadId || identity.sessionId === view.threadId)) {
    view.threadId = identity.sessionId;
    if (identity.turnId) view.turnId = identity.turnId;
  }
  const key = eventEntityKey(event);
  const entityId = identity.messageId ?? identity.toolCallId;
  const legacyKey = entityId == null ? null : `${identity.sessionId}:${identity.turnId}:${entityId}`;
  if (key && legacyKey && key !== legacyKey && !view._items[key] && view._items[legacyKey]) {
    view._items[key] = view._items[legacyKey];
    delete view._items[legacyKey];
    for (const command of view.activeCommands) if (command._key === legacyKey) command._key = key;
  }
  const state = key ? (view._items[key] ??= { text: "", summary: [], output: "" }) : null;
  let text = renderEventText(event, { tail: true });
  let tailKey = null;
  switch (event.type) {
    case "agent.activity": {
      view.subAgents ??= [];
      const threadId = p.agentId;
      let agent = view.subAgents.find((entry) => entry.threadId === threadId);
      if (!agent) {
        agent = { threadId, path: p.path, status: p.status, startedAt: p.status === "started" ? event.occurredAt : null,
          endedAt: null, startedSeq: String(event.seq) };
        view.subAgents.push(agent);
      }
      agent.path = p.path;
      // An executor that runs its sub-agents opaquely reports no events of
      // theirs, so what the agent was asked for is the only activity there is.
      if (p.detail) agent.lastActivity = preview(String(p.detail), 300);
      if (p.status !== "interacted" && (p.status !== "completed" || agent.status !== "failed")) agent.status = p.status;
      if (p.status === "started") { agent.startedAt ??= event.occurredAt; agent.endedAt = null; }
      if (["interrupted", "completed"].includes(p.status)) agent.endedAt = event.occurredAt;
      tailKey = key;
      break;
    }
    case "job.started": view.status = "running"; view.startedAt = p.startedAt ?? view.startedAt ?? event.occurredAt; break;
    case "job.completed": case "job.failed": case "job.cancelled":
      view.status = event.type.slice(4);
      view.endedAt = p.completedAt ?? event.occurredAt;
      view.activeCommands = [];
      view.pendingQuestion = null;
      break;
    case "turn.started":
      if (!child && turnAfterTerminal) {
        options.onDiagnostic?.(`Ignored turn.started for terminal job ${view.jobId} (${view.status}): event job=${event.jobId}, session=${identity.sessionId ?? "unknown"}, turn=${identity.turnId ?? "unknown"}, terminal turn=${view.turnId ?? "unknown"}`);
      } else if (!child) {
        view.status = "running";
        view.pendingQuestion = null;
      }
      break;
    case "turn.completed": view.activeCommands = view.activeCommands.filter((command) => view._items[command._key]?.turnId !== identity.turnId); break;
    case "command.started":
      Object.assign(state, { command: unwrapCommand(p.command), cwd: p.cwd, turnId: identity.turnId });
      view.activeCommands.push({ itemId: identity.toolCallId, command: state.command, cwd: p.cwd, startedAt: event.occurredAt, _key: key,
        ...(child ? { agentThreadId: event.agent.id } : {}) });
      tailKey = key;
      break;
    case "command.output.delta":
      if (!state.outputPreviewTruncated) {
        state.output = `${String(state.output ?? "").slice(0, 242)}${String(p.delta ?? "").slice(0, 242)}`.slice(0, 242);
        // The breaks stay so the renderer can give each output line a row, but a
        // carriage return does not: left in, it pulls the cursor back to the
        // start of the row it is drawn on.
        const characters = [...state.output.replace(/\r\n?/g, "\n")];
        state.outputPreviewTruncated = characters.length > 120;
        state.outputPreview = state.outputPreviewTruncated ? `${characters.slice(0, 119).join("")}…` : characters.join("");
      }
      text = `$ ${state.command ?? ""}`;
      tailKey = key;
      break;
    case "command.completed":
      view.activeCommands = view.activeCommands.filter((command) => command._key !== key);
      text = `$ ${state?.command ?? unwrapCommand(p.command)}`;
      // Output that never streamed as deltas arrives whole at completion.
      if (state && !state.outputPreview && p.outputText) {
        state.outputPreview = preview(String(p.outputText).replace(/\r\n?/g, "\n"), 120, true);
      }
      tailKey = key;
      break;
    case "message.delta": {
      const delta = blockText(p.block);
      state.text = (state.text ?? "") + delta;
      if (!child) view.lastMessage = { kind: "assistant", text: state.text, at: event.occurredAt };
      // An agent that writes, runs a tool, then writes again is not revising
      // what it already said. Carrying one row to the end would drag the
      // earlier half down past the tool it preceded, and do it again on every
      // resumption; so writing that resumes opens a row of its own and the
      // rows already drawn stay where they were.
      if (state.tailSeq && view.tail.at(-1)?.seq !== state.tailSeq) {
        state.shown = state.text.length - delta.length;
        state.tailSeq = null;
      }
      text = preview(`assistant: ${state.text.slice(state.shown ?? 0)}`, 300, true);
      tailKey = key;
      break;
    }
    case "reasoning.summary.delta":
      state.summary ??= [];
      state.summary[p.summaryIndex ?? 0] = (state.summary[p.summaryIndex ?? 0] ?? "") + (p.delta ?? "");
      if (!child) view.lastMessage = { kind: "reasoning", text: state.summary.join("\n"), at: event.occurredAt };
      text = state.summary.join("\n").trim() ? `reasoning: ${state.summary.join("\n")}` : null;
      tailKey = key;
      break;
    case "message.completed": case "reasoning.completed": {
      const body = p.message.text ?? p.message.content.map(blockText).join("");
      if (!child) view.lastMessage = { kind: event.type === "message.completed" ? "assistant" : "reasoning", text: body, at: event.occurredAt };
      if (state && event.type === "message.completed") {
        if (state.tailSeq && view.tail.at(-1)?.seq !== state.tailSeq) {
          state.shown = (state.text ?? "").length;
          state.tailSeq = null;
        }
        // Only a body that continues what was streamed can be cut at the
        // offset already drawn; a final text that rewrites the stream is shown
        // whole, since none of it has appeared yet.
        const streamed = state.text ?? "";
        const segment = body.startsWith(streamed) ? body.slice(Math.min(state.shown ?? 0, body.length)) : body;
        text = segment.trim() ? preview(`assistant: ${segment}`, 300, true) : null;
      }
      tailKey = key;
      break;
    }
    case "fileChange.completed": case "fileChange.patch.updated":
      for (const file of p.files ?? []) {
        const value = { path: file.path, kind: file.kind, additions: file.additions, deletions: file.deletions };
        const index = view.files.findIndex((entry) => entry.path === file.path);
        if (index < 0) view.files.push(value);
        else view.files[index] = value;
      }
      tailKey = key;
      break;
    case "plan.updated":
      // The plan is the shape of the work, not a thing that happened: it sits
      // at the foot of the pane where the reader can always see it, so the
      // view carries it and the trace does not. Appended as a row, every
      // redraw put another copy of the whole checklist in the trace.
      view.plan = { entries: p.entries ?? [], markdown: p.markdown ?? null };
      text = null;
      break;
    case "usage.updated": {
      const total = p.usage;
      if (!total || total.inputTokens == null || total.outputTokens == null) { view.usage.complete = false; break; }
      const usageKey = identity.sessionId ?? "unknown";
      const prior = view._usage[usageKey];
      const fields = ["inputTokens", "outputTokens", "cachedInputTokens"];
      const first = prior ?? Object.fromEntries(fields.map((field) => [field, view._resumed ? total.baselineTokens?.[field] ?? total[field] ?? 0 : 0]));
      for (const field of fields) {
        const increment = (total[field] ?? 0) - (first[field] ?? 0);
        if (increment < 0) view.usage.complete = false;
        view.usage[field] += Math.max(0, increment);
      }
      view.usage.complete &&= total.complete !== false;
      view._usage[usageKey] = total;
      break;
    }
    case "question.opened": {
      if (child) break;
      const openedAt = p.openedAt ?? event.occurredAt;
      const expires = p.expiresAt === undefined ? Date.parse(openedAt) + DEFAULT_INPUT_TIMEOUT_MS
        : p.expiresAt === null ? NaN : Date.parse(p.expiresAt);
      view.pendingQuestion = { requestId: String(p.requestId), text: p.message, openedAt,
        expiresAt: Number.isFinite(expires) ? new Date(expires).toISOString() : null };
      view.status = "waiting-for-answer";
      break;
    }
    case "question.resolved": case "question.closed":
      if (child) break;
      if (view.pendingQuestion?.requestId === String(p.requestId)) {
        view.pendingQuestion = null;
        view.status = "running";
      }
      break;
    case "history.retention.changed": case "history.continuity.lost": case "history.recording.failed":
      view.history.continuity = "partial";
      break;
  }
  if (child) {
    view.subAgents ??= [];
    let agent = view.subAgents.find((entry) => entry.threadId === event.agent.id);
    if (!agent) {
      agent = { threadId: event.agent.id, path: event.agent.path, status: "started", startedAt: event.occurredAt, endedAt: null, startedSeq: String(event.seq) };
      view.subAgents.push(agent);
    }
    // A sub-agent's summary is one line, so the output a command row now carries
    // beside it is folded back in here: it is the part that says how it went.
    if (!agent.endedAt && text && /^(command|message|reasoning|source|tool)\./.test(event.type)) {
      const trailing = event.type.startsWith("command.") && key ? view._items[key]?.outputPreview : null;
      agent.lastActivity = preview(trailing ? `${text}\n${trailing}` : text, 300);
    }
    if (!agent.endedAt && event.type === "turn.completed" && p.status === "failed") {
      agent.status = "failed";
      agent.endedAt = event.occurredAt;
      if (p.reason?.message) agent.lastActivity = preview(p.reason.message, 300);
    }
  }
  updateTail(view, event, text, tailKey);
  if (key && event.type.endsWith(".completed")) delete view._items[key];
  if (["job.completed", "job.failed", "job.cancelled"].includes(event.type)) view._items = {};
  return view;
}
