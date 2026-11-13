import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsAsync from "node:fs/promises";
import { parseSessionTaskIndex, sessionTaskIndexPath } from "../plugins/codex/scripts/lib/session-task-index.mjs";
import path from "node:path";
import { listDirectorTasks, resolveDirectorTaskCwd } from "../plugins/codex/scripts/lib/director-tasks.mjs";
import { createLiveView } from "../plugins/codex/scripts/lib/job-event-model.mjs";
import { resolveStateDir, writeJobFile } from "../plugins/codex/scripts/lib/state.mjs";
import { threadRecordPaths } from "../plugins/codex/scripts/lib/thread-records.mjs";
import { isolateTestEnvironment, makeTempDir } from "./helpers.mjs";
import { directorTools, dispatchInput, pluginDataDir, registerDirectorTools, startDirectorTools } from "../plugins/codex/hooks/director-tools/register.ts";

import { createJobRecord } from "../plugins/codex/scripts/lib/tracked-jobs.mjs";

const WORKER = "/home/test/.claude/skills/code-director/scripts/dispatch.sh";
const COMPANION = "/plugin/scripts/codex-companion.mjs";

function harness({ root = "/plugin", files = [WORKER, COMPANION, "/repo"], indexed = {}, exitCode = 0, stdout = "STATUS: started\nJOB: task-a-b\n", stderr = "" } = {}) {
  const hooks = new Map();
  const on = (event, matcher, hook) => hooks.set(`${event}:${matcher.tool}`, hook);
  const registered = [];
  const runs = [];
  const lookups = [];
  const writes = new Map();
  const exists = new Set(files);
  const $ = {
    plugin: { name: "codex", root },
    env: { get: async (name) => ({ HOME: "/home/test", TMPDIR: "/tmp/" })[name] },
    fs: { exists: async (path) => exists.has(path), write: async (path, text) => { writes.set(path, text); } },
    session: { id: async () => "session-1", cwd: async () => "/repo" },
    clock: { now: async () => 1000 },
    tool: { register: async (spec) => { registered.push(spec); return { tool: `mcp__codex__${spec.name}` }; } },
    process: { run: async (argv, init) => {
      if (argv[2] === "tasks" && (argv[3] === "--job-cwd" || argv[3] === "--thread-cwd")) {
        lookups.push({ argv, init });
        return { exitCode: 0, stdout: indexed[argv[4]] ? `${indexed[argv[4]]}\n` : "", stderr: "" };
      }
      runs.push({ argv, init });
      return { exitCode, stdout, stderr };
    } },
    ui: { log: () => {} },
  };
  const tools = directorTools();
  registerDirectorTools(on, tools);
  const call = (name, input) => hooks.get(`tool.call:mcp__codex__${name}`)($, { tool: `mcp__codex__${name}`, ...input }, () => assert.fail("next must not run"));
  return { $, tools, hooks, registered, runs, lookups, writes, call };
}

test("dispatchInput writes the headers dispatch.sh reads, then the brief", () => {
  assert.equal(
    dispatchInput({ brief: "Find it.", cwd: "/repo", name: "locate x", mode: "continue", thread: "t-1", write: true, executor: "codex" }),
    "MODE: continue\nNAME: locate x\nCWD: /repo\nTHREAD: t-1\nWRITE: yes\nEXECUTOR: codex\n\nFind it.\n",
  );
  assert.equal(
    dispatchInput({ brief: "Branch it.", cwd: "/repo", name: "fork x", mode: "fork", thread: "t-source", write: true }),
    "MODE: fork\nNAME: fork x\nCWD: /repo\nTHREAD: t-source\nWRITE: yes\n\nBranch it.\n",
  );
  assert.equal(dispatchInput({ mode: "investigate", name: "n", cwd: "/r", brief: "b\n", write: false, base: "" }), "MODE: investigate\nNAME: n\nCWD: /r\n\nb\n");
  const dsh = dispatchInput({ mode: "continue", name: "next", cwd: "/repo", brief: "Recall it.", thread: "session-1",
    executor: "dsh", executor_command: "/custom/dsh", executor_args: ["--profile", "acp", "line\nbreak"], executor_permissions: "ask" });
  assert.match(dsh, /EXECUTOR: dsh\n/);
  assert.match(dsh, /EXECUTOR_COMMAND: \/custom\/dsh\nEXECUTOR_ARGS: \["--profile","acp","line\\nbreak"\]\nEXECUTOR_PERMISSIONS: ask\n/);
  assert.throws(() => dispatchInput({ brief: "x", executor_args: "acp" }), /array of strings/);
  assert.throws(() => dispatchInput({ brief: "x", executor_args: [1] }), /array of strings/);
});

test("dispatchInput refuses a header value that would start another header, and an empty brief", () => {
  assert.throws(() => dispatchInput({ mode: "investigate", name: "a\nMODE: implement", cwd: "/r", brief: "b" }), /name must be one line/);
  assert.throws(() => dispatchInput({ mode: "investigate", name: "a", cwd: "/r", brief: "  \n" }), /brief is empty/);
});

test("the tools are registered in the prompt's tool list only where dispatch.sh is installed", async () => {
  const installed = harness();
  await startDirectorTools(installed.$, installed.tools);
  assert.deepEqual(installed.registered.map((spec) => spec.name), ["dispatch", "message", "answer", "result", "status", "tasks", "cancel"]);
  assert.ok(installed.registered.every((spec) => spec.isDeferred === false));
  const dispatchSchema = installed.registered.find(spec => spec.name === "dispatch").inputSchema.properties;
  assert.ok(dispatchSchema.mode.enum.includes("fork"));
  const executors = dispatchSchema.executor.enum;
  assert.ok(["antigravity", "agy"].every(name => executors.includes(name)));
  assert.deepEqual(installed.tools.context, { worker: WORKER, companion: COMPANION, tmp: "/tmp", data: null });

  const missing = harness({ files: [COMPANION] });
  await startDirectorTools(missing.$, missing.tools);
  assert.deepEqual(missing.registered, []);
  assert.deepEqual(await missing.call("dispatch", {}), { deny: "the code-director skill is not installed, so there is no dispatch.sh to run" });
});

test("dispatch passes its caller only in the process environment and records the director agent", async () => {
  for (const agentId of [undefined, "agent-1"]) {
    const h = harness();
    await startDirectorTools(h.$, h.tools);
    const answer = await h.call("dispatch", { mode: "investigate", name: "locate x", cwd: "/repo", brief: "Find it.", agentId });
    assert.deepEqual(answer, { result: "STATUS: started\nJOB: task-a-b" });
    assert.equal(h.runs.length, 1);
    const [{ argv, init }] = h.runs;
    assert.deepEqual(argv, ["bash", WORKER, "dispatch"]);
    assert.equal(init.cwd, "/repo");
    assert.equal(init.stdin, "MODE: investigate\nNAME: locate x\nCWD: /repo\n\nFind it.\n");
    assert.deepEqual(init.env, { CODEX_COMPANION: COMPANION, CODEX_COMPANION_SESSION_ID: "session-1",
      CODEX_COMPANION_DIRECTOR_AGENT_ID: agentId ?? "" });
    const job = createJobRecord({ id: "job", workspaceRoot: "/repo" }, { env: init.env });
    assert.equal(job.sessionId, "session-1");
    assert.equal(job.directorAgentId, agentId);
    assert.equal(h.tools.pending, true, "the pane is told to rescan");
  }
});

test("a failed dispatch reaches the model as an error and does not ask the pane to rescan", async () => {
  const h = harness({ exitCode: 1, stdout: "NAME_REQUIRED: add a NAME: header\n" });
  await startDirectorTools(h.$, h.tools);
  assert.deepEqual(await h.call("dispatch", { mode: "investigate", name: "x", cwd: "/repo", brief: "b" }), { deny: "NAME_REQUIRED: add a NAME: header" });
  assert.equal(h.tools.pending, false);
  assert.deepEqual(await h.call("dispatch", { mode: "investigate", name: "x", cwd: "relative", brief: "b" }), { deny: "cwd must be an absolute path" });
  assert.deepEqual(await h.call("dispatch", { mode: "investigate", name: "x", cwd: "/gone", brief: "b" }), { deny: "cwd does not exist: /gone" });
  assert.equal(h.runs.length, 1);
});

test("message writes the correction to a file and passes the delivery as dispatch.sh's flag", async () => {
  const h = harness({ stdout: "MESSAGED job=task-a-b queued=task-c-d\n" });
  await startDirectorTools(h.$, h.tools);
  assert.equal(h.registered.find(spec => spec.name === "message").inputSchema.required.includes("delivery"), false);
  for (const [delivery, flags] of [[undefined, []], ["queue", ["--queue"]], ["steer", []], ["interrupt", ["--interrupt"]]]) {
    h.runs.length = 0;
    await h.call("message", { job: "task-a-b", cwd: "/repo", text: "Stop editing tests.", delivery });
    const [{ argv }] = h.runs;
    assert.deepEqual(argv.slice(0, 3), ["bash", WORKER, "message"]);
    assert.deepEqual(argv.slice(5), ["--cwd", "/repo", ...flags]);
    assert.equal(h.writes.get(argv[4]), "Stop editing tests.");
    assert.match(argv[4], /^\/tmp\/codex-director-session-1-1000-\d+\.md$/);
    assert.deepEqual(h.runs[1].argv, ["rm", "-f", argv[4]], "the file is removed once dispatch.sh has read it");
  }
  assert.deepEqual(await h.call("message", { job: "j", cwd: "/repo", text: "x", delivery: "now" }), { deny: "delivery must be queue, steer or interrupt" });
});

test("concurrent messages each send their own text", async () => {
  const h = harness({ stdout: "MESSAGED\n" });
  await startDirectorTools(h.$, h.tools);
  await Promise.all([
    h.call("message", { job: "task-a", cwd: "/repo", text: "to A", delivery: "interrupt" }),
    h.call("message", { job: "task-b", cwd: "/repo", text: "to B", delivery: "interrupt" }),
  ]);
  const sent = h.runs.filter(({ argv }) => argv[2] === "message").map(({ argv }) => [argv[3], h.writes.get(argv[4])]);
  assert.deepEqual(sent.sort(), [["task-a", "to A"], ["task-b", "to B"]]);
});

test("answer writes the answers map as JSON for dispatch.sh answer", async () => {
  const h = harness({ stdout: "ANSWERED job=j request=0\n" });
  await startDirectorTools(h.$, h.tools);
  const answers = { q1: { answers: ["yes"] } };
  assert.deepEqual(await h.call("answer", { job: "j", cwd: "/repo", request: "0", answers }), { result: "ANSWERED job=j request=0" });
  const [{ argv }] = h.runs;
  assert.deepEqual([argv[2], argv[3], argv[4]], ["answer", "j", "0"]);
  assert.deepEqual(JSON.parse(h.writes.get(argv[5])), answers);
  assert.deepEqual(await h.call("answer", { job: "j", cwd: "/repo", request: "0", answers: [] }), { deny: "answers must be an object keyed by question id" });
  h.$.process.run = async () => { throw new Error("aborted: still running after 120000ms"); };
  assert.deepEqual(await h.call("answer", { job: "j", cwd: "/repo", request: "0", answers }), {
    deny: "answer did not finish: aborted: still running after 120000ms. Whether it took effect is unknown; check status before running it again." });
});

test("result, status and cancel run the plugin's companion directly", async () => {
  const h = harness({ stdout: "{}\n" });
  await startDirectorTools(h.$, h.tools);
  const cancelSpec = h.registered.find((spec) => spec.name === "cancel");
  assert.equal(cancelSpec.inputSchema.properties.queued.type, "boolean");
  assert.match(cancelSpec.description, /queuedJobId/);
  assert.match(cancelSpec.description, /queued: true/);
  await h.call("result", { job: "j", cwd: "/repo" });
  await h.call("status", { job: "j", cwd: "/repo" });
  await h.call("status", { cwd: "/repo" });
  await h.call("status", { cwd: "/repo", detail: true });
  h.tools.pending = false;
  await h.call("cancel", { job: "j", cwd: "/repo" });
  assert.equal(h.tools.pending, true);
  await h.call("cancel", { job: "j", cwd: "/repo", queued: true });
  assert.deepEqual(await h.call("cancel", { cwd: "/repo" }), { deny: "job is required" });
  assert.deepEqual(h.runs.map((run) => run.argv), [
    ["node", COMPANION, "result", "j", "--cwd", "/repo"],
    ["node", COMPANION, "status", "j", "--cwd", "/repo", "--brief"],
    ["node", COMPANION, "status", "--cwd", "/repo", "--brief"],
    ["node", COMPANION, "status", "--cwd", "/repo", "--json"],
    ["node", COMPANION, "cancel", "j", "--cwd", "/repo"],
    ["node", COMPANION, "cancel", "j", "--cwd", "/repo", "--queued"],
  ]);
});

test("an installed plugin's companion runs with the plugin's data folder, where Bash dispatches keep their jobs", async () => {
  const root = "/home/test/.claude/plugins/cache/openai-codex/codex/1.4.49";
  const data = "/home/test/.claude/plugins/data/codex-openai-codex";
  assert.equal(pluginDataDir(root), data);
  assert.equal(pluginDataDir(`${root}/`), data);
  assert.equal(pluginDataDir("/home/test/.claude/plugins/cache/my.market/codex/1.0.0"), "/home/test/.claude/plugins/data/codex-my-market");
  assert.equal(pluginDataDir("/work/codex-plugin-cc/plugins/codex"), null);

  const h = harness({ root, files: [WORKER, `${root}/scripts/codex-companion.mjs`, "/repo", data] });
  await startDirectorTools(h.$, h.tools);
  await h.call("status", { job: "j", cwd: "/repo" });
  await h.call("dispatch", { mode: "investigate", name: "locate x", cwd: "/repo", brief: "Find it." });
  for (const { init } of h.runs) assert.equal(init.env.CLAUDE_PLUGIN_DATA, data);

  const fresh = harness({ root, files: [WORKER, `${root}/scripts/codex-companion.mjs`, "/repo"] });
  await startDirectorTools(fresh.$, fresh.tools);
  await fresh.call("status", { cwd: "/repo" });
  assert.equal(fresh.runs[0].init.env.CLAUDE_PLUGIN_DATA, undefined, "no folder yet: the companion's own fallback");
});

test("tasks lists this session across stores, filters names and repositories, and collapses queued rounds", async (t) => {
  isolateTestEnvironment(t);
  t.mock.method(Date, "now", () => Date.parse("2026-10-23T12:00:00Z"));
  const home = fs.realpathSync(makeTempDir());
  const tmpDir = path.join(home, "tmp");
  const configDir = path.join(home, ".claude");
  const transcript = path.join(configDir, "projects", "repo", "session-1.jsonl");
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, "");
  const repoA = path.join(home, "projects", "alpha");
  const repoB = path.join(home, "projects", "beta");
  const repoC = path.join(home, "projects", "gamma");
  const currentData = process.env.CLAUDE_PLUGIN_DATA;
  for (const repo of [repoA, repoB, repoC]) fs.mkdirSync(repo, { recursive: true });
  const put = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  };
  const original = { id: "job-original", label: "Fix queued receipts", sessionId: "session-1", workspaceRoot: repoA,
    status: "completed", executor: "acp", executorSessionId: "thread-dsh", createdAt: "2026-10-22T01:00:00Z",
    updatedAt: "2026-10-22T05:00:00Z", request: { executorCommand: "dsh", executorArgs: ["--profile", "acp"] } };
  const queued = { ...original, id: "job-queued", status: "queued", recordId: "record-a", executorSessionId: null,
    pid: process.pid, createdAt: "2026-10-22T02:00:00Z" };
  const forked = { id: "job-forked", label: "Forked experiment", sessionId: "session-1", workspaceRoot: repoA,
    status: "completed", executor: "acp", executorSessionId: "thread-dsh-fork",
    forkedFrom: { threadId: "thread-dsh", jobId: "job-original" }, createdAt: "2026-10-22T02:15:00Z",
    updatedAt: "2026-10-22T02:20:00Z", request: { executorCommand: "dsh", executorArgs: ["--profile", "acp-fork"] } };
  const forkedCont = { ...forked, id: "job-forked-cont", forkedFrom: null, createdAt: "2026-10-22T02:30:00Z",
    updatedAt: "2026-10-22T02:40:00Z" };
  writeJobFile(repoA, original.id, original);
  writeJobFile(repoA, queued.id, queued);
  writeJobFile(repoA, forked.id, forked);
  writeJobFile(repoA, forkedCont.id, forkedCont);
  const stateDir = resolveStateDir(repoA);
  const history = threadRecordPaths(stateDir, "record-a");
  put(path.join(stateDir, "job-index", `${original.id}.json`),
    { schemaVersion: 1, jobId: original.id, roundId: original.id, recordId: "record-a" });
  put(history.liveView, { ...createLiveView(original), recordId: "record-a", latestRoundId: original.id });
  put(history.manifest, { threadId: "thread-dsh" });
  // A different plugin data store and a fallback store are both discovered.
  process.env.CLAUDE_PLUGIN_DATA = path.join(configDir, "plugins", "data", "codex-other");
  writeJobFile(repoB, "job-pending", { id: "job-pending", label: "Inspect pending thread", sessionId: "session-1",
    workspaceRoot: repoB, status: "running", pid: process.pid, createdAt: "2026-10-22T03:00:00Z" });
  put(path.join(tmpDir, "codex-companion", "gamma", "jobs", "job-foreign.json"), {
    id: "job-foreign", label: "Review export", sessionId: "session-2", workspaceRoot: repoC,
    executor: "acp", executorSessionId: "thread-qoder", request: { executorCommand: "qodercli" },
    status: "completed", createdAt: "2026-10-22T04:00:00Z"
  });
  process.env.CLAUDE_PLUGIN_DATA = currentData;
  const pending = "Inspect pending thread · thread=pending · codex · running · job=job-pending · ~/projects/beta";
  const forkedLine = "Forked experiment · thread=thread-dsh-fork · dsh · completed · job=job-forked-cont · ~/projects/alpha · forked from=thread-dsh";
  const resumed = "Fix queued receipts · thread=thread-dsh · dsh · queued · job=job-queued · ~/projects/alpha";
  const foreign = "Review export · thread=thread-qoder · qoder · completed · job=job-foreign · ~/projects/gamma · other session=session-2";
  for (const [name, input, expected, flags] of [
    ["session only", {}, [pending, forkedLine, resumed], []],
    ["name query", { query: "QUEUED" }, [resumed], ["--query", "QUEUED"]],
    ["fork query", { query: "forked" }, [forkedLine], ["--query", "forked"]],
    ["one repository", { cwd: repoA }, [forkedLine, resumed], ["--cwd", repoA]],
    ["all sessions", { all: true }, [foreign, pending, forkedLine, resumed], ["--all"]],
    ["wider history", { all: true, days: 14 }, [foreign, pending, forkedLine, resumed], ["--all", "--days", "14"]],
    ["limit", { limit: 1 }, [pending, "2 older not shown"], ["--limit", "1"]],
    ["no match", { query: "missing" }, ["No matching tasks."], ["--query", "missing"]],
  ]) {
    const result = await listDirectorTasks({ sessionId: "session-1", home, configDir, tmpDir, ...input });
    assert.equal(result, expected.join("\n"), name);
    const h = harness({ files: [WORKER, COMPANION, "/repo", repoA], stdout: result });
    await startDirectorTools(h.$, h.tools);
    assert.deepEqual(await h.call("tasks", input), { result }, name);
    assert.deepEqual(h.runs[0].argv, ["node", COMPANION, "tasks", ...flags], name);
    assert.equal(h.runs[0].init.cwd, input.cwd ?? "/repo", name);
    assert.equal(h.runs[0].init.env.CODEX_COMPANION_SESSION_ID, "session-1", name);
  }
});

test("session task index migrates once, keeps old own threads, bounds all by days and expires only idle indexes", async (t) => {
  isolateTestEnvironment(t);
  const home = fs.realpathSync(makeTempDir());
  const configDir = path.join(home, ".claude");
  const transcript = path.join(configDir, "projects", "repo", "session-1.jsonl");
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, "");
  const now = Date.now();
  const ago = days => new Date(now - days * 86_400_000);
  const indexedRepo = path.join(home, "indexed");
  fs.mkdirSync(indexedRepo);
  const job = { id: "indexed", label: "Indexed task", sessionId: "session-1", workspaceRoot: indexedRepo,
    threadId: "thread-indexed", status: "completed", createdAt: ago(20).toISOString() };
  writeJobFile(indexedRepo, job.id, job);
  const queued = { ...job, id: "queued", recordId: "retained", status: "queued", pid: process.pid, createdAt: ago(4).toISOString() };
  writeJobFile(indexedRepo, queued.id, queued);
  writeJobFile(indexedRepo, queued.id, queued);
  const indexedState = resolveStateDir(indexedRepo);
  const root = path.dirname(indexedState);
  const indexFile = sessionTaskIndexPath(root, job.sessionId);
  assert.equal(parseSessionTaskIndex(fs.readFileSync(indexFile, "utf8")).entries.length, 2);
  const history = threadRecordPaths(indexedState, "retained");
  fs.mkdirSync(path.join(indexedState, "job-index"), { recursive: true });
  fs.mkdirSync(history.rounds, { recursive: true });
  fs.writeFileSync(path.join(indexedState, "job-index", "indexed.json"),
    JSON.stringify({ schemaVersion: 1, jobId: job.id, roundId: job.id, recordId: "retained" }));
  fs.writeFileSync(path.join(history.rounds, "indexed.json"), JSON.stringify({ job }));
  fs.writeFileSync(history.liveView, JSON.stringify({ threadId: job.threadId }));
  fs.unlinkSync(path.join(indexedState, "jobs", "indexed.json"));
  fs.utimesSync(path.join(indexedState, "jobs"), ago(1), ago(1));
  const seed = (id, label, owner, age) => {
    const repo = path.join(home, id);
    fs.mkdirSync(repo);
    const state = resolveStateDir(repo);
    fs.mkdirSync(path.join(state, "jobs"), { recursive: true });
    const file = path.join(state, "jobs", `${id}.json`);
    fs.writeFileSync(file, JSON.stringify({ ...job, id, label, sessionId: owner, workspaceRoot: repo,
      threadId: `thread-${id}`, createdAt: ago(age).toISOString() }));
    // The legacy current-session job is discovered during the first migration.
    const time = owner === "session-1" ? new Date(now + 1000) : ago(age);
    fs.utimesSync(path.join(state, "jobs"), time, time);
    return file;
  };
  seed("legacy", "Legacy task", "session-1", 1);
  seed("recent", "Recent foreign", "session-2", 2);
  const oldFile = seed("old", "Older foreign", "session-2", 5);
  const ancientFile = seed("ancient", "Ancient foreign", "session-3", 10);
  const retired = sessionTaskIndexPath(root, "retired");
  fs.writeFileSync(retired, "");
  for (const file of [indexFile, retired]) fs.utimesSync(file, ago(8), ago(8));
  fs.rmSync(path.join(path.dirname(indexFile), ".gc"), { force: true });
  const reads = [];
  const directories = [];
  const readFile = fsAsync.readFile;
  const readdir = fsAsync.readdir;
  t.mock.method(fsAsync, "readFile", async (file, ...args) => { reads.push(String(file)); return readFile(file, ...args); });
  t.mock.method(fsAsync, "readdir", async (file, ...args) => { directories.push(String(file)); return readdir(file, ...args); });
  for (const [name, input, labels, readsOld, scans] of [
    ["concurrent first migration", { parallel: true }, ["Legacy task", "Indexed task"], false, true],
    ["warm index without time limit", {}, ["Legacy task", "Indexed task"], false, false],
    ["all defaults to three days", { all: true }, ["Legacy task", "Recent foreign", "Indexed task"], false, true],
    ["wider other-session history", { all: true, days: 7 }, ["Legacy task", "Recent foreign", "Indexed task", "Older foreign"], true, true],
    ["history beyond index retention", { all: true, days: 14 }, ["Legacy task", "Recent foreign", "Indexed task", "Older foreign", "Ancient foreign"], true, true],
    ["missing index migrates again", { missingIndex: true }, ["Legacy task", "Indexed task"], false, true],
  ]) {
    if (name === "warm index without time limit") fs.utimesSync(indexFile, ago(8), ago(8));
    if (input.missingIndex) {
      fs.unlinkSync(indexFile);
      fs.utimesSync(path.join(indexedState, "jobs"), new Date(now + 1000), new Date(now + 1000));
    }
    reads.length = directories.length = 0;
    const list = () => listDirectorTasks({ sessionId: "session-1", home, configDir,
      tmpDir: path.join(home, "tmp"), all: input.all, days: input.days });
    const outputs = await Promise.all(Array.from({ length: input.parallel ? 2 : 1 }, list));
    for (const output of outputs) {
      assert.deepEqual(output.split("\n").map(line => line.split(" · ")[0]), labels, name);
      assert.match(output, /Indexed task .*job=queued/, name);
    }
    assert.equal(reads.includes(oldFile), readsOld, name);
    assert.equal(directories.includes(root), scans, name);
    const contents = fs.readFileSync(indexFile, "utf8");
    const parsed = parseSessionTaskIndex(contents);
    assert.equal(parsed.complete, true, name);
    assert.equal(parsed.entries.length, 3, name);
    assert.equal(contents.split("\n").filter(line => line.includes('"complete":true')).length, 1, name);
    assert.ok(fs.statSync(indexFile).mtimeMs > now - 3_600_000, name);
    assert.equal(fs.existsSync(retired), false, name);
    assert.equal(fs.existsSync(ancientFile), true, name);
  }
});

test("job tools and continue/fork prefer unique session-indexed cwd, fall back to caller cwd, and require cwd when neither exists", async (t) => {
  isolateTestEnvironment(t);
  const home = fs.realpathSync(makeTempDir());
  const configDir = path.join(home, ".claude");
  const tmpDir = path.join(home, "tmp");
  const repoA = path.join(home, "alpha");
  const repoB = path.join(home, "beta");
  for (const dir of [repoA, repoB]) fs.mkdirSync(dir, { recursive: true });
  writeJobFile(repoA, "job-1", { id: "job-1", sessionId: "session-1", workspaceRoot: repoA, status: "running", threadId: "thr-1" });
  writeJobFile(repoB, "job-2", { id: "job-2", sessionId: "session-1", workspaceRoot: repoB, status: "completed", executor: "acp", executorSessionId: "thr-2" });
  writeJobFile(repoA, "job-dup", { id: "job-dup", sessionId: "session-1", workspaceRoot: repoA, status: "completed", threadId: "thr-dup" });
  writeJobFile(repoB, "job-dup", { id: "job-dup", sessionId: "session-1", workspaceRoot: repoB, status: "completed", threadId: "thr-dup" });

  for (const [label, opts, expected] of [
    ["exact job hit", { job: "job-1" }, repoA],
    ["job prefix ignored", { job: "job-" }, null],
    ["multi-repo job ignored", { job: "job-dup" }, null],
    ["missing job", { job: "job-missing" }, null],
    ["thread hit", { thread: "thr-2" }, repoB],
    ["multi-repo thread ignored", { thread: "thr-dup" }, null],
    ["missing thread", { thread: "thr-missing" }, null],
  ]) {
    assert.equal(await resolveDirectorTaskCwd({ sessionId: "session-1", home, configDir, tmpDir, ...opts }), expected, label);
  }

  const h = harness({ files: [WORKER, COMPANION, "/repo", repoA, repoB], indexed: { "job-1": repoA, "thr-2": repoB }, stdout: "OK\n" });
  await startDirectorTools(h.$, h.tools);
  const byName = Object.fromEntries(h.registered.map(spec => [spec.name, spec.inputSchema]));
  assert.deepEqual([byName.dispatch.required, byName.message.required, byName.answer.required, byName.result.required, byName.status.required, byName.cancel.required],
    [["mode", "name", "brief"], ["job", "text"], ["job", "request", "answers"], ["job"], undefined, ["job"]]);

  for (const [label, tool, input, expectedCwd] of [
    ["indexed job ignores wrong cwd on message", "message", { job: "job-1", cwd: "/gone", text: "Fix." }, repoA],
    ["indexed job without cwd on answer", "answer", { job: "job-1", request: "0", answers: { q: { answers: ["a"] } } }, repoA],
    ["indexed job ignores wrong cwd on result", "result", { job: "job-1", cwd: "/repo" }, repoA],
    ["indexed job without cwd on status", "status", { job: "job-1" }, repoA],
    ["indexed job without cwd on cancel", "cancel", { job: "job-1" }, repoA],
    ["unindexed job uses caller cwd", "result", { job: "job-other", cwd: "/repo" }, "/repo"],
    ["indexed thread ignores wrong cwd on continue", "dispatch", { mode: "continue", name: "next", thread: "thr-2", cwd: "/gone", brief: "Go." }, repoB],
    ["indexed thread without cwd on fork", "dispatch", { mode: "fork", name: "branch", thread: "thr-2", brief: "Go." }, repoB],
    ["unindexed thread uses caller cwd", "dispatch", { mode: "continue", name: "next", thread: "thr-other", cwd: "/repo", brief: "Go." }, "/repo"],
  ]) {
    h.runs.length = 0;
    assert.deepEqual(await h.call(tool, input), { result: "OK" }, label);
    assert.equal(h.runs[0].init.cwd, expectedCwd, label);
    if (tool === "dispatch") assert.match(h.runs[0].init.stdin, new RegExp(`CWD: ${expectedCwd}\\n`), label);
    else assert.ok(h.runs[0].argv.includes(expectedCwd), label);
  }

  for (const [label, tool, input, pattern] of [
    ["unindexed job without cwd", "result", { job: "job-missing" }, /This session has no record of job job-missing; pass cwd\./],
    ["unindexed thread without cwd", "dispatch", { mode: "continue", name: "next", thread: "thr-missing", brief: "Go." }, /This session has no record of thread thr-missing; pass cwd\./],
    ["status without job or cwd", "status", {}, /cwd is required unless job is provided/],
    ["investigate without cwd", "dispatch", { mode: "investigate", name: "find x", brief: "Go." }, /cwd is required for new tasks/],
    ["implement without cwd", "dispatch", { mode: "implement", name: "edit x", brief: "Go." }, /cwd is required for new tasks/],
    ["review without cwd", "dispatch", { mode: "review", name: "rev x", brief: "Go." }, /cwd is required for new tasks/],
    ["adversarial-review without cwd", "dispatch", { mode: "adversarial-review", name: "adv x", brief: "Go." }, /cwd is required for new tasks/],
  ]) {
    const answer = await h.call(tool, input);
    assert.match(answer.deny ?? "", pattern, label);
  }
});
