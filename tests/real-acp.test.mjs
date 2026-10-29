import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { resolveJobHistory } from "../plugins/codex/scripts/lib/history-resolver.mjs";
import { listJobs } from "../plugins/codex/scripts/lib/state.mjs";
import { initGitRepo, isolateTestEnvironment, makeTempDir, run } from "./helpers.mjs";

const enabled = process.env.CODEX_REAL_ACP_TEST === "1";
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = path.join(ROOT, "plugins/codex/scripts/codex-companion.mjs");
const QODER = "/Users/xingjian.ym/.qoder/entry/qoder";

test("installed Qoder ACP: read-only prompt streams into event history and live view", { skip: !enabled, timeout: 120000 }, async (t) => {
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
  const view = JSON.parse(fs.readFileSync((await resolveJobHistory(cwd, job.id)).liveView, "utf8"));
  assert.equal(view.executor.label, "Qoder");
  assert.equal(view.status, "completed");
  assert.equal(view.lastMessage.text, "QODER_REAL_OK");
  assert.equal(view.activeCommands.length, 0);
  assert.equal(view.files.length, 0);
  assert.ok(Number(view.history.committedSeq) > 1);
});

test("official Antigravity ACP reads a file and resumes its context in a new process", {
  skip: process.env.CODEX_REAL_ANTIGRAVITY_TEST !== "1", timeout: 180000
}, async (t) => {
  isolateTestEnvironment(t);
  const cwd = fs.realpathSync(makeTempDir("antigravity-acp-"));
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "fact.txt"), "verification phrase: ANTIGRAVITY_ACP_OK\n");
  run("git", ["add", "fact.txt"], { cwd });
  run("git", ["commit", "-m", "fixture"], { cwd });
  // The official runtime creates skills/system/run-workflow before any prompt.
  const before = run("git", ["status", "--short", "--untracked-files=no"], { cwd }).stdout;
  const command = process.env.CODEX_DIRECTOR_ANTIGRAVITY_COMMAND ?? "agy_acp_server.par";
  const cli = (prompt, extra = []) => run(process.execPath, [SCRIPT, "task", "--cwd", cwd,
    "--executor", "acp", "--executor-command", command, "--executor-args", "[]",
    "--executor-permissions", "allow-once", "--json", ...extra, prompt], { cwd, timeout: 80000 });
  const first = cli("Read fact.txt only. Reply with exactly the verification phrase. Do not modify files or run commands.");
  assert.equal(first.status, 0, first.stderr);
  const result = JSON.parse(first.stdout);
  assert.equal(result.rawOutput.trim(), "ANTIGRAVITY_ACP_OK");
  const second = cli("Reply with exactly the verification phrase from our previous turn, using your conversation context. Do not read files or run tools.",
    ["--thread", result.threadId]);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).rawOutput.trim(), "ANTIGRAVITY_ACP_OK");
  assert.equal(JSON.parse(second.stdout).threadId, result.threadId);
  assert.equal(run("git", ["status", "--short", "--untracked-files=no"], { cwd }).stdout, before);
  const job = listJobs(cwd)[0];
  const view = JSON.parse(fs.readFileSync((await resolveJobHistory(cwd, job.id)).liveView, "utf8"));
  assert.equal(view.executor.label, "Antigravity");
  assert.equal(view.status, "completed");
  assert.equal(view.lastMessage.text.trim(), "ANTIGRAVITY_ACP_OK");
});
