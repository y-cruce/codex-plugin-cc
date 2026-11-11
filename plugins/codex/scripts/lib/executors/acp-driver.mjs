import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { ReadableStream, WritableStream } from "node:stream/web";
import { fileURLToPath } from "node:url";

import { ClientSideConnection, PROTOCOL_VERSION, ndJsonStream } from "@agentclientprotocol/sdk";

import { createBrokerEndpoint, parseBrokerEndpoint } from "../broker-endpoint.mjs";
import { ExecutorEventQueue } from "../executor-port.mjs";
import { DirectorPublisher } from "../director-delivery.mjs";
import { excludeGeneratedSkill } from "../git.mjs";
import { JobRuntime } from "../job-runtime.mjs";
import { DEFAULT_INPUT_TIMEOUT_MS } from "../live-turn-control.mjs";
import { ACP_COMPANION_ENV, ACP_CONTROL_ENV } from "../observation-client.mjs";
import { AcpEventAdapter, normalizeAcpPermission, normalizeAcpQuestion } from "./acp-event-adapter.mjs";
import { antigravityMcpServers, antigravitySkillDirectories } from "./antigravity-session.mjs";
import { THREAD_RECORDS_ENABLED } from "../thread-records.mjs";

const CAPABILITIES = Object.freeze({
  resumeSession: true,
  sessionModes: true,
  structuredQuestions: true,
  permissionRequests: true,
  midTurnSteer: false,
  notifyDirector: true,
  commandOutputDelta: false,
  commandInteraction: false,
  turnDiff: false,
  subAgents: false
});

function nodeWritable(node) {
  return new WritableStream({
    write(chunk) {
      return new Promise((resolve, reject) => {
        node.write(Buffer.from(chunk), (error) => error ? reject(error) : resolve());
      });
    },
    close() { node.end(); },
    abort(error) { node.destroy(error); }
  });
}

function nodeReadable(node) {
  return new ReadableStream({
    start(controller) {
      node.on("data", (chunk) => controller.enqueue(new Uint8Array(chunk)));
      node.on("end", () => controller.close());
      node.on("error", (error) => controller.error(error));
    },
    cancel() { node.destroy(); }
  });
}

function send(socket, message) {
  if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
}

function rpcError(error) {
  return { code: -32600, message: error instanceof Error ? error.message : String(error),
    data: error?.code ? { code: error.code } : undefined };
}

function mapMcpServers(servers = []) {
  return servers.map((server) => structuredClone(server));
}

function selectOptionValues(option) {
  return (option.options ?? []).flatMap((entry) => Array.isArray(entry.options) ? entry.options : [entry])
    .map((entry) => entry.value);
}

function findModelOption(configOptions = []) {
  return configOptions.find((option) => option.type === "select" && option.id === "model") ??
    configOptions.find((option) => option.type === "select" && option.category === "model") ?? null;
}

function findReasoningEffortOption(configOptions = []) {
  return configOptions.find((option) => option.type === "select" && option.id === "reasoning_effort") ??
    configOptions.find((option) => option.type === "select" && option.id === "thinking_level") ?? null;
}

const REASONING_EFFORT_FALLBACKS = ["xhigh", "max", "high"];

function permissionQuestion(entry) {
  const message = entry.payload.interaction ? entry.payload.tool.title : `Permission requested: ${entry.payload.tool.title}`;
  return { requestId: entry.requestId, turnId: entry.turnId, kind: "permission",
    message, questions: [{ id: "optionId", question: message,
      options: entry.payload.options.map((option) => ({ label: option.name, value: option.optionId })) }],
    expiresAt: entry.payload.expiresAt ?? null };
}

function elicitationContent(values, fields) {
  return Object.fromEntries(Object.entries(values ?? {}).map(([id, value]) => {
    if (!Array.isArray(value?.answers)) return [id, value];
    const field = fields.find((item) => item.id === id);
    return [id, field?.rawSchema.type === "array" ? value.answers : value.answers[0]];
  }));
}

class AcpControlServer {
  constructor(port, runtime, cwd, jobId) {
    this.port = port;
    this.runtime = runtime;
    this.cwd = cwd;
    this.jobId = jobId;
    this.sockets = new Set();
  }

  async start() {
    this.directory = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "cxa-"));
    this.endpoint = createBrokerEndpoint(this.directory);
    const target = parseBrokerEndpoint(this.endpoint);
    this.server = net.createServer((socket) => this.accept(socket));
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(target.path, resolve);
    });
    return this.endpoint;
  }

  accept(socket) {
    this.sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        void this.handle(socket, JSON.parse(line));
      }
    });
    const close = () => { this.sockets.delete(socket); this.runtime.disconnected(socket); };
    socket.on("close", close);
    socket.on("error", close);
  }

  async handle(socket, message) {
    if (message.id === undefined) return;
    try {
      const p = message.params ?? {};
      let result;
      switch (message.method) {
        case "initialize": result = { userAgent: "acp-executor", observationVersion: 1 }; break;
        case "broker/observe-follow":
          result = await this.runtime.follow(socket, p.cwd ?? this.cwd, p.jobId, p.after);
          send(socket, { id: message.id, result });
          this.runtime.wake(this.runtime.followers.get(socket));
          return;
        case "broker/observe-status": result = { followers: this.runtime.followers.size }; break;
        case "broker/job-finish": result = await this.runtime.finish(p.cwd ?? this.cwd, p.jobId); break;
        case "executor/status": result = this.port.liveStatus(); break;
        case "executor/ack-notifications": result = this.port.ackNotifications(p.ids); break;
        case "executor/notify-director": result = await this.port.notifyDirector(p.message); break;
        case "executor/ask-director": result = await this.port.askDirector(p.question, p.options); break;
        case "executor/answer-question":
          await this.port.answerQuestion({ requestId: String(p.requestId), action: p.action, values: p.values });
          result = { answered: true, requestId: p.requestId };
          break;
        case "executor/answer-permission":
          await this.port.answerPermission({ requestId: String(p.requestId), outcome: p.outcome, optionId: p.optionId });
          result = { answered: true, requestId: p.requestId };
          break;
        case "executor/steer": result = await this.port.steerPrompt({ sessionId: p.executorSessionId, turnId: p.turnId, prompt: p.prompt }); break;
        case "executor/queue-turn": result = await this.port.queuePrompt({ turnId: p.turnId, prompt: p.prompt }); break;
        case "executor/interrupt-turn":
          result = await this.port.interruptTurn({ sessionId: this.port.sessionId, turnId: p.turnId, timeoutMs: this.port.cancelTimeoutMs,
            replacementPrompt: p.replacementPrompt ?? null });
          result = { interrupted: true, threadId: this.port.sessionId, turnId: p.turnId, partialChanges: [], terminal: result };
          break;
        case "executor/cancel-job":
          result = await this.port.cancelJob({ sessionId: this.port.sessionId, turnId: p.turnId, timeoutMs: this.port.cancelTimeoutMs });
          result = { interrupted: true, threadId: this.port.sessionId, turnId: p.turnId, partialChanges: [], terminal: result };
          break;
        default: throw new Error(`Unsupported executor request: ${message.method}`);
      }
      send(socket, { id: message.id, result });
    } catch (error) {
      send(socket, { id: message.id, error: rpcError(error) });
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const socket of this.sockets) socket.destroy();
    if (this.server) await new Promise((resolve) => this.server.close(resolve));
    if (this.directory) fs.rmSync(this.directory, { recursive: true, force: true });
  }
}

export class AcpExecutorJobPort {
  constructor(options) {
    this.kind = "acp";
    this.capabilities = { ...CAPABILITIES };
    this.cwd = options.cwd;
    this.job = options.job;
    this.command = options.command;
    this.args = options.args ?? [];
    this.env = options.env ?? process.env;
    this.modeId = options.modeId ?? null;
    this.permissionPolicy = options.permissionPolicy ?? null;
    this.inputTimeoutMs = options.inputTimeoutMs ?? DEFAULT_INPUT_TIMEOUT_MS;
    this.cancelTimeoutMs = options.cancelTimeoutMs ?? 15000;
    this.modelId = options.modelId ?? null;
    this.effortId = options.effortId ?? null;
    this.threadRecords = options.threadRecords ?? THREAD_RECORDS_ENABLED;
    this.onProgress = options.onProgress ?? null;
    this.createQueuedRound = options.createQueuedRound ?? null;
    this.queue = new ExecutorEventQueue();
    this.permissions = new Map();
    this.questions = new Map();
    this.notifications = [];
    this.queuedPrompts = [];
    this.activeTurn = null;
    this.replacementPrompt = null;
    this.stderr = "";
    this.startupPhase = "initialize";
    this.updateTail = Promise.resolve();
  }

  static async open(options) {
    if (!options.command) throw new Error("ACP execution requires --executor-command or CODEX_COMPANION_ACP_COMMAND.");
    const port = new AcpExecutorJobPort(options);
    try {
      await port.initialize();
      return port;
    } catch (error) {
      port.reportStartupFailure(error);
      await port.close().catch(() => {});
      throw error;
    }
  }

  reportStartupFailure(error) {
    this.onProgress?.({ message: `ACP startup failed (${this.startupPhase}): ${error.message ?? error}`,
      logTitle: "ACP startup failure", logBody: JSON.stringify({ phase: this.startupPhase,
        message: error.message ?? String(error), code: error.code ?? null, data: error.data ?? error.cause?.data ?? null,
        stderrTail: Buffer.from(this.stderr).subarray(-4096).toString("utf8") }, null, 2) });
  }

  createAdapter(job) {
    return new AcpEventAdapter(async (event) => {
      const owner = { ...job, executorSessionId: event.identity.sessionId, turnId: event.identity.turnId };
      const payload = { ...event.payload, threadId: event.identity.sessionId, turnId: event.identity.turnId };
      if (event.type === "question.opened") {
        this.director.publish(owner, event.type, { ...payload, expiresAt: payload.expiresAt == null ? null : Date.parse(payload.expiresAt) });
      } else if (event.type === "director.notified") this.director.publish(owner, event.type, payload);
      else if (event.type === "permission.requested" && !payload.interaction && !this.autoApprovePermissions()) {
        this.director.publish(owner, "question.opened", { ...permissionQuestion({ requestId: payload.requestId,
          turnId: payload.turnId, payload }), threadId: payload.threadId });
      } else if (["question.resolved", "question.closed", "permission.resolved"].includes(event.type)) {
        this.director.publish(owner, event.type === "permission.resolved" ? "question.resolved" : event.type, payload);
      } else if (["job.completed", "job.failed", "job.cancelled"].includes(event.type)) {
        this.director.publish({ ...owner, status: payload.status, errorMessage: payload.error?.message }, event.type, payload);
      }
      this.queue.push(event);
      await this.runtime.record(event);
    }, { job, receiveTime: this.receiveTime });
  }

  async initialize() {
    this.director = new DirectorPublisher({ onDelivered: (event) => {
      if (event.type === "director.notified") this.ackNotifications([event.payload.notificationId]);
    } });
    this.runtime = new JobRuntime({ directorPush: true, publishDirectorEvent: (job, type) => this.director.publish(job, type), threadRecords: this.threadRecords,
      executorIdentity: { kind: "acp", command: this.command, args: this.args } });
    this.owner = {};
    await this.runtime.register(this.owner, this.cwd, this.job.id);
    this.job = this.runtime.jobForSocket(this.owner);
    this.adapter = this.createAdapter(this.job);
    this.control = new AcpControlServer(this, this.runtime, this.cwd, this.job.id);
    this.controlEndpoint = await this.control.start();
    const env = { ...this.env, [ACP_CONTROL_ENV]: this.controlEndpoint,
      [ACP_COMPANION_ENV]: fileURLToPath(new URL("../../codex-companion.mjs", import.meta.url)) };
    this.proc = spawn(this.command, this.args, { cwd: this.cwd, env, stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32", windowsHide: true });
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (chunk) => {
      this.stderr += chunk;
      const turn = this.activeTurn;
      if (this.initializeResponse?.agentInfo?.name !== "antigravity-acp" || !turn?.accepting) return;
      const fatal = this.stderr.slice(turn.stderrOffset).match(/^[^\r\n]*harness stderr: Agent run failed:[^\r\n]*(?=\r?\n)/m)?.[0];
      if (fatal) turn.error = new Error(fatal);
    });
    this.exitPromise = new Promise((resolve) => {
      this.proc.once("exit", (code, signal) => {
        this.exit = { code, signal };
        resolve(this.exit);
      });
      this.proc.once("error", (error) => {
        this.exitError = error;
        resolve({ code: null, signal: null });
      });
    });
    const stream = ndJsonStream(nodeWritable(this.proc.stdin), nodeReadable(this.proc.stdout));
    this.connection = new ClientSideConnection(() => ({
      requestPermission: (params) => this.requestPermission(params),
      sessionUpdate: (params) => {
        this.updateTail = this.updateTail.then(() => this.adapter.accept(params));
        return this.updateTail;
      },
      createElicitation: (params) => this.createElicitation(params)
    }), stream);
    this.initializeResponse = await this.connection.initialize({ protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { elicitation: { form: {} }, plan: {} }, clientInfo: { name: "codex-companion", version: "1" } });
    const sessionCaps = this.initializeResponse.agentCapabilities?.sessionCapabilities ?? {};
    this.capabilities.resumeSession = Boolean(sessionCaps.resume);
    this.capabilities.sessionModes = false;
    this.steeringExtension = this.initializeResponse._meta?.steering?.supported === true;
    this.capabilities.midTurnSteer = this.steeringExtension || (this.initializeResponse.agentInfo?.name === "qoder-cli" &&
      this.initializeResponse.agentCapabilities?._meta?.qoder?.promptQueueing === true);
  }

  events() { return this.queue; }

  async sessionResult(sessionId, response, warnings = []) {
    this.sessionId = sessionId;
    const binding = await this.runtime.bind(this.owner, this.cwd, this.job.id, sessionId);
    this.recordId = binding.recordId ?? this.job.id;
    this.adapter.bindSession(sessionId);
    this.modes = response.modes ?? null;
    this.capabilities.sessionModes = Boolean(this.modes);
    this.configOptions = response.configOptions ?? [];
    for (const message of warnings) {
      await this.adapter.emit("source.warning", { code: "ANTIGRAVITY_MCP_CONFIG", message });
    }
    return { sessionId, modes: this.modes, configOptions: this.configOptions };
  }

  async bindQueuedRound(entry) {
    this.job = entry.round.job;
    await this.runtime.register(this.owner, this.cwd, this.job.id);
    this.job = this.runtime.jobForSocket(this.owner);
    const binding = await this.runtime.bind(this.owner, this.cwd, this.job.id, this.sessionId, null, entry.recordId);
    this.recordId = binding.recordId;
  }

  async startQueuedRound(entry, onProgress) {
    if (this.closed || this.exit) throw Object.assign(new Error("ACP executor session exited before the queued round started."), {
      code: "TRANSPORT_CLOSED", retryable: true
    });
    this.onProgress = onProgress;
    await this.bindQueuedRound(entry);
    this.adapter = this.createAdapter(this.job);
    this.adapter.bindSession(this.sessionId);
    this.control.jobId = this.job.id;
    this.notifications = [];
  }

  async applyMode(sessionId, response, modeId) {
    if (!modeId) return;
    const modes = response.modes?.availableModes ?? [];
    if (!modes.some((mode) => mode.id === modeId)) throw Object.assign(new Error(`ACP mode is not available: ${modeId}`), { code: "INVALID_STATE" });
    await this.connection.setSessionMode({ sessionId, modeId });
    this.modeId = modeId;
    response.modes = { ...response.modes, currentModeId: modeId };
  }

  async applyModel(sessionId, response, modelId) {
    if (!modelId) return;
    const option = findModelOption(response.configOptions);
    if (!option) {
      throw Object.assign(new Error(`ACP agent does not expose a model select option; cannot select model ${modelId}.`), {
        code: "UNSUPPORTED_CAPABILITY"
      });
    }
    const values = selectOptionValues(option);
    if (!values.includes(modelId)) {
      throw Object.assign(new Error(`ACP model ${modelId} is not available. Available values: ${values.join(", ") || "none"}.`), {
        code: "INVALID_STATE"
      });
    }
    let result;
    try {
      result = await this.connection.setSessionConfigOption({ sessionId, configId: option.id, value: modelId });
    } catch (error) {
      throw Object.assign(new Error(`ACP model selection failed for ${modelId}: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error
      }), { code: error?.code ?? "UNSUPPORTED_CAPABILITY" });
    }
    const selected = findModelOption(result.configOptions);
    if (!selected || selected.currentValue !== modelId) {
      throw Object.assign(new Error(`ACP agent did not confirm model ${modelId} after session/set_config_option.`), {
        code: "INVALID_RESPONSE"
      });
    }
    response.configOptions = result.configOptions;
  }

  effortNotice(message) {
    this.onProgress?.({ message, phase: "starting", stderrMessage: `Warning: ${message}` });
  }

  async applyReasoningEffort(sessionId, response, effortId) {
    if (!effortId) return null;
    const option = findReasoningEffortOption(response.configOptions);
    if (!option) {
      this.effortNotice(`ACP agent does not expose reasoning_effort; keeping its default for requested effort ${effortId}.`);
      return null;
    }
    const values = selectOptionValues(option);
    const selected = values.includes(effortId) ? effortId : REASONING_EFFORT_FALLBACKS.find((value) => values.includes(value));
    if (!selected) {
      this.effortNotice(`ACP reasoning effort ${effortId} is unavailable and no xhigh, max, or high fallback is exposed; keeping the agent default.`);
      return null;
    }
    if (selected !== effortId) {
      this.effortNotice(`ACP reasoning effort ${effortId} is unavailable; using ${selected}.`);
    }
    let result;
    try {
      result = await this.connection.setSessionConfigOption({ sessionId, configId: option.id, value: selected });
    } catch (error) {
      throw Object.assign(new Error(`ACP reasoning effort selection failed for ${selected}: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error
      }), { code: error?.code ?? "UNSUPPORTED_CAPABILITY" });
    }
    const confirmed = findReasoningEffortOption(result.configOptions);
    if (!confirmed || confirmed.currentValue !== selected) {
      throw Object.assign(new Error(`ACP agent did not confirm reasoning effort ${selected} after session/set_config_option.`), {
        code: "INVALID_RESPONSE"
      });
    }
    response.configOptions = result.configOptions;
    return selected;
  }

  sessionRequest(request) {
    const params = { cwd: request.cwd ?? this.cwd, additionalDirectories: request.additionalDirectories ?? [],
      mcpServers: mapMcpServers(request.mcpServers ?? []) };
    if (this.initializeResponse.agentInfo?.name !== "antigravity-acp") return { params };
    const home = this.env.HOME || os.homedir();
    const geminiHome = this.env.GEMINI_HOME?.replace(/^~(?=\/|$)/, home) || path.join(home, ".gemini");
    const codexHome = this.env.CODEX_HOME || path.join(home, ".codex");
    const directories = antigravitySkillDirectories(params.cwd, { home, geminiHome, codexHome });
    params.additionalDirectories = [...new Set([...params.additionalDirectories, path.resolve(home), ...directories])];
    // agy's workspace prompt sorts all roots, losing cwd's primary position.
    params._meta = { antigravity: { systemPrompt: { append:
      `The task's primary working directory is ${params.cwd}. Use it as Cwd for run_command unless the task explicitly requests another directory. Other workspace roots grant file access; their listed order does not select the task directory.` } } };
    const { mcpServers, warnings } = antigravityMcpServers(geminiHome, this.initializeResponse.agentCapabilities?.mcpCapabilities,
      params.mcpServers);
    params.mcpServers = mcpServers;
    return { params, warnings };
  }

  async startSession(request) {
    this.startupPhase = "session/new";
    const { params, warnings } = this.sessionRequest(request);
    const antigravity = this.initializeResponse.agentInfo?.name === "antigravity-acp";
    if (antigravity) excludeGeneratedSkill(params.cwd);
    const response = await this.connection.newSession(params);
    this.startupPhase = "ready";
    await this.applyMode(response.sessionId, response, request.modeId ?? this.modeId);
    const modelId = request.modelId ?? this.modelId ?? (antigravity ? process.env.CODEX_COMPANION_ANTIGRAVITY_MODEL || "gemini-4-carbon" : null);
    await this.applyModel(response.sessionId, response, modelId);
    const defaultEffort = antigravity ? (modelId.startsWith("claude-opus-") ? "medium" : "high") : null;
    const effortId = await this.applyReasoningEffort(response.sessionId, response,
      request.effortId ?? this.effortId ?? defaultEffort);
    return { ...await this.sessionResult(response.sessionId, response, warnings), effortId };
  }

  async resumeSession(request) {
    this.startupPhase = "session/resume";
    if (!this.capabilities.resumeSession) throw Object.assign(new Error("ACP agent does not support session/resume."), { code: "UNSUPPORTED_CAPABILITY" });
    const { params, warnings } = this.sessionRequest(request);
    const response = await this.connection.resumeSession({ sessionId: request.sessionId, ...params });
    this.startupPhase = "ready";
    await this.applyMode(request.sessionId, response, request.modeId ?? this.modeId);
    // A resumed session keeps the model it was created on. The default is ours
    // to pick when a session is new; imposing it here would switch a thread
    // that a dispatch had deliberately started somewhere else.
    await this.applyModel(request.sessionId, response, request.modelId ?? this.modelId);
    const effortId = await this.applyReasoningEffort(request.sessionId, response, request.effortId ?? this.effortId);
    return { ...await this.sessionResult(request.sessionId, response, warnings), effortId };
  }

  async setMode(request) {
    await this.connection.setSessionMode({ sessionId: request.sessionId, modeId: request.modeId });
    this.modeId = request.modeId;
  }

  async setConfigOption(request) {
    return this.connection.setSessionConfigOption({ sessionId: request.sessionId, configId: request.configId,
      ...(request.type === "boolean" ? { type: "boolean" } : {}), value: request.value });
  }

  async startTurn(request) {
    if (this.failure) throw this.failure;
    if (this.activeTurn) throw Object.assign(new Error("A turn is already active."), { code: "INVALID_STATE" });
    const turnId = `turn:${crypto.randomUUID()}`;
    await this.adapter.startTurn(turnId, request.prompt);
    const active = { turnId, interrupting: false, cancelling: false, accepting: true, messages: [], error: null,
      stderrOffset: this.stderr.length };
    this.activeTurn = active;
    const failed = new Promise((_, reject) => { active.fail = reject; });
    active.done = Promise.race([this.promptResponse(request.prompt, request.sessionId).then(async (value) => {
      active.accepting = false;
      await this.updateTail;
      await this.cancelPending();
      if (active.error) throw active.error;
      return this.adapter.completeTurn(value, { interrupting: active.interrupting && !active.cancelling });
    }).catch((error) => { throw active.error ?? error; }), failed]);
    const settled = () => { active.accepting = false; if (this.activeTurn === active) this.activeTurn = null; };
    active.done.then(settled, settled);
    return { turnId, done: active.done };
  }

  promptResponse(prompt, sessionId = this.sessionId) {
    const response = Promise.resolve().then(() => this.connection.prompt({ sessionId, prompt: structuredClone(prompt) }));
    return Promise.race([response, this.exitPromise.then(() => {
      throw Object.assign(this.exitError ?? new Error(`ACP process exited before the prompt completed.${this.stderr ? `\n${this.stderr.trim()}` : ""}`),
        { code: "TRANSPORT_CLOSED", retryable: true });
    })]).catch((error) => {
      if (/connection closed|transport|stream/i.test(error?.message ?? "")) Object.assign(error, { code: "TRANSPORT_CLOSED", retryable: true });
      throw error;
    });
  }

  async steerPrompt(request) {
    if (!this.capabilities.midTurnSteer) throw Object.assign(new Error("This executor does not support mid-turn steering."), { code: "UNSUPPORTED_CAPABILITY" });
    const active = this.activeTurn;
    if (!active || active.turnId !== request.turnId || request.sessionId !== this.sessionId || !active.accepting || active.interrupting || active.cancelling) {
      throw Object.assign(new Error("Turn is not active."), { code: "TURN_NOT_ACTIVE" });
    }
    if (this.questions.size || this.permissions.size) throw Object.assign(new Error("Answer the pending question with answer, or use message --interrupt."), { code: "INVALID_STATE" });
    if (!Array.isArray(request.prompt) || !request.prompt.length ||
        request.prompt.some((item) => item.type !== "text" || !item.text?.trim())) {
      throw Object.assign(new Error("A nonempty text message is required."), { code: "INVALID_ARGUMENT" });
    }
    const adapter = this.adapter;
    let accepted = null;
    if (this.steeringExtension) {
      const result = await this.connection.extMethod("_session/steering", {
        sessionId: this.sessionId, prompt: structuredClone(request.prompt),
        _meta: { steering: { idleBehavior: "promptRequired" } }
      });
      if (result?.outcome === "promptRequired") {
        throw Object.assign(new Error("Turn is no longer active; the steering message was not delivered."), { code: "TURN_NOT_ACTIVE" });
      }
      if (result?.outcome !== "injected") {
        throw Object.assign(new Error(`ACP steering was not confirmed: ${result?.outcome ?? "missing outcome"}.`), { code: "INVALID_RESPONSE" });
      }
      accepted = true;
    }
    const message = { id: crypto.randomUUID(), input: structuredClone(request.prompt), status: "sent" };
    active.messages.push(message);
    const rejected = async (error) => {
      if (!active.accepting || this.closed) return;
      active.error ??= error;
      message.status = "rejected";
      message.error = error.message;
      await adapter.emit("source.error", { code: error.code ?? "STEERING_REJECTED", message: error.message },
        { turnId: active.turnId, messageId: message.id }, null, "session/prompt");
    };
    // Qoder 1.1.78 can consume a queued prompt without settling its RPC.
    // The root response owns completion; keep observing errors until then.
    if (!this.steeringExtension) void this.promptResponse(message.input).then((value) => {
      if (!active.accepting || this.closed) return;
      if (value.stopReason === "cancelled" && (active.cancelling || active.interrupting)) return;
      if (value.stopReason !== "end_turn") return rejected(new Error(`Qoder steering ended: ${value.stopReason}`));
      message.status = "completed";
    }, rejected).catch((error) => { if (active.accepting) active.error ??= error; });
    await adapter.controlMessage(message.input, "steer", active.turnId, undefined, accepted);
    if (message.status === "rejected") throw active.error;
    return { turnId: active.turnId, messageId: message.id, sent: true, accepted, consumed: null,
      note: accepted ? "The ACP agent confirmed insertion into the active turn; model consumption is not acknowledged."
        : "Sent to Qoder's active session; acceptance and model consumption are not acknowledged separately." };
  }

  async queuePrompt(request) {
    if (this.failure) throw this.failure;
    if (!this.activeTurn || this.activeTurn.turnId !== request.turnId) {
      throw Object.assign(new Error("Turn is not active."), { code: "TURN_NOT_ACTIVE" });
    }
    if (!Array.isArray(request.prompt) || !request.prompt.length ||
        request.prompt.some((item) => item.type !== "text" || !item.text?.trim())) {
      throw Object.assign(new Error("A nonempty text message is required."), { code: "INVALID_ARGUMENT" });
    }
    if (!this.createQueuedRound) throw Object.assign(new Error("Queued ACP rounds are unavailable."), { code: "UNSUPPORTED_CAPABILITY" });
    if (this.queuedPrompts.length >= 100) throw Object.assign(new Error("Pending message queue is full (100 messages)."), { code: "QUEUE_FULL" });
    const input = structuredClone(request.prompt);
    const round = this.createQueuedRound({ input, sourceJobId: this.job.id, sessionId: this.sessionId,
      controlEndpoint: this.controlEndpoint, recordId: this.recordId });
    const entry = { id: crypto.randomUUID(), jobId: round.job.id, input, status: "accepted", queued: true,
      recordId: this.recordId, round };
    this.queuedPrompts.push(entry);
    await this.adapter.controlMessage(input, "queued", request.turnId, entry.jobId);
    return { queued: true, messageId: entry.id, queuedJobId: entry.jobId };
  }

  takeQueuedPrompt() { return this.queuedPrompts.shift() ?? null; }
  drainQueuedPrompts() { return this.queuedPrompts.splice(0); }

  autoApprovePermissions() {
    return this.permissionPolicy === "allow-once" || (this.permissionPolicy !== "ask" && this.modeId === "yolo");
  }

  async notifyDirector(message) {
    const active = this.activeTurn;
    if (!active?.accepting || active.interrupting || active.cancelling) throw new Error("No active ACP turn.");
    if (typeof message !== "string" || !message.trim() || [...message].length > 400) {
      throw new Error("Provide a nonempty message of at most 400 characters.");
    }
    const id = crypto.randomBytes(6).toString("hex");
    const pending = this.questions.keys().next().value ?? this.permissions.keys().next().value;
    const note = { id, notificationId: id, message, turnId: active.turnId, receivedAt: new Date().toISOString(),
      pendingRequestId: pending ?? null };
    this.notifications.push(note);
    await this.adapter.emit("director.notified", note, {}, null, "executor/notify-director");
    return { notificationId: id };
  }

  ackNotifications(ids) {
    this.notifications = this.notifications.filter((note) => !ids?.includes(note.id));
    return { remaining: this.notifications.length };
  }

  async askDirector(question, options = []) {
    if (!this.activeTurn?.accepting) throw new Error("No active ACP turn.");
    if (typeof question !== "string" || !question.trim() || !Array.isArray(options) ||
        options.some((option) => typeof option !== "string" || !option.trim())) {
      throw new Error("Provide a question and an array of nonempty option strings.");
    }
    const response = await this.createElicitation({ message: question, requestedSchema: {
      type: "object", properties: { answer: { type: "string", title: question,
        ...(options.length ? { enum: options } : {}) } }, required: ["answer"] } }, "executor/ask-director");
    if (response.action !== "accept") throw new Error(this.activeTurn?.error?.code === "INPUT_TIMEOUT"
      ? "Waiting for director answer timed out after 10 minutes." : "Director question was cancelled.");
    return { answer: response.content.answer };
  }

  waitForAnswer(requests, entry) {
    return new Promise((resolve) => {
      const pending = { ...entry, resolve };
      pending.timer = setTimeout(() => {
        if (requests.get(entry.requestId) !== pending) return;
        this.settlePending(pending, "expired");
        const active = this.activeTurn;
        const sameTurn = active && active.turnId === pending.turnId;
        if (sameTurn) {
          active.error ??= Object.assign(new Error("Waiting for user answer timed out."), { code: "INPUT_TIMEOUT" });
          this.failure = active.error;
          active.accepting = false;
        }
        const stopped = sameTurn ? this.stopTurn({ sessionId: this.sessionId, turnId: active.turnId,
          timeoutMs: this.cancelTimeoutMs }, true) : this.cancelPending();
        void stopped.catch((error) => {
          if (sameTurn && this.activeTurn === active) {
            active.error.message += ` Interrupt failed: ${error.message}`;
            active.fail(active.error);
          }
        });
      }, this.inputTimeoutMs);
      pending.timer.unref?.();
      requests.set(entry.requestId, pending);
    });
  }

  interactionEvent(entry) {
    const question = permissionQuestion(entry);
    const [field] = question.questions;
    return { requestId: entry.requestId, message: question.message, mode: "form", url: null,
      fields: [{ id: field.id, title: field.question, description: null, required: true, kind: "single_select", options: field.options }],
      openedAt: new Date(entry.payload.expiresAt - this.inputTimeoutMs).toISOString(),
      expiresAt: new Date(entry.payload.expiresAt).toISOString() };
  }

  async requestPermission(params) {
    if (this.failure) return { outcome: { outcome: "cancelled" } };
    // The tool this asks about was announced by an earlier update, and the
    // adapter applies updates asynchronously while the protocol delivers this
    // request independently of them. Reading its table too early would leave
    // the question with nothing but the call's id.
    await this.updateTail;
    const requestId = `permission:${crypto.randomUUID()}`;
    const remembered = this.adapter.tools?.get(String(params.toolCall?.toolCallId)) ?? null;
    const payload = normalizeAcpPermission(params, requestId, remembered);
    const interaction = this.initializeResponse?.agentInfo?.name === "antigravity-acp" && payload.tool.toolCallId.startsWith("interaction_");
    const automatic = !interaction && this.autoApprovePermissions();
    Object.assign(payload, { interaction, expiresAt: automatic ? null : Date.now() + this.inputTimeoutMs });
    const emitted = this.adapter.emit("permission.requested", payload, { requestId, toolCallId: payload.tool.toolCallId }, params,
      "session/request_permission");
    if (automatic) {
      const option = this.permissionPolicy === "allow-once"
        ? payload.options.find((item) => item.kind === "allow_once") ?? null
        : payload.options.find((item) => item.kind === "allow_always") ??
          payload.options.find((item) => item.kind === "allow_once") ??
          payload.options.find((item) => item.kind.startsWith("allow")) ?? null;
      const outcome = option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" };
      return emitted.then(async () => {
        await this.adapter.emit("permission.resolved", { requestId, outcome: outcome.outcome,
          optionId: option?.optionId ?? null }, { requestId }, { outcome }, "session/request_permission");
        return { outcome };
      });
    }
    const entry = { requestId, turnId: this.activeTurn?.turnId ?? null, payload };
    const reply = this.waitForAnswer(this.permissions, entry);
    await emitted;
    if (interaction) await this.adapter.emit("question.opened", this.interactionEvent(entry), { requestId }, null, "session/request_permission");
    return reply;
  }

  createElicitation(params, method = "elicitation/create") {
    if (this.failure) return Promise.resolve({ action: "cancel" });
    const requestId = `question:${crypto.randomUUID()}`;
    const receivedAt = new Date().toISOString();
    const payload = normalizeAcpQuestion(params, requestId, receivedAt);
    const expiresAt = Date.parse(receivedAt) + this.inputTimeoutMs;
    payload.expiresAt = new Date(expiresAt).toISOString();
    const reply = this.waitForAnswer(this.questions, { requestId, turnId: this.activeTurn?.turnId ?? null, payload, expiresAt, method });
    void this.adapter.emit("question.opened", payload, { requestId }, params, method);
    return reply;
  }

  settlePending(pending, status) {
    this.director.publish({ ...this.job, executorSessionId: this.sessionId, turnId: pending.turnId }, `question.${status}`,
      { requestId: pending.requestId, threadId: this.sessionId, turnId: pending.turnId });
  }

  async answerQuestion(request) {
    const pending = this.questions.get(String(request.requestId));
    if (!pending) throw Object.assign(new Error("Question is not pending."), { code: "REQUEST_NOT_PENDING" });
    this.settlePending(pending, "resolved");
    this.questions.delete(String(request.requestId));
    clearTimeout(pending.timer);
    const response = request.action === "accept"
      ? { action: "accept", content: elicitationContent(request.values, pending.payload.fields) } : { action: request.action };
    pending.resolve(response);
    await this.adapter.emit("question.resolved", { requestId: pending.requestId, action: request.action,
      values: request.values ?? null }, { requestId: pending.requestId }, response, pending.method);
    await this.adapter.emit("question.closed", { requestId: pending.requestId, reason: request.action === "accept" ? "answered" : "cancelled" },
      { requestId: pending.requestId }, response, pending.method);
  }

  async answerPermission(request) {
    const pending = this.permissions.get(String(request.requestId));
    if (!pending) throw Object.assign(new Error("Permission request is not pending."), { code: "REQUEST_NOT_PENDING" });
    this.settlePending(pending, "resolved");
    this.permissions.delete(String(request.requestId));
    clearTimeout(pending.timer);
    const outcome = request.outcome === "selected" ? { outcome: "selected", optionId: request.optionId } : { outcome: "cancelled" };
    pending.resolve({ outcome });
    await this.recordPermissionOutcome(pending, outcome);
  }

  async recordPermissionOutcome(pending, outcome) {
    const { requestId } = pending;
    await this.adapter.emit("permission.resolved", { requestId, outcome: outcome.outcome, optionId: outcome.optionId ?? null },
      { requestId }, outcome, "session/request_permission");
    if (pending.payload.interaction) {
      const selected = outcome.outcome === "selected";
      await this.adapter.emit("question.resolved", { requestId, action: selected ? "accept" : "cancel",
        values: selected ? { optionId: outcome.optionId } : null }, { requestId }, outcome, "session/request_permission");
      await this.adapter.emit("question.closed", { requestId, reason: selected ? "answered" : "cancelled" },
        { requestId }, outcome, "session/request_permission");
    }
  }

  async cancelPending() {
    const permissions = [...this.permissions.values()];
    this.permissions.clear();
    for (const pending of permissions) {
      clearTimeout(pending.timer);
      this.settlePending(pending, "closed");
      const response = { outcome: { outcome: "cancelled" } };
      pending.resolve(response);
      await this.recordPermissionOutcome(pending, response.outcome);
    }
    const questions = [...this.questions.values()];
    this.questions.clear();
    for (const pending of questions) {
      clearTimeout(pending.timer);
      this.settlePending(pending, "closed");
      const response = { action: "cancel" };
      pending.resolve(response);
      await this.adapter.emit("question.resolved", { requestId: pending.requestId, action: "cancel", values: null },
        { requestId: pending.requestId }, response, pending.method);
      await this.adapter.emit("question.closed", { requestId: pending.requestId, reason: "cancelled" },
        { requestId: pending.requestId }, response, pending.method);
    }
  }

  async stopTurn(request, cancelling) {
    const active = this.activeTurn;
    if (!active || active.turnId !== request.turnId) throw Object.assign(new Error("Turn is not active."), { code: "TURN_NOT_ACTIVE" });
    active.interrupting = !cancelling;
    active.cancelling = cancelling;
    await this.cancelPending();
    // Stored before the cancel is sent, not after the turn has ended. The
    // cancel cannot be taken back, so a replacement kept only on the one path
    // where the agent ends the turn as `interrupted` is lost on every other:
    // a dropped connection, a different stop reason, a cancellation that times
    // out. It is also read the moment the turn settles -- the run loop awaits
    // the same promise this method does, and it was there first -- so a write
    // made after that race resolves comes too late even when nothing failed.
    // Cleared again only when the cancel itself never left.
    if (!cancelling && request.replacementPrompt) this.replacementPrompt = request.replacementPrompt;
    try {
      await this.connection.cancel({ sessionId: request.sessionId });
    } catch (error) {
      if (!cancelling) this.replacementPrompt = null;
      throw error;
    }
    let timer;
    try {
      const terminal = await Promise.race([active.done, new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error("Timed out waiting for ACP cancellation."), { code: "CANCEL_TIMEOUT" })), request.timeoutMs);
        timer.unref?.();
      })]);
      if (!cancelling && request.replacementPrompt) await this.adapter.controlMessage(request.replacementPrompt, "interrupt", request.turnId);
      return terminal;
    } finally { clearTimeout(timer); }
  }

  interruptTurn(request) { return this.stopTurn(request, false); }
  cancelJob(request) { return this.stopTurn(request, true); }
  takeReplacementPrompt() { const value = this.replacementPrompt; this.replacementPrompt = null; return value; }

  liveStatus() {
    const permissions = [...this.permissions.values()].map(permissionQuestion);
    return { threadId: this.sessionId, turnId: this.activeTurn?.turnId ?? null,
      pendingMessages: (this.activeTurn?.messages ?? []).filter(entry => entry.status === "sent").map(entry => structuredClone(entry))
        .concat(this.queuedPrompts.map((entry) => structuredClone({ id: entry.id, jobId: entry.jobId,
          input: entry.input, status: entry.status, queued: entry.queued }))),
      undeliveredMessages: (this.activeTurn?.messages ?? []).filter(entry => entry.status === "rejected").map(entry => structuredClone(entry)),
      questions: [...this.questions.values()].map((entry) => ({ requestId: entry.requestId, turnId: entry.turnId,
        message: entry.payload.message, questions: entry.payload.fields.map((field) => ({ id: field.id,
          question: field.description ?? field.title ?? field.id, options: field.options })), expiresAt: entry.expiresAt })).concat(permissions),
      permissions, notifications: this.notifications, interrupting: Boolean(this.activeTurn?.interrupting),
      partialChanges: [], error: null, capabilities: { midTurnSteer: this.capabilities.midTurnSteer, notifyDirector: true } };
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.control?.close();
    await this.cancelPending();
    if (this.proc && this.proc.exitCode === null) {
      this.proc.stdin.end();
      this.proc.kill("SIGTERM");
      let timer;
      await Promise.race([this.exitPromise, new Promise((resolve) => {
        timer = setTimeout(resolve, 1000);
        timer.unref?.();
      })]);
      clearTimeout(timer);
      if (this.proc.exitCode === null) {
        this.proc.kill("SIGKILL");
        await this.exitPromise;
      }
    }
    await this.connection?.closed;
    await this.updateTail;
    this.queue.close();
    await this.runtime?.close();
  }
}

export async function openAcpExecutorJob(options) {
  return AcpExecutorJobPort.open(options);
}
