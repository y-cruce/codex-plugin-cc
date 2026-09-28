import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DONE = ["completed", "failed", "cancelled"];

// The tasks pane lives inside the Claude Code process, out of a shell's reach.
// A shell asks it through two files: it writes a request, and the pane answers
// it after its next poll, about two seconds later.
export function paneChannelDir(home = os.homedir()) {
  return path.join(home, ".claude", "plugins", "data", "codex-tasks-pane");
}

export async function askPane(sessionId, action, target, { dir = paneChannelDir(), timeoutMs = 30_000, pollMs = 200 } = {}) {
  const id = randomUUID();
  const request = path.join(dir, `${sessionId}.request.json`);
  const reply = path.join(dir, `${sessionId}.reply.json`);
  fs.mkdirSync(dir, { recursive: true });
  // Renamed into place so the pane never reads half a request.
  const temp = `${request}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify({ id, action, target })}\n`);
  fs.renameSync(temp, request);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    try {
      const answer = JSON.parse(fs.readFileSync(reply, "utf8"));
      if (answer.id === id) return withDiskStatus(answer);
    } catch {
      // Not answered yet, or caught mid-write.
    }
  }
  // Withdrawn, or a pane that loads later would carry it out long after the
  // caller was told it failed.
  try {
    if (JSON.parse(fs.readFileSync(request, "utf8")).id === id) fs.rmSync(request, { force: true });
  } catch {}
  throw new Error(`the tasks pane of session ${sessionId} did not answer within ${Math.round(timeoutMs / 1000)}s; it answers only from inside that Claude Code session with the Codex plugin's hooks loaded`);
}

// Read here rather than taken from the pane: the point of listing is to see
// where the pane's memory and the disk disagree.
function withDiskStatus(reply) {
  const rows = (reply.rows ?? []).map((row) => {
    if (!row.job) return { ...row, disk: "unknown" };
    try {
      const modifiedAt = fs.statSync(row.job).mtime.toISOString();
      return { ...row, disk: JSON.parse(fs.readFileSync(row.job, "utf8")).status ?? "unknown", modifiedAt };
    } catch (error) {
      return { ...row, disk: error.code === "ENOENT" ? "missing" : "unreadable" };
    }
  });
  return { ...reply, rows };
}

export function renderPaneReply(sessionId, reply) {
  const lines = [`Codex tasks pane · session ${sessionId}`];
  if (reply.text) lines.push(reply.text);
  if (!reply.rows.length) lines.push("no rows");
  for (const row of reply.rows) {
    const stale = !DONE.includes(row.status) && (DONE.includes(row.disk) || row.disk === "missing");
    lines.push(`${row.n} ${row.label} · pane ${row.status} · disk ${row.disk}${stale ? " · STALE" : ""}`);
    lines.push(`  id ${row.id}`);
    if (row.job) lines.push(`  job ${row.job}${row.modifiedAt ? ` (modified ${row.modifiedAt})` : ""}`);
    if (row.view) lines.push(`  view ${row.view}`);
  }
  if (reply.forgotten?.length) lines.push(`hidden by forget: ${reply.forgotten.join(" ")}`);
  return `${lines.join("\n")}\n`;
}
