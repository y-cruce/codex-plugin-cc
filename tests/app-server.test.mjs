import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { CodexAppServerClient } from "../plugins/codex/scripts/lib/app-server.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { isolateTestEnvironment, makeTempDir, waitFor, within } from "./helpers.mjs";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function encodeServerFrame(opcode, payload, fin = true) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
  let header;
  if (data.length < 126) {
    header = Buffer.from([(fin ? 0x80 : 0) | opcode, data.length]);
  } else {
    header = Buffer.alloc(4);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
  }
  return Buffer.concat([header, data]);
}

function decodeMaskedFrames(buffer) {
  const frames = [];
  let rest = buffer;
  while (rest.length >= 2) {
    const opcode = rest[0] & 0x0f;
    const masked = (rest[1] & 0x80) !== 0;
    let len = rest[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (rest.length < 4) break;
      len = rest.readUInt16BE(2);
      offset = 4;
    }
    const mask = masked ? rest.subarray(offset, offset + 4) : null;
    if (masked) offset += 4;
    if (rest.length < offset + len) break;
    const payload = Buffer.from(rest.subarray(offset, offset + len));
    if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i & 3];
    frames.push({ opcode, payload });
    rest = rest.subarray(offset + len);
  }
  return { frames, rest };
}

test("app-server preserves Unicode separators in JSONL responses and notifications", async (t) => {
  isolateTestEnvironment(t);
  const bin = makeTempDir();
  installFakeCodex(bin, "unicode-separators");
  const client = await CodexAppServerClient.connect(bin, { disableBroker: true, env: buildEnv(bin) });
  t.after(() => client.close());
  const notifications = [];
  client.setNotificationHandler((message) => notifications.push(message));

  const { thread } = await within(client.request("thread/start", { cwd: bin }), 1000, "Unicode response");
  const expected = "before\u2028between\u2029after";
  assert.equal(thread.name, expected);
  await waitFor(() => notifications.length, "Unicode notification", 1000);
  assert.equal(notifications[0].params.thread.name, expected);
  const result = await within(client.request("thread/list", {}), 1000, "request after Unicode message");
  assert.equal(result.data[0].name, expected);
});

test("failed app-server connections reject pending and later requests", async (t) => {
  isolateTestEnvironment(t);
  const bin = makeTempDir();
  installFakeCodex(bin);
  for (const failure of ["protocol", "exit"]) {
    const client = await CodexAppServerClient.connect(bin, { disableBroker: true, env: buildEnv(bin) });
    t.after(() => client.close());
    const sent = [];
    t.mock.method(client, "sendMessage", (message) => sent.push(message));
    const pending = Promise.allSettled([
      client.request("thread/list", {}), client.request("account/read", {})
    ]);
    if (failure === "protocol") client.handleChunk("{invalid JSON}\n");
    else client.proc.stdin.end();
    const expected = failure === "protocol" ? /Failed to parse codex app-server JSONL/ : /connection closed/;
    for (const result of await within(pending, 1000, `${failure} pending requests`)) {
      assert.equal(result.status, "rejected");
      assert.match(result.reason.message, expected);
    }
    await assert.rejects(within(Promise.resolve().then(() => client.request("thread/list", {})),
      1000, `${failure} later request`), expected);
    assert.equal(client.pending.size, 0);
    assert.equal(sent.length, 2);
    await client.close();
  }
});

test("daemon WebSocket-over-UDS client handles RPC, fragmented text, ping/pong, fallback, and test isolation", async (t) => {
  isolateTestEnvironment(t);
  const sockDir = makeTempDir("cxd-");
  const socketPath = path.join(sockDir, "app-server-control.sock");
  let pongs = 0;
  const server = http.createServer();
  server.on("upgrade", (req, socket) => {
    const accept = crypto.createHash("sha1").update(`${req.headers["sec-websocket-key"]}${WS_GUID}`).digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    let rx = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      const parsed = decodeMaskedFrames(Buffer.concat([rx, chunk]));
      rx = parsed.rest;
      for (const frame of parsed.frames) {
        if (frame.opcode === 0x8) {
          socket.end(encodeServerFrame(0x8, Buffer.alloc(0)));
          return;
        }
        if (frame.opcode === 0xa) {
          pongs += 1;
          continue;
        }
        if (frame.opcode !== 0x1) continue;
        const message = JSON.parse(frame.payload.toString("utf8"));
        if (message.method === "initialize") {
          socket.write(encodeServerFrame(0x1, JSON.stringify({ id: message.id, result: { userAgent: "mock-daemon" } })));
        } else if (message.method === "thread/list") {
          socket.write(encodeServerFrame(0x9, "hb"));
          const body = JSON.stringify({ id: message.id, result: { data: [{ id: "thr_daemon", name: "x".repeat(200) }], nextCursor: null } });
          socket.write(encodeServerFrame(0x1, body.slice(0, 40), false));
          socket.write(encodeServerFrame(0x0, body.slice(40), true));
        }
      }
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const daemonClient = await CodexAppServerClient.connect(sockDir, { disableBroker: true, daemonSocketPath: socketPath });
  t.after(() => daemonClient.close());
  assert.equal(daemonClient.transport, "daemon");
  const listed = await within(daemonClient.request("thread/list", {}), 1000, "daemon thread/list");
  assert.equal(listed.data[0].id, "thr_daemon");
  assert.equal(listed.data[0].name.length, 200);
  await waitFor(() => pongs >= 1, "daemon pong", 1000);
  await daemonClient.close();

  // Unreachable daemon socket falls back cleanly to spawning codex on PATH,
  // and fake codex on PATH never connects to the user's real daemon socket.
  const bin = makeTempDir();
  installFakeCodex(bin);
  const env = buildEnv(bin);
  const fallback = await CodexAppServerClient.connect(bin, {
    disableBroker: true,
    daemonSocketPath: path.join(sockDir, "missing.sock"),
    env
  });
  t.after(() => fallback.close());
  assert.equal(fallback.transport, "direct");
  await fallback.close();

  const isolated = await CodexAppServerClient.connect(bin, { disableBroker: true, env });
  t.after(() => isolated.close());
  assert.equal(isolated.transport, "direct");
  await isolated.close();
});
