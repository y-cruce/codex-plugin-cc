export type ExecutorKind = "codex" | "acp";
export type CanonicalEventType =
  | "job.started" | "job.completed" | "job.failed" | "job.cancelled"
  | "turn.started" | "turn.completed"
  | "message.started" | "message.delta" | "message.completed"
  | "reasoning.started" | "reasoning.summary.delta" | "reasoning.summary.part" | "reasoning.text.delta" | "reasoning.completed"
  | "command.started" | "command.output.delta" | "command.interaction" | "command.completed"
  | "fileChange.started" | "fileChange.patch.updated" | "fileChange.output.delta" | "fileChange.completed"
  | "plan.started" | "plan.delta" | "plan.updated" | "plan.completed"
  | "tool.started" | "tool.updated" | "tool.progress" | "tool.completed"
  | "usage.updated" | "turn.diff.updated"
  | "question.opened" | "question.resolved" | "question.closed"
  | "permission.requested" | "permission.resolved"
  | "director.notified" | "control.message.updated" | "agent.activity"
  | "source.warning" | "source.error" | "source.unknown"
  | "history.retention.changed" | "history.continuity.lost" | "history.recording.failed";

export type CanonicalContentBlock =
  | { type: "text"; text: string; annotations?: Record<string, unknown> | null }
  | { type: "image"; data: string; mimeType: string; uri?: string | null; annotations?: Record<string, unknown> | null }
  | { type: "audio"; data: string; mimeType: string; annotations?: Record<string, unknown> | null }
  | { type: "resource_link"; uri: string; name: string; title?: string | null; description?: string | null; mimeType?: string | null; size?: number | null }
  | { type: "resource"; resource: { uri: string; mimeType?: string | null; text?: string; blob?: string } }
  | { type: "unknown"; value: unknown };

export interface CanonicalIdentity {
  jobId: string;
  sessionId: string | null;
  turnId: string | null;
  messageId: string | null;
  toolCallId: string | null;
  requestId: string | null;
  agentId: string | null;
}

export interface CanonicalMessage {
  messageId: string;
  role: "assistant" | "user" | "reasoning";
  content: CanonicalContentBlock[];
  text: string | null;
}

export interface CanonicalFileChange {
  path: string;
  kind: "add" | "update" | "delete" | "move" | "unknown";
  additions: number | null;
  deletions: number | null;
  diff?: string | null;
  oldText?: string | null;
  newText?: string | null;
}

export interface CanonicalToolSnapshot {
  toolCallId: string;
  name: string | null;
  title: string;
  kind: "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "switch_mode" | "other";
  status: "pending" | "in_progress" | "completed" | "failed";
  content: CanonicalContentBlock[];
  files: CanonicalFileChange[];
  rawInput?: unknown;
  rawOutput?: unknown;
  error?: { code?: string | number; message: string } | null;
}

export interface CanonicalUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  thoughtTokens: number | null;
  totalTokens: number | null;
  contextUsed: number | null;
  contextSize: number | null;
  cost: { amount: number; currency: string } | null;
  basis: "turn" | "session" | "context";
  complete: boolean;
  baselineTokens?: { inputTokens: number; outputTokens: number; cachedInputTokens: number } | null;
}

export interface CanonicalTerminalReason {
  code: "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled" | "interrupted" | "backend_error" | "transport_closed" | "unknown";
  backendCode: string | null;
  message: string | null;
  retryable: boolean;
}

export interface CanonicalPlanEntry {
  content: string;
  priority: "high" | "medium" | "low" | "unknown";
  status: "pending" | "in_progress" | "completed" | "unknown";
}

export interface CanonicalQuestionField {
  id: string;
  title: string | null;
  description: string | null;
  required: boolean;
  kind: "text" | "number" | "integer" | "boolean" | "single_select" | "multi_select" | "unknown";
  options?: Array<{ value: string; label: string; description?: string | null }>;
  constraints?: Record<string, unknown>;
  rawSchema?: unknown;
}

export interface CanonicalEventPayloadMap {
  "job.started": { label: string; startedAt: string };
  "job.completed": JobTerminalPayload;
  "job.failed": JobTerminalPayload;
  "job.cancelled": JobTerminalPayload;
  "turn.started": { ordinal: number; prompt: CanonicalContentBlock[] };
  "turn.completed": { status: "completed" | "failed" | "cancelled" | "interrupted"; reason: CanonicalTerminalReason; finalMessages: CanonicalMessage[]; usage: CanonicalUsage | null };
  "message.started": { role: "assistant" | "user" };
  "message.delta": { role: "assistant" | "user"; block: CanonicalContentBlock };
  "message.completed": { message: CanonicalMessage };
  "reasoning.started": { summaryIndex: number | null };
  "reasoning.summary.delta": { delta: string; summaryIndex: number | null };
  "reasoning.summary.part": { summaryIndex: number };
  "reasoning.text.delta": { delta: string; summaryIndex: number | null };
  "reasoning.completed": { message: CanonicalMessage };
  "command.started": { command: string; commandKnown: boolean; cwd: string | null; startedAt: string };
  "command.output.delta": { delta: string };
  "command.interaction": { stdin: string; processId: string | null };
  "command.completed": { command: string; commandKnown: boolean; cwd: string | null; status: "completed" | "failed" | "cancelled"; exitCode: number | null; signal: string | null; durationMs: number | null; output: CanonicalContentBlock[]; outputText: string | null };
  "fileChange.started": FileChangePayload;
  "fileChange.patch.updated": FileChangePayload;
  "fileChange.output.delta": { delta: string };
  "fileChange.completed": FileChangePayload;
  "plan.started": { entries: CanonicalPlanEntry[] };
  "plan.delta": { delta: string };
  "plan.updated": { entries: CanonicalPlanEntry[]; markdown: string | null; uri: string | null };
  "plan.completed": { entries: CanonicalPlanEntry[] };
  "tool.started": { tool: CanonicalToolSnapshot };
  "tool.updated": { tool: CanonicalToolSnapshot };
  "tool.progress": { message: string; content: CanonicalContentBlock[] };
  "tool.completed": { tool: CanonicalToolSnapshot };
  "usage.updated": { usage: CanonicalUsage };
  "turn.diff.updated": { diff: string; files: CanonicalFileChange[] };
  "question.opened": { requestId: string; message: string; mode: "form" | "url" | "custom"; fields: CanonicalQuestionField[]; url: string | null; openedAt: string; expiresAt: string | null };
  "question.resolved": { requestId: string; action: "accept" | "decline" | "cancel"; values: Record<string, string | number | boolean | string[]> | null };
  "question.closed": { requestId: string; reason: "answered" | "turn_ended" | "timeout" | "cancelled" | "unknown" };
  "permission.requested": { requestId: string; tool: CanonicalToolSnapshot; options: Array<{ optionId: string; name: string; kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" | "unknown" }> };
  "permission.resolved": { requestId: string; outcome: "selected" | "cancelled"; optionId: string | null };
  "director.notified": { notificationId: string; message: string; pendingRequestId: string | null };
  "control.message.updated": { message: string; mode: "steer" | "queue" | "interrupt"; accepted: boolean };
  "agent.activity": { agentId: string; parentAgentId: string | null; path: string; status: "started" | "interacted" | "completed" | "interrupted" | "failed" };
  "source.warning": SourceNoticePayload;
  "source.error": SourceNoticePayload;
  "source.unknown": { method: string; data: unknown };
  "history.retention.changed": { earliestSeq: string; committedSeq: string };
  "history.continuity.lost": { continuity: "complete" | "partial"; reason: string };
  "history.recording.failed": { message: string };
}

interface JobTerminalPayload {
  status: "completed" | "failed" | "cancelled";
  reason: CanonicalTerminalReason;
  completedAt: string;
  finalMessages: CanonicalMessage[];
  error: { code?: string | number; message: string; data?: unknown } | null;
}

interface FileChangePayload {
  status: "pending" | "in_progress" | "completed" | "failed";
  files: CanonicalFileChange[];
}

interface SourceNoticePayload {
  code: string | number | null;
  message: string;
  data?: unknown;
}

export interface CanonicalEventDraft<T extends CanonicalEventType = CanonicalEventType> {
  schemaVersion: 2;
  jobId: string;
  executor: ExecutorKind;
  type: T;
  identity: CanonicalIdentity;
  occurredAt: string;
  receivedAt: string;
  timeBasis: "source" | "received";
  payload: CanonicalEventPayloadMap[T];
  source: { protocol: "codex-app-server" | "acp" | "companion" | "local"; method: string; raw: unknown | null };
  agent?: { id: string; path: string; parentId: string | null };
}

export interface CanonicalEvent<T extends CanonicalEventType = CanonicalEventType> extends CanonicalEventDraft<T> {
  streamId: string;
  seq: string;
}

export const CANONICAL_EVENT_TYPES: ReadonlySet<CanonicalEventType>;
export function assertCanonicalEventDraft<T extends CanonicalEventDraft>(event: T): T;
export function createCanonicalEvent<T extends CanonicalEventType>(options: {
  job: { id?: string; jobId?: string };
  executor?: ExecutorKind;
  type: T;
  identity?: Partial<Omit<CanonicalIdentity, "jobId">>;
  occurredAt?: string;
  receivedAt?: string;
  timeBasis?: "source" | "received";
  payload: CanonicalEventPayloadMap[T];
  source?: CanonicalEventDraft<T>["source"];
  agent?: CanonicalEventDraft<T>["agent"];
}): CanonicalEventDraft<T>;
