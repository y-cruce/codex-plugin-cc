import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { channelFlagged, channelMessage, paths } from "../plugins/codex/scripts/director-channel.mjs";

const SERVER = path.resolve("plugins/codex/scripts/director-channel.mjs");

test("the channel is on only when Claude Code was started with this plugin among its channels", () => {
  assert.equal(channelFlagged("claude --channels plugin:codex@y-cruce-codex"), true);
  assert.equal(channelFlagged("claude --dangerously-load-development-channels plugin:codex@y-cruce-codex --model x"), true);
  assert.equal(channelFlagged("claude --channels plugin:telegram@official plugin:codex@m"), true);
  assert.equal(channelFlagged("claude --channels=plugin:codex@m"), true);
  assert.equal(channelFlagged("claude --channels plugin:telegram@official --resume plugin:codex@m"), false);
  assert.equal(channelFlagged("claude --channels plugin:codexx@m"), false);
  assert.equal(channelFlagged("claude plugin:codex@m"), false);
  assert.equal(channelFlagged(""), false);
});

test("a pane line becomes one channel message, its job and event as tag attributes", () => {
  assert.deepEqual(channelMessage({ jobId: "task-a-b", cwd: "/r", type: "job.completed", text: "fix x · job.completed: done" }),
    { content: "fix x · job.completed: done", meta: { event: "job_completed", job: "task-a-b" } });
  assert.deepEqual(channelMessage({ text: "note" }), { content: "note", meta: {} });
  assert.equal(channelMessage({ jobId: "j", text: "  " }), null);
});

test("the server forwards each spooled batch in order and leaves its files only while the channel is on", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "channel-test-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  // A parent whose command line names the plugin, as Claude Code's would.
  // bash keeps running as the server's parent (the trailing `:` stops it from
  // exec'ing node), and its command line ends with the words given as $0.
  const parent = spawn("bash", ["-c", `node "${SERVER}"; :`, "claude --channels plugin:codex@m"], {
    env: { ...process.env, TMPDIR: tmp }, stdio: ["pipe", "pipe", "inherit"],
  });
  t.after(() => parent.kill("SIGKILL"));
  const messages = [];
  readline.createInterface({ input: parent.stdout }).on("line", (line) => messages.push(JSON.parse(line)));
  parent.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } })}\n`);
  const until = async (check) => { for (let i = 0; i < 100 && !check(); i += 1) await new Promise((r) => setTimeout(r, 50)); assert.ok(check()); };
  await until(() => messages.length >= 1);
  assert.deepEqual(messages[0].result.capabilities, { experimental: { "claude/channel": {} } });
  const files = paths(parent.pid, path.join(tmp, "codex-channel"));
  await until(() => fs.existsSync(files.ready));
  fs.writeFileSync(path.join(files.spool, "2.json"), JSON.stringify({ lines: [{ jobId: "b", type: "job.failed", text: "second" }] }));
  fs.writeFileSync(path.join(files.spool, "1.json"), JSON.stringify({ lines: [{ jobId: "a", type: "job.completed", text: "first" }] }));
  await until(() => messages.length >= 3);
  assert.deepEqual(messages.slice(1).map((m) => [m.method, m.params.content]),
    [["notifications/claude/channel", "first"], ["notifications/claude/channel", "second"]]);
  assert.deepEqual(fs.readdirSync(files.spool), []);
  parent.stdin.end();
  await until(() => !fs.existsSync(files.ready));
});

test("without the plugin among Claude Code's channels the server answers but leaves no ready file", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "channel-test-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const parent = spawn("bash", ["-c", `node "${SERVER}"; :`, "claude --model x"], {
    env: { ...process.env, TMPDIR: tmp }, stdio: ["pipe", "pipe", "inherit"],
  });
  t.after(() => parent.kill("SIGKILL"));
  const messages = [];
  readline.createInterface({ input: parent.stdout }).on("line", (line) => messages.push(JSON.parse(line)));
  parent.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
  for (let i = 0; i < 100 && !messages.length; i += 1) await new Promise((r) => setTimeout(r, 50));
  assert.equal(messages[0].id, 1);
  assert.equal(fs.existsSync(paths(parent.pid, path.join(tmp, "codex-channel")).ready), false);
});
