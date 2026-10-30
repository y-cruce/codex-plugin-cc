import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { register } from "../plugins/codex/hooks/register.ts";
import { resolveClaudeSessionPath } from "../plugins/codex/scripts/lib/claude-session-transfer.mjs";
import { handleSessionStart, handleSessionEnd } from "../plugins/codex/scripts/session-lifecycle-hook.mjs";
import { createJobRecord } from "../plugins/codex/scripts/lib/tracked-jobs.mjs";
import { loadState, updateState, resolveStateDir } from "../plugins/codex/scripts/lib/state.mjs";
import { isolateTestEnvironment, makeTempDir } from "./helpers.mjs";

test("native lifecycle restores ownership without command exports and clears a previous transcript", async (t) => {
  isolateTestEnvironment(t);
  const hooks = new Map();
  register((name, matcher, hook) => hooks.set(hook && matcher.tool ? `${name}:${matcher.tool}` : name, hook ?? matcher));
  assert.equal(hooks.has("classic.SessionStart"), false);
  let sessionId;
  const engine = {
    plugin: { root: "/plugin" }, session: { id: async () => sessionId }, clock: { after() {} },
    env: {
      get: async (key) => key === "HOME" ? undefined : process.env[key],
      set: async (key, value) => { if (value === undefined) delete process.env[key]; else process.env[key] = value; },
    },
    process: { run: async () => ({ exitCode: 1, stdout: "", stderr: "" }) }, ui: { log() {} },
  };
  const jobs = [];
  for (const [id, event, input] of [
    ["started", "session.start", { isInteractive: false }],
    ["resumed", "turn.start", {}],
    ["cleared", "command.run", { command: "codex:transfer", args: "" }],
    ["branch", "tool.call:Bash", { command: "node /plugin/scripts/codex-companion.mjs task" }],
  ]) {
    sessionId = id;
    process.env.CODEX_COMPANION_TRANSCRIPT_PATH = "/transcript/previous.jsonl";
    const result = await hooks.get(event)(engine, input, async () => {
      assert.equal(process.env.CODEX_COMPANION_SESSION_ID, sessionId);
      assert.equal(process.env.CODEX_COMPANION_TRANSCRIPT_PATH, undefined);
      assert.throws(() => resolveClaudeSessionPath("/work"), /Could not identify.*--source/);
      jobs.push(createJobRecord({ id: sessionId }));
      return { continued: true };
    });
    assert.equal(result.continued, true);
    // A real command export for this session must survive the next native hook.
    process.env.CODEX_COMPANION_TRANSCRIPT_PATH = `/transcript/${sessionId}.jsonl`;
    await hooks.get("turn.start")(engine, {}, async () => ({}));
    assert.equal(process.env.CODEX_COMPANION_TRANSCRIPT_PATH, `/transcript/${sessionId}.jsonl`);
  }
  assert.deepEqual(jobs.map(job => job.sessionId), ["started", "resumed", "cleared", "branch"]);
});

test("lifecycle command budgets cover delayed Node startup and state-lock cleanup", () => {
  const hooks = JSON.parse(fs.readFileSync(new URL("../plugins/codex/hooks/hooks.json", import.meta.url)));
  for (const event of ["SessionStart", "SessionEnd"]) {
    assert.ok(hooks.hooks[event][0].hooks[0].timeout >= 60, `${event} must allow a 16s startup and 30s state lock`);
  }
  assert.equal(hooks.hooks.Stop[0].hooks[0].timeout, 900);
});

test("lifecycle CLI state failures produce no hook failure or person-visible stderr", (t) => {
  isolateTestEnvironment(t);
  const cwd = makeTempDir();
  const state = resolveStateDir(cwd);
  updateState(cwd, current => { current.jobs = [{ id: "test-job", sessionId: "test", status: "completed" }]; });
  fs.mkdirSync(path.join(state, "broker.json"), { recursive: true });
  fs.mkdirSync(path.join(state, "state.lock"));
  const script = fileURLToPath(new URL("../plugins/codex/scripts/session-lifecycle-hook.mjs", import.meta.url));
  try {
    for (const event of ["SessionStart", "SessionEnd"]) {
      const result = spawnSync(process.execPath, [script, event], { cwd, encoding: "utf8",
        input: JSON.stringify({ cwd, session_id: "test", transcript_path: "/transcript" }),
        env: { ...process.env, CLAUDE_ENV_FILE: cwd } });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
    }
  } finally {
    fs.rmSync(path.join(state, "broker.json"), { recursive: true, force: true });
    fs.rmSync(path.join(state, "state.lock"), { recursive: true, force: true });
  }
});

test("disabled Stop gate does not launch Git", (t) => {
  isolateTestEnvironment(t);
  const cwd = makeTempDir();
  fs.mkdirSync(path.join(cwd, ".git"));
  const preload = path.join(cwd, "no-external.mjs");
  fs.writeFileSync(preload, `import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
cp.spawnSync = () => { process.stderr.write("disabled gate launched a subprocess"); throw new Error("subprocess forbidden"); };
syncBuiltinESMExports();
`);
  const script = fileURLToPath(new URL("../plugins/codex/scripts/stop-review-gate-hook.mjs", import.meta.url));
  const result = spawnSync(process.execPath, ["--import", preload, script], { cwd, encoding: "utf8",
    input: JSON.stringify({ cwd, session_id: "test" }), env: process.env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
});

test("clear cleans only the ended session and preserves the shared broker for the next session", async (t) => {
  isolateTestEnvironment(t);
  const cwd = makeTempDir();
  updateState(cwd, state => { state.jobs = [
    { id: "ended", sessionId: "ended", status: "completed" },
    { id: "next", sessionId: "next", status: "completed" },
  ]; });
  const file = path.join(resolveStateDir(cwd), "broker.json");
  const broker = { sessionId: "next" };
  fs.writeFileSync(file, JSON.stringify(broker));
  await handleSessionEnd({ cwd, session_id: "ended", reason: "clear" });
  assert.deepEqual(loadState(cwd).jobs.map(job => job.id), ["next"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), broker);
});

test("fork start exports branch ownership; resume end preserves the original jobs", async (t) => {
  isolateTestEnvironment(t);
  const cwd = makeTempDir();
  const previous = process.env.CLAUDE_ENV_FILE;
  try {
    const jobs = [];
    // 2.1.295 directs each SessionStart to the destination session's env file.
    for (const sessionId of ["original", "branch"]) {
      const envFile = path.join(cwd, `${sessionId}.sh`);
      process.env.CLAUDE_ENV_FILE = envFile;
      // A compaction starts the session again with the same env file.
      for (let start = 0; start < 2; start += 1) {
        handleSessionStart({ session_id: sessionId, transcript_path: `/projects/${sessionId}.jsonl` });
      }
      const exports = [...fs.readFileSync(envFile, "utf8").matchAll(/^export (\w+)='([^']*)'$/gm)];
      assert.equal(exports.length, 3);
      const env = Object.fromEntries(exports.map((match) => [match[1], match[2]]));
      assert.equal(env.CODEX_COMPANION_TRANSCRIPT_PATH, `/projects/${sessionId}.jsonl`);
      assert.equal(env.CLAUDE_PLUGIN_DATA, process.env.CLAUDE_PLUGIN_DATA);
      jobs.push(createJobRecord({ id: sessionId, status: "running" }, { env }));
    }
    assert.deepEqual(jobs.map((job) => job.sessionId), ["original", "branch"]);
    updateState(cwd, (state) => { state.jobs = jobs; });
    await handleSessionEnd({ cwd, session_id: "original", reason: "resume" });
    assert.deepEqual(loadState(cwd).jobs, jobs);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_ENV_FILE;
    else process.env.CLAUDE_ENV_FILE = previous;
  }
});
