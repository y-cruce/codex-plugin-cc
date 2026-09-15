import net from "node:net";
import { EventEmitter } from "node:events";
import { loadBrokerSession } from "./broker-lifecycle.mjs";
import { parseBrokerEndpoint } from "./broker-endpoint.mjs";
import path from "node:path";
import { readObservationJson } from "./observation-paths.mjs";

export class ObservationClient extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.pending = new Map();
    this.nextId = 1;
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { socket.destroy(new Error("Invalid broker response")); return; }
        const pending = this.pending.get(message.id);
        if (pending) {
          this.pending.delete(message.id);
          clearTimeout(pending.timer);
          if (message.error) pending.reject(Object.assign(new Error(message.error.message), message.error.data, { rpcCode: message.error.code }));
          else pending.resolve(message.result);
        } else if (message.method) this.emit("notification", message);
      }
    });
    socket.on("error", (error) => { this.failure = error; });
    socket.on("close", () => {
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(this.failure ?? new Error("Broker disconnected"));
      }
      this.pending.clear();
      this.emit("closed", this.failure);
    });
  }

  static async connect(cwd, { stateDir = undefined, fallback = false } = {}) {
    const session = stateDir ? await readObservationJson(path.join(stateDir, "broker.json")) : loadBrokerSession(cwd);
    const endpoint = (!fallback && process.env.CODEX_COMPANION_APP_SERVER_ENDPOINT) || session?.endpoint;
    if (!endpoint) throw Object.assign(new Error("No live broker"), { code: "BROKER_UNAVAILABLE" });
    const socket = net.createConnection({ path: parseBrokerEndpoint(endpoint).path });
    const client = new ObservationClient(socket);
    try {
      const initialized = await client.request("initialize", { clientInfo: { name: "codex-observer", version: "1" } });
      if (initialized?.observationVersion !== 1) throw Object.assign(new Error("OBSERVATION_UNSUPPORTED"), { code: "OBSERVATION_UNSUPPORTED" });
      return client;
    } catch (error) { client.close(); throw error; }
  }

  request(method, params = {}) {
    if (this.socket.destroyed) return Promise.reject(new Error("Broker disconnected"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Broker request timed out: ${method}`));
      }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  close() { this.socket.destroy(); }
}

// Register on the execution socket before thread/start or thread/resume can emit events.
export async function registerObservedJob(client, cwd, progress) {
  if (!progress?.jobId || client.observationVersion !== 1) return;
  await client.request("broker/job-register", { cwd, jobId: progress.jobId });
}

export async function finishObservedJob(cwd, jobId) {
  let client;
  try {
    client = await ObservationClient.connect(cwd);
    await client.request("broker/job-finish", { cwd, jobId });
  } catch {
    // Old brokers remain supported; the new broker also reconciles terminal job files.
  } finally { client?.close(); }
}
