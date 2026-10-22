import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { sendLiveCommand } from "../plugins/codex/scripts/lib/live-commands.mjs";
import { ObservationClient } from "../plugins/codex/scripts/lib/observation-client.mjs";
import { upsertJob, writeJobFile } from "../plugins/codex/scripts/lib/state.mjs";
import { isolateTestEnvironment, makeTempDir } from "./helpers.mjs";

function setup(t, snapshot) {
  isolateTestEnvironment(t);
  const cwd = makeTempDir();
  const job = { id: "acp-answers", jobClass: "task", status: "running", executor: "acp",
    executorSessionId: "session-1", turnId: "turn-1", workspaceRoot: cwd };
  writeJobFile(cwd, job.id, job);
  upsertJob(cwd, job);
  const requests = [];
  t.mock.method(ObservationClient, "connect", async () => ({
    request: async (method, params) => {
      requests.push({ method, params });
      return method === "executor/status" ? snapshot : { answered: true };
    },
    close() {}
  }));
  return { cwd, job, requests };
}

test("permission answers accept offered values or a unique exact label", async (t) => {
  const options = [
    { value: "proceed_once", label: "Allow" },
    { value: "cancel", label: "Reject" },
    { value: "duplicate-1", label: "Duplicate" },
    { value: "duplicate-2", label: "Duplicate" }
  ];
  const h = setup(t, { questions: [{ requestId: "permission:1", turnId: "question-turn", kind: "permission",
    questions: [{ id: "optionId", options }] }] });
  const answersFile = path.join(h.cwd, "answers.json");
  for (const [answers, expected] of [
    [["Allow"], "proceed_once"], [["proceed_once"], "proceed_once"], [["Reject"], "cancel"],
    [["Duplicate"], null], [["allow"], null], [["unknown"], null], [["Allow", "Reject"], null], [[], null]
  ]) {
    h.requests.length = 0;
    fs.writeFileSync(answersFile, JSON.stringify({ optionId: { answers } }));
    const result = sendLiveCommand(h.cwd, h.job.id, "answer", { "request-id": "permission:1", "answers-file": answersFile });
    if (expected === null) {
      await assert.rejects(result, /exactly one offered option/i, JSON.stringify(answers));
      assert.deepEqual(h.requests.map((request) => request.method), ["executor/status"]);
    } else {
      await result;
      assert.deepEqual(h.requests.at(-1), { method: "executor/answer-permission", params: {
        jobId: h.job.id, executorSessionId: "session-1", turnId: "question-turn", requestId: "permission:1",
        outcome: "selected", optionId: expected
      } }, JSON.stringify(answers));
    }
  }
});

test("unsupported mid-turn steering suggests queue before interrupt", async (t) => {
  const h = setup(t, { capabilities: { midTurnSteer: false } });
  await assert.rejects(sendLiveCommand(h.cwd, h.job.id, "message", {}, "more context"),
    /cannot add a message to the active turn.*--queue.*--interrupt/i);
  assert.deepEqual(h.requests.map((request) => request.method), ["executor/status"]);
});
