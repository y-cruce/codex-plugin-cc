import fs from "node:fs";
import path from "node:path";
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { BROKER_READY_MS, initGitRepo, isolateTestEnvironment, makeTempDir, run, writeExecutable } from "./helpers.mjs";
import { loadBrokerSession, saveBrokerSession } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { listJobs, readJobFile, resolveJobFile, resolveStateDir, upsertJob, writeJobFile } from "../plugins/codex/scripts/lib/state.mjs";
import { jobIndexPath, threadRecordPaths } from "../plugins/codex/scripts/lib/thread-records.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "codex-companion.mjs");
const STOP_HOOK = path.join(PLUGIN_ROOT, "scripts", "stop-review-gate-hook.mjs");
const SESSION_HOOK = path.join(PLUGIN_ROOT, "scripts", "session-lifecycle-hook.mjs");

beforeEach(isolateTestEnvironment);

async function waitFor(predicate, { timeoutMs = BROKER_READY_MS, intervalMs = 50 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition.");
}

function seedFakeCodexThread(binDir, repo, threadId) {
  fs.writeFileSync(
    path.join(binDir, "fake-codex-state.json"),
    `${JSON.stringify(
      {
        nextThreadId: 2,
        nextTurnId: 1,
        appServerStarts: 0,
        threads: [
          {
            id: threadId,
            cwd: repo,
            name: null,
            preview: "",
            ephemeral: false,
            createdAt: 1,
            updatedAt: 1
          }
        ],
        capabilities: null,
        lastInterrupt: null
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

function resolveStateDirWithPluginData(repo, pluginDataDir) {
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  try {
    return resolveStateDir(repo);
  } finally {
    if (previousPluginDataDir === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
}

function seedTrackedThread(repo, pluginDataDir, threadId, sessionId = "sess-other") {
  const stateDir = resolveStateDirWithPluginData(repo, pluginDataDir);
  fs.mkdirSync(path.join(stateDir, "jobs"), { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-tracked",
            status: "completed",
            title: "Codex Task",
            jobClass: "task",
            sessionId,
            threadId,
            summary: "Tracked task",
            updatedAt: "2026-09-03T00:00:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

test("task --resume-last resumes the latest persisted task thread", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const firstRun = run("node", [SCRIPT, "task", "initial task"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(firstRun.status, 0, firstRun.stderr);

  const result = run("node", [SCRIPT, "task", "--resume-last", "follow up"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Resumed the prior run.\nFollow-up prompt accepted.\n");
});

test("task --thread resumes a thread tracked in the current workspace across Claude sessions", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const threadId = "thr_specific";
  const statePath = path.join(binDir, "fake-codex-state.json");
  const pluginDataDir = makeTempDir();
  const env = {
    ...buildEnv(binDir),
    CLAUDE_PLUGIN_DATA: pluginDataDir,
    CODEX_COMPANION_SESSION_ID: "sess-current"
  };
  installFakeCodex(binDir);
  seedFakeCodexThread(binDir, repo, threadId);
  seedTrackedThread(repo, pluginDataDir, threadId);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "--thread", threadId, "follow up by id"], {
    cwd: repo,
    env
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.threadId, threadId);
  assert.equal(fakeState.lastTurnStart.prompt, "follow up by id");
});

test("task --fork-thread forks into an independent thread and leaves the source untouched", () => {
  const repo = fs.realpathSync(makeTempDir());
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  const pluginDataDir = makeTempDir();
  const env = {
    ...buildEnv(binDir),
    CLAUDE_PLUGIN_DATA: pluginDataDir,
    CODEX_COMPANION_SESSION_ID: "sess-fork"
  };
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const sourceRun = run("node", [SCRIPT, "task", "--label", "source investigation", "--effort", "high", "--json", "investigate source"], {
    cwd: repo,
    env
  });
  assert.equal(sourceRun.status, 0, sourceRun.stderr);
  const sourcePayload = JSON.parse(sourceRun.stdout);
  const stateDir = resolveStateDirWithPluginData(repo, pluginDataDir);
  const findJobByThread = (threadId) =>
    JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8")).jobs.find((job) => job.threadId === threadId);
  const sourceJobSummary = findJobByThread(sourcePayload.threadId);
  assert.ok(sourceJobSummary);
  const sourceJobPath = path.join(stateDir, "jobs", `${sourceJobSummary.id}.json`);
  const sourceJobRaw = fs.readFileSync(sourceJobPath, "utf8");
  const sourceIndex = JSON.parse(fs.readFileSync(jobIndexPath(stateDir, sourceJobSummary.id), "utf8"));
  const sourceRecord = threadRecordPaths(stateDir, sourceIndex.recordId);
  const sourceLiveViewRaw = fs.readFileSync(sourceRecord.liveView, "utf8");
  const sourceRounds = fs.readdirSync(sourceRecord.rounds).sort();
  const sourceSegments = fs.readdirSync(sourceRecord.segments).sort().map((file) => [
    file,
    fs.readFileSync(path.join(sourceRecord.segments, file), "utf8")
  ]);

  const forkRun = run("node", [SCRIPT, "task", "--fork-thread", sourcePayload.threadId, "--label", "forked branch", "--json", "implement forked branch"], {
    cwd: repo,
    env
  });
  assert.equal(forkRun.status, 0, forkRun.stderr);
  const forkPayload = JSON.parse(forkRun.stdout);
  assert.notEqual(forkPayload.threadId, sourcePayload.threadId);

  const fakeAfterFork = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeAfterFork.lastThreadFork.threadId, sourcePayload.threadId);
  assert.equal(fakeAfterFork.lastThreadFork.forkedThreadId, forkPayload.threadId);
  assert.equal(fakeAfterFork.lastThreadFork.excludeTurns, true);
  assert.equal(fakeAfterFork.threads.find((thread) => thread.id === forkPayload.threadId)?.name, "Codex Companion Task: forked branch");
  assert.equal(fakeAfterFork.lastTurnStart.effort, "high");

  const forkJobSummary = findJobByThread(forkPayload.threadId);
  assert.ok(forkJobSummary);
  const forkJob = JSON.parse(fs.readFileSync(path.join(stateDir, "jobs", `${forkJobSummary.id}.json`), "utf8"));
  assert.deepEqual(forkJob.forkedFrom, { threadId: sourcePayload.threadId, jobId: sourceJobSummary.id });
  const forkIndex = JSON.parse(fs.readFileSync(jobIndexPath(stateDir, forkJobSummary.id), "utf8"));
  assert.notEqual(forkIndex.recordId, sourceIndex.recordId);

  const continueFork = run("node", [SCRIPT, "task", "--thread", forkPayload.threadId, "--json", "follow up forked branch"], {
    cwd: repo,
    env
  });
  assert.equal(continueFork.status, 0, continueFork.stderr);
  const continuePayload = JSON.parse(continueFork.stdout);
  assert.equal(continuePayload.threadId, forkPayload.threadId);
  assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).lastTurnStart.threadId, forkPayload.threadId);

  assert.equal(fs.readFileSync(sourceJobPath, "utf8"), sourceJobRaw);
  assert.equal(fs.readFileSync(sourceRecord.liveView, "utf8"), sourceLiveViewRaw);
  assert.deepEqual(fs.readdirSync(sourceRecord.rounds).sort(), sourceRounds);
  assert.deepEqual(
    fs.readdirSync(sourceRecord.segments).sort().map((file) => [file, fs.readFileSync(path.join(sourceRecord.segments, file), "utf8")]),
    sourceSegments
  );
});

test("task --thread and --fork-thread reject conflicting, invalid, and busy-source routing values", () => {
  const repo = fs.realpathSync(makeTempDir());
  const otherRepo = fs.realpathSync(makeTempDir());
  initGitRepo(repo);
  initGitRepo(otherRepo);

  for (const args of [
    ["--thread", "thr_specific", "--resume-last"],
    ["--thread", "thr_specific", "--resume"],
    ["--thread", "thr_specific", "--fresh"],
    ["--fork-thread", "thr_specific", "--thread", "thr_other"],
    ["--fork-thread", "thr_specific", "--resume-last"],
    ["--fork-thread", "thr_specific", "--resume"],
    ["--fork-thread", "thr_specific", "--fresh"]
  ]) {
    const result = run("node", [SCRIPT, "task", ...args, "follow up"], {
      cwd: repo
    });
    assert.equal(result.status > 0, true, args.join(" "));
    assert.match(result.stderr, /Choose only one of --thread, --fork-thread, --resume\/--resume-last, or --fresh/);
  }

  for (const [invalidOption, pattern] of [
    ["--thread=", /Provide a thread id with --thread/],
    ["--thread=-bad", /Provide a thread id with --thread/],
    ["--fork-thread=", /Provide a thread id with --fork-thread/],
    ["--fork-thread=-bad", /Provide a thread id with --fork-thread/]
  ]) {
    const result = run("node", [SCRIPT, "task", invalidOption, "follow up"], {
      cwd: repo
    });
    assert.equal(result.status > 0, true, invalidOption);
    assert.match(result.stderr, pattern);
  }

  for (const status of ["running", "queued"]) {
    const pluginDataDir = makeTempDir();
    const env = { ...process.env, CLAUDE_PLUGIN_DATA: pluginDataDir };
    const previousData = process.env.CLAUDE_PLUGIN_DATA;
    process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
    try {
      const activeJob = {
        id: `job-active-${status}`,
        status,
        title: "Codex Task",
        jobClass: "task",
        workspaceRoot: repo,
        threadId: "thr_busy",
        pid: process.pid,
        createdAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      writeJobFile(repo, activeJob.id, activeJob);
      upsertJob(repo, activeJob);
    } finally {
      process.env.CLAUDE_PLUGIN_DATA = previousData;
    }

    const busyResult = run("node", [SCRIPT, "task", "--fork-thread", "thr_busy", "--background", "branch while busy"], {
      cwd: repo,
      env
    });
    assert.equal(busyResult.status > 0, true, status);
    assert.match(busyResult.stderr, new RegExp(`Thread thr_busy is still ${status} \\(job-active-${status}\\)`));
    const stateDir = resolveStateDirWithPluginData(repo, pluginDataDir);
    assert.deepEqual(fs.readdirSync(path.join(stateDir, "jobs")), [`job-active-${status}.json`]);
  }

  const wrongCwdData = makeTempDir();
  seedTrackedThread(repo, wrongCwdData, "thr_repo_only");
  const wrongCwd = run("node", [SCRIPT, "task", "--fork-thread", "thr_repo_only", "branch from wrong cwd"], {
    cwd: otherRepo,
    env: { ...process.env, CLAUDE_PLUGIN_DATA: wrongCwdData }
  });
  assert.equal(wrongCwd.status > 0, true);
  assert.match(wrongCwd.stderr, /is not tracked for this repository/);
});

test("task --thread --allow-other-repo resumes an untracked thread", () => {
  const repo = makeTempDir();
  const otherRepo = makeTempDir();
  const binDir = makeTempDir();
  const threadId = "thr_other_repo";
  const statePath = path.join(binDir, "fake-codex-state.json");
  const pluginDataDir = makeTempDir();
  const env = {
    ...buildEnv(binDir),
    CLAUDE_PLUGIN_DATA: pluginDataDir
  };
  installFakeCodex(binDir);
  seedFakeCodexThread(binDir, otherRepo, threadId);
  initGitRepo(repo);

  const result = run(
    "node",
    [SCRIPT, "task", "--thread", threadId, "--allow-other-repo", "cross-repo follow up"],
    {
      cwd: repo,
      env
    }
  );

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.threadId, threadId);
  assert.equal(fakeState.lastTurnStart.prompt, "cross-repo follow up");
});

test("task-resume-candidate returns the latest rescue thread from the current session", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-current",
            status: "completed",
            title: "Codex Task",
            jobClass: "task",
            sessionId: "sess-current",
            threadId: "thr_current",
            summary: "Investigate the flaky test",
            updatedAt: "2026-03-24T20:00:00.000Z"
          },
          {
            id: "task-other-session",
            status: "completed",
            title: "Codex Task",
            jobClass: "task",
            sessionId: "sess-other",
            threadId: "thr_other",
            summary: "Old rescue run",
            updatedAt: "2026-03-24T20:05:00.000Z"
          },
          {
            id: "review-current",
            status: "completed",
            title: "Codex Review",
            jobClass: "review",
            sessionId: "sess-current",
            threadId: "thr_review",
            summary: "Review main...HEAD",
            updatedAt: "2026-03-24T20:10:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "task-resume-candidate", "--json"], {
    cwd: workspace,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.available, true);
  assert.equal(payload.sessionId, "sess-current");
  assert.equal(payload.candidate.id, "task-current");
  assert.equal(payload.candidate.threadId, "thr_current");
});

test("session start hook exports the Claude session id, transcript path, and plugin data dir", () => {
  const repo = makeTempDir();
  const envFile = path.join(makeTempDir(), "claude-env.sh");
  fs.writeFileSync(envFile, "", "utf8");
  const pluginDataDir = makeTempDir();
  const transcriptPath = path.join(repo, "session.jsonl");

  const result = run("node", [SESSION_HOOK, "SessionStart"], {
    cwd: repo,
    env: {
      ...process.env,
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PLUGIN_DATA: pluginDataDir
    },
    input: JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: "sess-current",
      transcript_path: transcriptPath,
      cwd: repo
    })
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    fs.readFileSync(envFile, "utf8"),
    `export CODEX_COMPANION_SESSION_ID='sess-current'\nexport CODEX_COMPANION_TRANSCRIPT_PATH='${transcriptPath}'\nexport CLAUDE_PLUGIN_DATA='${pluginDataDir}'\n`
  );
});



test("a capability check in a subdirectory is not reused for the workspace root", { skip: process.platform === "win32" }, () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  const cwd = path.join(repo, "sub");
  fs.mkdirSync(path.join(cwd, "bin"), { recursive: true });
  fs.mkdirSync(path.join(repo, "bin"));
  writeExecutable(path.join(cwd, "bin", "codex"), '#!/bin/sh\nprintf "sub runtime available\n"\n');
  writeExecutable(path.join(repo, "bin", "codex"), '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "old root runtime\n"; exit 0; fi\nexit 77\n');
  const result = run(process.execPath, [SCRIPT, "task", "--cwd", cwd, "--json", "basic"], {
    cwd, env: { ...process.env, PATH: `bin${path.delimiter}${process.env.PATH}`,
      CODEX_COMPANION_APP_SERVER_ENDPOINT: `unix:${path.join(makeTempDir("cx-unused-"), "broker.sock")}` }
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Codex CLI is not installed or is missing required runtime support/);
});
