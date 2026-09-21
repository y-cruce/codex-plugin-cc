import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveJobHistory } from "../plugins/codex/scripts/lib/history-resolver.mjs";
import { executorKeyFor, threadIndexHash } from "../plugins/codex/scripts/lib/thread-records.mjs";

test("job history resolver keeps the legacy layout", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-history-resolver-"));
  const cwd = fs.mkdtempSync(path.join(root, "workspace-"));
  const stateDir = path.join(root, "state", "workspace");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  for (const jobId of ["task-one", "review-two"]) {
    const location = await resolveJobHistory(cwd, jobId, { stateDir });
    assert.equal(location.layout, "legacy");
    assert.equal(location.recordId, jobId);
    assert.equal(location.roundId, jobId);
    assert.equal(location.jobId, jobId);
    assert.equal(location.directory, path.join(stateDir, "job-history", jobId));
    assert.equal(location.manifest, path.join(location.directory, "manifest.json"));
    assert.equal(location.segments, path.join(location.directory, "segments"));
    assert.equal(location.liveView, path.join(location.directory, "live-view.json"));
    assert.equal(location.roundReceipt, null);
  }
});

test("thread index derivation namespaces ACP sessions by command identity", () => {
  const cwd = "/workspace/project";
  const threadId = "shared-session-id";
  const cases = [
    {
      name: "different ACP commands",
      left: { executor: "acp", command: "/opt/qoder/bin/qoder", args: ["--acp"] },
      right: { executor: "acp", command: "/opt/other/bin/agent", args: ["--acp"] }
    },
    {
      name: "different ACP arguments",
      left: { executor: "acp", command: "/opt/agent", args: ["--profile", "one"] },
      right: { executor: "acp", command: "/opt/agent", args: ["--profile", "two"] }
    }
  ];

  for (const entry of cases) {
    const leftKey = executorKeyFor(entry.left);
    const rightKey = executorKeyFor(entry.right);
    assert.notEqual(leftKey, rightKey, entry.name);
    assert.notEqual(threadIndexHash(cwd, leftKey, threadId), threadIndexHash(cwd, rightKey, threadId), entry.name);
    assert.equal(threadIndexHash(cwd, leftKey, threadId), threadIndexHash(cwd, leftKey, threadId), `${entry.name} is stable`);
  }
  assert.equal(executorKeyFor({ executor: "codex" }), "codex");
});
