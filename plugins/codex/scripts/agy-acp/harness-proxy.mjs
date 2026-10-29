#!/usr/bin/env node
import { spawn } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
const log = (value) => {
  if (process.env.AGY_STEERING_EVIDENCE) fs.appendFileSync(process.env.AGY_STEERING_EVIDENCE,
    JSON.stringify({ at: Date.now(), ...value }) + "\n");
};
export function varint(buffer, offset = 0) {
  let value = 0;
  let shift = 0;
  let byte;
  do { byte = buffer[offset++]; value += (byte & 127) * 2 ** shift; shift += 7; } while (byte & 128);
  return { value, offset };
}
export function encodeVarint(value) {
  const bytes = [];
  do { let byte = value % 128; value = Math.floor(value / 128); if (value) byte |= 128; bytes.push(byte); } while (value);
  return Buffer.from(bytes);
}
export function replacePort(buffer, port) {
  let offset = 0;
  const pieces = [];
  let previousPort;
  while (offset < buffer.length) {
    const start = offset;
    const tag = varint(buffer, offset);
    offset = tag.offset;
    if ((tag.value & 7) === 0) {
      const item = varint(buffer, offset);
      offset = item.offset;
      if ((tag.value >> 3) === 1) { previousPort = item.value; pieces.push(Buffer.from([8]), encodeVarint(port)); continue; }
    } else if ((tag.value & 7) === 2) {
      const size = varint(buffer, offset); offset = size.offset + size.value;
    } else throw new Error("Unexpected OutputConfig wire type");
    pieces.push(buffer.subarray(start, offset));
  }
  if (!previousPort) throw new Error("Official harness did not publish a port");
  return { previousPort, payload: Buffer.concat(pieces) };
}
export const readFrame = (stream) => new Promise((resolve, reject) => {
  let buffer = Buffer.alloc(0);
  const onData = (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
      stream.off("data", onData); resolve(buffer.subarray(4, 4 + buffer.readUInt32LE(0)));
    }
  };
  stream.on("data", onData);
  stream.once("error", reject);
  stream.once("end", () => reject(new Error("Incomplete official harness config frame")));
});
export const writeFrame = (stream, payload) => {
  const length = Buffer.alloc(4); length.writeUInt32LE(payload.length);
  stream.write(Buffer.concat([length, payload]));
};
export async function runHarnessProxy() {
  const child = spawn(path.join(process.env.AGY_OFFICIAL_RUNTIME_DIR, "localharness_external"), process.argv.slice(2),
    { stdio: ["pipe", "pipe", "pipe"], env: process.env });
  log({ kind: "helper.process", proxyPid: process.pid, officialPid: child.pid });
  child.stderr.pipe(process.stderr);
  const control = net.createConnection(process.env.AGY_STEERING_CONTROL);
  const wsServer = new WebSocketServer({ host: "127.0.0.1", port: 0,
    verifyClient(info, done) {
      const upstream = new WebSocket(`ws://127.0.0.1:${replacement.previousPort}/`,
        { headers: { "x-goog-api-key": info.req.headers["x-goog-api-key"] }, maxPayload: 0 });
      info.req.agyUpstream = upstream;
      const failed = () => done(false, 503);
      upstream.once("error", failed);
      upstream.once("open", () => { upstream.off("error", failed); done(true); });
      info.req.socket.once("close", () => { if (upstream.readyState === WebSocket.CONNECTING) upstream.terminate(); });
    } });
  await new Promise((resolve) => wsServer.once("listening", resolve));
  writeFrame(child.stdin, await readFrame(process.stdin));
  const output = await readFrame(child.stdout);
  const replacement = replacePort(output, wsServer.address().port);
  writeFrame(process.stdout, replacement.payload);
  let sessionId;
  let runtimeState = "idle";
  let upstream;
  let peer;
  let controlBuffer = "";
  const publish = () => { if (sessionId) control.write(JSON.stringify({ kind: "state", sessionId, state: runtimeState }) + "\n"); };
  control.setEncoding("utf8");
  control.on("error", () => child.kill("SIGTERM"));
  control.on("data", (chunk) => {
    controlBuffer += chunk;
    for (;;) {
      const end = controlBuffer.indexOf("\n"); if (end < 0) break;
      const line = controlBuffer.slice(0, end); controlBuffer = controlBuffer.slice(end + 1);
      const request = JSON.parse(line);
      const reply = (result) => control.write(JSON.stringify({ id: request.id, result }) + "\n");
      if (request.sessionId !== sessionId || runtimeState !== "running" || upstream?.readyState !== WebSocket.OPEN) {
        reply({ outcome: "promptRequired", reason: "noRunningTurn" }); continue;
      }
      upstream.send(JSON.stringify({ automatedTrigger: request.text }), (error) => {
        if (error) { reply({ outcome: "error", message: error.message }); return; }
        log({ kind: "trigger.sent", sessionId, runtimeState, text: request.text });
        reply({ outcome: "injected", accepted: true });
      });
    }
  });
  wsServer.on("connection", (socket, request) => {
    peer = socket;
    // Publish the proxy handshake only after the real helper is ready. A
    // startup refusal therefore stays inside the official SDK's retry loop.
    upstream = request.agyUpstream;
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (message.config?.cascadeId) {
        sessionId = message.config.cascadeId;
        log({ kind: "session.bound", sessionId }); publish();
      }
      if (message.haltRequest) log({ kind: "halt.sent", sessionId });
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data.toString());
    });
    upstream.on("message", (data) => {
      const message = JSON.parse(data.toString());
      const state = message.trajectoryStateUpdate;
      if (state && (!state.trajectoryId || state.trajectoryId === sessionId)) {
        runtimeState = state.state === "STATE_RUNNING" ? "running" : "idle";
        log({ kind: "runtime.state", sessionId, state: state.state }); publish();
      }
      socket.send(data.toString());
    });
    upstream.on("error", (error) => { log({ kind: "upstream.error", message: error.message }); socket.close(); });
    upstream.on("close", () => socket.close());
    socket.on("close", () => upstream.close());
  });
  let closing = false;
  function close() {
    if (closing) return; closing = true;
    control.destroy(); peer?.close(); upstream?.close(); wsServer.close(); child.stdin.end();
    setTimeout(() => { if (child.exitCode === null) child.kill("SIGTERM"); }, 400).unref();
    setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 1000).unref();
  }
  process.stdin.on("end", close);
  process.on("SIGTERM", close);
  child.once("exit", (code, signal) => { log({ kind: "helper.exit", code, signal }); process.exit(code ?? 0); });

}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runHarnessProxy();
