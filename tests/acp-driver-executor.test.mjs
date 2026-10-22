import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import os from "node:os";
import { runAcpTurn } from "../plugins/codex/scripts/lib/acp.mjs";
import { DirectorChannel } from "../plugins/codex/scripts/director-channel.mjs";
import { acceptDirectorEvents, eventFromRef, eventPaths } from "../plugins/codex/scripts/lib/director-delivery.mjs";
import { ObservationClient } from "../plugins/codex/scripts/lib/observation-client.mjs";
import { listJobs, writeJobFile, upsertJob, readJobFile, resolveJobFile } from "../plugins/codex/scripts/lib/state.mjs";
import { initGitRepo, isolateTestEnvironment, makeTempDir, run, waitFor, within } from "./helpers.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const AGENT = path.join(ROOT, "tests/fake-acp-agent.mjs");
const SCRIPT = path.join(ROOT, "plugins/codex/scripts/codex-companion.mjs");

test("companion selects the ACP executor without changing the Codex default", (t) => {
  isolateTestEnvironment(t);
  const cwd = fs.realpathSync(makeTempDir());
  initGitRepo(cwd);
  const recording = path.join(cwd, "acp-recording.jsonl");
  const result = run(process.execPath, [SCRIPT, "task", "--cwd", cwd, "--executor", "acp", "--executor-command", process.execPath,
    "--executor-args", JSON.stringify([AGENT]), "--executor-mode", "yolo", "--json", "permission"],
    { cwd, env: { ...process.env, ACP_FAKE_RECORDING: recording } });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.executor, "acp");
  assert.match(payload.rawOutput, /"optionId":"allow-session"/);
  const job = listJobs(cwd)[0];
  assert.equal(job.request.executorMode, "yolo");
  const mode = fs.readFileSync(recording, "utf8").trim().split("\n").map(JSON.parse)
    .find((entry) => entry.method === "session/set_mode");
  assert.equal(mode.params.modeId, "yolo");
  const replay = run(process.execPath, [SCRIPT, "observe", "replay", job.id, "--cwd", cwd, "--jsonl"], { cwd });
  assert.equal(replay.status, 0, replay.stderr);
  const events = replay.stdout.trim().split("\n").map(JSON.parse);
  assert.ok(events.some((event) => event.type === "message.completed"));
  assert.equal(events.at(-1).type, "end");
});

test("CODEX_COMPANION_EXECUTOR sets the default executor and an explicit flag still wins", (t) => {
  isolateTestEnvironment(t);
  const cwd = fs.realpathSync(makeTempDir());
  initGitRepo(cwd);
  const env = {
    ...process.env,
    CODEX_COMPANION_EXECUTOR: "acp",
    CODEX_COMPANION_ACP_COMMAND: process.execPath,
    CODEX_COMPANION_ACP_ARGS: JSON.stringify([AGENT])
  };
  const viaEnv = run(process.execPath, [SCRIPT, "task", "--cwd", cwd, "--json", "basic"], { cwd, env });
  assert.equal(viaEnv.status, 0, viaEnv.stderr);
  assert.equal(JSON.parse(viaEnv.stdout).executor, "acp");

  const viaFlag = run(process.execPath, [SCRIPT, "task", "--cwd", cwd, "--executor", "acp", "--json", "basic"], {
    cwd, env: { ...env, CODEX_COMPANION_EXECUTOR: "codex" }
  });
  assert.equal(viaFlag.status, 0, viaFlag.stderr);
  assert.equal(JSON.parse(viaFlag.stdout).executor, "acp");
  assert.doesNotMatch(String(viaFlag.stdout) + String(viaFlag.stderr), /ACP execution requires/);
});

test("a backgrounded ACP round stores its payload in the round receipt", (t) => {
  isolateTestEnvironment(t);
  const cwd = fs.realpathSync(makeTempDir());
  const launch = run(process.execPath, [SCRIPT, "task", "--cwd", cwd, "--executor", "acp", "--executor-command", process.execPath,
    "--executor-args", JSON.stringify([AGENT]), "--background", "--json", "basic"], { cwd });
  assert.equal(launch.status, 0, launch.stderr);
  const jobId = JSON.parse(launch.stdout).jobId;
  const waited = run(process.execPath, [SCRIPT, "status", jobId, "--cwd", cwd, "--wait", "--json"], { cwd });
  assert.equal(waited.status, 0, waited.stderr);
  // The receipt is written when the round finalizes, which happens before the
  // runner stores the payload, so every backgrounded ACP round used to read
  // back as "no captured result payload" while the answer sat in the job file.
  // The foreground path writes in the other order and never showed it.
  // The summary line alone is not enough to tell the two apart: it is the first
  // line of the same payload, so it is printed either way.
  const stored = run(process.execPath, [SCRIPT, "result", jobId, "--cwd", cwd], { cwd });
  assert.equal(stored.status, 0, stored.stderr);
  assert.doesNotMatch(stored.stdout, /No captured result payload/);
  assert.match(stored.stdout, /Basic complete/);
});

test("a backgrounded ACP session startup failure reaches the director channel without a thread or turn", async (t) => {
  isolateTestEnvironment(t);
  process.env.CODEX_COMPANION_SESSION_ID = "acp-startup-owner";
  const cwd = fs.realpathSync(makeTempDir());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cxd-failed-"));
  const recording = path.join(cwd, "acp-recording.jsonl");
  const messages = [];
  const channel = new DirectorChannel({ dir, send: async message => {
    const event = eventFromRef(message.params.meta.delivery);
    await acceptDirectorEvents([event], "channel", async () => { messages.push({ ...message.params, event }); return {}; });
  } });
  t.after(async () => { await channel.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await channel.start(process.env.CODEX_COMPANION_SESSION_ID);
  await channel.handle({ action: "confirm", sessionId: channel.sessionId, instance: channel.instance, nonce: channel.nonce });
  const launch = run(process.execPath, [SCRIPT, "task", "--cwd", cwd, "--executor", "acp", "--executor-command", process.execPath,
    "--executor-args", JSON.stringify([AGENT]), "--executor-model", "no-such-model", "--background", "--json", "basic"],
    { cwd, env: { ...process.env, ACP_FAKE_RECORDING: recording } });
  assert.equal(launch.status, 0, launch.stderr);
  const { jobId, status } = JSON.parse(launch.stdout);
  assert.equal(status, "queued");
  const failed = await waitFor(() => {
    const job = readJobFile(resolveJobFile(cwd, jobId));
    return job.status === "failed" && job;
  }, "ACP startup failure");
  assert.match(failed.errorMessage, /ACP model no-such-model is not available/);
  assert.equal(failed.threadId ?? null, null);
  assert.equal(failed.turnId ?? null, null);
  const calls = fs.readFileSync(recording, "utf8").trim().split("\n").map(JSON.parse);
  assert.ok(calls.some(call => call.method === "session/new"));
  assert.ok(!calls.some(call => call.method === "session/prompt"));
  await waitFor(() => messages.length, "job_failed channel message after ACP startup failure", 5000);
  await channel.replay();
  assert.equal(messages.length, 1);
  const [{ meta, content, event }] = messages;
  assert.equal(meta.event, "job_failed");
  assert.equal(meta.job, jobId);
  assert.equal(meta.session, failed.sessionId);
  assert.equal(event.payload.errorMessage, failed.errorMessage);
  assert.equal(event.threadId, null);
  assert.equal(event.turnId, null);
  assert.match(content, /ACP model no-such-model is not available/);
});

test("runAcpTurn publishes questions and permissions with the persisted owner on a confirmed channel", async (t) => {
  isolateTestEnvironment(t);
  process.env.CODEX_COMPANION_SESSION_ID = "wrong-environment-owner";
  const cwd = fs.realpathSync(makeTempDir());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cxd-run-"));
  const messages = [];
  let endpoint;
  const channel = new DirectorChannel({ dir, send: async message => {
    const event = eventFromRef(message.params.meta.delivery);
    assert.equal(event.sessionId, "persisted-owner");
    assert.equal(fs.existsSync(eventPaths(event).item), true);
    await acceptDirectorEvents([event], "channel", async () => { messages.push(message.params); return {}; });
    if (event.type !== "question.opened") return;
    const client = await ObservationClient.connect(cwd, { endpoint });
    try {
      if (event.payload.requestId.startsWith("permission:")) await client.request("executor/answer-permission", {
        requestId: event.payload.requestId, outcome: "selected", optionId: "allow" });
      else await client.request("executor/answer-question", { requestId: event.payload.requestId, action: "accept",
        values: { name: "Ada", choice: "a", tags: ["x"], enabled: true } });
    } finally { client.close(); }
  } });
  await channel.start("persisted-owner");
  await channel.handle({ action: "confirm", sessionId: "persisted-owner", instance: channel.instance, nonce: channel.nonce });
  t.after(async () => { await channel.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  for (const prompt of ["question", "permission"]) {
    const id = `acp-production-${prompt}`;
    const job = { id, executor: "acp", workspaceRoot: cwd, sessionId: "persisted-owner", status: "running", pid: process.pid,
      createdAt: new Date().toISOString(), startedAt: new Date().toISOString() };
    writeJobFile(cwd, id, job);
    upsertJob(cwd, job);
    let finished = false;
    const running = runAcpTurn(cwd, { jobId: id, prompt, command: process.execPath, args: [AGENT], modeId: "default",
      onProgress: progress => { if (progress.controlEndpoint) endpoint = progress.controlEndpoint; } });
    running.catch(() => {});
    t.after(async () => {
      if (finished || !endpoint) return;
      const client = await ObservationClient.connect(cwd, { endpoint }).catch(() => null);
      if (client) try {
        const live = await client.request("executor/status");
        await client.request("executor/cancel-job", { turnId: live.turnId });
      } finally { client.close(); }
      const result = await running.catch(() => null);
      await result?.afterCompletion?.();
    });
    const result = await within(running, 20000, `production ACP ${prompt} delivery`);
    assert.equal(result.status, 0);
    assert.equal(readJobFile(resolveJobFile(cwd, id)).directorPush, true);
    await result.afterCompletion();
    finished = true;
  }
  assert.equal(messages.filter(message => message.meta.event === "question_opened").length, 2);
  assert.equal(messages.filter(message => message.meta.event === "job_completed").length, 2);
});
