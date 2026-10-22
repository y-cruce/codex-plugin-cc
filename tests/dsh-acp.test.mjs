import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { AcpExecutorJobPort } from "../plugins/codex/scripts/lib/executors/acp-driver.mjs";
import { createLiveView } from "../plugins/codex/scripts/lib/job-event-model.mjs";
import { listJobs } from "../plugins/codex/scripts/lib/state.mjs";
import { readRoundContext } from "../plugins/codex/scripts/lib/history-resolver.mjs";
import { initGitRepo, isolateTestEnvironment, makeTempDir, run } from "./helpers.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = path.join(ROOT, "plugins/codex/scripts/codex-companion.mjs");
const AGENT = path.join(ROOT, "tests/fake-acp-agent.mjs");

test("DSH-shaped ACP sessions resume across processes and keep thoughts out of the answer", async (t) => {
  isolateTestEnvironment(t);
  const cwd = fs.realpathSync(makeTempDir());
  initGitRepo(cwd);
  const recording = path.join(cwd, "requests.jsonl");
  const env = { ...process.env, ACP_FAKE_DSH: "1", ACP_FAKE_RECORDING: recording,
    ACP_FAKE_SESSION_FILE: path.join(cwd, "sessions.json") };
  const cli = (prompt, extra = []) => run(process.execPath, [SCRIPT, "task", "--cwd", cwd, "--executor", "acp",
    "--executor-command", process.execPath, "--executor-args", JSON.stringify([AGENT]),
    "--executor-permissions", "allow-once", "--json", ...extra, prompt], { cwd, env });
  const first = cli("remember:context-survives");
  assert.equal(first.status, 0, first.stderr);
  const sessionId = JSON.parse(first.stdout).threadId;
  const firstJob = listJobs(cwd)[0];
  const second = cli("recall", ["--thread", sessionId]);
  assert.equal(second.status, 0, second.stderr);
  const result = JSON.parse(second.stdout);
  assert.equal(result.threadId, sessionId);
  assert.equal(result.rawOutput, "context-survives");
  assert.deepEqual(result.reasoningSummary, ["private reasoning"]);
  const secondJob = listJobs(cwd).find(job => job.id !== firstJob.id);
  assert.equal(secondJob.request.executorPermissions, "allow-once");
  assert.equal((await readRoundContext(cwd, firstJob.id)).recordId, (await readRoundContext(cwd, secondJob.id)).recordId);

  const requests = fs.readFileSync(recording, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(requests.filter(item => item.method === "session/new").length, 1);
  assert.deepEqual(requests.filter(item => item.method === "session/resume").map(item => item.params.sessionId), [sessionId]);
  assert.deepEqual(requests.find(item => item.method === "permission/result").outcome, { outcome: "selected", optionId: "allow" });
  assert.equal(requests.some(item => ["session/load", "session/set_mode", "session/set_config_option"].includes(item.method)), false);
});

test("one-shot permission policy never selects a lasting grant", async () => {
  const port = new AcpExecutorJobPort({ job: { id: "permissions" }, permissionPolicy: "allow-once" });
  const events = [];
  port.adapter = { emit: async (type, payload) => { events.push({ type, payload }); } };
  const response = await port.requestPermission({ toolCall: { toolCallId: "tool" },
    options: [{ optionId: "forever", name: "Always", kind: "allow_always" }] });
  assert.deepEqual(response, { outcome: { outcome: "cancelled" } });
  assert.equal(events.at(-1).type, "permission.resolved");
  const ask = new AcpExecutorJobPort({ job: { id: "ask" }, permissionPolicy: "ask", modeId: "yolo" });
  assert.equal(ask.autoApprovePermissions(), false);
});

test("live views distinguish DSH, Qoder and generic ACP commands", () => {
  for (const [command, label] of [["/bin/dsh", "DSH"], ["/bin/qoder", "Qoder"], ["/bin/agent", "ACP"]]) {
    assert.equal(createLiveView({ id: "label", executor: "acp", request: { executorCommand: command } }).executor.label, label);
  }
});
