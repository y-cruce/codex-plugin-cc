import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { DirectorPublisher, cleanupDirectorEvent, durableJson, eventPaths, pendingEvents, wasDelivered,
  deliveryRoot } from "../plugins/codex/scripts/lib/director-delivery.mjs";
import { bridgeOnce, watchOnce } from "../plugins/codex/scripts/remote-relay.mjs";
import { relayCommand, shouldDropRelayEnd } from "../plugins/codex/hooks/remote-relay/register.ts";
import { isolateTestEnvironment, makeTempDir } from "./helpers.mjs";

const SCRIPT = fileURLToPath(new URL("../plugins/codex/scripts/remote-relay.mjs", import.meta.url));
const SESSION = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

async function startServe(t, dataDir, port, session = SESSION) {
  const child = spawn(process.execPath, [SCRIPT, "serve", "--session", session, "--port", String(port)],
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

test("remote-relay watch prints each event once and settles it at the source", async (t) => {
  isolateTestEnvironment(t);
  const source = process.env.CLAUDE_PLUGIN_DATA;
  const port = 20000 + Math.floor(Math.random() * 20000);
  const repoState = path.join(source, "state", "repo-1");
  const job = { id: "task-2", sessionId: SESSION, workspaceRoot: "/repo", label: "fix bugs" };
  const eventId = new DirectorPublisher().publish(job, "director.notified", { notificationId: "n1", message: "line one\nline two" }, repoState);
  await startServe(t, source, port);

  const lines = [];
  const printed = new Set();
  await watchOnce({ sessionId: SESSION, url: `http://127.0.0.1:${port}`, printed, write: (line) => lines.push(line), wait: 0 });
  await watchOnce({ sessionId: SESSION, url: `http://127.0.0.1:${port}`, printed, write: (line) => lines.push(line), wait: 0 });

  assert.deepEqual(lines, ["job=task-2 [fix bugs] · director.notified: line one line two"]);
  assert.ok(wasDelivered({ eventId, sessionId: SESSION, stateDir: repoState }));
  assert.equal(pendingEvents(deliveryRoot(), SESSION).length, 0);
});

test("remote-relay mod drops only its own watch endings", () => {
  const owned = new Set(["m1"]);
  const note = (id, status, summary, event = "") =>
    `<task-notification><task-id>${id}</task-id><status>${status}</status><summary>${summary}</summary>${event}</task-notification>`;
  assert.equal(shouldDropRelayEnd(note("m1", "completed", 'Monitor "x" stream ended'), owned), true);
  assert.equal(shouldDropRelayEnd(note("m1", "completed", "x", "<event>[Monitor expired after 30m]</event>"), owned), true);
  assert.equal(shouldDropRelayEnd(note("m1", "completed", 'Monitor "x" stream ended', "<event>job=t · job.completed: done</event>"), owned), false);
  assert.equal(shouldDropRelayEnd(note("m1", "failed", 'Monitor "x" stream ended'), owned), false);
  assert.equal(shouldDropRelayEnd(note("m2", "completed", 'Monitor "x" stream ended'), owned), false);
  assert.match(relayCommand("/p/codex/1.0.0", "s-1", "http://127.0.0.1:13005"),
    /^node '\/p\/codex\/1\.0\.0\/scripts\/remote-relay\.mjs' watch --session 's-1' --url 'http:\/\/127\.0\.0\.1:13005' --for-ms 1740000$/);
});

test("remote-relay serve with * serves any named session", async (t) => {
  isolateTestEnvironment(t);
  const port = 20000 + Math.floor(Math.random() * 20000);
  await startServe(t, makeTempDir(), port, "*");
  assert.equal((await fetch(`http://127.0.0.1:${port}/events?session=other&wait=0`)).status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${port}/events?wait=0`)).status, 403);
});

test("remote-relay mod drops endings of watches retired by a session change", () => {
  const note = (id, status) => `<task-notification><task-id>${id}</task-id><status>${status}</status><summary>Monitor "x" stream ended</summary></task-notification>`;
  const owned = new Map([["live", "s-2"]]);
  const retired = new Set(["old"]);
  assert.equal(shouldDropRelayEnd(note("old", "killed"), owned, retired), true);
  assert.equal(shouldDropRelayEnd(note("live", "killed"), owned, retired), false);
});
