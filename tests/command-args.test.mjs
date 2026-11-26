import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { handleCompact, handleTask } from "../plugins/codex/scripts/codex-companion.mjs";
import { handleObserve } from "../plugins/codex/scripts/lib/job-observe.mjs";
import { upsertJob, writeJobFile } from "../plugins/codex/scripts/lib/state.mjs";
import { fileURLToPath } from "node:url";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, isolateTestEnvironment, makeTempDir, run } from "./helpers.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = path.join(ROOT, "plugins/codex/scripts/codex-companion.mjs");

function setup() {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  return {
    cwd,
    env: { ...process.env, CLAUDE_PLUGIN_DATA: makeTempDir() }
  };
}

test("events rejects unknown options with its supported options and accepts legal options", () => {
  const h = setup();
  const rejected = run(process.execPath, [SCRIPT, "events", "--cwd", h.cwd, "--stall-ms", "1", "--exit-idle-ms", "1"], h);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /Unknown option --stall-ms/);
  for (const option of ["--cwd", "--poll-ms", "--question-remind-ms", "--exit-idle-ms", "--session"]) {
    assert.match(rejected.stderr, new RegExp(option));
  }

  const status = run(process.execPath, [SCRIPT, "status", "--cwd", h.cwd, "--stall-ms", "1"], h);
  assert.notEqual(status.status, 0);
  assert.match(status.stderr, /Unknown option --stall-ms/);

  const accepted = run(process.execPath, [SCRIPT, "events", "--cwd", h.cwd, "--poll-ms", "1",
    "--question-remind-ms", "1", "--exit-idle-ms", "1", "--session", "session-a"], h);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.stdout, /^IDLE_EXIT /m);
});

test("follow rejects unknown and unused options while preserving its job-id positional", async () => {
  const h = setup();
  for (const args of [["--stall-ms", "1"], ["--json"], ["--jsonl"], ["--limit", "1"]]) {
    await assert.rejects(handleObserve(["follow", "missing-job", "--cwd", h.cwd, ...args]), (error) => {
      assert.match(error.message, new RegExp(`Unknown option ${args[0]}`));
      for (const option of ["--cwd", "--after", "--until", "--max-seconds", "--verbose", "--quiet"]) {
        assert.match(error.message, new RegExp(option));
      }
      return true;
    });
  }

  const accepted = run(process.execPath, [SCRIPT, "observe", "follow", "missing-job", "--cwd", h.cwd,
    "--after", "cursor", "--until", "done", "--max-seconds", "1", "--verbose", "--quiet"], h);
  assert.equal(accepted.status, 1);
  assert.equal(accepted.stderr.trim(), "UNKNOWN_JOB missing-job");
});

test("task --workspace-root passthrough and compact CLI validation/end-to-end", async (t) => {
  isolateTestEnvironment(t);
  const repo = makeTempDir();
  const extraRoot = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  await assert.rejects(
    handleTask(["--cwd", repo, "--executor", "acp", "--executor-command", "fake", "--workspace-root", extraRoot, "hi"]),
    /--workspace-root is only supported for Codex tasks/
  );
  await assert.rejects(
    handleTask(["--cwd", repo, "--workspace-root", "  ", "hi"]),
    /--workspace-root must not be empty/
  );

  // compact validation errors (in-process)
  for (const [args, pattern] of [
    [["--cwd", repo], /Provide a job id or --thread/],
    [["task-1", "--thread", "thr_1", "--cwd", repo], /Choose either a job id or --thread/],
    [["task-1", "--bogus", "--cwd", repo], /Unknown option --bogus/]
  ]) {
    await assert.rejects(handleCompact(args), pattern);
  }

  // compact rejects non-Codex and active Codex jobs (in-process)
  const acpJob = { id: "task-acp", status: "completed", jobClass: "task", executor: "acp", threadId: "acp-1", workspaceRoot: repo };
  const activeJob = { id: "task-busy", status: "running", jobClass: "task", executor: "codex", threadId: "thr_busy", pid: process.pid, workspaceRoot: repo };
  for (const job of [acpJob, activeJob]) {
    writeJobFile(repo, job.id, job);
    upsertJob(repo, job);
  }
  await assert.rejects(handleCompact(["task-acp", "--cwd", repo]), /only supported for Codex threads/);
  await assert.rejects(handleCompact(["task-busy", "--cwd", repo]), /is still running/);

  // end-to-end: task with repeatable --workspace-root -> unsubscribe -> compact by --thread -> resume
  const env = buildEnv(binDir);
  const taskRun = run(process.execPath, [
    SCRIPT, "task", "--cwd", repo, "--workspace-root", ".", "--workspace-root", extraRoot, "--workspace-root", extraRoot, "--json", "cross-repo task"
  ], { cwd: repo, env });
  assert.equal(taskRun.status, 0, taskRun.stderr);
  const taskPayload = JSON.parse(taskRun.stdout);
  const fakeState = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  const resolvedRepo = path.resolve(repo);
  assert.deepEqual(fakeState.lastThreadStart.config, { "features.default_mode_request_user_input": true });
  assert.deepEqual(fakeState.lastThreadStart.runtimeWorkspaceRoots, [resolvedRepo, path.resolve(extraRoot)]);
  assert.deepEqual(fakeState.lastTurnStart.runtimeWorkspaceRoots, [resolvedRepo, path.resolve(extraRoot)]);
  assert.ok(fakeState.unsubscribedThreads.includes(taskPayload.threadId));

  const compacted = run(process.execPath, [SCRIPT, "compact", "--thread", taskPayload.threadId, "--cwd", repo, "--json"], { cwd: repo, env });
  assert.equal(compacted.status, 0, compacted.stderr);
  const compactPayload = JSON.parse(compacted.stdout);
  assert.equal(compactPayload.threadId, taskPayload.threadId);
  assert.equal(compactPayload.compacted, true);
  assert.ok(compactPayload.turnId);

  const resumed = run(process.execPath, [SCRIPT, "task", "--cwd", repo, "--thread", taskPayload.threadId, "--json", "follow up"], { cwd: repo, env });
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).threadId, taskPayload.threadId);
});
