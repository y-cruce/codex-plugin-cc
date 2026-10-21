import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { PROBE, channelMessage, paths } from "../plugins/codex/scripts/director-channel.mjs";

const SERVER = path.resolve("plugins/codex/scripts/director-channel.mjs");

test("a pane line becomes one channel message, its job and event as tag attributes", () => {
  assert.deepEqual(channelMessage({ jobId: "task-a-b", cwd: "/r", type: "job.completed", text: "fix x · job.completed: done" }),
    { content: "fix x · job.completed: done", meta: { event: "job_completed", job: "task-a-b" } });
  assert.deepEqual(channelMessage({ text: "note" }), { content: "note", meta: {} });
  assert.equal(channelMessage({ jobId: "j", text: "  " }), null);
});

async function startServer(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "channel-test-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  // bash stays the server's parent, standing in for Claude Code (the trailing
  // `:` stops it from exec'ing node).
  const parent = spawn("bash", ["-c", `node "${SERVER}"; :`], { env: { ...process.env, TMPDIR: tmp }, stdio: ["pipe", "pipe", "inherit"] });
  t.after(() => parent.kill("SIGKILL"));
  const messages = [];
  readline.createInterface({ input: parent.stdout }).on("line", (line) => messages.push(JSON.parse(line)));
  const write = (message) => parent.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const files = paths(parent.pid, path.join(tmp, "codex-channel"));
  return { parent, messages, write, files };
}

async function until(check, ms = 8000) {
  for (let waited = 0; waited < ms && !check(); waited += 50) await new Promise((r) => setTimeout(r, 50));
  assert.ok(check());
}

test("the server probes the route until the pane confirms it, then stops", async (t) => {
  const { messages, write, files } = await startServer(t);
  write({ id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } });
  await until(() => messages.length >= 1);
  assert.deepEqual(messages[0].result.capabilities, { experimental: { "claude/channel": {} } });
  write({ method: "notifications/initialized" });
  const probes = () => messages.filter((m) => m.method === "notifications/claude/channel" && m.params.content.includes(PROBE));
  await until(() => probes().length >= 2);
  assert.deepEqual(probes()[0].params.meta, { event: "probe" });
  fs.writeFileSync(files.confirmed, "{}");
  await new Promise((r) => setTimeout(r, 2500));
  const settled = probes().length;
  await new Promise((r) => setTimeout(r, 2500));
  assert.equal(probes().length, settled, "no probe after the confirmation");
});

test("the server forwards each spooled batch in order and removes its files when Claude Code goes", async (t) => {
  const { parent, messages, write, files } = await startServer(t);
  write({ id: 1, method: "initialize", params: {} });
  await until(() => fs.existsSync(files.spool));
  fs.writeFileSync(path.join(files.spool, "2.json"), JSON.stringify({ lines: [{ jobId: "b", type: "job.failed", text: "second" }] }));
  fs.writeFileSync(path.join(files.spool, "1.json"), JSON.stringify({ lines: [{ jobId: "a", type: "job.completed", text: "first" }] }));
  const sent = () => messages.filter((m) => m.method === "notifications/claude/channel").map((m) => m.params.content);
  await until(() => sent().length >= 2);
  assert.deepEqual(sent(), ["first", "second"]);
  assert.deepEqual(fs.readdirSync(files.spool), []);
  fs.writeFileSync(files.confirmed, "{}");
  parent.stdin.end();
  await until(() => !fs.existsSync(files.spool) && !fs.existsSync(files.confirmed));
});

test("a confirmation left over from an earlier server for the same pid is cleared at start", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "channel-test-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const dir = path.join(tmp, "codex-channel");
  fs.mkdirSync(dir, { recursive: true });
  // The server's parent is this bash; write its stale file before node starts.
  const parent = spawn("bash", ["-c", `echo '{}' > "${dir}/$$.confirmed.json"; node "${SERVER}"; :`], {
    env: { ...process.env, TMPDIR: tmp }, stdio: ["pipe", "pipe", "inherit"],
  });
  t.after(() => parent.kill("SIGKILL"));
  const files = paths(parent.pid, dir);
  await until(() => fs.existsSync(files.spool));
  assert.equal(fs.existsSync(files.confirmed), false);
});

test("the pane drops the server's probe and records that the channel reaches the session", async () => {
  const { registerTaskPane } = await import("../plugins/codex/hooks/task-pane/register.ts");
  const hooks = new Map();
  registerTaskPane((event, options, callback) => hooks.set(event, callback ?? options));
  const writes = new Map();
  const engine = {
    env: { get: async (name) => ({ TMPDIR: "/tmp/x/" })[name] },
    process: { run: async (argv) => ({ exitCode: 0, stdout: argv[0] === "sh" ? "4242\n" : "", stderr: "" }) },
    fs: { write: async (file, text) => { writes.set(file, text); } },
    clock: { now: async () => 1 },
  };
  const submit = hooks.get("prompt.submit");
  const probe = await submit(engine, { origin: { kind: "channel", server: "plugin:codex:director" },
    text: `<channel source="plugin:codex:director" event="probe">${PROBE} 1-2: check</channel>` }, async () => assert.fail("the probe reached the model"));
  assert.ok(probe.drop);
  assert.deepEqual([...writes.keys()], ["/tmp/x/codex-channel/4242.confirmed.json"]);
  // A job event from the channel, or a probe-looking line from another server, goes on to the model.
  let passed = 0;
  await submit(engine, { origin: { kind: "channel", server: "plugin:codex:director" }, text: "job x · job.completed: done" }, async () => { passed += 1; });
  await submit(engine, { origin: { kind: "channel", server: "plugin:other:x" }, text: PROBE }, async () => { passed += 1; });
  assert.equal(passed, 2);
});
