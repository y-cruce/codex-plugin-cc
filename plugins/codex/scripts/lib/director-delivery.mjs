import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { acquireWriter, releaseWriter } from "./job-event-store.mjs";
import { questionIds, questionText } from "./job-event-model.mjs";
import { resolveStateDirAtWorkspaceRoot } from "./state.mjs";
import { deliveryRefs, stripDeliveryTags } from "./director-refs.mjs";
import { scanConsumedDirectorEvents } from "./director-consumed.mjs";
import { eventForPersistence } from "./persisted-result.mjs";

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
  if (type === "question.opened" || type === "question.reminder") detail = `request=${payload.requestId}${questionIds(payload.questions ?? payload.fields)}: ${questionText(payload.questions ?? payload.fields, payload.message, Infinity)}`;
  else if (type === "director.notified") detail = `${payload.pendingRequestId == null ? "" : `pending_request=${payload.pendingRequestId} `}${payload.message ?? ""}`;
  else detail = job.errorMessage ?? job.result?.error?.message
    ?? job.result?.terminal?.finalMessages?.findLast((message) => message.role === "assistant")?.text
    ?? job.result?.rawOutput ?? "";
  return { eventId, sessionId: job.sessionId, cwd: job.request?.cwd ?? job.workspaceRoot,
    ...(job.directorAgentId ? { directorAgentId: job.directorAgentId } : {}), stateDir, jobId: job.id, roundId: job.roundId ?? job.id, label: job.label ?? null, reportFile: job.reportFile ?? null, type,
    payload: terminal ? { status: job.status, errorMessage: job.errorMessage ?? job.result?.error?.message ?? null, ...payload } : payload,
    threadId: payload.threadId ?? job.executorSessionId ?? job.threadId ?? null, turnId: payload.turnId ?? job.turnId ?? null,
    text: `job=${job.id}${job.label ? ` [${job.label}]` : ""} · ${type}${detail ? `: ${detail}` : ""}` };
}

export function eventPaths(event) {
  const directory = sessionDirectory(deliveryRoot(event.stateDir), event.sessionId);
  return { directory, item: path.join(directory, "outbox", `${event.eventId}.json`),
    receipt: path.join(directory, "delivered", `${event.eventId}.json`), question: path.join(directory, "questions", `${event.payload?.questionEventId ?? event.eventId}.json`), lock: path.join(directory, "locks", event.eventId) };
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

export function registerDirectorTranscript(root, sessionId, source) {
  if (!sessionId || typeof source !== "string" || !path.isAbsolute(source)
    || path.basename(source) !== `${sessionId}.jsonl`) return;
  const file = path.join(sessionDirectory(root, sessionId), "transcript.json");
  if (readJson(file)?.source !== source) durableJson(file, { source });
}

function directorTranscript(root, sessionId) {
  const known = readJson(path.join(sessionDirectory(root, sessionId), "transcript.json"))?.source;
  if (known) return known;
  const supplied = process.env.CODEX_COMPANION_TRANSCRIPT_PATH;
  if (supplied && path.isAbsolute(supplied) && path.basename(supplied) === `${sessionId}.jsonl`) {
    registerDirectorTranscript(root, sessionId, supplied);
    return supplied;
  }
  // A plugin reload may predate registration of the transcript location. Find
  // that session once without reading other sessions' contents.
  if (!/^[a-f0-9-]{36}$/.test(sessionId)) return null;
  const projects = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects");
  let entries;
  try { entries = fs.readdirSync(projects, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  const sources = entries.filter(entry => entry.isDirectory()).map(entry => path.join(projects, entry.name, `${sessionId}.jsonl`))
    .filter(file => fs.existsSync(file)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (sources.length) registerDirectorTranscript(root, sessionId, sources[0]);
  return sources[0] ?? null;
}

export async function recoverConsumedDirectorEvents(root, sessionId) {
  const source = directorTranscript(root, sessionId);
  if (!source) return;
  const directory = sessionDirectory(root, sessionId);
  const file = path.join(directory, "consumed.json");
  const previous = readJson(file);
  let stat;
  try { stat = fs.statSync(source); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  if (previous?.source === source && previous.dev === stat.dev && previous.ino === stat.ino && previous.offset === stat.size) return;
  const recovery = path.join(directory, "recovery");
  const lease = await lock(recovery);
  try {
    const saved = readJson(file);
    const { cursor, eventIds } = scanConsumedDirectorEvents(source, sessionId, saved);
    const events = eventIds.map(id => readJson(path.join(directory, "outbox", `${id}.json`)))
      .filter(event => event?.sessionId === sessionId && eventPaths(event).directory === directory);
    await commitDirectorEvents(events, "consumed");
    // Commit receipts before advancing: interrupted recovery safely repeats the
    // same input, and commitDirectorEvents preserves any existing receipt's at.
    if (JSON.stringify(cursor) !== JSON.stringify(saved)) durableJson(file, cursor);
  } finally { await releaseWriter(recovery, lease); }
}

export const INACTIVE_SESSION_MS = 30 * 24 * 60 * 60 * 1000;
function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
}

export function touchDirectorSession(directory, now = Date.now()) {
  durableJson(path.join(directory, "activity.json"), { at: now });
}

export function cleanupDirectorEvent(event) {
  const paths = eventPaths(event);
  fs.rmSync(paths.item, { force: true });
  fs.rmSync(path.join(paths.directory, "attempts", event.eventId), { recursive: true, force: true });
}

// Only channel startup and the hourly timer scan inactive sessions. Recovery
// continues to inspect only the bound session's outbox every 30 seconds.
export function sweepDirectorSessions(root, now = Date.now()) {
  let sessions;
  try { sessions = fs.readdirSync(root); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  for (const name of sessions.filter(name => /^[a-f0-9]{64}$/.test(name))) {
    const directory = path.join(root, name);
    try {
      const lease = readJson(path.join(directory, "consumer", "writer.lock"));
      if (lease && pidAlive(lease.pid)) continue;
      const lastActivity = readJson(path.join(directory, "activity.json"))?.at ?? fs.statSync(directory).mtimeMs;
      if (now - lastActivity > INACTIVE_SESSION_MS) fs.rmSync(directory, { recursive: true, force: true });
    } catch {
      // Unreadable ownership or activity is not proof of an inactive session.
    }
  }
}

export function settleDirectorQuestion(job, question, status, stateDir) {
  const event = directorEvent(job, "question.opened", question, stateDir);
  if (!event) return;
  const paths = eventPaths(event);
  touchDirectorSession(paths.directory);
  if (!fs.existsSync(paths.question)) durableJson(paths.question, { eventId: event.eventId, status, at: new Date().toISOString() });
  cleanupDirectorEvent(event);
}

export function isDirectorEventPending(event) {
  if (!event) return false;
  if (wasDelivered(event)) { cleanupDirectorEvent(event); return false; }
  if (event.type === "question.opened" || event.type === "question.reminder") {
    const file = eventPaths(event).question;
    if (fs.existsSync(file)) { cleanupDirectorEvent(event); return false; }
    if (event.payload.expiresAt != null && event.payload.expiresAt <= Date.now()) {
      durableJson(file, { eventId: event.eventId, status: "expired", at: new Date().toISOString() });
      cleanupDirectorEvent(event);
      return false;
    }
  }
  return true;
}

function retainEvent(event) {
  const directory = eventPaths(event).directory;
  touchDirectorSession(directory);
  if (["job.completed", "job.failed", "job.cancelled"].includes(event.type)) {
    for (const question of pendingEvents(deliveryRoot(event.stateDir), event.sessionId)) {
      if (question.type === "question.opened" && question.jobId === event.jobId && question.stateDir === event.stateDir) {
        settleDirectorQuestion({ id: event.jobId, sessionId: event.sessionId }, question.payload, "closed", event.stateDir);
      }
    }
  }
  const paths = eventPaths(event);
  if (!fs.existsSync(paths.item) && isDirectorEventPending(event)) {
    durableJson(paths.item, { ...eventForPersistence(event), acceptedAt: event.acceptedAt ?? new Date().toISOString() });
  }
}

export function deliveryRef(event) {
  return Buffer.from(JSON.stringify({ eventId: event.eventId, sessionId: event.sessionId, stateDir: event.stateDir })).toString("base64url");
}
export const deliveryTag = (event) => `[codex-delivery=${deliveryRef(event)}]`;
export { deliveryRefs, stripDeliveryTags };
export function eventFromRef(ref) {
  try {
    const identity = JSON.parse(Buffer.from(ref, "base64url").toString());
    if (!/^[a-f0-9]{64}$/.test(identity.eventId) || typeof identity.sessionId !== "string" || typeof identity.stateDir !== "string") return null;
    const event = readJson(eventPaths(identity).item);
    return event && event.eventId === identity.eventId && event.sessionId === identity.sessionId && event.stateDir === identity.stateDir ? event : null;
  } catch { return null; }
}

// Output only reserves a short transport attempt. It is not a delivery receipt:
// the host may still drop the queued channel/Monitor frame at prompt.submit.
export async function deliverDirectorEvents(events, route, output, { attemptMs = 5000 } = {}) {
  const pending = await reserveDirectorEvents(events, route, { attemptMs });
  if (!pending.length) return false;
  try {
    if (await output(pending) !== false) return true;
  } catch (error) {
    releaseDirectorEvents(pending, route);
    throw error;
  }
  releaseDirectorEvents(pending, route);
  return false;
}

const attemptFile = (event, route) => path.join(eventPaths(event).directory, "attempts", event.eventId, `${hash(route)}.json`);

// The halves of deliverDirectorEvents, for a caller whose output runs in
// another process (the hooks module, through scripts/director-ingress.mjs).
export async function reserveDirectorEvents(events, route, { attemptMs = 5000 } = {}) {
  const pending = [];
  const recovered = new Set();
  for (const event of new Map(events.filter(Boolean).map((e) => [e.eventId, e])).values()) {
    retainEvent(event);
    const paths = eventPaths(event);
    if (!recovered.has(paths.directory)) {
      await recoverConsumedDirectorEvents(deliveryRoot(event.stateDir), event.sessionId);
      recovered.add(paths.directory);
    }
    const lease = await lock(paths.lock);
    const attempt = attemptFile(event, route);
    try {
      if (!isDirectorEventPending(event) || (readJson(attempt)?.until ?? 0) > Date.now()) continue;
      durableJson(attempt, { until: Date.now() + attemptMs });
      pending.push(event);
    } finally { await releaseWriter(paths.lock, lease); }
  }
  return pending;
}
export function releaseDirectorEvents(events, route) {
  for (const event of events.filter(Boolean)) fs.rmSync(attemptFile(event, route), { force: true });
}

// The receipt half of acceptDirectorEvents, written once the ingress has let
// the items through. Without the lock held across that decision, a channel and
// a Monitor frame accepted at the same moment may both reach the director.
export async function commitDirectorEvents(events, route) {
  for (const event of new Map(events.filter(Boolean).map((e) => [e.eventId, e])).values()) {
    const paths = eventPaths(event);
    const lease = await lock(paths.lock);
    try {
      if (!isDirectorEventPending(event)) continue;
      touchDirectorSession(paths.directory);
      durableJson(paths.receipt, { eventId: event.eventId, route, at: new Date().toISOString() });
      cleanupDirectorEvent(event);
    } finally { await releaseWriter(paths.lock, lease); }
  }
}

// Only the ingress decision commits the final receipt. A crash after next()
// accepts but before this fsync can repeat the stable id; receiver-side durable
// enqueue and receipt are not atomic in Claude Code's hook API.
export async function acceptDirectorEvents(events, route, accept) {
  const leases = [];
  try {
    for (const event of [...new Map(events.filter(Boolean).map((e) => [e.eventId, e])).values()].sort((a, b) => a.eventId.localeCompare(b.eventId))) {
      const paths = eventPaths(event);
      const lease = await lock(paths.lock);
      leases.push({ event, paths, lease });
    }
    const pending = leases.filter(({ event }) => isDirectorEventPending(event));
    if (!pending.length) return { drop: "Codex event already accepted or question closed" };
    const result = await accept(pending.map(({ event }) => event));
    if (!result?.drop) {
      for (const { event, paths } of pending) {
        touchDirectorSession(paths.directory);
        durableJson(paths.receipt, { eventId: event.eventId, route, at: new Date().toISOString() });
        cleanupDirectorEvent(event);
      }
    }
    return result;
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
  constructor({ instance = randomUUID(), onDelivered = (_event) => {} } = {}) {
    this.instance = instance;
    this.inflight = new Map();
    this.onDelivered = onDelivered;
  }

  publish(job, type, payload = {}, stateDir = undefined) {
    if (["question.resolved", "question.closed", "question.expired"].includes(type)) {
      settleDirectorQuestion(job, payload, type.slice(9), stateDir);
      return null;
    }
    const event = directorEvent(job, type, payload, stateDir);
    if (!event) return null;
    retainEvent({ ...event, brokerInstance: this.instance, acceptedAt: new Date().toISOString() });
    // Start IPC in this call, independently of ordinary history commits/deltas.
    this.push(event);
    return event.eventId;
  }

  push(event) {
    if (this.inflight.has(event.eventId)) return this.inflight.get(event.eventId);
    const paths = eventPaths(event);
    if (wasDelivered(event)) { fs.rmSync(paths.item, { force: true }); this.onDelivered(event); return; }
    if (!isDirectorEventPending(event)) return;
    const route = confirmedRoute(event);
    if (!route) return;
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
}
