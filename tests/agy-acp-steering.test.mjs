import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { initializeRequest, initializeResponse, steeringSession } from "../plugins/codex/scripts/agy-acp/acp-proxy.mjs";
import { encodeVarint, replacePort, readFrame, writeFrame } from "../plugins/codex/scripts/agy-acp/harness-proxy.mjs";

test("OutputConfig changes only its port and config framing handles split chunks", async () => {
  const opaqueFields = Buffer.from([18, 5, 0, 255, 17, 33, 48, 26, 2, 8, 9]);
  const original = Buffer.concat([Buffer.from([8]), encodeVarint(48123), opaqueFields]);
  const changed = replacePort(original, 53210);
  assert.equal(changed.previousPort, 48123);
  assert.deepEqual(changed.payload, Buffer.concat([Buffer.from([8]), encodeVarint(53210), opaqueFields]));
  const stream = new PassThrough();
  const reading = readFrame(stream);
  const encoded = new PassThrough();
  const chunks = [];
  encoded.on("data", (chunk) => chunks.push(chunk));
  writeFrame(encoded, original);
  const frame = Buffer.concat(chunks);
  stream.write(frame.subarray(0, 2));
  stream.end(frame.subarray(2));
  assert.deepEqual(await reading, original);
});

test("a helper RUNNING event after the root response cannot consume an idle message", () => {
  const prompts = new Map([[5, "own-session"]]);
  const bridges = new Map([["own-session", { state: "running", socket: { destroyed: false } }]]);
  assert.equal(steeringSession(prompts, bridges, "own-session"), bridges.get("own-session"));
  assert.equal(steeringSession(prompts, bridges, "other-session"), null);
  prompts.delete(5);
  assert.equal(steeringSession(prompts, bridges, "own-session"), null);
});

test("steering is advertised only for the verified official runtime and preserves metadata", () => {
  const result = { agentInfo: { name: "antigravity-acp", version: "1.4.4" }, _meta: { own: true } };
  assert.deepEqual(initializeResponse({ result }).result._meta, { own: true, steering: { supported: true } });
  const unknown = { result: { agentInfo: { name: "antigravity-acp", version: "1.4.5" } } };
  assert.equal(initializeResponse(unknown), unknown);
});

test("the agy adapter reports zed without changing initialize capabilities or other messages", () => {
  const request = { jsonrpc: "2.0", id: 1, method: "initialize", params: {
    protocolVersion: 1, clientCapabilities: { elicitation: { form: {} }, plan: {} },
    clientInfo: { name: "codex-companion", version: "1", title: "Director" }, _meta: { own: true }
  } };
  assert.deepEqual(initializeRequest(request), { ...request, params: { ...request.params,
    clientInfo: { ...request.params.clientInfo, name: "zed" } } });
  assert.equal(request.params.clientInfo.name, "codex-companion");
  const prompt = { method: "session/prompt", params: { sessionId: "session", prompt: [] } };
  assert.equal(initializeRequest(prompt), prompt);
});
