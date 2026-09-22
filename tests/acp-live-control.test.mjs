import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { readStoredJob } from "../plugins/codex/scripts/lib/job-control.mjs";
import { readRecordHistory } from "../plugins/codex/scripts/lib/job-event-store.mjs";
import { readRoundContext } from "../plugins/codex/scripts/lib/history-resolver.mjs";
import { liveStatus, sendLiveCommand } from "../plugins/codex/scripts/lib/live-commands.mjs";
import { LiveTurnControl } from "../plugins/codex/scripts/lib/live-turn-control.mjs";
import { listJobs } from "../plugins/codex/scripts/lib/state.mjs";
import { initGitRepo, isolateTestEnvironment, makeTempDir, run } from "./helpers.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const AGENT = path.join(ROOT, "tests/fake-acp-agent.mjs");
const SCRIPT = path.join(ROOT, "plugins/codex/scripts/codex-companion.mjs");

async function waitFor(predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for ACP live control");
}

function recordingPrompts(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
    .filter((entry) => entry.method === "session/prompt")
    .map((entry) => entry.params.prompt.map((block) => block.text).join("\n"));
}

function startTask(t, mode = "default") {
  isolateTestEnvironment(t);
  const cwd = fs.realpathSync(makeTempDir());
  initGitRepo(cwd);
  const recording = path.join(makeTempDir(), "acp-recording.jsonl");
  const releaseFile = path.join(makeTempDir(), "acp-release");
  const env = { ...process.env, ACP_FAKE_RECORDING: recording, ACP_FAKE_RELEASE_FILE: releaseFile };
  const child = spawn(process.execPath, [SCRIPT, "task", "--cwd", cwd, "--executor", "acp",
    "--executor-command", process.execPath, "--executor-args", JSON.stringify([AGENT]),
    "--executor-mode", mode, "--json", mode === "yolo" ? "permission" : "hold"], { cwd, env });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const done = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal, stdout, stderr })));
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    await done;
  });
  const cli = (...args) => run(process.execPath, [SCRIPT, ...args, "--cwd", cwd, "--json"], { cwd, env });
  const runningJob = () => listJobs(cwd).find((job) => job.pid === child.pid && job.turnId) ?? null;
  const release = () => fs.writeFileSync(releaseFile, "release\n");
  return { cwd, env, child, done, cli, recording, runningJob, release };
}

async function waitForExit(task, timeoutMs = 10000) {
  let timer;
  try {
    return await Promise.race([task.done, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Timed out waiting for ACP task exit")), timeoutMs);
      timer.unref?.();
    })]);
  } finally {
    clearTimeout(timer);
  }
}

const cases = [
  {
    name: "--queue waits for the active turn and starts the next turn",
    run: async (t) => {
      const h = startTask(t);
      const job = await waitFor(h.runningJob);
      const queued = h.cli("message", job.id, "--queue", "queued-next");
      assert.equal(queued.status, 0, queued.stderr);
      const accepted = JSON.parse(queued.stdout);
      assert.equal(accepted.queued, true);
      assert.notEqual(accepted.queuedJobId, job.id);
      const pending = (await liveStatus(h.cwd, job)).pendingMessages;
      assert.deepEqual(pending.map((entry) => [entry.jobId, entry.input[0].text, entry.queued]),
        [[accepted.queuedJobId, "queued-next", true]]);
      h.release();
      const result = await waitForExit(h);
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(recordingPrompts(h.recording), ["hold", "queued-next"]);

      const original = await readRoundContext(h.cwd, job.id);
      const continuation = await readRoundContext(h.cwd, accepted.queuedJobId);
      assert.equal(continuation.recordId, original.recordId);
      const history = await readRecordHistory(h.cwd, original.recordId);
      assert.deepEqual(history.events.filter((event) => event.type.startsWith("job.")).map((event) => [event.jobId, event.type]), [
        [job.id, "job.started"], [job.id, "job.completed"],
        [accepted.queuedJobId, "job.started"], [accepted.queuedJobId, "job.completed"]
      ]);
    }
  },
  {
    name: "a message without a flag remains unsupported for ACP",
    run: async (t) => {
      const h = startTask(t);
      const job = await waitFor(h.runningJob);
      const refused = h.cli("message", job.id, "mid-turn");
      assert.equal(refused.status, 1);
      assert.match(refused.stderr, /cannot add a message to the active turn/i);
      h.release();
      const result = await waitForExit(h);
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(recordingPrompts(h.recording), ["hold"]);
    }
  },
  {
    name: "two queued messages start turns in FIFO order",
    run: async (t) => {
      const h = startTask(t);
      const job = await waitFor(h.runningJob);
      const queuedJobIds = [];
      for (const prompt of ["queued-first", "queued-second"]) {
        const queued = await sendLiveCommand(h.cwd, job.id, "message", { queue: true }, prompt);
        queuedJobIds.push(queued.queuedJobId);
      }
      assert.equal(new Set([job.id, ...queuedJobIds]).size, 3);
      h.release();
      const result = await waitForExit(h);
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(recordingPrompts(h.recording), ["hold", "queued-first", "queued-second"]);

      const contexts = await Promise.all([job.id, ...queuedJobIds].map((jobId) => readRoundContext(h.cwd, jobId)));
      assert.equal(new Set(contexts.map((context) => context.recordId)).size, 1);
      const history = await readRecordHistory(h.cwd, contexts[0].recordId);
      assert.deepEqual(history.events.filter((event) => event.type.startsWith("job.")).map((event) => [event.jobId, event.type]), [
        [job.id, "job.started"], [job.id, "job.completed"],
        [queuedJobIds[0], "job.started"], [queuedJobIds[0], "job.completed"],
        [queuedJobIds[1], "job.started"], [queuedJobIds[1], "job.completed"]
      ]);
    }
  },
  {
    name: "a permission wakes the director and answer selects an option value",
    run: async (t) => {
      const h = startTask(t);
      const job = await waitFor(h.runningJob);
      const queued = h.cli("message", job.id, "--queue", "permission");
      assert.equal(queued.status, 0, queued.stderr);
      const queuedJobId = JSON.parse(queued.stdout).queuedJobId;
      h.release();
      const permission = await waitFor(() => {
        const status = h.cli("status", queuedJobId);
        if (status.status !== 0) return null;
        return JSON.parse(status.stdout).job.live?.questions?.find((item) => item.kind === "permission") ?? null;
      });
      assert.ok(permission.requestId.startsWith("permission:"));
      assert.ok(permission.questions[0].options.some((option) => option.value === "allow"));
      const stale = h.cli("message", job.id, "stale-old-round");
      assert.equal(stale.status, 1);
      assert.match(stale.stderr, /not the active round/i);

      const events = spawn(process.execPath, [SCRIPT, "events", "--cwd", h.cwd, "--poll-ms", "20"], { cwd: h.cwd, env: h.env });
      let eventOutput = "";
      events.stdout.on("data", (chunk) => { eventOutput += chunk; });
      const eventsDone = new Promise((resolve) => events.on("exit", resolve));
      t.after(async () => { if (events.exitCode === null) events.kill("SIGTERM"); await eventsDone; });
      await waitFor(() => eventOutput.includes(`QUESTION job=${queuedJobId} request=${permission.requestId}`));

      const answersFile = path.join(h.cwd, "answers.json");
      fs.writeFileSync(answersFile, JSON.stringify({ optionId: { answers: ["allow"] } }));
      const answered = h.cli("answer", queuedJobId, "--request-id", permission.requestId, "--answers-file", answersFile);
      assert.equal(answered.status, 0, answered.stderr);
      const result = await waitForExit(h);
      assert.equal(result.code, 0, result.stderr);
      assert.match(readStoredJob(h.cwd, queuedJobId).result.rawOutput, /"optionId":"allow"/);
    }
  },
  {
    name: "yolo automatically chooses the most permissive option",
    run: async (t) => {
      const h = startTask(t, "yolo");
      const result = await waitForExit(h);
      assert.equal(result.code, 0, result.stderr);
      assert.match(JSON.parse(result.stdout).rawOutput, /"optionId":"allow-session"/);
    }
  }
];

test("ACP queued turns and permission control", async (t) => {
  for (const entry of cases) await t.test(entry.name, (subtest) => entry.run(subtest));
});

test("Codex queue waits for natural completion and preserves FIFO", async () => {
  const requests = [];
  const control = new LiveTurnControl({ cwd: process.cwd(), request: async (...args) => { requests.push(args); } }, () => {});
  control.starting({ threadId: "thread-1", cwd: process.cwd() });
  control.observe({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1" } } });
  for (const text of ["queued-first", "queued-second"]) {
    const result = await control.request("broker/queue", {
      threadId: "thread-1", expectedTurnId: "turn-1", input: [{ type: "text", text }]
    });
    assert.equal(result.queued, true);
  }
  assert.deepEqual(control.snapshot("thread-1").pendingMessages.map((entry) => entry.input[0].text),
    ["queued-first", "queued-second"]);

  const first = { method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } };
  control.observe(first);
  assert.equal(first.params.queuedInput[0].text, "queued-first");
  control.observe({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-2" } } });
  const second = { method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-2", status: "completed" } } };
  control.observe(second);
  assert.equal(second.params.queuedInput[0].text, "queued-second");
  assert.deepEqual(requests, []);
});
