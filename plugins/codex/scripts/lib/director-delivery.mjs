import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { acquireWriter, releaseWriter } from "./job-event-store.mjs";
import { questionIds, questionText } from "./job-event-model.mjs";
import { resolveStateDirAtWorkspaceRoot } from "./state.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
export const channelDirectory = () => path.join(os.tmpdir(), "codex-channel");
export function deliveryRoot(stateDir) {
  if (stateDir) return path.join(path.basename(path.dirname(stateDir)) === "state"
    ? path.dirname(path.dirname(stateDir)) : path.dirname(stateDir), "director-delivery");
  return path.join(process.env.CLAUDE_PLUGIN_DATA || path.join(os.tmpdir(), "codex-companion"), "director-delivery");
}
export const sessionDirectory = (root, sessionId) => path.join(root, hash(String(sessionId)));
export const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
};

// Publish complete files, then sync their directory: acceptance survives a crash.
export function durableJson(file, value) {
  const missing = [];
  for (let directory = path.dirname(file); !fs.existsSync(directory); directory = path.dirname(directory)) missing.push(directory);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const directory of missing.reverse()) {
    const parent = fs.openSync(path.dirname(directory), "r");
    try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
  }
  const temporary = `${file}.${process.pid}-${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, "wx", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
  const directory = fs.openSync(path.dirname(file), "r");
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

export function directorEvent(job, type, payload = {}, stateDir = undefined) {
  if (!job.sessionId) return null;
  stateDir ??= resolveStateDirAtWorkspaceRoot(job.workspaceRoot);
  const terminal = type.startsWith("job.");
  const identity = terminal ? "terminal" : type === "question.opened"
    ? [payload.threadId ?? job.executorSessionId ?? job.threadId, payload.turnId ?? job.turnId, String(payload.requestId)]
    : payload.notificationId ?? payload.id;
  const eventId = hash(JSON.stringify([stateDir, job.id, terminal ? "terminal" : type, identity]));
  let detail;
  if (type === "question.opened") detail = `request=${payload.requestId}${questionIds(payload.questions ?? payload.fields)}: ${questionText(payload.questions ?? payload.fields, payload.message, Infinity)}`;
  else if (type === "director.notified") detail = `${payload.pendingRequestId == null ? "" : `pending_request=${payload.pendingRequestId} `}${payload.message ?? ""}`;
  else detail = job.errorMessage ?? job.result?.error?.message ?? job.result?.terminal?.finalMessages?.map((m) => m.text).join("\n") ?? "";
  return { eventId, sessionId: job.sessionId, stateDir, jobId: job.id, roundId: job.roundId ?? job.id, label: job.label ?? null, reportFile: job.reportFile ?? null, type,
    payload: terminal ? { status: job.status, errorMessage: job.errorMessage ?? job.result?.error?.message ?? null, ...payload } : payload,
    threadId: payload.threadId ?? job.executorSessionId ?? job.threadId ?? null, turnId: payload.turnId ?? job.turnId ?? null,
    text: `job=${job.id}${job.label ? ` [${job.label}]` : ""} · ${type}${detail ? `: ${detail}` : ""}` };
}

export function eventPaths(event) {
  const directory = sessionDirectory(deliveryRoot(event.stateDir), event.sessionId);
  return { directory, item: path.join(directory, "outbox", `${event.eventId}.json`),
    receipt: path.join(directory, "delivered", `${event.eventId}.json`), lock: path.join(directory, "locks", event.eventId) };
}
export function confirmedRoute(event) {
  const route = readJson(path.join(eventPaths(event).directory, "route.json"));
  const confirmation = route?.confirmationFile ? readJson(route.confirmationFile) : null;
  return route?.confirmed && route.sessionId === event.sessionId && confirmation?.instance === route.instance
    && confirmation.sessionId === event.sessionId && confirmation.until > Date.now() ? route : null;
}
export const wasDelivered = (event) => Boolean(event && fs.existsSync(eventPaths(event).receipt));

async function lock(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const deadline = Date.now() + 10000;
  for (;;) {
    try { return await acquireWriter(directory); }
    catch (error) {
      if (error.code !== "STORE_BUSY" || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

// Both routes hold the same item locks through output and receipt publication.
// A crash after output but before the receipt/ACK can repeat the stable event id.
// Claude's one-way channel API cannot provide receiver-side exactly-once delivery.
export async function deliverDirectorEvents(events, route, output) {
  const leases = [];
  try {
    for (const event of [...new Map(events.filter(Boolean).map((e) => [e.eventId, e])).values()].sort((a, b) => a.eventId.localeCompare(b.eventId))) {
      const paths = eventPaths(event);
      const lease = await lock(paths.lock);
      leases.push({ event, paths, lease });
    }
    const pending = leases.filter(({ paths }) => !fs.existsSync(paths.receipt));
    if (pending.length && await output(pending.map(({ event }) => event)) === false) return false;
    for (const { event, paths } of pending) durableJson(paths.receipt, { eventId: event.eventId, route, at: new Date().toISOString() });
    return pending.length > 0;
  } finally {
    for (const { paths, lease } of leases.reverse()) await releaseWriter(paths.lock, lease);
  }
}

export function pendingEvents(root, sessionId) {
  const directory = path.join(sessionDirectory(root, sessionId), "outbox");
  let names;
  try { names = fs.readdirSync(directory); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  return names.filter((name) => name.endsWith(".json")).map((name) => readJson(path.join(directory, name))).filter(Boolean)
    .sort((a, b) => a.acceptedAt.localeCompare(b.acceptedAt) || a.eventId.localeCompare(b.eventId));
}

export function channelRequest(endpoint, message) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    const timer = setTimeout(() => socket.destroy(new Error("Director channel timed out")), 5000);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify(message)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      try {
        const result = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
        if (result.error) reject(new Error(result.error)); else resolve(result);
      } catch (error) { reject(error); }
      socket.destroy();
    });
    socket.on("error", reject);
    socket.on("close", () => { clearTimeout(timer); reject(new Error("Director channel disconnected before ACK")); });
  });
}

export class DirectorPublisher {
  constructor({ root = deliveryRoot(), instance = randomUUID(), retryMs = 2000, onDelivered = (_event) => {} } = {}) {
    this.root = root;
    this.instance = instance;
    this.inflight = new Map();
    this.onDelivered = onDelivered;
    this.timer = setInterval(() => this.replay(), retryMs);
    this.timer.unref();
    this.replay();
  }

  publish(job, type, payload = {}, stateDir = undefined) {
    const event = directorEvent(job, type, payload, stateDir);
    if (!event) return null;
    const paths = eventPaths(event);
    if (!fs.existsSync(paths.item) && !fs.existsSync(paths.receipt)) {
      durableJson(paths.item, { ...event, brokerInstance: this.instance, acceptedAt: new Date().toISOString() });
    }
    // Start IPC in this call, independently of ordinary history commits/deltas.
    this.push(event);
    return event.eventId;
  }

  push(event) {
    if (this.inflight.has(event.eventId)) return this.inflight.get(event.eventId);
    const paths = eventPaths(event);
    const route = confirmedRoute(event);
    if (!route) return;
    if (wasDelivered(event)) { fs.rmSync(paths.item, { force: true }); this.onDelivered(event); return; }
    const sending = channelRequest(route.endpoint, { action: "deliver", sessionId: event.sessionId, eventId: event.eventId, instance: route.instance })
      .then((ack) => {
        if (ack.eventId === event.eventId && wasDelivered(event)) {
          fs.rmSync(paths.item, { force: true });
          this.onDelivered(event);
        }
      }).catch(() => {}).finally(() => this.inflight.delete(event.eventId));
    this.inflight.set(event.eventId, sending);
    return sending;
  }

  replay() {
    let sessions;
    try { sessions = fs.readdirSync(this.root); } catch (error) { if (error.code === "ENOENT") return; throw error; }
    for (const name of sessions) {
      const directory = path.join(this.root, name, "outbox");
      let files;
      try { files = fs.readdirSync(directory); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
      for (const file of files.filter((name) => name.endsWith(".json"))) {
        const event = readJson(path.join(directory, file));
        if (event) this.push(event);
      }
    }
  }

  close() { clearInterval(this.timer); }
}
