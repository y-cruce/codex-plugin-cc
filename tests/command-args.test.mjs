import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

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
  const rejected = run(process.execPath, [SCRIPT, "events", "--cwd", h.cwd, "--stall-msec", "1", "--exit-idle-ms", "1"], h);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /Unknown option --stall-msec/);
  for (const option of ["--cwd", "--poll-ms", "--stall-ms", "--question-remind-ms", "--exit-idle-ms"]) {
    assert.match(rejected.stderr, new RegExp(option));
  }

  const accepted = run(process.execPath, [SCRIPT, "events", "--cwd", h.cwd, "--poll-ms", "1", "--stall-ms", "1",
    "--question-remind-ms", "1", "--exit-idle-ms", "1"], h);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.stdout, /^IDLE_EXIT /m);
});

test("follow rejects unknown and unused options while preserving its job-id positional", () => {
  const h = setup();
  for (const args of [["--stall-msec", "1"], ["--json"], ["--jsonl"], ["--limit", "1"]]) {
    const rejected = run(process.execPath, [SCRIPT, "observe", "follow", "missing-job", "--cwd", h.cwd, ...args], h);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, new RegExp(`Unknown option ${args[0]}`));
    for (const option of ["--cwd", "--after", "--until", "--max-seconds", "--verbose", "--quiet"]) {
      assert.match(rejected.stderr, new RegExp(option));
    }
  }

  const accepted = run(process.execPath, [SCRIPT, "observe", "follow", "missing-job", "--cwd", h.cwd,
    "--after", "cursor", "--until", "done", "--max-seconds", "1", "--verbose", "--quiet"], h);
  assert.equal(accepted.status, 1);
  assert.equal(accepted.stderr.trim(), "UNKNOWN_JOB missing-job");
});

test("message accepts queue, keeps steer as the default, and rejects queue with interrupt", () => {
  const h = setup();
  const conflicting = run(process.execPath, [SCRIPT, "message", "missing-job", "--queue", "--interrupt", "text"], h);
  assert.notEqual(conflicting.status, 0);
  assert.match(conflicting.stderr, /only one of --queue or --interrupt/);

  for (const args of [["--queue", "text"], ["text"]]) {
    const parsed = run(process.execPath, [SCRIPT, "message", "missing-job", ...args], h);
    assert.notEqual(parsed.status, 0);
    assert.doesNotMatch(parsed.stderr, /Unknown option/);
    assert.match(parsed.stderr, /missing-job|Unknown job/i);
  }
});
