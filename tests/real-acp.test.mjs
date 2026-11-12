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
  const command = process.env.CODEX_DIRECTOR_ANTIGRAVITY_COMMAND ?? path.join(process.env.HOME, ".local/bin/agy");
  const cli = (prompt, extra = []) => run(process.execPath, [SCRIPT, "task", "--cwd", cwd,
    "--executor", "acp", "--executor-command", command, "--executor-args", '["acp"]',
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

test("legacy Antigravity launcher continues without checkout proxy files", {
  skip: process.env.CODEX_REAL_ANTIGRAVITY_LEGACY_TEST !== "1", timeout: 180000
}, (t) => {
  isolateTestEnvironment(t);
  const cwd = fs.realpathSync(makeTempDir("agy-legacy-"));
  const command = path.join(process.env.HOME, ".local/bin/agy_acp_server.par");
  const secret = `LEGACY_MEMORY_${path.basename(cwd)}`;
  const proxy = path.join(ROOT, "plugins/codex/scripts/agy-acp/acp-proxy.mjs");
  assert.equal(fs.existsSync(proxy), false);
  const first = run(process.execPath, [SCRIPT, "task", "--cwd", cwd, "--executor", "acp", "--executor-command", command,
    "--executor-args", "[]", "--executor-permissions", "allow-once", "--executor-model", "claude-opus-5-5",
    "--executor-effort", "medium", "--json",
    `Remember this exact secret in conversation for our next turn: ${secret}. Reply LEGACY_FIRST_OK only. Do not use tools.`],
  { cwd, timeout: 80000 });
  assert.equal(first.status, 0, first.stderr);
  const initial = JSON.parse(first.stdout);
  assert.match(initial.rawOutput, /LEGACY_FIRST_OK/);
  const second = run(process.execPath, [SCRIPT, "task", "--cwd", cwd, "--thread", initial.threadId, "--json",
    "Recall the exact secret I asked you to remember in the previous turn. Reply with that secret and LEGACY_CONTINUE_OK. Do not use tools."],
  { cwd, timeout: 80000 });
  assert.equal(second.status, 0, second.stderr);
  const continued = JSON.parse(second.stdout);
  assert.equal(continued.threadId, initial.threadId);
  assert.ok(continued.rawOutput.includes(secret));
  assert.match(continued.rawOutput, /LEGACY_CONTINUE_OK/);
  const jobs = listJobs(cwd).filter(job => job.threadId === initial.threadId);
  assert.equal(jobs.length, 2);
  assert.ok(jobs.every(job => job.status === "completed" && job.request.executorCommand === command));
  assert.equal(fs.existsSync(proxy), false);
  if (process.env.CODEX_REAL_ACP_EVIDENCE_DIR) {
    fs.mkdirSync(process.env.CODEX_REAL_ACP_EVIDENCE_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.CODEX_REAL_ACP_EVIDENCE_DIR, "legacy-continuation.json"),
      JSON.stringify({ cwd, command, checkoutProxyAbsent: true, initial, continued,
        jobs: jobs.map(job => ({ id: job.id, status: job.status, threadId: job.threadId, command: job.request.executorCommand,
          args: job.request.executorArgs })) }, null, 2));
  }
});
