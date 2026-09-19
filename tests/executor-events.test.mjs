import test from "node:test";
import assert from "node:assert/strict";

import { CANONICAL_EVENT_TYPES, assertCanonicalEventDraft, createCanonicalEvent } from "../plugins/codex/scripts/lib/executor-events.mjs";

test("canonical event validation accepts complete events and rejects malformed envelopes and payloads", () => {
  const event = createCanonicalEvent({
    job: { id: "job-1" },
    type: "message.delta",
    identity: { sessionId: "session", turnId: "turn", messageId: "message" },
    occurredAt: "2026-09-18T00:00:00.000Z",
    receivedAt: "2026-09-18T00:00:00.000Z",
    payload: { role: "assistant", block: { type: "text", text: "hello" } },
    source: { protocol: "codex-app-server", method: "item/agentMessage/delta", raw: { delta: "hello" } }
  });
  assert.equal(assertCanonicalEventDraft(event), event);
  assert.ok(CANONICAL_EVENT_TYPES.has("history.recording.failed"));
  assert.throws(() => assertCanonicalEventDraft({ ...event, schemaVersion: 1 }), { code: "INVALID_CANONICAL_EVENT" });
  assert.throws(() => assertCanonicalEventDraft({ ...event, type: "unknown.event" }), { code: "INVALID_CANONICAL_EVENT" });
  assert.throws(() => assertCanonicalEventDraft({ ...event, identity: { ...event.identity, turnId: 1 } }), { code: "INVALID_CANONICAL_EVENT" });
  const { block, ...incomplete } = event.payload;
  assert.throws(() => assertCanonicalEventDraft({ ...event, payload: incomplete }), { code: "INVALID_CANONICAL_EVENT" });
});
