import test from "node:test";
import assert from "node:assert/strict";
import { activityState, activityKey, activityRequests, activityText, activityNotes, finishActivity } from "../plugins/codex/hooks/task-pane/activity.ts";

const began = Date.parse("2026-11-03T00:00:00Z");
const view = (id = "a") => ({ recordId: `record-${id}`, jobId: `job-${id}`, activeRoundId: `job-${id}`,
  status: "running", label: `Task ${id}`, startedAt: new Date(began).toISOString(), tail: [], activeCommands: [],
  lastMessage: { kind: "assistant", text: "正在核对通知路由", at: "" }, pendingQuestion: null });

test("each running thread schedules independently without a panel cap or overlapping requests", () => {
  const state = activityState();
  assert.equal(activityKey({ ...view(), recordId: undefined, threadId: "executor-id" }), "job-a");
  const views = Array.from({ length: 7 }, (_, at) => view(String(at)));
  assert.equal(activityRequests(state, views, began + 119999).length, 0);
  const requests = activityRequests(state, views, began + 120000);
  assert.equal(requests.length, 7);
  assert.equal(activityRequests(state, views, began + 240000).length, 0);
  for (const request of requests) finishActivity(state, request, began + 122000);
  assert.equal(activityRequests(state, views, began + 242000).length, 0, "unchanged notes do not trigger paid calls");
  views[0].lastMessage.text = "正在修复通知去重条件";
  const next = activityRequests(state, views, began + 362000);
  assert.equal(next.length, 1);
  next[0].entry.text = "正在修复通知去重";
  finishActivity(state, next[0], began + 364000);
  const restored = activityState(JSON.parse(JSON.stringify(Object.fromEntries(state.entries))));
  assert.equal(activityText(restored, views[0]), "正在修复通知去重");
  for (const changed of [{ status: "completed", activeRoundId: null }, { activeRoundId: "next-round" },
    { status: "waiting-for-answer" }, { pendingQuestion: { text: "Which?" } }]) {
    assert.equal(activityText(restored, { ...views[0], ...changed }), undefined);
  }
});

test("activity notes keep bounded current actions and exclude output, raw thinking and command arguments", () => {
  const data = view();
  data.rounds = [{ jobId: "job-a", firstSeq: "3", startedAt: data.startedAt }];
  data.tail = [
    { seq: "1", type: "message.completed", text: "old-round-sentinel" },
    { seq: "3", type: "reasoning.text.delta", text: "raw-thinking-sentinel" },
    { seq: "4", type: "command.output.delta", text: "output-sentinel" },
    { seq: "5", type: "command.started", text: "$ /usr/bin/curl --data argument-sentinel" },
    { seq: "6", type: "tool.started", text: "Read activity.ts" },
  ];
  data.activeCommands = [{ command: "node --eval argument-sentinel" }];
  data.plan = { entries: [{ status: "in_progress", content: "核对退出条件" }] };
  const notes = activityNotes(data);
  assert.match(notes, /curl/);
  assert.match(notes, /Read activity.ts/);
  assert.match(notes, /核对退出条件/);
  assert.doesNotMatch(notes, /sentinel/);
  data.lastMessage.text = "中".repeat(10000);
  assert.ok([...activityNotes(data)].length < 4500);
  assert.equal(activityNotes({ ...view(), lastMessage: null }), "");
});
