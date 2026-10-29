import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { readFrame, writeFrame, varint } from "../plugins/codex/scripts/agy-acp/harness-proxy.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("a helper that listens 400 ms after OutputConfig preserves the official startup retry boundary", { timeout: 6000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agy-startup-"));
  const controlPath = path.join(directory, "control.sock");
  const sockets = new Set();
  const control = net.createServer((socket) => { sockets.add(socket); socket.on("data", () => {}); });
  await new Promise((resolve) => control.listen(controlPath, resolve));
  const fake = path.join(directory, "localharness_external");
  fs.writeFileSync(fake, `#!/usr/bin/env node
import net from 'node:net';
import {createRequire} from 'node:module';
const {WebSocketServer}=createRequire(${JSON.stringify(path.join(ROOT, "package.json"))})('ws');
const reserve=net.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));
const port=reserve.address().port;await new Promise(r=>reserve.close(r));
process.stdin.once('data',()=>{let n=port,b=[];do{let v=n%128;n=Math.floor(n/128);if(n)v|=128;b.push(v)}while(n);
const payload=Buffer.from([8,...b,18,3,107,101,121]),size=Buffer.alloc(4);size.writeUInt32LE(payload.length);process.stdout.write(Buffer.concat([size,payload]));
setTimeout(()=>{const server=new WebSocketServer({host:'127.0.0.1',port});server.on('connection',(s,req)=>{if(req.headers['x-goog-api-key']!=='key')return s.close();s.on('message',d=>s.send(d.toString()))});process.stdin.on('end',()=>{for(const s of server.clients)s.terminate();server.close(()=>process.exit(0))})},400)});
`, { mode: 0o755 });
  const child = spawn(process.execPath, [path.join(ROOT, "plugins/codex/scripts/agy-acp/harness-proxy.mjs")], {
    env: { ...process.env, AGY_OFFICIAL_RUNTIME_DIR: directory, AGY_STEERING_CONTROL: controlPath, AGY_STEERING_EVIDENCE: "" },
    stdio: ["pipe", "pipe", "pipe"]
  });
  const closed = new Promise((resolve) => child.once("close", resolve));
  let socket;
  try {
    const output = readFrame(child.stdout);
    writeFrame(child.stdin, Buffer.alloc(0));
    const config = await output;
    const port = varint(config, 1).value;
    const started = Date.now();
    let attempts = 0;
    // Same 5 iterations and exponential waits as LocalConnectionStrategy;
    // localhost and 127.0.0.1 are both tried before each wait.
    for (let attempt = 0; attempt < 5 && !socket; attempt++) {
      for (const host of ["localhost", "127.0.0.1"]) {
        attempts++;
        try {
          socket = await new Promise((resolve, reject) => {
            const connection = new WebSocket(`ws://${host}:${port}/`, { headers: { "x-goog-api-key": "key" } });
            connection.once("open", () => resolve(connection)); connection.once("error", reject);
          });
          break;
        } catch {}
      }
      if (!socket) await sleep(100 * 2 ** attempt);
    }
    assert.ok(socket, "official retry window should reach the delayed helper");
    assert.ok(attempts > 1, "the helper was initially unavailable");
    assert.ok(Date.now() - started >= 350, "proxy must not complete an early handshake");
    const echoed = new Promise((resolve) => socket.once("message", (data) => resolve(data.toString())));
    socket.send('{"config":{"cascadeId":"startup-session"}}');
    assert.equal(await echoed, '{"config":{"cascadeId":"startup-session"}}');
  } finally {
    socket?.close(); child.stdin.end();
    await Promise.race([closed, sleep(1500)]);
    if (child.exitCode === null) child.kill("SIGKILL");
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => control.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
