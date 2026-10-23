import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { directorEvent, eventPaths, reserveDirectorEvents } from "../plugins/codex/scripts/lib/director-delivery.mjs";
import { createCanonicalEvent } from "../plugins/codex/scripts/lib/executor-events.mjs";
import { AcpEventAdapter } from "../plugins/codex/scripts/lib/executors/acp-event-adapter.mjs";
import { normalizeCodexEvent } from "../plugins/codex/scripts/lib/executors/codex-event-adapter.mjs";
import { resolveJobHistory } from "../plugins/codex/scripts/lib/history-resolver.mjs";
import { JobEventStore, readHistory } from "../plugins/codex/scripts/lib/job-event-store.mjs";
import { renderJobEvent } from "../plugins/codex/scripts/lib/job-event-model.mjs";
import { JobRuntime } from "../plugins/codex/scripts/lib/job-runtime.mjs";
import { resultForPersistence } from "../plugins/codex/scripts/lib/persisted-result.mjs";
import { renderStoredJobResult } from "../plugins/codex/scripts/lib/render.mjs";
import { readJobFile, resolveJobFile, resolveStateDir, writeJobFile } from "../plugins/codex/scripts/lib/state.mjs";
import { updateRoundReceipt } from "../plugins/codex/scripts/lib/thread-record-binding.mjs";
import { runTrackedJob } from "../plugins/codex/scripts/lib/tracked-jobs.mjs";
import { isolateTestEnvironment, makeTempDir } from "./helpers.mjs";

test("segments and outbox omit raw and duplicate command text while retaining unknown payloads and live events", async (t) => {
  isolateTestEnvironment(t);
  const cwd = makeTempDir();
  const job = { id: "compact-events", sessionId: "compact-session", workspaceRoot: cwd };
  const output = "unique command output";
  const command = normalizeCodexEvent({ method: "item/completed", params: { item: {
    id: "command", type: "commandExecution", command: "echo output", status: "completed", exitCode: 0, aggregatedOutput: output
  } } }, job);
  const codexUnknown = normalizeCodexEvent({ method: "new/notification", params: { detail: "unknown codex data" } }, job);
  const acpEvents = [];
  const adapter = new AcpEventAdapter((event) => acpEvents.push(event), { job });
  adapter.bindSession("thread");
  const update = { sessionUpdate: "new_update", detail: "unknown acp data" };
  await adapter.accept({ sessionId: "thread", update });
  const events = [command, codexUnknown, ...acpEvents];
  const original = structuredClone(events);
  const committed = [];
  const store = await new JobEventStore(cwd, job.id, { onCommit: (batch) => committed.push(...batch) }).initialize();
  t.after(() => store.close());
  for (const event of events) store.append(event);
  await store.flush();
  const stored = (await readHistory(cwd, job.id)).events;
  for (const event of stored) assert.equal(Object.hasOwn(event.source, "raw"), false);
  assert.deepEqual(stored[0].source, { protocol: "codex-app-server", method: "item/completed" });
  assert.deepEqual(stored[0].payload.output, []);
  assert.equal(stored[0].payload.outputText, output);
  assert.equal(JSON.stringify(stored[0]).split(output).length - 1, 1);
  assert.match(renderJobEvent(stored[0]), /unique command output/);
  assert.deepEqual(stored[1].payload, { method: "new/notification", data: { detail: "unknown codex data" } });
  assert.deepEqual(stored[2].payload, { method: "session/update:new_update", data: update });
  assert.deepEqual(committed[0].source.raw, command.source.raw);
  assert.deepEqual(events, original);
  const stateDir = resolveStateDir(cwd);
  const notification = { ...directorEvent(job, command.type, command.payload, stateDir), source: command.source };
  await reserveDirectorEvents([notification], "test");
  const outbox = JSON.parse(fs.readFileSync(eventPaths(notification).item, "utf8"));
  assert.equal(Object.hasOwn(outbox.source, "raw"), false);
  assert.equal(JSON.stringify(outbox).split(output).length - 1, 1);
  const segment = path.join(store.directory, "segments", store.snapshot.segments[0].file);
  assert.equal(fs.readFileSync(segment, "utf8").includes('"raw":'), false);
});

test("ACP persistence compacts replies and removes reasoning without changing result output or live events", async (t) => {
  isolateTestEnvironment(t);
  const cwd = fs.realpathSync(makeTempDir());
  const job = { id: "task-chunks", executor: "acp", workspaceRoot: cwd, status: "running", pid: process.pid };
  const chunks = Array.from({ length: 3000 }, (_, index) => ({ type: "text", text: `${index % 7}答\n` }));
  const image = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };
  const content = [...chunks, image, { type: "text", text: " tail" }, { type: "text", text: "\n" }];
  const reply = content.filter((block) => block.type === "text").map((block) => block.text).join("");
  const messages = [
    { role: "user", content: [{ type: "text", text: "Brief" }, { type: "text", text: "\n" }], text: "Brief\n" },
    { role: "reasoning", content: Array.from({ length: 12000 }, () => ({ type: "text", text: "think " })), text: "think ".repeat(12000) },
    { role: "assistant", content, text: reply }
  ];
  const terminal = { status: "completed", reason: { code: "end_turn" }, finalMessages: messages };
  const payload = { rawOutput: reply, finalContent: content, reasoningSummary: [messages[1].text] };
  const execution = { terminal, payload, rendered: `${reply}\n`, executor: "acp", sessionId: "thread", threadId: "thread", turnId: "turn", exitStatus: 0 };
  const original = structuredClone(execution);
  writeJobFile(cwd, job.id, job);
  const runtime = new JobRuntime({ threadRecords: true, historySweepMs: 0, executorIdentity: { kind: "acp", command: "qoder", args: [] } });
  t.after(() => runtime.close());
  const owner = {};
  await runtime.register(owner, cwd, job.id);
  await runtime.bind(owner, cwd, job.id, "thread", "turn");
  await runtime.record(createCanonicalEvent({ job, type: "turn.completed", identity: { sessionId: "thread", turnId: "turn" },
    payload: { ...terminal, usage: null }, source: { protocol: "acp", method: "session/prompt", raw: null } }));
  await runTrackedJob(job, async () => execution);
  await runtime.finish(cwd, job.id);

  const file = resolveJobFile(cwd, job.id);
  const stored = readJobFile(file);
  assert.equal(fs.readFileSync(file, "utf8"), `${JSON.stringify(stored)}\n`);
  assert.equal("reasoningSummary" in stored.result, false);
  assert.deepEqual(stored.result.terminal.finalMessages.map((message) => message.role), ["user", "assistant"]);
  assert.deepEqual(stored.result.finalContent, [{ type: "text", text: chunks.map((block) => block.text).join("") }, image, { type: "text", text: " tail\n" }]);
  assert.deepEqual(stored.result.terminal.finalMessages[1].content, stored.result.finalContent);
  assert.deepEqual(stored.result.terminal.finalMessages[0].content, [{ type: "text", text: "Brief\n" }]);
  assert.equal(stored.result.finalContent.filter((block) => block.type === "text").map((block) => block.text).join(""), reply);
  assert.equal(renderStoredJobResult(job, stored), renderStoredJobResult(job, { ...stored, result: { ...payload, terminal } }));
  assert.deepEqual(execution, original);

  const location = await resolveJobHistory(cwd, job.id);
  // Receipts can also receive an unslimmed live result, before the job is stored.
  await updateRoundReceipt(location, { jobId: job.id, result: { ...payload, terminal } }, { ...stored, result: { ...payload, terminal } });
  const receiptText = fs.readFileSync(location.roundReceipt, "utf8");
  const receipt = JSON.parse(receiptText);
  assert.equal(receiptText, `${JSON.stringify(receipt)}\n`);
  assert.deepEqual(receipt.result, stored.result);
  assert.deepEqual(receipt.job.result, stored.result);
  const history = await readHistory(cwd, job.id);
  assert.deepEqual(history.events.find((event) => event.type === "turn.completed").payload.finalMessages, messages);
  assert.deepEqual(history.events.find((event) => event.type === "job.completed").payload.result, stored.result);
  assert.deepEqual(resultForPersistence({ codex: { stdout: reply, reasoning: ["review reasoning"] } }), { codex: { stdout: reply } });
});

test("completion notification fallback uses only the last assistant reply or raw output", () => {
  const job = { id: "task", sessionId: "session", workspaceRoot: "/repo", status: "completed" };
  const reply = "Final reply\n第二行";
  const messages = [{ role: "user", text: "Brief" }, { role: "assistant", text: "Earlier reply" },
    { role: "reasoning", text: "Internal reasoning" }, { role: "assistant", text: reply }, { role: "reasoning", text: "Later thought" }];
  for (const result of [{ terminal: { finalMessages: messages } }, { rawOutput: reply },
    { rawOutput: reply, terminal: { finalMessages: [{ role: "reasoning", text: "Internal reasoning" }] } }]) {
    assert.equal(directorEvent({ ...job, result }, "job.completed", {}, "/tmp/state/repo").text, `job=task · job.completed: ${reply}`);
  }
});
