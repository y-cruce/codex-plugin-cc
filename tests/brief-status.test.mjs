import test from "node:test";
import assert from "node:assert/strict";

import { renderBriefJobStatus, renderBriefStatusReport } from "../plugins/codex/scripts/lib/render.mjs";

const running = { id: "task-a", label: "fix retry", status: "running", kindLabel: "task", phase: "running", elapsed: "21m",
  progressAgeMinutes: 2, progressPreview: ["one", "two", "three", "x".repeat(400)],
  live: { questions: [{ requestId: "7", questions: [{ id: "source", question: "Which wins?",
    options: [{ label: "Env (Recommended)", description: "Matches prod" }, { label: "Config" }] }] }],
  notifications: [{ id: "n", message: "Blocked on creds" }], pendingMessages: [], interrupting: false } };
const finished = (n, extra = {}) => ({ id: `task-${n}`, status: "completed", kindLabel: "task", duration: "3m", ...extra });

test("the brief listing has one line per active job and the last five finished jobs of this session", () => {
  const text = renderBriefStatusReport({ workspaceRoot: "/r", config: { big: true }, sessionRuntime: { label: "x" },
    threads: [running, ...[1, 2, 3, 4, 5, 6, 7].map((n) => finished(n)), finished(8, { otherSession: true })] });
  assert.equal(text, [
    "Active:",
    "- task-a [fix retry] running · task · 21m · last progress 2m ago · waiting for answer request=7 · 1 undelivered note(s)",
    "Recently finished:",
    ...[1, 2, 3, 4, 5].map((n) => `- task-${n} completed · task · 3m`),
    "(2 older finished job(s) not shown)",
    ""
  ].join("\n"));
  assert.doesNotMatch(text, /config|workspaceRoot|task-8/);
});

test("the brief job status carries what the director can act on and clips the rest", () => {
  const text = renderBriefJobStatus(running);
  const lines = text.trimEnd().split("\n");
  assert.equal(lines[1], "QUESTION request=7 ids=source Which wins? Options: Env (Recommended) (Matches prod); Config.");
  assert.equal(lines[2], "Note: Blocked on creds");
  assert.deepEqual(lines.slice(3, 5), ["Recent:", "  two"]);
  assert.ok(lines[6].length <= 162 && lines[6].endsWith("…"));
  assert.match(renderBriefJobStatus(finished(1, { errorMessage: "boom" })), /^task-1 completed · task · 3m · error: boom\nOutput: result task-1\n$/);
});
