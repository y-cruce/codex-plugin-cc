const TERMINAL_REASONS = {
  end_turn: { status: "completed", retryable: false },
  max_tokens: { status: "failed", retryable: true },
  max_turn_requests: { status: "failed", retryable: true },
  refusal: { status: "failed", retryable: false },
  cancelled: { status: "cancelled", retryable: false },
  interrupted: { status: "interrupted", retryable: true },
  backend_error: { status: "failed", retryable: false },
  transport_closed: { status: "failed", retryable: true },
  unknown: { status: "failed", retryable: false }
};

export const CODEX_EXECUTOR_CAPABILITIES = Object.freeze({
  resumeSession: true,
  sessionModes: false,
  structuredQuestions: true,
  permissionRequests: false,
  midTurnSteer: true,
  nextTurnQueue: true,
  notifyDirector: true,
  commandOutputDelta: true,
  commandInteraction: true,
  turnDiff: true,
  subAgents: true
});

export function canonicalTerminalReason(code, options = {}) {
  const normalized = Object.hasOwn(TERMINAL_REASONS, code) ? code : "unknown";
  return {
    code: normalized,
    backendCode: options.backendCode == null ? code ?? null : String(options.backendCode),
    message: options.message ?? null,
    retryable: options.retryable ?? TERMINAL_REASONS[normalized].retryable
  };
}

export function jobStatusForTerminal(terminal, fallbackExitStatus = 1) {
  const code = terminal?.reason?.code;
  if (code && Object.hasOwn(TERMINAL_REASONS, code)) {
    const status = TERMINAL_REASONS[code].status;
    return status === "interrupted" ? "failed" : status;
  }
  return fallbackExitStatus === 0 ? "completed" : "failed";
}

export function codexTerminal(turnState) {
  const backendStatus = turnState.finalTurn?.status ?? (turnState.error ? "failed" : "unknown");
  const error = turnState.error ?? turnState.finalTurn?.error ?? null;
  const code = backendStatus === "completed"
    ? "end_turn"
    : backendStatus === "interrupted"
      ? "interrupted"
      : "backend_error";
  const status = backendStatus === "completed"
    ? "completed"
    : backendStatus === "interrupted"
      ? "interrupted"
      : "failed";
  const finalMessages = turnState.lastAgentMessage
    ? [{ messageId: `${turnState.turnId ?? "turn"}/assistant`, role: "assistant",
        content: [{ type: "text", text: turnState.lastAgentMessage }], text: turnState.lastAgentMessage }]
    : [];
  return {
    turnId: turnState.turnId,
    sessionId: turnState.threadId,
    status,
    reason: canonicalTerminalReason(code, {
      backendCode: backendStatus,
      message: error?.message ?? null
    }),
    finalMessages,
    usage: null
  };
}

export class ExecutorEventQueue {
  constructor() {
    this.values = [];
    this.waiters = [];
    this.closed = false;
  }

  push(value) {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.values.length) return Promise.resolve({ value: this.values.shift(), done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      }
    };
  }
}
