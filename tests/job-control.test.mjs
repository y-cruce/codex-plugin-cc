import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";

import { resolveResultJob } from "../plugins/codex/scripts/lib/job-control.mjs";
import { upsertJob } from "../plugins/codex/scripts/lib/state.mjs";
import { initGitRepo, isolateTestEnvironment, makeTempDir } from "./helpers.mjs";

beforeEach(isolateTestEnvironment);

function workspaceWithJobs(jobs) {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  for (const job of jobs) upsertJob(cwd, job);
  return cwd;
}

test("result reports an exact running job as still running", () => {
  const cwd = workspaceWithJobs([{ id: "task-running", status: "running" }]);

  assert.throws(
    () => resolveResultJob(cwd, "task-running"),
    /Job task-running is still running\. Check \/codex:status and try again once it finishes\./
  );
});

test("result still reports a missing job as not found", () => {
  const cwd = workspaceWithJobs([]);

  assert.throws(() => resolveResultJob(cwd, "task-missing"), /No (?:finished )?job found for "task-missing"/);
});

test("result still rejects an ambiguous job reference", () => {
  const cwd = workspaceWithJobs([
    { id: "task-shared-one", status: "completed" },
    { id: "task-shared-two", status: "completed" }
  ]);

  assert.throws(() => resolveResultJob(cwd, "task-shared"), /Job reference "task-shared" is ambiguous/);
});
