import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function realDirectory(entry) {
  try {
    const real = fs.realpathSync(entry);
    return fs.statSync(real).isDirectory() ? real : null;
  } catch { return null; }
}

export function antigravitySkillDirectories(cwd, { home = os.homedir(), geminiHome = path.join(home, ".gemini"),
  codexHome = path.join(home, ".codex") } = {}) {
  const directories = new Set();
  for (const root of [path.join(geminiHome, "antigravity-cli/skills"), path.join(geminiHome, "config/skills"),
    path.join(cwd, ".agents/skills")]) {
    let entries;
    try { entries = fs.readdirSync(root); }
    catch { continue; }
    for (const entry of entries) {
      const real = realDirectory(path.join(root, entry));
      if (real) directories.add(real);
    }
  }
  // The Claude director names the sibling skill in its dispatch note. Its
  // installer also links that skill under CODEX_HOME for Codex executors.
  const director = realDirectory(path.join(home, ".claude/skills/code-director"));
  const executor = (director && realDirectory(path.join(path.dirname(director), "codex-executor"))) ??
    realDirectory(path.join(codexHome, "skills/codex-executor"));
  if (executor) directories.add(executor);
  return [...directories];
}

const SAFE_SESSION_ID = /^[A-Za-z0-9._-]+$/;
const SWARM_BOARD_TAIL_BYTES = 64 * 1024;
const DEFAULT_SWARM_RECENT_POSTS = 4;

function statMtime(filePath) {
  try { return fs.statSync(filePath).mtimeMs; }
  catch { return null; }
}

function readTailUtf8(filePath, maxBytes = SWARM_BOARD_TAIL_BYTES) {
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString("utf8");
    // Drop a potentially partial first line when reading from mid-file.
    return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
  } catch {
    return null;
  } finally {
    if (fd != null) try { fs.closeSync(fd); } catch {}
  }
}

export function readAntigravitySwarmSnapshot(job, options = {}) {
  const sessionId = job?.executorSessionId ?? job?.threadId;
  if (typeof sessionId !== "string" || !SAFE_SESSION_ID.test(sessionId)) return null;
  const env = options.env ?? process.env;
  const home = options.home ?? env.HOME ?? os.homedir();
  const geminiHome = options.geminiHome ?? env.GEMINI_HOME?.replace(/^~(?=\/|$)/, home) ?? path.join(home, ".gemini");
  const brainRoot = path.join(geminiHome, "antigravity-cli", "brain");
  const swarmDir = path.join(brainRoot, sessionId, ".system_generated", "swarm");
  const membersFile = path.join(swarmDir, "members.json");
  const boardFile = path.join(swarmDir, "board.jsonl");
  const membersMtime = statMtime(membersFile);
  const boardMtime = statMtime(boardFile);
  if (membersMtime == null && boardMtime == null) return null;

  let lastActivityAt = Math.max(membersMtime ?? 0, boardMtime ?? 0) || null;
  let title = null;
  const members = [];
  if (membersMtime != null) {
    try {
      const parsed = JSON.parse(fs.readFileSync(membersFile, "utf8"));
      if (typeof parsed?.title === "string" && parsed.title.trim()) title = parsed.title.trim();
      for (const [name, info] of Object.entries(parsed?.members ?? {})) {
        if (!info || typeof info !== "object") continue;
        const cid = typeof info.conversation_id === "string" && SAFE_SESSION_ID.test(info.conversation_id)
          ? info.conversation_id : null;
        if (!info.killed && cid) {
          const mtime = statMtime(path.join(brainRoot, cid, ".system_generated", "logs", "transcript.jsonl"));
          if (mtime != null && (lastActivityAt == null || mtime > lastActivityAt)) lastActivityAt = mtime;
        }
        if (name === "coordinator" || info.role === "coordinator") continue;
        const rawState = info.killed === true ? "killed"
          : typeof info.state === "string" && info.state.trim() ? info.state.trim()
            : typeof info.phase === "string" && info.phase.trim() ? info.phase.trim() : "active";
        members.push({
          name,
          state: rawState.toLowerCase(),
          ...(typeof info.model === "string" && info.model.trim() ? { model: info.model.trim() } : {})
        });
      }
    } catch {}
  }

  const maxPosts = options.maxSwarmPosts ?? DEFAULT_SWARM_RECENT_POSTS;
  let boardHead = null;
  const posts = [];
  if (boardMtime != null) {
    const raw = readTailUtf8(boardFile);
    if (raw) {
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (!entry || typeof entry !== "object") continue;
          const seq = Number.isInteger(entry.seq) ? entry.seq : null;
          if (seq != null && (boardHead == null || seq > boardHead)) boardHead = seq;
          if (typeof entry.text === "string" && entry.text.trim()) {
            posts.push({ seq, agent: typeof entry.agent === "string" ? entry.agent : "unknown", text: entry.text });
          }
        } catch {}
      }
    }
  }

  return { title, members, boardHead, recentPosts: posts.slice(-maxPosts), lastActivityAt };
}
