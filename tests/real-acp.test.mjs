import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { resolveLiveViewPath } from "../plugins/codex/scripts/lib/job-event-store.mjs";
import { listJobs } from "../plugins/codex/scripts/lib/state.mjs";
import { initGitRepo, isolateTestEnvironment, makeTempDir, run } from "./helpers.mjs";

const enabled = process.env.CODEX_REAL_ACP_TEST === "1";
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = path.join(ROOT, "plugins/codex/scripts/codex-companion.mjs");
const QODER = "/Users/xingjian.ym/.qoder/entry/qoder";

test("installed Qoder ACP: read-only prompt streams into event history and live view", { skip: !enabled, timeout: 120000 }, (t) => {
  isolateTestEnvironment(t);
  const cwd = fs.realpathSync(makeTempDir("qoder-acp-"));
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "fact.txt"), "verification phrase: QODER_REAL_OK\n");
  run("git", ["add", "fact.txt"], { cwd });
  run("git", ["commit", "-m", "fixture"], { cwd });
  const before = run("git", ["status", "--short"], { cwd }).stdout;
  const result = run(process.execPath, [SCRIPT, "task", "--cwd", cwd, "--executor", "acp", "--executor-command", QODER,
    "--executor-args", JSON.stringify(["--acp"]), "--executor-mode", "dontAsk", "--executor-model", "efficient", "--json",
    "Read fact.txt only. Reply with exactly QODER_REAL_OK and do not modify files or run commands."], { cwd });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).rawOutput, "QODER_REAL_OK");
  assert.equal(run("git", ["status", "--short"], { cwd }).stdout, before);
  const job = listJobs(cwd)[0];
  assert.equal(job.executorModel, "efficient");
  const view = JSON.parse(fs.readFileSync(resolveLiveViewPath(cwd, job.id), "utf8"));
  assert.equal(view.executor.label, "Qoder");
  assert.equal(view.status, "completed");
  assert.equal(view.lastMessage.text, "QODER_REAL_OK");
  assert.equal(view.activeCommands.length, 0);
  assert.equal(view.files.length, 0);
  assert.ok(Number(view.history.committedSeq) > 1);
});
