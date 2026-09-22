import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { listJobs } from "../plugins/codex/scripts/lib/state.mjs";
import { initGitRepo, isolateTestEnvironment, makeTempDir, run } from "./helpers.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const AGENT = path.join(ROOT, "tests/fake-acp-agent.mjs");
const SCRIPT = path.join(ROOT, "plugins/codex/scripts/codex-companion.mjs");

test("companion selects the ACP executor without changing the Codex default", (t) => {
  isolateTestEnvironment(t);
  const cwd = fs.realpathSync(makeTempDir());
  initGitRepo(cwd);
  const result = run(process.execPath, [SCRIPT, "task", "--cwd", cwd, "--executor", "acp", "--executor-command", process.execPath,
    "--executor-args", JSON.stringify([AGENT]), "--json", "basic"], { cwd });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.executor, "acp");
  assert.equal(payload.rawOutput, "Basic complete");
  const job = listJobs(cwd)[0];
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
