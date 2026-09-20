// Imported when a turn actually runs, not when the module loads: the driver
// needs `@agentclientprotocol/sdk`, and a plugin is distributed without its
// dependencies, so a top-level import failed every companion call on an
// installed copy -- `observe list` included, which has nothing to do with ACP.

function emitProgress(onProgress, message, phase = null, extra = {}) {
  if (onProgress) onProgress({ message, phase, ...extra });
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
  const eventPump = (async () => { for await (const event of port.events()) options.onExecutorEvent?.(event); })();
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
      terminal = await turn.done;
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
    const reason = { code: error?.code === "TRANSPORT_CLOSED" ? "transport_closed" : "backend_error",
      backendCode: error?.code ?? null, message: error instanceof Error ? error.message : String(error), retryable: error?.retryable === true };
    await port.adapter.completeJob({ status: "failed", reason, finalMessages: [], usage: null });
    throw error;
  } finally {
    await port.close();
    await eventPump;
  }
}
