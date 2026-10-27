import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { DirectorPublisher, cleanupDirectorEvent, durableJson, eventPaths, pendingEvents, wasDelivered,
  deliveryRoot } from "../plugins/codex/scripts/lib/director-delivery.mjs";
import { bridgeOnce } from "../plugins/codex/scripts/remote-relay.mjs";
import { isolateTestEnvironment, makeTempDir } from "./helpers.mjs";

const SCRIPT = fileURLToPath(new URL("../plugins/codex/scripts/remote-relay.mjs", import.meta.url));
const SESSION = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

async function startServe(t, dataDir, port) {
  const child = spawn(process.execPath, [SCRIPT, "serve", "--session", SESSION, "--port", String(port)],
    { env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir }, stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => child.kill());
  await new Promise((resolve) => child.stdout.once("data", resolve));
}

test("remote-relay moves an event into the remote outbox and settles both receipts", async (t) => {
  isolateTestEnvironment(t);
  const source = makeTempDir();
  const target = process.env.CLAUDE_PLUGIN_DATA;
  const port = 20000 + Math.floor(Math.random() * 20000);

  process.env.CLAUDE_PLUGIN_DATA = source;
  const repoState = path.join(source, "state", "repo-1");
  const job = { id: "task-1", sessionId: SESSION, workspaceRoot: "/repo", label: "fix bugs" };
  const publisher = new DirectorPublisher();
  const kept = publisher.publish(job, "director.notified", { notificationId: "n1", message: "need a decision" }, repoState);
  const settled = publisher.publish(job, "director.notified", { notificationId: "n2", message: "obsolete" }, repoState);
  process.env.CLAUDE_PLUGIN_DATA = target;
  await startServe(t, source, port);

  const url = `http://127.0.0.1:${port}`;
  const forwarded = new Map();
  await bridgeOnce({ sessionId: SESSION, url, forwarded, wait: 0 });
  const copies = pendingEvents(deliveryRoot(), SESSION);
  assert.deepEqual(copies.map((event) => event.eventId).sort(), [kept, settled].sort());
  assert.ok(copies.every((event) => event.stateDir === path.join(target, "state", "remote-relay")));

  // The source settles one before delivery; the remote session receives the other.
  cleanupDirectorEvent({ eventId: settled, sessionId: SESSION, stateDir: repoState });
  const local = copies.find((event) => event.eventId === kept);
  durableJson(eventPaths(local).receipt, { eventId: kept });
  await bridgeOnce({ sessionId: SESSION, url, forwarded, wait: 0 });

  assert.equal(pendingEvents(deliveryRoot(), SESSION).length, 0);
  assert.equal(forwarded.size, 0);
  assert.ok(wasDelivered({ eventId: kept, sessionId: SESSION, stateDir: repoState }));
  assert.equal(fs.existsSync(eventPaths({ eventId: kept, sessionId: SESSION, stateDir: repoState }).item), false);
});

test("remote-relay serve refuses a session it was not started for", async (t) => {
  isolateTestEnvironment(t);
  const port = 20000 + Math.floor(Math.random() * 20000);
  await startServe(t, makeTempDir(), port);
  const response = await fetch(`http://127.0.0.1:${port}/events?session=other&wait=0`);
  assert.equal(response.status, 403);
});
