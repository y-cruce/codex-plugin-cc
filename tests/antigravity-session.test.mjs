import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { antigravitySkillDirectories, readAntigravitySwarmSnapshot } from "../plugins/codex/scripts/lib/executors/antigravity-session.mjs";
import { enrichJob } from "../plugins/codex/scripts/lib/job-control.mjs";

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agy-session-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("Antigravity grants the distinct real directories of registered skills and the director's executor skill", (t) => {
  const home = fixture(t);
  const cwd = path.join(home, "workspace");
  const shared = path.join(home, "shared/compass");
  const local = path.join(cwd, ".agents/skills/local");
  const director = path.join(home, "checkout/skills/code-director");
  const executor = path.join(home, "checkout/skills/codex-executor");
  const cliSkills = path.join(home, ".gemini/antigravity-cli/skills");
  const configSkills = path.join(home, ".gemini/config/skills");
  const claudeSkills = path.join(home, ".claude/skills");
  for (const dir of [shared, local, director, executor, cliSkills, configSkills, claudeSkills]) fs.mkdirSync(dir, { recursive: true });
  for (const root of [cliSkills, configSkills, path.dirname(local)]) fs.symlinkSync(shared, path.join(root, "compass"), "dir");
  fs.symlinkSync(director, path.join(claudeSkills, "code-director"), "dir");
  fs.symlinkSync(path.join(home, "missing"), path.join(cliSkills, "broken"), "dir");
  fs.writeFileSync(path.join(configSkills, "not-a-directory"), "");
  assert.deepEqual(antigravitySkillDirectories(cwd, { home }), [shared, local, executor]);
});

test("readAntigravitySwarmSnapshot reads members, recent board posts, and advances active job progress time", (t) => {
  const home = fixture(t);
  const sessionId = "sess-swarm-1";
  const workerCid = "worker-cid-1";
  const brainRoot = path.join(home, ".gemini/antigravity-cli/brain");
  const swarmDir = path.join(brainRoot, sessionId, ".system_generated/swarm");
  const workerLogDir = path.join(brainRoot, workerCid, ".system_generated/logs");
  fs.mkdirSync(swarmDir, { recursive: true });
  fs.mkdirSync(workerLogDir, { recursive: true });

  const logFile = path.join(home, "job.log");
  fs.writeFileSync(logFile, "[2026-11-26T00:00:00Z] started\n");
  const oldTime = new Date(Date.now() - 20 * 60 * 1000);
  fs.utimesSync(logFile, oldTime, oldTime);

  const membersFile = path.join(swarmDir, "members.json");
  fs.writeFileSync(membersFile, JSON.stringify({
    title: "refactor auth",
    members: {
      coordinator: { role: "coordinator", conversation_id: sessionId, phase: "RUNNING", killed: false },
      alpha: { role: "worker", conversation_id: workerCid, phase: "RUNNING", killed: false, model: "gemini-4-carbon" },
      beta: { role: "worker", conversation_id: "worker-cid-2", phase: "RUNNING", killed: true }
    }
  }));
  fs.utimesSync(membersFile, oldTime, oldTime);

  const boardFile = path.join(swarmDir, "board.jsonl");
  const posts = [1, 2, 3, 4, 5].map((seq) => JSON.stringify({ seq, agent: seq % 2 ? "alpha" : "verifier", text: `post ${seq}` }));
  fs.writeFileSync(boardFile, `${posts.join("\n")}\n`);
  const boardTime = new Date(Date.now() - 5 * 60 * 1000);
  fs.utimesSync(boardFile, boardTime, boardTime);

  // Active worker transcript newer than board advances lastProgressAt.
  const workerTranscript = path.join(workerLogDir, "transcript.jsonl");
  fs.writeFileSync(workerTranscript, "{}\n");
  const freshTime = new Date(Date.now() - 30 * 1000);
  fs.utimesSync(workerTranscript, freshTime, freshTime);

  const job = { id: "job-1", executor: "acp", status: "running", threadId: sessionId, logFile, pid: process.pid };
  const snapshot = readAntigravitySwarmSnapshot(job, { home });
  assert.equal(snapshot.title, "refactor auth");
  assert.deepEqual(snapshot.members, [
    { name: "alpha", state: "running", model: "gemini-4-carbon" },
    { name: "beta", state: "killed" }
  ]);
  assert.equal(snapshot.boardHead, 5);
  assert.deepEqual(snapshot.recentPosts.map((p) => p.seq), [2, 3, 4, 5]);
  assert.ok(snapshot.lastActivityAt >= freshTime.getTime() - 1000);

  const enriched = enrichJob(job, { home });
  assert.equal(enriched.progressAgeMinutes, 0);
  assert.equal(enriched.swarm.boardHead, 5);
  assert.equal(readAntigravitySwarmSnapshot({ executor: "acp", threadId: "non-existent" }, { home }), null);
  assert.equal(readAntigravitySwarmSnapshot({ executor: "acp", threadId: "../escape" }, { home }), null);
});
