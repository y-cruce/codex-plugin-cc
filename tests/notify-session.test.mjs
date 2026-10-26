import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { deliveryRoot, pendingEvents } from "../plugins/codex/scripts/lib/director-delivery.mjs";
import { isolateTestEnvironment, makeTempDir } from "./helpers.mjs";

const SCRIPT = fileURLToPath(new URL("../plugins/codex/scripts/notify-session.mjs", import.meta.url));

test("notify-session queues a director note for a session without any job", (t) => {
  isolateTestEnvironment(t);
  const sessionId = "11111111-2222-3333-4444-555555555555";
  const file = path.join(makeTempDir(), "message.txt");
  fs.writeFileSync(file, "remote session dispatched task-x\n");

  const result = spawnSync(process.execPath, [SCRIPT, sessionId, file, "--from", "order-space-17", "--wait-ms", "0"],
    { encoding: "utf8", env: process.env });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`^QUEUED session=${sessionId} id=msg-`));
  const [event] = pendingEvents(deliveryRoot(), sessionId);
  assert.equal(event.type, "director.notified");
  assert.equal(event.payload.message, "remote session dispatched task-x");
  assert.match(event.text, /\[message from order-space-17, not a Codex job\] · director\.notified: remote session dispatched task-x$/);
});

test("notify-session refuses an empty message", (t) => {
  isolateTestEnvironment(t);
  const file = path.join(makeTempDir(), "empty.txt");
  fs.writeFileSync(file, "  \n");
  const result = spawnSync(process.execPath, [SCRIPT, "some-session", file], { encoding: "utf8", env: process.env });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /NOTIFY_FAILED empty message/);
});
