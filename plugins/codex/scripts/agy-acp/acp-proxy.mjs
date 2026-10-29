#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
export function initializeResponse(message) {
  if (message.result?.agentInfo?.name !== "antigravity-acp" || message.result.agentInfo.version !== "1.4.4") return message;
  return { ...message, result: { ...message.result,
    _meta: { ...message.result._meta, steering: { supported: true } } } };
}

export function steeringSession(prompts, bridges, sessionId) {
  const entry = bridges.get(sessionId);
  // A helper can briefly report RUNNING after the ACP root response. That
  // response still ends the task; a later message must start a new prompt.
  return [...prompts.values()].includes(sessionId) && entry?.state === "running" && !entry.socket.destroyed ? entry : null;
}

export async function runAcpProxy() {
  const runtimeDir = process.env.AGY_OFFICIAL_RUNTIME_DIR ?? path.join(os.homedir(), ".local/share/antigravity-acp/1.4.4");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agy-steering-"));
  const endpoint = path.join(directory, "control.sock");
  const bridges = new Map();
  const pending = new Map();
  const prompts = new Map();
  let supported = false;
  let nextControlId = 0;
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      for (;;) {
        const end = buffer.indexOf("\n"); if (end < 0) break;
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        const message = JSON.parse(line);
        if (message.kind === "state") bridges.set(message.sessionId, { socket, state: message.state });
        else if (pending.has(message.id)) { pending.get(message.id)(message.result); pending.delete(message.id); }
      }
    });
    socket.on("close", () => { for (const [id, entry] of bridges) if (entry.socket === socket) bridges.delete(id); });
  });
  await new Promise((resolve) => server.listen(endpoint, resolve));
  const env = { ...process.env, AGY_ACP_DEFAULT_MODEL: "gemini-4-argon-high",
    AGY_OFFICIAL_RUNTIME_DIR: runtimeDir, ANTIGRAVITY_HARNESS_PATH: path.join(ROOT, "harness-proxy.mjs"),
    AGY_STEERING_CONTROL: endpoint };
  // Match the installed official launcher's process-local proxy handling.
  for (const key of Object.keys(env)) if (/^(http|https|all)_proxy$/i.test(key)) delete env[key];
  const child = spawn(path.join(runtimeDir, "agy_acp_server.par"), process.argv.slice(2), { env, stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.pipe(process.stderr);
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
    for (;;) {
      const end = output.indexOf("\n"); if (end < 0) break;
      const line = output.slice(0, end); output = output.slice(end + 1);
      let message;
      try { message = JSON.parse(line); }
      catch { process.stdout.write(line + "\n"); continue; }
      if (message.id !== undefined && !message.method) prompts.delete(message.id);
      const advertised = initializeResponse(message);
      if (advertised !== message) supported = true;
      process.stdout.write(JSON.stringify(advertised) + "\n");
    }
  });
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    input += chunk;
    for (;;) {
      const end = input.indexOf("\n"); if (end < 0) break;
      const line = input.slice(0, end); input = input.slice(end + 1);
      const message = JSON.parse(line);
      if (message.method !== "_session/steering") {
        if (message.method === "session/prompt") prompts.set(message.id, message.params?.sessionId);
        child.stdin.write(line + "\n"); continue;
      }
      const params = message.params ?? {};
      const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n");
      const error = (code, detail) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id,
        error: { code, message: detail } }) + "\n");
      if (!supported) { error(-32601, "Steering requires the verified official agy ACP 1.4.4 runtime"); continue; }
      const text = Array.isArray(params.prompt) && params.prompt.length &&
        params.prompt.every((item) => item.type === "text" && typeof item.text === "string" && item.text.trim())
        ? params.prompt.map((item) => item.text).join("\n") : null;
      if (!text) { error(-32602, "Only nonempty text steering prompts are supported"); continue; }
      const entry = steeringSession(prompts, bridges, params.sessionId);
      if (!entry) { reply({ outcome: "promptRequired", reason: "noRunningTurn" }); continue; }
      const id = ++nextControlId;
      const timer = setTimeout(() => { pending.delete(id); error(-32603, "Harness steering response timed out"); }, 3000);
      pending.set(id, (result) => {
        clearTimeout(timer);
        if (result.outcome === "error") error(-32603, result.message); else reply(result);
      });
      entry.socket.write(JSON.stringify({ id, sessionId: params.sessionId, text }) + "\n");
    }
  });
  process.stdin.on("end", () => child.stdin.end());
  process.on("SIGTERM", () => child.kill("SIGTERM"));
  child.once("error", (error) => { process.stderr.write(error.message + "\n"); process.exit(1); });
  child.once("exit", (code) => {
    for (const entry of bridges.values()) entry.socket.destroy();
    server.close(); fs.rmSync(directory, { recursive: true, force: true }); process.exit(code ?? 0);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runAcpProxy();
