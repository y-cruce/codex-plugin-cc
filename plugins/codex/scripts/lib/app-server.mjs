/**
 * @typedef {Error & { data?: unknown, rpcCode?: number }} ProtocolError
 * @typedef {import("./app-server-protocol").AppServerMethod} AppServerMethod
 * @typedef {import("./app-server-protocol").AppServerNotification} AppServerNotification
 * @typedef {import("./app-server-protocol").AppServerNotificationHandler} AppServerNotificationHandler
 * @typedef {import("./app-server-protocol").ClientInfo} ClientInfo
 * @typedef {import("./app-server-protocol").CodexAppServerClientOptions} CodexAppServerClientOptions
 * @typedef {import("./app-server-protocol").InitializeCapabilities} InitializeCapabilities
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { ensureBrokerSession, loadBrokerSession } from "./broker-lifecycle.mjs";
import { binaryAvailable, terminateProcessTree } from "./process.mjs";

const PLUGIN_MANIFEST_URL = new URL("../../.claude-plugin/plugin.json", import.meta.url);
const PLUGIN_MANIFEST = JSON.parse(fs.readFileSync(PLUGIN_MANIFEST_URL, "utf8"));

export const BROKER_ENDPOINT_ENV = "CODEX_COMPANION_APP_SERVER_ENDPOINT";
export const DISABLE_DAEMON_ENV = "CODEX_COMPANION_DISABLE_DAEMON";
export const BROKER_BUSY_RPC_CODE = -32001;
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const DAEMON_CONNECT_TIMEOUT_MS = 2000;

export function resolveDaemonControlSocketPath(env = process.env) {
  const codexHome = path.resolve(env?.CODEX_HOME || path.join(env?.HOME || os.homedir(), ".codex"));
  return path.join(codexHome, "app-server-control", "app-server-control.sock");
}

function resolveEligibleDaemonSocket(cwd, options = {}) {
  if (options.daemonSocketPath) {
    return options.daemonSocketPath;
  }
  if (process.platform === "win32") {
    return null;
  }
  const env = options.env ?? process.env;
  if (options.disableDaemon || env?.[DISABLE_DAEMON_ENV] === "1") {
    return null;
  }
  const socketPath = resolveDaemonControlSocketPath(env);
  if (!fs.existsSync(socketPath)) {
    return null;
  }
  // Ensure `codex` on PATH is a real Codex CLI release (not a test fixture stub)
  // so tests with custom PATH and default CODEX_HOME never bypass fixtures.
  const version = binaryAvailable("codex", ["--version"], { cwd, env });
  if (!version.available || !/^codex-cli\s+\d+\.\d+\.\d+/.test(version.detail)) {
    return null;
  }
  return socketPath;
}

/** @type {ClientInfo} */
const DEFAULT_CLIENT_INFO = {
  title: "Codex Plugin",
  name: "Claude Code",
  version: PLUGIN_MANIFEST.version ?? "0.0.0"
};

/** @type {InitializeCapabilities} */
const DEFAULT_CAPABILITIES = {
  experimentalApi: true,
  requestAttestation: false,
  optOutNotificationMethods: []
};

function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

function createProtocolError(message, data) {
  const error = /** @type {ProtocolError} */ (new Error(message));
  error.data = data;
  if (data?.code !== undefined) {
    error.rpcCode = data.code;
  }
  return error;
}

class AppServerClientBase {
  constructor(cwd, options = {}) {
    this.cwd = cwd;
    this.options = options;
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = "";
    this.closed = false;
    this.exitError = null;
    /** @type {AppServerNotificationHandler | null} */
    this.notificationHandler = null;
    this.serverRequestHandler = null;
    this.lineBuffer = "";
    this.transport = "unknown";

    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  setNotificationHandler(handler) {
    this.notificationHandler = handler;
  }

  setServerRequestHandler(handler) {
    this.serverRequestHandler = handler;
  }

  respond(id, result) {
    this.sendMessage({ id, result });
  }

  /**
   * @template {AppServerMethod} M
   * @param {M} method
   * @param {import("./app-server-protocol").AppServerRequestParams<M>} params
   * @returns {Promise<import("./app-server-protocol").AppServerResponse<M>>}
   */
  request(method, params) {
    if (this.exitResolved) {
      return Promise.reject(this.exitError ?? new Error("codex app-server connection closed."));
    }
    if (this.closed) {
      throw new Error("codex app-server client is closed.");
    }

    const id = this.nextId;
    this.nextId += 1;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.sendMessage({ id, method, params });
    });
  }

  notify(method, params = {}) {
    if (this.closed) {
      return;
    }
    this.sendMessage({ method, params });
  }

  handleChunk(chunk) {
    this.lineBuffer += chunk;
    let newlineIndex = this.lineBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.lineBuffer.slice(0, newlineIndex);
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
      this.handleLine(line);
      newlineIndex = this.lineBuffer.indexOf("\n");
    }
  }

  handleLine(line) {
    if (this.exitResolved || !line.trim()) {
      return;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.handleExit(createProtocolError(`Failed to parse codex app-server JSONL: ${error.message}`, { line }));
      return;
    }

    if (message.id !== undefined && message.method) {
      return this.handleServerRequest(message);
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);

      if (message.error) {
        pending.reject(createProtocolError(message.error.message ?? `codex app-server ${pending.method} failed.`, message.error));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }

    if (message.method && this.notificationHandler) {
      return this.notificationHandler(/** @type {AppServerNotification} */ (message));
    }
  }

  async handleServerRequest(message) {
    if (await this.serverRequestHandler?.(message)) {
      return;
    }
    this.sendMessage({
      id: message.id,
      error: buildJsonRpcError(-32601, `Unsupported server request: ${message.method}`)
    });
  }

  handleExit(error) {
    if (this.exitResolved) {
      return;
    }

    this.exitResolved = true;
    this.exitError = error ?? null;

    for (const pending of this.pending.values()) {
      pending.reject(this.exitError ?? new Error("codex app-server connection closed."));
    }
    this.pending.clear();
    this.resolveExit(undefined);
  }

  sendMessage(_message) {
    throw new Error("sendMessage must be implemented by subclasses.");
  }
}

class SpawnedCodexAppServerClient extends AppServerClientBase {
  constructor(cwd, options = {}) {
    super(cwd, options);
    this.transport = "direct";
  }

  async initialize() {
    const args = ["app-server"];
    if (this.options.requestUserInput) args.push("-c", "features.default_mode_request_user_input=true");
    this.proc = spawn("codex", args, {
      cwd: this.cwd,
      env: this.options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32" ? (process.env.SHELL || true) : false,
      windowsHide: true
    });

    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");

    this.proc.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });

    this.proc.on("error", (error) => {
      this.handleExit(error);
    });

    this.proc.on("exit", (code, signal) => {
      const stderr = this.stderr.trim();
      const detail =
        code === 0
          ? null
          : createProtocolError(
              `codex app-server exited unexpectedly (${signal ? `signal ${signal}` : `exit ${code}`}).${stderr ? `\n${stderr}` : ""}`
            );
      this.handleExit(detail);
    });

    this.reading = (async () => {
      for await (const chunk of this.proc.stdout) {
        this.lineBuffer += chunk;
        let newlineIndex;
        // JSONL uses LF; readline also splits strings at Unicode separators.
        while ((newlineIndex = this.lineBuffer.indexOf("\n")) !== -1) {
          const line = this.lineBuffer.slice(0, newlineIndex);
          this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
          await this.handleLine(line);
        }
      }
    })().catch((error) => this.handleExit(error));

    const initialized = await this.request("initialize", {
      clientInfo: this.options.clientInfo ?? DEFAULT_CLIENT_INFO,
      capabilities: this.options.capabilities ?? DEFAULT_CAPABILITIES
    });
    this.observationVersion = Number(initialized["observationVersion"] ?? 0);
    this.notify("initialized", {});
  }

  async close() {
    if (this.closed) {
      await this.exitPromise;
      return;
    }

    this.closed = true;

    if (this.proc && !this.proc.killed) {
      this.proc.stdin.end();
      setTimeout(() => {
        if (this.proc && !this.proc.killed && this.proc.exitCode === null) {
          // On Windows with shell: true, the direct child is cmd.exe.
          // Use terminateProcessTree to kill the entire tree including
          // the grandchild node process.
          if (process.platform === "win32") {
            try {
              terminateProcessTree(this.proc.pid);
            } catch {
              // Best-effort cleanup inside an unref'd timer — swallow errors
              // to avoid crashing the host process during shutdown.
            }
          } else {
            this.proc.kill("SIGTERM");
          }
        }
      }, 50).unref?.();
    }

    await this.exitPromise;
  }

  sendMessage(message) {
    const line = `${JSON.stringify(message)}\n`;
    const stdin = this.proc?.stdin;
    if (!stdin) {
      throw new Error("codex app-server stdin is not available.");
    }
    stdin.write(line);
  }
}

class BrokerCodexAppServerClient extends AppServerClientBase {
  constructor(cwd, options = {}) {
    super(cwd, options);
    this.transport = "broker";
    this.endpoint = options.brokerEndpoint;
  }

  async initialize() {
    await new Promise((resolve, reject) => {
      const target = parseBrokerEndpoint(this.endpoint);
      this.socket = net.createConnection({ path: target.path });
      const timeout = this.options.brokerTimeoutMs
        ? setTimeout(() => this.socket.destroy(new Error("Live broker request timed out.")), this.options.brokerTimeoutMs)
        : null;
      this.socket.setEncoding("utf8");
      this.socket.on("connect", resolve);
      this.socket.on("data", (chunk) => {
        this.handleChunk(chunk);
      });
      this.socket.on("error", (error) => {
        if (!this.exitResolved) {
          reject(error);
        }
        this.handleExit(error);
      });
      this.socket.on("close", () => {
        if (timeout) clearTimeout(timeout);
        this.handleExit(this.exitError);
      });
    });

    const initialized = await this.request("initialize", {
      clientInfo: this.options.clientInfo ?? DEFAULT_CLIENT_INFO,
      capabilities: this.options.capabilities ?? DEFAULT_CAPABILITIES
    });
    this.observationVersion = Number(initialized["observationVersion"] ?? 0);
    this.notify("initialized", {});
  }

  async close() {
    if (this.closed) {
      await this.exitPromise;
      return;
    }

    this.closed = true;
    if (this.socket) {
      this.socket.end();
    }
    await this.exitPromise;
  }

  sendMessage(message) {
    const line = `${JSON.stringify(message)}\n`;
    const socket = this.socket;
    if (!socket) {
      throw new Error("codex app-server broker connection is not connected.");
    }
    socket.write(line);
  }
}

class DaemonCodexAppServerClient extends AppServerClientBase {
  constructor(cwd, options = {}) {
    super(cwd, options);
    this.transport = "daemon";
    this.socketPath = options.daemonSocketPath;
    this.socket = null;
    this.rxBuffer = Buffer.alloc(0);
    this.fragmentChunks = null;
  }

  async initialize() {
    const key = crypto.randomBytes(16).toString("base64");
    const expectedAccept = crypto.createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64");

    await new Promise((resolve, reject) => {
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        req.destroy();
        reject(error);
      };
      const req = http.request({
        socketPath: this.socketPath,
        path: "/rpc",
        headers: {
          Host: "localhost",
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Key": key,
          "Sec-WebSocket-Version": "13"
        }
      });
      const timer = setTimeout(
        () => fail(new Error("Timed out connecting to Codex app-server daemon.")),
        DAEMON_CONNECT_TIMEOUT_MS
      );
      timer.unref?.();

      req.on("upgrade", (res, socket, head) => {
        if (res.headers["sec-websocket-accept"] !== expectedAccept) {
          socket.destroy();
          fail(new Error("Invalid WebSocket handshake response from Codex app-server daemon."));
          return;
        }
        clearTimeout(timer);
        this.socket = socket;
        socket.on("data", (chunk) => this.handleFrameChunk(chunk));
        socket.on("error", (error) => this.handleExit(error));
        socket.on("close", () => this.handleExit(this.exitError));
        settled = true;
        if (head?.length) {
          this.handleFrameChunk(head);
        }
        resolve(undefined);
      });
      req.on("response", (res) => {
        res.resume();
        fail(new Error(`Codex app-server daemon rejected upgrade with HTTP ${res.statusCode}.`));
      });
      req.on("error", fail);
      req.end();
    });

    const initialized = await this.request("initialize", {
      clientInfo: this.options.clientInfo ?? DEFAULT_CLIENT_INFO,
      capabilities: this.options.capabilities ?? DEFAULT_CAPABILITIES
    });
    this.observationVersion = Number(initialized["observationVersion"] ?? 0);
    this.notify("initialized", {});
  }

  handleFrameChunk(chunk) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.rxBuffer = this.rxBuffer.length ? Buffer.concat([this.rxBuffer, buf]) : buf;

    while (!this.exitResolved && this.rxBuffer.length >= 2) {
      const b0 = this.rxBuffer[0];
      const b1 = this.rxBuffer[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let length = b1 & 0x7f;
      let offset = 2;

      if (length === 126) {
        if (this.rxBuffer.length < 4) return;
        length = this.rxBuffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.rxBuffer.length < 10) return;
        length = Number(this.rxBuffer.readBigUInt64BE(2));
        offset = 10;
      }

      let mask = null;
      if (masked) {
        if (this.rxBuffer.length < offset + 4) return;
        mask = this.rxBuffer.subarray(offset, offset + 4);
        offset += 4;
      }

      if (this.rxBuffer.length < offset + length) return;
      let payload = this.rxBuffer.subarray(offset, offset + length);
      this.rxBuffer = this.rxBuffer.subarray(offset + length);

      if (mask) {
        const unmasked = Buffer.allocUnsafe(payload.length);
        for (let i = 0; i < payload.length; i += 1) {
          unmasked[i] = payload[i] ^ mask[i & 3];
        }
        payload = unmasked;
      }

      if (opcode === 0x9) {
        if (!this.closed && this.socket && !this.socket.destroyed) {
          this.writeFrame(0xa, payload);
        }
      } else if (opcode === 0x8) {
        if (!this.closed && this.socket && !this.socket.destroyed) {
          try {
            this.writeFrame(0x8, Buffer.alloc(0));
          } catch {}
          this.socket.end();
        }
        return;
      } else if (opcode === 0x1) {
        if (fin) {
          this.handleLine(payload.toString("utf8"));
        } else {
          this.fragmentChunks = [Buffer.from(payload)];
        }
      } else if (opcode === 0x0 && this.fragmentChunks) {
        this.fragmentChunks.push(Buffer.from(payload));
        if (fin) {
          const text = Buffer.concat(this.fragmentChunks).toString("utf8");
          this.fragmentChunks = null;
          this.handleLine(text);
        }
      }
    }
  }

  writeFrame(opcode, payload) {
    const socket = this.socket;
    if (!socket || socket.destroyed) {
      throw new Error("codex app-server daemon connection is not connected.");
    }
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.allocUnsafe(2);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | len;
    } else if (len <= 0xffff) {
      header = Buffer.allocUnsafe(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.allocUnsafe(10);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    const mask = crypto.randomBytes(4);
    const maskedPayload = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i += 1) {
      maskedPayload[i] = payload[i] ^ mask[i & 3];
    }
    socket.write(Buffer.concat([header, mask, maskedPayload]));
  }

  async close() {
    if (this.closed) {
      await this.exitPromise;
      return;
    }

    this.closed = true;
    if (this.socket && !this.socket.destroyed) {
      try {
        this.writeFrame(0x8, Buffer.alloc(0));
      } catch {}
      this.socket.end();
      setTimeout(() => {
        if (this.socket && !this.socket.destroyed) {
          this.socket.destroy();
        }
      }, 50).unref?.();
    } else {
      this.handleExit(this.exitError);
    }
    await this.exitPromise;
  }

  sendMessage(message) {
    this.writeFrame(0x1, Buffer.from(JSON.stringify(message), "utf8"));
  }
}

export class CodexAppServerClient {
  static async connect(cwd, options = {}) {
    let brokerEndpoint = null;
    if (!options.disableBroker) {
      brokerEndpoint = options.brokerEndpoint ?? options.env?.[BROKER_ENDPOINT_ENV] ?? process.env[BROKER_ENDPOINT_ENV] ?? null;
      if (!brokerEndpoint && options.reuseExistingBroker) {
        brokerEndpoint = loadBrokerSession(cwd)?.endpoint ?? null;
      }
      if (!brokerEndpoint && !options.reuseExistingBroker) {
        const brokerSession = await ensureBrokerSession(cwd, { env: options.env, requireBroker: options.requireBroker });
        brokerEndpoint = brokerSession?.endpoint ?? null;
      }
    }
    if (!brokerEndpoint && options.requireBroker) {
      throw new Error("A shared broker is required for interactive tasks. Check /codex:setup before retrying.");
    }
    if (brokerEndpoint) {
      const client = new BrokerCodexAppServerClient(cwd, { ...options, brokerEndpoint });
      await client.initialize();
      return client;
    }

    const daemonSocketPath = resolveEligibleDaemonSocket(cwd, options);
    if (daemonSocketPath) {
      const daemonClient = new DaemonCodexAppServerClient(cwd, { ...options, daemonSocketPath });
      try {
        await daemonClient.initialize();
        return daemonClient;
      } catch {
        await daemonClient.close().catch(() => {});
      }
    }

    const client = new SpawnedCodexAppServerClient(cwd, options);
    await client.initialize();
    return client;
  }
}
