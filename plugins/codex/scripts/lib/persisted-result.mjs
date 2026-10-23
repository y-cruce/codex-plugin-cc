function mergeTextBlocks(content) {
  if (!Array.isArray(content)) return content;
  const merged = [];
  for (const block of content) {
    const previous = merged.at(-1);
    if (block?.type === "text" && typeof block.text === "string") {
      if (previous?.type === "text" && typeof previous.text === "string") previous.text += block.text;
      else merged.push({ ...block });
    } else merged.push(block);
  }
  return merged;
}

// Keep execution messages intact: only their persisted copies lose reasoning.
export function resultForPersistence(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const { reasoningSummary, ...stored } = result;
  if (result.codex && typeof result.codex === "object") {
    const { reasoning, ...codex } = result.codex;
    stored.codex = codex;
  }
  if (Array.isArray(result.finalContent)) stored.finalContent = mergeTextBlocks(result.finalContent);
  if (Array.isArray(result.terminal?.finalMessages)) {
    stored.terminal = { ...result.terminal, finalMessages: result.terminal.finalMessages
      .filter((message) => message.role !== "reasoning")
      .map((message) => ({ ...message, ...(Array.isArray(message.content) ? { content: mergeTextBlocks(message.content) } : {}) })) };
  }
  return stored;
}

export function jobForPersistence(job) {
  return job?.result ? { ...job, result: resultForPersistence(job.result) } : job;
}
