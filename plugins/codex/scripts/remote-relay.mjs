#!/usr/bin/env node
// Carries director events to a Claude session that runs on another machine, for example a
// remote pod that drives this machine's Codex through a forwarded port. Opt-in and standalone:
// nothing loads it, so local sessions keep their own channel and Monitor routes unchanged.
//
//   serve  (machine running Codex)  node remote-relay.mjs serve --session <id> [--port 13005]
//   bridge (machine running Claude) node remote-relay.mjs bridge --session <id> [--url http://127.0.0.1:13005]
//
// Jobs dispatched for the remote session publish into this machine's outbox for that session,
// where no consumer reads them. `serve` hands those pending events out by long poll; `bridge`
// copies each into the remote session's own outbox, with stateDir rewritten to the remote data
// directory, so that session's director channel delivers it and its prompt hook writes the
// receipt. Once the remote receipt exists the bridge acks, and `serve` writes the local receipt.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import { cleanupDirectorEvent, deliveryRoot, durableJson, eventPaths, isDirectorEventPending, pendingEvents,
  wasDelivered } from "./lib/director-delivery.mjs";
import { pluginDataDir } from "./lib/plugin-data.mjs";

const USAGE = [
  "usage: remote-relay.mjs serve --session <claude-session-id> [--session <id>...] [--port 13005]",
  "       remote-relay.mjs bridge --session <claude-session-id> [--url http://127.0.0.1:13005]"
].join("\n");
const POLL_MS = 25000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (message) => console.log(`${new Date().toISOString()} ${message}`);

function parse(argv) {
  const [mode, ...rest] = argv;
  const options = { mode, sessions: [], port: 13005, url: "http://127.0.0.1:13005" };
  for (let i = 0; i < rest.length; i += 2) {
    const [name, value] = [rest[i], rest[i + 1]];
    if (value === undefined) throw new Error(USAGE);
    if (name === "--session") options.sessions.push(value);
    else if (name === "--port") options.port = Number(value);
    else if (name === "--url") options.url = value.replace(/\/+$/, "");
    else throw new Error(USAGE);
  }
  if (!["serve", "bridge"].includes(mode) || !options.sessions.length
    || (mode === "bridge" && options.sessions.length !== 1) || !Number.isInteger(options.port)) throw new Error(USAGE);
  return options;
}

function requireDataDir() {
  const dataDir = pluginDataDir(import.meta.url);
  if (!dataDir) throw new Error("set CLAUDE_PLUGIN_DATA to this plugin's data directory");
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  return dataDir;
}

const pending = (sessionId) => pendingEvents(deliveryRoot(), sessionId).filter(isDirectorEventPending);

export function serve({ sessions, port }) {
  requireDataDir();
  const allowed = new Set(sessions);
  const server = http.createServer(async (request, response) => {
    const reply = (status, body) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    try {
      const url = new URL(request.url, "http://relay");
      const sessionId = url.searchParams.get("session");
      if (!allowed.has(sessionId)) return reply(403, { error: "session not served" });
      if (request.method === "GET" && url.pathname === "/events") {
        const deadline = Date.now() + Math.min(Number(url.searchParams.get("wait") ?? POLL_MS), POLL_MS);
        let events = pending(sessionId);
        while (!events.length && Date.now() < deadline && !request.socket.destroyed) {
          await sleep(500);
          events = pending(sessionId);
        }
        return reply(200, { events });
      }
      if (request.method === "POST" && url.pathname === "/ack") {
        let body = "";
        for await (const chunk of request) body += chunk;
        const acked = [];
        for (const event of pendingEvents(deliveryRoot(), sessionId)) {
          if (!JSON.parse(body).eventIds?.includes(event.eventId)) continue;
          if (!wasDelivered(event)) durableJson(eventPaths(event).receipt, { eventId: event.eventId, route: "remote-relay", at: new Date().toISOString() });
          cleanupDirectorEvent(event);
          acked.push(event.eventId);
        }
        return reply(200, { acked });
      }
      return reply(404, { error: "not found" });
    } catch (error) {
      return reply(500, { error: error.message });
    }
  });
  server.listen(port, "127.0.0.1", () => log(`serving director events for ${sessions.join(", ")} on 127.0.0.1:${port}`));
  return server;
}

async function call(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { "content-type": "application/json" } });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json();
}

// One round: copy new remote events into the local outbox, drop copies the source settled
// (an answered question) before delivery, and ack the ones this session has received.
export async function bridgeOnce({ sessionId, url, forwarded, wait = POLL_MS }) {
  const stateDir = path.join(process.env.CLAUDE_PLUGIN_DATA, "state", "remote-relay");
  const { events } = await call(`${url}/events?session=${encodeURIComponent(sessionId)}&wait=${wait}`);
  const live = new Set(events.map((event) => event.eventId));
  for (const event of events) {
    const local = { ...event, stateDir };
    if (!forwarded.has(event.eventId) && !wasDelivered(local) && !fs.existsSync(eventPaths(local).item)) {
      durableJson(eventPaths(local).item, local);
      log(`forwarded ${event.text}`);
    }
    forwarded.set(event.eventId, local);
  }
  const done = [];
  for (const [eventId, local] of forwarded) {
    if (wasDelivered(local)) done.push(eventId);
    else if (!live.has(eventId)) { cleanupDirectorEvent(local); forwarded.delete(eventId); }
  }
  if (done.length) {
    await call(`${url}/ack?session=${encodeURIComponent(sessionId)}`, { method: "POST", body: JSON.stringify({ eventIds: done }) });
    for (const eventId of done) { cleanupDirectorEvent(forwarded.get(eventId)); forwarded.delete(eventId); }
  }
}

async function bridge({ sessions: [sessionId], url }) {
  requireDataDir();
  log(`bridging ${url} into session ${sessionId}`);
  const forwarded = new Map();
  for (;;) {
    try {
      await bridgeOnce({ sessionId, url, forwarded, wait: forwarded.size ? 2000 : POLL_MS });
    } catch (error) {
      log(`relay unavailable: ${error.message}`);
      await sleep(5000);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  let options;
  try { options = parse(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exit(2); }
  if (options.mode === "serve") serve(options);
  else await bridge(options);
}
