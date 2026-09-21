import test from "node:test";
import assert from "node:assert/strict";

import { LiveTurnControl } from "../plugins/codex/scripts/lib/live-turn-control.mjs";

function harness() {
  const notifications = [];
  let control;
  let interruptedCompletion = null;
  const client = {
    cwd: process.cwd(),
    exitPromise: new Promise(() => {}),
    async request(method, params) {
      if (method === "turn/interrupt") {
        queueMicrotask(() => {
          interruptedCompletion = { threadId: params.threadId, turn: { id: params.turnId, status: "interrupted" } };
          control.observe({ method: "turn/completed", params: interruptedCompletion });
        });
      }
      return {};
    }
  };
  control = new LiveTurnControl(client, (message) => notifications.push(message));
  const start = (turnId) => control.observe({ method: "turn/started", params: { threadId: "thread-1", turn: { id: turnId } } });
  const complete = (turnId, status) => {
    const params = { threadId: "thread-1", turn: { id: turnId, status } };
    control.observe({ method: "turn/completed", params });
    return params;
  };
  return { control, notifications, start, complete, interruptedCompletion: () => interruptedCompletion };
}

const input = (text) => [{ type: "text", text }];

test("queued input starts after natural completion and occupies one slot", async () => {
  const h = harness();
  h.start("turn-1");
  assert.deepEqual(await h.control.request("broker/queue-message", {
    threadId: "thread-1", turnId: "turn-1", input: input("queued")
  }), { queued: true });
  await assert.rejects(h.control.request("broker/queue-message", {
    threadId: "thread-1", turnId: "turn-1", input: input("second")
  }), /already queued/);

  const completed = h.complete("turn-1", "completed");
  assert.deepEqual(completed.redirectInput, input("queued"));
  assert.equal(completed.redirectMode, "queue");

  h.start("turn-2");
  assert.equal(h.complete("turn-2", "completed").redirectInput, undefined);
});

test("failed, cancelled, and unredirected interrupted turns reject queued input", async () => {
  for (const status of ["failed", "cancelled", "interrupted"]) {
    const h = harness();
    h.start(`turn-${status}`);
    await h.control.request("broker/queue-message", {
      threadId: "thread-1", turnId: `turn-${status}`, input: input(status)
    });
    const completed = h.complete(`turn-${status}`, status);
    assert.equal(completed.redirectInput, undefined, status);
    assert.deepEqual(h.notifications.map((message) => ({ mode: message.params.mode, status: message.params.status,
      terminalStatus: message.params.terminalStatus })), [
      { mode: "queue", status: "rejected", terminalStatus: status }
    ], status);
  }
});

test("interrupt replacement runs before queued input", async () => {
  const h = harness();
  h.start("turn-1");
  await h.control.request("broker/queue-message", {
    threadId: "thread-1", turnId: "turn-1", input: input("queued")
  });
  await h.control.request("broker/redirect", {
    threadId: "thread-1", turnId: "turn-1", input: input("replacement")
  });
  assert.deepEqual(h.interruptedCompletion().redirectInput, input("replacement"));
  assert.equal(h.interruptedCompletion().redirectMode, "interrupt");

  h.start("turn-2");
  const completed = h.complete("turn-2", "completed");
  assert.deepEqual(completed.redirectInput, input("queued"));
  assert.equal(completed.redirectMode, "queue");
});
