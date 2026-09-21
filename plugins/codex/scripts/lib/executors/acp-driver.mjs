import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { ReadableStream, WritableStream } from "node:stream/web";

import { ClientSideConnection, PROTOCOL_VERSION, ndJsonStream } from "@agentclientprotocol/sdk";

import { createBrokerEndpoint, parseBrokerEndpoint } from "../broker-endpoint.mjs";
import { ExecutorEventQueue } from "../executor-port.mjs";
import { JobRuntime } from "../job-runtime.mjs";
import { AcpEventAdapter, normalizeAcpPermission, normalizeAcpQuestion } from "./acp-event-adapter.mjs";
import { THREAD_RECORDS_ENABLED } from "../thread-records.mjs";

const CAPABILITIES = Object.freeze({
  resumeSession: true,
  sessionModes: true,
  structuredQuestions: true,
  permissionRequests: true,
  midTurnSteer: false,
  notifyDirector: false,
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
  return configOptions.find((option) => option.type === "select" && option.id === "reasoning_effort") ?? null;
}

const REASONING_EFFORT_FALLBACKS = ["xhigh", "max", "high"];

function permissionQuestion(entry) {
  return { requestId: entry.requestId, turnId: entry.turnId, message: `Permission requested: ${entry.payload.tool.title}`,
    questions: [{ id: "optionId", question: `Permission requested: ${entry.payload.tool.title}`,
      options: entry.payload.options.map((option) => ({ label: option.name, value: option.optionId })) }], expiresAt: null };
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
        case "executor/ack-notifications": result = { remaining: 0 }; break;
        case "executor/answer-question":
          await this.port.answerQuestion({ requestId: String(p.requestId), action: p.action, values: p.values });
          result = { answered: true, requestId: p.requestId };
          break;
        case "executor/answer-permission":
          await this.port.answerPermission({ requestId: String(p.requestId), outcome: p.outcome, optionId: p.optionId });
          result = { answered: true, requestId: p.requestId };
          break;
        case "executor/steer": throw Object.assign(new Error("This executor does not support mid-turn steering."), { code: "UNSUPPORTED_CAPABILITY" });
        case "executor/interrupt-turn":
          result = await this.port.interruptTurn({ sessionId: this.port.sessionId, turnId: p.turnId, timeoutMs: 15000,
            replacementPrompt: p.replacementPrompt ?? null });
          result = { interrupted: true, threadId: this.port.sessionId, turnId: p.turnId, partialChanges: [], terminal: result };
          break;
        case "executor/cancel-job":
          result = await this.port.cancelJob({ sessionId: this.port.sessionId, turnId: p.turnId, timeoutMs: 15000 });
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
    await new Promise((resolve) => this.server.close(resolve));
    fs.rmSync(this.directory, { recursive: true, force: true });
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
    this.modelId = options.modelId ?? null;
    this.effortId = options.effortId ?? null;
    this.threadRecords = options.threadRecords ?? THREAD_RECORDS_ENABLED;
    this.onProgress = options.onProgress ?? null;
    this.queue = new ExecutorEventQueue();
    this.permissions = new Map();
    this.questions = new Map();
    this.activeTurn = null;
    this.replacementPrompt = null;
    this.stderr = "";
    this.updateTail = Promise.resolve();
  }

  static async open(options) {
    if (!options.command) throw new Error("ACP execution requires --executor-command or CODEX_COMPANION_ACP_COMMAND.");
    const port = new AcpExecutorJobPort(options);
    try {
      await port.initialize();
      return port;
    } catch (error) {
      await port.close().catch(() => {});
      throw error;
    }
  }

  async initialize() {
    this.runtime = new JobRuntime({ threadRecords: this.threadRecords,
      executorIdentity: { kind: "acp", command: this.command, args: this.args } });
    this.owner = {};
    await this.runtime.register(this.owner, this.cwd, this.job.id);
    this.adapter = new AcpEventAdapter(async (event) => {
      this.queue.push(event);
      await this.runtime.record(event);
    }, { job: this.job, receiveTime: this.receiveTime });
    this.proc = spawn(this.command, this.args, { cwd: this.cwd, env: this.env, stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32", windowsHide: true });
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (chunk) => { this.stderr += chunk; });
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
    this.capabilities.sessionModes = true;
    this.control = new AcpControlServer(this, this.runtime, this.cwd, this.job.id);
    this.controlEndpoint = await this.control.start();
  }

  events() { return this.queue; }

  async sessionResult(sessionId, response) {
    this.sessionId = sessionId;
    await this.runtime.bind(this.owner, this.cwd, this.job.id, sessionId);
    this.adapter.bindSession(sessionId);
    this.modes = response.modes ?? null;
    this.configOptions = response.configOptions ?? [];
    return { sessionId, modes: this.modes, configOptions: this.configOptions };
  }

  async applyMode(sessionId, response, modeId) {
    if (!modeId) return;
    const modes = response.modes?.availableModes ?? [];
    if (!modes.some((mode) => mode.id === modeId)) throw Object.assign(new Error(`ACP mode is not available: ${modeId}`), { code: "INVALID_STATE" });
    await this.connection.setSessionMode({ sessionId, modeId });
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

  async startSession(request) {
    const response = await this.connection.newSession({ cwd: request.cwd ?? this.cwd,
      additionalDirectories: request.additionalDirectories ?? [], mcpServers: mapMcpServers(request.mcpServers ?? []) });
    await this.applyMode(response.sessionId, response, request.modeId ?? this.modeId);
    await this.applyModel(response.sessionId, response, request.modelId ?? this.modelId);
    const effortId = await this.applyReasoningEffort(response.sessionId, response, request.effortId ?? this.effortId);
    return { ...await this.sessionResult(response.sessionId, response), effortId };
  }

  async resumeSession(request) {
    if (!this.capabilities.resumeSession) throw Object.assign(new Error("ACP agent does not support session/resume."), { code: "UNSUPPORTED_CAPABILITY" });
    const response = await this.connection.resumeSession({ sessionId: request.sessionId, cwd: request.cwd ?? this.cwd,
      additionalDirectories: request.additionalDirectories ?? [], mcpServers: mapMcpServers(request.mcpServers ?? []) });
    await this.applyMode(request.sessionId, response, request.modeId ?? this.modeId);
    await this.applyModel(request.sessionId, response, request.modelId ?? this.modelId);
    const effortId = await this.applyReasoningEffort(request.sessionId, response, request.effortId ?? this.effortId);
    return { ...await this.sessionResult(request.sessionId, response), effortId };
  }

  async setMode(request) {
    await this.connection.setSessionMode({ sessionId: request.sessionId, modeId: request.modeId });
  }

  async setConfigOption(request) {
    return this.connection.setSessionConfigOption({ sessionId: request.sessionId, configId: request.configId,
      ...(request.type === "boolean" ? { type: "boolean" } : {}), value: request.value });
  }

  async startTurn(request) {
    if (this.activeTurn) throw Object.assign(new Error("A turn is already active."), { code: "INVALID_STATE" });
    const turnId = `turn:${crypto.randomUUID()}`;
    await this.adapter.startTurn(turnId, request.prompt);
    const active = { turnId, interrupting: false, cancelling: false };
    const response = this.connection.prompt({ sessionId: request.sessionId, prompt: structuredClone(request.prompt) }).catch((error) => {
      if (/connection closed|transport|stream/i.test(error?.message ?? "")) {
        throw Object.assign(error, { code: "TRANSPORT_CLOSED", retryable: true });
      }
      throw error;
    });
    active.done = Promise.race([response, this.exitPromise.then(() => {
      throw Object.assign(this.exitError ?? new Error(`ACP process exited before the prompt completed.${this.stderr ? `\n${this.stderr.trim()}` : ""}`),
        { code: "TRANSPORT_CLOSED", retryable: true });
    })]).then(async (value) => {
      await this.updateTail;
      return this.adapter.completeTurn(value, { interrupting: active.interrupting && !active.cancelling });
    });
    this.activeTurn = active;
    active.done.then(() => { if (this.activeTurn === active) this.activeTurn = null; },
      () => { if (this.activeTurn === active) this.activeTurn = null; });
    return { turnId, done: active.done };
  }

  requestPermission(params) {
    const requestId = `permission:${crypto.randomUUID()}`;
    const payload = normalizeAcpPermission(params, requestId);
    void this.adapter.emit("permission.requested", payload, { requestId, toolCallId: payload.tool.toolCallId }, params,
      "session/request_permission");
    return new Promise((resolve) => this.permissions.set(requestId, { requestId, turnId: this.activeTurn?.turnId ?? null,
      payload, resolve }));
  }

  createElicitation(params) {
    const requestId = `question:${crypto.randomUUID()}`;
    const receivedAt = new Date().toISOString();
    const payload = normalizeAcpQuestion(params, requestId, receivedAt);
    void this.adapter.emit("question.opened", payload, { requestId }, params, "elicitation/create");
    return new Promise((resolve) => this.questions.set(requestId, { requestId, turnId: this.activeTurn?.turnId ?? null,
      payload, resolve }));
  }

  async answerQuestion(request) {
    const pending = this.questions.get(String(request.requestId));
    if (!pending) throw Object.assign(new Error("Question is not pending."), { code: "REQUEST_NOT_PENDING" });
    this.questions.delete(String(request.requestId));
    const response = request.action === "accept" ? { action: "accept", content: request.values ?? {} } : { action: request.action };
    pending.resolve(response);
    await this.adapter.emit("question.resolved", { requestId: pending.requestId, action: request.action,
      values: request.values ?? null }, { requestId: pending.requestId }, response, "elicitation/create");
    await this.adapter.emit("question.closed", { requestId: pending.requestId, reason: request.action === "accept" ? "answered" : "cancelled" },
      { requestId: pending.requestId }, response, "elicitation/create");
  }

  async answerPermission(request) {
    const pending = this.permissions.get(String(request.requestId));
    if (!pending) throw Object.assign(new Error("Permission request is not pending."), { code: "REQUEST_NOT_PENDING" });
    this.permissions.delete(String(request.requestId));
    const outcome = request.outcome === "selected" ? { outcome: "selected", optionId: request.optionId } : { outcome: "cancelled" };
    pending.resolve({ outcome });
    await this.adapter.emit("permission.resolved", { requestId: pending.requestId, outcome: request.outcome,
      optionId: request.optionId ?? null }, { requestId: pending.requestId }, outcome, "session/request_permission");
  }

  async cancelPending() {
    const permissions = [...this.permissions.values()];
    this.permissions.clear();
    for (const pending of permissions) {
      const response = { outcome: { outcome: "cancelled" } };
      pending.resolve(response);
      await this.adapter.emit("permission.resolved", { requestId: pending.requestId, outcome: "cancelled", optionId: null },
        { requestId: pending.requestId }, response, "session/request_permission");
    }
    const questions = [...this.questions.values()];
    this.questions.clear();
    for (const pending of questions) {
      const response = { action: "cancel" };
      pending.resolve(response);
      await this.adapter.emit("question.resolved", { requestId: pending.requestId, action: "cancel", values: null },
        { requestId: pending.requestId }, response, "elicitation/create");
      await this.adapter.emit("question.closed", { requestId: pending.requestId, reason: "cancelled" },
        { requestId: pending.requestId }, response, "elicitation/create");
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
      return await Promise.race([active.done, new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error("Timed out waiting for ACP cancellation."), { code: "CANCEL_TIMEOUT" })), request.timeoutMs);
        timer.unref?.();
      })]);
    } finally { clearTimeout(timer); }
  }

  interruptTurn(request) { return this.stopTurn(request, false); }
  cancelJob(request) { return this.stopTurn(request, true); }
  takeReplacementPrompt() { const value = this.replacementPrompt; this.replacementPrompt = null; return value; }

  liveStatus() {
    return { threadId: this.sessionId, turnId: this.activeTurn?.turnId ?? null, pendingMessages: [], undeliveredMessages: [],
      questions: [...this.questions.values()].map((entry) => ({ requestId: entry.requestId, turnId: entry.turnId,
        message: entry.payload.message, questions: entry.payload.fields.map((field) => ({ id: field.id,
          question: field.description ?? field.title ?? field.id, options: field.options })), expiresAt: null })),
      permissions: [...this.permissions.values()].map(permissionQuestion), notifications: [], interrupting: Boolean(this.activeTurn?.interrupting),
      partialChanges: [], error: null, capabilities: { midTurnSteer: false } };
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
