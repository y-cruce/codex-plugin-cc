#!/usr/bin/env node

import fs from "node:fs";
import crypto from "node:crypto";
import { ReadableStream, WritableStream } from "node:stream/web";
import { AgentSideConnection, PROTOCOL_VERSION, ndJsonStream } from "@agentclientprotocol/sdk";

if (process.env.ACP_FAKE_PID_FILE) fs.writeFileSync(process.env.ACP_FAKE_PID_FILE, `${process.pid}\n`);

function nodeWritable(node) {
  return new WritableStream({
    write(chunk) { return new Promise((resolve, reject) => node.write(Buffer.from(chunk), (error) => error ? reject(error) : resolve())); },
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
    }
  });
}

function record(value) {
  if (process.env.ACP_FAKE_RECORDING) fs.appendFileSync(process.env.ACP_FAKE_RECORDING, `${JSON.stringify(value)}\n`);
}

const modes = { currentModeId: "default", availableModes: ["default", "acceptEdits", "auto", "dontAsk", "yolo"].map((id) => ({ id, name: id, description: null })) };

function modelValues() {
  return (process.env.ACP_FAKE_MODEL_OPTIONS ?? "dfmodel,efficient,performance").split(",").filter(Boolean);
}

function reasoningEffortValues() {
  if (process.env.ACP_FAKE_CONFIG_BEHAVIOR === "no-effort") return null;
  return (process.env.ACP_FAKE_EFFORT_OPTIONS ?? "high,max,low,none").split(",").filter(Boolean);
}

function configOptions(currentModel = modelValues()[0], currentEffort = null) {
  const options = [{ type: "select", id: "model", name: "Model", category: "model", currentValue: currentModel,
    options: modelValues().map((value) => ({ value, name: value })) }];
  const effortValues = reasoningEffortValues();
  if (effortValues) options.push({ type: "select", id: "reasoning_effort", name: "Reasoning effort",
    currentValue: currentEffort ?? effortValues[0], options: effortValues.map((value) => ({ value, name: value })) });
  return options;
}

class FakeAgent {
  constructor(connection) {
    this.connection = connection;
    this.sessions = new Map();
    if (process.env.ACP_FAKE_CONFIG_BEHAVIOR === "unsupported") this.setSessionConfigOption = undefined;
  }

  initialize(params) {
    record({ method: "initialize", params });
    if (process.env.ACP_FAKE_INITIALIZE_ERROR) throw new Error("fake initialize failure");
    return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: { loadSession: true,
      sessionCapabilities: { resume: true }, promptCapabilities: { image: true, embeddedContext: true } }, authMethods: [] };
  }

  newSession(params) {
    record({ method: "session/new", params });
    const sessionId = `fake-${crypto.randomUUID()}`;
    this.sessions.set(sessionId, { cwd: params.cwd, mode: "default", model: modelValues()[0],
      effort: reasoningEffortValues()?.[0] ?? null, cancelled: null, cancelCount: 0 });
    return { sessionId, modes, configOptions: configOptions() };
  }

  loadSession() { throw new Error("session/load must not be used"); }
  authenticate() { return {}; }

  resumeSession(params) {
    record({ method: "session/resume", params });
    const session = this.sessions.get(params.sessionId) ?? { cwd: params.cwd, mode: "default", model: modelValues()[0],
      effort: reasoningEffortValues()?.[0] ?? null, cancelled: null };
    this.sessions.set(params.sessionId, session);
    return { modes, configOptions: configOptions(session.model, session.effort) };
  }

  setSessionMode(params) {
    record({ method: "session/set_mode", params });
    this.sessions.get(params.sessionId).mode = params.modeId;
    return {};
  }

  setSessionConfigOption(params) {
    record({ method: "session/set_config_option", params });
    const session = this.sessions.get(params.sessionId);
    if (params.configId === "model") {
      if (!modelValues().includes(params.value)) throw new Error(`invalid model: ${params.value}`);
      session.model = params.value;
      const selected = process.env.ACP_FAKE_CONFIG_BEHAVIOR === "mismatch" ? "dfmodel" : session.model;
      return { configOptions: configOptions(selected, session.effort) };
    }
    if (params.configId === "reasoning_effort") {
      if (process.env.ACP_FAKE_CONFIG_BEHAVIOR === "effort-error") throw new Error("reasoning effort rejected");
      if (!reasoningEffortValues()?.includes(params.value)) throw new Error(`invalid reasoning effort: ${params.value}`);
      session.effort = params.value;
      return { configOptions: configOptions(session.model, session.effort) };
    }
    throw new Error(`invalid config option: ${params.configId}`);
  }

  update(sessionId, update) {
    return this.connection.sessionUpdate({ sessionId, update });
  }

  async basic(sessionId) {
    const updates = [
      { sessionUpdate: "user_message_chunk", content: { type: "text", text: "basic" } },
      { sessionUpdate: "agent_message_chunk", messageId: "assistant-1", content: { type: "text", text: "Basic " } },
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } },
      { sessionUpdate: "plan", entries: [{ content: "Read fixture", priority: "high", status: "in_progress" }] },
      { sessionUpdate: "tool_call", toolCallId: "generic-1", title: "Inspect fixture", kind: "read", status: "pending", rawInput: { path: "README.md" } },
      { sessionUpdate: "tool_call_update", toolCallId: "generic-1", status: "completed", content: [{ type: "content", content: { type: "text", text: "read ok" } }] },
      { sessionUpdate: "tool_call", toolCallId: "command-1", title: "Print fixture", kind: "execute", status: "in_progress", rawInput: { command: "printf fixture", cwd: process.cwd() } },
      { sessionUpdate: "tool_call_update", toolCallId: "command-1", status: "completed", rawOutput: { exitCode: 0 }, content: [{ type: "content", content: { type: "text", text: "fixture" } }] },
      { sessionUpdate: "tool_call", toolCallId: "edit-1", title: "Preview edit", kind: "edit", status: "in_progress", locations: [{ path: `${process.cwd()}/fixture.txt` }] },
      { sessionUpdate: "tool_call_update", toolCallId: "edit-1", status: "completed", content: [{ type: "diff", path: `${process.cwd()}/fixture.txt`, oldText: "old", newText: "new" }] },
      { sessionUpdate: "usage_update", used: 12, size: 100 },
      { sessionUpdate: "available_commands_update", availableCommands: [] },
      { sessionUpdate: "current_mode_update", currentModeId: "default" },
      { sessionUpdate: "config_option_update", configOptions: [] },
      { sessionUpdate: "session_info_update", title: "Fake", updatedAt: new Date().toISOString() },
      { sessionUpdate: "compaction_update", compactionId: "compact-1", status: "pending" },
      { sessionUpdate: "compaction_summary_chunk", compactionId: "compact-1", content: { type: "text", text: "summary" } },
      { sessionUpdate: "plan_update", plan: { type: "markdown", planId: "plan-1", content: "Done" } },
      { sessionUpdate: "plan_removed", planId: "plan-1" },
      { sessionUpdate: "agent_message_chunk", messageId: "assistant-1", content: { type: "text", text: "complete" } }
    ];
    for (const update of updates) await this.update(sessionId, update);
  }

  async prompt(params) {
    const text = params.prompt.filter((block) => block.type === "text").map((block) => block.text).join("\n");
    record({ method: "session/prompt", params });
    if (text === "transport-failure") process.exit(23);
    if (text === "permission") {
      const response = await this.connection.requestPermission({ sessionId: params.sessionId,
        toolCall: { toolCallId: "permission-tool", title: "Dangerous operation", kind: "execute", status: "pending" },
        options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }, { optionId: "reject", name: "Reject", kind: "reject_once" }] });
      await this.update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(response.outcome) } });
      return { stopReason: response.outcome.outcome === "cancelled" ? "cancelled" : "end_turn" };
    }
    if (text === "question") {
      const response = await this.connection.createElicitation({ mode: "form", sessionId: params.sessionId, message: "Choose values",
        requestedSchema: { type: "object", required: ["name", "choice"], properties: {
          name: { type: "string", title: "Name" }, choice: { type: "string", enum: ["a", "b"], title: "Choice" },
          tags: { type: "array", items: { type: "string", enum: ["x", "y"] }, title: "Tags" }, enabled: { type: "boolean", title: "Enabled" }
        } } });
      await this.update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(response) } });
      return { stopReason: response.action === "cancel" ? "cancelled" : "end_turn" };
    }
    if (text === "terminal-tool-calls") {
      await this.update(params.sessionId, { sessionUpdate: "tool_call", toolCallId: "terminal-generic", title: "Finished read",
        kind: "read", status: "completed", content: [{ type: "content", content: { type: "text", text: "done" } }] });
      await this.update(params.sessionId, { sessionUpdate: "tool_call", toolCallId: "terminal-command", title: "Failed command",
        kind: "execute", status: "failed", rawInput: { command: "false" }, rawOutput: { exitCode: 1 } });
      await this.update(params.sessionId, { sessionUpdate: "tool_call", toolCallId: "terminal-edit", title: "Finished edit",
        kind: "edit", status: "completed", content: [{ type: "diff", path: "fixture.txt", oldText: "old", newText: "new" }] });
      return { stopReason: "end_turn" };
    }
    if (text === "cancel-natural") {
      return new Promise((resolve) => {
        this.sessions.get(params.sessionId).cancelled = () => resolve({ stopReason: "end_turn" });
      });
    }
    if (text === "cancel-late") {
      return new Promise((resolve) => {
        const session = this.sessions.get(params.sessionId);
        session.cancelled = async () => {
          const cancelCount = ++session.cancelCount;
          await this.update(params.sessionId, { sessionUpdate: "tool_call_update", toolCallId: `late-tool-${cancelCount}`,
            title: `Late tool ${cancelCount}`, kind: "other", status: "completed" });
          await this.update(params.sessionId, { sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `late update ${cancelCount}` } });
          resolve({ stopReason: "cancelled" });
        };
      });
    }
    const stop = text.startsWith("stop:") ? text.slice(5) : "end_turn";
    await this.basic(params.sessionId);
    return { stopReason: stop, usage: { totalTokens: 9, inputTokens: 4, outputTokens: 5, thoughtTokens: 1, cachedReadTokens: 2 } };
  }

  async cancel(params) {
    record({ method: "session/cancel", params });
    await this.sessions.get(params.sessionId)?.cancelled?.();
  }
}

const stream = ndJsonStream(nodeWritable(process.stdout), nodeReadable(process.stdin));
new AgentSideConnection((connection) => new FakeAgent(connection), stream);
