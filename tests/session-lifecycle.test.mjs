import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { handleSessionStart, handleSessionEnd } from "../plugins/codex/scripts/session-lifecycle-hook.mjs";
import { createJobRecord } from "../plugins/codex/scripts/lib/tracked-jobs.mjs";
import { loadState, updateState } from "../plugins/codex/scripts/lib/state.mjs";
import { isolateTestEnvironment, makeTempDir } from "./helpers.mjs";

test("fork start exports branch ownership; resume end preserves the original jobs", async (t) => {
  isolateTestEnvironment(t);
  const cwd = makeTempDir();
  const previous = process.env.CLAUDE_ENV_FILE;
  try {
    const jobs = [];
    // 2.1.295 directs each SessionStart to the destination session's env file.
    for (const sessionId of ["original", "branch"]) {
      const envFile = path.join(cwd, `${sessionId}.sh`);
      process.env.CLAUDE_ENV_FILE = envFile;
      handleSessionStart({ session_id: sessionId, transcript_path: `/projects/${sessionId}.jsonl` });
      const env = Object.fromEntries([...fs.readFileSync(envFile, "utf8").matchAll(/^export (\w+)='([^']*)'$/gm)]
        .map((match) => [match[1], match[2]]));
      assert.equal(env.CODEX_COMPANION_TRANSCRIPT_PATH, `/projects/${sessionId}.jsonl`);
      assert.equal(env.CLAUDE_PLUGIN_DATA, process.env.CLAUDE_PLUGIN_DATA);
      jobs.push(createJobRecord({ id: sessionId, status: "running" }, { env }));
    }
    assert.deepEqual(jobs.map((job) => job.sessionId), ["original", "branch"]);
    updateState(cwd, (state) => { state.jobs = jobs; });
    await handleSessionEnd({ cwd, session_id: "original", reason: "resume" });
    assert.deepEqual(loadState(cwd).jobs, jobs);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_ENV_FILE;
    else process.env.CLAUDE_ENV_FILE = previous;
  }
});
