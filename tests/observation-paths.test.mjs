import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import os from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveStateDir, writeJobFile, upsertJob } from "../plugins/codex/scripts/lib/state.mjs";
import { JobEventStore } from "../plugins/codex/scripts/lib/job-event-store.mjs";
import { createBrokerEndpoint, parseBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-endpoint.mjs";
import { initGitRepo, isolateTestEnvironment, makeTempDir } from "./helpers.mjs";

const SCRIPT = fileURLToPath(new URL("../plugins/codex/scripts/codex-companion.mjs", import.meta.url));

async function setup(t, customConfig = false) {
  isolateTestEnvironment(t);
  const cwd = fs.realpathSync(makeTempDir());
  const home = makeTempDir();
  initGitRepo(cwd);
  const config = customConfig ? path.join(home, "custom-config") : path.join(home, ".claude");
  const env = { ...process.env, HOME: home };
  delete env.CLAUDE_PLUGIN_DATA;
  delete env.CLAUDE_CONFIG_DIR;
  if (customConfig) env.CLAUDE_CONFIG_DIR = config;
  const key = path.basename(resolveStateDir(cwd));
  const put = async (name, id, label, mtime, status = "completed") => {
    process.env.CLAUDE_PLUGIN_DATA = path.join(config, "plugins", "data", name);
    const job = { id, label, kind: "task", jobClass: "task", workspaceRoot: cwd, status,
      startedAt: new Date().toISOString(), completedAt: status === "completed" ? new Date().toISOString() : null,
      threadId: `thread-${name}`, rendered: `result-${label}\n` };
    writeJobFile(cwd, id, job);
    upsertJob(cwd, job);
    const store = await new JobEventStore(cwd, id).initialize({ job });
    store.append({ type: "message.completed", occurredAt: job.startedAt, receivedAt: job.startedAt,
      threadId: job.threadId, source: { message: { method: "item/completed", params: { item: { text: label } } } } });
    await store.close();
    const stateDir = resolveStateDir(cwd);
    fs.utimesSync(path.join(stateDir, "jobs", `${id}.json`), mtime, mtime);
    return { job, stateDir };
  };
  const cli = (args, extraEnv = {}) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, "observe", ...args, "--cwd", cwd], { env: { ...env, ...extraEnv } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
  return { cwd, env, config, key, put, cli };
}

test("observe falls back to HOME data root, pins history/result reads, and merges newest jobs", async (t) => {
  const h = await setup(t);
  const old = await h.put("codex-inline", "task-shared", "old", 100);
  const recent = await h.put("codex-market", "task-shared", "new", 200);
  await h.put("codex-inline", "task-only-inline", "inline", 100);
  const view = await h.cli(["view-path", "task-shared"]);
  assert.equal(view.code, 0, view.stderr);
  assert.equal(view.stdout.trim(), path.join(recent.stateDir, "job-history/task-shared/live-view.json"));
  const replay = await h.cli(["replay", "task-shared", "--jsonl"]);
  assert.equal(replay.code, 0, replay.stderr);
  assert.equal(JSON.parse(replay.stdout.split("\n")[0]).source.raw.params.item.text, "new");
  const follow = await h.cli(["follow", "task-shared"]);
  assert.equal(follow.code, 0, follow.stderr);
  assert.match(follow.stdout, /result-new/);
  assert.doesNotMatch(follow.stdout, /result-old/);
  const list = await h.cli(["list", "--json"]);
  assert.equal(list.code, 0, list.stderr);
  const jobs = JSON.parse(list.stdout).jobs;
  assert.deepEqual(jobs.map((job) => job.id).sort(), ["task-only-inline", "task-shared"]);
  assert.equal(jobs.find((job) => job.id === "task-shared").label, "new");
  const current = await h.cli(["view-path", "task-shared"], { CLAUDE_PLUGIN_DATA: path.dirname(path.dirname(old.stateDir)) });
  assert.equal(current.stdout.trim(), path.join(old.stateDir, "job-history/task-shared/live-view.json"));
  const missing = await h.cli(["view-path", "missing"]);
  assert.equal(missing.code, 1);
  assert.equal(missing.stderr.trim(), "UNKNOWN_JOB missing");
});

test("observe respects CLAUDE_CONFIG_DIR and uses the matched broker instead of inherited endpoint", async (t) => {
  const h = await setup(t, true);
  const { job, stateDir } = await h.put("codex-inline", "task-live", "live", 200, "running");
  const endpoint = createBrokerEndpoint(makeTempDir("cxo-path-"));
  fs.writeFileSync(path.join(stateDir, "broker.json"), JSON.stringify({ endpoint }));
  const sockets = new Set();
  const methods = [];
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    socket.on("data", (data) => {
      buffer += data;
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const message = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        methods.push(message.method);
        socket.write(`${JSON.stringify({ id: message.id, result: message.method === "initialize" ? { observationVersion: 1 } : {} })}\n`);
      }
    });
  });
  await new Promise((resolve) => server.listen(parseBrokerEndpoint(endpoint).path, resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise((resolve) => server.close(resolve)); });
  const output = await h.cli(["follow", job.id, "--max-seconds", "0.2"], { CODEX_COMPANION_APP_SERVER_ENDPOINT: "unix:/nonexistent/wrong-broker" });
  assert.equal(output.code, 0, output.stderr);
  assert.match(output.stdout, /TIMEOUT job=task-live/);
  assert.deepEqual(methods, ["initialize", "broker/observe-follow"]);
});

test("observe checks the temp-backed repo key after an explicit root misses", async (t) => {
  const h = await setup(t);
  const { stateDir } = await h.put("codex-inline", "task-temp", "temp", 100);
  const tempState = path.join(os.tmpdir(), "codex-companion", h.key);
  fs.mkdirSync(path.dirname(tempState), { recursive: true });
  fs.renameSync(stateDir, tempState);
  t.after(() => fs.rmSync(tempState, { recursive: true, force: true }));
  const result = await h.cli(["view-path", "task-temp"], { CLAUDE_PLUGIN_DATA: path.join(h.config, "missing-data") });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), path.join(tempState, "job-history/task-temp/live-view.json"));
});
