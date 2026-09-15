#!/usr/bin/env node

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";

import { parseArgs } from "./lib/args.mjs";
import { BROKER_BUSY_RPC_CODE, CodexAppServerClient } from "./lib/app-server.mjs";
import { parseBrokerEndpoint } from "./lib/broker-endpoint.mjs";
import { LiveTurnControl, DEFAULT_INPUT_TIMEOUT_MS } from "./lib/live-turn-control.mjs";
import { JobRuntime } from "./lib/job-runtime.mjs";

const STREAMING_METHODS = new Set(["turn/start", "review/start", "thread/compact/start"]);

function buildStreamThreadIds(method, params, result) {
  const threadIds = new Set();
  if (params?.threadId) {
    threadIds.add(params.threadId);
  }
  if (method === "review/start" && result?.reviewThreadId) {
    threadIds.add(result.reviewThreadId);
  }
  return threadIds;
}

function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

function send(socket, message) {
  if (socket.destroyed) {
    return;
  }
  socket.write(`${JSON.stringify(message)}\n`);
}

function writePidFile(pidFile) {
  if (!pidFile) {
    return;
  }
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, `${process.pid}\n`, "utf8");
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (subcommand !== "serve") {
    throw new Error("Usage: node scripts/app-server-broker.mjs serve --endpoint <value> [--cwd <path>] [--pid-file <path>]");
  }

  const { options } = parseArgs(argv, {
    valueOptions: ["cwd", "pid-file", "endpoint", "input-timeout-ms", "idle-timeout-ms"]
  });

  if (!options.endpoint) {
    throw new Error("Missing required --endpoint.");
  }

  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  const endpoint = String(options.endpoint);
  const listenTarget = parseBrokerEndpoint(endpoint);
  const pidFile = options["pid-file"] ? path.resolve(options["pid-file"]) : null;
  const inputTimeoutMs = Number(options["input-timeout-ms"] ?? DEFAULT_INPUT_TIMEOUT_MS);
  if (!Number.isSafeInteger(inputTimeoutMs) || inputTimeoutMs <= 0 || inputTimeoutMs > 2147483647) {
    throw new Error("input-timeout-ms must be a positive timer duration.");
  }
  const idleTimeoutMs = Number(options["idle-timeout-ms"] ?? 600000);
  if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs <= 0 || idleTimeoutMs > 2147483647) {
    throw new Error("idle-timeout-ms must be a positive timer duration.");
  }
  writePidFile(pidFile);
  const appClient = await CodexAppServerClient.connect(cwd, { disableBroker: true, requestUserInput: true });
  const controls = new LiveTurnControl(appClient, routeNotification, inputTimeoutMs);
  const jobs = new JobRuntime();
  let activeRequestSocket = null;
  const streamOwners = new Map();
  const pendingThreadStarts = new Map();
  let requestTail = Promise.resolve();
  let pendingStreamNotifications = null;
  let idleTimer = null;
  let shutdownPromise = null;
  const sockets = new Set();

  function resetIdleTimer() {
    clearTimeout(idleTimer);
    if (!shutdownPromise && sockets.size === 0 && streamOwners.size === 0) {
      idleTimer = setTimeout(async () => {
        await shutdown(server);
        process.exit(0);
      }, idleTimeoutMs);
      idleTimer.unref();
    }
  }

  function clearSocketOwnership(socket) {
    if (activeRequestSocket === socket) {
      activeRequestSocket = null;
    }
    for (const [threadId, owner] of streamOwners) {
      if (owner === socket) streamOwners.delete(threadId);
    }
    resetIdleTimer();
  }

  function routeNotification(message) {
    const recorded = jobs.observe(structuredClone(message));
    controls.observe(message);
    deliverNotification(message);
    return recorded;
  }

  function deliverNotification(message) {
    const threadId = message.params?.threadId ?? message.params?.thread?.id;
    const parentId = message.params?.thread?.source?.subagent?.thread_spawn?.parent_thread_id;
    if (threadId && parentId && !streamOwners.has(threadId) && streamOwners.has(parentId)) {
      streamOwners.set(threadId, streamOwners.get(parentId));
    }
    // Threadless notifications belong only to the current non-streaming request; otherwise drop them.
    const target = threadId ? streamOwners.get(threadId) : activeRequestSocket;
    if (!target) {
      if (message.method === "thread/started") pendingThreadStarts.set(threadId, message);
      else if (threadId && pendingStreamNotifications) pendingStreamNotifications.push(message);
      return;
    }
    // Spawned agents share their parent's owner, never another root task's stream.
    if (message.params?.item?.type === "collabAgentToolCall") {
      for (const childId of message.params.item.receiverThreadIds ?? []) {
        if (!streamOwners.has(childId)) streamOwners.set(childId, target);
        if (streamOwners.get(childId) === target && pendingThreadStarts.has(childId)) {
          send(target, pendingThreadStarts.get(childId));
          pendingThreadStarts.delete(childId);
        }
      }
    }
    send(target, message);
    if (message.method === "turn/completed") {
      streamOwners.delete(threadId);
    }
    resetIdleTimer();
  }

  function shutdown(server) {
    if (shutdownPromise) return shutdownPromise;
    clearTimeout(idleTimer);
    shutdownPromise = closeServer(server);
    return shutdownPromise;
  }

  async function closeServer(server) {
    controls.close();
    for (const socket of sockets) {
      socket.end();
    }
    await jobs.close();
    await appClient.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    if (listenTarget.kind === "unix" && fs.existsSync(listenTarget.path)) {
      fs.unlinkSync(listenTarget.path);
    }
    if (pidFile && fs.existsSync(pidFile)) {
      fs.unlinkSync(pidFile);
    }
  }

  appClient.setNotificationHandler(routeNotification);
  appClient.setServerRequestHandler(async (message) => {
    await jobs.observe(message);
    return controls.handleServerRequest(message);
  });

  const server = net.createServer((socket) => {
    sockets.add(socket);
    resetIdleTimer();
    socket.setEncoding("utf8");
    let buffer = "";

    socket.on("data", async (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");

        if (!line.trim()) {
          continue;
        }

        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          send(socket, {
            id: null,
            error: buildJsonRpcError(-32700, `Invalid JSON: ${error.message}`)
          });
          continue;
        }

        if (message.id !== undefined && message.method === "initialize") {
          send(socket, {
            id: message.id,
            result: {
              userAgent: "codex-companion-broker",
              observationVersion: 1
            }
          });
          continue;
        }

        if (message.method === "initialized" && message.id === undefined) {
          continue;
        }

        if (message.id !== undefined && message.method === "broker/shutdown") {
          send(socket, { id: message.id, result: {} });
          await shutdown(server);
          process.exit(0);
        }

        if (message.id === undefined) {
          continue;
        }

        if (message.method.startsWith("broker/job-") || message.method.startsWith("broker/observe-")) {
          try {
            const p = message.params ?? {};
            let result;
            switch (message.method) {
              case "broker/job-register": result = await jobs.register(socket, p.cwd ?? cwd, p.jobId); break;
              case "broker/job-finish": result = await jobs.finish(p.cwd ?? cwd, p.jobId); break;
              case "broker/observe-follow": result = await jobs.follow(socket, p.cwd ?? cwd, p.jobId, p.after); break;
              case "broker/observe-status": result = { followers: jobs.followers.size }; break;
              default: throw new Error("OBSERVATION_UNSUPPORTED");
            }
            send(socket, { id: message.id, result });
            if (message.method === "broker/observe-follow") jobs.wake(jobs.followers.get(socket));
          } catch (error) {
            send(socket, { id: message.id, error: buildJsonRpcError(-32600, error.message, {
              code: error.code ?? "OBSERVATION_FAILED", earliestAvailableCursor: error.earliestAvailableCursor
            }) });
          }
          continue;
        }

        if (controls.handles(message.method)) {
          try {
            if (message.method === "broker/redirect" && !streamOwners.has(message.params?.threadId)) {
              throw new Error("No task owner is connected to continue after interruption.");
            }
            const result = await controls.request(message.method, message.params ?? {});
            const p = message.params ?? {};
            if (message.method === "turn/steer" || message.method === "broker/redirect") {
              await jobs.observe({ method: "companion/control-message", params: { threadId: p.threadId,
                turnId: p.expectedTurnId ?? p.turnId, message: p.input.map((item) => item.text).join("\n"),
                interrupt: message.method === "broker/redirect", status: "accepted" } });
            } else if (message.method === "broker/answer") {
              await jobs.observe({ method: "companion/answer-delivered", params: { ...p } });
            }
            send(socket, { id: message.id, result });
          } catch (error) {
            send(socket, { id: message.id, error: buildJsonRpcError(error.rpcCode ?? -32600, error.message) });
          }
          continue;
        }

        // Serialize request/response exchanges, not the lifetime of their turns.
        const request = requestTail.then(async () => {
          if (socket.destroyed) return;
          const isStreaming = STREAMING_METHODS.has(message.method);
          const threadIds = buildStreamThreadIds(message.method, message.params, null);
          if (isStreaming && [...threadIds].some((id) => streamOwners.has(id) && streamOwners.get(id) !== socket)) {
            send(socket, { id: message.id, error: buildJsonRpcError(BROKER_BUSY_RPC_CODE, "Shared Codex broker is busy.") });
            return;
          }
          const added = new Set();
          if (isStreaming) {
            // Reserve known threads before sending: turn events can precede the RPC response.
            for (const id of threadIds) {
              if (!streamOwners.has(id)) added.add(id);
              streamOwners.set(id, socket);
            }
            pendingStreamNotifications = [];
            resetIdleTimer();
          } else activeRequestSocket = socket;
          if (message.method === "turn/start") controls.starting(message.params ?? {});
          if (message.params?.threadId) await jobs.bind(socket, message.params.threadId);
          try {
            const result = await appClient.request(message.method, message.params ?? {});
            if (result.thread?.id) await jobs.bind(socket, result.thread.id);
            if (result.reviewThreadId) await jobs.bind(socket, result.reviewThreadId);
            if (message.method === "thread/start") pendingThreadStarts.delete(result.thread?.id);
            if (isStreaming && !socket.destroyed) {
              for (const id of buildStreamThreadIds(message.method, message.params, result)) {
                if (!threadIds.has(id)) {
                  streamOwners.set(id, socket);
                  if (pendingThreadStarts.has(id)) {
                    send(socket, pendingThreadStarts.get(id));
                    pendingThreadStarts.delete(id);
                  }
                }
              }
              const buffered = pendingStreamNotifications;
              pendingStreamNotifications = null;
              for (const notification of buffered) deliverNotification(notification);
            }
            send(socket, { id: message.id, result });
          } catch (error) {
            for (const id of added) {
              if (streamOwners.get(id) === socket) streamOwners.delete(id);
            }
            send(socket, { id: message.id, error: buildJsonRpcError(error.rpcCode ?? -32000, error.message) });
          } finally {
            activeRequestSocket = null;
            pendingStreamNotifications = null;
            resetIdleTimer();
          }
        });
        requestTail = request.catch(() => {});
      }
    });

    socket.on("close", () => {
      jobs.disconnected(socket);
      sockets.delete(socket);
      clearSocketOwnership(socket);
    });

    socket.on("error", () => {
      jobs.disconnected(socket);
      sockets.delete(socket);
      clearSocketOwnership(socket);
    });
  });

  process.on("SIGTERM", async () => {
    await shutdown(server);
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    await shutdown(server);
    process.exit(0);
  });

  server.listen(listenTarget.path);
  resetIdleTimer();
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
