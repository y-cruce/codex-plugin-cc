import fs from "node:fs";
import path from "node:path";
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, isolateTestEnvironment, makeTempDir, run } from "./helpers.mjs";
import { loadBrokerSession, saveBrokerSession } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { resolveStateDir } from "../plugins/codex/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "codex-companion.mjs");
const STOP_HOOK = path.join(PLUGIN_ROOT, "scripts", "stop-review-gate-hook.mjs");
const SESSION_HOOK = path.join(PLUGIN_ROOT, "scripts", "session-lifecycle-hook.mjs");

beforeEach(isolateTestEnvironment);

async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 50 } = {}) {
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

test("task --thread rejects conflicting and invalid routing values", () => {
  const repo = makeTempDir();
  initGitRepo(repo);

  for (const conflictingFlag of ["--resume-last", "--resume", "--fresh"]) {
    const result = run("node", [SCRIPT, "task", "--thread", "thr_specific", conflictingFlag, "follow up"], {
      cwd: repo
    });
    assert.equal(result.status > 0, true);
    assert.match(result.stderr, /Choose only one of --thread, --resume\/--resume-last, or --fresh/);
  }

  for (const invalidThreadOption of ["--thread=", "--thread=-bad"]) {
    const result = run("node", [SCRIPT, "task", invalidThreadOption, "follow up"], {
      cwd: repo
    });
    assert.equal(result.status > 0, true);
    assert.match(result.stderr, /Provide a thread id with --thread/);
  }
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

