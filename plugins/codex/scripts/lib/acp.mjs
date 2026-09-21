// Imported when a turn actually runs, not when the module loads: the driver
// needs `@agentclientprotocol/sdk`, and a plugin is distributed without its
// dependencies, so a top-level import failed every companion call on an
// installed copy -- `observe list` included, which has nothing to do with ACP.

import { renderJobEvent } from "./job-event-model.mjs";

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

export async function runAcpTurn(cwd, options = {}) {
  const { openAcpExecutorJob } = await import("./executors/acp-driver.mjs");
  const job = { id: options.onProgress?.jobId ?? options.jobId, executor: "acp", workspaceRoot: cwd,
    status: "running", title: options.title ?? "ACP Task" };
  const port = await openAcpExecutorJob({ cwd, job, onProgress: options.onProgress, command: options.command,
    args: options.args, env: options.env, modeId: options.modeId, modelId: options.modelId, effortId: options.effortId });
  const eventPump = (async () => {
    for await (const event of port.events()) {
      options.onExecutorEvent?.(event);
      const progress = progressForEvent(event);
      if (progress) emitProgress(options.onProgress, progress.message, progress.phase);
    }
  })();
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
    let input = [{ type: "text", text: prompt }];
    let terminal;
    const interruptedTurns = [];
    do {
      const turn = await port.startTurn({ sessionId: session.sessionId, prompt: input });
      emitProgress(options.onProgress, `Turn started (${turn.turnId}).`, "starting", { turnId: turn.turnId });
      try {
        terminal = await turn.done;
      } catch (error) {
        // A turn can end by throwing -- the agent dropped the connection, or
        // exited -- after a redirect already cancelled it. The correction is
        // waiting, so carry it into another turn while the session is still
        // usable; when it is not, say that the correction never landed rather
        // than report a bare transport error.
        const pending = port.takeReplacementPrompt();
        if (!pending || port.closed || error?.code === "TRANSPORT_CLOSED") {
          if (pending && error instanceof Error) error.undeliveredRedirect = true;
          throw error;
        }
        input = pending;
        interruptedTurns.push({ turnId: turn.turnId, touchedFiles: [], workspaceStatus: null });
        emitProgress(options.onProgress, "Turn interrupted; continuing in the same ACP session.", "redirecting");
        continue;
      }
      input = port.takeReplacementPrompt();
      if (input) {
        interruptedTurns.push({ turnId: turn.turnId, touchedFiles: [], workspaceStatus: null });
        emitProgress(options.onProgress, "Turn interrupted; continuing in the same ACP session.", "redirecting");
      }
    } while (input);
    await port.adapter.completeJob(terminal);
    const message = lastAssistantMessage(terminal);
    const reasoningSummary = terminal.finalMessages.filter((item) => item.role === "reasoning" && item.text).map((item) => item.text);
    return { status: terminal.status === "completed" ? 0 : 1, executor: "acp", sessionId: session.sessionId,
      threadId: session.sessionId, turnId: terminal.turnId, terminal, finalMessage: message?.text ?? "",
      finalContent: message?.content ?? [], reasoningSummary, error: terminal.status === "completed" ? null : { message: terminal.reason.message ?? terminal.reason.code },
      stderr: port.stderr.trim(), fileChanges: [], touchedFiles: [], interruptedTurns, commandExecutions: [] };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const reason = { code: error?.code === "TRANSPORT_CLOSED" ? "transport_closed" : "backend_error",
      backendCode: error?.code ?? null, retryable: error?.retryable === true,
      // Said in the failure itself: a job that dies holding a correction has to
      // report that the correction never reached the agent, or the director
      // reads a transport error and assumes the message is still queued.
      message: error?.undeliveredRedirect ? `${detail} (the message sent with --interrupt was never delivered)` : detail };
    await port.adapter.completeJob({ status: "failed", reason, finalMessages: [], usage: null });
    throw error;
  } finally {
    await port.close();
    await eventPump;
  }
}
