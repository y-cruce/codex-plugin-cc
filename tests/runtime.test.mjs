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

test("test environment excludes inherited live broker and session state", () => {
  const inheritedData = makeTempDir();
  const result = run(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { isolateTestEnvironment } from ${JSON.stringify(new URL("./helpers.mjs", import.meta.url).href)};
    const inheritedData = process.env.CLAUDE_PLUGIN_DATA;
    let cleanup;
    isolateTestEnvironment({ after(fn) { cleanup = fn; } });
    assert.notEqual(process.env.CLAUDE_PLUGIN_DATA, inheritedData);
    assert.equal(Object.keys(process.env).some((key) => key.startsWith("CODEX_COMPANION_")), false);
    assert.equal(process.env.CLAUDE_ENV_FILE, undefined);
    await cleanup();
  `], { env: {
    ...process.env,
    CLAUDE_PLUGIN_DATA: inheritedData,
    CLAUDE_ENV_FILE: path.join(inheritedData, "session.env"),
    CODEX_COMPANION_APP_SERVER_ENDPOINT: `unix:${path.join(inheritedData, "live.sock")}`,
    CODEX_COMPANION_APP_SERVER_PID_FILE: path.join(inheritedData, "live.pid"),
    CODEX_COMPANION_APP_SERVER_LOG_FILE: path.join(inheritedData, "live.log"),
    CODEX_COMPANION_SESSION_ID: "live-session",
    CODEX_COMPANION_JOB_ID: "live-job"
  } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readdirSync(inheritedData), []);
});

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

test("setup is ready without npm when Codex is already installed and authenticated", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  fs.symlinkSync(process.execPath, path.join(binDir, "node"));

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PATH: binDir
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.npm.available, false);
  assert.equal(payload.codex.available, true);
  assert.equal(payload.auth.loggedIn, true);
});

test("setup is ready when the active provider does not require OpenAI login", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir, "provider-no-auth");

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.auth.loggedIn, true);
  assert.equal(payload.auth.authMethod, null);
  assert.equal(payload.auth.source, "app-server");
  assert.match(payload.auth.detail, /configured and does not require OpenAI authentication/i);
});

test("task runs without auth preflight so Codex can refresh an expired session", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "refreshable-auth");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "check refreshable auth"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Handled the requested task/);
});

test("adversarial review renders structured findings over app-server turn/start", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0];\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0].id;\n");

  const result = run("node", [SCRIPT, "adversarial-review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Missing empty-state guard/);
});
