// Imported when a turn actually runs, not when the module loads: the driver
// needs `@agentclientprotocol/sdk`, and an installed copy can be missing it,
// so a top-level import failed every companion call on such a copy --
// `observe list` included, which has nothing to do with ACP.

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { renderJobEvent } from "./job-event-model.mjs";

const PLUGIN_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DRIVER = new URL("./executors/acp-driver.mjs", import.meta.url).href;
const LOCK_STALE_MS = 5 * 60 * 1000;
const INSTALL_TIMEOUT_MS = 3 * 60 * 1000;

// Claude Code installs a plugin's dependencies with `npm ci --ignore-scripts`
// and reports the install as a success when that fails. It failed every time
// the install ran under `npm run`, which exports npm_config_allow_scripts and
// makes npm refuse a project install -- and a copy without the SDK cannot run a
// Qoder turn at all. Qoder needs the network to do anything, so wherever it can
// run npm can fetch: a copy installs what it is missing before its first turn.
export function missingDependency(error) {
  return error?.code === "ERR_MODULE_NOT_FOUND" &&
    /Cannot find package '(@agentclientprotocol\/sdk|zod)'/.test(String(error.message));
}

export async function loadAcpDriver({ importDriver = (href) => import(href), install = installDependencies, onProgress } = {}) {
  try { return await importDriver(DRIVER); }
  catch (error) { if (!missingDependency(error)) throw error; }
  await install(PLUGIN_ROOT, onProgress);
  // A fresh URL: whether a failed import is remembered for its URL has not
  // held the same across the Node versions this plugin supports.
  return importDriver(`${DRIVER}?installed=${Date.now()}`);
}

async function installed(root) {
  try { await fs.access(path.join(root, "node_modules", ".package-lock.json")); return true; }
  catch { return false; }
}

// Two turns dispatched together both find the SDK missing. One installs and
// the other waits for it, rather than two `npm ci` runs each deleting the
// node_modules the other is writing.
async function acquireInstallLock(lock) {
  while (true) {
    try { await fs.mkdir(lock); return; }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    const since = await fs.stat(lock).then((stat) => stat.mtimeMs, () => Date.now());
    if (Date.now() - since > LOCK_STALE_MS) await fs.rm(lock, { recursive: true, force: true });
    else await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

export async function installDependencies(root, onProgress) {
  const lock = path.join(root, ".dependencies.lock");
  await acquireInstallLock(lock);
  try {
    if (await installed(root)) return;
    onProgress?.("Installing the plugin's ACP dependencies before the first Qoder turn");
    const env = { ...process.env };
    delete env.npm_config_allow_scripts;
    delete env.NPM_CONFIG_ALLOW_SCRIPTS;
    const windows = process.platform === "win32";
    const { code, output } = await new Promise((resolve) => {
      const child = spawn(windows ? "npm.cmd" : "npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
        { cwd: root, env, shell: windows, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { output += chunk; });
      const timer = setTimeout(() => child.kill(), INSTALL_TIMEOUT_MS);
      child.on("error", (error) => { clearTimeout(timer); resolve({ code: null, output: error.message }); });
      child.on("close", (exit) => { clearTimeout(timer); resolve({ code: exit, output }); });
    });
    if (code !== 0) {
      const tail = output.trim().split("\n").slice(-4).join(" | ");
      throw new Error(`Qoder needs @agentclientprotocol/sdk, which this copy of the plugin (${root}) is missing, ` +
        `and installing it failed (npm exit ${code}): ${tail}. Run \`npm ci --ignore-scripts\` in that directory.`);
    }
  } finally {
    await fs.rm(lock, { recursive: true, force: true });
  }
}

function emitProgress(onProgress, message, phase = null, extra = {}) {
  if (onProgress) onProgress({ message, phase, ...extra });
}

// A job's last sign of life is its log file's mtime: `status` reports it as
// `lastProgressAt`, and the pane's monitor calls a job stalled fifteen minutes
// after it. A Codex turn writes a line per item; an ACP turn wrote three lines
// at startup and nothing after, so a working ACP task was reported stalled and
// `status` showed it frozen at "starting" with no progress for its whole run.
const PHASES = [["command.", "running"], ["fileChange.", "editing"], ["tool.", "investigating"],
  ["agent.", "investigating"], ["plan.", "investigating"], ["turn.completed", "finalizing"]];

function progressForEvent(event) {
  const message = renderJobEvent(event);
  if (!message) return null;
  return { message, phase: PHASES.find(([prefix]) => event.type.startsWith(prefix))?.[1] ?? null };
}

function lastAssistantMessage(terminal) {
  return [...terminal.finalMessages].reverse().find((message) => message.role === "assistant") ?? null;
}

function terminalError(terminal) {
  const reason = terminal.reason ?? {};
  return Object.assign(new Error(reason.message ?? reason.code ?? `ACP round ended ${terminal.status}.`), {
    code: reason.code ?? terminal.status,
    backendCode: reason.backendCode ?? null,
    retryable: reason.retryable === true
  });
}

export async function runAcpTurn(cwd, options = {}) {
  const { openAcpExecutorJob } = await loadAcpDriver({
    onProgress: (message) => emitProgress(options.onProgress, message, "starting")
  });
  const job = { id: options.onProgress?.jobId ?? options.jobId, executor: "acp", workspaceRoot: cwd,
    status: "running", title: options.title ?? "ACP Task" };
  const port = await openAcpExecutorJob({ cwd, job, onProgress: options.onProgress, command: options.command,
    args: options.args, env: options.env, modeId: options.modeId, modelId: options.modelId, effortId: options.effortId,
    createQueuedRound: options.createQueuedRound });
  const eventPump = (async () => {
    for await (const event of port.events()) {
      options.onExecutorEvent?.(event);
      const progress = progressForEvent(event);
      if (progress) emitProgress(port.onProgress, progress.message, progress.phase);
    }
  })();
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await port.close();
    await eventPump;
  };
  const failQueuedRounds = async (error) => {
    for (const entry of port.drainQueuedPrompts()) {
      await options.failQueuedRound?.(entry.round, error, () => port.bindQueuedRound(entry));
    }
  };
  const runRound = async (sessionId, firstInput, onProgress) => {
    let input = firstInput;
    let terminal;
    const interruptedTurns = [];
    try {
      do {
        const turn = await port.startTurn({ sessionId, prompt: input });
        emitProgress(onProgress, `Turn started (${turn.turnId}).`, "starting", { turnId: turn.turnId });
        try {
          terminal = await turn.done;
        } catch (error) {
          const pending = port.takeReplacementPrompt();
          if (!pending || port.closed || error?.code === "TRANSPORT_CLOSED") {
            if (pending && error instanceof Error) error.undeliveredRedirect = true;
            throw error;
          }
          input = pending;
          interruptedTurns.push({ turnId: turn.turnId, touchedFiles: [], workspaceStatus: null });
          emitProgress(onProgress, "Turn interrupted; continuing in the same ACP session.", "redirecting");
          continue;
        }
        input = port.takeReplacementPrompt();
        if (input) {
          interruptedTurns.push({ turnId: turn.turnId, touchedFiles: [], workspaceStatus: null });
          emitProgress(onProgress, "Turn interrupted; continuing in the same ACP session.", "redirecting");
        }
      } while (input);
      await port.adapter.completeJob(terminal);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const reason = { code: error?.code === "TRANSPORT_CLOSED" ? "transport_closed" : "backend_error",
        backendCode: error?.code ?? null, retryable: error?.retryable === true,
        message: error?.undeliveredRedirect ? `${detail} (the message sent with --interrupt was never delivered)` : detail };
      await port.adapter.completeJob({ status: "failed", reason, finalMessages: [], usage: null });
      throw error;
    }
    const message = lastAssistantMessage(terminal);
    const reasoningSummary = terminal.finalMessages.filter((item) => item.role === "reasoning" && item.text).map((item) => item.text);
    return { status: terminal.status === "completed" ? 0 : 1, executor: "acp", sessionId,
      threadId: sessionId, turnId: terminal.turnId, terminal, finalMessage: message?.text ?? "",
      finalContent: message?.content ?? [], reasoningSummary, error: terminal.status === "completed" ? null : { message: terminal.reason.message ?? terminal.reason.code },
      stderr: port.stderr.trim(), fileChanges: [], touchedFiles: [], interruptedTurns, commandExecutions: [] };
  };
  try {
    emitProgress(options.onProgress, options.resumeSessionId ? `Resuming ACP session ${options.resumeSessionId}.` : "Starting ACP session.", "starting",
      { executor: "acp", controlEndpoint: port.controlEndpoint });
    const session = options.resumeSessionId
      ? await port.resumeSession({ sessionId: options.resumeSessionId, cwd, additionalDirectories: options.additionalDirectories ?? [],
          mcpServers: options.mcpServers ?? [], modeId: options.modeId, modelId: options.modelId, effortId: options.effortId })
      : await port.startSession({ cwd, additionalDirectories: options.additionalDirectories ?? [], mcpServers: options.mcpServers ?? [],
          modeId: options.modeId, modelId: options.modelId, effortId: options.effortId });
    emitProgress(options.onProgress, `ACP session ready (${session.sessionId}).`, "starting", {
      executor: "acp", executorSessionId: session.sessionId, threadId: session.sessionId, controlEndpoint: port.controlEndpoint,
      executorEffort: session.effortId
    });
    const prompt = options.prompt?.trim() || options.defaultPrompt || "";
    if (!prompt) throw new Error("A prompt is required for this ACP run.");
    const firstResult = await runRound(session.sessionId, [{ type: "text", text: prompt }], options.onProgress);
    return { ...firstResult, afterCompletion: async () => {
      try {
        let previous = firstResult;
        while (true) {
          if (previous.terminal.status !== "completed") {
            await failQueuedRounds(terminalError(previous.terminal));
            break;
          }
          const queued = port.takeQueuedPrompt();
          if (!queued) break;
          try {
            previous = await options.runQueuedRound(queued.round, async (onProgress) => {
              await port.startQueuedRound(queued, onProgress);
              emitProgress(onProgress, "Previous round completed; starting the next queued instruction.", "starting", {
                executor: "acp", executorSessionId: session.sessionId, threadId: session.sessionId,
                controlEndpoint: port.controlEndpoint, executorEffort: session.effortId
              });
              return runRound(session.sessionId, queued.input, onProgress);
            });
          } catch (error) {
            await failQueuedRounds(error);
            break;
          }
        }
      } finally {
        await close();
      }
    } };
  } catch (error) {
    await failQueuedRounds(error);
    await close();
    throw error;
  }
}
