import type { CanonicalContentBlock, CanonicalEventDraft, CanonicalMessage, CanonicalTerminalReason, CanonicalUsage, ExecutorKind } from "./executor-events.mjs";

export interface ExecutorCapabilities {
  resumeSession: boolean;
  sessionModes: boolean;
  structuredQuestions: boolean;
  permissionRequests: boolean;
  midTurnSteer: boolean;
  notifyDirector: boolean;
  commandOutputDelta: boolean;
  commandInteraction: boolean;
  turnDiff: boolean;
  subAgents: boolean;
}

export interface ExecutorSession {
  sessionId: string;
  modes: { currentModeId: string; availableModes: Array<{ id: string; name: string; description: string | null }> } | null;
  configOptions: unknown[];
}

export interface TurnTerminal {
  turnId: string;
  sessionId: string;
  status: "completed" | "failed" | "cancelled" | "interrupted";
  reason: CanonicalTerminalReason;
  finalMessages: CanonicalMessage[];
  usage: CanonicalUsage | null;
}

export interface ExecutorTurn {
  turnId: string;
  done: Promise<TurnTerminal>;
}

export interface ExecutorJobPort {
  readonly kind: ExecutorKind;
  readonly capabilities: ExecutorCapabilities;
  events(): AsyncIterable<CanonicalEventDraft>;
  startSession(request: Record<string, unknown>): Promise<ExecutorSession>;
  resumeSession?(request: Record<string, unknown> & { sessionId: string }): Promise<ExecutorSession>;
  setMode?(request: { sessionId: string; modeId: string }): Promise<void>;
  setConfigOption?(request: { sessionId: string; configId: string; type?: "boolean"; value: string | boolean }): Promise<unknown>;
  startTurn(request: { sessionId: string; prompt: CanonicalContentBlock[]; [key: string]: unknown }): Promise<ExecutorTurn>;
  answerQuestion?(request: { requestId: string; action: "accept" | "decline" | "cancel"; values?: Record<string, unknown> }): Promise<void>;
  answerPermission(request: { requestId: string; outcome: "selected" | "cancelled"; optionId?: string }): Promise<void>;
  interruptTurn(request: { sessionId: string; turnId: string; timeoutMs: number }): Promise<TurnTerminal>;
  cancelJob(request: { sessionId: string; turnId: string; timeoutMs: number }): Promise<TurnTerminal>;
  close(): Promise<void>;
}
