#!/usr/bin/env node
// Sends a one-line note to a Claude session's director channel without a Codex job behind it.
// The note goes through the same outbox and receipts as job events: a live channel delivers it
// at once; otherwise it waits in the outbox until that session's channel replays it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DirectorPublisher, eventPaths, wasDelivered } from "./lib/director-delivery.mjs";

const USAGE = "usage: notify-session.mjs <claude-session-id> <message-file> [--from <name>] [--wait-ms <ms>]";

// An installed copy lives at ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/scripts;
// its data directory is ~/.claude/plugins/data/<plugin>-<marketplace>.
function pluginDataDir() {
  if (process.env.CLAUDE_PLUGIN_DATA) return process.env.CLAUDE_PLUGIN_DATA;
  const scripts = path.dirname(fileURLToPath(import.meta.url));
  const [version, plugin, marketplace, cache] = [1, 2, 3, 4].map((n) => path.resolve(scripts, ...Array(n).fill("..")));
  if (path.basename(cache) !== "cache" || !version) return null;
  return path.join(path.dirname(cache), "data", `${path.basename(plugin)}-${path.basename(marketplace)}`);
}

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
};
const from = option("--from", "another session");
const waitMs = Number(option("--wait-ms", "15000"));
const [sessionId, messageFile] = args;
if (!sessionId || !messageFile || args.length !== 2 || !Number.isFinite(waitMs) || waitMs < 0) {
  console.error(USAGE);
  process.exit(2);
}
const message = fs.readFileSync(messageFile, "utf8").trim();
if (!message) {
  console.error("NOTIFY_FAILED empty message");
  process.exit(2);
}
const dataDir = pluginDataDir();
if (!dataDir) {
  console.error("NOTIFY_FAILED set CLAUDE_PLUGIN_DATA to this plugin's data directory");
  process.exit(2);
}
process.env.CLAUDE_PLUGIN_DATA = dataDir;

const id = `msg-${Date.now().toString(36)}`;
const job = { id, sessionId, workspaceRoot: process.cwd(), label: `message from ${from}, not a Codex job` };
const stateDir = path.join(dataDir, "state", "session-messages");
const publisher = new DirectorPublisher();
const eventId = publisher.publish(job, "director.notified", { notificationId: id, message }, stateDir);
await Promise.all(publisher.inflight.values());
const event = { eventId, sessionId, stateDir };
for (let waited = 0; waited < waitMs && !wasDelivered(event); waited += 500) {
  await new Promise((resolve) => setTimeout(resolve, 500));
}
console.log(wasDelivered(event)
  ? `NOTIFIED session=${sessionId} id=${id}`
  : `QUEUED session=${sessionId} id=${id} outbox=${eventPaths(event).item}`);
