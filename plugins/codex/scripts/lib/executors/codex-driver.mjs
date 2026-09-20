import { CODEX_EXECUTOR_CAPABILITIES, ExecutorEventQueue, codexTerminal } from "../executor-port.mjs";
import { registerObservedJob } from "../observation-client.mjs";
import { CodexEventAdapter } from "./codex-event-adapter.mjs";

const SERVICE_NAME = "claude_code_codex_plugin";
const NOTIFY_DIRECTOR_TOOL = {
  type: "function",
  name: "notify_director",
  description: "Send a short note to the director agent that started you, without stopping your work. Use it only for conclusions that change the plan, blockers you are working around, or a finished phase the director could act on now. Do not report routine progress. Returns immediately; the director does not reply through this tool. Notes longer than 400 characters are rejected.",
  inputSchema: {
    type: "object",
    properties: { message: { type: "string", maxLength: 400 } },
    required: ["message"],
    additionalProperties: false
  },
  deferLoading: false
};

function threadParams(cwd, options = {}) {
  return {
    cwd,
    model: options.model ?? null,
    approvalPolicy: options.approvalPolicy ?? "never",
    sandbox: options.sandbox ?? "read-only",
    serviceName: SERVICE_NAME,
    ephemeral: options.ephemeral ?? true,
    ...(options.persistThread ? { dynamicTools: [NOTIFY_DIRECTOR_TOOL] } : {})
  };
}

export function buildCodexTurnInput(prompt) {
  if (Array.isArray(prompt)) {
    return prompt.map((block) => block.type === "text"
      ? { type: "text", text: block.text, text_elements: [] }
      : block);
  }
  return [{ type: "text", text: String(prompt ?? ""), text_elements: [] }];
}

export async function startCodexSession(client, cwd, options = {}) {
  const response = await client.request("thread/start", threadParams(cwd, options));
  const sessionId = response.thread.id;
  if (options.threadName) {
    try {
      await client.request("thread/name/set", { threadId: sessionId, name: options.threadName });
    } catch (error) {
      const message = String(error?.message ?? error ?? "");
      if (!message.includes("unknown variant") && !message.includes("unknown method")) throw error;
    }
  }
  return response;
}

export function resumeCodexSession(client, sessionId, cwd, options = {}) {
  return client.request("thread/resume", {
    threadId: sessionId,
    cwd,
    model: options.model ?? null,
    approvalPolicy: options.approvalPolicy ?? "never",
    sandbox: options.sandbox ?? "read-only"
  });
}

export class CodexExecutorJobPort {
  constructor({ client, cwd, job, onProgress, captureTurn }) {
    this.kind = "codex";
    this.capabilities = CODEX_EXECUTOR_CAPABILITIES;
    this.client = client;
    this.cwd = cwd;
    this.job = job;
    this.onProgress = onProgress;
    this.captureTurn = captureTurn;
    this.queue = new ExecutorEventQueue();
    this.questions = new Map();
    this.activeTurn = null;
    this.previousHandler = client.notificationHandler;
    this.adapter = new CodexEventAdapter((event) => this.queue.push(event));
    client.setNotificationHandler((message) => {
      if (message.method === "companion/question") {
        this.questions.set(String(message.params.requestId), {
          sessionId: message.params.threadId,
          turnId: message.params.turnId
        });
      } else if (message.method === "serverRequest/resolved") {
        this.questions.delete(String(message.params.requestId));
      }
      void this.adapter.accept(structuredClone(message));
      this.previousHandler?.(message);
    });
  }

  static async open(options) {
    const port = new CodexExecutorJobPort(options);
    await registerObservedJob(options.client, options.cwd, options.onProgress);
    return port;
  }

  events() {
    return this.queue;
  }

  async startSession(request) {
    const response = await startCodexSession(this.client, request.cwd ?? this.cwd, request);
    await this.adapter.bindSession(response.thread.id, this.job);
    return { sessionId: response.thread.id, modes: null, configOptions: [] };
  }

  async resumeSession(request) {
    const response = await resumeCodexSession(this.client, request.sessionId, request.cwd ?? this.cwd, request);
    await this.adapter.bindSession(response.thread.id, this.job);
    return { sessionId: response.thread.id, modes: null, configOptions: [] };
  }

  async startTurn(request) {
    let resolveStarted;
    let rejectStarted;
    const started = new Promise((resolve, reject) => {
      resolveStarted = resolve;
      rejectStarted = reject;
    });
    const capture = this.captureTurn(
      this.client,
      request.sessionId,
      () => this.client.request("turn/start", {
        threadId: request.sessionId,
        input: buildCodexTurnInput(request.prompt),
        cwd: request.cwd ?? this.cwd,
        approvalPolicy: "never",
        sandboxPolicy: request.sandbox === "danger-full-access"
          ? { type: "dangerFullAccess" }
          : request.sandbox === "workspace-write"
            ? { type: "workspaceWrite", writableRoots: [request.cwd ?? this.cwd], networkAccess: Boolean(request.network), excludeTmpdirEnvVar: false, excludeSlashTmp: false }
            : { type: "readOnly", networkAccess: false },
        model: request.model ?? null,
        effort: request.effort ?? null,
        outputSchema: request.outputSchema ?? null
      }),
      {
        onProgress: this.onProgress,
        onResponse(response) {
          resolveStarted(response.turn?.id ?? null);
        }
      }
    );
    const done = capture.then((state) => codexTerminal(state), (error) => {
      rejectStarted(error);
      throw error;
    });
    // Settled before the await: a capture that fails rejects `started` too, and
    // an unhandled `done` would take the worker down before the caller sees it.
    const turn = { turnId: null, done, capture };
    done.then(
      () => { if (this.activeTurn === turn) this.activeTurn = null; },
      () => { if (this.activeTurn === turn) this.activeTurn = null; }
    );
    turn.turnId = await started;
    this.activeTurn = turn;
    return turn;
  }

  async answerQuestion(request) {
    const pending = this.questions.get(String(request.requestId));
    if (!pending) throw Object.assign(new Error("Question is not pending."), { code: "REQUEST_NOT_PENDING" });
    if (request.action !== "accept") {
      throw Object.assign(new Error("Codex questions require an accepted answer."), { code: "INVALID_RESPONSE" });
    }
    await this.client.request("broker/answer", { threadId: pending.sessionId, turnId: pending.turnId,
      requestId: request.requestId, answers: request.values ?? {} });
    this.questions.delete(String(request.requestId));
  }

  answerPermission() {
    throw Object.assign(new Error("Codex permission requests are disabled by policy."), { code: "UNSUPPORTED_CAPABILITY" });
  }

  async interruptTurn(request) {
    const active = this.activeTurn;
    if (!active || active.turnId !== request.turnId) {
      throw Object.assign(new Error("Turn is not active."), { code: "TURN_NOT_ACTIVE" });
    }
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error("Timed out waiting for turn cancellation."), {
        code: "CANCEL_TIMEOUT",
        retryable: true
      })), request.timeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([
        Promise.all([
          this.client.request("turn/interrupt", { threadId: request.sessionId, turnId: request.turnId }),
          active.done
        ]).then(([, terminal]) => terminal),
        timeout
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async cancelJob(request) {
    const terminal = await this.interruptTurn(request);
    return {
      ...terminal,
      status: "cancelled",
      reason: { code: "cancelled", backendCode: terminal.reason.backendCode, message: terminal.reason.message, retryable: false }
    };
  }

  async close() {
    this.client.setNotificationHandler(this.previousHandler ?? null);
    this.questions.clear();
    this.queue.close();
  }
}
