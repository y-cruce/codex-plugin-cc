import fs from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import { parseArgs } from "./args.mjs";
import { resolveStateDir } from "./state.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";
import { renderStoredJobResult } from "./render.mjs";
import { readHistory, cursorFor, cleanupHistory } from "./job-event-store.mjs";
import { createLiveView, renderJobEvent } from "./job-event-model.mjs";
import { ObservationClient } from "./observation-client.mjs";
import { readObservationJson, observationRoots, observationJobs, resolveObservationRoot } from "./observation-paths.mjs";

const terminal = (status) => ["completed", "failed", "cancelled"].includes(status);
const oneLine = (text) => String(text ?? "").replace(/[\r\n]+/g, " ");
const errorFor = (code, message) => Object.assign(new Error(message ?? code), { code });

async function metadata(location, id) {
  return readObservationJson(path.join(location.stateDir, "job-history", id, "manifest.json"));
}

async function findJob(location, id) {
  const recorded = (await metadata(location, id))?.metadata?.job;
  const job = terminal(recorded?.status) ? recorded : (await observationJobs(location.stateDir)).find((entry) => entry.job.id === id)?.job ?? recorded;
  if (!job) throw errorFor("UNKNOWN_JOB", `UNKNOWN_JOB ${id}`);
  return job;
}

function history(location, id, options = {}) {
  return readHistory(location.cwd, id, { ...options, stateDir: location.stateDir });
}

async function write(text) {
  if (!process.stdout.write(text)) await once(process.stdout, "drain");
}

function clock(iso) {
  return new Date(iso).toLocaleTimeString("en-GB", { hour12: false });
}

function prefix(job) {
  return `job=${job.id}${job.label ? ` [${oneLine(job.label)}]` : ""}`;
}

function eventExit(event, job, until) {
  const p = event.source.message.params;
  const threadId = event.threadId ?? job.threadId ?? "unknown";
  if (event.type === "question.opened") return `QUESTION ${prefix(job)} request=${p.requestId} ${oneLine(p.questions?.[0]?.question).slice(0, 200)}`;
  if (event.type === "director.notified" && until !== "done") return `NOTIFIED job=${job.id} thread=${threadId} ${oneLine(p.message)}`;
  if (["job.completed", "job.failed", "job.cancelled"].includes(event.type)) {
    if (event.type === "job.completed") return `DONE ${prefix(job)} thread=${threadId}`;
    return `FAILED ${prefix(job)} thread=${threadId} ${oneLine(p.job?.errorMessage ?? p.job?.result?.error?.message ?? "unknown")}`;
  }
  return null;
}

async function follow(location, job, options) {
  const { cwd } = location;
  const followStartedAt = Date.now();
  const until = options.until;
  if (until !== undefined && until !== "done") throw errorFor("INVALID_ARGUMENT", "--until must be done");
  const maxSeconds = options["max-seconds"] === undefined ? null : Number(options["max-seconds"]);
  if (maxSeconds !== null && (!Number.isFinite(maxSeconds) || maxSeconds <= 0)) throw errorFor("INVALID_ARGUMENT", "--max-seconds must be positive");
  let manifest = await metadata(location, job.id);
  let initial = manifest ? await history(location, job.id, { after: options.after, limit: 1 }) : null;
  let client;
  if (!terminal(job.status)) client = await ObservationClient.connect(cwd, location);
  // Dispatch returns before its detached worker has registered with the broker.
  // Keep this connection open while that worker publishes the history identity.
  if (!manifest && client && job.status === "queued") {
    const deadline = Date.now() + 10000;
    while (!manifest && !client.socket.destroyed && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      manifest = await metadata(location, job.id);
    }
  }
  if (!manifest) {
    client?.close();
    throw errorFor("OBSERVATION_UNSUPPORTED", "OBSERVATION_UNSUPPORTED: legacy job has no event history");
  }
  try { initial ??= await history(location, job.id, { after: options.after, limit: 1 }); }
  catch (error) { client?.close(); throw error; }
  let cursor = options.after ?? cursorFor({ jobId: job.id, streamId: initial.streamId }, BigInt(initial.earliestSeq) - 1n);
  let finished = false;
  let lastProgress = followStartedAt;
  let lastThread = job.threadId;
  let resolveDone;
  let rejectDone;
  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  // Attach immediately to avoid unhandled rejection while the initial RPC is pending.
  done.catch(() => {});
  let chain = Promise.resolve();
  const finish = async (line) => {
    if (finished) return;
    finished = true;
    await write(`CURSOR: ${cursor}\n${line}\n`);
    if (line.startsWith("DONE ") && !options.quiet) {
      const stored = await readObservationJson(path.join(location.stateDir, "jobs", `${job.id}.json`)) ?? (await metadata(location, job.id))?.metadata?.job;
      await write(renderStoredJobResult(stored ?? job, stored));
    }
    resolveDone();
  };
  const processPage = async (page) => {
    for (const event of page.events) {
      if (finished) return;
      cursor = cursorFor({ jobId: job.id, streamId: page.streamId }, event.seq);
      lastThread = event.threadId ?? lastThread;
      lastProgress = Math.max(lastProgress, Date.parse(event.receivedAt) || 0);
      const text = renderJobEvent(event, { verbose: Boolean(options.verbose) });
      if (text != null && !options.quiet) await write(`${clock(event.occurredAt)} ${text}\n`);
      const exit = eventExit(event, job, until);
      if (exit) { await finish(exit); return; }
    }
    if (!page.events.length) cursor = page.nextCursor;
  };
  const enqueue = (action) => {
    chain = chain.then(action).catch((error) => { finished = true; rejectDone(error); });
    return chain;
  };
  let timeout;
  let stalled;
  let heartbeat;
  const interrupted = () => { finished = true; client?.close(); resolveDone(); };
  process.on("SIGTERM", interrupted);
  process.on("SIGINT", interrupted);
  const outputError = (error) => { finished = true; client?.close(); rejectDone(error); };
  process.stdout.on("error", outputError);
  try {
    if (!options.quiet && initial.continuity !== "complete") await write(`${clock(new Date().toISOString())} History is partial; earliest retained sequence ${initial.earliestSeq}\n`);
    if (options.quiet && client) heartbeat = setInterval(() => enqueue(async () => {
      if (!finished) await write(`… ${clock(new Date().toISOString())} still running\n`);
    }), 60000);
    if (maxSeconds != null && !terminal(job.status)) timeout = setTimeout(() => enqueue(() => finish(`TIMEOUT ${prefix(job)} thread=${lastThread ?? "unknown"} ${maxSeconds}s elapsed, continue with --after`)), Math.max(0, maxSeconds * 1000 - (Date.now() - followStartedAt)));
    stalled = setInterval(() => {
      if (Date.now() - lastProgress >= 15 * 60 * 1000) enqueue(() => finish(`STALLED ${prefix(job)} thread=${lastThread ?? "unknown"} ${Math.floor((Date.now() - lastProgress) / 60000)}m without progress`));
    }, 1000);
    if (client) {
      client.on("notification", (message) => {
        client.socket.pause();
        enqueue(async () => {
          if (message.method === "broker/observation-error") throw Object.assign(new Error(message.params.message), message.params);
          if (message.method === "broker/observation") await processPage(message.params);
        }).finally(() => { if (!finished) client.socket.resume(); });
      });
      client.on("closed", () => enqueue(async () => {
        if (finished) return;
        while (!finished) {
          const page = await history(location, job.id, { after: cursor, limit: 256 });
          await processPage(page);
          if (!page.events.length || page.events.at(-1).seq === page.committedSeq) break;
        }
        if (!finished) throw errorFor("BROKER_UNAVAILABLE", "Broker disconnected; continue with --after");
      }));
      await client.request("broker/observe-follow", { cwd, jobId: job.id, after: options.after });
    } else {
      let after = options.after;
      do {
        const page = await history(location, job.id, { after, limit: 256 });
        await processPage(page);
        after = page.nextCursor;
        if (finished) break;
        if (!page.events.length || page.events.at(-1).seq === page.committedSeq) {
          await finish(`${job.status === "completed" ? "DONE" : "FAILED"} ${prefix(job)} thread=${job.threadId ?? "unknown"}${job.status === "completed" ? "" : ` ${oneLine(job.errorMessage ?? "unknown")}`}`);
        }
      } while (!finished);
    }
    await done;
  } finally {
    finished = true;
    clearTimeout(timeout);
    clearInterval(stalled);
    clearInterval(heartbeat);
    process.off("SIGTERM", interrupted);
    process.off("SIGINT", interrupted);
    process.stdout.off("error", outputError);
    client?.close();
  }
}

export async function handleObserve(argv) {
  const [command, ...rest] = argv;
  const { options, positionals } = parseArgs(rest, {
    valueOptions: ["cwd", "after", "limit", "until", "max-seconds"],
    booleanOptions: ["json", "jsonl", "verbose", "quiet"]
  });
  const cwd = resolveWorkspaceRoot(path.resolve(options.cwd ?? process.cwd()));
  try {
    await cleanupHistory(cwd);
    if (command === "list") {
      const roots = process.env.CLAUDE_PLUGIN_DATA ? [resolveStateDir(cwd)] : await observationRoots(cwd);
      const selected = new Map();
      for (const stateDir of roots) {
        for (const entry of await observationJobs(stateDir)) {
          if (!selected.has(entry.job.id) || selected.get(entry.job.id).mtime < entry.mtime) selected.set(entry.job.id, entry);
        }
      }
      const visible = [...selected.values()].filter(({ job }) => !process.env.CODEX_COMPANION_SESSION_ID || job.sessionId === process.env.CODEX_COMPANION_SESSION_ID);
      const result = await Promise.all(visible.map(async ({ job: original, stateDir }) => {
        const manifest = await metadata({ stateDir }, original.id);
        const job = terminal(manifest?.metadata?.job?.status) ? manifest.metadata.job : original;
        return { id: job.id, label: job.label ?? null, status: job.status, startedAt: job.startedAt ?? null,
          threadId: job.threadId ?? null, historyAvailable: Boolean(manifest && !manifest.tombstone) };
      }));
      await write(`${JSON.stringify({ jobs: result })}\n`);
      return;
    }
    const id = positionals[0];
    if (!id) throw errorFor("INVALID_ARGUMENT", "Pass a job id");
    const stateDir = await resolveObservationRoot(cwd, id);
    const location = { cwd, stateDir, fallback: stateDir !== resolveStateDir(cwd) };
    const job = await findJob(location, id);
    if (command === "view-path") {
      const file = path.join(stateDir, "job-history", id, "live-view.json");
      if (!(await metadata(location, id)) && !location.fallback) {
        const view = createLiveView(job);
        view.history.continuity = "legacy";
        await fs.mkdir(path.dirname(file), { recursive: true });
        const temporary = `${file}.${process.pid}.tmp`;
        await fs.writeFile(temporary, `${JSON.stringify(view)}\n`);
        await fs.rename(temporary, file);
      }
      await write(`${file}\n`);
    } else if (command === "replay") {
      if (!(await metadata(location, id))) throw errorFor("HISTORY_UNAVAILABLE", "Legacy job has no event history");
      const limit = options.limit === undefined ? Infinity : Number(options.limit);
      if (!(limit === Infinity || (Number.isSafeInteger(limit) && limit > 0))) throw errorFor("INVALID_LIMIT", "limit must be a positive integer");
      let after = options.after;
      let remaining = limit;
      let committedSeq;
      do {
        const page = await history(location, id, { after, limit: Math.min(256, remaining) });
        committedSeq ??= page.committedSeq;
        const events = page.events.filter((event) => BigInt(event.seq) <= BigInt(committedSeq));
        for (const event of events) await write(`${JSON.stringify(event)}\n`);
        remaining -= events.length;
        after = events.length ? cursorFor({ jobId: id, streamId: page.streamId }, events.at(-1).seq) : after ?? page.nextCursor;
        if (!events.length || events.at(-1).seq === committedSeq) break;
      } while (remaining > 0);
      await write(`${JSON.stringify({ type: "end", nextCursor: after, committedSeq })}\n`);
    } else if (command === "follow") await follow(location, job, options);
    else throw errorFor("INVALID_ARGUMENT", "Usage: observe list | replay | view-path | follow");
  } catch (error) {
    const payload = { type: "error", code: error.code ?? "OBSERVATION_FAILED", message: error.message,
      earliestAvailableCursor: error.earliestAvailableCursor };
    if (command === "replay") await write(`${JSON.stringify(payload)}\n`);
    else if (payload.earliestAvailableCursor) process.stderr.write(`${JSON.stringify(payload)}\n`);
    else process.stderr.write(`${payload.code}${payload.message.startsWith(payload.code) ? payload.message.slice(payload.code.length) : ` ${payload.message}`}\n`);
    process.exitCode = 1;
  }
}
