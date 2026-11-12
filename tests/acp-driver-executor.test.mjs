import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import os from "node:os";
import { AcpExecutorJobPort } from "../plugins/codex/scripts/lib/executors/acp-driver.mjs";
import { runAcpTurn } from "../plugins/codex/scripts/lib/acp.mjs";
import { handleStatus } from "../plugins/codex/scripts/codex-companion.mjs";
import { DirectorChannel } from "../plugins/codex/scripts/director-channel.mjs";
import { acceptDirectorEvents, eventFromRef, eventPaths } from "../plugins/codex/scripts/lib/director-delivery.mjs";
import { ObservationClient } from "../plugins/codex/scripts/lib/observation-client.mjs";
import { listJobs, writeJobFile, upsertJob, readJobFile, resolveJobFile } from "../plugins/codex/scripts/lib/state.mjs";
import { createJobLogFile, createProgressReporter, runTrackedJob } from "../plugins/codex/scripts/lib/tracked-jobs.mjs";
import { BROKER_READY_MS, initGitRepo, isolateTestEnvironment, makeTempDir, run, waitFor, within } from "./helpers.mjs";
import { createFakeAcpProcess } from "./fake-acp-agent.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const AGENT = path.join(ROOT, "tests/fake-acp-agent.mjs");
const SCRIPT = path.join(ROOT, "plugins/codex/scripts/codex-companion.mjs");

function useInProcessAgent(t, configure) {
  t.mock.method(childProcess, "spawn", (_command, _args, { env }) => createFakeAcpProcess(env, configure));
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
}

test("ACP detects steering in both initialize metadata locations", async (t) => {
  isolateTestEnvironment(t);
  useInProcessAgent(t);
  for (const location of ["top-level", "capabilities", "none"]) {
    const cwd = fs.realpathSync(makeTempDir());
    const job = { id: "steering-metadata", executor: "acp", workspaceRoot: cwd, status: "running" };
    writeJobFile(cwd, job.id, job);
    upsertJob(cwd, job);
    const port = await AcpExecutorJobPort.open({ cwd, job, command: process.execPath, args: [AGENT],
      env: { ...process.env, ACP_FAKE_STEERING_LOCATION: location } });
    try {
      assert.equal(port.steeringExtension, location !== "none", location);
      assert.equal(port.capabilities.midTurnSteer, location !== "none", location);
    } finally {
      await port.close();
    }
  }
});

test("prompt completion closes Qoder input immediately and rechecks agy steering after pending updates", async (t) => {
  isolateTestEnvironment(t);
  let replies;
  useInProcessAgent(t, agent => {
    agent.prompt = () => new Promise(resolve => replies.push(resolve));
  });
  for (const name of ["Antigravity ACP Server", "qoder-cli"]) {
    replies = [];
    const cwd = fs.realpathSync(makeTempDir());
    const job = { id: "completion-boundary", executor: "acp", workspaceRoot: cwd, status: "running" };
    writeJobFile(cwd, job.id, job);
    upsertJob(cwd, job);
    const port = await AcpExecutorJobPort.open({ cwd, job, command: process.execPath, args: [AGENT],
      env: { ...process.env, HOME: cwd, ACP_FAKE_AGENT_NAME: name } });
    let release;
    try {
      await port.startSession({ modelId: "efficient" });
      port.capabilities.midTurnSteer = true;
      const prompt = [{ type: "text", text: "task" }];
      const turn = await port.startTurn({ sessionId: port.sessionId, prompt });
      await waitFor(() => replies.length === 1);
      port.updateTail = new Promise(resolve => { release = resolve; });
      replies[0]({ stopReason: "end_turn" });
      await new Promise(setImmediate);
      const correction = port.steerPrompt({ sessionId: port.sessionId, turnId: turn.turnId, prompt });
      if (name === "qoder-cli") {
        await assert.rejects(correction, error => error.code === "TURN_NOT_ACTIVE");
        assert.equal(replies.length, 1);
        release();
      } else {
        await correction;
        await waitFor(() => replies.length === 2);
        release();
        await new Promise(setImmediate);
        assert.equal(port.activeTurn?.turnId, turn.turnId);
        replies[1]({ stopReason: "end_turn" });
      }
      assert.equal((await turn.done).status, "completed");
    } finally { release?.(); await port.close(); }
  }
});

test("interruption drains a late load replay before replacement and closes a load that never settles", async (t) => {
  isolateTestEnvironment(t);
  let releaseLoad, prompts, stall;
  useInProcessAgent(t, agent => {
    agent.prompt = async ({ sessionId }) => {
      prompts++;
      if (prompts === 1) await agent.connection.sessionUpdate({ sessionId, update: { sessionUpdate: "tool_call",
        toolCallId: "background-command", title: "npm test", kind: "execute", status: "in_progress" } });
      else await agent.connection.sessionUpdate({ sessionId, update: { sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Replacement only" } } });
      return { stopReason: "end_turn" };
    };
    agent.loadSession = ({ sessionId }) => new Promise(resolve => {
      releaseLoad = async () => {
        await agent.connection.sessionUpdate({ sessionId, update: { sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "OLD REPLAY MUST NOT APPEAR" } } });
        await agent.connection.sessionUpdate({ sessionId, update: { sessionUpdate: "tool_call",
          toolCallId: "background-command", title: "npm test", kind: "execute", status: "completed" } });
        if (!stall) resolve({});
      };
    });
  });
  for (const mode of ["interrupt", "cancel", "timeout"]) {
    prompts = 0;
    releaseLoad = null;
    stall = mode === "timeout";
    const cwd = fs.realpathSync(makeTempDir());
    const job = { id: "load-drain", executor: "acp", workspaceRoot: cwd, status: "running" };
    writeJobFile(cwd, job.id, job);
    upsertJob(cwd, job);
    const port = await AcpExecutorJobPort.open({ cwd, job, command: process.execPath, args: [AGENT],
      cancelTimeoutMs: stall ? 10 : 1000, env: { ...process.env, HOME: cwd, ACP_FAKE_AGENT_NAME: "Antigravity ACP Server" } });
    try {
      await port.startSession({ modelId: "efficient" });
      const turn = await port.startTurn({ sessionId: port.sessionId, prompt: [{ type: "text", text: "task" }] });
      await waitFor(() => releaseLoad);
      const method = mode === "cancel" ? "cancelJob" : "interruptTurn";
      const stopped = port[method]({ sessionId: port.sessionId, turnId: turn.turnId, timeoutMs: 1000,
        replacementPrompt: [{ type: "text", text: "replace" }] });
      if (stall) {
        await assert.rejects(Promise.all([turn.done, stopped]), error => error.code === "TRANSPORT_CLOSED" && /session\/load/.test(error.message));
        assert.equal(port.proc.exitCode, 0);
        assert.equal(prompts, 1);
      } else {
        await new Promise(setImmediate);
        assert.ok(port.backgroundSnapshot);
        assert.equal(port.activeTurn?.turnId, turn.turnId);
        await releaseLoad();
        await stopped;
        assert.equal(port.backgroundSnapshot, null);
        const next = await port.startTurn({ sessionId: port.sessionId, prompt: [{ type: "text", text: "replace" }] });
        const terminal = await next.done;
        assert.equal(terminal.finalMessages.find(message => message.role === "assistant").text, "Replacement only");
        assert.equal(JSON.stringify(terminal).includes("OLD REPLAY"), false);
      }
    } finally { await port.close(); }
  }
});

test("Antigravity harness fatal stderr fails the round before end_turn can publish completion", async (t) => {
  isolateTestEnvironment(t);
  useInProcessAgent(t);
  const fatal = "I1111 local_connection.py:553] harness stderr: Agent run failed: no pending hook for ID hook_request_31\n";
  for (const [agent, stderr, fails] of [
    ["antigravity-acp", fatal, true],
    ["Antigravity ACP Server", fatal, true],
    ["qoder-cli", fatal, false],
    ["antigravity-acp", "ERROR ordinary tool error\nharness stderr: received model response error: context canceled\n", false]
  ]) {
    const cwd = fs.realpathSync(makeTempDir());
    const job = { id: "acp-stderr", executor: "acp", workspaceRoot: cwd, status: "running" };
    writeJobFile(cwd, job.id, job);
    upsertJob(cwd, job);
    const events = [];
    const { result, error } = await runAcpTurn(cwd, { jobId: job.id, prompt: "stderr", command: process.execPath, args: [AGENT], modelId: "efficient",
      env: { ...process.env, HOME: cwd, GEMINI_HOME: cwd, CODEX_HOME: cwd, ACP_FAKE_AGENT_NAME: agent,
        ACP_FAKE_STDERR: stderr }, onExecutorEvent: event => events.push(event) })
      .then(result => ({ result }), error => ({ error }));
    if (result) await result.afterCompletion();
    if (fails) {
      assert.equal(error?.message, fatal.trimEnd());
      assert.ok(events.some(event => event.type === "job.failed" && event.payload.error.message === fatal.trimEnd()));
      assert.equal(events.some(event => ["turn.completed", "job.completed"].includes(event.type)), false);
    } else {
      assert.equal(error, undefined);
      assert.equal(result.status, 0);
    }
  }
});

test("ACP transport failure remains the job reason when SDK cleanup also rejects", async (t) => {
  isolateTestEnvironment(t);
  useInProcessAgent(t);
  const close = AcpExecutorJobPort.prototype.close;
  t.mock.method(AcpExecutorJobPort.prototype, "close", async function () {
    await close.call(this);
    throw new Error("SDK cleanup rejected");
  });
  t.mock.method(AcpExecutorJobPort.prototype, "promptResponse", async () => {
    throw Object.assign(new Error("ACP connection closed"), { code: "TRANSPORT_CLOSED" });
  });
  const cwd = fs.realpathSync(makeTempDir());
  const job = { id: "acp-close-failure", executor: "acp", workspaceRoot: cwd, status: "running" };
  writeJobFile(cwd, job.id, job);
  upsertJob(cwd, job);
  await assert.rejects(runTrackedJob(job, () => runAcpTurn(cwd, { jobId: job.id,
    prompt: "basic", command: process.execPath, args: [AGENT] })),
  error => error.code === "TRANSPORT_CLOSED");
  assert.match(readJobFile(resolveJobFile(cwd, job.id)).errorMessage, /closed|exited/i);
});

test("status skips live endpoints for finished ACP jobs including status --wait", async (t) => {
  isolateTestEnvironment(t);
  const cwd = fs.realpathSync(makeTempDir());
  let output;
  t.mock.method(console, "log", text => { output = text; });
  const connect = t.mock.method(ObservationClient, "connect", () => assert.fail("finished job connected to a live endpoint"));
  for (const status of ["completed", "failed", "cancelled"]) {
    const job = { id: `acp-${status}`, executor: "acp", workspaceRoot: cwd, status,
      controlEndpoint: `unix:${path.join(cwd, "removed", "broker.sock")}` };
    writeJobFile(cwd, job.id, job);
    upsertJob(cwd, job);
    await handleStatus([job.id, "--cwd", cwd, "--json", ...(status === "failed" ? ["--wait"] : [])]);
    assert.equal(JSON.parse(output).job.live, undefined);
  }
  assert.equal(connect.mock.callCount(), 0);
});

test("ACP startup failures log phase, RPC details and bounded stderr before cleanup", async (t) => {
  isolateTestEnvironment(t);
  useInProcessAgent(t);
  for (const phase of ["initialize", "session/new", "session/resume", "ready"]) {
    const cwd = fs.realpathSync(makeTempDir());
    const job = { id: "acp-startup-evidence", executor: "acp", workspaceRoot: cwd, status: "queued" };
    const logFile = createJobLogFile(cwd, job.id, "ACP test");
    const progress = Object.assign(createProgressReporter({ logFile }), { jobId: job.id });
    await assert.rejects(runTrackedJob({ ...job, logFile }, () => runAcpTurn(cwd, {
      jobId: job.id, prompt: "basic", command: process.execPath, args: [AGENT], modeId: "default", onProgress: progress,
      ...(phase === "session/resume" ? { resumeSessionId: "fake-session" } : {}),
      env: { ...process.env, ACP_FAKE_STARTUP_ERROR: phase }
    })), /Internal error/);
    const log = fs.readFileSync(logFile, "utf8");
    assert.match(log, new RegExp(`"phase": "${phase}"`));
    assert.match(log, /"code": -32603/);
    assert.match(log, /"detail": "fake startup detail"/);
    assert.match(log, /startup stderr tail/);
    assert.doesNotMatch(log, /discarded startup prefix/);
    assert.ok(Buffer.byteLength(log) < 6000, `startup log too large: ${Buffer.byteLength(log)}`);
    const stored = readJobFile(resolveJobFile(cwd, job.id));
    assert.equal(stored.status, "failed");
    assert.doesNotMatch(JSON.stringify(stored), /startup stderr tail/);
  }
});

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
  const ports = [];
  let channel;
  let dir;
  // Run before isolateTestEnvironment restores process.env: a late ACP event
  // must still use this test's state directory while its child is shutting down.
  t.after(async () => {
    try {
      for (const port of ports) {
        try {
          await within(port.close(), 2000, "ACP port cleanup");
        } finally {
          if (port.proc?.exitCode === null && port.proc.signalCode === null) port.proc.kill("SIGKILL");
          port.proc?.stdin.destroy();
          port.proc?.stdout.destroy();
          port.proc?.stderr.destroy();
          port.queue.close();
          try {
            await within(port.exitPromise, 1000, "ACP child exit");
          } finally {
            await within(port.runtime?.close(), 1000, "ACP runtime cleanup");
          }
        }
      }
    } finally {
      try {
        if (channel) await within(channel.close(), 1000, "director channel cleanup");
      } finally {
        if (dir) fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });
  isolateTestEnvironment(t);
  // Capture ownership before initialize can wait on the fake agent, even if it
  // never publishes a control endpoint. Exercise the real initialize method.
  const initialize = AcpExecutorJobPort.prototype.initialize;
  t.mock.method(AcpExecutorJobPort.prototype, "initialize", function () {
    ports.push(this);
    return initialize.call(this);
  });
  process.env.CODEX_COMPANION_SESSION_ID = "wrong-environment-owner";
  const cwd = fs.realpathSync(makeTempDir());
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cxd-run-"));
  const messages = [];
  let endpoint;
  channel = new DirectorChannel({ dir, send: async message => {
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
  for (const prompt of ["question", "permission"]) {
    const id = `acp-production-${prompt}`;
    const job = { id, executor: "acp", workspaceRoot: cwd, sessionId: "persisted-owner", status: "running", pid: process.pid,
      createdAt: new Date().toISOString(), startedAt: new Date().toISOString() };
    writeJobFile(cwd, id, job);
    upsertJob(cwd, job);
    let sessionReady;
    const ready = new Promise(resolve => { sessionReady = resolve; });
    const running = runAcpTurn(cwd, { jobId: id, prompt, command: process.execPath, args: [AGENT], modeId: "default",
      onProgress: progress => {
        if (progress.controlEndpoint) endpoint = progress.controlEndpoint;
        if (progress.executorSessionId) sessionReady();
      } });
    // Process/session startup has its own budget; the delivery deadline starts
    // only once the agent is ready to receive the prompt.
    await within(Promise.race([ready, running]), BROKER_READY_MS, `production ACP ${prompt} startup`);
    const result = await within(running, 20000, `production ACP ${prompt} delivery`);
    assert.equal(result.status, 0);
    assert.equal(readJobFile(resolveJobFile(cwd, id)).directorPush, true);
    await within(result.afterCompletion(), 2000, `production ACP ${prompt} completion`);
    ports.pop();
  }
  assert.equal(messages.filter(message => message.meta.event === "question_opened").length, 2);
  assert.equal(messages.filter(message => message.meta.event === "job_completed").length, 2);
});

test("ACP fork branches session context and re-applies mode/model/effort when advertised, and rejects unsupported agents", (t) => {
  isolateTestEnvironment(t);
  const cwd = fs.realpathSync(makeTempDir());
  initGitRepo(cwd);
  const sessionFile = path.join(cwd, "acp-sessions.json");
  const sourceRun = run(
    process.execPath,
    [
      SCRIPT, "task", "--cwd", cwd, "--executor", "acp",
      "--executor-command", process.execPath,
      "--executor-args", JSON.stringify([AGENT]),
      "--executor-mode", "yolo",
      "--executor-model", "performance",
      "--executor-effort", "max",
      "--json", "memo:set:alpha"
    ],
    { cwd, env: { ...process.env, ACP_FAKE_SESSION_FILE: sessionFile, ACP_FAKE_FORK: "1" } }
  );
  assert.equal(sourceRun.status, 0, sourceRun.stderr);
  const sourcePayload = JSON.parse(sourceRun.stdout);
  const sourceJob = listJobs(cwd).find((job) => job.executorSessionId === sourcePayload.threadId);
  assert.ok(sourceJob);

  for (const row of [
    { name: "advertises session/fork", fork: true },
    { name: "omits session/fork", fork: false }
  ]) {
    const recording = path.join(cwd, `acp-fork-${row.fork ? "yes" : "no"}.jsonl`);
    const forkRun = run(
      process.execPath,
      [SCRIPT, "task", "--cwd", cwd, "--fork-thread", sourcePayload.threadId, "--json", "memo:set:beta"],
      {
        cwd,
        env: {
          ...process.env,
          ACP_FAKE_SESSION_FILE: sessionFile,
          ACP_FAKE_FORK: row.fork ? "1" : "0",
          ACP_FAKE_RECORDING: recording
        }
      }
    );

    if (row.fork) {
      assert.equal(forkRun.status, 0, `${row.name}: ${forkRun.stderr}`);
      const forkPayload = JSON.parse(forkRun.stdout);
      assert.notEqual(forkPayload.threadId, sourcePayload.threadId, row.name);
      assert.match(forkPayload.rawOutput, /prev=alpha now=beta mode=yolo model=performance effort=max/, row.name);

      const forkJobSummary = listJobs(cwd).find((job) => job.executorSessionId === forkPayload.threadId);
      assert.ok(forkJobSummary, row.name);
      const forkJob = readJobFile(resolveJobFile(cwd, forkJobSummary.id));
      assert.deepEqual(forkJob.forkedFrom, { threadId: sourcePayload.threadId, jobId: sourceJob.id }, row.name);

      const calls = fs.readFileSync(recording, "utf8").trim().split("\n").map(JSON.parse);
      assert.equal(calls.find((call) => call.method === "session/fork")?.params.sessionId, sourcePayload.threadId, row.name);
      assert.deepEqual(
        calls.find((call) => call.method === "session/set_mode")?.params,
        { sessionId: forkPayload.threadId, modeId: "yolo" },
        row.name
      );
      assert.deepEqual(
        calls.filter((call) => call.method === "session/set_config_option").map((call) => call.params),
        [
          { sessionId: forkPayload.threadId, configId: "model", value: "performance" },
          { sessionId: forkPayload.threadId, configId: "reasoning_effort", value: "max" }
        ],
        row.name
      );

      const sessions = new Map(JSON.parse(fs.readFileSync(sessionFile, "utf8")));
      assert.equal(sessions.get(sourcePayload.threadId)?.remembered, "alpha", row.name);
      assert.equal(sessions.get(forkPayload.threadId)?.remembered, "beta", row.name);

      const queuedRecording = path.join(cwd, "acp-fork-queued.jsonl");
      const queueEnv = {
        ...process.env,
        ACP_FAKE_SESSION_FILE: sessionFile,
        ACP_FAKE_FORK: "1",
        ACP_FAKE_RECORDING: queuedRecording
      };
      const queuedRun = run(
        process.execPath,
        [SCRIPT, "message", forkJobSummary.id, "--cwd", cwd, "--queue", "--json", "memo:set:gamma"],
        { cwd, env: queueEnv }
      );
      assert.equal(queuedRun.status, 0, `${row.name} queue: ${queuedRun.stderr}`);
      const { queuedJobId } = JSON.parse(queuedRun.stdout);
      const waitedRun = run(
        process.execPath,
        [SCRIPT, "status", queuedJobId, "--cwd", cwd, "--wait", "--json"],
        { cwd, env: queueEnv }
      );
      assert.equal(waitedRun.status, 0, waitedRun.stderr);
      const queuedJob = JSON.parse(waitedRun.stdout).job;
      assert.equal(queuedJob.status, "completed", queuedJob.errorMessage);
      assert.equal(queuedJob.threadId, forkPayload.threadId);
      assert.equal(queuedJob.request?.forkThreadId, undefined);
      const resultRun = run(
        process.execPath,
        [SCRIPT, "result", queuedJobId, "--cwd", cwd],
        { cwd, env: queueEnv }
      );
      assert.equal(resultRun.status, 0, resultRun.stderr);
      assert.match(resultRun.stdout, /prev=beta now=gamma/);
      const queuedCalls = fs.readFileSync(queuedRecording, "utf8").trim().split("\n").map(JSON.parse);
      assert.equal(queuedCalls.some((call) => call.method === "session/fork"), false);
      assert.equal(queuedCalls.find((call) => call.method === "session/resume")?.params.sessionId, forkPayload.threadId);
      const afterQueueSessions = new Map(JSON.parse(fs.readFileSync(sessionFile, "utf8")));
      assert.equal(afterQueueSessions.get(sourcePayload.threadId)?.remembered, "alpha");
      assert.equal(afterQueueSessions.get(forkPayload.threadId)?.remembered, "gamma");
    } else {
      assert.notEqual(forkRun.status, 0, row.name);
      assert.match(forkRun.stderr, /does not support session\/fork/, row.name);
      const failedJob = listJobs(cwd).find((job) => job.status === "failed");
      assert.ok(failedJob, row.name);
      const log = fs.readFileSync(failedJob.logFile, "utf8");
      assert.match(log, /"phase": "session\/fork"/, row.name);
      assert.match(log, /"code": "UNSUPPORTED_CAPABILITY"/, row.name);
    }
  }
});
