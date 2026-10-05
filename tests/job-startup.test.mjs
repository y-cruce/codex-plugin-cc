import fs from "node:fs";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";

import { enqueueBackgroundTask } from "../plugins/codex/scripts/codex-companion.mjs";
import { runTrackedJob } from "../plugins/codex/scripts/lib/tracked-jobs.mjs";
import { readStoredJob } from "../plugins/codex/scripts/lib/job-control.mjs";
import { resolveJobFile } from "../plugins/codex/scripts/lib/state.mjs";
import { isolateTestEnvironment, makeTempDir } from "./helpers.mjs";

beforeEach(isolateTestEnvironment);

test("job startup failures preserve the original error and leave no ownerless active file", async (t) => {
  for (const [name, enqueue, failureAt, writeFailure, spawnFailure] of [
    ["enqueue first index", true, 1, false, false],
    ["enqueue worker index", true, 2, false, false],
    ["enqueue first write", true, 0, true, false],
    ["enqueue spawn error", true, 0, false, true],
    ["worker first write", false, 0, true, false],
    ["worker first index", false, 1, false, false]
  ]) {
    const cwd = makeTempDir();
    const job = { id: "startup", workspaceRoot: cwd, title: "Startup test" };
    const jobFile = resolveJobFile(cwd, job.id);
    const original = new Error(name);
    const cleanup = new Error("cleanup index also failed");
    const open = fs.openSync;
    const write = fs.writeFileSync;
    let locks = 0, spawns = 0, terminations = 0, writes = 0;
    t.mock.method(fs, "openSync", (file, ...args) => {
      if (String(file).endsWith("/state.lock") && ++locks >= failureAt && failureAt) {
        throw locks === failureAt ? original : cleanup;
      }
      return open(file, ...args);
    });
    t.mock.method(fs, "writeFileSync", (file, ...args) => {
      if (writeFailure && String(file).startsWith(`${jobFile}.`) && writes++ === 0) throw original;
      return write(file, ...args);
    });
    t.mock.method(childProcess, "spawn", () => {
      spawns++;
      const child = Object.assign(new EventEmitter(), { pid: 2147483647, unref() {} });
      queueMicrotask(() => spawnFailure ? child.emit("error", original) : child.emit("spawn"));
      return child;
    });
    t.mock.method(process, "kill", (pid, signal) => {
      assert.equal(pid, -2147483647);
      assert.equal(signal, "SIGTERM");
      terminations++;
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(async () => enqueue
        ? await enqueueBackgroundTask(cwd, job, {})
        : await runTrackedJob(job, () => assert.fail("runner must not start")), (error) => error === original, name);
      const stored = readStoredJob(cwd, job.id);
      if (stored) {
        assert.equal(stored.status, "failed", name);
        assert.equal(stored.phase, "failed", name);
        assert.equal(stored.pid, null, name);
        assert.equal(stored.errorMessage, original.message, name);
      }
      assert.equal(spawns, enqueue && (failureAt === 2 || spawnFailure) ? 1 : 0, name);
      assert.equal(terminations, spawnFailure ? 0 : spawns, name);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  }
});
