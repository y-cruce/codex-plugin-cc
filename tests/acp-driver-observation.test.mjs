import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { openAcpExecutorJob } from "../plugins/codex/scripts/lib/executors/acp-driver.mjs";
import { ObservationClient } from "../plugins/codex/scripts/lib/observation-client.mjs";
import { readHistory } from "../plugins/codex/scripts/lib/job-event-store.mjs";
import { resolveJobHistory } from "../plugins/codex/scripts/lib/history-resolver.mjs";
import { listJobs, upsertJob, writeJobFile } from "../plugins/codex/scripts/lib/state.mjs";
import { BROKER_READY_MS, isolateTestEnvironment, makeTempDir, run } from "./helpers.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const AGENT = path.join(ROOT, "tests/fake-acp-agent.mjs");
const SCRIPT = path.join(ROOT, "plugins/codex/scripts/codex-companion.mjs");

async function waitFor(predicate, timeoutMs = BROKER_READY_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for ACP state");
}

async function setupPort(t, id = "acp-job", options = {}) {
  isolateTestEnvironment(t);
  const cwd = fs.realpathSync(makeTempDir());
  const job = { id, executor: "acp", workspaceRoot: cwd, status: "running", title: "ACP test",
    createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), pid: process.pid };
  writeJobFile(cwd, id, job);
  upsertJob(cwd, job);
  const port = await openAcpExecutorJob({ cwd, job, command: process.execPath, args: [AGENT], env: options.env,
    modelId: options.modelId, effortId: options.effortId });
  t.after(() => port.close());
  const events = [];
  const pump = (async () => { for await (const event of port.events()) events.push(event); })();
  t.after(() => pump);
  const session = await port.startSession({ cwd, additionalDirectories: [], mcpServers: [], modeId: "default",
    modelId: options.modelId, effortId: options.effortId });
  return { cwd, job, port, events, session };
}

function readRecording(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
}

test("ACP observation endpoint follows events and persists a nonblank live view", async (t) => {
  const h = await setupPort(t, "acp-observe");
  const job = { ...h.job, executorSessionId: h.session.sessionId, controlEndpoint: h.port.controlEndpoint };
  const client = await ObservationClient.connect(h.cwd, { job });
  t.after(() => client.close());
  const pages = [];
  client.on("notification", (message) => { if (message.method === "broker/observation") pages.push(message.params); });
  await client.request("broker/observe-follow", { cwd: h.cwd, jobId: h.job.id });
  const turn = await h.port.startTurn({ sessionId: h.session.sessionId, prompt: [{ type: "text", text: "basic" }] });
  const terminal = await turn.done;
  await h.port.adapter.completeJob(terminal);
  await waitFor(() => pages.some((page) => page.events.some((event) => event.type === "message.completed")));
  await h.port.close();
  const history = await readHistory(h.cwd, h.job.id);
  assert.ok(history.events.some((event) => event.type === "job.completed"));
  const view = JSON.parse(fs.readFileSync((await resolveJobHistory(h.cwd, h.job.id)).liveView, "utf8"));
  assert.equal(view.executor.kind, "acp");
  assert.equal(view.lastMessage.text, "Basic complete");
  assert.equal(view.files.length, 1);
});

test("ACP follow replays a committed terminal event after its endpoint closes", async (t) => {
  const h = await setupPort(t, "acp-follow-close-race");
  const running = { ...h.job, executorSessionId: h.session.sessionId, controlEndpoint: h.port.controlEndpoint };
  writeJobFile(h.cwd, h.job.id, running);
  upsertJob(h.cwd, running);
  const turn = await h.port.startTurn({ sessionId: h.session.sessionId, prompt: [{ type: "text", text: "basic" }] });
  const terminal = await turn.done;
  await h.port.adapter.completeJob(terminal);
  await h.port.close();

  const followed = run(process.execPath, [SCRIPT, "observe", "follow", h.job.id, "--cwd", h.cwd, "--quiet"], { cwd: h.cwd });
  assert.equal(followed.status, 0, followed.stderr);
  assert.match(followed.stdout, /^CURSOR: /m);
  assert.match(followed.stdout, /^DONE job=acp-follow-close-race /m);
});

test("ACP follow reaches DONE when the endpoint closes while it is waiting", async (t) => {
  const h = await setupPort(t, "acp-follow-connected-close");
  const running = { ...h.job, executorSessionId: h.session.sessionId, controlEndpoint: h.port.controlEndpoint };
  writeJobFile(h.cwd, h.job.id, running);
  upsertJob(h.cwd, running);
  const child = spawn(process.execPath, [SCRIPT, "observe", "follow", h.job.id, "--cwd", h.cwd, "--quiet"], {
    cwd: h.cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const exited = once(child, "exit");
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  await waitFor(() => h.port.runtime.followers.size === 1);

  const turn = await h.port.startTurn({ sessionId: h.session.sessionId, prompt: [{ type: "text", text: "basic" }] });
  const terminal = await turn.done;
  await h.port.adapter.completeJob(terminal);
  await h.port.close();
  const [code] = await exited;

  assert.equal(code, 0, stderr);
  assert.match(stdout, /^CURSOR: /m);
  assert.match(stdout, /^DONE job=acp-follow-connected-close /m);
});

test("ACP follow prints a recovery cursor when its endpoint closes before a terminal event", async (t) => {
  const h = await setupPort(t, "acp-follow-unavailable");
  const running = { ...h.job, executorSessionId: h.session.sessionId, controlEndpoint: h.port.controlEndpoint };
  writeJobFile(h.cwd, h.job.id, running);
  upsertJob(h.cwd, running);
  await h.port.close();

  const followed = run(process.execPath, [SCRIPT, "observe", "follow", h.job.id, "--cwd", h.cwd, "--quiet"], { cwd: h.cwd });
  assert.equal(followed.status, 1);
  assert.match(followed.stdout, /^CURSOR: /m);
  assert.match(followed.stderr, /^BROKER_UNAVAILABLE Broker disconnected; continue with --after$/m);
});
